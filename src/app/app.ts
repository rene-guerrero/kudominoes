import type { AppSettings, Bonus, RuleSettings, DominoMode, EngineApi, FrameStats, GameEvent, GameMode, Lineup, MatchState, Seat, SfxName, TableView, TableViewOptions } from '../contracts';
import { tileById, tileSetOf } from '../engine/tiles';
import { staticFace, faceOfSeat } from '../ui/avatars';
import { character, profileOf, randomLineup } from '../roster';
import { hapticTick, playSfx, setAudioPrefs, setAudioSuspended } from '../audio/sfx';
import { buildHowto } from '../ui/howto';
import { Hud } from '../ui/hud';
import { loc, setLang, t, type Key } from '../ui/i18n';
import { buildMenu } from '../ui/menu';
import { buildAbout } from '../ui/about';
import { confirmDialog, Overlay } from '../ui/overlay';
import { buildSettings, presetName, type SettingsTab } from '../ui/settings';
import { buildModeEditor } from '../ui/modeEditor';
import { ChatButton, phraseText, sanitizeGestures } from '../ui/chat';
import { allPresets } from './modes';
import { defaultRulesFor } from '../engine/rules';
import { customMode, deleteCustomMode, modeNameFree, rulesForMode, saveCustomMode, setupLine } from './modes';
import { buildNewGame } from '../ui/newgame';
import { setTileTheme } from '../ui/tiles';
import { buildHandSummary, buildMatchEnd, buildPause, buildStarterChooser } from '../ui/summary';
import { h, prefersReducedMotion, setReducedMotionPref, setUiQuality } from '../ui/dom';
import { AvatarController } from '../ui/avatars';
import { SeatPlates } from '../ui/plates';
import { GameSession, type SessionHooks } from './controller';
import { clearSave, loadSave, saveGame, saveSummary } from './save';
import { findTarget, RANDOM, rulesFor, sanitizeLineupSetting, saveSettings } from './settings';
import { QualityGovernor, resolveQuality } from './perf';
import { errorReport, logError, onErrorLogged, type LoggedError } from './errorLog';
import { buildCrash } from '../ui/crash';
import type { OnlineController, OnlineHost } from './online';
import type { FaceSpec } from '../roster';
import { served, type NetMode } from '../net/config';

type Names = [string, string, string, string];

export interface AppDeps {
  engine: EngineApi;
  createTableView(opts: TableViewOptions): TableView;
  settings: AppSettings;
  overlay: Overlay;
  tableEl: HTMLElement;
}

type ScreenName = 'menu' | 'settings' | 'howto' | 'game' | 'newgame' | 'online';

export class App {
  private engine: EngineApi;
  private settings: AppSettings;
  private overlay: Overlay;
  private hud: Hud;
  private view!: TableView;
  private viewNames: Names | null = null;
  private session: GameSession | null = null;
  /** online play (lazy-loaded); names of the online match override the lineup's */
  private online: OnlineController | null = null;
  private onlineLoading: Promise<OnlineController> | null = null;
  private onlineNames: Names | null = null;
  private screen: ScreenName = 'menu';
  private closePause: (() => void) | null = null;
  private returnToPause = false;
  /** where Ajustes was opened from, so the mode editor can come back to the same place */
  private settingsFrom: ScreenName = 'menu';
  private sfxMuted = false;
  private names: Names;
  private rulesNoticePending = false;
  private avatars = new AvatarController();
  private plates = new SeatPlates(this.avatars);
  /** online: where chat picks go; null = offline (only the player's own avatar shows them) */
  private chatSend: ((id: string) => void) | null = null;
  private chat!: ChatButton;
  /** the characters of the match being played (from the new-game sheet or the save) */
  private lineup: Lineup;
  /** auto quality: steps the level down when the renderer reports sustained slow frames */
  private governor = new QualityGovernor();
  /** the match being played: its mode and seats in play (individual: 2–4 players) */
  private mode: GameMode = 'pairs';
  private seats: Seat[] = [0, 1, 2, 3];
  /** individual: the seat that drew last (one "Robo" bubble per run of draws) */
  private lastDrawSeat: Seat | null = null;

  constructor(private deps: AppDeps) {
    this.engine = deps.engine;
    this.settings = resolveQuality(deps.settings);
    if (this.settings !== deps.settings) saveSettings(this.settings);
    setUiQuality(this.settings.quality);
    this.avatars.setQuality(this.settings.quality);
    this.overlay = deps.overlay;
    this.lineup = resolveLineup(sanitizeLineupSetting(this.settings.lineup));
    this.applyLineupFaces();
    this.names = this.computeNames();
    this.hud = new Hud(() => (this.screen === 'online' ? this.online?.openMenu() : this.pause()));
    // plates under the HUD (the turn pill and top bar stay on top)
    this.overlay.hudLayer.append(this.plates.el, this.hud.el);
    // gestures and quick phrases, in every game (offline: on the player's own avatar)
    this.chat = new ChatButton({
      layer: this.overlay.hudLayer,
      plates: this.plates,
      gestures: () => sanitizeGestures(this.settings.gestures),
      face: () => faceOfSeat(0),
      onGesture: (g) => (this.chatSend ? this.chatSend(`g:${g}`) : this.avatars.gesture(0, g)),
      onPhrase: (id) => {
        if (this.chatSend) return this.chatSend(id);
        this.plates.say(0, phraseText(id), false, 2400);
      },
    });
    this.avatars.setHumanFace(this.settings.avatarFace ?? 0);
    this.plates.setAvatars(this.settings.avatars !== false);
    this.avatars.setReducedMotion(prefersReducedMotion());
    this.ensureView();
    this.bindGlobal();
    // an uncaught error while a local match runs: the friendly error screen instead of a frozen table
    onErrorLogged((e) => {
      if (this.screen === 'game' && this.session) this.crash(e);
    });
    // dev only: feed fake frame stats from the console, e.g. __kudoPerf.feed(40) a few times
    if (import.meta.env.DEV)
      (window as unknown as { __kudoPerf: unknown }).__kudoPerf = {
        feed: (avgFrameMs: number, frames = 30) => this.onFrameStats({ avgFrameMs, frames, quality: this.settings.quality }),
        settings: () => ({ quality: this.settings.quality, qualityMode: this.settings.qualityMode, autoQuality: this.settings.autoQuality }),
      };
  }

