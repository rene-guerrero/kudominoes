/**
 * Online play controller (lazy-loaded from App). It plays the role of the local GameSession, but driven
 * by the room server: 'events' are animated in order through one queue (never overlapping), 'turn'
 * lights the seat to move with a quiet timer ring and, on my turn, asks the view for a move; a
 * welcome/sync puts the table back instantly through the view's restore path (no replay).
 *
 * Seats and teams are rotated into the local perspective (src/net/perspective.ts) so the HUD, plates,
 * summaries and the renderer work exactly as in a local match ("seat 0 = me").
 */
import type { AppSettings, EngineApi, GameEvent, GameMode, MatchState, Move, RuleSettings, Seat, TableView } from '../contracts';
import type { Overlay } from '../ui/overlay';
import type { Hud } from '../ui/hud';
import type { SeatPlates } from '../ui/plates';
import type { AvatarController, AvatarExpr } from '../ui/avatars';
import type { FaceSpec } from '../roster';
import type { SessionHooks } from './controller';
import { character, ROSTER } from '../roster';
import { HUMAN_FACES, sanitizeFace } from 'kuavatars/faces';
import { RoomClient, httpBackend, NetError, type Backend, type ConnState } from '../net/client';
import { useMockServer, shareLink } from '../net/config';
import { displayCode, normalizeCode, playerId, rememberRoom, cleanName } from '../net/identity';
import { Perspective } from '../net/perspective';
import { applyEvent, emptyMatch } from '../net/mirror';
import { withPlaceholders } from '../net/redact';
import { CHAT_GESTURES, TURN_TIMEOUT_MS, type ChatGesture, type ErrorCode, type PublicRoom, type QuickPhraseId, type SeatView, type ServerMsg } from '../net/protocol';
import { activeSeatsOf, buildLobby, buildOnlineHome, buildOnlinePause, buildRulesSheet, buildSeatSheet, occupantName, phraseText, type Lobby, type OnlineHome } from '../ui/online';
import type { ChatButton } from '../ui/chat';
import { buildHandSummary, buildMatchEnd, buildStarterChooser } from '../ui/summary';
import { confirmDialog } from '../ui/overlay';
import { h } from '../ui/dom';
import { t } from '../ui/i18n';
import { hapticTick } from '../audio/sfx';
import { findTarget, rulesFor } from './settings';
import { presetName } from '../ui/settings';
import { allPresets, loadProfiles } from './ruleProfiles';
import { sameRules } from '../engine/rules';

type Names = [string, string, string, string];
type HandEnd = Extract<GameEvent, { type: 'handEnd' }>;
type MatchEnd = Extract<GameEvent, { type: 'matchEnd' }>;

export interface OnlineMatchSetup {
  names: Names;
  /** faces of local seats 1..3 (index 0 unused: the player's own face from the settings) */
  faces: FaceSpec[];
  mode: GameMode;
  seats: Seat[];
  match: MatchState;
}

/** what the online controller needs from App */
export interface OnlineHost {
  engine: EngineApi;
  overlay: Overlay;
  hud: Hud;
  plates: SeatPlates;
  avatars: AvatarController;
  view(): TableView;
  settings(): AppSettings;
  setSetting<K extends keyof AppSettings>(key: K, v: AppSettings[K]): void;
  hooks(): SessionHooks;
  /** HUD, plates, faces and table for a new (or restored) online match */
  beginMatch(o: OnlineMatchSetup): void;
  /** live update of names / faces (someone joined, left, a CPU took over) */
  setPlayers(names: Names, faces: FaceSpec[]): void;
  setSfxMuted(m: boolean): void;
  /** the in-game chat button (shared with offline games) */
  chat: ChatButton;
  /** where the chat button's picks go (null: back to offline, own avatar only) */
  setChatSender(send: ((id: string) => void) | null): void;
  /** back to the main menu (clears the table) */
  exit(): void;
}

class Stale extends Error {}

const errorText = (code: ErrorCode | NetError['code'] | 'lost'): string =>
  code === 'room_not_found'
    ? t('online.err.notFound')
    : code === 'room_full'
      ? t('online.err.full')
      : code === 'version_mismatch'
        ? t('online.err.version')
        : code === 'offline'
          ? t('online.err.offline')
          : code === 'lost'
            ? t('online.err.lost')
            : t('online.err.server');

const PHRASE_FACE: Partial<Record<QuickPhraseId, AvatarExpr>> = { hello: 'happy', nice: 'amazed', oops: 'meh', thinking: 'thinking', gg: 'happy', thanks: 'happy', wow: 'amazed', hurry: 'smug' };

