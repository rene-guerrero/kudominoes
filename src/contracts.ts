import type { FaceSpec } from 'kuavatars/faces';
/**
 * SHARED CONTRACTS — the single source of truth between the three modules:
 *   src/engine  (pure rules + CPU, no DOM, no three.js)
 *   src/render  (three.js 3D table + animations + tile input)
 *   src/ui      (HTML overlay: menus, settings, HUD, audio, i18n) and src/app (controller)
 *
 * Do NOT change exported shapes here without telling the coordinator; other modules
 * are being built in parallel against this file. Adding optional fields is OK.
 */

// ───────────────────────── Tiles & seats ─────────────────────────

export type Pip = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** Double-six set: 28 tiles. Invariant a <= b. id = stable index 0..27 (ordered 0-0,0-1,…,6-6). */
export interface Tile {
  id: number;
  a: Pip;
  b: Pip;
}

/**
 * Seats. 0 = human (bottom of screen), 1 = right, 2 = partner (top), 3 = left.
 * Turn order is 0→1→2→3 (counter-clockwise on the table, the Cuban way).
 * Teams: team 0 = seats 0 & 2 (human + partner), team 1 = seats 1 & 3.
 */
export type Seat = 0 | 1 | 2 | 3;
export type Team = 0 | 1;
export const teamOf = (s: Seat): Team => (s % 2) as Team;

/**
 * Game modes. 'pairs' (default) = two partnerships (seats 0&2 vs 1&3). 'individual' = every player for
 * themselves, 2–4 players: the human (seat 0) plus 1–3 CPU players seated around the table (SEATS_FOR).
 */
export type GameMode = 'pairs' | 'individual';

/**
 * Seats in use for a number of players (turn order counter-clockwise, as always): 2 players face each
 * other (bottom/top), 3 players sit bottom/right/left (the top is free), 4 players use every seat.
 */
export const SEATS_FOR: Record<2 | 3 | 4, Seat[]> = { 2: [0, 2], 3: [0, 1, 3], 4: [0, 1, 2, 3] };

/** The chain (la mesa) has two open ends, addressed as 'left' and 'right'. */
export type Side = 'left' | 'right';

export type Move =
  /** slam: optional, cosmetic — the tile is slammed on the table (a signal to the partner). Ignored for legality. */
  | { kind: 'play'; seat: Seat; tileId: number; side: Side; slam?: boolean }
  | { kind: 'pass'; seat: Seat }
  /** individual mode with a boneyard ("pozo"): no tile fits, take one from the boneyard (the turn stays) */
  | { kind: 'draw'; seat: Seat };

/** A tile as it sits on the table. `outer` is the pip value facing the open end on its side. */
export interface PlacedTile {
  tile: Tile;
  seat: Seat;
  side: Side; // side it was attached to (first tile: 'right')
  outer: Pip; // for the first tile, outer = b and the left end = a
}

// ───────────────────────── Settings (data-driven) ─────────────────────────

/**
 * Rule/variant settings are a flat record. The ENGINE owns the list of rule settings and
 * exports `RULE_SETTINGS: SettingDescriptor[]` + `DEFAULT_RULES: RuleSettings` from src/engine/index.ts.
 * The UI renders the settings screen generically from descriptors, so new variants need no UI work.
 */
export type SettingValue = string | number | boolean;
export type RuleSettings = Record<string, SettingValue>;

export interface SettingDescriptor {
  key: string;
  /** grouping header in the settings screen, e.g. 'salida', 'puntuacion', 'tranque', 'bonos' */
  group: string;
  type: 'toggle' | 'select';
  /** for 'select'. `short` is an optional compact label for one-line group summaries. */
  options?: { value: SettingValue; label: { es: string; en: string }; short?: { es: string; en: string } }[];
  default: SettingValue;
  label: { es: string; en: string };
  /** short name for one-line group summaries (falls back to label) */
  short?: { es: string; en: string };
  /** one-line explanation of the variant shown under the control */
  help?: { es: string; en: string };
  /**
   * optional: numeric option values are on the tens scale. When rules[scale.key] === scale.when, the
   * value actually used (and shown) is value × scale.factor. Option labels may contain `{n}`, which the
   * UI replaces with the shown value.
   */
  scale?: { key: string; when: SettingValue; factor: number };
  /** optional per-mode wording for a descriptor shared by both modes (e.g. "the pair" → "the player") */
  byMode?: Partial<Record<GameMode, { label?: { es: string; en: string }; help?: { es: string; en: string } }>>;
}

