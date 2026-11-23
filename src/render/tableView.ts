import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type {
  FrameStats,
  GameEvent,
  Move,
  PlacedTile,
  Pip,
  Quality,
  RestoreState,
  Seat,
  SeatPlate,
  SfxName,
  Side,
  TableStyle,
  TableView,
  TableViewOptions,
  Tile,
  TileBack,
  TileSet,
  TileTheme,
} from '../contracts';
import { MAX_TILE_ID, TILE_BY_ID, TILE_SETS, type TileSetDef } from '../engine/tiles';
import { layoutChain, type AvoidRect, type ChainBounds, type ChainLayoutResult } from './chainLayout';
import { Animator, ease, lerp, clamp01, type Ease } from './tween';
import * as tex from './textures';
import { Particles } from './particles';
import { RingDirector as MenuDirector, type Fit, type FitBox, type MenuHost } from './menuRing';
import { PerfHud } from './perfHud';
import { pickSwap, resolvePlaceholders, swapIds } from './hiddenTiles';
import { FrameLoop } from './frameLoop';
import { noteError } from '../app/errorLog';

type V3 = THREE.Vector3;
type Q = THREE.Quaternion;

/** tile geometry in cell units (cell = tile width incl. gap) */
const TL = 1.92;
const TW = 0.94;
const TH = 0.3;
const OPP_SCALE = 0.72;
/** hold time over a slot (or on it) before a release slams */
const SLAM_HOLD_MS = 600;
const sameMove = (a: Move, b: Move): boolean =>
  a.kind === b.kind && (a.kind !== 'play' || (b.kind === 'play' && a.tileId === b.tileId && a.side === b.side));
const MAX_CELL = 1;
/** global id space: 0..27 (double-six) + 28..82 (double-nine) */
const TILE_COUNT = MAX_TILE_ID + 1;

const UP = new THREE.Vector3(0, 1, 0);
const Q_FLIP = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
/** plane (XY, normal +Z) -> lies in a tile's X/Z plane facing +Y */
const Q_PLANE_TO_TILE = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);

interface QualityCfg {
  /** canvas pixel ratio = clamp(devicePixelRatio * dprScale, dprMin, dpr) (CSS stretches it to the view) */
  dpr: number;
  dprScale: number;
  dprMin: number;
  /** MSAA: a context creation flag, so changing it recreates the WebGLRenderer */
  aa: boolean;
  shadows: boolean;
  particles: number;
  confetti: number;
  atlas: number;
  seg: number;
  /** min ms between rendered frames while animating (0 = every rAF) / while only ambient pulses run */
  frameMs: number;
  ambientMs: number;
  /** largest simulated step per frame (s): below 1/maxDt fps the tweens would run slower than wall clock */
  maxDt: number;
  /** impact dust count / size / lifetime multipliers */
  fx: number;
  fxSize: number;
  fxLife: number;
  /** camera shake, zoom punch and full-screen flashes */
  shake: boolean;
  /** cheap look: no rim light, a still medallion, calmer slam ripple, idle ring without per-tile wobble */
  lite: boolean;
  /** procedural canvas size (the arena texture's longest side is 1.5x this) and texture anisotropy */
  felt: number;
  aniso: number;
}
const QUALITY: Record<Quality, QualityCfg> = {
  low: {
    dpr: 0.75, dprScale: 0.75, dprMin: 0.6, aa: false, shadows: false, particles: 64, confetti: 70, atlas: 128, seg: 2,
    frameMs: 28, ambientMs: 60, maxDt: 0.1, fx: 0.25, fxSize: 0.8, fxLife: 0.7, shake: false, lite: true, felt: 512, aniso: 1,
  },
  medium: {
    dpr: 1.5, dprScale: 1, dprMin: 0, aa: true, shadows: false, particles: 200, confetti: 180, atlas: 256, seg: 2,
    frameMs: 0, ambientMs: 30, maxDt: 0.1, fx: 1, fxSize: 1, fxLife: 1, shake: true, lite: false, felt: 1024, aniso: 4,
  },
  high: {
    dpr: 2, dprScale: 1, dprMin: 0, aa: true, shadows: true, particles: 360, confetti: 280, atlas: 256, seg: 3,
    frameMs: 0, ambientMs: 30, maxDt: 0.05, fx: 1, fxSize: 1, fxLife: 1, shake: true, lite: false, felt: 1024, aniso: 4,
  },
};

/** 'pile' = the boneyard of individual play (face down at a free side, or a corner when all four seats play) */
type Loc = 'idle' | 'pool' | 'hand' | 'chain' | 'reveal' | 'pile';
type PileSide = 'top' | 'left' | 'corner';
type RectXZ = { x0: number; x1: number; z0: number; z1: number };

interface TileObj {
  id: number;
  tile: Tile;
  pos: V3;
  quat: Q;
  s: number;
  sq: number; // squash (1 = none)
  off: V3; // transient offset (shake/hop)
  wx: number; // transient wobble tilt (radians, world X / Z), always eased back to 0
  wz: number;
  loc: Loc;
  seat: number;
  glow: number;
  dim: number;
  token: number;
}

interface FlyOpts {
  dur?: number;
  arc?: number;
  delay?: number;
  posEase?: Ease;
  rotEase?: Ease;
}

interface Ghost {
  side: Side;
  x: number;
  z: number;
  rotY: number;
  move: Move;
}

interface HumanReq {
  legal: Move[];
  resolve: (m: Move) => void;
  sides: Map<number, Move[]>;
  passOnly: boolean;
  passMove: Move | null;
  selected: number;
  ghosts: Ghost[];
  hover: number;
  done: boolean;
}

interface Sprite2D {
  sprite: THREE.Sprite;
  canvas: HTMLCanvasElement;
  tex: THREE.CanvasTexture;
}

const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const tmpV3 = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const tmpQ2 = new THREE.Quaternion();
const tmpM = new THREE.Matrix4();
const tmpS = new THREE.Vector3();
const tmpC = new THREE.Color();
const tmpE = new THREE.Euler();
const tmpQW = new THREE.Quaternion();
const bx = new THREE.Vector3();
const by = new THREE.Vector3();
const bz = new THREE.Vector3();

/** the only on-table words: the match-end celebration (per-player callouts are the plates' speech bubbles) */
const LABELS = {
  es: { win: '¡VICTORIA!', lose: 'DERROTA' },
  en: { win: 'VICTORY!', lose: 'DEFEAT' },
};

/** outline quad size relative to the tile footprint (texture padding for the soft glow) */
/** css px kept free at the top for the HTML HUD (score card, hand pill, pause) */
const HUD_PX = 72;
/** landscape edge columns: css px kept free at the top corners (score card, pause button) */
const HUD_SIDE_PX = 94;
/** speech-bubble zone the UI attaches beside each HTML plate (css px) */
const BUBBLE_W = 120;
const BUBBLE_H = 44;
/** the compact bubble of a portrait edge plate (rises over the seat's stack) */
const BUBBLE_EDGE_W = 76;
const BUBBLE_EDGE_H = 34;
/** portrait edge plates: the stack stands this far outboard of the box edge, tight against the frame */
const EDGE_STACK_OUT = 0.3;
/** portrait chain tile length on screen: at most this share of a hand tile ... */
const CHAIN_MAX_OF_HAND = 0.8;
/** ... and a readability floor (css px / share of a hand tile), only crossed in the worst case */
const CHAIN_MIN_PX = 50;
const CHAIN_MIN_OF_HAND = 0.56;
/** side seats: their tiles are revealed flat just inboard of the stack; the plate's outer edge sits this far in */
const SIDE_REVEAL_X = 0.15;
const SIDE_PLATE_GAP = 0.95;
type BubbleDir = 'left' | 'right' | 'up' | 'down';
/** SeatPlate plus the speech-bubble anchor (point on the plate's table-centre side + growth direction) */
type SeatPlateX = SeatPlate & { bubble?: { x: number; y: number; dir: BubbleDir } };

const GHOST_SX = (tex.GHOST_IN_W + 2 * tex.GHOST_PAD) / tex.GHOST_IN_W;
const GHOST_SY = (tex.GHOST_IN_H + 2 * tex.GHOST_PAD) / tex.GHOST_IN_H;

const CONFETTI_COLORS: [number, number, number][] = [
  [1, 0.82, 0.25],
  [1, 0.42, 0.33],
  [0.25, 0.8, 0.72],
  [0.85, 0.3, 0.7],
  [1, 1, 0.95],
  [0.55, 0.85, 0.3],
  [0.3, 0.55, 1],
];

export class TableViewImpl implements TableView {
  private container: HTMLElement;
  private opts: TableViewOptions;
  private quality: Quality;
  private q: QualityCfg;
  private renderer!: THREE.WebGLRenderer;
  private canvas!: HTMLCanvasElement;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(40, 1, 0.1, 300);
  private overlay = new THREE.Scene();
  private overlayCam = new THREE.OrthographicCamera(0, 1, 1, 0, -10, 10);
  private anim = new Animator();
  private speedMul = 1;
  private reduced: boolean;
  private lang: 'es' | 'en' = 'es';
  private theme: TileTheme = 'classic';
  private tableStyle: TableStyle = 'green';
  private tileBack: TileBack = 'ornate';

  // scene objects
  private keyLight!: THREE.DirectionalLight;
  private hemiLight!: THREE.HemisphereLight;
  private rimLight!: THREE.DirectionalLight;
  private felt!: THREE.Mesh;
  private feltCanvas: HTMLCanvasElement | null = null;
  private feltTex: THREE.CanvasTexture | null = null;
  /** what the arena texture was drawn for (table geometry, style, size); '' = redraw */
  private arenaKey = '';
  /** the centre medallion: its own quad so it can turn slowly while a hand is on */
  private emblem!: THREE.Mesh;
  private emblemTex: THREE.CanvasTexture | null = null;
  /** warm pool of light on the felt in front of whoever's turn it is; glides from seat to seat */
  private turnLight!: THREE.Mesh;
  private turnLightAmt = 0;
  private turnLightGen = 0;
  /** small ground ring under every tile that lands */
  private ripple!: THREE.Mesh;
  private tileGeo!: THREE.BufferGeometry;
  private tileMat!: THREE.MeshLambertMaterial;
  private atlas!: THREE.CanvasTexture;
  private tilesMesh!: THREE.InstancedMesh;
  private fxAttr!: THREE.InstancedBufferAttribute;
  private blobMesh!: THREE.InstancedMesh;
  private glowMesh!: THREE.InstancedMesh;
  private ghostMesh!: THREE.InstancedMesh;
  private uTime = { value: 0 };
  private dust!: Particles;
  private ring!: THREE.Mesh;
  private confetti!: Particles;

  // overlay
  private plates: Sprite2D[] = [];
  private plateX = [0, 0, 0, 0];
  private plateY = [0, 0, 0, 0];
  private plateScale = [1, 1, 1, 1];
  private plateRot = [0, 0, 0, 0];
  private plateW = 140;
  private plateH = 42;
  private plateInfo: tex.PlateInfo[] = [];
  /** HTML plates mode (opts.onPlates): boxes laid out here, drawn by the UI */
  private htmlPlates = false;
  private plateBoxes: SeatPlateX[] = [];
  private bubX = [0, 0, 0, 0];
  private bubY = [0, 0, 0, 0];
  private bubDir: BubbleDir[] = ['up', 'left', 'down', 'right'];
  /** partner row: centred on topOffX, or packed toward its right end (plate beside it) */
  private topAnchor: 'center' | 'right' = 'center';
  private plateSig: number[] = [0, 0, 0, 0];
  private plateCenter = { x: 0, y: 0 };
  private plateCenterSig = 0;
  private turnGlow!: THREE.Sprite;
  private popups: Sprite2D[] = [];
  private popupIdx = 0;
  private flash!: THREE.Sprite;
  /** dark veil over the scene for the restore() fade-in */
  private fader!: THREE.Sprite;
  private fadeAmt = 0;

  // state
  private tiles: TileObj[] = [];
  private hands: number[][] = [[], [], [], []];
  /** seats in play (individual play: 2 → bottom/top, 3 → bottom/right/left); plates of the others are hidden */
  private active: boolean[] = [true, true, true, true];
  /** individual: the boneyard tiles left (drawn from the end) and their fixed slots (the order at the deal) */
  private pile: number[] = [];
  private pileOrder: number[] = [];
  /** the keep-out pushed into chainAvoid for the boneyard, so it can be replaced when the pile changes */
  private pileAvoidEntry: RectXZ | null = null;
  /** online: tiles whose identity is not known here (they stand in for hidden tiles; see hiddenTiles.ts) */
  private unknown: boolean[] = new Array<boolean>(TILE_COUNT).fill(false);
  /** physical set driving hand size and which global tile ids are live on the table */
  private tileSet: TileSet = 'double6';
  private tileSetDef: TileSetDef = TILE_SETS.double6;
  private get handSize(): number {
    return this.tileSetDef.handSize;
  }
  private chain: PlacedTile[] = [];
  private ends: { left: Pip; right: Pip } | null = null;
  private layoutRes: ChainLayoutResult = { poses: [], cell: MAX_CELL, fits: true, vertical: false, shift: { x: 0, y: 0 } };
  private turnSeat: Seat | null = null;
  private req: HumanReq | null = null;
  /** bumped by cancelHumanMove: a request still waiting for the queue to drain is abandoned */
  private reqGen = 0;
  private gen = 0;
  private queue: Promise<void> = Promise.resolve();
  private busy = 0;
  private needsSettle = false;
  private idleActive = false;
  /** this frame: the attract scenes run (idle + menu on screen) */
  private menuOn = false;
  /** main-menu attract ring (menuRing.ts), driven while idleActive and the menu is on screen */
  private menuDir!: MenuDirector;
  private idleCam: THREE.PerspectiveCamera | null = null;
  private idleScratch = new THREE.Vector3();
  /** the menu element ([data-attract]) last seen; null once it left */
  private menuEl: HTMLElement | null = null;
  private menuSeen = false;
  private menuPoll = 0;
  /** dev only: attract-scene time scale */
  private menuDev = { speed: 1 };
  /** pending tap on the menu's empty table area */
  private tapPtr = { id: -1, x: 0, y: 0, t: 0 };

  // layout
  private W = 1;
  private H = 1;
  private portrait = false;
  private camDist = 20;
  private baseCamPos = new THREE.Vector3();
  private baseCamQuat = new THREE.Quaternion();
  private lookTarget = new THREE.Vector3();
  private bounds: ChainBounds = { cx: 0, cz: 0, w: 16, h: 9 };
  /**
   * HTML plates: the side seats are edge columns (stack, plate right under it) hugging the screen edges
   * and the chain gets the full felt width, keeping clear of plates / stacks / bubble zones through
   * keep-out rects instead (portrait and landscape)
   */
  private edgeMode = false;
  private chainAvoid: AvoidRect[] = [];
  private chainMaxCell = MAX_CELL;
  private chainSoftMin = 0;
  private chainVertical: boolean | undefined = undefined;
  /** landscape edge columns: mirrored folds (right arm toward the viewer), no axis change */
  private chainFlip = false;
  /** safe-area insets (css px), left / right */
  private safeL = 0;
  private safeR = 0;
  private box = { x: 12, z0: -6, z1: 6 };
  private sideX = 10;
  private sideZ = 0;
  /** side-stack spacing multiplier (tightened a step on short viewports) */
  private sidePitchK = 1;
  /** HTML plates: side plates centred inboard beside their stacks (landscape) vs. below the near end */
  private sideBeside = false;
  private topZ = -5;
  private topOffX = 0;
  private handDh = 10;
  private handHalfH = 1;
  private handHs = 0.4;
  private handTopPx = 0;
  private handLeftPx = 0;
  private qBasisHand = new THREE.Quaternion();

  // loop (one pending frame at most, see frameLoop.ts)
  private loop = new FrameLoop({
    frame: (now) => this.loopFrame(now),
    canRun: () => !this.paused && !this.disposed,
    onError: (e, n) => {
      if (n === 1 || n % 60 === 0) console.error(`[render] frame failed (${n}x)`, e);
      if (n === 1) noteError('render frame', e);
    },
    onFatal: (e) => this.opts.onError?.(e),
    onStalled: () => {
      if (import.meta.env.DEV) console.warn('[render] requestAnimationFrame stalled: frames run from a timer');
      noteError('render', 'requestAnimationFrame stalled (timer fallback)');
    },
  });
  /** safety net: wakes the loop if it is asleep while animations are still pending */
  private heartbeat = 0;
  private lastT = 0;
  private lastRender = 0;
  private paused = false;
  private disposed = false;
  private shake = 0;
  private punch = 0;
  private shakeT = 0;
  private shakeDecay = 9;
  private flashAmt = 0;
  /** onFrameStats sampling window (see sampleFrame) */
  private fstat = { prev: 0, skip: 0, start: 0, sum: 0, n: 0 };
  private fstatOut: FrameStats = { avgFrameMs: 0, frames: 0, quality: 'high' };

  // input
  private ptr = { id: -1, x: 0, y: 0, sx: 0, sy: 0, tile: -1, dragging: false, down: false, t: 0, vx: 0, vy: 0, ghost: -1 };
  /** press-and-hold slam charge: the move it will play, the tile trembling, and the hold timer */
  private charge: { move: Move; tile: number; armed: boolean; t0: number; start: number } | null = null;
  /** pointer trail for the release velocity (fixed ring buffer, no allocations) */
  private trailX = new Float32Array(8);
  private trailY = new Float32Array(8);
  private trailT = new Float64Array(8);
  private trailN = 0;
  private chargeTimer = 0;
  private dragTarget = new THREE.Vector3();
  private dragQuat = new THREE.Quaternion();
  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private resizeObs: ResizeObserver | null = null;
  /** dev-only perf readout (?perf=1) */
  private perf: PerfHud | null = null;