export class OnlineController {
  private backend: Backend;
  private client: RoomClient | null = null;
  private pid = playerId();
  private mode: 'home' | 'lobby' | 'game' | 'off' = 'off';
  private home: OnlineHome | null = null;
  private lobby: Lobby | null = null;
  private room: PublicRoom | null = null;
  private mySeat: Seat | null = null;
  private isHost = false;
  private joinWait: { resolve: () => void; reject: (e: string) => void } | null = null;
  // ── game ──
  private persp: Perspective | null = null;
  private mirror: MatchState | null = null;
  private queue: (() => Promise<void>)[] = [];
  private pumping = false;
  private gen = 0;
  private staleRej: (e: Error) => void = () => {};
  private stale: Promise<never> = this.newStale();
  private interruptRes: (() => void) | null = null;
  private lastDrawSeat: Seat | null = null;
  private turnSeat: Seat | null = null;
  private closeSummary: (() => void) | null = null;
  private closeMatchEnd: (() => void) | null = null;
  private closeMenu: (() => void) | null = null;
  private closeSheet: (() => void) | null = null;
  private closeChooser: (() => void) | null = null;
  /** the opener choice of this hand was answered here (pick or wish): later repeats of it are stale */
  private starterAnswered = false;
  private netChip: HTMLElement | null = null;
  private hiddenAt = 0;
  private lastRules = '';

  constructor(private host: OnlineHost) {
    this.backend = useMockServer() ? null! : httpBackend();
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('online', this.onOnline);
    if (import.meta.env.DEV) (window as unknown as { __kudoNet: unknown }).__kudoNet = { ctl: this, drop: () => this.client?.resync() };
  }

  /** the mock backend is loaded lazily (dev only) */
  private async ensureBackend(): Promise<Backend> {
    // (dev only: the branch is dead code in production builds, so the mock never ships)
    if (import.meta.env.DEV && !this.backend) this.backend = (await import('../net/mock/backend')).mockBackend();
    this.backend ??= httpBackend();
    return this.backend;
  }

  get active(): boolean {
    return this.mode !== 'off';
  }

  // ───────────────────────── screens ─────────────────────────

  /** open the "Jugar en línea" screen; with a code (share link / reload) join it right away */
  open(code?: string, quiet = false): void {
    this.mode = 'home';
    const s = this.host.settings();
    const home = buildOnlineHome({
      name: s.playerName,
      face: s.avatarFace ?? 0,
      avatars: s.avatars !== false,
      code,
      onName: (n) => this.host.setSetting('playerName', cleanName(n)),
      onCreate: () => void this.create(),
      onJoin: (c) => void this.join(c),
      onBack: () => this.exit(),
    });
    this.home = home;
    this.host.overlay.showScreen(home.el);
    if (!s.playerName) home.askName();
    if (code && s.playerName) void this.join(code, quiet);
    else if (code) home.setError(t('online.nameNeeded'));
  }

  private async create(): Promise<void> {
    const home = this.home;
    home?.setBusy('create');
    home?.setError(null);
    try {
      const be = await this.ensureBackend();
      const code = await be.createRoom(this.pid);
      await this.connect(code);
    } catch (e) {
      if (this.home !== home) return;
      home?.setBusy(null);
      home?.setError(errorText(e instanceof NetError ? e.code : typeof e === 'string' ? (e as ErrorCode) : 'server'));
    }
  }

  /** quiet: a rejoin after a reload — a room that is gone just goes back to the menu */
  private async join(raw: string, quiet = false): Promise<void> {
    const code = normalizeCode(raw);
    const home = this.home;
    if (!code) return home?.setError(t('online.err.notFound'));
    home?.setBusy('join');
    home?.setError(null);
    try {
      const be = await this.ensureBackend();
      const info = await be.roomInfo(code);
      if (!info.exists) throw new NetError('room_not_found');
      await this.connect(code);
    } catch (e) {
      if (this.home !== home) return;
      rememberRoom(null);
      if (quiet) return this.exit();
      home?.setBusy(null);
      home?.setError(errorText(e instanceof NetError ? e.code : typeof e === 'string' ? (e as ErrorCode) : 'server'));
    }
  }