  // ───────────────────────── graphics quality ─────────────────────────

  /** renderer telemetry (≈1/s while animating): in auto mode, sustained slow frames lower the level */
  private onFrameStats = (st: FrameStats): void => {
    if (this.settings.qualityMode === 'manual') return;
    const next = this.governor.feed(st, this.settings.quality);
    if (!next) return;
    if (import.meta.env.DEV) console.info(`[kudominoes] auto quality: ${this.settings.quality} → ${next} (avg ${st.avgFrameMs.toFixed(1)} ms over ${st.frames} frames)`);
    this.settings = { ...this.settings, autoQuality: next, quality: next };
    saveSettings(this.settings);
    this.applyQuality();
  };

  private applyQuality(): void {
    const q = this.settings.quality;
    this.view.setQuality(q);
    setUiQuality(q);
    this.avatars.setQuality(q);
  }

  /** seats 1..3 wear their characters' faces */
  private applyLineupFaces(): void {
    for (const s of [1, 2, 3] as const) this.avatars.setSeatFace(s, character(this.lineup[s]).face);
  }

  // ───────────────────────── view ─────────────────────────

  private computeNames(): Names {
    if (this.onlineNames) return [this.settings.playerName || t('seat.you'), this.onlineNames[1], this.onlineNames[2], this.onlineNames[3]];
    const l = this.lineup;
    return [this.settings.playerName || t('seat.you'), character(l[1]).name, character(l[2]).name, character(l[3]).name];
  }

  private onSfx = (name: SfxName) => {
    if (!this.sfxMuted) playSfx(name);
  };

  private viewSpeed(): number {
    return this.settings.animationSpeed === 'fast' ? 1.6 : 1;
  }

  private ensureView(): void {
    const names = this.computeNames();
    this.names = names;
    this.plates.setNames(names);
    if (this.view) {
      if (this.viewNames && this.viewNames.join('|') === names.join('|')) return;
      if (this.view.setPlayerNames) {
        this.view.setPlayerNames(names);
        this.viewNames = names;
        return;
      }
      this.view.dispose();
    }
    this.view = this.deps.createTableView({
      container: this.deps.tableEl,
      quality: this.settings.quality,
      onSfx: this.onSfx,
      playerNames: names,
      reducedMotion: prefersReducedMotion(),
      language: this.settings.language,
      speed: this.viewSpeed(),
      tileTheme: this.settings.tileTheme ?? 'dark',
      tableStyle: this.settings.tableStyle ?? 'green',
      tileBack: this.settings.tileBack ?? 'ornate',
      onPlates: (plates, center) => this.plates.update(plates, center),
      onImpact: (seat, kind) => this.avatars.onImpact(seat, kind),
      onDrag: (d) => this.plates.setDragging(d),
      onFrameStats: this.onFrameStats,
      onError: (err) => this.crash(logError('render', err)),
    });
    this.viewNames = names;
  }

  // ───────────────────────── screens ─────────────────────────

  showMenu(): void {
    this.screen = 'menu';
    this.hud.show(false);
    const s = loadSave();
    const save = s ? saveSummary(s) : null;
    this.overlay.showScreen(
      buildMenu({
        save,
        onPlay: () => void this.quickPlay(!!s),
        onSetup: () => void this.onPlay(!!s),
        setupLine: setupLine(this.engine, this.settings),
        profile: {
          face: staticFace(this.settings.avatarFace ?? 0),
          name: this.settings.playerName || t('seat.you'),
          onOpen: () => this.showSettings('game'),
        },
        onContinue: () => this.continueSaved(),
        onSettings: () => this.showSettings(),
        onHowto: () => this.showHowto(),
        onOnline: () => void this.openOnline(),
        onFriends: () => void this.openOnline(undefined, false, 'local'),
      }),
    );
  }

  // ───────────────────────── online play ─────────────────────────

  /** "Jugar en línea" / "Jugar con amigos" (or a share link / a reload inside a room: join that code) */
  async openOnline(code?: string, quiet = false, net: NetMode = served() ? 'local' : 'online'): Promise<void> {
    this.onlineLoading ??= import('./online').then((m) => {
      this.online = new m.OnlineController(this.onlineHost());
      return this.online;
    });
    const ctl = await this.onlineLoading;
    this.stopSession();
    this.screen = 'online';
    ctl.open(code, quiet, net);
  }