  constructor(opts: TableViewOptions) {
    this.opts = opts;
    this.container = opts.container;
    this.quality = opts.quality;
    this.q = QUALITY[opts.quality];
    this.reduced = !!opts.reducedMotion;
    this.lang = opts.language ?? 'en';
    this.theme = opts.tileTheme ?? 'classic';
    this.tableStyle = opts.tableStyle && tex.TABLE_STYLE_DEFS[opts.tableStyle] ? opts.tableStyle : 'green';
    this.tileBack = opts.tileBack ?? 'ornate';
    this.speedMul = Math.max(0.1, opts.speed ?? 1);
    this.anim.speed = this.speedMul * (this.reduced ? 1.35 : 1);
    this.htmlPlates = !!opts.onPlates;
    for (let s = 0; s < 4; s++)
      this.plateBoxes.push({ x: 0, y: 0, w: 0, h: 0, d: 0, layout: 'row', scale: 1, rot: 0, visible: false, active: false, winner: false, count: 0, pips: null, bubble: { x: 0, y: 0, dir: 'up' } });

    if (import.meta.env.DEV && /[?&]perf=1/.test(location.search)) this.perf = new PerfHud(this.container);
    this.createRenderer();
    this.buildScene();
    this.buildOverlay();
    this.applyQualityKnobs();
    this.initTiles();

    const qb = new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0));
    this.qBasisHand.setFromRotationMatrix(qb);

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObs = new ResizeObserver(() => this.onResize());
      this.resizeObs.observe(this.container);
    }
    window.addEventListener('resize', this.onResize);
    this.menuDir = new MenuDirector(this.menuHost());
    if (import.meta.env.DEV) {
      // dev-only console handle: __kudoMenu.speed = 0 freezes the attract scenes for frame captures
      (window as unknown as { __kudoMenu: unknown }).__kudoMenu = Object.assign(this.menuDev, { director: this.menuDir });
    }
    window.addEventListener('pointerdown', this.onMenuDown, { passive: true });
    window.addEventListener('pointerup', this.onMenuUp, { passive: true });
    window.addEventListener('pointercancel', this.onMenuCancel, { passive: true });
    this.heartbeat = window.setInterval(this.checkAwake, 1000);
    this.onResize();
    this.prewarm();
    this.reset();
  }

  // ───────────────────────── main-menu attract scenes ─────────────────────────

  private menuHost(): MenuHost {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const view = this;
    return {
      tiles: this.tiles,
      fit: (box, maxS, out) => this.menuFit(box, maxS, out),
      offscreen: (x, y, z, r) => this.menuOffscreen(x, y, z, r),
      get lite() {
        return view.q.lite;
      },
      rnd: Math.random,
    };
  }

  /** the menu screen ([data-attract], set by ui/menu.ts) if it is on screen and not leaving */
  private menuOnScreen(): HTMLElement | null {
    let el = this.menuEl;
    if (!el || !el.isConnected || el.classList.contains('leaving')) {
      el = typeof document !== 'undefined' ? document.querySelector<HTMLElement>('[data-attract]:not(.leaving)') : null;
      this.menuEl = el;
    }
    if (el) this.menuSeen = true;
    return el;
  }

  /** a visible menu that shows the scenes; a menu marked data-attract="off" covers the table, so they stay parked */
  private scenesWanted(): boolean {
    const m = this.menuOnScreen();
    return m ? m.dataset.attract !== 'off' : !this.menuSeen;
  }

  /**
   * Scenes play while the view is idle and the menu is visible. Once a menu has been seen, its absence
   * (Ajustes, Cómo jugar…) parks them: the loop sleeps and a slow poll wakes it when the menu returns.
   * Without any menu ever (dev harness) they always play.
   */
  private menuLive(): boolean {
    if (!this.idleActive) return false;
    const on = this.scenesWanted();
    if (!on && !this.menuPoll) {
      this.menuPoll = window.setInterval(() => {
        if (this.disposed || !this.idleActive || this.scenesWanted()) {
          clearInterval(this.menuPoll);
          this.menuPoll = 0;
          this.lastT = 0;
          this.kick();
        }
      }, 400);
    }
    return on;
  }

  /**
   * Free screen rect for the attract scene (css px, y down), always centred: logo above the buttons →
   * the full width (centred on the screen) between the logo's bottom and the buttons' top; logo beside
   * the buttons (landscape phones) → the gap between them, or a screen-centred band when that gap is too
   * narrow (the scene then runs behind the dimmed buttons). The scene is scaled to fit, never shifted.
   */
  private menuFreeRect(out: { x0: number; y0: number; x1: number; y1: number }): void {
    const W = this.W;
    const H = this.H;
    const pad = 16;
    out.x0 = W * 0.06;
    out.x1 = W * 0.94;
    out.y0 = H * 0.3;
    out.y1 = H * 0.7;
    const el = this.menuOnScreen();
    if (!el) return;
    const base = this.container.getBoundingClientRect();
    const obs: DOMRect[] = [];
    el.querySelectorAll<HTMLElement>('[data-attract-avoid]').forEach((o) => {
      const r = o.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) obs.push(new DOMRect(r.x - base.x, r.y - base.y, r.width, r.height));
    });
    if (obs.length < 2) return;
    const [logo, buttons] = obs;
    if (logo.bottom <= buttons.top + 4) {
      out.x0 = pad;
      out.x1 = W - pad;
      out.y0 = logo.bottom + pad;
      out.y1 = Math.max(out.y0 + 40, buttons.top - pad);
    } else if (buttons.left - logo.right >= W * 0.15) {
      out.x0 = logo.right + pad;
      out.x1 = buttons.left - pad;
      out.y0 = pad;
      out.y1 = H - pad;
    } else {
      out.x0 = W * 0.28;
      out.x1 = W * 0.72;
      out.y0 = pad;
      out.y1 = H - pad;
    }
  }

  private freeRect = { x0: 0, y0: 0, x1: 0, y1: 0 };

  /** base camera (no shake / punch) for the scene fits */
  private fitCam(): THREE.PerspectiveCamera {
    const cam = (this.idleCam ??= new THREE.PerspectiveCamera());
    cam.position.copy(this.baseCamPos);
    cam.quaternion.copy(this.baseCamQuat);
    cam.updateMatrixWorld(true);
    cam.projectionMatrix.copy(this.camera.projectionMatrix);
    cam.projectionMatrixInverse.copy(this.camera.projectionMatrixInverse);
    return cam;
  }

  /** scale + centre so the local box fits the free rect (projected with the real camera, height included) */
  private menuFit(box: FitBox, maxS: number, out: Fit): void {
    const fr = this.freeRect;
    this.menuFreeRect(fr);
    const W = this.W;
    const H = this.H;
    const nx0 = (fr.x0 / W) * 2 - 1;
    const nx1 = (fr.x1 / W) * 2 - 1;
    const ny0 = 1 - (fr.y1 / H) * 2;
    const ny1 = 1 - (fr.y0 / H) * 2;
    const cam = this.fitCam();
    const p = this.idleScratch;
    const ray = this.raycaster;
    const bx = (box.x0 + box.x1) / 2;
    const bz = (box.z0 + box.z1) / 2;
    const place = (s: number): boolean => {
      // centre: the point under the rect centre at half the box height, nudged until the projection is centred
      this.ndc.set((nx0 + nx1) / 2, (ny0 + ny1) / 2);
      ray.setFromCamera(this.ndc, cam);
      this.plane.constant = -(box.h * s) / 2;
      if (!ray.ray.intersectPlane(this.plane, p)) return false;
      this.plane.constant = 0;
      out.s = s;
      out.cx = p.x - bx * s;
      out.cz = p.z - bz * s;
      for (let it = 0; it < 3; it++) {
        let mnx = Infinity;
        let mxx = -Infinity;
        let mny = Infinity;
        let mxy = -Infinity;
        for (let c = 0; c < 8; c++) {
          p.set(out.cx + (c & 1 ? box.x1 : box.x0) * s, c & 2 ? box.h * s : 0, out.cz + (c & 4 ? box.z1 : box.z0) * s).project(cam);
          mnx = Math.min(mnx, p.x);
          mxx = Math.max(mxx, p.x);
          mny = Math.min(mny, p.y);
          mxy = Math.max(mxy, p.y);
        }
        if (it === 2) return mnx >= nx0 && mxx <= nx1 && mny >= ny0 && mxy <= ny1;
        // shift by the centre offset (converted at the table plane)
        const dx = (nx0 + nx1) / 2 - (mnx + mxx) / 2;
        const dy = (ny0 + ny1) / 2 - (mny + mxy) / 2;
        this.ndc.set((nx0 + nx1) / 2, (ny0 + ny1) / 2);
        ray.setFromCamera(this.ndc, cam);
        if (!ray.ray.intersectPlane(this.plane, tmpV3)) return false;
        this.ndc.set((nx0 + nx1) / 2 + dx, (ny0 + ny1) / 2 + dy);
        ray.setFromCamera(this.ndc, cam);
        if (!ray.ray.intersectPlane(this.plane, tmpV2)) return false;
        out.cx += tmpV2.x - tmpV3.x;
        out.cz += tmpV2.z - tmpV3.z;
      }
      return false;
    };
    let lo = 0.05;
    let hi = maxS;
    if (place(hi)) return;
    for (let it = 0; it < 18; it++) {
      const mid = (lo + hi) / 2;
      if (place(mid)) lo = mid;
      else hi = mid;
    }
    place(lo);
  }

  private frustum = new THREE.Frustum();
  private frustumKey = [NaN, NaN, NaN, NaN];
  private sphere = new THREE.Sphere();

  /** is the sphere fully outside the (unshaken) camera view, with a margin? */
  private menuOffscreen(x: number, y: number, z: number, r: number): boolean {
    const k = this.frustumKey;
    if (k[0] !== this.W || k[1] !== this.H || k[2] !== this.camDist || k[3] !== this.baseCamPos.z) {
      k[0] = this.W;
      k[1] = this.H;
      k[2] = this.camDist;
      k[3] = this.baseCamPos.z;
      const cam = this.fitCam();
      tmpM.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      this.frustum.setFromProjectionMatrix(tmpM);
    }
    this.sphere.center.set(x, y, z);
    this.sphere.radius = r + 0.15;
    return !this.frustum.intersectsSphere(this.sphere);
  }

  /** taps on the menu's empty table area (the menu screen itself, not its buttons, logo or links) */
  private isMenuTap(e: PointerEvent): boolean {
    if (!this.idleActive || this.paused) return false;
    const tg = e.target as Element | null;
    if (!tg) return false;
    return tg === this.canvas || (tg instanceof HTMLElement && tg.hasAttribute('data-attract') && tg.dataset.attract !== 'off' && !tg.classList.contains('leaving'));
  }

  private onMenuDown = (e: PointerEvent): void => {
    if (!e.isPrimary || !this.isMenuTap(e)) {
      this.tapPtr.id = -1;
      return;
    }
    this.tapPtr.id = e.pointerId;
    this.tapPtr.x = e.clientX;
    this.tapPtr.y = e.clientY;
    this.tapPtr.t = performance.now();
  };

  private onMenuUp = (e: PointerEvent): void => {
    const p = this.tapPtr;
    if (p.id !== e.pointerId) return;
    p.id = -1;
    if (!this.isMenuTap(e) || performance.now() - p.t > 450 || Math.hypot(e.clientX - p.x, e.clientY - p.y) > 12) return;
    if (!this.menuLive()) return;
    const base = this.container.getBoundingClientRect();
    const x = e.clientX - base.left;
    const y = e.clientY - base.top;
    if (!this.pxToTable(x, this.H - y, tmpV3)) return;
    this.menuDir.tap(tmpV3.x, tmpV3.z);
    this.kick();
  };

  private onMenuCancel = (): void => {
    this.tapPtr.id = -1;
  };

  /**
   * Compile every shader up front (including the normally hidden fx: dust, confetti, shockwave ring,
   * drop slots, flash, popups), so the first slam / win doesn't stall on a compile mid-animation;
   * on weak phones a program link can take 100+ ms.
   */
  private prewarm(): void {
    const hidden: THREE.Object3D[] = [this.ring, this.ripple, this.turnLight, this.dust.points, this.confetti.points, this.ghostMesh, this.glowMesh, this.flash, this.fader, this.turnGlow];
    for (const p of this.popups) hidden.push(p.sprite);
    const was = hidden.map((o) => o.visible);
    for (const o of hidden) o.visible = true;
    try {
      this.renderer.compile(this.scene, this.camera);
      this.renderer.compile(this.overlay, this.overlayCam);
    } catch {
      /* best effort */
    }
    hidden.forEach((o, i) => (o.visible = was[i]));
  }

  // ───────────────────────── setup ─────────────────────────

  private createRenderer(): void {
    const old = this.renderer;
    const r = new THREE.WebGLRenderer({ antialias: this.q.aa, alpha: true, powerPreference: 'high-performance' });
    r.setClearColor(0x000000, 0);
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.15;
    r.autoClear = false;
    r.shadowMap.enabled = this.q.shadows;
    r.shadowMap.type = THREE.PCFShadowMap;
    r.setPixelRatio(this.pixelRatio());
    const c = r.domElement;
    c.style.cssText =
      'display:block;width:100%;height:100%;touch-action:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;' +
      `background:${tex.ROOM};`;
    // diagnostics for the error screen ("Detalles"): a lost GPU context is a classic phone-only failure
    c.addEventListener('webglcontextlost', () => noteError('webgl', 'context lost'));
    c.addEventListener('webglcontextrestored', () => noteError('webgl', 'context restored'));
    if (old) {
      this.detachInput();
      // a press in progress on the old canvas never gets its pointerup: forget it (else taps stay ignored)
      this.releasePointer();
      old.dispose();
      old.forceContextLoss(); // free the old context now (browsers cap live WebGL contexts)
      old.domElement.replaceWith(c);
    } else {
      this.container.appendChild(c);
    }
    this.renderer = r;
    this.canvas = c;
    if (import.meta.env.DEV && this.perf) r.info.autoReset = false;
    this.attachInput();
    if (old) {
      r.setSize(this.W, this.H, false);
    }
  }

  /** canvas resolution per CSS px for the current quality (low renders under 1:1 and is stretched by CSS) */
  private pixelRatio(): number {
    const q = this.q;
    return Math.min(q.dpr, Math.max(q.dprMin, (window.devicePixelRatio || 1) * q.dprScale));
  }

  /** quality knobs that live on existing objects (lights, particles, texture filtering) */
  private applyQualityKnobs(): void {
    const q = this.q;
    this.rimLight.visible = !q.lite;
    this.dust.limit = q.particles;
    this.dust.sizeMul = q.fxSize;
    this.dust.lifeMul = q.fxLife;
    this.confetti.limit = q.confetti;
    this.confetti.sizeMul = q.lite ? 0.85 : 1;
    this.confetti.lifeMul = q.lite ? 0.75 : 1;
    this.atlas.anisotropy = q.aniso;
    if (!q.shake) {
      this.shake = 0;
      this.punch = 0;
      this.flashAmt = 0;
    }
    this.syncFeltMat();
  }

  /**
   * Arena material (felt + rail + room, one texture). It is drawn as painted: not tone mapped, and with
   * no lighting, so its edge is exactly the room colour behind the canvas. Without shadow maps that is
   * a MeshBasicMaterial (no per-fragment lighting on the biggest surface on screen). With them (high)
   * it is Lambert so it can receive the tiles' shadows, and its colour is divided by the light a flat
   * upward plane gets, which leaves the same pixels wherever no shadow falls.
   */
  private syncFeltMat(): void {
    const S = tex.tableStyleDef(this.tableStyle);
    let m = this.felt.material as THREE.MeshBasicMaterial | THREE.MeshLambertMaterial;
    const basic = !this.q.shadows;
    if (basic !== !!(m as THREE.MeshBasicMaterial).isMeshBasicMaterial) {
      const n = basic ? new THREE.MeshBasicMaterial() : new THREE.MeshLambertMaterial();
      n.map = m.map;
      n.toneMapped = false;
      m.dispose();
      this.felt.material = n;
      m = n;
    }
    m.color.setScalar(S.feltTint);
    if (basic) return;
    // three's Lambert: (hemi sky (normal straight up) + sum(dir colour * max(N.L, 0))) * albedo / PI
    const hemi = this.hemiLight;
    tmpC.copy(hemi.color).multiplyScalar(hemi.intensity);
    for (const l of [this.keyLight, this.rimLight]) {
      if (!l.visible) continue;
      tmpV.subVectors(l.position, l.target.position);
      const len = tmpV.length();
      const ndl = len > 0 ? Math.max(0, tmpV.y / len) : 0;
      tmpC.r += l.color.r * l.intensity * ndl;
      tmpC.g += l.color.g * l.intensity * ndl;
      tmpC.b += l.color.b * l.intensity * ndl;
    }
    m.color.r *= Math.PI / Math.max(1e-3, tmpC.r);
    m.color.g *= Math.PI / Math.max(1e-3, tmpC.g);
    m.color.b *= Math.PI / Math.max(1e-3, tmpC.b);
  }

  private buildScene(): void {
    const S = tex.tableStyleDef(this.tableStyle);
    const hemi = new THREE.HemisphereLight(S.hemiSky, S.hemiGround, S.hemi);
    this.scene.add(hemi);
    this.hemiLight = hemi;
    const key = new THREE.DirectionalLight(S.keyColor, S.key);
    key.position.set(-7, 16, 10);
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.bias = -0.0008;
    key.shadow.normalBias = 0.02;
    const sc = key.shadow.camera;
    sc.left = -16;
    sc.right = 16;
    sc.top = 16;
    sc.bottom = -16;
    // near plane clips casters higher than ~5 units (the camera-space human hand) so they never shadow the table
    sc.near = 14;
    sc.far = 40;
    key.castShadow = this.q.shadows;
    this.scene.add(key);
    this.scene.add(key.target);
    this.keyLight = key;
    const rim = new THREE.DirectionalLight(S.rimColor, S.rim);
    rim.position.set(9, 7, -12);
    this.scene.add(rim);
    this.rimLight = rim;

    // the arena: felt, rail and room on one plane (see syncFeltMat for the material)
    this.feltTex = null;
    const feltMat = new THREE.MeshLambertMaterial({ color: new THREE.Color(S.feltTint, S.feltTint, S.feltTint), toneMapped: false });
    this.felt = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), feltMat);
    this.felt.receiveShadow = true;
    this.felt.renderOrder = 0;
    this.scene.add(this.felt);
    // centre medallion (texture set by buildTable)
    this.emblem = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, opacity: 0, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
    );
    this.emblem.renderOrder = 0.4;
    this.scene.add(this.emblem);
    // turn light: a soft warm pool, additive
    this.turnLight = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        map: tex.makeRadial('rgba(255,226,170,1)', 'rgba(255,226,170,0)'),
        transparent: true,
        depthWrite: false,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      }),
    );
    this.turnLight.renderOrder = 0.6;
    this.turnLight.visible = false;
    this.scene.add(this.turnLight);

    // tiles
    this.atlas = tex.makeTileAtlas(this.q.atlas, this.theme, this.tileBack);
    this.tileGeo = buildTileGeometry(this.q.seg);
    this.fxAttr = new THREE.InstancedBufferAttribute(new Float32Array(TILE_COUNT * 2), 2);
    this.fxAttr.setUsage(THREE.DynamicDrawUsage);
    this.tileGeo.setAttribute('aFx', this.fxAttr);
    // matte, view-independent shading (Lambert: diffuse only, no specular/fresnel), so every tile in
    // the hand has the same face colour and pip contrast whatever its position or tilt
    this.tileMat = new THREE.MeshLambertMaterial({ map: this.atlas });
    patchTileMaterial(this.tileMat, this.uTime);
    this.tilesMesh = new THREE.InstancedMesh(this.tileGeo, this.tileMat, TILE_COUNT);
    this.tilesMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.tilesMesh.frustumCulled = false;
    this.tilesMesh.castShadow = true;
    this.tilesMesh.receiveShadow = this.q.shadows;
    this.tilesMesh.renderOrder = 3;
    this.scene.add(this.tilesMesh);

    // blob shadows
    const blobMat = new THREE.MeshBasicMaterial({ map: tex.makeBlob(), transparent: true, depthWrite: false, color: 0xffffff, opacity: 0.55 });
    blobMat.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace(
        '#include <color_fragment>',
        '#include <color_fragment>\n#ifdef USE_INSTANCING_COLOR\n diffuseColor.a *= vColor.r; diffuseColor.rgb = vec3(0.02,0.01,0.0);\n#endif',
      );
    };
    this.blobMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), blobMat, TILE_COUNT);
    this.blobMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(TILE_COUNT * 3).fill(1), 3);
    this.blobMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.blobMesh.frustumCulled = false;
    this.blobMesh.renderOrder = 1;
    this.blobMesh.visible = !this.q.shadows;
    this.scene.add(this.blobMesh);

    // glows: one halo behind every global tile id; the drop slots use their own 2-instance mesh below
    const glowMat = new THREE.MeshBasicMaterial({
      map: tex.makeGhostSlot(), // shared tile-shaped outline (rims on playable tiles + drop slots)
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      toneMapped: false,
    });
    // instance colour = hue * intensity; intensity becomes alpha so gold stays gold over the green felt
    glowMat.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace(
        '#include <color_fragment>',
        `#include <color_fragment>
#ifdef USE_INSTANCING_COLOR
 float gm = max(max(vColor.r, vColor.g), vColor.b);
 diffuseColor.rgb = vColor / max(gm, 1e-3);
 diffuseColor.a *= clamp(gm, 0.0, 1.0);
#endif`,
      );
    };
    this.glowMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), glowMat, TILE_COUNT);
    this.glowMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(TILE_COUNT * 3), 3);
    this.glowMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.glowMesh.frustumCulled = false;
    this.glowMesh.renderOrder = 2;
    this.scene.add(this.glowMesh);
    // drop-slot ghosts: tile-shaped outline (crisp, tile corner radius), same tint shader
    const ghostMat = glowMat.clone();
    ghostMat.map = glowMat.map; // one shared outline texture so rim and slot always match
    ghostMat.onBeforeCompile = glowMat.onBeforeCompile;
    this.ghostMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), ghostMat, 2);
    this.ghostMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(2 * 3), 3);
    this.ghostMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.ghostMesh.frustumCulled = false;
    this.ghostMesh.renderOrder = 2;
    this.ghostMesh.visible = false;
    this.scene.add(this.ghostMesh);

    {
      // impact ring texture (used by the finishing shockwave)
      const c = document.createElement('canvas');
      c.width = c.height = 128;
      const g2 = c.getContext('2d')!;
      const grd = g2.createRadialGradient(64, 64, 36, 64, 64, 63);
      grd.addColorStop(0, 'rgba(255,214,140,0)');
      grd.addColorStop(0.55, 'rgba(255,214,140,1)');
      grd.addColorStop(1, 'rgba(255,214,140,0)');
      g2.fillStyle = grd;
      g2.fillRect(0, 0, 128, 128);
      const rt = new THREE.CanvasTexture(c);
      rt.colorSpace = THREE.SRGBColorSpace;
      this.ring = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ map: rt, transparent: true, depthWrite: false, opacity: 0, toneMapped: false }),
      );
      this.ring.renderOrder = 2;
      this.ring.visible = false;
      this.scene.add(this.ring);
      this.ripple = new THREE.Mesh(this.ring.geometry, new THREE.MeshBasicMaterial({ map: rt, transparent: true, depthWrite: false, opacity: 0, toneMapped: false }));
      this.ripple.renderOrder = 2;
      this.ripple.visible = false;
      this.scene.add(this.ripple);
    }
    this.dust = new Particles(360, { atten: true, shape: 'soft' });
    this.dust.gravity = -7;
    this.dust.drag = 2.2;
    this.dust.limit = this.q.particles;
    this.dust.floorY = 0.015;
    this.dust.floorK = 0.5;
    this.dust.killOnFloor = true;
    this.dust.material.uniforms.uOpacity.value = 0.5;
    this.dust.points.renderOrder = 5;
    this.scene.add(this.dust.points);
  }

  private buildOverlay(): void {
    const names = this.opts.playerNames;
    for (let s = 0; s < 4; s++) {
      const c = document.createElement('canvas');
      this.plateInfo.push({ name: names[s] ?? `P${s + 1}`, count: 0, team: (s % 2) as 0 | 1, active: false, pips: null, winner: false });
      tex.drawPlate(c, this.plateInfo[s]);
      const t = tex.canvasTexture(c);
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
      sp.renderOrder = 10;
      this.overlay.add(sp);
      this.plates.push({ sprite: sp, canvas: c, tex: t });
    }
    this.turnGlow = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: tex.makeRadial('rgba(255,196,96,0.9)', 'rgba(255,170,60,0)'),
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: THREE.NormalBlending,
        toneMapped: false,
      }),
    );
    this.turnGlow.renderOrder = 9;
    this.turnGlow.visible = false;
    this.overlay.add(this.turnGlow);
    for (let i = 0; i < 2; i++) {
      const c = document.createElement('canvas');
      tex.drawPopup(c, ' ', 'gold');
      const t = tex.canvasTexture(c);
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
      sp.visible = false;
      sp.renderOrder = 20;
      this.overlay.add(sp);
      this.popups.push({ sprite: sp, canvas: c, tex: t });
    }
    this.flash = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: tex.makeRadial('rgba(255,255,255,0)', 'rgba(255,255,255,1)'),
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
        opacity: 0,
      }),
    );
    this.flash.visible = false;
    this.flash.renderOrder = 30;
    this.overlay.add(this.flash);
    this.fader = new THREE.Sprite(
      new THREE.SpriteMaterial({ color: 0x050403, transparent: true, depthTest: false, depthWrite: false, toneMapped: false, opacity: 0 }),
    );
    this.fader.visible = false;
    this.fader.renderOrder = 40;
    this.overlay.add(this.fader);

    this.confetti = new Particles(300, { atten: false, shape: 'confetti' });
    this.confetti.gravity = -900;
    this.confetti.drag = 1.6;
    this.confetti.wobble = 260;
    this.confetti.limit = this.q.confetti;
    this.confetti.points.renderOrder = 25;
    this.overlay.add(this.confetti.points);
  }

  private initTiles(): void {
    for (let i = 0; i < TILE_COUNT; i++) {
      this.tiles.push({
        id: i,
        tile: TILE_BY_ID[i],
        pos: new THREE.Vector3(0, -5, 0),
        quat: new THREE.Quaternion(),
        s: 0.8,
        sq: 1,
        off: new THREE.Vector3(),
        wx: 0,
        wz: 0,
        loc: 'idle',
        seat: -1,
        glow: 0,
        dim: 0,
        token: 0,
      });
    }
  }

  // ───────────────────────── layout / resize ─────────────────────────

  private onResize = (): void => {
    if (this.disposed) return;
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    const pr = this.pixelRatio();
    if (pr !== this.renderer.getPixelRatio()) {
      this.renderer.setPixelRatio(pr);
      if (w === this.W && h === this.H && this.arenaKey) {
        // same CSS size, new device pixel ratio (zoom / another screen): px-based sizes follow
        this.renderer.setSize(w, h, false);
        this.computeLayout();
        this.kick();
        return;
      }
    }
    if (w === this.W && h === this.H && this.arenaKey) return;
    this.W = w;
    this.H = h;
    this.renderer.setSize(w, h, false);
    this.computeLayout();
    if (this.anim.active || this.busy > 0) this.needsSettle = true;
    else this.snapAll();
    this.kick();
  };

  private computeLayout(): void {
    const W = this.W;
    const H = this.H;
    const aspect = W / H;
    this.portrait = aspect < 0.9;
    const cam = this.camera;
    cam.aspect = aspect;
    cam.fov = this.portrait ? 46 : 36;
    cam.updateProjectionMatrix();
    const elev = THREE.MathUtils.degToRad(this.portrait ? 63 : 56);

    // human hand metrics in units of the hand plane half-height (independent of distance)
    const hand = this.handSize;
    const hsN = Math.min((2 * aspect * 0.92) / (hand * 1.06 * TW), (this.portrait ? 0.3 : 0.34) / TL);
    const bottomN = this.portrait ? 0.05 : 0.06;
    const handTopNdc = -1 + bottomN + TL * hsN + 0.3 * hsN;
    this.plateW = Math.round(THREE.MathUtils.clamp(Math.min(W, H) * 0.32, 104, 176));
    this.plateH = Math.round((this.plateW * tex.PLATE_H) / tex.PLATE_W);
    const handLeftNdc = -(hand * 1.06 * TW * hsN) / 2 / aspect;
    // HTML plates (KuCards): bigger faces, and one wide compact plate per seat (avatar above the name)
    const minWH = Math.min(W, H);
    const D = this.portrait ? Math.max(44, Math.min(70, Math.round(minWH * 0.13))) : Math.max(40, Math.min(78, Math.round(minWH * 0.105)));
    const rowW = Math.round(Math.max(96, D * 1.8));
    const rowH = Math.round(D * 1.36);
    const stackW = rowW;
    const stackH = rowH;
    const humanW = this.htmlPlates ? rowW : this.plateW;
    const plateBesideHand = (handLeftNdc + 1) * 0.5 * W > humanW + 24;
    const yBot = handTopNdc + (plateBesideHand ? 0.05 : this.htmlPlates ? (2 * (rowH + 10)) / H + 0.02 : (this.plateH * 2) / H + 0.03);
    // keep the top band free for the HTML HUD (score card, hand line + open ends): ~84 css px
    const yTop = Math.min(0.74, 1 - (2 * 84) / H);

    this.box = this.portrait ? { x: 6.4, z0: -9.4, z1: 6.6 } : { x: 12.6, z0: -6.6, z1: 5.4 };
    const box = this.box;
    const corners = [
      new THREE.Vector3(-box.x, 0, box.z0),
      new THREE.Vector3(box.x, 0, box.z0),
      new THREE.Vector3(-box.x, 0, box.z1),
      new THREE.Vector3(box.x, 0, box.z1),
    ];
    const place = (d: number, tz: number) => {
      cam.position.set(0, d * Math.sin(elev), tz + d * Math.cos(elev));
      cam.lookAt(0, 0, tz);
      cam.updateMatrixWorld(true);
    };
    const ndcY = (v: V3) => tmpV.copy(v).project(cam).y;
    const centerFor = (d: number): number => {
      // find tz so the box's vertical span is centred in [yBot, yTop]
      let lo = -30;
      let hi = 30;
      const want = (yTop + yBot) / 2;
      for (let i = 0; i < 28; i++) {
        const mid = (lo + hi) / 2;
        place(d, mid);
        const c = (ndcY(corners[0]) + ndcY(corners[2])) / 2;
        if (c > want) hi = mid;
        else lo = mid;
      }
      return (lo + hi) / 2;
    };
    const fits = (d: number): boolean => {
      const tz = centerFor(d);
      place(d, tz);
      for (const c of corners) {
        tmpV.copy(c).project(cam);
        if (Math.abs(tmpV.x) > 0.97 || tmpV.y > yTop + 1e-3 || tmpV.y < yBot - 1e-3) return false;
      }
      return true;
    };
    const fitDist = (): number => {
      let lo = 4;
      let hi = 120;
      for (let i = 0; i < 26; i++) {
        const mid = (lo + hi) / 2;
        if (fits(mid)) hi = mid;
        else lo = mid;
      }
      return hi;
    };
    const setZ0 = (z0: number) => {
      box.z0 = z0;
      corners[0].z = corners[1].z = z0;
    };
    let hi = fitDist();
    if (!this.portrait && this.htmlPlates) {
      // landscape edge columns: the height-bound fit leaves broad wood margins left and right. Take a
      // shallower box (the camera comes closer) until the width binds too: the felt then spans the screen
      // between the side columns, and the far edge still meets the HUD band.
      const xBound = (): boolean => {
        place(hi, centerFor(hi));
        for (const c of corners) if (Math.abs(tmpV.copy(c).project(cam).x) > 0.97 - 2e-3) return true;
        return false;
      };
      if (!xBound()) {
        let zlo = box.z0;
        let zhi = box.z1 - 6;
        for (let i = 0; i < 18; i++) {
          setZ0((zlo + zhi) / 2);
          hi = fitDist();
          if (xBound()) zhi = box.z0;
          else zlo = box.z0;
        }
        setZ0(zhi);
        hi = fitDist();
      }
    }
    this.camDist = hi;
    const tz = centerFor(hi);
    place(hi, tz);
    this.lookTarget.set(0, 0, tz);
    this.baseCamPos.copy(cam.position);
    this.baseCamQuat.copy(cam.quaternion);
    if (this.portrait && this.htmlPlates) {
      // portrait is width-bound: the box ends up centred with spare height above it (wood and sky).
      // Grow the felt away from the viewer until its far edge meets the HUD band: the partner's row moves
      // up and the chain gets that height.
      const farY = (z: number) => ndcY(tmpV2.set(box.x, 0, z));
      if (farY(box.z0) < yTop - 0.01) {
        let zlo = box.z0 - 12;
        let zhi = box.z0;
        for (let i = 0; i < 26; i++) {
          const mid = (zlo + zhi) / 2;
          if (farY(mid) > yTop) zlo = mid;
          else zhi = mid;
        }
        box.z0 = zhi;
      }
    }

    // hand plane
    this.handDh = this.camDist * 0.45;
    this.handHalfH = this.handDh * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
    this.handHs = hsN * this.handHalfH;
    this.handTopPx = ((handTopNdc + 1) / 2) * H;
    this.handLeftPx = ((handLeftNdc + 1) / 2) * W;

    // seats
    this.topZ = box.z0 + 1.0;
    // HTML plates: the side seats are edge columns (stack, plate right under it) in both orientations
    this.edgeMode = this.htmlPlates;
    // edge columns: the side stacks stand tight against the frame, out of the felt's width
    this.sideX = this.edgeMode ? box.x + EDGE_STACK_OUT : box.x - 0.8;
    this.sideZ = (box.z0 + box.z1) / 2 - (this.portrait ? 1.2 : 0.5);
    // portrait: the partner's row is centred (its HTML plate sits under it); the 3D plate needs room beside it
    this.topOffX = this.portrait && !this.htmlPlates ? -1.2 : 0;
    this.sideBeside = !this.portrait && !this.edgeMode;
    const handHalfLen = (hand * TW * OPP_SCALE * 1.12) / 2;

    // chain bounds: between the hands
    const cz0 = this.topZ + 1.7;
    const cz1 = box.z1;
    const cx = this.edgeMode ? box.x - 0.8 - 1.4 : this.sideX - (this.portrait ? 1.4 : 2.8);
    this.bounds = { cx: 0, cz: (cz0 + cz1) / 2, w: cx * 2, h: cz1 - cz0 };
    this.chainAvoid = [];
    this.chainMaxCell = MAX_CELL;
    this.chainSoftMin = 0;
    this.chainVertical = undefined;
    this.chainFlip = false;
    if (this.edgeMode) this.readSafeArea();
    else this.safeL = this.safeR = 0;

    // shadow camera centred on the table
    this.keyLight.target.position.set(0, 0, this.bounds.cz);
    this.keyLight.position.set(-7, 16, this.bounds.cz + 10);

    this.buildTable();

    if (this.htmlPlates) {
      this.layoutHtmlPlates(D, plateBesideHand, bottomN, hsN);
    } else this.layoutSpritePlates(plateBesideHand, bottomN, hsN, handHalfLen);

    // overlay camera
    this.overlayCam.left = 0;
    this.overlayCam.right = W;
    this.overlayCam.top = H;
    this.overlayCam.bottom = 0;
    this.overlayCam.updateProjectionMatrix();
    const dpr = this.renderer.getPixelRatio();
    this.confetti.material.uniforms.uPx.value = dpr;
    this.dust.material.uniforms.uScale.value = (H * dpr) / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)));
    this.flash.scale.set(W * 1.1, H * 1.1, 1);
    this.flash.position.set(W / 2, H / 2, 0);
    this.fader.scale.set(W + 4, H + 4, 1);
    this.fader.position.set(W / 2, H / 2, 0);

    this.layoutRes = this.fitChain(this.chain);
    if (this.req && this.req.selected >= 0) this.computeGhosts(this.req.selected);
  }

  /**
   * Chain layout for the current bounds. `preview` (drag placeholders / drop zones) keeps the live
   * cell size, orientation and slide so a ghost lands exactly where the tile will.
   */
  private fitChain(chain: PlacedTile[], preview = false): ChainLayoutResult {
    const avoid = this.chainAvoid.length ? this.chainAvoid : undefined;
    if (preview) {
      const r = this.layoutRes;
      return layoutChain(chain, this.bounds, { cell: r.cell, vertical: r.vertical, shift: r.shift, avoid, flip: this.chainFlip || undefined });
    }
    return layoutChain(chain, this.bounds, {
      maxCell: this.chainMaxCell,
      softMinCell: this.chainSoftMin || undefined,
      vertical: this.chainVertical,
      avoid,
      ...(this.chainFlip ? { flip: true, allowTurnAxis: false, maxSlide: 6 } : {}),
    });
  }

  /** safe-area insets (left / right) from the CSS env(), measured on a throwaway probe */
  private readSafeArea(): void {
    this.safeL = this.safeR = 0;
    if (typeof document === 'undefined' || !document.body) return;
    const el = document.createElement('div');
    el.style.cssText =
      'position:fixed;visibility:hidden;pointer-events:none;padding-left:env(safe-area-inset-left,0px);padding-right:env(safe-area-inset-right,0px)';
    document.body.append(el);
    const cs = getComputedStyle(el);
    this.safeL = parseFloat(cs.paddingLeft) || 0;
    this.safeR = parseFloat(cs.paddingRight) || 0;
    el.remove();
  }

  /** table-plane point under an overlay pixel (y up); false when the ray misses */
  private pxToTable(x: number, y: number, out: V3): boolean {
    this.ndc.set((x / this.W) * 2 - 1, (y / this.H) * 2 - 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    this.plane.constant = 0;
    return !!this.raycaster.ray.intersectPlane(this.plane, out);
  }

  /**
   * HTML plates. Every plate is anchored to its own seat's tiles:
   *  - sides (1/3): compact stack right below the near end of the tile stack, mirror-symmetric; the
   *    stack+plate unit is centred vertically between the top HUD and a clearance band of 1.5 avatars
   *    above the human's plate and hand (avatars shrink a step when the viewport is too short);
   *  - partner (2): beside its row with the pair centred as a unit (or centred under the row when the
   *    pair does not fit the width), clear of the top HUD;
   *  - human (0): to the left of the hand of fichas (just above its left end when there is no room beside it);
   * Every seat uses the same compact stack plate (KuCards): the avatar sits above a wide name pill,
   * with the fichas-left count at the pill's right end.
   * Each seat also gets a speech-bubble anchor on its table-centre side, and the chain bounds avoid
   * all plates and bubble zones. Overlay px, y up (converted to CSS on emit).
   */
  private layoutHtmlPlates(D0: number, besideHand: boolean, bottomN: number, hsN: number): void {
    const W = this.W;
    const H = this.H;
    const B = this.plateBoxes;
    const scr = { x: 0, y: 0 };
    const so = OPP_SCALE;
    const topPitch = TW * so * 1.12;
    const halfRow = this.handSize / 2;
    const lean = 0.32;
    const box = this.box;
    let D = D0;
    // side stacks may tighten their spacing a step on short viewports (never slide into the corners)
    this.sidePitchK = 1;
    let pitch = topPitch;
    let rowW = 0;
    let rowH = 0;
    let stackW = 0;
    let stackH = 0;
    const setBox = (s: number, layout: 'row' | 'stack', x: number, y: number) => {
      const b = B[s];
      b.layout = layout;
      b.w = layout === 'row' ? rowW : stackW;
      b.h = layout === 'row' ? rowH : stackH;
      b.d = D;
      b.x = THREE.MathUtils.clamp(x, b.w / 2 + 4, W - b.w / 2 - 4);
      b.y = THREE.MathUtils.clamp(y, b.h / 2 + 4, H - b.h / 2 - 4);
      this.plateX[s] = b.x;
      this.plateY[s] = b.y;
    };
    /** side stack at centre z `sz`: screen x/y (y up) of its near foot, the y of its far top and of its far foot */
    const sideMeasure = (sz: number, out: { nx: number; ny: number; ty: number; fy: number }) => {
      this.toScreen(tmpV2.set(this.sideX, 0, sz + halfRow * pitch), scr);
      out.nx = scr.x;
      out.ny = scr.y;
      this.toScreen(tmpV2.set(this.sideX + Math.sin(lean) * TL * so, Math.cos(lean) * TL * so, sz - halfRow * pitch), scr);
      out.ty = scr.y;
      this.toScreen(tmpV2.set(this.sideX, 0, sz - halfRow * pitch), scr);
      out.fy = scr.y;
    };
    const m = { nx: 0, ny: 0, ty: 0, fy: 0 };
    /** the side plate sits inboard of the stack's near end, its top this fraction of its height above the foot */
    // (edge plates sit in the same screen column as the stack: right under its near end instead)
    const PLATE_RISE = this.edgeMode ? 0.02 : 0.28;
    const edge = this.edgeMode;
    for (let s = 0; s < 4; s++) B[s].edge = undefined;
    const topFree = H - HUD_PX; // y-up: nothing of ours above this line
    // landscape edge columns stand under the HUD's corners (score card / pause), clear of the partner's row
    const landEdge = edge && !this.portrait;
    const sideTop = landEdge ? H - HUD_SIDE_PX : topFree;
    for (let attempt = 0; ; attempt++) {
      // one compact plate shape for everyone: wide enough for a full name and the ficha count at its end
      rowW = Math.round(Math.max(96, D * 1.8));
      rowH = Math.round(D * 1.36);
      stackW = rowW;
      stackH = rowH;
      // human: left of the hand (y-up: small y is the bottom), just above its left end when there is
      // no room beside it — same spot as before the plate redesign
      if (besideHand) setBox(0, 'stack', Math.max(stackW / 2 + 10, this.handLeftPx - stackW / 2 - 16), ((-1 + bottomN + (TL * hsN) / 2 + 1) / 2) * H);
      else setBox(0, 'stack', stackW / 2 + 10, this.handTopPx + stackH / 2 + 6);

      // partner: avatar beside the row, the pair centred as a unit; otherwise centred under the row
      this.topOffX = 0;
      this.toScreen(tmpV2.set(-halfRow * topPitch, 0.4, this.topZ), scr);
      const xl = scr.x;
      this.toScreen(tmpV2.set(halfRow * topPitch, 0.4, this.topZ), scr);
      const rowPx = scr.x - xl;
      const rowY = scr.y;
      const ppu = rowPx / (this.handSize * topPitch);
      const gapTop = 10;
      const total = rowPx + gapTop + rowW;
      if (total <= W - 24) {
        this.topAnchor = 'right';
        const left = W / 2 - total / 2;
        this.topOffX = (left + rowPx / 2 - W / 2) / ppu;
        setBox(2, 'stack', left + rowPx + gapTop + stackW / 2, Math.min(rowY, topFree - stackH / 2));
      } else {
        this.topAnchor = 'center';
        this.toScreen(tmpV2.set(0, 0, this.topZ + TL * so * 0.5), scr);
        setBox(2, 'stack', scr.x, Math.min(scr.y - stackH / 2 - 2, topFree - stackH / 2));
      }

      // sides: the stack + its plate (just inboard-below the stack's near end) form one unit, centred
      // vertically on the side edge between the top row (keeping a gap of at least one tile length) and a
      // clearance band of 1.5 avatars above the human's plate and hand. When the band is too short the
      // side stacks tighten their spacing, then the avatars shrink a step; they never slide into a corner.
      // y-up: plates stay above (landscape edge columns are beside the hand, not over it: a smaller gap)
      const minY = landEdge
        ? this.plateY[0] + rowH / 2 + 0.3 * D
        : Math.max(this.plateY[0] + rowH / 2, this.handTopPx) + 0.9 * D;
      this.toScreen(tmpV2.set(0, 0, this.topZ + 0.2), scr);
      const rowFoot = scr.y;
      // landscape: the plate sits inboard beside the stack, centred on it (the stack itself is centred on
      // the side edge); portrait (no width to spare): just inboard-below the stack's near end
      const beside = this.sideBeside;
      const unitTop = (sz: number) => (sideMeasure(sz, m), beside ? Math.max(m.ty, (m.ty + m.ny) / 2 + stackH / 2) : m.ty);
      const unitBottom = (sz: number) =>
        (sideMeasure(sz, m), beside ? Math.min(m.ny, (m.ty + m.ny) / 2 - stackH / 2) : m.ny + PLATE_RISE * stackH - stackH);
      // one side tile's length on screen near the top of the band
      const tileLenPx = (sz: number) => (sideMeasure(sz, m), ((m.fy - m.ny) / this.handSize) * (TL / (TW * 1.12 * this.sidePitchK)));
      /** z where the screen y `f(z)` equals `want` (screen y falls as z grows, nearer the viewer) */
      const solve = (f: (z: number) => number, want: number): number => {
        let lo = box.z0 - 6;
        let hi = box.z1 + 6;
        for (let i = 0; i < 30; i++) {
          const mid = (lo + hi) / 2;
          if (f(mid) > want) lo = mid;
          else hi = mid;
        }
        return (lo + hi) / 2;
      };
      const stackMid = (z: number) => (sideMeasure(z, m), (m.ty + m.ny) / 2);
      const unitMid = (z: number) => (unitTop(z) + unitBottom(z)) / 2;
      const centreFor = (want: number): number => solve(unitMid, want);
      // the stack itself is centred in the band; the plate (below it in portrait) only nudges it up when
      // it would reach the human's clearance band
      let sz = solve(stackMid, (topFree + minY) / 2);
      let bandTop = landEdge ? sideTop : Math.min(topFree, rowFoot - tileLenPx(sz));
      // (landscape edge columns: the whole stack + plate unit is centred)
      sz = landEdge ? centreFor((bandTop + minY) / 2) : solve(stackMid, (bandTop + minY) / 2);
      if (!landEdge) bandTop = Math.min(topFree, rowFoot - tileLenPx(sz));
      if (unitBottom(sz) < minY) sz = solve(unitBottom, minY);
      if (unitTop(sz) > bandTop) sz = solve(unitTop, bandTop);
      const fits = unitTop(sz) <= bandTop + 0.5 && unitBottom(sz) >= minY - 0.5;
      if (!fits && attempt < 6) {
        if (this.sidePitchK > 0.91) {
          this.sidePitchK = Math.max(0.9, this.sidePitchK - 0.05);
          pitch = topPitch * this.sidePitchK;
          continue;
        }
        if (D > 36) {
          D = Math.max(36, Math.round(D * 0.88));
          continue;
        }
      }
      if (!fits) {
        // still too short: stay centred between the top row's foot and the human's clearance band
        sz = centreFor((Math.min(topFree, rowFoot - 4) + minY) / 2);
      }
      const base = { ...this.bounds };
      this.sideZ = sz;
      if (edge) {
        // the stack stands as far out as the frame allows, but its near end (the widest on screen) stays
        // fully visible: its outer top corner keeps a few px from the screen edge
        const limitPx = W - Math.max(this.safeL, this.safeR) - 5;
        const outerTop = (x: number) => (
          this.toScreen(tmpV2.set(x + Math.sin(lean) * TL * so + TH * so, Math.cos(lean) * TL * so, sz + halfRow * pitch + TW * so * 0.5), scr), scr.x
        );
        let lo = box.x - 3;
        let hi = box.x + EDGE_STACK_OUT;
        if (outerTop(hi) > limitPx) {
          for (let i = 0; i < 24; i++) {
            const mid = (lo + hi) / 2;
            if (outerTop(mid) > limitPx) hi = mid;
            else lo = mid;
          }
          this.sideX = lo;
        } else this.sideX = hi;
      }
      sideMeasure(sz, m);
      // seat 1 (right) and seat 3 (left) mirror each other exactly
      if (beside) {
        // inboard of the stack and of the zone its tiles are revealed in (revealPose), centred on the stack
        const cy = (m.ty + m.ny) / 2;
        this.toScreen(tmpV2.set(this.sideX - SIDE_PLATE_GAP, 0, sz), scr);
        const x1 = THREE.MathUtils.clamp(scr.x - stackW / 2, stackW / 2 + 4, W - stackW / 2 - 4);
        setBox(1, 'stack', x1, cy);
        setBox(3, 'stack', W - x1, cy);
      } else if (edge) {
        // portrait: the plate hugs the screen edge (over the frame), right under the stack's near end
        const inset = Math.max(this.safeL, this.safeR) + 4;
        const py = m.ny + PLATE_RISE * stackH - stackH / 2;
        let x3 = inset + stackW / 2;
        if (!this.portrait) {
          // landscape: centred under the stack's near tile (the stack hugs the edge), never past the edge
          this.toScreen(tmpV2.set(this.sideX + 0.5 * Math.sin(lean) * TL * so, 0.5 * Math.cos(lean) * TL * so, sz + halfRow * pitch), scr);
          x3 = Math.max(x3, W - scr.x);
        }
        setBox(1, 'stack', W - x3, py);
        setBox(3, 'stack', x3, py);
        B[1].edge = 'right';
        B[3].edge = 'left';
      } else {
        // the plate tucks a little inboard, just below the stack's near end
        const x1 = THREE.MathUtils.clamp(m.nx - stackW * 0.62, stackW / 2 + 4, W - stackW / 2 - 4);
        setBox(1, 'stack', x1, m.ny + PLATE_RISE * stackH - stackH / 2);
        setBox(3, 'stack', W - x1, m.ny + PLATE_RISE * stackH - stackH / 2);
      }
      // speech-bubble anchors, on each plate's table-centre side
      const bx0 = THREE.MathUtils.clamp(B[0].x, BUBBLE_W / 2 + 4, W - BUBBLE_W / 2 - 4);
      // edge mode: beside the human's plate (one compact keep-out band above the hand instead of a
      // bubble zone poking up into the chain area)
      // landscape edge columns: left of the human's plate (out of the chain area) when the corner has room
      if (edge && !besideHand && B[0].x + B[0].w / 2 + 6 + BUBBLE_W <= W - 6) this.setBubble(0, B[0].x + B[0].w / 2 + 6, B[0].y, 'right');
      else if (
        edge &&
        besideHand &&
        B[0].x - B[0].w / 2 - 6 - BUBBLE_W >= 6 &&
        B[0].y + BUBBLE_H / 2 + 4 <= B[3].y - B[3].h / 2
      )
        this.setBubble(0, B[0].x - B[0].w / 2 - 6, B[0].y, 'left');
      else this.setBubble(0, bx0, B[0].y + B[0].h / 2 + 6, 'up');
      // landscape: the side plates sit mid-height, so their bubbles go above them (a bubble beside the plate
      // would cut the chain area in two); portrait: beside the plate, toward the table centre
      // edge plates: the compact bubble rises over the seat's own stack, clamped to the screen edge, so it
      // grows inward without cutting the felt in two
      if (beside || edge) this.setBubble(1, B[1].x, B[1].y + B[1].h / 2 + 6, 'up');
      else this.setBubble(1, B[1].x - B[1].w / 2 - 6, B[1].y, 'left');
      // landscape edge columns: beside the partner's plate, in the top band (not down into the chain area)
      if (edge && !this.portrait && this.topAnchor === 'right' && B[2].x + B[2].w / 2 + 6 + BUBBLE_W <= W - 6)
        this.setBubble(2, B[2].x + B[2].w / 2 + 6, B[2].y, 'right');
      else this.setBubble(2, B[2].x, B[2].y - B[2].h / 2 - 6, 'down');
      if (beside || edge) this.setBubble(3, B[3].x, B[3].y + B[3].h / 2 + 6, 'up');
      else this.setBubble(3, B[3].x + B[3].w / 2 + 6, B[3].y, 'right');
      this.bounds = { ...base };
      if (edge) this.fitEdgeBounds(D);
      else this.fitChainBounds();
      break;
    }

    // table centre on screen (CSS px), for the avatars' glances
    this.toScreen(tmpV2.set(this.bounds.cx, 0, this.bounds.cz), scr);
    this.plateCenter.x = scr.x;
    this.plateCenter.y = H - scr.y;
    this.plateCenterSig = -1;
    for (let s = 0; s < 4; s++) this.plateSig[s] = -1;
  }

  private setBubble(s: number, x: number, y: number, dir: BubbleDir): void {
    this.bubX[s] = x;
    this.bubY[s] = y;
    this.bubDir[s] = dir;
  }

  /** overlay rect (y up) of seat s's plate (which = 0) or bubble zone (which = 1) */
  private seatRect(s: number, which: 0 | 1, out: { x0: number; x1: number; y0: number; y1: number }): void {
    const b = this.plateBoxes[s];
    if (which === 0) {
      out.x0 = this.plateX[s] - b.w / 2;
      out.x1 = this.plateX[s] + b.w / 2;
      out.y0 = this.plateY[s] - b.h / 2;
      out.y1 = this.plateY[s] + b.h / 2;
      // an edge plate's count badge pokes out above the avatar (its outer top corner)
      if (b.edge) out.y1 += b.d * 0.26;
      return;
    }
    const x = this.bubX[s];
    const y = this.bubY[s];
    const d = this.bubDir[s];
    const BW = b.edge ? BUBBLE_EDGE_W : BUBBLE_W;
    const BH = b.edge ? BUBBLE_EDGE_H : BUBBLE_H;
    out.x0 = d === 'left' ? x - BW : d === 'right' ? x : x - BW / 2;
    // the UI clamps bubbles 6 px inside the view (edge plates' bubbles rely on it to grow inward)
    if (b.edge) out.x0 = THREE.MathUtils.clamp(out.x0, 6, Math.max(6, this.W - BW - 6));
    out.x1 = out.x0 + BW;
    out.y0 = d === 'up' ? y : d === 'down' ? y - BH : y - BH / 2;
    out.y1 = out.y0 + BH;
  }

  /**
   * Chain bounds clear of every plate and bubble zone. Two candidates: (A) narrow the width to the side
   * plates' and bubbles' inner edges; (B) narrow only to the side plates and keep the side bubbles out by
   * height. The larger rectangle wins. Camera has no roll, so a screen row is a constant table z.
   */
  private fitChainBounds(): void {
    const base = this.bounds;
    const r = { x0: 0, x1: 0, y0: 0, y1: 0 };
    const innerLimit = (s: number, which: 0 | 1): number => {
      this.seatRect(s, which, r);
      const xi = s === 1 ? r.x0 : r.x1;
      let lim = Infinity;
      for (const py of [r.y0, r.y1]) if (this.pxToTable(xi, py, tmpV3)) lim = Math.min(lim, Math.abs(tmpV3.x) - 0.3);
      return lim;
    };
    const fit = (halfW: number, rects: [number, 0 | 1][]): ChainBounds | null => {
      let cz0 = base.cz - base.h / 2;
      let cz1 = base.cz + base.h / 2;
      for (const [s, which] of rects) {
        this.seatRect(s, which, r);
        // the rect's horizontal extent on the table at its top and bottom rows
        let zTop = Infinity;
        let zBot = -Infinity;
        let overlaps = false;
        for (const py of [r.y0, r.y1]) {
          if (!this.pxToTable(r.x0, py, tmpV3)) continue;
          const xa = tmpV3.x;
          const z = tmpV3.z;
          if (!this.pxToTable(r.x1, py, tmpV3)) continue;
          const xb = tmpV3.x;
          if (Math.max(xa, xb) > -halfW - 0.3 && Math.min(xa, xb) < halfW + 0.3) overlaps = true;
          zTop = Math.min(zTop, z);
          zBot = Math.max(zBot, z);
        }
        if (!overlaps || zTop > cz1 || zBot < cz0) continue;
        // cut off whichever end leaves more room
        const keepBelow = cz1 - Math.max(cz0, zBot + 0.3);
        const keepAbove = Math.min(cz1, zTop - 0.3) - cz0;
        if (keepBelow >= keepAbove) cz0 = Math.max(cz0, zBot + 0.3);
        else cz1 = Math.min(cz1, zTop - 0.3);
      }
      if (cz1 - cz0 < 3 || halfW < 2.5) return null;
      return { cx: base.cx, cz: (cz0 + cz1) / 2, w: halfW * 2, h: cz1 - cz0 };
    };
    const plateHalf = Math.min(base.w / 2, innerLimit(1, 0), innerLimit(3, 0));
    const allHalf = Math.min(plateHalf, innerLimit(1, 1), innerLimit(3, 1));
    const a = fit(allHalf, [
      [0, 0],
      [0, 1],
      [2, 0],
      [2, 1],
    ]);
    const b = fit(plateHalf, [
      [0, 0],
      [0, 1],
      [2, 0],
      [2, 1],
      [1, 1],
      [3, 1],
    ]);
    const best = a && b ? (a.w * a.h >= b.w * b.h ? a : b) : (a ?? b);
    if (best) this.bounds = best;
    // never let the chain run under the side plates, even when no height cut fits
    else if (plateHalf >= 2.5) this.bounds = { ...base, w: plateHalf * 2 };
  }

  /**
   * Edge mode: the chain gets the whole felt between the partner's row and the human's hand (landscape:
   * also beside the fan, down to the bottom of the screen, horizontal with mirrored folds),
   * as wide as the felt (and the screen) allows; plates, bubble zones and the side stacks become keep-out
   * rects the snake must dodge, so they only cost room where they actually are. Also sets the chain's
   * size limits from on-screen px: at most ~0.8 of a hand tile, and a readability floor.
   */
  private fitEdgeBounds(D: number): void {
    void D;
    const base = this.bounds;
    const W = this.W;
    const H = this.H;
    const so = OPP_SCALE;
    const cz0 = base.cz - base.h / 2;
    let cz1 = base.cz + base.h / 2;
    const land = !this.portrait;
    // y-up px: a few px above the top of the human's fan (landscape: the felt beside the hand down to the
    // bottom of the screen too; the hand itself becomes a keep-out rect)
    const handPx = this.handTopPx + 8;
    const nearPx = land ? 10 : handPx;
    if (this.pxToTable(W / 2, nearPx, tmpV3)) cz1 = Math.max(cz0 + 3, tmpV3.z);
    let half = this.box.x + 0.9 - 0.35;
    // a rectangle: the screen edge is narrowest (in table units) at its near row (landscape: at the hand's
    // top row; the band beside the hand keeps clear of the screen edge through keep-out rects)
    const inset = Math.max(this.safeL, this.safeR) + 6;
    if (this.pxToTable(W - inset, handPx, tmpV3)) half = Math.min(half, Math.abs(tmpV3.x));
    this.bounds = { cx: 0, cz: (cz0 + cz1) / 2, w: half * 2, h: cz1 - cz0 };
    const r = { x0: 0, x1: 0, y0: 0, y1: 0 };
    const avoid: AvoidRect[] = [];
    // landscape: where the chain starts (and where its size is measured): mid-way between the partner's row
    // and the human's fan. The bounds stay centred on it, reaching past the band's top edge, which a
    // keep-out rect closes again.
    let zMid = this.bounds.cz;
    if (land && this.pxToTable(W / 2, handPx, tmpV3)) {
      const zh = tmpV3.z;
      zMid = (cz0 + Math.min(zh, cz1)) / 2;
      const top = Math.min(cz0, 2 * zMid - cz1);
      this.bounds = { cx: 0, cz: (top + cz1) / 2, w: half * 2, h: cz1 - top };
      if (top < cz0) avoid.push({ x0: -half - 1, x1: half + 1, z0: top - 1, z1: cz0 });
      // the band beside the fan: clear of the screen edge (narrower in table units toward the viewer)
      if (this.pxToTable(W - inset, nearPx, tmpV3)) {
        const xb = Math.abs(tmpV3.x);
        if (xb < half) {
          avoid.push({ x0: xb, x1: half + 1, z0: zh, z1: cz1 + 1 });
          avoid.push({ x0: -half - 1, x1: -xb, z0: zh, z1: cz1 + 1 });
        }
      }
    }
    const pad = 0.2;
    const addPx = () => {
      let x0 = Infinity;
      let x1 = -Infinity;
      let z0 = Infinity;
      let z1 = -Infinity;
      for (const [px, py] of [
        [r.x0, r.y0],
        [r.x1, r.y0],
        [r.x0, r.y1],
        [r.x1, r.y1],
      ]) {
        // rays above the horizon: treat as far away
        if (!this.pxToTable(px, py, tmpV3)) tmpV3.set(px < W / 2 ? -1e3 : 1e3, 0, -1e3);
        x0 = Math.min(x0, tmpV3.x);
        x1 = Math.max(x1, tmpV3.x);
        z0 = Math.min(z0, tmpV3.z);
        z1 = Math.max(z1, tmpV3.z);
      }
      if (z1 + pad < cz0 || z0 - pad > cz1) return;
      avoid.push({ x0: x0 - pad, x1: x1 + pad, z0: z0 - pad, z1: z1 + pad });
    };
    for (let s = 0; s < 4; s++) {
      // (individual play: seats not in play have no plate and no bubble)
      if (!this.active[s]) continue;
      this.seatRect(s, 0, r);
      addPx();
      this.seatRect(s, 1, r);
      addPx();
    }
    if (land) {
      // the human's fan (a full hand wide, raised tiles included)
      r.x0 = this.handLeftPx - 6;
      r.x1 = W - this.handLeftPx + 6;
      r.y0 = -20;
      r.y1 = handPx;
      addPx();
    }
    // side stacks and the zone their tiles are revealed in at the end of a hand (only seats in play)
    const zHalf = (this.handSize / 2) * TW * so * 1.12 * this.sidePitchK + 0.45;
    const xIn = this.sideX - SIDE_REVEAL_X - (TL * so) / 2 - 0.25;
    if (this.active[1]) avoid.push({ x0: xIn, x1: xIn + 20, z0: this.sideZ - zHalf, z1: this.sideZ + zHalf });
    if (this.active[3]) avoid.push({ x0: -xIn - 20, x1: -xIn, z0: this.sideZ - zHalf, z1: this.sideZ + zHalf });
    // individual: the boneyard keeps the chain off it (left side with 2 players, inner corner with 4)
    this.updatePileAvoid(avoid);
    this.chainAvoid = avoid;
    this.chainVertical = this.portrait;
    this.chainFlip = land;
    // size limits in on-screen px, measured at the middle of the chain area (landscape: its main row)
    const scr = { x: 0, y: 0 };
    const zm = land ? zMid : this.bounds.cz;
    this.toScreen(tmpV2.set(-0.5, 0, zm), scr);
    const xa = scr.x;
    this.toScreen(tmpV2.set(0.5, 0, zm), scr);
    const ppw = Math.max(1e-3, scr.x - xa);
    const handLen = (TL * this.handHs * H) / (2 * this.handHalfH);
    this.chainMaxCell = (CHAIN_MAX_OF_HAND * handLen) / (TL * ppw);
    // (landscape hand tiles are small: the floor is the share of a hand tile alone)
    const floorPx = land ? CHAIN_MIN_OF_HAND * handLen : Math.max(CHAIN_MIN_PX, CHAIN_MIN_OF_HAND * handLen);
    this.chainSoftMin = Math.min(this.chainMaxCell, floorPx / (TL * ppw));
  }

  private layoutSpritePlates(plateBesideHand: boolean, bottomN: number, hsN: number, handHalfLen: number): void {
    const W = this.W;
    const H = this.H;
    const cam = this.camera;
    // plates (overlay px, y up)
    const pw = this.plateW;
    const ph = this.plateH;
    if (plateBesideHand) {
      this.plateX[0] = Math.max(pw / 2 + 10, this.handLeftPx - pw / 2 - 16);
      this.plateY[0] = ((-1 + bottomN + (TL * hsN) / 2 + 1) / 2) * H;
    } else {
      this.plateX[0] = pw / 2 + 10;
      this.plateY[0] = this.handTopPx + ph / 2 + 4;
    }
    const scr = { x: 0, y: 0 };
    this.toScreen(tmpV2.set(this.topOffX + handHalfLen + 0.3, 0.6, this.topZ), scr);
    this.plateX[2] = Math.min(W - pw / 2 - 6, scr.x + pw / 2 + 8);
    this.plateY[2] = scr.y;
    for (const s of [1, 3]) {
      const sx = s === 1 ? this.sideX : -this.sideX;
      this.toScreen(tmpV2.set(sx, 0, this.sideZ + handHalfLen + 0.4), scr);
      this.plateX[s] = THREE.MathUtils.clamp(scr.x + (s === 1 ? -pw * 0.08 : pw * 0.08), pw / 2 + 6, W - pw / 2 - 6);
      this.plateY[s] = scr.y - ph * 0.6;
    }
    // keep the chain clear of the side name plates: narrow the chain bounds to the plates' inner edges
    {
      let limit = this.bounds.w / 2;
      for (const s of [1, 3]) {
        const xi = this.plateX[s] + (s === 1 ? -pw / 2 : pw / 2);
        for (const py of [this.plateY[s] - ph / 2, this.plateY[s] + ph / 2]) {
          this.ndc.set((xi / W) * 2 - 1, (py / H) * 2 - 1);
          this.raycaster.setFromCamera(this.ndc, cam);
          this.plane.constant = 0;
          if (this.raycaster.ray.intersectPlane(this.plane, tmpV3)) limit = Math.min(limit, Math.abs(tmpV3.x) - 0.35);
        }
      }
      if (limit >= 2.5) this.bounds.w = limit * 2;
    }
  }

  private buildTable(): void {
    const box = this.box;
    const FX = box.x + 0.9;
    const FZ0 = box.z0 - 0.5;
    // the felt runs on under the human's hand and off the bottom of the screen: no near edge in view
    let FZ1 = box.z1 + 8;
    if (this.pxToTable(this.W / 2, 0, tmpV) && Number.isFinite(tmpV.z)) FZ1 = Math.min(box.z1 + 40, Math.max(FZ1, tmpV.z + 2));
    const fw = FX * 2;
    const fh = FZ1 - FZ0;
    // room shown round the table: beyond the far edge, and at the sides (little of it on a phone)
    const rail = 0.6;
    const mT = 9;
    const mS = this.portrait ? 4 : 9;
    const mB = 1;
    const geo: tex.ArenaGeo = {
      w: fw + (rail + mS) * 2,
      h: fh + rail * 2 + mT + mB,
      fx: rail + mS,
      fy: rail + mT,
      fw,
      fh,
      rail,
      r: 0.9,
      cy: rail + mT + (this.bounds.cz - FZ0),
    };
    this.felt.scale.set(geo.w, 1, geo.h);
    this.felt.position.set(0, 0, FZ0 - rail - mT + geo.h / 2);
    const px = Math.round(this.q.felt * 1.5);
    const key = `${this.tableStyle}:${px}:${geo.w.toFixed(2)}:${geo.h.toFixed(2)}:${geo.cy.toFixed(2)}`;
    if (key !== this.arenaKey) {
      this.arenaKey = key;
      this.feltCanvas = tex.drawArena(this.feltCanvas, geo, px, this.tableStyle);
      if (this.feltTex) this.feltTex.dispose();
      this.feltTex = new THREE.CanvasTexture(this.feltCanvas);
      this.feltTex.colorSpace = THREE.SRGBColorSpace;
      this.feltTex.anisotropy = this.q.aniso;
      const m = this.felt.material as THREE.MeshBasicMaterial | THREE.MeshLambertMaterial;
      m.map = this.feltTex;
      m.needsUpdate = true;
      const em = this.emblem.material as THREE.MeshBasicMaterial;
      this.emblemTex?.dispose();
      this.emblemTex = tex.makeEmblem(this.q.lite ? 256 : 512, this.tableStyle);
      this.emblemTex.anisotropy = this.q.aniso;
      em.map = this.emblemTex;
      em.needsUpdate = true;
    }
    // medallion: under the chain, at the centre of the light pool
    const R = 0.22 * Math.min(fw, fh);
    this.emblem.scale.set(R / 0.47, 1, R / 0.47);
    this.emblem.position.set(0, 0.006, this.bounds.cz);
    (this.emblem.material as THREE.MeshBasicMaterial).opacity = this.emblemAlpha();
    this.placeTurnLight(this.turnSeat, true);
  }

  /** medallion strength for the current table style (painted faint; the turn adds a slow breath) */
  private emblemAlpha(): number {
    return Math.min(1, tex.tableStyleDef(this.tableStyle).emblemA * 1.6);
  }

  /** where the turn light rests for a seat: in front of that player's tiles, a third of the way to the centre */
  private turnLightSpot(seat: number, out: V3): void {
    const cz = this.bounds.cz;
    if (seat === 0) out.set(0, 0, this.box.z1 + 1.2);
    else if (seat === 2) out.set(this.topOffX, 0, this.topZ);
    else out.set(seat === 1 ? this.sideX : -this.sideX, 0, this.sideZ);
    out.x *= 0.72;
    out.z = cz + (out.z - cz) * 0.8;
  }

  /** move the turn light to a seat (null = fade out); `snap` skips the glide (resize, restore, reduced motion) */
  private placeTurnLight(seat: Seat | null, snap = false): void {
    const l = this.turnLight;
    const gen = ++this.turnLightGen;
    const size = (this.portrait ? 1.15 : 0.95) * (this.box.x + 2);
    l.scale.set(size, 1, size);
    if (seat === null || this.idleActive) {
      if (snap || this.reduced || !l.visible) {
        this.turnLightAmt = 0;
        l.visible = false;
        return;
      }
      const a0 = this.turnLightAmt;
      void this.anim.tween(0.3, (k) => {
        if (gen !== this.turnLightGen) return;
        this.turnLightAmt = a0 * (1 - k);
        if (k >= 1) l.visible = false;
      });
      return;
    }
    this.turnLightSpot(seat, tmpV);
    if (snap || this.reduced || !l.visible) {
      const a0 = snap || this.reduced ? 1 : this.turnLightAmt;
      l.position.set(tmpV.x, 0.008, tmpV.z);
      l.visible = true;
      if (a0 >= 1) this.turnLightAmt = 1;
      else
        void this.anim.tween(0.35, (k) => {
          if (gen === this.turnLightGen) this.turnLightAmt = a0 + (1 - a0) * k;
        });
      return;
    }
    const x0 = l.position.x;
    const z0 = l.position.z;
    const x1 = tmpV.x;
    const z1 = tmpV.z;
    const a0 = this.turnLightAmt;
    void this.anim.tween(
      0.45,
      (k) => {
        if (gen !== this.turnLightGen) return;
        l.position.set(x0 + (x1 - x0) * k, 0.008, z0 + (z1 - z0) * k);
        this.turnLightAmt = a0 + (1 - a0) * k;
      },
      ease.inOutCubic,
    );
  }

  // ───────────────────────── poses ─────────────────────────

  private handCount(seat: number): number {
    return this.hands[seat].length;
  }

  /** world pose of a slot in a seat's hand; returns scale */
  private slotPose(seat: number, idx: number, n: number, out: V3, outQ: Q): number {
    if (seat === 0) {
      // more than a full hand (individual play, after drawing): the fan keeps its hand-width; tiles shrink a
      // little and close up, later ones a hair nearer the camera so overlaps never flicker
      const hk = this.humanHandK(n);
      const hs = this.handHs * hk.s;
      const pitch = 1.06 * TW * this.handHs * hk.p;
      const c = idx - (n - 1) / 2;
      let x = c * pitch;
      let y = -this.handHalfH + (this.portrait ? 0.05 : 0.06) * this.handHalfH + (TL * hs) / 2 - c * c * 0.012 * hs * hk.p * hk.p;
      const r = this.req;
      const id = this.hands[0][idx];
      let lift = 0;
      let z = -this.handDh + (n > this.handSize ? idx * 0.004 * this.handHs : 0);
      if (r && !r.passOnly && id !== undefined) {
        if (r.sides.has(id)) lift = 0.3 * hs;
        if (r.selected === id) {
          lift = 0.42 * hs;
          z += 0.05 * hs;
        }
      }
      y += lift;
      out.set(x, y, z).applyQuaternion(this.baseCamQuat).add(this.baseCamPos);
      tmpQ2.setFromAxisAngle(bx.set(1, 0, 0), -0.22);
      outQ.setFromAxisAngle(bz.set(0, 0, 1), -c * 0.03 * hk.p).multiply(tmpQ2).multiply(this.qBasisHand);
      outQ.premultiply(this.baseCamQuat);
      return hs;
    }
    // more than a full hand (individual play): smaller tiles, closer together, never overlapping
    const so = OPP_SCALE * (n > this.handSize ? Math.max(0.5, this.handSize / n) : 1);
    const pitch = Math.max(TW * so * 1.04, TW * OPP_SCALE * 1.12 * (seat === 2 ? 1 : this.sidePitchK) * Math.min(1, this.handSize / Math.max(1, n)));
    const lean = 0.32;
    let ox = 0;
    let oz = 0;
    let rowX = 0;
    let rowZ = 0;
    let outX = 0;
    let outZ = 0;
    // rows keep the end next to their plate fixed (side stacks: the near end) and shrink away from it
    if (seat === 2) {
      ox = this.topOffX + (idx - (n - 1) / 2) * pitch;
      oz = this.topZ;
      rowX = 1;
      outZ = -1;
    } else if (seat === 1) {
      ox = this.sideX;
      // plate beside the stack's middle: the stack shrinks toward its centre; else toward the near end
      oz = this.sideZ + ((n - 1) / 2 - idx) * pitch;
      rowZ = -1;
      outX = 1;
    } else {
      ox = -this.sideX;
      oz = this.sideZ + (idx - (n - 1) / 2) * pitch;
      rowZ = 1;
      outX = -1;
    }
    void rowX;
    void rowZ;
    const cl = Math.cos(lean);
    const sl = Math.sin(lean);
    // X axis (long) = up tilted outward; Y (face) = outward tilted down; Z = X x Y
    const ax = bx.set(outX * sl, cl, outZ * sl);
    const ay = by.set(outX * cl, -sl, outZ * cl);
    const az = bz.crossVectors(ax, ay);
    tmpM.makeBasis(ax, ay, az);
    outQ.setFromRotationMatrix(tmpM);
    const half = (TL * so) / 2;
    out.set(ox + ax.x * half - ay.x * TH * so * 0.5, ax.y * half + 0.04, oz + ax.z * half - ay.z * TH * so * 0.5);
    return so;
  }

  /** orientation of an un-fanned tile in the human hand (upright on screen, facing the camera) */
  private handQuat(out: Q): Q {
    tmpQ2.setFromAxisAngle(bx.set(1, 0, 0), -0.22);
    out.copy(tmpQ2).multiply(this.qBasisHand).premultiply(this.baseCamQuat);
    return out;
  }

  /** the human fan with n tiles: tile scale and pitch factors (1 up to a full hand; the fan never gets wider) */
  private humanHandK(n: number): { s: number; p: number } {
    const full = this.handSize;
    if (n <= full) return { s: 1, p: 1 };
    return { s: Math.max(0.62, full / n), p: full / n };
  }

  // ───────── individual play: the boneyard pile ─────────

  /** where the boneyard lies: a free top/left side, or an inner corner when all four seats play */
  private pileSide(): PileSide | null {
    if (this.active[0] && this.active[1] && this.active[2] && this.active[3]) return this.pileOrder.length ? 'corner' : null;
    if (!this.active[2]) return 'top';
    if (!this.active[1] && !this.active[3]) return 'left';
    return null;
  }

  /** pile geometry: columns per layer, pitch and centre (table units) */
  private pileGeo(): { side: PileSide; perLayer: number; pitch: number; s: number; cx: number; cz: number } | null {
    const side = this.pileSide();
    if (!side) return null;
    const minimum = this.handSize * (side === 'left' ? 2 : 1);
    const total = Math.max(this.pileOrder.length, minimum);
    const s = side === 'corner' ? OPP_SCALE * 0.82 : OPP_SCALE;
    const pitch = TW * s * 1.08;
    if (side === 'corner') {
      // four-player double-nine: a compact stack just below the top row, inside the felt's top-left corner
      const perLayer = 4;
      const len = perLayer * pitch;
      return {
        side,
        perLayer,
        pitch,
        s,
        cx: -this.box.x + len / 2 + 0.8,
        cz: this.topZ + (TL * s) / 2 + 0.65,
      };
    }
    // double-six keeps its familiar flat pile; the 35-tile double-nine boneyard gets extra layers
    // so it stays on the felt instead of becoming a 13-unit row
    const available = (side === 'left' ? this.box.z1 - this.box.z0 : this.box.x * 2) - 3.0;
    const cap = Math.max(1, Math.floor(available / pitch));
    const perLayer = this.tileSet === 'double6' ? Math.ceil(total / (total > this.handSize ? 2 : 1)) : Math.min(Math.ceil(total / 2), cap);
    if (side === 'top') return { side, perLayer, pitch, s, cx: 0, cz: this.topZ + 0.2 };
    // left: inside the felt, clear of the frame, at the side seats' height
    return { side, perLayer, pitch, s, cx: -(this.box.x - (TL * s) / 2 - 0.45), cz: this.sideZ };
  }

  /** the pile's footprint on the table (for the chain's keep-out) */
  private pileRect(): RectXZ {
    const g = this.pileGeo();
    if (!g) return { x0: 0, x1: 0, z0: 0, z1: 0 };
    const len = g.perLayer * g.pitch;
    const deep = TL * g.s;
    return g.side === 'left'
      ? { x0: g.cx - deep / 2, x1: g.cx + deep / 2, z0: g.cz - len / 2, z1: g.cz + len / 2 }
      : { x0: g.cx - len / 2, x1: g.cx + len / 2, z0: g.cz - deep / 2, z1: g.cz + deep / 2 };
  }

  /** replace the boneyard keep-out when the seats or the pile size change (pileRect depends on both) */
  private updatePileAvoid(avoid: RectXZ[]): void {
    if (this.pileAvoidEntry) {
      const i = avoid.indexOf(this.pileAvoidEntry);
      if (i >= 0) avoid.splice(i, 1);
      this.pileAvoidEntry = null;
    }
    const side = this.pileSide();
    if (side !== 'left' && side !== 'corner') return;
    const pr = this.pileRect();
    const rect: RectXZ =
      side === 'left'
        ? { x0: pr.x0 - 20, x1: pr.x1 + 0.35, z0: pr.z0 - 0.35, z1: pr.z1 + 0.35 }
        : { x0: pr.x0 - 0.35, x1: pr.x1 + 0.35, z0: pr.z0 - 0.35, z1: pr.z1 + 0.35 };
    avoid.push(rect);
    this.pileAvoidEntry = rect;
  }

  /** a pile tile's slot (fixed by its place at the deal: bottom layers first, the top layer is drawn first) */
  private pilePose(id: number, out: V3, outQ: Q): number {
    const g = this.pileGeo();
    const p = Math.max(0, this.pileOrder.indexOf(id));
    if (!g) {
      out.set(0, -5, 0);
      outQ.identity();
      return OPP_SCALE;
    }
    const layer = Math.floor(p / g.perLayer);
    const inLayer = Math.min(g.perLayer, this.pileOrder.length - layer * g.perLayer);
    const col = p % g.perLayer;
    const c = (col - (inLayer - 1) / 2) * g.pitch;
    const y = TH * g.s * (0.5 + layer);
    if (g.side === 'left') {
      out.set(g.cx, y, g.cz + c);
      outQ.copy(Q_FLIP);
    } else {
      out.set(g.cx + c, y, g.cz);
      // long axis along z, face down
      outQ.setFromAxisAngle(UP, Math.PI / 2).multiply(Q_FLIP);
    }
    return g.s;
  }

  /** switch the seats in play (re-lays out the plates and the chain area when it changes) */
  private setActiveSeats(seats: readonly number[] | undefined): void {
    const next = [0, 1, 2, 3].map((s) => !seats || seats.includes(s));
    if (next.every((v, i) => v === this.active[i])) return;
    this.active = next;
    this.computeLayout();
    this.plateCenterSig = -1;
  }

  private revealPose(seat: number, idx: number, n: number, out: V3, outQ: Q): number {
    // many tiles left (individual play): the revealed row closes up so it stays on the felt
    const so = OPP_SCALE * (n > 9 ? 9 / n : 1);
    const pitch = TW * so * 1.1;
    const c = (idx - (n - 1) / 2) * pitch;
    const y = (TH * so) / 2;
    if (seat === 2) {
      out.set(this.topOffX + c, y, this.topZ + 0.9);
      outQ.setFromAxisAngle(UP, Math.PI / 2);
    } else if (seat === 1) {
      out.set(this.sideX - SIDE_REVEAL_X, y, this.sideZ - c);
      outQ.setFromAxisAngle(UP, 0);
    } else {
      out.set(-this.sideX + SIDE_REVEAL_X, y, this.sideZ + c);
      outQ.setFromAxisAngle(UP, Math.PI);
    }
    return so;
  }

  private chainPose(i: number, out: V3, outQ: Q): number {
    const p = this.layoutRes.poses[i];
    const cell = this.layoutRes.cell;
    out.set(p.x, (TH * cell) / 2, p.z);
    outQ.setFromAxisAngle(UP, p.rotY);
    return cell;
  }

  private canonical(t: TileObj, out: V3, outQ: Q): number {
    if (t.loc === 'hand') {
      const idx = this.hands[t.seat].indexOf(t.id);
      if (idx >= 0) return this.slotPose(t.seat, idx, this.handCount(t.seat), out, outQ);
    } else if (t.loc === 'chain') {
      const idx = this.chain.findIndex((p) => p.tile.id === t.id);
      if (idx >= 0) return this.chainPose(idx, out, outQ);
    } else if (t.loc === 'reveal') {
      const idx = this.hands[t.seat].indexOf(t.id);
      if (idx >= 0) return this.revealPose(t.seat, idx, this.handCount(t.seat), out, outQ);
    } else if (t.loc === 'pile') {
      return this.pilePose(t.id, out, outQ);
    }
    // idle tiles: wherever the menu scenes put them
    out.copy(t.pos);
    outQ.copy(t.quat);
    return t.s;
  }

  // ───────────────────────── tile animation helpers ─────────────────────────

  private fly(t: TileObj, toPos: V3, toQuat: Q, toScale: number, o: FlyOpts = {}): Promise<void> {
    const from = new THREE.Vector3();
    const fq = new THREE.Quaternion();
    let fs = 1;
    let my = 0;
    const tp = toPos.clone();
    const tq = toQuat.clone();
    const arc = o.arc ?? 0;
    const pe = o.posEase ?? ease.outCubic;
    const re = o.rotEase ?? ease.inOutCubic;
    return this.anim.tween(
      o.dur ?? 0.4,
      (_k, raw) => {
        if (t.token !== my) return;
        const p = pe(raw);
        t.pos.lerpVectors(from, tp, p);
        t.pos.y += arc * Math.sin(Math.PI * raw);
        t.quat.slerpQuaternions(fq, tq, re(raw));
        t.s = lerp(fs, toScale, p);
      },
      ease.linear,
      o.delay ?? 0,
      () => {
        my = ++t.token;
        from.copy(t.pos);
        fq.copy(t.quat);
        fs = t.s;
      },
    );
  }

  private flyHome(t: TileObj, o: FlyOpts = {}): Promise<void> {
    const s = this.canonical(t, tmpV, tmpQ);
    return this.fly(t, tmpV, tmpQ, s, o);
  }

  private relayoutSeat(seat: number, dur: number): Promise<void> {
    const ps: Promise<void>[] = [];
    for (const id of this.hands[seat]) {
      const t = this.tiles[id];
      if (t.loc === 'hand' || t.loc === 'reveal') ps.push(this.flyHome(t, { dur }));
    }
    return Promise.all(ps).then(() => undefined);
  }

  private snapAll(): void {
    for (const t of this.tiles) {
      if (t.loc === 'pool') continue;
      t.token++;
      t.s = this.canonical(t, t.pos, t.quat);
    }
  }

  private settleAll(dur: number): Promise<void> {
    const ps: Promise<void>[] = [];
    for (const t of this.tiles) {
      if (t.loc === 'pool' || t.loc === 'idle') continue;
      if (this.req && this.ptr.dragging && t.id === this.ptr.tile) continue;
      ps.push(this.flyHome(t, { dur }));
    }
    return Promise.all(ps).then(() => undefined);
  }

  private shakeTile(t: TileObj): Promise<void> {
    tmpV.set(1, 0, 0).applyQuaternion(this.baseCamQuat);
    const dir = tmpV.clone();
    const amp = 0.14 * (t.loc === 'hand' && t.seat === 0 ? this.handHs * 2 : t.s);
    return this.anim.tween(0.38, (k) => {
      t.off.copy(dir).multiplyScalar(Math.sin(k * Math.PI * 7) * amp * (1 - k));
    });
  }

  private hop(t: TileObj, h: number, dur: number, delay = 0): Promise<void> {
    return this.anim.tween(
      dur,
      (k) => {
        t.off.y = Math.sin(Math.PI * k) * h;
      },
      ease.linear,
      delay,
    );
  }

  private sfx(n: SfxName): void {
    try {
      this.opts.onSfx?.(n);
    } catch {
      /* ignore */
    }
  }

  private sfxAt(n: SfxName, delay: number): void {
    if (delay <= 0) this.sfx(n);
    else void this.anim.wait(delay).then(() => this.sfx(n));
  }

  private addShake(a: number, p = 0, cap = 0.35, punchCap = 1.5): void {
    if (this.reduced || !this.q.shake) return;
    this.shake = Math.min(cap, this.shake + a);
    this.punch = Math.min(punchCap, this.punch + p);
  }

  private landFx(t: TileObj, slam: boolean, power = 1): void {
    this.sfx(slam ? 'slam' : 'clack');
    const amp = slam ? 0.5 : 0.32;
    void this.anim.tween(slam ? 0.42 : 0.28, (k) => {
      t.sq = 1 - amp * Math.exp(-5 * k) * Math.cos(k * 16) * (1 - k);
    });
    t.glow = 1;
    void this.anim.tween(slam ? 0.9 : 0.5, (k) => {
      t.glow = 1 - k;
    });
    if (slam) {
      // the quake: harder and a little longer than any other shake, with a quick zoom punch
      this.addShake(1.25 * power, 4 * power, 1.4, 4);
      if (!this.reduced && this.q.shake) this.shakeDecay = power >= 1 ? 4.5 : 6;
    } else {
      this.addShake(0.035, 0.25);
      this.rippleAt(t);
    }
    if (slam) {
      if (!this.reduced && this.q.shake) {
        this.flashAmt = 0.12 * power;
        tmpC.set(0xffc060);
        (this.flash.material as THREE.SpriteMaterial).color.copy(tmpC);
      }
      this.shockwave(t, power);
    }
    // particles: a light puff ring hugging the felt (outward + slightly upward only) and a few sparks
    const n = Math.round((slam ? 22 : 10) * (this.reduced ? 0.4 : 1) * this.q.fx);
    const cell = t.s;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.4;
      const sp = (slam ? 3.4 : 1.8) * (0.7 + Math.random() * 0.5) * cell;
      const size = (0.22 + Math.random() * 0.18) * cell * (slam ? 1.3 : 1);
      this.dust.spawn(
        t.pos.x + Math.cos(a) * cell * 0.85,
        0.03 + size * 0.5,
        t.pos.z + Math.sin(a) * cell * 0.5,
        Math.cos(a) * sp,
        0.15 + Math.random() * 0.35,
        Math.sin(a) * sp,
        0.96,
        0.9,
        0.78,
        size,
        0.28 + Math.random() * 0.2,
      );
    }
    const ns = Math.round((slam ? 18 : 4) * (this.reduced ? 0.4 : 1) * this.q.fx);
    for (let i = 0; i < ns; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (slam ? 5 : 3) * (0.4 + Math.random()) * cell;
      this.dust.spawn(
        t.pos.x,
        0.25 * cell,
        t.pos.z,
        Math.cos(a) * sp,
        (slam ? 5 : 3) * (0.5 + Math.random()) * cell,
        Math.sin(a) * sp,
        1,
        0.8 + Math.random() * 0.15,
        0.35,
        (0.1 + Math.random() * 0.08) * cell,
        0.35 + Math.random() * 0.3,
      );
    }
  }

  /** a small ring spreading on the felt from a tile that just landed (not with reduced motion) */
  private rippleAt(t: TileObj): void {
    if (this.reduced) return;
    const rp = this.ripple;
    const mat = rp.material as THREE.MeshBasicMaterial;
    const cell = Math.max(0.5, t.s);
    rp.position.set(t.pos.x, 0.02, t.pos.z);
    rp.visible = true;
    void this.anim.tween(
      0.5,
      (k) => {
        const r = cell * (1.6 + 4.4 * k);
        rp.scale.set(r, 1, r);
        mat.opacity = 0.42 * (1 - k) * (1 - k);
        if (k >= 1) rp.visible = false;
      },
      ease.outCubic,
    );
  }

  // ───────────────────────── overlay helpers ─────────────────────────

  private toScreen(v: V3, out: { x: number; y: number }): void {
    tmpV.copy(v).project(this.camera);
    out.x = ((tmpV.x + 1) / 2) * this.W;
    out.y = ((tmpV.y + 1) / 2) * this.H;
  }

  private redrawPlate(s: number): void {
    const p = this.plates[s];
    this.plateInfo[s].count = this.hands[s].length;
    if (this.htmlPlates) return void this.kick(); // drawn by the UI (see emitPlates)
    tex.drawPlate(p.canvas, this.plateInfo[s]);
    p.tex.needsUpdate = true;
  }

  private redrawPlates(): void {
    for (let s = 0; s < 4; s++) this.redrawPlate(s);
  }

  private popup(text: string, palette: 'gold' | 'red' | 'teal', x: number, y: number, width: number, hold: number): Promise<void> {
    const p = this.popups[this.popupIdx];
    this.popupIdx = (this.popupIdx + 1) % this.popups.length;
    tex.drawPopup(p.canvas, text, palette);
    p.tex.needsUpdate = true;
    const sp = p.sprite;
    const mat = sp.material as THREE.SpriteMaterial;
    const h = (width * 200) / 640;
    sp.visible = true;
    mat.opacity = 1;
    mat.rotation = (Math.random() - 0.5) * 0.12;
    sp.position.set(x, y, 0);
    const pop = this.anim.tween(0.32, (k) => {
      const s = Math.max(0.001, ease.outBackBig(k));
      sp.scale.set(width * s, h * s, 1);
    });
    void pop
      .then(() => this.anim.wait(hold))
      .then(() =>
        this.anim.tween(0.3, (k) => {
          sp.position.y = y + k * 30;
          mat.opacity = 1 - k;
          if (k >= 1) sp.visible = false;
        }),
      );
    return pop;
  }

  private confettiBurst(big: boolean, team: 0 | 1 | null): void {
    const W = this.W;
    const H = this.H;
    const n = Math.round((big ? 1 : 0.6) * this.confetti.limit * (this.reduced ? 0.4 : 1));
    const palette = team === 1 ? [CONFETTI_COLORS[1], CONFETTI_COLORS[0], CONFETTI_COLORS[3]] : CONFETTI_COLORS;
    const scale = Math.min(W, H) / 700;
    for (let i = 0; i < n; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      const c = palette[i % palette.length];
      const x = side < 0 ? -10 : W + 10;
      const vx = -side * (200 + Math.random() * 700) * (W / 900);
      const vy = (900 + Math.random() * 900) * (H / 800);
      this.confetti.spawn(x, H * 0.12, 0, vx, vy, 0, c[0], c[1], c[2], (10 + Math.random() * 10) * Math.max(0.7, scale * 1.4), 2.2 + Math.random() * 1.4, (Math.random() - 0.5) * 22);
    }
    if (big) {
      for (let i = 0; i < n * 0.5; i++) {
        const c = palette[i % palette.length];
        this.confetti.spawn(Math.random() * W, H + 20 + Math.random() * 200, 0, (Math.random() - 0.5) * 100, -50 - Math.random() * 200, 0, c[0], c[1], c[2], (10 + Math.random() * 8) * Math.max(0.7, scale * 1.4), 3 + Math.random() * 1.5, (Math.random() - 0.5) * 18);
      }
    }
  }

  // ───────────────────────── public API ─────────────────────────

  /**
   * Online: make real tile `id` sit in `seat`'s hand (seat -1 = on top of the pile) by trading places
   * with a hidden tile there. Both are face down, so the trade is invisible. No-op in local games.
   */
  private claim(id: number, seat: number, keep?: readonly number[]): void {
    if (id < 0 || id >= TILE_COUNT || !this.tileSetDef.ids.includes(id)) return;
    const dest = seat < 0 ? this.pile : this.hands[seat];
    if (!dest) return;
    const y = pickSwap(id, dest, this.unknown, seat < 0, keep);
    if (y < 0) return;
    swapIds(id, y, [this.hands[0], this.hands[1], this.hands[2], this.hands[3], this.pile, this.pileOrder]);
    const a = this.tiles[id];
    const b = this.tiles[y];
    const loc = a.loc;
    const st = a.seat;
    a.loc = b.loc;
    a.seat = b.seat;
    b.loc = loc;
    b.seat = st;
    a.token++;
    b.token++;
    tmpV.copy(a.pos);
    tmpQ.copy(a.quat);
    const sc = a.s;
    a.pos.copy(b.pos);
    a.quat.copy(b.quat);
    a.s = b.s;
    b.pos.copy(tmpV);
    b.quat.copy(tmpQ);
    b.s = sc;
    // the identity flags stay with the places: the hidden one stays hidden
    const u = this.unknown[id];
    this.unknown[id] = this.unknown[y];
    this.unknown[y] = u;
  }

  /** online fallback: some hidden tile (no pile left to draw from) */
  private anyUnknown(): number {
    for (const id of this.tileSetDef.ids) if (this.unknown[id] && this.tiles[id].loc !== 'chain') return id;
    return -1;
  }

  /** online: the player's turn ended elsewhere (timeout, resync): drop the pending tile pick */
  cancelHumanMove(): void {
    this.reqGen++;
    if (!this.req) return;
    this.cancelReq();
    for (const id of this.hands[0]) void this.flyHome(this.tiles[id], { dur: 0.18 });
    this.kick();
  }

  handle(event: GameEvent): Promise<void> {
    const run = async () => {
      if (this.disposed) return;
      this.busy++;
      try {
        await this.doHandle(event);
      } catch (e) {
        console.error('[render] event failed', event.type, e);
      } finally {
        this.busy--;
      }
      if (this.needsSettle && !this.disposed) {
        this.needsSettle = false;
        await this.settleAll(0.25);
      }
    };
    this.queue = this.queue.then(run, run);
    this.kick();
    return this.queue;
  }

  private async doHandle(ev: GameEvent): Promise<void> {
    switch (ev.type) {
      case 'handStart':
        return this.onHandStart(ev);
      case 'play':
        return this.onPlay(ev);
      case 'pass':
        return this.onPass(ev.seat);
      case 'draw':
        return this.onDraw(ev);
      case 'handEnd':
        return this.onHandEnd(ev);
      case 'matchEnd':
        return this.onMatchEnd(ev);
    }
  }

  /**
   * Individual play: a tile slides from the top of the boneyard pile into the drawer's hand (face up for
   * the human, face down for the others); the rest of that hand makes room.
   */
  private async onDraw(ev: Extract<GameEvent, { type: 'draw' }>): Promise<void> {
    const g = this.gen;
    this.idleActive = false;
    // online: another player's draw carries no tile (take the top of the pile); my own draw is real
    let id = ev.tile?.id ?? -1;
    if (id < 0) id = this.pile.length ? this.pile[this.pile.length - 1] : this.anyUnknown();
    else this.claim(id, -1);
    if (id < 0) return;
    if (ev.seat === 0) this.unknown[id] = false;
    const t = this.tiles[id];
    const k = this.pile.indexOf(id);
    if (k >= 0) this.pile.splice(k, 1);
    if (t.loc !== 'pile') this.pilePose(id, t.pos, t.quat); // (a replay without the pile: start from it anyway)
    for (let s = 0; s < 4; s++) {
      const i = this.hands[s].indexOf(id);
      if (i >= 0) this.hands[s].splice(i, 1);
    }
    this.hands[ev.seat].push(id);
    if (ev.seat === 0) this.sortHuman();
    t.loc = 'hand';
    t.seat = ev.seat;
    t.glow = 0;
    t.dim = 0;
    this.sfx('deal');
    void this.relayoutSeat(ev.seat, 0.28);
    this.redrawPlate(ev.seat);
    // a little lift off the pile first, then the slide to the hand
    tmpV.copy(t.pos);
    tmpV.y += 0.9;
    await this.fly(t, tmpV, t.quat, t.s, { dur: 0.12, posEase: ease.outCubic });
    if (g !== this.gen) return;
    await this.flyHome(t, { dur: 0.42, arc: ev.seat === 0 ? 0.8 : 1.2, rotEase: ease.outCubic });
    if (g !== this.gen) return;
    await this.anim.wait(0.06);
  }

  private async onHandStart(ev: Extract<GameEvent, { type: 'handStart' }>): Promise<void> {
    const g = ++this.gen;
    this.idleActive = false;
    // individual play: the seats in play and the boneyard (both default to the four-seat game)
    this.setActiveSeats(ev.seats);
    this.pileOrder = (ev.boneyard ?? []).map((t) => t.id);
    this.chain = [];
    this.ends = null;
    this.updatePileAvoid(this.chainAvoid);
    this.layoutRes = this.fitChain([]);
    const dealt = ev.hands.map((h) => h.map((t) => t.id));
    // online: other players' tiles and the boneyard arrive hidden (placeholders); they borrow free ids
    resolvePlaceholders([...dealt, this.pileOrder], [], this.unknown, this.tileSetDef.ids);
    this.pile = this.pileOrder.slice();
    this.hands = dealt.map((h) => h.slice());
    this.sortHuman();
    for (let s = 0; s < 4; s++) {
      this.plateInfo[s].pips = null;
      this.plateInfo[s].winner = false;
      this.plateInfo[s].count = 0;
    }
    const counts = [0, 0, 0, 0];
    for (const t of this.tiles) {
      t.loc = 'pool';
      t.glow = 0;
      t.dim = 0;
      t.off.set(0, 0, 0);
      t.sq = 1;
    }
    const b = this.bounds;
    // Non-overlapping shuffle slots: concentric rings, tiles lying tangentially. Each ring then
    // rotates rigidly (alternate rings counter-rotate) and the radii only ever grow, so the spacing
    // between any two tiles never shrinks and nothing interpenetrates.
    const active = this.tileSetDef.ids;
    const slots = this.shuffleSlots(Math.min(this.sideX + 0.4, b.h / 2 + 1.6), active.length);
    const sc = slots.scale;
    const perm = Array.from({ length: active.length }, (_, i) => i);
    for (let i = perm.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [perm[i], perm[j]] = [perm[j], perm[i]];
    }
    const yawJ = perm.map(() => (Math.random() - 0.5) * 0.24);
    const flipEnd = perm.map(() => (Math.random() < 0.5 ? 0 : Math.PI));
    const poseAt = (i: number, rot: number, grow: number, out: V3, outQ: Q) => {
      const sl = slots.list[perm[i]];
      const a = sl.a + rot * sl.dir;
      const r = sl.r * grow;
      out.set(Math.cos(a) * r, TH * 0.5 * sc, b.cz + Math.sin(a) * r);
      // tangent orientation (local +X along the ring), plus a small fixed jitter
      outQ.setFromAxisAngle(UP, -a + Math.PI / 2 + yawJ[i] + flipEnd[i]).multiply(Q_FLIP);
    };
    this.sfx('shuffle');
    const gather: Promise<void>[] = [];
    for (let i = 0; i < active.length; i++) {
      const t = this.tiles[active[i]];
      poseAt(i, 0, 1, tmpV, tmpQ);
      const ring = slots.list[perm[i]].ring;
      // staggered, height-separated arcs so tiles never cross at the same height
      gather.push(this.fly(t, tmpV, tmpQ, sc, { dur: 0.5, arc: 1.0 + ring * 0.5 + (i % 4) * 0.2, delay: i * 0.012 }));
    }
    await Promise.all(gather);
    if (g !== this.gen) return;
    if (!this.reduced) {
      for (const t of this.tiles) t.token++;
      const tokens = active.map((id) => this.tiles[id].token);
      this.sfxAt('shuffle', 0.4);
      await this.anim.tween(
        1.15,
        (k) => {
          const rot = k * Math.PI * 1.3;
          const grow = 1 + 0.12 * Math.sin(Math.PI * k);
          for (let i = 0; i < active.length; i++) {
            const t = this.tiles[active[i]];
            if (t.token !== tokens[i]) continue;
            poseAt(i, rot, grow, t.pos, t.quat);
          }
        },
        ease.inOutQuad,
      );
      if (g !== this.gen) return;
    }
    // deal a full hand to each seat, round robin from the starter
    const ps: Promise<void>[] = [];
    let n = 0;
    for (let r = 0; r < this.handSize; r++) {
      for (let j = 0; j < 4; j++) {
        const s = (ev.starter + j) % 4;
        const id = dealt[s][r];
        if (id === undefined) continue;
        const t = this.tiles[id];
        t.loc = 'hand';
        t.seat = s;
        const slot = this.hands[s].indexOf(id);
        const sc = this.slotPose(s, slot, this.hands[s].length, tmpV, tmpQ);
        const delay = n * 0.045;
        ps.push(
          this.fly(t, tmpV, tmpQ, sc, { dur: 0.42, arc: s === 0 ? 0.6 : 1.6, delay, rotEase: ease.outCubic }).then(() => {
            counts[s]++;
            this.plateInfo[s].count = counts[s];
            tex.drawPlate(this.plates[s].canvas, this.plateInfo[s]);
            this.plates[s].tex.needsUpdate = true;
          }),
        );
        if (n % 3 === 0) this.sfxAt('deal', delay);
        n++;
      }
    }
    // individual: the undealt tiles gather face down into the boneyard (free side, or a corner with 4 players)
    this.pileOrder.forEach((id, i) => {
      const t = this.tiles[id];
      t.loc = 'pile';
      t.seat = -1;
      const sc = this.pilePose(id, tmpV, tmpQ);
      ps.push(this.fly(t, tmpV, tmpQ, sc, { dur: 0.4, arc: 0.9, delay: n * 0.045 + 0.1 + i * 0.03, rotEase: ease.outCubic }));
    });
    // pairs with a double-nine set: the 15 tiles nobody holds slide off the felt and shrink away
    const inPlay = new Set<number>([...dealt.flat(), ...this.pileOrder]);
    const leftovers = active.filter((id) => !inPlay.has(id));
    leftovers.forEach((id, i) => {
      const t = this.tiles[id];
      const dx = t.pos.x;
      const dz = t.pos.z - this.bounds.cz;
      const len = Math.hypot(dx, dz) || 1;
      tmpV.set(t.pos.x + (dx / len) * 3.2, -1.6, t.pos.z + (dz / len) * 3.2);
      ps.push(this.fly(t, tmpV, t.quat, 0, { dur: 0.34, delay: n * 0.045 + 0.12 + i * 0.02, posEase: ease.inQuad }));
    });
    await Promise.all(ps);
    if (g !== this.gen) return;
    for (const id of leftovers) {
      const t = this.tiles[id];
      t.loc = 'pool';
      t.seat = -1;
      t.s = 0;
      t.pos.set(0, -5, 0);
    }
    this.redrawPlates();
    // the fan "breathes" open
    const hand = this.hands[0].map((id) => this.tiles[id]);
    await Promise.all(hand.map((t, i) => this.hop(t, this.handHs * 0.25, 0.22, i * 0.03)));
  }

  /** ring slots for `count` tangential tiles that cannot overlap (shrinks tiles until within maxR) */
  private shuffleSlots(maxR: number, count: number): { list: { r: number; a: number; ring: number; dir: number }[]; scale: number } {
    let scale = 0.85;
    for (;;) {
      const L = (TL / 2) * scale; // half length
      const w = (TW / 2) * scale + L * Math.sin(0.12) + 0.04; // half width incl. yaw jitter
      const gap = 0.1;
      const list: { r: number; a: number; ring: number; dir: number }[] = [];
      let R = 1.25 * scale + 0.25;
      let ring = 0;
      let outer = 0;
      while (list.length < count) {
        const half = Math.asin(Math.min(1, (L + gap) / R)); // half angle each tile needs
        const cap = Math.max(1, Math.floor(Math.PI / half));
        const n = Math.min(cap, count - list.length);
        const a0 = Math.random() * Math.PI * 2;
        for (let k = 0; k < n; k++) list.push({ r: R, a: a0 + (k / n) * Math.PI * 2, ring, dir: ring % 2 ? -1 : 1 });
        outer = Math.sqrt((R + w) ** 2 + L * L);
        R = outer + w + gap;
        ring++;
      }
      // breathing grows radii up to 12%
      if (outer * 1.12 <= maxR || scale < 0.45) return { list, scale };
      scale *= 0.92;
    }
  }

  private sortHuman(): void {
    this.hands[0].sort((x, y) => {
      const a = TILE_BY_ID[x];
      const b = TILE_BY_ID[y];
      return a.a + a.b - (b.a + b.b) || a.a - b.a;
    });
  }

  private async onPlay(ev: Extract<GameEvent, { type: 'play' }>): Promise<void> {
    const g = this.gen;
    this.idleActive = false;
    const id = ev.tile.id;
    // online: the revealed tile takes the place of one of that seat's hidden tiles
    this.claim(id, ev.seat);
    this.unknown[id] = false;
    const t = this.tiles[id];
    for (let s = 0; s < 4; s++) {
      const k = this.hands[s].indexOf(id);
      if (k >= 0) this.hands[s].splice(k, 1);
    }
    if (t.loc === 'pool' || t.loc === 'idle') {
      // tile never dealt visibly (e.g. event replay without handStart): start from the seat
      this.slotPose(ev.seat, 0, 1, t.pos, t.quat);
    }
    t.loc = 'chain';
    t.seat = ev.seat;
    t.glow = 0;
    t.dim = 0;
    const prev = this.layoutRes;
    this.chain.push(ev.placed);
    this.ends = ev.ends;
    this.layoutRes = this.fitChain(this.chain);
    // a winning (domino) play gets the signature finish; a blocking play is placed normally
    const slam = ev.finishing ?? ev.tilesLeft === 0;

    // reflow existing tiles if the layout changed (auto-fit)
    for (let i = 0; i < this.chain.length - 1; i++) {
      const a = prev.poses[i];
      const b = this.layoutRes.poses[i];
      if (!a || Math.abs(a.x - b.x) > 1e-4 || Math.abs(a.z - b.z) > 1e-4 || prev.cell !== this.layoutRes.cell) {
        void this.flyHome(this.tiles[this.chain[i].tile.id], { dur: 0.45, posEase: ease.inOutCubic });
      }
    }
    void this.relayoutSeat(ev.seat, 0.3);
    this.redrawPlate(ev.seat);

    const cell = this.chainPose(this.chain.length - 1, tmpV, tmpQ);
    const target = tmpV.clone();
    const tq = tmpQ.clone();
    // a player's slam (signal to the partner): hard landing + table thump, no air show
    const hard = !slam && !!ev.slam;
    if (slam && !this.reduced) {
      await this.finishingFlight(t, target, tq, cell, g);
      if (g !== this.gen) return;
    } else if (hard) {
      const up = target.clone();
      up.y += 2.6 * cell + 1.2;
      // pull back toward the slamming seat
      const back = ev.seat === 0 ? [0, 1] : ev.seat === 1 ? [1, 0] : ev.seat === 2 ? [0, -1] : [-1, 0];
      up.x += back[0] * 1.1 * cell;
      up.z += back[1] * 1.1 * cell;
      await this.fly(t, up, tq, cell * 1.25, { dur: 0.24, arc: 0.3, posEase: ease.outCubic, rotEase: ease.outCubic });
      if (g !== this.gen) return;
      await this.anim.wait(0.06);
      if (g !== this.gen) return;
      await this.fly(t, target, tq, cell, { dur: 0.07, posEase: ease.inQuad, rotEase: ease.linear });
    } else {
      await this.fly(t, target, tq, cell, { dur: 0.4, arc: ev.seat === 0 ? 1.4 : 2.2 });
    }
    if (g !== this.gen) return;
    this.landFx(t, slam || hard, slam ? 1 : 0.7);
    this.opts.onImpact?.(ev.seat, slam ? 'finish' : hard ? 'slam' : 'clack');
    await this.anim.wait(slam ? 0.38 : hard ? 0.3 : 0.12);
  }

  /**
   * Signature domino finish (~1 s): anticipation crouch, a high arc with a brief hang at the apex
   * while the tile tumbles end-over-end 3 times and spins (yaw) twice, then a hard fast slam.
   * Scratch objects are allocated once per animation, never per frame.
   */
  private async finishingFlight(t: TileObj, target: V3, tq: Q, cell: number, g: number): Promise<void> {
    // anticipation: a quick squash where the tile is
    await this.anim.tween(0.1, (k) => {
      t.sq = 1 - 0.2 * Math.sin(k * Math.PI);
    });
    t.sq = 1;
    if (g !== this.gen) return;
    const from = t.pos.clone();
    const fromQ = t.quat.clone();
    const fromS = t.s;
    const apexY = target.y + 5 * cell + 1.8;
    const hoverY = apexY - 0.6 * cell;
    const axisFlip = new THREE.Vector3(0, 0, 1); // short horizontal axis: end-over-end
    const qFlip = new THREE.Quaternion();
    const qYaw = new THREE.Quaternion();
    const qTmp = new THREE.Quaternion();
    const FLIPS = Math.PI * 2 * 3;
    const YAWS = Math.PI * 2 * 2;
    t.token++;
    const my = t.token;
    await this.anim.tween(
      0.95,
      (k) => {
        if (t.token !== my) return;
        // horizontal travel: most of it on the way up
        const h = ease.outCubic(Math.min(1, k / 0.5));
        t.pos.x = lerp(from.x, target.x, h);
        t.pos.z = lerp(from.z, target.z, h);
        // vertical: rise to the apex (0..0.42), hang (0.42..0.62), settle a touch lower (..1)
        if (k < 0.42) t.pos.y = lerp(from.y, apexY, ease.outCubic(k / 0.42));
        else if (k < 0.62) t.pos.y = apexY + Math.sin(((k - 0.42) / 0.2) * Math.PI) * 0.12 * cell;
        else t.pos.y = lerp(apexY, hoverY, ease.inOutQuad((k - 0.62) / 0.38));
        t.s = lerp(fromS, cell * 1.6, ease.outCubic(Math.min(1, k / 0.4)));
        // rotation: tumble + yaw unwind to exactly the slot orientation at k = 1
        const r = 1 - ease.inOutQuad(k);
        qFlip.setFromAxisAngle(axisFlip, FLIPS * r);
        qYaw.setFromAxisAngle(UP, YAWS * r);
        qTmp.copy(tq).premultiply(qYaw).multiply(qFlip);
        // blend out of the starting (hand) orientation during the first moments
        if (k < 0.15) t.quat.slerpQuaternions(fromQ, qTmp, ease.outCubic(k / 0.15));
        else t.quat.copy(qTmp);
      },
      ease.linear,
    );
    if (g !== this.gen) return;
    t.quat.copy(tq);
    t.pos.set(target.x, hoverY, target.z);
    // hard, fast slam
    await this.fly(t, target, tq, cell, { dur: 0.09, posEase: ease.inQuad, rotEase: ease.linear });
  }

  /** shockwave from an impact: every other tile on the table hops and settles, delayed by distance */
  private shockwave(src: TileObj, power = 1): void {
    const amp = (this.reduced ? 0.3 : 1) * power;
    const scr = { x: 0, y: 0 };
    const scr2 = { x: 0, y: 0 };
    this.toScreen(src.pos, scr2);
    const unitPx = Math.max(1, this.H / 16);
    for (const o of this.tiles) {
      if (o === src || (o.loc !== 'chain' && o.loc !== 'hand' && o.loc !== 'reveal')) continue;
      const human = o.loc === 'hand' && o.seat === 0;
      let d: number;
      if (human) {
        // the human hand lives in camera space: use screen distance converted to rough table units
        this.toScreen(o.pos, scr);
        d = Math.hypot(scr.x - scr2.x, scr.y - scr2.y) / unitPx;
      } else d = Math.hypot(o.pos.x - src.pos.x, o.pos.z - src.pos.z);
      // the tiles clearly leave the table: ~4.5 thicknesses near the impact, ~2+ at the far hands
      const fall = 1 / (1 + d * 0.085);
      const h = TH * (human ? this.handHs * 3.2 : o.s * 4.5) * amp * fall;
      const tilt = (this.reduced ? 0.06 : this.q.lite ? 0.16 : 0.38) * (0.45 + 0.55 * fall) * Math.min(1, amp + 0.2);
      // tilt away from the impact
      const dx = o.pos.x - src.pos.x;
      const dz = o.pos.z - src.pos.z;
      const dl = Math.hypot(dx, dz) || 1;
      void this.bounce(o, h, 0.5, d * 0.012, (dz / dl) * tilt, (-dx / dl) * tilt);
    }
    // expanding ground ring at the impact point
    const ring = this.ring;
    const mat = ring.material as THREE.MeshBasicMaterial;
    ring.position.set(src.pos.x, 0.025, src.pos.z);
    ring.scale.set(0.6, 1, 0.6);
    ring.visible = true;
    const maxR = 22 * Math.max(0.6, src.s) * (0.5 + 0.5 * power);
    void this.anim.tween(
      0.85,
      (k) => {
        const r = 0.6 + maxR * k;
        ring.scale.set(r, 1, r);
        mat.opacity = 0.9 * (0.4 + 0.6 * power) * (1 - k) * (1 - k);
        if (k >= 1) ring.visible = false;
      },
      ease.outCubic,
    );
  }

  /**
   * Quake hop: big jump with a tilt, a smaller second bounce, then a tiny wobble/squash on landing.
   * Ends exactly at zero offset / zero tilt, so tiles settle precisely in their layout slots.
   */
  private bounce(t: TileObj, h: number, dur: number, delay: number, tx = 0, tz = 0): Promise<void> {
    return this.anim.tween(
      dur,
      (k) => {
        if (k >= 1) {
          t.off.y = 0;
          t.sq = 1;
          t.wx = 0;
          t.wz = 0;
          return;
        }
        let w: number;
        if (k < 0.5) {
          const u = k / 0.5;
          t.off.y = Math.sin(u * Math.PI) * h;
          t.sq = 1;
          w = Math.sin(u * Math.PI);
        } else if (k < 0.8) {
          const u = (k - 0.5) / 0.3;
          const r = Math.sin(u * Math.PI);
          t.off.y = r * h * 0.25;
          t.sq = u < 0.15 ? 1 - 0.12 * (1 - u / 0.15) : 1;
          w = -0.6 * r;
        } else {
          const u = (k - 0.8) / 0.2;
          t.off.y = 0;
          t.sq = 1 - 0.06 * Math.sin(u * Math.PI);
          w = 0.25 * Math.sin(u * Math.PI * 2) * (1 - u);
        }
        t.wx = tx * w;
        t.wz = tz * w;
      },
      ease.linear,
      delay,
    );
  }

  private async onPass(seat: Seat): Promise<void> {
    this.sfx('pass');
    void this.anim.tween(0.55, (k) => {
      this.plateScale[seat] = 1 + 0.2 * Math.abs(Math.sin(k * Math.PI * 2)) * (1 - k);
      this.plateRot[seat] = Math.sin(k * Math.PI * 4) * 0.09 * (1 - k);
    });
    for (const id of this.hands[seat]) void this.hop(this.tiles[id], 0.12, 0.16);
    void this.anim.wait(0.25).then(() => {
      for (const id of this.hands[seat]) void this.hop(this.tiles[id], 0.08, 0.14);
    });
    // no on-table word: the UI's plate speech bubble ("Paso") is the only pass indicator
    await this.anim.wait(0.72);
  }

  private async onHandEnd(ev: Extract<GameEvent, { type: 'handEnd' }>): Promise<void> {
    const g = this.gen;
    this.setTurn(null);
    // reveal remaining hands
    const ps: Promise<void>[] = [];
    for (let s = 1; s < 4; s++) {
      const ids = (ev.remaining[s] ?? []).map((t) => t.id).filter((id) => id >= 0);
      // online: the revealed tiles take the places of that seat's hidden tiles
      for (const id of ids) this.claim(id, s, ids);
      for (const id of ids) this.unknown[id] = false;
      // (a tile still unknown stays face down in the hand)
      for (const id of this.hands[s]) if (!ids.includes(id) && !this.unknown[id]) ids.push(id);
      this.hands[s] = [...ids, ...this.hands[s].filter((id) => this.unknown[id] && !ids.includes(id))];
      ids.forEach((id, i) => {
        const t = this.tiles[id];
        t.loc = 'reveal';
        t.seat = s;
        ps.push(this.flyHome(t, { dur: 0.5, arc: 1.2, delay: i * 0.05 + s * 0.12, rotEase: ease.outCubic }));
      });
    }
    for (const id of this.hands[0]) {
      this.tiles[id].dim = 0;
      this.tiles[id].glow = 0;
    }
    this.sfxAt('deal', 0.15);
    for (let s = 0; s < 4; s++) {
      this.plateInfo[s].pips = ev.pipCounts[s] ?? 0;
      // individual (ev.seats): only the winning player; pairs: the winning team
      this.plateInfo[s].winner = ev.seats ? s === ev.winnerSeat : ev.winnerTeam !== null && s % 2 === ev.winnerTeam;
    }
    this.redrawPlates();
    if (ev.reason === 'blocked') {
      this.sfx('tranque');
      this.addShake(0.2, 0.8);
      this.flashAmt = this.reduced ? 0.1 : 0.24;
      (this.flash.material as THREE.SpriteMaterial).color.set(0xff3b2a);
      this.chain.forEach((p, i) => {
        void this.hop(this.tiles[p.tile.id], 0.35 * this.layoutRes.cell, 0.3, i * 0.02);
      });
      await this.anim.wait(0.32);
    } else if (ev.winnerSeat !== null) {
      // no on-table word: '¡Dominó!' / '¡Capicúa!' is the winner's speech bubble (UI)
      await this.anim.wait(0.32);
    }
    if (g !== this.gen) return;
    await Promise.all(ps);
    if (g !== this.gen) return;
    if (ev.winnerTeam !== null) {
      const human = ev.winnerTeam === 0;
      this.sfx(human ? 'winHand' : 'loseHand');
      // celebrate only the human's (or the human's team's) wins — never the opponents'
      if (human) this.confettiBurst(false, ev.winnerTeam);
      for (let s = 0; s < 4; s++) {
        if (!this.plateInfo[s].winner) continue;
        void this.anim.tween(0.6, (k) => {
          this.plateScale[s] = 1 + 0.25 * Math.sin(Math.PI * k);
        });
      }
    }
    await this.anim.wait(1.2);
  }

  private async onMatchEnd(ev: Extract<GameEvent, { type: 'matchEnd' }>): Promise<void> {
    const g = this.gen;
    const human = ev.winner === 0;
    this.sfx(human ? 'winMatch' : 'loseMatch');
    if (human) this.confettiBurst(true, ev.winner);
    this.addShake(0.1, 0.6);
    this.flashAmt = 0.14;
    (this.flash.material as THREE.SpriteMaterial).color.set(human ? 0xffd060 : 0xff6040);
    await this.popup(human ? LABELS[this.lang].win : LABELS[this.lang].lose, human ? 'gold' : 'red', this.W / 2, this.H * 0.55, Math.min(this.W * 0.9, 600), 1.6);
    if (g !== this.gen) return;
    if (human && !this.reduced) {
      await this.anim.wait(0.5);
      this.confettiBurst(true, 0);
    }
    // all chain tiles do a victory wave (only when the human wins)
    if (human) this.chain.forEach((p, i) => void this.hop(this.tiles[p.tile.id], 0.4 * this.layoutRes.cell, 0.35, i * 0.03));
    await this.anim.wait(1.4);
  }

  requestHumanMove(legal: Move[]): Promise<Move> {
    const g = this.gen;
    const rg = this.reqGen;
    return new Promise<Move>((resolve) => {
      const start = () => {
        // a reset()/dispose() between the request and its start abandons it (the caller was cancelled)
        if (this.disposed || g !== this.gen || rg !== this.reqGen) return;
        if (this.req && !this.req.done) this.cancelReq();
        const sides = new Map<number, Move[]>();
        let passMove: Move | null = null;
        for (const m of legal) {
          if (m.kind === 'play') {
            const arr = sides.get(m.tileId) ?? [];
            arr.push(m);
            sides.set(m.tileId, arr);
          } else passMove = m;
        }
        if (!legal.length) passMove = { kind: 'pass', seat: 0 };
        const req: HumanReq = {
          legal,
          resolve,
          sides,
          passOnly: sides.size === 0,
          passMove,
          selected: -1,
          ghosts: [],
          hover: -1,
          done: false,
        };
        this.req = req;
        for (const id of this.hands[0]) {
          const t = this.tiles[id];
          t.dim = req.passOnly || !sides.has(id) ? 1 : 0;
          t.glow = 0;
        }
        if (req.passOnly) this.autoPass(req);
        else void this.relayoutSeat(0, 0.2);
        this.kick();
      };
      // wait until queued animations finished so the hand is in place
      void this.queue.then(start, start);
    });
  }

  /**
   * The human has no tile that fits: no on-table word or button — the dimmed hand says it, and the
   * plate's "Paso" speech bubble (UI) is the only pass indicator. The pass is taken after a short beat.
   */
  private autoPass(req: HumanReq): void {
    // individual play: drawing from the boneyard is forced too, and quicker (one tile after another)
    void this.anim.wait(req.passMove?.kind === 'draw' ? 0.32 : 1.0).then(() => {
      if (this.req === req && !req.done && req.passMove) this.finishReq(req.passMove);
    });
  }

  private finishReq(m: Move): void {
    const r = this.req;
    if (!r || r.done) return;
    r.done = true;
    this.req = null;
    this.clearCharge();
    for (const id of this.hands[0]) {
      const t = this.tiles[id];
      t.dim = 0;
      t.glow = 0;
    }
    this.setDragging(false);
    this.ptr.tile = -1;
    // keep the chosen tile where it is (the play event animates it); restore others
    const chosen = m.kind === 'play' ? m.tileId : -1;
    for (const id of this.hands[0]) if (id !== chosen) void this.flyHome(this.tiles[id], { dur: 0.18 });
    this.kick();
    r.resolve(m);
  }

  private cancelReq(): void {
    const r = this.req;
    if (!r) return;
    r.done = true;
    this.req = null;
    this.clearCharge();
    this.setDragging(false);
    this.ptr.down = false;
    for (const id of this.hands[0]) {
      this.tiles[id].dim = 0;
      this.tiles[id].glow = 0;
    }
  }

  setTurn(seat: Seat | null): void {
    if (seat !== this.turnSeat || (seat !== null && !this.turnLight.visible)) this.placeTurnLight(seat);
    this.turnSeat = seat;
    for (let s = 0; s < 4; s++) {
      const a = seat === s;
      if (this.plateInfo[s].active !== a) {
        this.plateInfo[s].active = a;
        this.redrawPlate(s);
      }
    }
    this.kick();
  }

  reset(): void {
    this.gen++;
    this.anim.finishAll();
    this.cancelReq();
    this.releasePointer();
    this.chain = [];
    this.ends = null;
    this.hands = [[], [], [], []];
    this.pile = [];
    this.pileOrder = [];
    this.unknown.fill(false);
    this.layoutRes = this.fitChain([]);
    this.dust.clear();
    this.confetti.clear();
    for (const p of this.popups) p.sprite.visible = false;
    this.flashAmt = 0;
    this.turnSeat = null;
    this.placeTurnLight(null, true);
    for (let s = 0; s < 4; s++) {
      this.plateInfo[s].active = false;
      this.plateInfo[s].pips = null;
      this.plateInfo[s].winner = false;
      this.plateScale[s] = 1;
      this.plateRot[s] = 0;
    }
    this.redrawPlates();
    for (let i = 0; i < TILE_COUNT; i++) {
      const t = this.tiles[i];
      t.token++;
      t.loc = 'idle';
      t.seat = -1;
      t.glow = 0;
      t.dim = 0;
      t.sq = 1;
      t.off.set(0, 0, 0);
      t.wx = 0;
      t.wz = 0;
    }
    this.idleActive = true;
    this.placeTurnLight(null, true);
    // whatever is still on the table shrinks away in place, then the attract scenes start
    this.menuDir.start(this.reduced);
    this.lastT = 0;
    this.kick();
  }

  setQuality(q: Quality): void {
    if (q === this.quality) return;
    const prev = this.q;
    this.quality = q;
    this.q = QUALITY[q];
    this.fstat.prev = 0; // never mix frame-time samples across levels
    // antialias is fixed at context creation: a change recreates the renderer (GPU resources re-upload lazily)
    if (prev.aa !== this.q.aa) this.createRenderer();
    this.renderer.setPixelRatio(this.pixelRatio());
    this.renderer.setSize(this.W, this.H, false);
    this.renderer.shadowMap.enabled = this.q.shadows;
    this.keyLight.castShadow = this.q.shadows;
    if (!this.q.shadows && this.keyLight.shadow.map) {
      // release the shadow map render target (re-created on demand if shadows come back)
      this.keyLight.shadow.map.dispose();
      this.keyLight.shadow.map = null;
    }
    this.tilesMesh.receiveShadow = this.q.shadows;
    this.blobMesh.visible = !this.q.shadows;
    this.tileMat.needsUpdate = true;
    (this.felt.material as THREE.Material).needsUpdate = true;
    if (prev.atlas !== this.q.atlas) {
      const old = this.atlas;
      this.atlas = tex.makeTileAtlas(this.q.atlas, this.theme, this.tileBack);
      this.tileMat.map = this.atlas;
      old.dispose();
    }
    if (prev.seg !== this.q.seg) {
      const old = this.tileGeo;
      this.tileGeo = buildTileGeometry(this.q.seg);
      this.tileGeo.setAttribute('aFx', this.fxAttr);
      this.tilesMesh.geometry = this.tileGeo;
      old.dispose();
    }
    this.applyQualityKnobs();
    this.arenaKey = '';
    this.computeLayout();
    this.prewarm();
    this.kick();
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    if (!paused) {
      this.lastT = 0;
      this.kick();
    } else this.loop.cancel();
  }

  /** optional extra: animation speed multiplier (1 = normal, 1.6 = fast) */
  setSpeed(x: number): void {
    this.speedMul = Math.max(0.1, x);
    this.anim.speed = this.speedMul * (this.reduced ? 1.35 : 1);
  }

  setReducedMotion(r: boolean): void {
    this.reduced = r;
    if (this.idleActive) this.menuDir.setReduced(r);
    this.kick();
    this.setSpeed(this.speedMul);
  }

  setLanguage(lang: 'es' | 'en'): void {
    if (lang === this.lang) return;
    this.lang = lang;
  }

  /**
   * Choose the physical tile set for the next hand. All global ids (0..82) are allocated up front;
   * this switches which ids are live (and the hand size used by layout and the deal). Inactive ids
   * are hidden by flushTiles. The main-menu attract ring always uses the decorative double-six ids.
   */
  setTileSet(set: TileSet): void {
    if (set === this.tileSet) return;
    this.tileSet = set;
    this.tileSetDef = TILE_SETS[set];
    this.computeLayout();
    this.kick();
  }

  setTileTheme(theme: TileTheme): void {
    if (theme === this.theme) return;
    this.theme = theme;
    const old = this.atlas;
    this.atlas = tex.makeTileAtlas(this.q.atlas, theme, this.tileBack);
    this.tileMat.map = this.atlas;
    this.tileMat.needsUpdate = true;
    old.dispose();
    this.kick();
  }

  /** switch the tile-back look live (regenerates the shared atlas, old one disposed) */
  setTileBack(back: TileBack): void {
    if (back === this.tileBack) return;
    this.tileBack = back;
    const old = this.atlas;
    this.atlas = tex.makeTileAtlas(this.q.atlas, this.theme, back);
    this.tileMat.map = this.atlas;
    this.tileMat.needsUpdate = true;
    old.dispose();
    this.kick();
  }

  /** switch the table look live: felt, medallion and the light on the tiles; old textures disposed */
  setTableStyle(style: TableStyle): void {
    if (style === this.tableStyle || !tex.TABLE_STYLE_DEFS[style]) return;
    this.tableStyle = style;
    const S = tex.tableStyleDef(style);
    this.hemiLight.color.set(S.hemiSky);
    this.hemiLight.groundColor.set(S.hemiGround);
    this.hemiLight.intensity = S.hemi;
    this.keyLight.color.set(S.keyColor);
    this.keyLight.intensity = S.key;
    this.rimLight.color.set(S.rimColor);
    this.rimLight.intensity = S.rim;
    this.syncFeltMat();
    // redraw the arena and the medallion (buildTable disposes the previous textures)
    this.arenaKey = '';
    this.buildTable();
    this.kick();
  }

  /**
   * Put a saved hand on the table in one frame: chain laid out exactly as normal play would leave it,
   * hands dealt (human face-up and sorted, CPUs face-down; revealed when the hand is over), plates
   * final. No sounds, impacts, particles or event animations, only a short dark fade-in.
   */
  restore(state: RestoreState): Promise<void> {
    // fast-forward anything queued/running so the queue drains immediately
    this.gen++;
    this.anim.finishAll();
    const run = async () => {
      if (this.disposed) return;
      // let promise callbacks of the finished tweens settle, then kill anything they started
      await new Promise<void>((r) => setTimeout(r, 0));
      if (this.disposed) return;
      this.gen++;
      this.anim.finishAll();
      try {
        this.applyRestore(state);
      } catch (e) {
        console.error('[render] restore failed', e);
      }
    };
    // never wait behind a step that cannot finish (a restore is the way out of any stuck state): the
    // queue normally drains within a tick after finishAll; if not, restore anyway after a short grace
    const prev = this.queue;
    const grace = new Promise<void>((r) => setTimeout(r, 400));
    this.queue = Promise.race([prev.then(() => undefined, () => undefined), grace]).then(run, run);
    this.kick();
    return this.queue;
  }

  private applyRestore(state: RestoreState): void {
    const h = state.hand;
    const over = !!state.handOver || !!h.over;
    this.cancelReq();
    this.clearCharge();
    this.setDragging(false);
    this.idleActive = false;
    this.dust.clear();
    this.confetti.clear();
    for (const p of this.popups) p.sprite.visible = false;
    this.ring.visible = false;
    this.flashAmt = 0;
    this.shake = 0;
    this.punch = 0;
    this.shakeDecay = 9;
    this.needsSettle = false;

    // individual play: seats in play and what is left of the boneyard (laid out as a fresh, compact pile)
    this.setActiveSeats(state.seats);
    this.pileOrder = (h.boneyard ?? []).map((t) => t.id);
    this.chain = h.chain.slice();
    this.ends = h.ends ? { left: h.ends.left, right: h.ends.right } : null;
    this.updatePileAvoid(this.chainAvoid);
    this.layoutRes = this.fitChain(this.chain);
    this.hands = [0, 1, 2, 3].map((s) => (h.hands[s] ?? []).map((t) => t.id));
    // online: hidden tiles (placeholders) borrow the ids of tiles that are nowhere in sight
    resolvePlaceholders(
      [...this.hands, this.pileOrder],
      this.chain.map((p) => p.tile.id),
      this.unknown,
      this.tileSetDef.ids,
    );
    this.pile = this.pileOrder.slice();
    this.sortHuman();

    for (const t of this.tiles) {
      t.token++;
      t.loc = 'pool';
      t.seat = -1;
      t.glow = 0;
      t.dim = 0;
      t.sq = 1;
      t.off.set(0, 0, 0);
      t.wx = 0;
      t.wz = 0;
      t.pos.set(0, -5, 0);
      t.quat.identity();
      t.s = 0.8;
    }
    for (const p of this.chain) {
      const t = this.tiles[p.tile.id];
      t.loc = 'chain';
      t.seat = p.seat;
    }
    for (let s = 0; s < 4; s++)
      for (const id of this.hands[s]) {
        const t = this.tiles[id];
        // as after handEnd: the CPUs' remaining tiles lie revealed, the human keeps the fan (hidden tiles stay face down)
        t.loc = over && s > 0 && !this.unknown[id] ? 'reveal' : 'hand';
        t.seat = s;
      }
    for (const id of this.pile) {
      const t = this.tiles[id];
      t.loc = 'pile';
      t.seat = -1;
    }
    // restored hands have no leftovers on the felt (15 undealt double-nine tiles in pairs)
    const used = new Set<number>([...this.chain.map((p) => p.tile.id), ...this.hands.flat(), ...this.pile]);
    for (const id of this.tileSetDef.ids) {
      if (used.has(id)) continue;
      const t = this.tiles[id];
      t.loc = 'pool';
      t.seat = -1;
      t.s = 0;
    }
    this.snapAll();

    for (let s = 0; s < 4; s++) {
      const info = this.plateInfo[s];
      info.pips = over && !this.hands[s].some((id) => this.unknown[id]) ? this.hands[s].reduce((n, id) => n + TILE_BY_ID[id].a + TILE_BY_ID[id].b, 0) : null;
      info.winner = false;
      info.active = false;
      this.plateScale[s] = 1;
      this.plateRot[s] = 0;
    }
    this.turnSeat = null;
    this.setTurn(over ? null : h.turn);
    this.redrawPlates();

    // short fade-in (not awaited: play may continue right away)
    this.fadeAmt = 1;
    void this.anim.tween(0.22, (k) => (this.fadeAmt = k >= 1 ? 0 : 1 - k), ease.outQuad);
    this.kick();
  }

  /** the human's drag state; notifies the UI (onDrag) only on change */
  private setDragging(v: boolean): void {
    if (this.ptr.dragging === v) return;
    this.ptr.dragging = v;
    try {
      this.opts.onDrag?.(v);
    } catch {
      /* ignore */
    }
  }

  setPlayerNames(names: [string, string, string, string]): void {
    for (let s = 0; s < 4; s++) this.plateInfo[s].name = names[s] ?? `P${s + 1}`;
    this.redrawPlates();
    this.kick();
  }

  dispose(): void {
    if (this.disposed) return;
    this.setDragging(false);
    this.gen++;
    this.anim.finishAll();
    this.disposed = true;
    this.loop.cancel();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = 0;
    this.resizeObs?.disconnect();
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('pointerdown', this.onMenuDown);
    window.removeEventListener('pointerup', this.onMenuUp);
    window.removeEventListener('pointercancel', this.onMenuCancel);
    if (this.menuPoll) clearInterval(this.menuPoll);
    this.menuPoll = 0;
    this.detachInput();
    const seen = new Set<unknown>();
    const disposeMat = (m: THREE.Material) => {
      if (seen.has(m)) return;
      seen.add(m);
      const anyM = m as unknown as Record<string, unknown>;
      for (const k of Object.keys(anyM)) {
        const v = anyM[k];
        if (v instanceof THREE.Texture && !seen.has(v)) {
          seen.add(v);
          v.dispose();
        }
      }
      m.dispose();
    };
    for (const sc of [this.scene, this.overlay]) {
      sc.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.geometry && !seen.has(mesh.geometry)) {
          seen.add(mesh.geometry);
          mesh.geometry.dispose();
        }
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach(disposeMat);
        else if (mat) disposeMat(mat);
      });
    }
    for (const p of this.plates) p.tex.dispose();
    for (const p of this.popups) p.tex.dispose();
    this.feltTex?.dispose();
    this.emblemTex?.dispose();
    this.atlas.dispose();
    this.renderer.dispose();
    this.canvas.remove();
    if (import.meta.env.DEV) this.perf?.dispose();
  }

  // ───────────────────────── loop ─────────────────────────

  private kick(): void {
    this.loop.kick();
  }

  /**
   * Safety net (1 s timer): the loop must never sleep while tweens, queued events or a human request
   * are pending; if it does (a missed kick), wake it. Normally a no-op.
   */
  private checkAwake = (): void => {
    if (this.paused || this.disposed || this.loop.scheduled) return;
    if (!this.anim.active && this.busy === 0 && !this.req && !this.charge) return;
    if (import.meta.env.DEV) console.warn('[render] loop was asleep with work pending: woken');
    this.lastT = 0;
    this.kick();
  };

  /**
   * The table's idle life (the medallion turns, the turn light breathes) runs while it is somebody's
   * turn. Not with reduced motion, and not on low quality, where the loop sleeps between moves instead.
   */
  private tableAlive(): boolean {
    return !this.reduced && !this.q.lite && !this.idleActive;
  }

  /** one frame; returns true when another frame is wanted */
  private loopFrame(now: number): boolean {
    // attract scenes: full rate (low: its 30 fps cap) while the menu shows; the calm showcase is ambient
    const menuOn = (this.menuOn = this.menuLive());
    const hard =
      (menuOn && this.menuDir.busy) || this.anim.active || this.dust.busy || this.confetti.busy || this.shake > 0.002 || this.punch > 0.002 || this.ptr.dragging || this.flashAmt > 0.002 || this.charge !== null || this.fadeAmt > 0;
    // the turn pulse is a 3D sprite only without HTML plates (the UI animates its own plates)
    const ambient = menuOn || (this.turnSeat !== null && (!this.htmlPlates || this.tableAlive())) || (this.req !== null && !this.req.passOnly);
    const woke = this.lastT === 0;
    // frame cap: low skips rAF ticks (30 fps animating, 15 fps for gentle pulses); time stays real
    const minGap = hard ? this.q.frameMs : ambient ? this.q.ambientMs : 0;
    if (!woke && minGap > 0 && now - this.lastRender < minGap && now >= this.lastRender) return true;
    let dt = woke ? 1 / 60 : (now - this.lastT) / 1000;
    // (a frame run by the stall timer, see frameLoop.ts: a bigger step so animations still finish)
    const maxDt = this.loop.fromTimer ? 0.5 : this.q.maxDt;
    if (dt > maxDt) dt = maxDt;
    if (dt < 0) dt = 0;
    this.lastT = now;
    this.lastRender = now;
    const w0 = import.meta.env.DEV && this.perf ? performance.now() : 0;
    this.update(dt);
    this.render();
    if (import.meta.env.DEV && this.perf) this.perf.frame(now, performance.now() - w0, this.renderer, this.quality, [this.scene, this.overlay], this.q.aa);
    if (this.opts.onFrameStats) this.sampleFrame(now, hard && !woke);
    if (hard || ambient || this.anim.active) return true;
    this.lastT = 0;
    return false;
  }

  /**
   * onFrameStats: average interval between rendered frames over ~1 s windows, only while something is
   * really animating; a window restarts after idle / pause / a hidden tab / a quality change, and the
   * first frames after waking (uploads, shader compiles, rAF ramp-up) are not counted. No allocations.
   */
  private sampleFrame(now: number, active: boolean): void {
    const s = this.fstat;
    if (!active || s.prev === 0 || now - s.prev > 250) {
      s.prev = active ? now : 0;
      s.skip = 3;
      s.start = now;
      s.sum = 0;
      s.n = 0;
      return;
    }
    const d = now - s.prev;
    s.prev = now;
    if (s.skip > 0) {
      s.skip--;
      s.start = now;
      return;
    }
    s.sum += d;
    s.n++;
    if (now - s.start >= 1000) {
      const o = this.fstatOut;
      o.avgFrameMs = s.sum / s.n;
      o.frames = s.n;
      o.quality = this.quality;
      s.start = now;
      s.sum = 0;
      s.n = 0;
      try {
        this.opts.onFrameStats?.(o);
      } catch {
        /* ignore */
      }
    }
  }

  private update(dt: number): void {
    this.anim.update(dt);
    // a resize during a non-event animation (e.g. the restore fade): settle once things are quiet
    if (this.needsSettle && this.busy === 0 && !this.anim.active) {
      this.needsSettle = false;
      void this.settleAll(0.25);
    }
    const sdt = dt * this.anim.speed;
    this.uTime.value += dt;
    // main-menu attract scenes (parked while the menu is not on screen)
    if (this.menuOn) this.menuDir.update(import.meta.env.DEV ? dt * this.menuDev.speed : dt);
    // drag follow
    if (this.ptr.dragging && this.ptr.tile >= 0) {
      const t = this.tiles[this.ptr.tile];
      const k = 1 - Math.exp(-dt * 22);
      t.pos.lerp(this.dragTarget, k);
      t.quat.slerp(this.dragQuat, 1 - Math.exp(-dt * 11));
      t.s = lerp(t.s, this.layoutRes.cell * 1.12, k);
    }
    // slam charge: the tile rises a little and trembles while the press is held
    const ch = this.charge;
    if (ch) {
      const t = this.tiles[ch.tile];
      const k = Math.min(1, (performance.now() - ch.start) / SLAM_HOLD_MS);
      const a = ch.armed ? 0.06 * this.handHs : 0;
      t.off.set(Math.sin(this.uTime.value * 70) * a, this.handHs * 0.35 * k + Math.sin(this.uTime.value * 53) * a * 0.5, 0);
    }
    // human glow pulse on playable tiles
    const r = this.req;
    if (r && !r.passOnly) {
      const pulse = 0.5 + 0.5 * Math.sin(this.uTime.value * 2.2);
      for (const id of this.hands[0]) {
        const t = this.tiles[id];
        if (!r.sides.has(id)) continue;
        t.glow = r.selected === id ? 0.95 : 0.45 + 0.3 * pulse;
      }
    }
    // table life: the medallion turns slowly and breathes with the turn light
    const breath = this.turnSeat !== null && this.tableAlive() ? Math.sin(this.uTime.value * 1.7) : 0;
    if (breath !== 0 || this.turnLight.visible) {
      if (this.turnSeat !== null && this.tableAlive()) this.emblem.rotation.y -= dt * 0.11;
      (this.emblem.material as THREE.MeshBasicMaterial).opacity = this.emblemAlpha() * (1 + 0.22 * breath);
      (this.turnLight.material as THREE.MeshBasicMaterial).opacity = this.turnLightAmt * (0.17 + 0.035 * breath);
    }
    this.dust.update(sdt);
    this.confetti.update(dt);
    // camera shake / punch
    this.shakeT += dt;
    this.shake *= Math.exp(-dt * this.shakeDecay);
    this.punch *= Math.exp(-dt * (this.shakeDecay < 9 ? 4 : 6));
    if (this.shake < 0.01 && this.punch < 0.01) this.shakeDecay = 9;
    const cam = this.camera;
    cam.position.copy(this.baseCamPos);
    if (this.shake > 0.002) {
      const st = this.shakeT;
      cam.position.x += Math.sin(st * 53) * this.shake;
      cam.position.y += Math.sin(st * 61 + 1) * this.shake * 0.6;
      cam.position.z += Math.sin(st * 47 + 2) * this.shake;
    }
    if (this.punch > 0.002) {
      tmpV.subVectors(this.lookTarget, this.baseCamPos).multiplyScalar(this.punch * 0.025 * Math.sin(Math.min(1, this.punch) * Math.PI * 0.5));
      cam.position.add(tmpV);
    }
    cam.quaternion.copy(this.baseCamQuat);
    cam.updateMatrixWorld();
    this.flashAmt = this.q.shake ? this.flashAmt * Math.exp(-dt * 5) : 0;
    const fm = this.flash.material as THREE.SpriteMaterial;
    fm.opacity = this.flashAmt;
    this.flash.visible = this.flashAmt > 0.003;
    const fdm = this.fader.material as THREE.SpriteMaterial;
    fdm.opacity = this.fadeAmt;
    this.fader.visible = this.fadeAmt > 0.003;

    this.flushTiles();
    this.updateOverlay();
  }

  private flushTiles(): void {
    const fx = this.fxAttr.array as Float32Array;
    const blobCol = this.blobMesh.instanceColor!.array as Float32Array;
    const glowCol = this.glowMesh.instanceColor!.array as Float32Array;
    for (let id = 0; id < TILE_COUNT; id++) {
      // The attract ring uses the decorative double-six ids; in play only the active set is live.
      // Every other global id is scaled away, so an inactive tile can never appear on the table.
      const visible = this.idleActive ? id < TILE_SETS.double6.count : this.tileSetDef.ids.includes(id);
      if (!visible) {
        tmpM.makeScale(0, 0, 0);
        this.tilesMesh.setMatrixAt(id, tmpM);
        this.blobMesh.setMatrixAt(id, tmpM);
        this.glowMesh.setMatrixAt(id, tmpM);
        fx[id * 2] = 0;
        fx[id * 2 + 1] = 0;
        blobCol[id * 3] = blobCol[id * 3 + 1] = blobCol[id * 3 + 2] = 0;
        glowCol[id * 3] = glowCol[id * 3 + 1] = glowCol[id * 3 + 2] = 0;
        continue;
      }
      const t = this.tiles[id];
      const s = t.s;
      const sx = s * (1 + (1 - t.sq) * 0.45);
      tmpV.copy(t.pos).add(t.off);
      tmpS.set(sx, s * t.sq, sx);
      if (t.wx !== 0 || t.wz !== 0) {
        tmpQW.setFromEuler(tmpE.set(t.wx, 0, t.wz)).multiply(t.quat);
        tmpM.compose(tmpV, tmpQW, tmpS);
      } else tmpM.compose(tmpV, t.quat, tmpS);
      this.tilesMesh.setMatrixAt(id, tmpM);
      fx[id * 2] = t.glow;
      fx[id * 2 + 1] = t.dim;

      // blob shadow
      const inHand = t.loc === 'hand' && t.seat === 0;
      const hgt = tmpV.y;
      if (inHand || t.s <= 0.01 || (t.loc === 'pool' && hgt < -1)) {
        tmpM.makeScale(0, 0, 0);
        blobCol[id * 3] = 0;
      } else {
        const ax = tmpV2.set(TL * s, 0, 0).applyQuaternion(t.quat);
        const az = tmpV3.set(0, 0, TW * s).applyQuaternion(t.quat);
        const spread = 1 + Math.min(1.5, Math.max(0, hgt)) * 0.12;
        const cx = (Math.abs(ax.x) + Math.abs(az.x) + TH * s) * 1.5 * spread;
        const cz = (Math.abs(ax.z) + Math.abs(az.z) + TH * s) * 1.5 * spread;
        tmpM.makeScale(cx, 1, cz);
        tmpM.setPosition(tmpV.x, 0.012, tmpV.z);
        // align with yaw for flat tiles
        const yaw = Math.atan2(-ax.z, ax.x);
        const flat = Math.abs(ax.y) < 0.5 * TL * s;
        if (flat) {
          tmpQ.setFromAxisAngle(UP, yaw);
          tmpS.set((Math.hypot(ax.x, ax.z) + TH * s) * 1.5 * spread, 1, (Math.hypot(az.x, az.z) + TH * s) * 1.6 * spread);
          tmpV2.set(tmpV.x, 0.012, tmpV.z);
          tmpM.compose(tmpV2, tmpQ, tmpS);
        }
        blobCol[id * 3] = clamp01(1.1 - hgt / 3.5) * clamp01((s - 0.3) * 3) * (t.loc === 'idle' ? 0.5 : 1);
      }
      this.blobMesh.setMatrixAt(id, tmpM);

      // halo behind glowing tiles
      if (t.glow > 0.01) {
        tmpQ.copy(t.quat).multiply(Q_PLANE_TO_TILE);
        const faceN = tmpV2.set(0, 1, 0).applyQuaternion(t.quat);
        tmpV.addScaledVector(faceN, -TH * s * 0.55);
        // same outline texture as the drop slots: tile-shaped, tile corner radius, a hair outside the edge
        const m = 0.07 * TW * s;
        tmpS.set((TL * s + 2 * m) * GHOST_SX, (TW * s + 2 * m) * GHOST_SY, 1);
        tmpM.compose(tmpV, tmpQ, tmpS);
        const gl = Math.min(1, t.glow);
        glowCol[id * 3] = 0.75 * gl;
        glowCol[id * 3 + 1] = 0.55 * gl;
        glowCol[id * 3 + 2] = 0.18 * gl;
      } else {
        tmpM.makeScale(0, 0, 0);
      }
      this.glowMesh.setMatrixAt(id, tmpM);
    }
    // ghost slots
    const r = this.req;
    const ghostCol = this.ghostMesh.instanceColor!.array as Float32Array;
    let anyGhost = false;
    for (let gi = 0; gi < 2; gi++) {
      const gh = r && !r.done ? r.ghosts[gi] : undefined;
      if (gh) {
        anyGhost = true;
        const cell = this.layoutRes.cell;
        const hovered = r!.hover === gi;
        let pulse = hovered ? 1 : 0.55 + 0.25 * Math.sin(this.uTime.value * 5 + gi);
        // slam charge on this slot: the outline fills teal -> gold and swells slightly
        const c = this.charge;
        let fill = 0;
        if (c && c.move.kind === 'play' && gh.move.kind === 'play' && c.move.side === gh.move.side && c.move.tileId === gh.move.tileId) {
          fill = c.armed ? 1 : Math.min(1, (performance.now() - c.start) / SLAM_HOLD_MS);
          pulse = Math.max(pulse, 0.6 + 0.4 * fill);
        }
        tmpQ.setFromAxisAngle(UP, gh.rotY).multiply(Q_PLANE_TO_TILE);
        tmpV.set(gh.x, 0.03, gh.z);
        // exactly a placed tile's footprint (the texture's inner rect), plus the glow padding
        const sw = 1 + 0.08 * fill + (c && c.armed && fill >= 1 ? 0.025 * Math.sin(this.uTime.value * 18) : 0);
        tmpS.set(TL * cell * GHOST_SX * sw, TW * cell * GHOST_SY * sw, 1);
        tmpM.compose(tmpV, tmpQ, tmpS);
        ghostCol[gi * 3] = lerp(0.45, 1.0, fill) * pulse;
        ghostCol[gi * 3 + 1] = lerp(1.0, 0.74, fill) * pulse;
        ghostCol[gi * 3 + 2] = lerp(0.75, 0.18, fill) * pulse;
      } else tmpM.makeScale(0, 0, 0);
      this.ghostMesh.setMatrixAt(gi, tmpM);
    }
    this.ghostMesh.visible = anyGhost;
    this.ghostMesh.instanceMatrix.needsUpdate = true;
    this.ghostMesh.instanceColor!.needsUpdate = true;
    this.tilesMesh.instanceMatrix.needsUpdate = true;
    this.fxAttr.needsUpdate = true;
    this.blobMesh.instanceMatrix.needsUpdate = true;
    this.blobMesh.instanceColor!.needsUpdate = true;
    this.glowMesh.instanceMatrix.needsUpdate = true;
    this.glowMesh.instanceColor!.needsUpdate = true;
  }

  /** HTML plates: report the boxes when anything about them changed (allocation-free when idle) */
  private emitPlates(): void {
    const cb = this.opts.onPlates;
    if (!cb) return;
    let dirty = false;
    const H = this.H;
    for (let s = 0; s < 4; s++) {
      const b = this.plateBoxes[s];
      const info = this.plateInfo[s];
      b.scale = this.plateScale[s];
      b.rot = -this.plateRot[s];
      b.visible = !this.idleActive && this.active[s];
      b.active = info.active;
      b.winner = info.winner;
      b.count = info.count;
      b.pips = info.pips;
      // a cheap signature of everything the UI draws
      const sig =
        this.plateX[s] * 3.1 + (H - this.plateY[s]) * 7.3 + b.w * 11 + b.d * 13 + b.scale * 1000 + b.rot * 5000 +
        (b.visible ? 1e5 : 0) + (b.active ? 2e5 : 0) + (b.winner ? 4e5 : 0) + b.count * 1e6 + (b.pips ?? -1) * 1e7;
      if (sig !== this.plateSig[s]) {
        this.plateSig[s] = sig;
        dirty = true;
      }
    }
    if (!dirty && this.plateCenterSig === 0) return;
    this.plateCenterSig = 0;
    for (let s = 0; s < 4; s++) {
      const b = this.plateBoxes[s];
      b.x = this.plateX[s];
      b.y = H - this.plateY[s];
      if (b.bubble) {
        b.bubble.x = this.bubX[s];
        b.bubble.y = H - this.bubY[s];
        b.bubble.dir = this.bubDir[s];
      }
    }
    try {
      cb(this.plateBoxes, this.plateCenter);
    } catch (e) {
      // the UI's plates must never take the render loop down with them
      if (!this.platesErr) {
        console.error('[render] onPlates failed', e);
        noteError('plates', e);
      }
      this.platesErr = true;
    }
  }
  private platesErr = false;

  private updateOverlay(): void {
    if (this.htmlPlates) {
      for (let s = 0; s < 4; s++) this.plates[s].sprite.visible = false;
      this.turnGlow.visible = false;
      this.emitPlates();
      return;
    }
    for (let s = 0; s < 4; s++) {
      const sp = this.plates[s].sprite;
      sp.visible = !this.idleActive;
      const k = this.plateScale[s];
      sp.position.set(this.plateX[s], this.plateY[s], 0);
      sp.scale.set(this.plateW * k, this.plateH * k, 1);
      (sp.material as THREE.SpriteMaterial).rotation = this.plateRot[s];
    }
    const ts = this.turnSeat;
    if (ts !== null) {
      const pulse = 0.5 + 0.5 * Math.sin(this.uTime.value * 2);
      this.turnGlow.visible = true;
      this.turnGlow.position.set(this.plateX[ts], this.plateY[ts], 0);
      // subtle, tight warm wash behind the plate (normal blending, low opacity: never blooms the name)
      this.turnGlow.scale.set(this.plateW * 1.18, this.plateH * 1.9, 1);
      (this.turnGlow.material as THREE.SpriteMaterial).opacity = 0.1 + 0.1 * pulse;
    } else this.turnGlow.visible = false;
  }

  private render(): void {
    const r = this.renderer;
    if (import.meta.env.DEV && this.perf) r.info.reset();
    r.clear();
    r.render(this.scene, this.camera);
    r.clearDepth();
    r.render(this.overlay, this.overlayCam);
  }

  // ───────────────────────── input ─────────────────────────

  private attachInput(): void {
    const c = this.canvas;
    c.addEventListener('pointerdown', this.onDown);
    c.addEventListener('pointermove', this.onMove);
    c.addEventListener('pointerup', this.onUp);
    c.addEventListener('pointercancel', this.onCancel);
    c.addEventListener('contextmenu', this.prevent);
  }

  private detachInput(): void {
    const c = this.canvas;
    if (!c) return;
    c.removeEventListener('pointerdown', this.onDown);
    c.removeEventListener('pointermove', this.onMove);
    c.removeEventListener('pointerup', this.onUp);
    c.removeEventListener('pointercancel', this.onCancel);
    c.removeEventListener('contextmenu', this.prevent);
  }

  private prevent = (e: Event) => e.preventDefault();

  private evPos(e: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: this.H - (e.clientY - rect.top) };
  }

  /** index into hands[0] under the point, or -1 */
  private hitHand(x: number, y: number): number {
    const n = this.hands[0].length;
    if (!n) return -1;
    const pxPerWorld = this.H / (2 * this.handHalfH);
    // (more than a full hand: the fan closes up, see slotPose)
    const hk = this.humanHandK(n);
    const tw = TW * this.handHs * hk.s * pxPerWorld;
    const th = TL * this.handHs * hk.s * pxPerWorld;
    const pitch = 1.06 * TW * this.handHs * hk.p * pxPerWorld;
    let best = -1;
    let bestD = 1e9;
    const scr = { x: 0, y: 0 };
    for (let i = 0; i < n; i++) {
      const t = this.tiles[this.hands[0][i]];
      if (t.loc !== 'hand') continue;
      this.toScreen(t.pos, scr);
      const dx = Math.abs(x - scr.x);
      const dy = y - scr.y;
      if (dx <= Math.max(pitch * 0.5, tw * 0.5 + 4) && dy <= th * 0.62 + 10 && dy >= -th * 0.5 - 40) {
        if (dx < bestD) {
          bestD = dx;
          best = i;
        }
      }
    }
    return best;
  }

  /** screen position of ghost i (y up); returns the on-screen length of a placed tile in px */
  private ghostPx(i: number, out: { x: number; y: number }): number {
    const g = this.req!.ghosts[i];
    tmpV2.set(g.x, 0, g.z);
    this.toScreen(tmpV2, out);
    const ox = out.x;
    const oy = out.y;
    tmpV2.x += TL * this.layoutRes.cell;
    this.toScreen(tmpV2, this.scrTmp);
    out.x = ox;
    out.y = oy;
    return Math.max(24, Math.hypot(this.scrTmp.x - ox, this.scrTmp.y - oy));
  }
  private scrTmp = { x: 0, y: 0 };
  private scrG = { x: 0, y: 0 };
  /** distance (px) and tile length (px) of the last dropTarget() result */
  private dropDist = 0;
  private dropLen = 1;

  /**
   * Generous drop zones. Over the hand area -> -1 (cancel). Above it: with one legal end, that end;
   * with two, the nearest one to the release point pushed a little along the pointer velocity (so the
   * table is split by the midline between the ends — no dead zone). `radiusLens` > 0 limits the zone to
   * that many tile lengths around a slot (used for taps).
   */
  private dropTarget(x: number, y: number, vx: number, vy: number, radiusLens = 0): number {
    const r = this.req;
    if (!r || !r.ghosts.length) return -1;
    if (y < this.handTopPx + 6) return -1;
    const sp = Math.hypot(vx, vy);
    const lead = sp > 400 ? 0.09 : 0;
    const px = x + vx * lead;
    const py = y + vy * lead;
    let best = -1;
    let bestD = 1e9;
    for (let i = 0; i < r.ghosts.length; i++) {
      const len = this.ghostPx(i, this.scrG);
      const d = Math.hypot(px - this.scrG.x, py - this.scrG.y);
      const dRaw = Math.hypot(x - this.scrG.x, y - this.scrG.y);
      if (radiusLens > 0 && dRaw > radiusLens * len) continue;
      if (d < bestD) {
        bestD = d;
        best = i;
        this.dropDist = dRaw;
        this.dropLen = len;
      }
    }
    return best;
  }

  /** pointer velocity (px/s, y up) over the last ~80 ms, from the trail ring buffer */
  private trailVel = { x: 0, y: 0 };
  private velocity(x: number, y: number): { x: number; y: number } {
    const now = performance.now();
    const n = Math.min(this.trailN, 8);
    let ox = x;
    let oy = y;
    let ot = now;
    for (let i = 1; i <= n; i++) {
      const k = (this.trailN - i) & 7;
      if (now - this.trailT[k] > 80) break;
      ox = this.trailX[k];
      oy = this.trailY[k];
      ot = this.trailT[k];
    }
    const dt = Math.max(16, now - ot) / 1000;
    this.trailVel.x = (x - ox) / dt;
    this.trailVel.y = (y - oy) / dt;
    return this.trailVel;
  }

  private computeGhosts(tileId: number): void {
    const r = this.req;
    if (!r) return;
    r.ghosts = [];
    r.hover = -1;
    const moves = r.sides.get(tileId);
    if (!moves) return;
    const tile = TILE_BY_ID[tileId];
    const seen = new Set<string>();
    for (const m of moves) {
      if (m.kind !== 'play') continue;
      let placed: PlacedTile;
      if (!this.ends || this.chain.length === 0) {
        placed = { tile, seat: 0, side: 'right', outer: tile.b };
      } else {
        const end = m.side === 'left' ? this.ends.left : this.ends.right;
        placed = { tile, seat: 0, side: m.side, outer: (tile.a === end ? tile.b : tile.a) as Pip };
      }
      const res = this.fitChain(this.chain.concat(placed), true);
      const p = res.poses[res.poses.length - 1];
      const key = `${p.x.toFixed(3)},${p.z.toFixed(3)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      r.ghosts.push({ side: m.side, x: p.x, z: p.z, rotY: p.rotY, move: m });
    }
  }

  private select(tileId: number): void {
    const r = this.req;
    if (!r) return;
    r.selected = tileId;
    if (tileId >= 0) this.computeGhosts(tileId);
    else {
      r.ghosts = [];
      r.hover = -1;
    }
    void this.relayoutSeat(0, 0.16);
    this.kick();
  }

  /** start the SLAM_HOLD_MS hold timer that arms a slam for `move` (tile trembles once armed) */
  private startCharge(move: Move, tile: number): void {
    this.clearCharge();
    this.charge = { move, tile, armed: false, t0: 0, start: performance.now() };
    this.kick();
    this.chargeTimer = window.setTimeout(() => {
      const c = this.charge;
      if (!c || !this.ptr.down) return;
      c.armed = true;
      c.t0 = performance.now();
      this.sfx('charge');
      this.kick();
    }, SLAM_HOLD_MS);
  }

  private clearCharge(): void {
    if (this.chargeTimer) clearTimeout(this.chargeTimer);
    this.chargeTimer = 0;
    const c = this.charge;
    if (c) {
      const t = this.tiles[c.tile];
      if (t) t.off.set(0, 0, 0);
    }
    this.charge = null;
  }

  private slamMove(m: Move): Move {
    return m.kind === 'play' ? { ...m, slam: true } : m;
  }

  private invalid(tileId: number): void {
    this.sfx('invalid');
    const t = this.tiles[tileId];
    void this.shakeTile(t);
    this.kick();
  }

  private onDown = (e: PointerEvent): void => {
    const r = this.req;
    // a new primary pointer means no other pointer is down: a press whose pointerup/cancel never arrived
    // (lost with a recreated canvas, a WebView quirk…) must not block every later tap (touch ids never repeat)
    if (this.ptr.down && e.isPrimary && e.pointerId !== this.ptr.id) this.releasePointer();
    if (!r || r.done || this.ptr.down) return;
    const p = this.evPos(e);
    if (r.passOnly) return; // taken automatically (autoPass)
    this.ptr.down = true;
    this.ptr.id = e.pointerId;
    this.ptr.sx = this.ptr.x = p.x;
    this.ptr.sy = this.ptr.y = p.y;
    this.ptr.t = performance.now();
    this.ptr.vx = this.ptr.vy = 0;
    this.trailN = 0;
    this.setDragging(false);
    const hi = this.hitHand(p.x, p.y);
    this.ptr.tile = hi >= 0 ? this.hands[0][hi] : -1;
    this.ptr.ghost = -1;
    if (this.ptr.tile >= 0) {
      const moves = r.sides.get(this.ptr.tile);
      // (no slam charge here: holding a hand tile used to arm one and slammed by accident)
      if (moves && moves.length === 1 && r.selected !== this.ptr.tile) this.select(this.ptr.tile);
    } else if (r.selected >= 0) {
      const gi = this.dropTarget(p.x, p.y, 0, 0, 2.5);
      if (gi >= 0) {
        this.ptr.ghost = gi;
        this.startCharge(r.ghosts[gi].move, r.selected);
      }
    }
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  private onMove = (e: PointerEvent): void => {
    const r = this.req;
    if (!r || r.done || !this.ptr.down || e.pointerId !== this.ptr.id) return;
    const p = this.evPos(e);
    const now = performance.now();
    const dt = Math.max(1, now - this.ptr.t) / 1000;
    // smoothed pointer velocity (px/s) for drop targeting
    const k = Math.min(1, dt / 0.05);
    this.ptr.vx += ((p.x - this.ptr.x) / dt - this.ptr.vx) * k;
    this.ptr.vy += ((p.y - this.ptr.y) / dt - this.ptr.vy) * k;
    this.ptr.t = now;
    this.ptr.x = p.x;
    this.ptr.y = p.y;
    const ti = this.trailN++ & 7;
    this.trailX[ti] = p.x;
    this.trailY[ti] = p.y;
    this.trailT[ti] = now;
    const id = this.ptr.tile;
    if (id < 0) {
      // a press on a slot: sliding off it cancels the slam charge
      if (this.charge && Math.hypot(p.x - this.ptr.sx, p.y - this.ptr.sy) > 24) this.clearCharge();
      return;
    }
    if (!this.ptr.dragging) {
      if (Math.hypot(p.x - this.ptr.sx, p.y - this.ptr.sy) < 10) return;
      if (!r.sides.has(id)) return; // unplayable: handled as tap on release
      this.clearCharge();
      this.setDragging(true);
      if (r.selected !== id) {
        this.sfx('select');
        this.select(id);
      }
      this.tiles[id].token++; // cancel tweens on the dragged tile
      this.handQuat(this.dragQuat);
    }
    // follow the pointer on a plane above the table
    this.ndc.set((p.x / this.W) * 2 - 1, (p.y / this.H) * 2 - 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const lift = 0.9;
    this.plane.constant = -lift;
    const hit = this.raycaster.ray.intersectPlane(this.plane, tmpV);
    if (hit) this.dragTarget.copy(hit);
    const vel = this.velocity(p.x, p.y);
    const gi = this.dropTarget(p.x, p.y, vel.x, vel.y);
    // the targeted slot is always highlighted; near it the tile rotates into place and is pulled in
    r.hover = gi;
    const near = gi >= 0 && this.dropDist < 1.6 * this.dropLen;
    if (near) this.dragQuat.setFromAxisAngle(UP, r.ghosts[gi].rotY);
    else this.handQuat(this.dragQuat);
    // hold-to-slam: the tile resting over a slot charges a slam for that slot; leaving it cancels
    const over = gi >= 0 && this.dropDist < this.dropLen;
    if (over) {
      const mv = r.ghosts[gi].move;
      const c = this.charge;
      if (!c || !sameMove(c.move, mv)) this.startCharge(mv, id);
    } else if (this.charge) this.clearCharge();
    if (near) {
      const gh = r.ghosts[gi];
      const m = 0.55 * (1 - this.dropDist / (1.6 * this.dropLen));
      this.dragTarget.x = lerp(this.dragTarget.x, gh.x, m);
      this.dragTarget.z = lerp(this.dragTarget.z, gh.z, m);
    }
    this.kick();
  };

  private onUp = (e: PointerEvent): void => {
    const r = this.req;
    if (!this.ptr.down || e.pointerId !== this.ptr.id) return;
    this.ptr.down = false;
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (!r || r.done) {
      this.setDragging(false);
      return;
    }
    const p = this.evPos(e);
    const id = this.ptr.tile;
    // a held (armed) press releases as a slam
    const ch = this.charge;
    if (ch && ch.armed) {
      if (this.ptr.dragging) this.setDragging(false);
      this.finishReq(this.slamMove(ch.move));
      return;
    }
    this.clearCharge();
    if (this.ptr.dragging) {
      this.setDragging(false);
      const vel = this.velocity(p.x, p.y);
      const gi = this.dropTarget(p.x, p.y, vel.x, vel.y);
      if (gi >= 0) {
        this.finishReq(r.ghosts[gi].move); // slams only by holding over the slot (no flick slam)
        return;
      }
      r.hover = -1;
      void this.flyHome(this.tiles[id], { dur: 0.25 });
      this.kick();
      return;
    }
    // tap
    if (id >= 0) {
      const moves = r.sides.get(id);
      if (!moves) {
        this.invalid(id);
        return;
      }
      if (r.selected === id) {
        // second tap on the selected tile: if only one placement, play it; otherwise deselect
        if (r.ghosts.length === 1) this.finishReq(r.ghosts[0].move);
        else this.select(-1);
        return;
      }
      this.select(id);
      if (r.ghosts.length === 1) {
        this.finishReq(r.ghosts[0].move);
        return;
      }
      this.sfx('select');
      return;
    }
    // tap on (near) a slot: generous zone of 2.5 tile lengths
    const gi = r.selected >= 0 ? this.dropTarget(p.x, p.y, 0, 0, 2.5) : -1;
    if (gi >= 0 && r.selected >= 0) {
      this.finishReq(r.ghosts[gi].move);
      return;
    }
    if (r.selected >= 0) this.select(-1);
  };

  /** drop any press / drag / slam charge in progress (the next pointerdown starts fresh) */
  private releasePointer(): void {
    this.clearCharge();
    if (this.ptr.dragging && this.ptr.tile >= 0 && this.tiles[this.ptr.tile]) void this.flyHome(this.tiles[this.ptr.tile], { dur: 0.2 });
    this.setDragging(false);
    this.ptr.down = false;
    this.ptr.id = -1;
    this.ptr.tile = -1;
  }

  private onCancel = (e: PointerEvent): void => {
    if (e.pointerId !== this.ptr.id) return;
    this.ptr.down = false;
    this.clearCharge();
    if (this.ptr.dragging && this.ptr.tile >= 0) {
      this.setDragging(false);
      void this.flyHome(this.tiles[this.ptr.tile], { dur: 0.25 });
    }
    this.setDragging(false);
    this.kick();
  };
}

// ───────────────────────── geometry / material helpers ─────────────────────────

function buildTileGeometry(seg: number): THREE.BufferGeometry {
  const g = new RoundedBoxGeometry(TL, TH, TW, seg, 0.075);
  const pos = g.attributes.position;
  const nor = g.attributes.normal;
  const uv = g.attributes.uv;
  const face = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const ny = nor.getY(i);
    const x = pos.getX(i);
    const z = pos.getZ(i);
    if (ny > 0.6) {
      face[i] = 0;
      uv.setXY(i, (x + TL / 2) / TL, 0.5 - z / TW);
    } else if (ny < -0.6) {
      face[i] = 1;
      uv.setXY(i, (x + TL / 2) / TL, 0.5 + z / TW);
    } else {
      face[i] = 2;
      uv.setXY(i, 0.5, 0.5);
    }
  }
  g.setAttribute('aFace', new THREE.BufferAttribute(face, 1));
  return g;
}

function patchTileMaterial(m: THREE.MeshLambertMaterial, uTime: { value: number }): void {
  const cols = tex.ATLAS_COLS.toFixed(1);
  const rows = tex.ATLAS_ROWS.toFixed(1);
  const back = `vec2(${tex.BACK_CELL.col.toFixed(1)}, ${(tex.ATLAS_ROWS - 1 - tex.BACK_CELL.row).toFixed(1)})`;
  const side = `vec2(${tex.SIDE_CELL.col.toFixed(1)}, ${(tex.ATLAS_ROWS - 1 - tex.SIDE_CELL.row).toFixed(1)})`;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = uTime;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aFace;\nattribute vec2 aFx;\nvarying vec2 vFx;\nvarying float vTop;')
      .replace(
        '#include <uv_vertex>',
        `#include <uv_vertex>
  #ifdef USE_INSTANCING
    float tid = float(gl_InstanceID);
  #else
    float tid = 0.0;
  #endif
  vec2 cell;
  if (aFace < 0.5) cell = vec2(mod(tid, ${cols}), ${rows} - 1.0 - floor(tid / ${cols}));
  else if (aFace < 1.5) cell = ${back};
  else cell = ${side};
  vec2 inset = vec2(0.012, 0.024);
  vMapUv = (cell + inset + clamp(uv, 0.0, 1.0) * (1.0 - 2.0 * inset)) / vec2(${cols}, ${rows});
  vFx = aFx;
  vTop = aFace < 0.5 ? 1.0 : 0.0;`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vFx;\nvarying float vTop;\nuniform float uTime;')
      .replace(
        '#include <colorspace_fragment>',
        `// unplayable tiles: ~18% darker + slightly desaturated. Applied AFTER tone mapping so the ACES
  // shoulder cannot swallow it; playable tiles are never brightened (lift + gold outline only).
  float dl = dot(gl_FragColor.rgb, vec3(0.299, 0.587, 0.114));
  gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(dl), vFx.y * 0.3) * (1.0 - 0.32 * vFx.y);
  #include <colorspace_fragment>`,
      );
    // (no emissive boost for playable/landing glow: the gold outline quad behind the tile carries it)
  };
  m.customProgramCacheKey = () => `kudo-tile-v5-${cols}x${rows}`;
}

function roundedRectPath(p: THREE.Path, x: number, y: number, w: number, h: number, r: number): void {
  p.moveTo(x + r, y);
  p.lineTo(x + w - r, y);
  p.quadraticCurveTo(x + w, y, x + w, y + r);
  p.lineTo(x + w, y + h - r);
  p.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  p.lineTo(x + r, y + h);
  p.quadraticCurveTo(x, y + h, x, y + h - r);
  p.lineTo(x, y + r);
  p.quadraticCurveTo(x, y, x + r, y);
}