/** A named rule set (e.g. "Cubano clásico"). */
export interface RulePreset {
  id: string;
  /** the mode this preset is for (missing = 'pairs') */
  mode?: GameMode;
  label: { es: string; en: string };
  rules: RuleSettings;
}

export type Difficulty = 'easy' | 'normal' | 'hard' | 'master';

/**
 * Playing styles: light behaviour biases on top of a CPU level (they never change what information a
 * level uses). 'perfect' = no bias (the master level).
 */
export type PlayStyle =
  | 'carefree'
  | 'impulsive'
  | 'beginner'
  | 'balanced'
  | 'byTheBook'
  | 'blocker'
  | 'aggressive'
  | 'calculator'
  | 'teamPlayer'
  | 'perfect';

/** what a CPU seat plays like: its level plus an optional style */
export interface CpuProfile {
  level: Difficulty;
  style?: PlayStyle;
}

// ───────────────────────── Game state ─────────────────────────

export interface HandState {
  handNo: number; // 1-based
  hands: Tile[][]; // index by Seat
  chain: PlacedTile[]; // in play order
  ends: { left: Pip; right: Pip } | null; // null before first tile
  turn: Seat;
  starter: Seat;
  passesInRow: number;
  /** per seat: pip values the seat is known to have passed on (public info, used by CPU) */
  passedOn: Pip[][];
  over: boolean;
  /**
   * optional: set right after the deal when the team that won the previous hand chooses which of its two
   * players opens (nextStarter 'winnerTeam'). While set, `turn`/`starter` are provisional, legalMoves()
   * returns [] and the controller must call EngineApi.chooseStarter(match, seat).
   */
  pendingStarterChoice?: Team | null;
  /**
   * optional (individual mode, 2–3 players): the undealt tiles ("pozo"), drawn from the END. Hidden
   * information: only the engine and the renderer (to show a face-down pile) may look at it. With the
   * boneyard rule off the tiles are simply set aside. Missing = no boneyard.
   */
  boneyard?: Tile[];
  /** optional (individual mode): the tile that must open this hand (first hand: 6-6, else highest double / tile) */
  openTile?: number | null;
}

export interface MatchState {
  rules: RuleSettings;
  scores: [number, number]; // by Team
  handsWon: [number, number];
  hand: HandState | null;
  lastHandWinner: Seat | null;
  over: boolean;
  winner: Team | null;
  /** opaque RNG state so matches are reproducible from a seed */
  rng: number;
  /**
   * optional: points held "abajo" (rule 'abajo'): a shared pot fed by small wins of a team on 0 and
   * claimed by the next hand that scores normally. Missing (old saves) = 0.
   */
  abajo?: number;
  /** optional: game mode (missing = 'pairs', old saves) */
  mode?: GameMode;
  /** optional: seats in play, in turn order (missing = all four) */
  seats?: Seat[];
  /** optional (individual): scores by Seat (inactive seats stay 0). `scores` stays [0, 0] then. */
  seatScores?: number[];
  /** optional (individual): hands won by Seat */
  seatHandsWon?: number[];
  /** optional (individual): the seat that won the match */
  winnerSeat?: Seat | null;
}

export interface Bonus {
  /** machine id e.g. 'capicua', 'pase-salida', 'pollona' */
  id: string;
  label: { es: string; en: string };
  points: number;
  team: Team;
  /** optional: 'double' = this bonus repeats the hand's points (capicúa ×2) */
  kind?: 'double';
  /** optional: these points went to the abajo pot instead of the team's score */
  abajo?: boolean;
  /**
   * optional (individual mode): the player credited. `team` is then human-centric (0 = the human,
   * 1 = anyone else) so team-based code keeps working; use `seat`.
   */
  seat?: Seat;
}