  /** open the socket and wait for the welcome (or a fatal error) */
  private connect(code: string): Promise<void> {
    this.client?.stop();
    const client: RoomClient = new RoomClient({
      backend: this.backend,
      code,
      identity: () => {
        const s = this.host.settings();
        return { playerId: this.pid, name: s.playerName || t('seat.player'), face: s.avatarFace ?? 0 };
      },
      onMessage: (m) => this.client === client && this.onMessage(m),
      onState: (st) => this.client === client && this.onConnState(st),
      onFatal: (c) => this.client === client && this.onFatal(c),
    });
    this.client = client;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.joinWait) {
          this.joinWait = null;
          client.stop();
          reject('offline');
        }
      }, 12_000);
      this.joinWait = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      client.start();
    });
  }

  private onFatal(code: ErrorCode): void {
    if (this.joinWait) {
      const w = this.joinWait;
      this.joinWait = null;
      return w.reject(code);
    }
    // thrown out of a room we were in: back to the online screen with the reason
    const c = this.room?.code;
    this.teardownRoom();
    rememberRoom(null);
    this.host.exit();
    this.open();
    this.home?.setError(errorText(code));
    void c;
  }

  private onConnState(st: ConnState): void {
    const down = st === 'reconnecting' || st === 'connecting';
    const text = down ? t('online.reconnecting') : '';
    this.lobby?.setConn(st === 'reconnecting' ? text : '');
    if (this.netChip) {
      this.netChip.textContent = text;
      this.netChip.classList.toggle('on', st === 'reconnecting');
    }
  }

  private showLobby(): void {
    if (!this.room) return;
    if (this.mode === 'game') this.leaveGameUi();
    this.mode = 'lobby';
    this.home = null;
    if (!this.lobby || !this.lobby.el.isConnected) {
      const s = this.host.settings();
      this.lobby = buildLobby({
        code: this.room.code,
        avatars: s.avatars !== false,
        tableStyle: s.tableStyle ?? 'green',
        myId: this.pid,
        presetName: (mode, rules) => presetName(allPresets(this.host.engine), rules, mode),
        onShare: () => void this.share(),
        onSeat: (seat) => this.tapSeat(seat),
        onMode: (mode, count) => {
          this.client?.send({ t: 'setMode', mode, playerCount: count });
          if (mode !== this.room?.mode) this.client?.send({ t: 'setRules', rules: { ...rulesFor(this.host.settings(), mode) } });
        },
        onRules: () => this.openRules(),
        onStart: () => this.client?.send({ t: 'start' }),
        onLeave: () => void this.confirmLeave(),
      });
      this.host.overlay.showScreen(this.lobby.el);
    }
    this.lobby.update(this.room, { seat: this.mySeat, isHost: this.isHost });
  }

  private tapSeat(seat: Seat): void {
    const room = this.room;
    if (!room || room.phase === 'playing') return;
    const occ = room.seats[seat];
    if (!occ || occ.kind === 'human') return;
    if (!this.isHost) {
      this.client?.send({ t: 'sit', seat });
      return;
    }
    const taken = room.seats.flatMap((o, s) => (o.kind === 'cpu' && s !== seat ? [o.characterId] : []));
    const done = () => {
      this.closeSheet?.();
      this.closeSheet = null;
    };
    const card = buildSeatSheet({
      current: occ.kind === 'cpu' ? occ.characterId : null,
      taken,
      canSit: this.mySeat !== seat,
      avatars: this.host.settings().avatars !== false,
      onSit: () => {
        this.client?.send({ t: 'sit', seat });
        done();
      },
      onPick: (id) => {
        this.client?.send({ t: 'setCpu', seat, characterId: id });
        done();
      },
      onClear: () => {
        this.client?.send({ t: 'setCpu', seat, characterId: null });
        done();
      },
      onClose: done,
    });
    this.closeSheet?.();
    this.closeSheet = this.host.overlay.openModal(card);
  }

  private openRules(): void {
    const room = this.room;
    if (!room || !this.isHost) return;
    const preset = (this.host.engine.RULE_PRESETS ?? []).find((p) => (p.mode ?? 'pairs') === room.mode);
    const mine = rulesFor(this.host.settings(), room.mode);
    const opts: { label: string; rules: RuleSettings }[] = [];
    if (preset) opts.push({ label: presetName([preset], preset.rules, room.mode), rules: preset.rules });
    // the host's saved profiles of this mode, then their current rules (when not already listed)
    for (const p of loadProfiles(this.host.engine)) {
      if (p.mode !== room.mode || opts.some((x) => sameRules(x.rules, p.rules, room.mode))) continue;
      opts.push({ label: p.name, rules: p.rules });
    }
    if (!opts.some((x) => sameRules(x.rules, mine, room.mode))) opts.push({ label: `${t('lobby.myRules')} · ${presetName(allPresets(this.host.engine), mine, room.mode)}`, rules: mine });
    const done = () => {
      this.closeSheet?.();
      this.closeSheet = null;
    };
    const card = buildRulesSheet({
      options: opts.map((o) => ({
        label: o.label,
        selected: sameRules(o.rules, room.rules, room.mode),
        onPick: () => {
          this.client?.send({ t: 'setRules', rules: { ...o.rules } });
          done();
        },
      })),
      onClose: done,
    });
    this.closeSheet?.();
    this.closeSheet = this.host.overlay.openModal(card);
  }

  private async share(): Promise<void> {
    const code = this.room?.code;
    if (!code) return;
    const url = shareLink(code);
    const data = { title: t('lobby.shareTitle'), text: t('lobby.shareText', { code: displayCode(code) }), url };
    const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void>; canShare?: (d: ShareData) => boolean };
    if (nav.share && (!nav.canShare || nav.canShare(data))) {
      try {
        await nav.share(data);
        return;
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(`${data.text}\n${url}`);
    } catch {
      // very old WebViews: a hidden textarea
      const ta = h('textarea', { style: 'position:fixed;opacity:0' }) as HTMLTextAreaElement;
      ta.value = url;
      document.body.append(ta);
      ta.select();
      document.execCommand?.('copy');
      ta.remove();
    }
    this.lobby?.flashCopied();
  }

  private async confirmLeave(): Promise<void> {
    const ok = await confirmDialog(this.host.overlay, {
      title: t('lobby.leaveTitle'),
      body: this.mode === 'game' && !this.mirror?.over ? t('lobby.leaveBodyGame') : t('lobby.leaveBody'),
      ok: t('lobby.leaveOk'),
      cancel: t('common.cancel'),
      danger: true,
    });
    if (ok) this.leave();
  }

  /** leave the room for good and go back to the main menu */
  leave(): void {
    this.client?.leave();
    rememberRoom(null);
    this.teardownRoom();
    this.exit();
  }

  private exit(): void {
    this.teardownRoom();
    this.mode = 'off';
    this.host.exit();
  }

  private teardownRoom(): void {
    this.client?.stop();
    this.client = null;
    if (this.mode === 'game') this.leaveGameUi();
    this.closeSheet?.();
    this.closeSheet = null;
    this.room = null;
    this.lobby = null;
    this.home = null;
    this.mySeat = null;
    this.isHost = false;
    // the share link has done its job
    if (/[?&]sala=/.test(location.search)) {
      const u = new URL(location.href);
      u.searchParams.delete('sala');
      history.replaceState(history.state, '', u.toString());
    }
  }

  /** Escape / Android back */
  back(): void {
    if (this.closeSheet) {
      this.closeSheet();
      this.closeSheet = null;
      return;
    }
    if (this.mode === 'home') return this.exit();
    if (this.mode === 'lobby') return void this.confirmLeave();
    if (this.mode === 'game') {
      if (this.host.chat.isOpen) return this.host.chat.toggle(false);
      if (this.closeMenu) return this.resumeFromMenu();
      if (!this.host.overlay.modalOpen || this.closeSummary || this.closeMatchEnd) this.openMenu();
    }
  }

  // ───────────────────────── messages ─────────────────────────

  private applyRoom(room: PublicRoom): void {
    const prev = this.room;
    this.room = room;
    const seat = room.seats.findIndex((o) => o.kind === 'human' && o.playerId === this.pid);
    this.mySeat = seat >= 0 ? (seat as Seat) : null;
    this.isHost = room.hostId === this.pid;
    if (this.mode === 'game' && prev) this.presenceNotices(prev, room);
    // the host's own rules are the room default (once, when the room is fresh)
    if (this.isHost && room.phase === 'lobby' && !prev) {
      const mine = rulesFor(this.host.settings(), room.mode);
      if (!sameRules(mine, room.rules, room.mode)) this.client?.send({ t: 'setRules', rules: { ...mine } });
    }
  }

  private onMessage(msg: ServerMsg): void {
    switch (msg.t) {
      case 'welcome': {
        this.applyRoom(msg.room);
        rememberRoom(msg.room.code);
        if (this.joinWait) {
          this.joinWait.resolve();
          this.joinWait = null;
        }
        if (msg.view && msg.room.phase === 'playing') void this.restore(msg.room, msg.view);
        else if (this.mode === 'game' && msg.room.phase === 'finished' && this.mirror?.over) this.refreshNames();
        else this.showLobby();
        break;
      }
      case 'room': {
        this.applyRoom(msg.room);
        if (msg.room.phase === 'playing') {
          if (this.mode !== 'game') {
            if (this.mySeat !== null) this.enterGame();
          } else this.refreshNames(); // (a rematch resets the table at its first handStart)
        } else if (this.mode === 'game') {
          // finished: the match-end card stays; anything else returns to the lobby
          if (!this.mirror?.over && msg.room.phase === 'lobby') this.showLobby();
          else this.refreshNames();
        } else this.showLobby();
        break;
      }
      case 'sync':
        this.applyRoom(msg.room);
        void this.restore(msg.room, msg.view);
        break;
      case 'events':
        if (this.mode !== 'game') {
          if (this.mySeat === null || !this.room) return;
          this.enterGame();
        }
        this.enqueueEvents(msg.events);
        break;
      case 'turn':
        if (this.mode !== 'game') return;
        this.enqueueTurn(msg);
        break;
      case 'covered':
        if (this.mode !== 'game') return;
        this.enqueue(async () => this.onCovered(msg.seat, msg.reason));
        break;
      case 'phrase':
        if (this.mode !== 'game' || !this.persp) return;
        this.showPhrase(this.persp.seat(msg.seat), msg.id);
        break;
      case 'starterWish':
        if (this.mode !== 'game' || !this.persp) return;
        this.host.plates.say(this.persp.seat(msg.seat), t(msg.wants ? 'say.wantStart' : 'say.youStart'), false, 2600);
        break;
      case 'error':
        if (msg.code === 'bad_move' || msg.code === 'not_your_turn') this.client?.resync();
        else if (import.meta.env.DEV && msg.code !== 'rate_limited') console.warn('[online] server error', msg.code, msg.message ?? '');
        break;
      case 'pong':
        break;
    }
  }

  private presenceNotices(prev: PublicRoom, room: PublicRoom): void {
    const p = this.persp;
    if (!p) return;
    for (const s of [0, 1, 2, 3] as Seat[]) {
      const a = prev.seats[s];
      const b = room.seats[s];
      if (!a || !b || p.seat(s) === 0) continue;
      if (a.kind === 'human' && b.kind === 'human' && a.playerId === b.playerId) {
        if (!a.cpuCovering && b.cpuCovering) this.host.hud.notice(t('online.covered.disconnected', { name: b.name }));
        else if (!a.connected && b.connected) this.host.hud.notice(t('online.back', { name: b.name }));
      } else if (a.kind === 'human' && b.kind !== 'human') this.host.hud.notice(t('online.left', { name: a.name }));
      else if (b.kind === 'human' && (a.kind !== 'human' || a.playerId !== b.playerId)) this.host.hud.notice(t('online.joined', { name: b.name }));
    }
  }

  // ───────────────────────── game set-up ─────────────────────────

  private playersOf(room: PublicRoom, p: Perspective): { names: Names; faces: FaceSpec[] } {
    const names = ['', '', '', ''] as Names;
    const faces: FaceSpec[] = [HUMAN_FACES[0], HUMAN_FACES[0], HUMAN_FACES[0], HUMAN_FACES[0]];
    for (const l of [0, 1, 2, 3] as Seat[]) {
      const o = room.seats[p.server(l)] ?? { kind: 'empty' as const };
      if (l === 0) {
        names[0] = this.host.settings().playerName || (o.kind === 'human' ? o.name : t('seat.you'));
        continue;
      }
      names[l] = o.kind === 'empty' ? '' : occupantName(o);
      if (o.kind === 'human') faces[l] = sanitizeFace(o.face);
      else if (o.kind === 'cpu') faces[l] = character(o.characterId).face;
      else faces[l] = ROSTER[3].face;
    }
    return { names, faces };
  }

  private refreshNames(): void {
    if (!this.room || !this.persp) return;
    const { names, faces } = this.playersOf(this.room, this.persp);
    this.host.setPlayers(names, faces);
  }

  private newPersp(room: PublicRoom, seat: Seat): Perspective {
    return new Perspective(seat, room.mode, activeSeatsOf(room));
  }

  /** from the lobby to the table (events follow) */
  private enterGame(): void {
    if (!this.room || this.mySeat === null) return;
    this.mode = 'game';
    this.closeSheet?.();
    this.closeSheet = null;
    this.lobby = null;
    this.beginFresh();
    this.buildGameChrome();
  }

  private beginFresh(): void {
    const room = this.room;
    if (!room || this.mySeat === null) return;
    this.closeMatchEnd?.();
    this.closeMatchEnd = null;
    this.closeSummary?.();
    this.closeSummary = null;
    this.persp = this.newPersp(room, this.mySeat);
    this.mirror = emptyMatch(room.rules, room.mode, this.persp.localSeats());
    this.lastDrawSeat = null;
    const { names, faces } = this.playersOf(room, this.persp);
    this.host.beginMatch({ names, faces, mode: room.mode, seats: this.persp.localSeats(), match: this.mirror });
  }

  private buildGameChrome(): void {
    const layer = this.host.overlay.hudLayer;
    if (!this.netChip) this.netChip = h('div.net-chip', { role: 'status', 'aria-live': 'polite' });
    layer.append(this.netChip);
    this.host.setChatSender((id) => this.client?.send({ t: 'phrase', id }));
    this.host.chat.show();
    this.onConnState(this.client?.connState ?? 'open');
  }

  private showPhrase(seat: Seat, id: string): void {
    // a gesture: the seat's avatar makes it
    if (id.startsWith('g:')) {
      if ((CHAT_GESTURES as readonly string[]).includes(id.slice(2))) this.host.avatars.gesture(seat, id.slice(2) as ChatGesture);
      return;
    }
    const text = phraseText(id);
    if (!text) return;
    this.host.plates.say(seat, text, false, 2400);
    const e = PHRASE_FACE[id as QuickPhraseId];
    if (e) this.host.avatars.react(seat, e, 1.6);
  }

  private leaveGameUi(): void {
    this.bumpGen();
    this.host.chat.hide();
    this.host.setChatSender(null);
    this.netChip?.remove();
    this.host.plates.onLayout = null;
    this.host.plates.setTimer(null);
    for (const c of [this.closeSummary, this.closeMatchEnd, this.closeMenu, this.closeChooser]) c?.();
    this.closeSummary = this.closeMatchEnd = this.closeMenu = this.closeChooser = null;
    this.starterAnswered = false;
    this.persp = null;
    this.mirror = null;
    if (this.mode === 'game') this.mode = 'off';
  }

  // ───────────────────────── queue ─────────────────────────

  private newStale(): Promise<never> {
    const p = new Promise<never>((_, rej) => (this.staleRej = rej));
    p.catch(() => {});
    return p;
  }

  /** drop everything queued or running (a full snapshot replaces it) */
  private bumpGen(): void {
    this.gen++;
    this.queue = [];
    this.staleRej(new Stale());
    this.stale = this.newStale();
    this.interrupt();
    this.host.view().cancelHumanMove?.();
    this.closeChooser?.();
    this.closeChooser = null;
  }

  private interrupt(): void {
    const r = this.interruptRes;
    this.interruptRes = null;
    r?.();
  }

  private enqueue(fn: () => Promise<void>): void {
    this.queue.push(fn);
    // anything new means a pending pick of mine is over (the server moved on)
    this.interrupt();
    if (!this.pumping) void this.pump();
  }

  private async pump(): Promise<void> {
    this.pumping = true;
    try {
      while (this.queue.length) {
        const fn = this.queue.shift()!;
        try {
          await fn();
        } catch (e) {
          if (!(e instanceof Stale)) console.error('[online] step failed', e);
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  /** await `p` unless the queue is reset meanwhile */
  private async w<T>(p: Promise<T>): Promise<T> {
    const g = this.gen;
    const v = await Promise.race([p, this.stale]);
    if (g !== this.gen) throw new Stale();
    return v;
  }

  // ───────────────────────── events & turns ─────────────────────────

  private enqueueEvents(raw: GameEvent[]): void {
    const p = this.persp;
    if (!p) return;
    const evs = raw.map((e) => p.event(e));
    const matchOver = evs.some((e) => e.type === 'matchEnd');
    for (let i = 0; i < evs.length; i++) {
      let ev = evs[i];
      const next = evs[i + 1];
      if (ev.type === 'play' && next?.type === 'handEnd' && next.reason === 'domino') ev = { ...ev, finishing: true };
      const e = ev;
      const at = Date.now();
      this.enqueue(async () => this.playEvent(e, matchOver, at));
    }
  }

  private async playEvent(ev: GameEvent, matchOver: boolean, receivedAt: number): Promise<void> {
    if (!this.mirror) return;
    // a rematch: the first hand of a new match gets a fresh table, HUD and scores
    if (ev.type === 'handStart' && (this.mirror.over || (ev.handNo === 1 && this.mirror.hand))) this.beginFresh();
    if (!this.mirror) return;
    const view = this.host.view();
    const hooks = this.host.hooks();
    if (ev.type === 'handStart') {
      view.setTurn(null);
      this.closeSummary?.();
      this.closeSummary = null;
      this.closeMatchEnd?.();
      this.closeMatchEnd = null;
    }
    if (ev.type === 'play' || ev.type === 'pass' || ev.type === 'handEnd' || ev.type === 'handStart') this.setRing(null);
    const before = this.mirror;
    this.mirror = applyEvent(this.mirror, ev);
    if (ev.type === 'draw') this.lastDrawSeat = ev.seat;
    else if (ev.type !== 'matchEnd') this.lastDrawSeat = null;
    hooks.onEvent(ev, this.mirror, false);
    await this.w(this.watchdog(view.handle(ev), ev));
    if (ev.type === 'handEnd') {
      view.setTurn(null);
      this.turnSeat = null;
      hooks.onTurn(null, this.mirror, false);
      await this.w(this.handSummary(ev, before, matchOver, receivedAt));
    } else if (ev.type === 'matchEnd') {
      this.showMatchEnd(ev);
    }
  }

  /**
   * An animation that never finishes would freeze the table while the match goes on without us: after
   * a generous limit, stop waiting and take a fresh snapshot instead (instant restore).
   */
  private watchdog(p: Promise<void>, ev: GameEvent): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (document.hidden) return; // a background tab just runs late; the visibility resync catches up
        console.warn('[online] animation stuck, resyncing', ev.type);
        reject(new Stale());
        this.client?.resync();
      }, 15_000);
      p.then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  }

  /** the hand summary: closes by itself when the next hand is dealt (7 s), or with Continuar */
  private handSummary(ev: HandEnd, before: MatchState, matchOver: boolean, receivedAt: number): Promise<void> {
    const host = this.host;
    const s = host.settings();
    const m = this.mirror!;
    const solo = m.mode === 'individual';
    return new Promise<void>((resolve) => {
      let closed = false;
      let close = () => {};
      const done = () => {
        if (closed) return;
        closed = true;
        close();
        host.avatars.setHold(false);
        if (this.closeSummary === finish) this.closeSummary = null;
        resolve();
      };
      const finish = () => done();
      host.avatars.setHold(true);
      const card = buildHandSummary(
        ev,
        {
          avatars: s.avatars !== false,
          names: this.namesNow(),
          handNo: m.hand?.handNo ?? 0,
          prevScores: [before.scores[0], before.scores[1]],
          target: findTarget(host.engine, m.rules),
          matchOver,
          speed: s.animationSpeed === 'fast' ? 0.6 : 1,
          ...(solo ? { seats: m.seats ?? [0, 1, 2, 3], prevSeatScores: (before.seatScores ?? [0, 0, 0, 0]).slice() } : {}),
        },
        done,
      );
      // online: no blocking Continuar — a quiet countdown bar until the next deal
      card.classList.add('online-summary');
      if (!matchOver) {
        const left = Math.max(1500, 7000 - (Date.now() - receivedAt));
        const bar = h('div.summary-countdown', h('span', { style: `animation-duration:${left}ms` }));
        card.append(bar);
        setTimeout(done, left + 600);
      } else setTimeout(done, 3500);
      close = host.overlay.openModal(card);
      this.closeSummary = finish;
    });
  }

  private namesNow(): Names {
    if (!this.room || !this.persp) return ['', '', '', ''];
    return this.playersOf(this.room, this.persp).names;
  }

  private showMatchEnd(ev: MatchEnd): void {
    const m = this.mirror!;
    const s = this.host.settings();
    const solo = m.mode === 'individual';
    this.host.avatars.setHold(true);
    const card = buildMatchEnd(
      ev,
      {
        names: this.namesNow(),
        handsWon: m.handsWon,
        avatars: s.avatars !== false,
        ...(solo ? { seats: m.seats ?? [0, 1, 2, 3], seatHandsWon: m.seatHandsWon } : {}),
      },
      () => this.client?.send({ t: 'rematch' }),
      () => this.leave(),
    );
    card.classList.add('online-match-end');
    // labels for online: Revancha (host) / Salir; the others wait for the host
    const btns = card.querySelectorAll<HTMLButtonElement>('.sheet-actions .btn');
    const [menuBtn, rematchBtn] = [btns[0], btns[1]];
    if (menuBtn) menuBtn.querySelector('.btn-label')!.textContent = t('online.exit');
    if (rematchBtn) {
      rematchBtn.querySelector('.btn-label')!.textContent = t('online.rematch');
      if (!this.isHost) rematchBtn.replaceWith(h('p.match-wait', h('span.lobby-wait-dot'), t('online.waitRematch')));
      else rematchBtn.addEventListener('click', () => rematchBtn.classList.add('is-loading'));
    }
    const close = this.host.overlay.openModal(card);
    this.closeMatchEnd = () => {
      close();
      this.host.avatars.setHold(false);
    };
  }

  private setRing(seat: Seat | null, deadline = 0): void {
    if (seat === null || !this.client) return this.host.plates.setTimer(null);
    const ends = this.client.toLocal(deadline);
    this.host.plates.setTimer(seat, ends, TURN_TIMEOUT_MS, seat === 0 ? 5000 : 0, () => {
      // a gentle nudge on my own turn: warm ring, one soft pulse, a light tick
      this.host.plates.pulse(0);
      hapticTick();
    });
  }

  private enqueueTurn(msg: Extract<ServerMsg, { t: 'turn' }>): void {
    this.enqueue(async () => {
      const p = this.persp;
      const m = this.mirror;
      if (!p || !m) return;
      const view = this.host.view();
      const hooks = this.host.hooks();
      const seat = p.seat(msg.seat);
      const legal = msg.legal.map((x) => p.move(x));
      this.turnSeat = seat;
      view.setTurn(seat);
      this.setRing(seat, msg.deadline);
      if (msg.choosingStarter) {
        // one player decides (the last hand's winner); the partner may only say what they want
        if (this.starterAnswered || this.closeChooser || this.mySeat === null) return;
        const chooser = msg.starterChooser;
        if (chooser === undefined) return; // CPUs decide
        if (chooser === this.mySeat) await this.chooseStarter(msg.partnerWants);
        else if (((chooser + 2) % 4) === this.mySeat) this.offerStarterWish(p.seat(chooser));
        return;
      }
      this.starterAnswered = false;
      this.closeChooser?.();
      this.closeChooser = null;
      const mustPass = legal.length === 1 && legal[0].kind !== 'play';
      if (this.lastDrawSeat !== seat) hooks.onTurn(seat, m, mustPass);
      if (seat !== 0 || !legal.length) return;
      // individual, first play: the tile that must open (all plays are that tile)
      if (m.hand && m.hand.chain.length === 0) {
        const ids = new Set(legal.flatMap((x) => (x.kind === 'play' ? [x.tileId] : [])));
        const forced = ids.size === 1 ? [...ids][0] : null;
        if (m.mode === 'individual' && forced !== null && m.hand.openTile !== forced) {
          this.mirror = { ...m, hand: { ...m.hand, openTile: forced } };
        }
      }
      const interrupted = new Promise<null>((r) => (this.interruptRes = () => r(null)));
      const chosen = await this.w(Promise.race([view.requestHumanMove(legal), interrupted]));
      if (!chosen) {
        view.cancelHumanMove?.();
        return;
      }
      this.interruptRes = null;
      let move: Move =
        legal.find((x) => sameMove(x, chosen)) ?? legal.find((x) => x.kind === 'play' && chosen.kind === 'play' && x.tileId === chosen.tileId) ?? legal[0];
      if (move.kind === 'play' && chosen.kind === 'play' && chosen.slam) move = { ...move, slam: true };
      this.setRing(null);
      if (!this.client?.send({ t: 'move', move: p.moveToServer(move) })) {
        // not connected: the reconnect snapshot will ask again (or the CPU covered)
        this.client?.nudge();
      }
    });
  }

  /** "¿Quién sale?" for my pair */
  private async chooseStarter(wish: boolean | undefined): Promise<void> {
    const p = this.persp!;
    const s = this.host.settings();
    const partnerWants = wish ?? false;
    // a CPU partner speaks first (as offline); a human partner's wish arrives as its own bubble
    if (wish !== undefined) this.host.plates.say(2, t(wish ? 'say.wantStart' : 'say.youStart'), false, 2600);
    const interrupted = new Promise<null>((r) => (this.interruptRes = () => r(null)));
    const pick = new Promise<Seat>((resolve) => {
      const card = buildStarterChooser({
        names: this.namesNow(),
        avatars: s.avatars !== false,
        partnerWants,
        onPick: (seat) => resolve(seat),
      });
      const close = this.host.overlay.openModal(card, { dim: false });
      card.parentElement?.classList.add('starter-wrap');
      this.closeChooser = close;
    });
    const seat = await this.w(Promise.race([pick, interrupted]));
    this.closeChooser?.();
    this.closeChooser = null;
    if (seat === null) return;
    this.interruptRes = null;
    this.starterAnswered = true;
    if (seat === 0) this.host.plates.say(0, t('say.iStart'), false);
    this.client?.send({ t: 'chooseStarter', seat: p.server(seat) });
  }

  /** my partner decides who opens: I can say "Quiero salir" or "Sal tú" (doesn't block the queue) */
  private offerStarterWish(chooser: Seat): void {
    const s = this.host.settings();
    const names = this.namesNow();
    const card = buildStarterChooser({
      names,
      avatars: s.avatars !== false,
      partnerWants: false,
      labels: { me: t('say.wantStart'), partner: t('say.youStart') },
      note: t('starter.decides', { name: names[chooser] }),
      onPick: (seat) => {
        this.closeChooser?.();
        this.closeChooser = null;
        this.starterAnswered = true;
        this.client?.send({ t: 'starterWish', wants: seat === 0 });
      },
    });
    const close = this.host.overlay.openModal(card, { dim: false });
    card.parentElement?.classList.add('starter-wrap');
    this.closeChooser = close;
  }

  private onCovered(serverSeat: Seat, reason: 'timeout' | 'disconnected'): void {
    const p = this.persp;
    if (!p) return;
    const seat = p.seat(serverSeat);
    this.setRing(null);
    if (seat === 0) {
      this.host.view().cancelHumanMove?.();
      this.closeChooser?.();
      this.closeChooser = null;
    }
    const name = this.namesNow()[seat];
    if (reason === 'timeout') this.host.hud.notice(seat === 0 ? t('online.covered.timeoutYou') : t('online.covered.timeout', { name }));
    this.host.avatars.react(seat, 'sleepy', 2.4);
  }

  // ───────────────────────── restore ─────────────────────────

  /** put the table back from a snapshot in one frame (reconnect / resync) */
  private async restore(room: PublicRoom, view: SeatView): Promise<void> {
    this.bumpGen();
    const g = this.gen;
    const wasGame = this.mode === 'game';
    this.mode = 'game';
    this.home = null;
    this.lobby = null;
    this.closeSheet?.();
    this.closeSheet = null;
    this.closeSummary?.();
    this.closeSummary = null;
    this.closeMatchEnd?.();
    this.closeMatchEnd = null;
    const p = this.newPersp(room, view.seat);
    this.persp = p;
    const m = p.match(withPlaceholders(view));
    this.mirror = { ...m, mode: room.mode, seats: m.seats ?? p.localSeats() };
    this.lastDrawSeat = null;
    if (!wasGame) {
      const { names, faces } = this.playersOf(room, p);
      this.host.beginMatch({ names, faces, mode: room.mode, seats: p.localSeats(), match: this.mirror });
      this.buildGameChrome();
    } else this.refreshNames();
    const tv = this.host.view();
    const h = this.mirror.hand;
    if (h) {
      this.host.setSfxMuted(true);
      try {
        await (tv.restore?.({ hand: h, scores: this.mirror.scores, handOver: h.over, seats: this.mirror.seats }) ?? Promise.resolve());
      } finally {
        this.host.setSfxMuted(false);
      }
      if (g !== this.gen) return;
    }
    this.host.hooks().onRestore?.(this.mirror);
    if (this.mirror.over) {
      const mm = this.mirror;
      this.showMatchEnd({ type: 'matchEnd', winner: mm.winner ?? 0, scores: mm.scores, bonuses: [], winnerSeat: mm.winnerSeat ?? undefined, seatScores: mm.seatScores });
      return;
    }
    if (h && !h.over) {
      if (view.legal.length && view.turnDeadline) {
        this.enqueueTurn({ t: 'turn', seat: view.seat, deadline: view.turnDeadline, legal: view.legal });
      } else {
        tv.setTurn(h.turn);
        this.turnSeat = h.turn;
        if (view.turnDeadline && h.pendingStarterChoice == null) this.setRing(h.turn, view.turnDeadline);
      }
    }
  }

  // ───────────────────────── menu ─────────────────────────

  /** the in-game menu: the online match does not pause */
  openMenu(): void {
    if (this.mode !== 'game' || this.closeMenu) return;
    this.host.chat.toggle(false);
    const s = this.host.settings();
    this.closeMenu = this.host.overlay.openModal(
      buildOnlinePause({
        audio: { sound: s.sound, music: s.music, vibration: s.vibration },
        onAudio: (key, on) => this.host.setSetting(key, on),
        onResume: () => this.resumeFromMenu(),
        onLeave: () => {
          this.resumeFromMenu();
          if (this.mirror?.over) this.leave();
          else void this.confirmLeave();
        },
      }),
    );
  }

  private resumeFromMenu(): void {
    this.closeMenu?.();
    this.closeMenu = null;
  }

  // ───────────────────────── app lifecycle ─────────────────────────

  private onVisibility = (): void => {
    if (!this.client) return;
    if (document.hidden) {
      this.hiddenAt = Date.now();
      return;
    }
    // back from the background: animations froze meanwhile; a fresh snapshot catches up instantly
    const away = this.hiddenAt ? Date.now() - this.hiddenAt : 0;
    this.hiddenAt = 0;
    if (this.mode === 'game' && (away > 4000 || this.queue.length > 3)) this.client.resync();
    else this.client.nudge();
  };

  private onOnline = (): void => this.client?.nudge();

  dispose(): void {
    this.teardownRoom();
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('online', this.onOnline);
  }
}

function sameMove(a: Move, b: Move | undefined | null): boolean {
  if (!b || a.kind !== b.kind || a.seat !== b.seat) return false;
  if (a.kind !== 'play') return true;
  return b.kind === 'play' && a.tileId === b.tileId && a.side === b.side;
}