  private onlineHost(): OnlineHost {
    return {
      engine: this.engine,
      overlay: this.overlay,
      hud: this.hud,
      plates: this.plates,
      avatars: this.avatars,
      view: () => this.view,
      settings: () => this.settings,
      setSetting: (key, v) => {
        this.settings = { ...this.settings, [key]: v };
        saveSettings(this.settings);
        this.applySetting(key);
      },
      hooks: () => this.hooks(),
      beginMatch: (o) => {
        this.stopSession();
        this.screen = 'online';
        this.onlineNames = o.names;
        this.mode = o.mode;
        this.seats = o.seats.slice();
        this.lastDrawSeat = null;
        this.applyOnlineFaces(o.faces);
        this.ensureView();
        this.view.reset();
        this.view.setTileSet?.(tileSetOf(o.match.rules));
        this.overlay.closeAllModals();
        this.overlay.showScreen(null);
        this.hud.reset();
        this.plates.clearBubbles();
        this.avatars.reset();
        this.avatars.setPaused(false);
        this.avatars.setHold(false);
        this.hud.setScores(o.match.scores);
        this.hud.setAbajo(o.match.abajo ?? 0);
        this.hud.setTarget(findTarget(this.engine, o.match.rules));
        this.setupSoloHud(o.match);
        if (o.match.hand) this.hud.setHand(o.match.hand.handNo);
        this.hud.show(true);
      },
      setPlayers: (names, faces) => {
        this.onlineNames = names;
        this.applyOnlineFaces(faces);
        this.ensureView();
        if (this.mode === 'individual' && this.session === null) {
          const avatarsOn = this.settings.avatars !== false;
          const i = Math.max(0, this.seats.indexOf(0));
          const order = [...this.seats.slice(i), ...this.seats.slice(0, i)];
          this.hud.setPlayers(order.map((s) => ({ seat: s, name: this.names[s], face: avatarsOn ? h('span.face-static', staticFace(faceOfSeat(s), 'idle')) : null })));
        }
      },
      setSfxMuted: (m) => (this.sfxMuted = m),
      chat: this.chat,
      setChatSender: (send) => (this.chatSend = send),
      exit: () => {
        this.onlineNames = null;
        this.applyLineupFaces();
        this.toMenu();
      },
    };
  }

  private applyOnlineFaces(faces: FaceSpec[]): void {
    for (const s of [1, 2, 3] as const) if (faces[s]) this.avatars.setSeatFace(s, faces[s]);
  }