/** Events are what the renderer/UI animate. The engine returns them in order from every transition. */
export type GameEvent =
  | {
      type: 'handStart';
      handNo: number;
      hands: Tile[][];
      starter: Seat;
      scores: [number, number];
      /** optional: seats in play (missing = all four) */
      seats?: Seat[];
      /** optional (individual, 2–3 players): the boneyard, drawn from the end (renderer: face-down pile) */
      boneyard?: Tile[];
      /** optional (individual): scores by Seat */
      seatScores?: number[];
    }
  | {
      type: 'play';
      seat: Seat;
      tile: Tile;
      side: Side;
      placed: PlacedTile;
      ends: { left: Pip; right: Pip };
      tilesLeft: number; // tiles left in that seat's hand after the play
      isFirst: boolean;
      /** optional: this play wins the hand (domino). Set by the controller from the following handEnd. */
      finishing?: boolean;
      /** optional: the player slammed this tile on the table (passed through from the Move) */
      slam?: boolean;
    }
  | {
      type: 'pass';
      seat: Seat;
      ends: { left: Pip; right: Pip };
      /** optional: a bonus credited right now (pase de salida); already included in `scores` */
      bonus?: Bonus;
      /** optional: a bonus that was earned but not added (the opening pass cannot win the match) */
      bonusBlocked?: Bonus;
      /** optional: scores after this pass (present when a bonus was credited) */
      scores?: [number, number];
      /** optional: the opening-pass bonus of a team on 0, held abajo (added to the pot, not to `scores`) */
      bonusAbajo?: Bonus;
      /** optional: points the bonus took from the abajo pot (only if PASS_BONUS_CLAIMS_ABAJO) */
      abajoClaimed?: number;
      /** optional: the abajo pot after this pass (present when it changed) */
      abajoPot?: number;
      /** optional (individual): seat scores after this pass (present when a bonus was credited) */
      seatScores?: number[];
    }
  | {
      /** individual mode: `seat` takes `tile` from the boneyard. Only seat 0's tile may be shown face up. */
      type: 'draw';
      seat: Seat;
      tile: Tile;
      /** tiles left in the boneyard after this draw */
      boneyardLeft: number;
      ends: { left: Pip; right: Pip };
      /** optional: the opening-pass bonus credited now (the player after the opener could not play the first tile) */
      bonus?: Bonus;
      bonusBlocked?: Bonus;
      seatScores?: number[];
    }
  | {
      type: 'handEnd';
      reason: 'domino' | 'blocked'; // domino = someone ran out (se pegó); blocked = tranque
      winnerSeat: Seat | null; // null when the hand is void (e.g. tied tranque)
      winnerTeam: Team | null;
      points: number; // base points awarded to winnerTeam (bonuses listed separately)
      bonuses: Bonus[];
      pipCounts: [number, number, number, number]; // remaining pips per seat
      remaining: Tile[][]; // remaining hands per seat (to reveal)
      scores: [number, number]; // after this hand
      /** optional: raw pips counted for the winner before rounding (points = rounded value) */
      rawPips?: number;
      /** optional: rounding mode used ('up' | 'nearest' | 'down' | 'none') */
      rounding?: string;
      /** optional: bonuses credited earlier in this hand (already in the scores before this event) */
      earlyBonuses?: Bonus[];
      /**
       * optional (rule 'abajo'): the winning team was on 0 and the hand was small, so its points
       * (`points` + its bonuses, all flagged `abajo`) went to the pot. Value = points added to the pot.
       */
      abajoAdded?: number;
      /** optional (rule 'abajo'): the winning team scored normally and also took this many points from the pot */
      abajoClaimed?: number;
      /** optional (rule 'abajo'): the pot after this hand (present whenever the rule is on) */
      abajoPot?: number;
      /**
       * optional (individual): scores by Seat after this hand. `winnerTeam` is then human-centric
       * (0 = the human won, 1 = someone else, null = void) and `scores` stays [0, 0].
       */
      seatScores?: number[];
      /** optional (individual): seats that took part */
      seats?: Seat[];
    }
  | {
      type: 'matchEnd';
      /** individual: human-centric (0 = the human won) — use winnerSeat */
      winner: Team;
      scores: [number, number];
      bonuses: Bonus[];
      /** optional (individual) */
      winnerSeat?: Seat;
      seatScores?: number[];
    };