  /** Acerca de: a small modal over the menu or Ajustes; Esc / Cerrar / Android back close it */
  private showAbout(): void {
    let close = () => {};
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'GoBack' || e.key === 'BrowserBack') done();
    };
    const done = () => {
      window.removeEventListener('keydown', onKey);
      close();
    };
    close = this.overlay.openModal(buildAbout(done));
    window.addEventListener('keydown', onKey);
  }

  private showSettings(tab?: SettingsTab, rulesMode?: GameMode, fromOverride?: ScreenName): void {
    const from = fromOverride ?? this.screen;
    this.settingsFrom = from;
    this.screen = 'settings';
    const back = () => {
      if (from === 'game') this.backToPause();
      else if (from === 'newgame') this.showNewGame();
      else this.showMenu();
    };
    if (tab) this.settings = { ...this.settings, settingsTab: tab };
    // Reglas opens on the mode asked for (the new-game sheet's mode, or the match being played)
    const rm = rulesMode ?? (from === 'game' ? this.mode : undefined);
    if (rm) this.settings = { ...this.settings, rulesTabMode: rm };
    const build = () =>
      buildSettings({
        settings: this.settings,
        ruleDescriptors: this.engine.RULE_SETTINGS,
        defaultRules: this.engine.DEFAULT_RULES,
        ruleDescriptorsIndividual: this.engine.RULE_SETTINGS_INDIVIDUAL,
        defaultRulesIndividual: this.engine.DEFAULT_RULES_INDIVIDUAL,
        presets: this.engine.RULE_PRESETS ?? [],
        editMode: (draft, isNew) => this.editMode(draft, isNew),
        profileLocked: from === 'game' || !!this.onlineNames,
        confirm: (o) => confirmDialog(this.overlay, o),
        resolvedQuality: () => this.settings.quality,
        onChange: (next, key) => {
          // the auto decision belongs to the app (the screen's copy may be stale); auto mode = that level
          this.settings = resolveQuality({ ...next, autoQuality: this.settings.autoQuality });
          saveSettings(this.settings);
          this.applySetting(key);
          if ((key === 'rules' && from === 'game' && this.mode === 'pairs') || (key === 'rulesIndividual' && from === 'game' && this.mode === 'individual'))
            this.rulesNoticePending = true;
          if (key === 'language') this.overlay.showScreen(build());
        },
        onBack: back,
        onAbout: () => this.showAbout(),
      });
    this.returnToPause = from === 'game';
    this.overlay.showScreen(build());
  }

  /** the separate rules editor over Ajustes › Reglas (plus / pencil) */
  private editMode(draft: DominoMode, isNew: boolean): void {
    const back = () => this.showSettings('rules', undefined, this.settingsFrom);
    const apply = (def: DominoMode | null) => {
      // a deleted mode (def null) falls back to its base mode's default rules, the rules the Reglas view shows
      const base = def?.base ?? draft.base;
      const rules = def ? { ...def.rules } : { ...defaultRulesFor(base) };
      this.settings = {
        ...this.settings,
        settingsTab: 'rules',
        customMode: def?.id,
        mode: base,
        rulesTabMode: base,
        rules: base === 'pairs' ? rules : this.settings.rules,
        rulesIndividual: base === 'individual' ? rules : this.settings.rulesIndividual,
      };
      saveSettings(this.settings);
      back();
    };
    this.overlay.showScreen(
      buildModeEditor({
        draft,
        isNew,
        nameFree: (n) => modeNameFree(n, isNew ? undefined : draft.id),
        onSave: (def) => apply(saveCustomMode(def).find((m) => m.id === def.id) ?? null),
        onDelete: isNew
          ? undefined
          : async () => {
              const ok = await confirmDialog(this.overlay, { title: t('modes.deleteTitle', { name: loc(draft.name) }), body: t('modes.deleteBody'), ok: t('modes.delete'), cancel: t('common.cancel'), danger: true });
              if (!ok) return;
              deleteCustomMode(draft.id);
              apply(null);
            },
        onBack: back,
      }),
    );
  }

  private showHowto(): void {
    const from = this.screen;
    this.screen = 'howto';
    this.returnToPause = from === 'game';
    this.overlay.showScreen(buildHowto(() => (from === 'game' ? this.backToPause() : this.showMenu())));
  }

  /** Partida rápida: the new-game screen's own Comenzar with the last setup, so the two never drift apart */
  private async quickPlay(hasSave: boolean): Promise<void> {
    if (hasSave && !(await this.confirmNew())) return;
    (this.newGameScreen().querySelector('.ng-start') as HTMLButtonElement | null)?.click();
  }

  /** the new-game sheet: the mode (Parejas | Individual), the characters, the rules preset, Comenzar */
  private showNewGame(): void {
    this.screen = 'newgame';
    this.overlay.showScreen(this.newGameScreen());
  }

  private newGameScreen(): HTMLElement {
    return buildNewGame({
        mode: this.settings.mode ?? 'pairs',
        customMode: this.settings.customMode,
        lineup: sanitizeLineupSetting(this.settings.lineup),
        soloOpponents: this.settings.soloOpponents ?? 2,
        soloLineup: this.settings.soloLineup ?? [],
        avatars: this.settings.avatars !== false,
        humanFace: this.settings.avatarFace ?? 0,
        humanName: this.settings.playerName || t('seat.you'),
        tableStyle: this.settings.tableStyle ?? 'green',
        presetName: (mode) => {
          const c = customMode(this.settings.customMode);
          return c && c.base === mode ? loc(c.name) : presetName(allPresets(this.engine), rulesFor(this.settings, mode), mode);
        },
        onChange: (lineup) => {
          this.settings = { ...this.settings, lineup };
          saveSettings(this.settings);
        },
        onSoloChange: (soloLineup, soloOpponents) => {
          this.settings = { ...this.settings, soloLineup, soloOpponents };
          saveSettings(this.settings);
        },
        onMode: (mode, customMode) => {
          this.settings = { ...this.settings, mode, customMode };
          saveSettings(this.settings);
        },
        onRules: (mode) => this.showSettings('rules', mode),
        onStart: (o) => {
          clearSave();
          this.settings = { ...this.settings, mode: o.mode };
          saveSettings(this.settings);
          const lineup = o.mode === 'pairs' ? resolveLineup(o.lineup) : o.lineup;
          this.startMatch(this.newMatch(o.mode, o.players), false, lineup);
        },
        onBack: () => this.showMenu(),
      });
  }

  /** a fresh match of a mode with the selected mode's rules (a custom mode plays its own rule set) */
  private newMatch(mode: GameMode, players: 2 | 3 | 4): MatchState {
    const rules = rulesForMode(this.settings, mode);
    return mode === 'individual' ? this.engine.createMatch(rules, undefined, { mode, players }) : this.engine.createMatch(rules);
  }

  private backToPause(): void {
    this.screen = 'game';
    this.returnToPause = false;
    this.overlay.showScreen(null);
    this.openPauseModal();
  }

  private applySetting(key: keyof AppSettings): void {
    const s = this.settings;
    switch (key) {
      case 'language':
        setLang(s.language);
        this.hud.relabel();
        this.view.setLanguage?.(s.language);
        // the human's default name ("Tú"/"You") is language dependent
        this.ensureView();
        break;
      case 'animationSpeed':
        this.view.setSpeed?.(this.viewSpeed());
        break;
      case 'reducedMotion':
        setReducedMotionPref(!!s.reducedMotion);
        this.view.setReducedMotion?.(!!s.reducedMotion);
        this.avatars.setReducedMotion(!!s.reducedMotion);
        break;
      case 'avatars':
        this.plates.setAvatars(s.avatars !== false);
        break;
      case 'avatarFace':
        this.avatars.setHumanFace(s.avatarFace ?? 0);
        break;
      case 'tileTheme':
        setTileTheme(s.tileTheme ?? 'dark');
        this.view.setTileTheme?.(s.tileTheme ?? 'dark');
        break;
      case 'tableStyle':
        this.view.setTableStyle?.(s.tableStyle ?? 'green');
        break;
      case 'tileBack':
        this.view.setTileBack?.(s.tileBack ?? 'ornate');
        break;
      case 'quality':
      case 'qualityMode':
        this.governor.reset();
        this.applyQuality();
        break;
      case 'sound':
      case 'music':
      case 'vibration':
        setAudioPrefs({ sound: s.sound, music: s.music, vibration: s.vibration });
        break;
      case 'playerName':
        // live rename when the view supports it; otherwise recreate only when idle
        if (this.view.setPlayerNames || !this.session) this.ensureView();
        break;
    }
  }

  // ───────────────────────── match lifecycle ─────────────────────────

  private async onPlay(hasSave: boolean): Promise<void> {
    if (hasSave && !(await this.confirmNew())) return;
    this.showNewGame();
  }

  /** a saved match is lost when a new one starts: ask first */
  private confirmNew(): Promise<boolean> {
    return confirmDialog(this.overlay, {
      title: t('menu.newConfirmTitle'),
      body: t('menu.newConfirmBody'),
      ok: t('menu.newConfirmOk'),
      cancel: t('common.cancel'),
      danger: true,
    });
  }

  private continueSaved(): void {
    const s = loadSave();
    if (!s) return this.showMenu();
    this.startMatch(s.match, true, s.lineup);
  }

  private startMatch(match: MatchState, resume: boolean, lineup: Lineup): void {
    this.stopSession();
    this.lineup = { ...lineup };
    this.mode = match.mode ?? 'pairs';
    this.seats = (match.seats ?? [0, 1, 2, 3]).slice();
    this.lastDrawSeat = null;
    this.applyLineupFaces();
    this.ensureView();
    this.view.reset();
    this.view.setTileSet?.(tileSetOf(match.rules));
    this.overlay.closeAllModals();
    this.overlay.showScreen(null);
    this.screen = 'game';
    this.hud.reset();
    this.plates.clearBubbles();
    this.chatSend = null;
    this.chat.show();
    this.avatars.reset();
    this.avatars.setPaused(false);
    this.avatars.setHold(false);
    this.hud.setScores(match.scores);
    this.hud.setAbajo(match.abajo ?? 0);
    this.hud.setTarget(findTarget(this.engine, match.rules));
    this.setupSoloHud(match);
    if (match.hand) this.hud.setHand(match.hand.handNo);
    this.hud.show(true);

    const session = new GameSession(
      {
        engine: this.engine,
        view: this.view,
        hooks: this.hooks(),
        profile: (seat: Seat) => (seat === 0 ? { level: 'normal' } : profileOf(this.lineup[seat])),
        slam: (seat: Seat) => (seat === 0 ? { p: 0, cap: 0 } : character(this.lineup[seat]).slam),
        speed: () => (this.settings.animationSpeed === 'fast' ? 0.5 : 1),
        viewSpeed: () => this.viewSpeed(),
      },
      match,
      resume,
    );
    this.session = session;
    session
      .run()
      .then((res) => {
        if (this.session !== session) return; // superseded
        this.session = null;
        // a rematch keeps the same mode, players and characters
        if (res === 'rematch') this.startMatch(this.newMatch(this.mode, this.seats.length as 2 | 3 | 4), false, this.lineup);
        else if (res === 'menu') this.toMenu();
      })
      .catch((err) => {
        console.error('[kudominoes] game loop crashed', err);
        if (this.session === session) this.crash(logError('game', err));
      });
  }

  /** individual mode: the per-player scoreboard (in turn order from the human) and the boneyard chip */
  private setupSoloHud(match: MatchState): void {
    if (this.mode !== 'individual') {
      this.hud.setPlayers(null);
      this.hud.setPile(null);
      return;
    }
    const avatarsOn = this.settings.avatars !== false;
    const i = Math.max(0, this.seats.indexOf(0));
    const order = [...this.seats.slice(i), ...this.seats.slice(0, i)];
    this.hud.setPlayers(order.map((s) => ({ seat: s, name: this.names[s], face: avatarsOn ? h('span.face-static', staticFace(faceOfSeat(s), 'idle')) : null })));
    this.hud.setSeatScores(match.seatScores ?? [0, 0, 0, 0]);
    this.hud.setPile(pileOf(match));
  }

  private stopSession(): void {
    if (this.session) {
      this.session.cancel();
      this.session = null;
    }
  }

  /**
   * An unexpected error stopped the match: stop it, then a friendly card with "Volver al menú" and the
   * error text under "Detalles" (also in production: the APK has no console). Never a frozen screen.
   */
  private crashCard: (() => void) | null = null;
  private crash(e: LoggedError): void {
    if (this.crashCard) return;
    try {
      this.stopSession();
      this.closePause?.();
      this.closePause = null;
      this.overlay.closeAllModals();
      this.avatars.setHold(true);
    } catch (err) {
      console.error('[kudominoes] cleanup after an error failed', err);
    }
    const close = this.overlay.openModal(
      buildCrash({
        details: errorReport(e),
        onMenu: () => {
          close();
          this.crashCard = null;
          try {
            this.toMenu();
          } catch (err) {
            logError('menu', err);
            this.showMenu();
          }
        },
      }),
    );
    this.crashCard = close;
  }

  private toMenu(): void {
    this.stopSession();
    this.chat.hide();
    this.chatSend = null;
    this.closePause?.();
    this.closePause = null;
    this.overlay.closeAllModals();
    this.view.setPaused(false);
    this.view.setTurn(null);
    this.view.reset();
    this.hud.reset();
    this.plates.clearBubbles();
    this.avatars.reset();
    this.avatars.setPaused(false);
    this.avatars.setHold(false);
    this.ensureView();
    this.showMenu();
  }

  // ───────────────────────── pause ─────────────────────────

  pause(): void {
    this.chat.toggle(false);
    if (!this.session || this.screen !== 'game' || this.closePause) return;
    this.session.setPaused(true);
    this.openPauseModal();
  }

  private openPauseModal(): void {
    this.session?.setPaused(true);
    this.avatars.setPaused(true);
    this.closePause?.();
    const lu = this.lineup;
    this.closePause = this.overlay.openModal(
      buildPause({
        levels: ([2, 1, 3] as const)
          .filter((s) => this.seats.includes(s))
          .map((s) => ({ name: this.names[s], level: t(`settings.difficulty.${character(lu[s]).level}` as Key), partner: s === 2 && this.mode === 'pairs' })),
        audio: { sound: this.settings.sound, music: this.settings.music, vibration: this.settings.vibration },
        // the same settings fields as Ajustes → Imagen y sonido, applied live
        onAudio: (key, on) => {
          this.settings = { ...this.settings, [key]: on };
          saveSettings(this.settings);
          this.applySetting(key);
        },
        onResume: () => this.resume(),
        onSettings: () => {
          this.closePause?.();
          this.closePause = null;
          this.showSettings();
        },
        onHowto: () => {
          this.closePause?.();
          this.closePause = null;
          this.showHowto();
        },
        onQuit: () => this.toMenu(),
      }),
    );
  }

  private resume(): void {
    this.closePause?.();
    this.closePause = null;
    this.session?.setPaused(false);
    this.avatars.setPaused(false);
    if (this.rulesNoticePending) {
      this.rulesNoticePending = false;
      this.hud.notice(t('notice.rulesNext'));
    }
  }

  // ───────────────────────── hooks ─────────────────────────

  private callout(seat: Seat, key: Key, strong = false) {
    this.plates.say(seat, t(key), strong);
  }

  private noticeBonuses(bonuses: Bonus[]): void {
    for (const b of bonuses) {
      if (b.seat !== undefined) {
        // individual: the player's name
        const name = this.names[b.seat];
        const you = b.seat === 0;
        if (b.kind === 'double') this.hud.notice(you ? t('notice.capicuaDoubleSoloYou') : t('notice.capicuaDoubleSolo', { name }));
        else this.hud.notice(t(you ? 'notice.bonusSoloYou' : 'notice.bonusSolo', { label: loc(b.label), n: b.points, name }));
        continue;
      }
      const team = b.team === 0 ? t('team.us') : t('team.them');
      if (b.kind === 'double') this.hud.notice(t('notice.capicuaDouble', { team }));
      else this.hud.notice(b.points ? t('notice.bonus', { label: loc(b.label), n: b.points, team }) : t('notice.bonusNoPts', { label: loc(b.label), team }));
    }
  }

  private hooks(): SessionHooks {
    return {
      onEvent: (ev, match, replay) => {
        if (replay) this.avatars.setQuiet(true);
        this.avatars.onEvent(ev, replay);
        switch (ev.type) {
          case 'handStart':
            this.hud.setHand(ev.handNo);
            this.hud.setScores(ev.scores);
            if (ev.seatScores) this.hud.setSeatScores(ev.seatScores);
            if (this.mode === 'individual') this.hud.setPile(match.rules.boneyardDraw === false || !ev.boneyard?.length ? null : ev.boneyard.length);
            this.hud.setEnds(null);
            this.plates.clearBubbles();
            this.lastDrawSeat = null;
            break;
          case 'play':
            this.hud.setEnds(ev.ends);
            this.lastDrawSeat = null;
            break;
          case 'draw':
            // one "Robo" bubble per run of draws; the boneyard chip counts down
            if (!replay && this.lastDrawSeat !== ev.seat) this.callout(ev.seat, 'say.draw');
            this.lastDrawSeat = ev.seat;
            this.hud.setPile(ev.boneyardLeft > 0 ? ev.boneyardLeft : null);
            if (ev.seatScores) this.hud.setSeatScores(ev.seatScores, !replay);
            if (!replay && ev.bonus) this.noticeBonuses([ev.bonus]);
            if (!replay && ev.bonusBlocked) this.hud.notice(t('notice.paseSalidaBlocked'));
            break;
          case 'pass':
            this.hud.setEnds(ev.ends);
            this.lastDrawSeat = null;
            // the one and only "Paso" callout, as a bubble on the passer's plate
            if (!replay) this.callout(ev.seat, 'say.pass');
            if (ev.scores) this.hud.setScores(ev.scores, !replay);
            if (ev.seatScores) this.hud.setSeatScores(ev.seatScores, !replay);
            if (!replay && ev.bonus && ev.bonus.seat !== undefined) this.noticeBonuses([ev.bonus]);
            else if (!replay && ev.bonus) {
              const team = ev.bonus.team === 0 ? t('team.us') : t('team.them');
              this.hud.notice(t('notice.bonus', { label: loc(ev.bonus.label), n: ev.bonus.points, team }));
            }
            if (!replay && ev.bonusBlocked) this.hud.notice(t('notice.paseSalidaBlocked'));
            if (ev.abajoPot !== undefined) this.hud.setAbajo(ev.abajoPot, !replay);
            if (!replay && ev.bonusAbajo) this.hud.notice(t('notice.abajoPase', { n: ev.bonusAbajo.points }));
            if (!replay && ev.abajoClaimed) this.hud.notice(t(ev.bonus?.team === 1 ? 'notice.abajoClaimThem' : 'notice.abajoClaimUs', { n: ev.abajoClaimed }));
            break;
          case 'handEnd': {
            if (!replay) {
              if (ev.reason === 'domino' && ev.winnerSeat !== null) {
                const cap = ev.bonuses.some((b) => b.id === 'capicua');
                this.callout(ev.winnerSeat, cap ? 'say.capicua' : 'say.domino', true);
              } else if (ev.reason === 'blocked') {
                const last = match.hand?.chain[match.hand.chain.length - 1]?.seat;
                if (last !== undefined) this.callout(last, 'say.tranque', true);
              }
            }
            this.hud.setScores(ev.scores, true);
            if (ev.seatScores) this.hud.setSeatScores(ev.seatScores, true);
            if (this.mode === 'individual') this.hud.setPile(null);
            if (ev.abajoPot !== undefined) this.hud.setAbajo(ev.abajoPot, !replay);
            // rare events nothing else on screen explains get a short notice in the top bar
            if (!replay) {
              if (ev.winnerTeam === null) this.hud.notice(t('notice.void'));
              if (ev.abajoAdded) this.hud.notice(ev.abajoAdded === 1 ? t('notice.abajoAdded1') : t('notice.abajoAdded', { n: ev.abajoAdded }));
              if (ev.abajoClaimed) this.hud.notice(t(ev.winnerTeam === 1 ? 'notice.abajoClaimThem' : 'notice.abajoClaimUs', { n: ev.abajoClaimed }));
              this.noticeBonuses(ev.bonuses);
            }
            break;
          }
          case 'matchEnd':
            if (!replay) this.noticeBonuses(ev.bonuses);
            break;
        }
      },
      pickStarter: async (match) => {
        const hand = match.hand!;
        const team = hand.pendingStarterChoice ?? 0;
        const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms * (this.settings.animationSpeed === 'fast' ? 0.6 : 1)));
        if (team === 1) {
          // the CPU pair: each says whether it wants to open; the one who opens announces it
          const seat = this.engine.cpuStarter ? this.engine.cpuStarter(match) : hand.turn;
          await pause(450);
          this.callout(seat, 'say.iStart');
          await pause(1000);
          return seat;
        }
        // the human's pair: the partner speaks first (judging only its own tiles), then the human decides
        const wants = this.engine.starterPreference?.(match, 2) ?? false;
        await pause(300);
        this.plates.say(2, t(wants ? 'say.wantStart' : 'say.youStart'), false, 2600);
        return new Promise<Seat>((resolve) => {
          let close = () => {};
          const card = buildStarterChooser({
            names: this.names,
            avatars: this.settings.avatars !== false,
            partnerWants: wants,
            onPick: (seat) => {
              close();
              if (seat === 0) this.callout(0, 'say.iStart');
              resolve(seat);
            },
          });
          close = this.overlay.openModal(card, { dim: false });
          card.parentElement?.classList.add('starter-wrap');
        });
      },
      onRestore: (match) => {
        // the restored table is final: HUD in place, faces calm, no reactions
        const h = match.hand;
        this.hud.setScores(match.scores);
        this.hud.setAbajo(match.abajo ?? 0);
        if (match.seatScores) this.hud.setSeatScores(match.seatScores);
        if (this.mode === 'individual') this.hud.setPile(pileOf(match));
        if (h) {
          this.hud.setHand(h.handNo);
          this.hud.setEnds(h.over ? null : h.ends);
        }
      },
      onTurn: (seat, m, mustPass) => {
        this.avatars.setQuiet(false);
        this.avatars.onTurn(seat);
        if (seat !== 0) return;
        // the human's turn: a short pulse on the own plate, the face perks up, a light tick
        this.plates.pulse(0);
        this.avatars.perk(0);
        hapticTick();
        const h = m.hand;
        if (this.mode === 'individual') {
          // individual, first hand: the double six (or the highest double / tile) must open
          const id = h && h.chain.length === 0 ? h.openTile : null;
          if (id !== null && id !== undefined) {
            const tl = tileById(m.rules, id);
            const d6 = tileSetOf(m.rules) === 'double6';
            this.hud.notice(
              d6 && id === 27
                ? t('notice.openDouble6')
                : t('notice.openTile', { tile: d6 && tl.a === tl.b ? t(`tile.double.${tl.a}` as Key) : `${tl.b}-${tl.a}` }),
            );
          }
          return;
        }
        // pairs: the forced opener (6-6, or in double-nine the highest double dealt) is stored as openTile
        const forced = !mustPass && h && h.chain.length === 0 ? h.openTile : null;
        if (forced !== null && forced !== undefined) {
          const tl = tileById(m.rules, forced);
          const d6 = tileSetOf(m.rules) === 'double6';
          this.hud.notice(d6 && forced === 27 ? t('notice.openDouble6') : t('notice.openTile', { tile: d6 && tl.a === tl.b ? t(`tile.double.${tl.a}` as Key) : `${tl.b}-${tl.a}` }));
        } else if (!mustPass && h && h.chain.length === 0 && h.handNo === 1 && m.rules.firstStarter === 'double6' && tileSetOf(m.rules) === 'double6')
          this.hud.notice(t('notice.openDouble6'));
      },
      showHandSummary: (ev, match, prevScores) =>
        new Promise<void>((resolve) => {
          let close = () => {};
          this.avatars.setHold(true);
          const card = buildHandSummary(
            ev,
            {
              avatars: this.settings.avatars !== false,
              names: this.names,
              handNo: match.hand?.handNo ?? 0,
              prevScores: [ev.scores[0] - delta(ev, 0), ev.scores[1] - delta(ev, 1)].map((v, i) => (v < 0 ? prevScores[i] : v)) as [number, number],
              target: findTarget(this.engine, match.rules),
              matchOver: match.over,
              speed: this.settings.animationSpeed === 'fast' ? 0.6 : 1,
              ...(this.mode === 'individual' ? { seats: this.seats, prevSeatScores: soloPrev(ev) } : {}),
            },
            () => {
              close();
              this.avatars.setHold(false);
              resolve();
            },
          );
          close = this.overlay.openModal(card);
        }),
      showMatchEnd: (ev, match) =>
        new Promise<'rematch' | 'menu'>((resolve) => {
          clearSave();
          let close = () => {};
          this.avatars.setHold(true);
          const card = buildMatchEnd(
            ev,
            {
              names: this.names,
              handsWon: match.handsWon,
              avatars: this.settings.avatars !== false,
              ...(this.mode === 'individual' ? { seats: this.seats, seatHandsWon: match.seatHandsWon } : {}),
            },
            () => {
              close();
              resolve('rematch');
            },
            () => {
              close();
              resolve('menu');
            },
          );
          close = this.overlay.openModal(card);
        }),
      save: (match, events) => saveGame(match, events, this.lineup),
      setSfxMuted: (m) => (this.sfxMuted = m),
    };
  }

  // ───────────────────────── global input ─────────────────────────

  private bindGlobal(): void {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        setAudioSuspended(true);
        this.pause();
      } else setAudioSuspended(false);
    });
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' && e.key !== 'GoBack' && e.key !== 'BrowserBack') return;
      if (this.screen === 'online') {
        // a confirm dialog of the online screens handles itself
        if (this.overlay.modalOpen && this.overlay.modalLayer.querySelector('.dialog:not(.rules-sheet)')) return;
        this.online?.back();
        return;
      }
      if (this.overlay.modalOpen && this.screen !== 'game') return; // a confirm dialog handles itself
      if (this.screen === 'settings' || this.screen === 'howto' || this.screen === 'newgame') {
        (this.overlay.screen?.querySelector('.screen-head .back') as HTMLButtonElement | null)?.click();
      } else if (this.screen === 'game') {
        if (this.closePause) this.resume();
        else if (!this.overlay.modalOpen) this.pause();
      }
    });
    // Android hardware back (called by MainActivity): returns true when handled, false = leave the app
    (window as unknown as { __kudoBack: () => boolean }).__kudoBack = () => {
      if (this.screen === 'menu') {
        if (!this.overlay.modalOpen) return false;
        this.overlay.closeAllModals();
        return true;
      }
      if (this.screen === 'online' && this.online?.closeTopSheet()) return true;
      if (this.overlay.modalOpen && this.screen !== 'game') {
        this.overlay.closeAllModals();
        return true;
      }
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      return true;
    };
    document.addEventListener('backbutton', () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
  }
}