/** Public engine API — exported from src/engine/index.ts. All functions are PURE (return new state). */
export interface EngineApi {
  RULE_SETTINGS: SettingDescriptor[];
  DEFAULT_RULES: RuleSettings;
  ALL_TILES: Tile[];
  /** `setup` (optional): individual mode with 2–4 players; missing = pairs */
  createMatch(rules: RuleSettings, seed?: number, setup?: MatchSetup): MatchState;
  /** Deals and starts the next hand. Call when match.hand is null or match.hand.over. */
  startHand(match: MatchState): { match: MatchState; events: GameEvent[] };
  /** Legal moves for the seat to move. If no tile fits, returns exactly one pass move. */
  legalMoves(match: MatchState): Move[];
  /** Applies a legal move; emits play/pass and, when applicable, handEnd and matchEnd. */
  applyMove(match: MatchState, move: Move): { match: MatchState; events: GameEvent[] };
  /** CPU decision for the seat to move. Must only use information that seat legitimately has. */
  chooseMove(match: MatchState, difficulty: Difficulty, style?: PlayStyle): Move;
  /** optional: the effective match target in points for these rules (already scaled) */
  matchTarget?(rules: RuleSettings): number;
  /** optional: named rule sets; the first one is the classic default */
  RULE_PRESETS?: RulePreset[];
  /** optional (required when hands can have pendingStarterChoice): the chosen seat of the choosing team opens */
  chooseStarter?(match: MatchState, seat: Seat): MatchState;
  /** optional: does this seat want to open, judging ONLY its own tiles? (what a player would say aloud) */
  starterPreference?(match: MatchState, seat: Seat): boolean;
  /** optional: a CPU team's decision, based only on each player's spoken preference */
  cpuStarter?(match: MatchState): Seat;
  /** optional: the rule descriptors of individual mode (shared rules reuse the pairs descriptors) */
  RULE_SETTINGS_INDIVIDUAL?: SettingDescriptor[];
  /** optional: default rules of individual mode */
  DEFAULT_RULES_INDIVIDUAL?: RuleSettings;
}

export interface MatchSetup {
  mode: GameMode;
  /** individual: 2, 3 or 4 players (pairs: always 4) */
  players?: 2 | 3 | 4;
}

/** The characters in the CPU seats (roster ids): 1 = right rival, 2 = partner, 3 = left rival. */
export type Lineup = { 1: string; 2: string; 3: string };

// ───────────────────────── Renderer ─────────────────────────

export type SfxName =
  | 'shuffle'
  | 'deal'
  | 'clack' // tile hits the table
  | 'slam' // emphatic play (winning tile / capicúa)
  | 'pass' // knock on the table
  | 'select'
  | 'invalid'
  | 'winHand'
  | 'loseHand'
  | 'winMatch'
  | 'loseMatch'
  | 'tranque'
  | 'charge'; // a slam is armed (press-and-hold): tiny tick + light vibration

export type Quality = 'low' | 'medium' | 'high';

/** tile look: 'classic' = ivory faces + black pips; 'dark' = charcoal faces + ivory pips (the 1 stays red) */
export type TileTheme = 'classic' | 'dark';

export interface TableViewOptions {
  container: HTMLElement; // renderer creates and owns its <canvas> inside
  quality: Quality;
  onSfx?: (name: SfxName) => void;
  /** names shown above each seat, index by Seat */
  playerNames: [string, string, string, string];
  reducedMotion?: boolean;
  /** language for the 3D popups / pass button (default 'es') */
  language?: 'es' | 'en';
  /** animation speed multiplier (1 = normal, >1 = faster) */
  speed?: number;
  /** tile look (default 'classic') */
  tileTheme?: TileTheme;
  /**
   * optional: HTML name plates. When set, the view stops drawing its own 3D plates, lays the plate
   * boxes out itself (keeping the chain clear of them) and reports them here whenever anything
   * about them changes (position, bounce, turn, tile count…). The array and its objects are reused.
   */
  onPlates?: (plates: readonly SeatPlate[], center: { x: number; y: number }) => void;
  /** optional: a tile landed on the table ('clack'), was slammed ('slam') or won the hand ('finish') */
  onImpact?: (seat: Seat, kind: 'clack' | 'slam' | 'finish') => void;
  /** optional: the human started (true) / stopped (false) dragging a tile — the UI fades its plate */
  onDrag?: (dragging: boolean) => void;
  /** table look (default 'green') */
  tableStyle?: TableStyle;
  /** tile-back look (default 'ornate') */
  tileBack?: TileBack;
  /**
   * optional performance telemetry: called about once per second WHILE the view is actively
   * animating (never while idle/render-on-demand is asleep) with the average frame time in ms
   * over the frames rendered in that window and how many frames that was.
   */
  onFrameStats?: (stats: FrameStats) => void;
  /** optional: the render loop keeps failing (frames throw); the app shows its error screen */
  onError?: (err: unknown) => void;
}

/** Frame timing sample reported by the renderer (see TableViewOptions.onFrameStats). */
export interface FrameStats {
  avgFrameMs: number;
  frames: number;
  /** quality level that was active while sampling */
  quality: Quality;
}

/** Table looks: felt + wood frame + emblem tint + ambient. */
export type TableStyle = 'green' | 'navy' | 'burgundy' | 'charcoal' | 'wood' | 'sand';
export const TABLE_STYLES: TableStyle[] = ['green', 'navy', 'burgundy', 'charcoal', 'wood', 'sand'];
/** Tile-back looks. */
export type TileBack = 'ornate' | 'ivory' | 'red' | 'navy' | 'green' | 'wood';
export const TILE_BACKS: TileBack[] = ['ornate', 'ivory', 'red', 'navy', 'green', 'wood'];

/** Everything needed to put a saved hand back on the table in one frame (TableView.restore). */
export interface RestoreState {
  hand: HandState;
  scores: [number, number];
  /** optional: seats in play (missing = all four) */
  seats?: Seat[];
  /** true when the saved hand is already over (summary pending / between hands) */
  handOver?: boolean;
}

/** One HTML name plate box, in CSS px relative to the view container (y down). */
export interface SeatPlate {
  /** box centre */
  x: number;
  y: number;
  w: number;
  h: number;
  /** avatar diameter */
  d: number;
  /** 'row' = avatar left, name + count right; 'stack' = avatar on top, name below */
  layout: 'row' | 'stack';
  /**
   * optional (portrait side seats): the stack plate hugs this screen edge, so its count badge sits on
   * the avatar's outer top corner and its speech bubble is the compact edge bubble (rising over the
   * seat's stack)
   */
  edge?: 'left' | 'right';
  scale: number;
  /** radians, clockwise */
  rot: number;
  visible: boolean;
  active: boolean;
  winner: boolean;
  count: number;
  pips: number | null;
  /**
   * optional: where a speech bubble attaches (6 px off the plate on its table-centre side). For 'left'
   * the bubble's right edge is at x (centred on y); 'right': left edge at x; 'up': centred on x, bottom
   * at y; 'down': centred on x, top at y (all clamped inside the view). The chain keeps clear of a
   * 120x44 bubble there (76x34 for an edge plate's compact bubble).
   */
  bubble?: { x: number; y: number; dir: 'left' | 'right' | 'up' | 'down' };
}