/** draw the 'random' slots among the characters not seated yet */
function resolveLineup(l: Lineup): Lineup {
  const keep: Partial<Lineup> = {};
  for (const s of [1, 2, 3] as const) if (l[s] !== RANDOM) keep[s] = l[s];
  return randomLineup(keep);
}

/** points a team gained at this hand end = base (if winner) + its bonuses (early bonuses were credited before) */
function delta(ev: Extract<GameEvent, { type: 'handEnd' }>, team: 0 | 1): number {
  // points held abajo never reached the scores; a claimed pot did
  const won = ev.winnerTeam === team && ev.abajoAdded === undefined ? ev.points + (ev.abajoClaimed ?? 0) : 0;
  return won + ev.bonuses.filter((b) => b.team === team && !b.abajo).reduce((a, b) => a + b.points, 0);
}

/** individual: the scores by seat before this hand end (the winner's base points and bonuses taken off) */
function soloPrev(ev: Extract<GameEvent, { type: 'handEnd' }>): number[] {
  const out = (ev.seatScores ?? [0, 0, 0, 0]).slice();
  if (ev.winnerSeat !== null) out[ev.winnerSeat] -= ev.points;
  for (const b of ev.bonuses) if (b.seat !== undefined) out[b.seat] -= b.points;
  return out.map((v) => Math.max(0, v));
}

/** individual: tiles left in the boneyard while drawing is on (null = no chip) */
function pileOf(m: MatchState): number | null {
  const h = m.hand;
  if (m.mode !== 'individual' || m.rules.boneyardDraw === false || !h || h.over || !h.boneyard?.length) return null;
  return h.boneyard.length;
}