/** Public renderer API — `createTableView(opts): TableView` exported from src/render/index.ts. */
export interface TableView {
  /** Animate an engine event; resolves when the animation finished and the next event may start. */
  handle(event: GameEvent): Promise<void>;
  /**
   * Let the human (seat 0) pick one of the legal moves: tap/drag a tile, and if it fits both ends,
   * choose the end. Resolves with the chosen move. If `legal` is a single pass, the view shows the
   * pass affordance and resolves once acknowledged (or auto after a short delay).
   */
  requestHumanMove(legal: Move[]): Promise<Move>;
  /** Highlight whose turn it is (glow on seat / name plate). */
  setTurn(seat: Seat | null): void;
  /** Clear the table (between matches / back to menu). Idle attract-mode animation is welcome. */
  reset(): void;
  setQuality(q: Quality): void;
  setPaused(paused: boolean): void;
  dispose(): void;
  /** optional: animation speed multiplier (1 = normal, >1 = faster) */
  setSpeed?(x: number): void;
  /** optional: live reduced-motion toggle */
  setReducedMotion?(r: boolean): void;
  /** optional: language of in-scene text */
  setLanguage?(lang: 'es' | 'en'): void;
  /** optional: switch the tile look live (regenerates the atlas, keeps the view) */
  setTileTheme?(theme: TileTheme): void;
  /** optional: rename the seat name plates */
  setPlayerNames?(names: [string, string, string, string]): void;
  /** optional: switch the table look live (no view recreation, old textures disposed) */
  setTableStyle?(style: TableStyle): void;
  /** optional: switch the tile-back look live */
  setTileBack?(back: TileBack): void;
  /**
   * optional: put a saved hand on the table instantly — chain laid out normally, every seat's remaining
   * tiles in hand (human face-up sorted, CPUs face-down), plates/counts final; no sounds, no event
   * animations (a short scene fade-in is fine). After it resolves, play continues with handle()/requestHumanMove().
   */
  restore?(state: RestoreState): Promise<void>;
  /**
   * optional (online play): the human's turn ended elsewhere (timer ran out, resync) — drop a pending
   * requestHumanMove (its promise never resolves; the caller stops waiting on it).
   */
  cancelHumanMove?(): void;
}

// ───────────────────────── App settings (non-rule) ─────────────────────────

export interface AppSettings {
  language: 'es' | 'en';
  /** the EFFECTIVE graphics level the renderer uses (in auto mode = autoQuality) */
  quality: Quality;
  /** 'auto' (default; missing = auto) picks and adapts the level per device; 'manual' keeps `quality` as chosen */
  qualityMode?: 'auto' | 'manual';
  /** auto mode's current decision (device detection, lowered at runtime when frames are slow); missing = not decided yet */
  autoQuality?: Quality;
  sound: boolean;
  music: boolean;
  vibration: boolean;
  animationSpeed: 'normal' | 'fast';
  playerName: string;
  rules: RuleSettings;
  /** tile look; missing = default ('dark' for now) */
  tileTheme?: TileTheme;
  /** calmer animations (no camera shake, no air show). Explicit opt-in; default false. */
  reducedMotion?: boolean;
  /** animated faces on the name plates; missing = on */
  avatars?: boolean;
  /** the human's face, 0..6 (0 = plain); missing = 0 */
  /** the player's own face (a FaceSpec from the avatar editor; older saves stored a stock-face index) */
  avatarFace?: number | FaceSpec;
  /** the characters chosen for new matches (roster ids); missing = default lineup */
  lineup?: Lineup;
  /** version of the stored rule schema (2 = tens-scale Cuban scoring) */
  rulesVersion?: number;
  /** last open settings tab */
  settingsTab?: 'game' | 'rules' | 'av';
  /** table look; missing = 'green' */
  tableStyle?: TableStyle;
  /** tile-back look; missing = 'ornate' */
  tileBack?: TileBack;
  /** the mode of the last new game (missing = 'pairs') */
  mode?: GameMode;
  /** individual-mode rules (missing = the individual defaults) */
  rulesIndividual?: RuleSettings;
  /** individual mode: how many CPU opponents (1–3; missing = 2) */
  soloOpponents?: 1 | 2 | 3;
  /** individual mode: the last chosen opponents in order (roster ids; up to 3) */
  soloLineup?: string[];
  /** last mode shown in Ajustes → Reglas */
  rulesTabMode?: GameMode;
}
