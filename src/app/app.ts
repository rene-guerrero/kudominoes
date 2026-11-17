import type { AppSettings, Bonus, EngineApi, GameEvent, Lineup, MatchState, Seat, SfxName, TableView, TableViewOptions } from '../contracts';
import { character, profileOf, randomLineup } from '../roster';
import { hapticTick, playSfx, setAudioPrefs, setAudioSuspended } from '../audio/sfx';
import { buildHowto } from '../ui/howto';
import { Hud } from '../ui/hud';
import { loc, setLang, t, type Key } from '../ui/i18n';
import { buildMenu } from '../ui/menu';
import { confirmDialog, Overlay } from '../ui/overlay';
import { buildSettings, presetName, type SettingsTab } from '../ui/settings';
import { buildNewGame } from '../ui/newgame';
import { setTileTheme } from '../ui/tiles';
import { buildHandSummary, buildMatchEnd, buildPause, buildStarterChooser } from '../ui/summary';
import { prefersReducedMotion, setReducedMotionPref } from '../ui/dom';
import { AvatarController } from '../ui/avatars';
import { SeatPlates } from '../ui/plates';
import { GameSession, type SessionHooks } from './controller';
import { clearSave, loadSave, saveGame } from './save';
import { findTarget, RANDOM, sanitizeLineupSetting, saveSettings } from './settings';

type Names = [string, string, string, string];

export interface AppDeps {
  engine: EngineApi;
  createTableView(opts: TableViewOptions): TableView;
  settings: AppSettings;
  overlay: Overlay;
  tableEl: HTMLElement;
}

type ScreenName = 'menu' | 'settings' | 'howto' | 'game' | 'newgame';

export class App {
  private engine: EngineApi;
  private settings: AppSettings;
  private overlay: Overlay;
  private hud: Hud;
  private view!: TableView;
  private viewNames: Names | null = null;
  private session: GameSession | null = null;
  private screen: ScreenName = 'menu';
  private closePause: (() => void) | null = null;
  private returnToPause = false;
  private sfxMuted = false;
  private names: Names;
  private rulesNoticePending = false;
  private avatars = new AvatarController();
  private plates = new SeatPlates(this.avatars);
  /** the characters of the match being played (from the new-game sheet or the save) */
  private lineup: Lineup;

  constructor(private deps: AppDeps) {
    this.engine = deps.engine;
    this.settings = deps.settings;
    this.overlay = deps.overlay;
    this.lineup = resolveLineup(sanitizeLineupSetting(this.settings.lineup));
    this.applyLineupFaces();
    this.names = this.computeNames();
    this.hud = new Hud(() => this.pause());
    // plates under the HUD (the turn pill and top bar stay on top)
    this.overlay.hudLayer.append(this.plates.el, this.hud.el);
    this.avatars.setHumanFace(this.settings.avatarFace ?? 0);
    this.plates.setAvatars(this.settings.avatars !== false);
    this.avatars.setReducedMotion(prefersReducedMotion());
    this.ensureView();
    this.bindGlobal();
  }

  /** seats 1..3 wear their characters' faces */
  private applyLineupFaces(): void {
    for (const s of [1, 2, 3] as const) this.avatars.setSeatFace(s, character(this.lineup[s]).face);
  }

  // ───────────────────────── view ─────────────────────────

  private computeNames(): Names {
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
    });
    this.viewNames = names;
  }

  // ───────────────────────── screens ─────────────────────────

  showMenu(): void {
    this.screen = 'menu';
    this.hud.show(false);
    const s = loadSave();
    const save = s ? { hand: s.match.hand?.handNo ?? 0, us: s.match.scores[0], them: s.match.scores[1] } : null;
    this.overlay.showScreen(
      buildMenu({
        save,
        onPlay: () => void this.onPlay(!!s),
        onContinue: () => this.continueSaved(),
        onSettings: () => this.showSettings(),
        onHowto: () => this.showHowto(),
      }),
    );
  }

  private showSettings(tab?: SettingsTab): void {
    const from = this.screen;
    this.screen = 'settings';
    const back = () => {
      if (from === 'game') this.backToPause();
      else if (from === 'newgame') this.showNewGame();
      else this.showMenu();
    };
    if (tab) this.settings = { ...this.settings, settingsTab: tab };
    const build = () =>
      buildSettings({
        settings: this.settings,
        ruleDescriptors: this.engine.RULE_SETTINGS,
        defaultRules: this.engine.DEFAULT_RULES,
        presets: this.engine.RULE_PRESETS ?? [],
        matchInProgress: !!this.session || !!loadSave(),
        confirm: (o) => confirmDialog(this.overlay, o),
        onChange: (next, key) => {
          this.settings = next;
          saveSettings(next);
          this.applySetting(key);
          if (key === 'rules' && from === 'game') this.rulesNoticePending = true;
          if (key === 'language') this.overlay.showScreen(build());
        },
        onBack: back,
      });
    this.returnToPause = from === 'game';
    this.overlay.showScreen(build());
  }

  private showHowto(): void {
    const from = this.screen;
    this.screen = 'howto';
    this.returnToPause = from === 'game';
    this.overlay.showScreen(buildHowto(() => (from === 'game' ? this.backToPause() : this.showMenu())));
  }

  /** the new-game sheet: pick the partner and the two rivals, the rules preset, Comenzar */
  private showNewGame(): void {
    this.screen = 'newgame';
    this.overlay.showScreen(
      buildNewGame({
        lineup: sanitizeLineupSetting(this.settings.lineup),
        avatars: this.settings.avatars !== false,
        humanFace: this.settings.avatarFace ?? 0,
        humanName: this.settings.playerName || t('seat.you'),
        tableStyle: this.settings.tableStyle ?? 'green',
        presetName: presetName(this.engine.RULE_PRESETS ?? [], this.settings.rules),
        onChange: (lineup) => {
          this.settings = { ...this.settings, lineup };
          saveSettings(this.settings);
        },
        onRules: () => this.showSettings('rules'),
        onStart: (lineup) => {
          clearSave();
          this.startMatch(this.engine.createMatch({ ...this.settings.rules }), false, resolveLineup(lineup));
        },
        onBack: () => this.showMenu(),
      }),
    );
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
        this.view.setQuality(s.quality);
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
    if (hasSave) {
      const ok = await confirmDialog(this.overlay, {
        title: t('menu.newConfirmTitle'),
        body: t('menu.newConfirmBody'),
        ok: t('menu.newConfirmOk'),
        cancel: t('common.cancel'),
        danger: true,
      });
      if (!ok) return;
    }
    this.showNewGame();
  }

  private continueSaved(): void {
    const s = loadSave();
    if (!s) return this.showMenu();
    this.startMatch(s.match, true, s.lineup);
  }

  private startMatch(match: MatchState, resume: boolean, lineup: Lineup): void {
    this.stopSession();
    this.lineup = { ...lineup };
    this.applyLineupFaces();
    this.ensureView();
    this.view.reset();
    this.overlay.closeAllModals();
    this.overlay.showScreen(null);
    this.screen = 'game';
    this.hud.reset();
    this.plates.clearBubbles();
    this.avatars.reset();
    this.avatars.setPaused(false);
    this.avatars.setHold(false);
    this.hud.setScores(match.scores);
    this.hud.setTarget(findTarget(this.engine, match.rules));
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
        // a rematch keeps the same characters
        if (res === 'rematch') this.startMatch(this.engine.createMatch({ ...this.settings.rules }), false, this.lineup);
        else if (res === 'menu') this.toMenu();
      })
      .catch((err) => {
        console.error('[kudominoes] game loop crashed', err);
        if (this.session === session) {
          this.session = null;
          this.toMenu();
        }
      });
  }

  private stopSession(): void {
    if (this.session) {
      this.session.cancel();
      this.session = null;
    }
  }

  private toMenu(): void {
    this.stopSession();
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
        levels: ([2, 1, 3] as const).map((s) => ({ name: this.names[s], level: t(`settings.difficulty.${character(lu[s]).level}` as Key), partner: s === 2 })),
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
            this.hud.setEnds(null);
            this.plates.clearBubbles();
            break;
          case 'play':
            this.hud.setEnds(ev.ends);
            break;
          case 'pass':
            this.hud.setEnds(ev.ends);
            // the one and only "Paso" callout, as a bubble on the passer's plate
            if (!replay) this.callout(ev.seat, 'say.pass');
            if (ev.scores) this.hud.setScores(ev.scores, !replay);
            if (!replay && ev.bonus) {
              const team = ev.bonus.team === 0 ? t('team.us') : t('team.them');
              this.hud.notice(t('notice.bonus', { label: loc(ev.bonus.label), n: ev.bonus.points, team }));
            }
            if (!replay && ev.bonusBlocked) this.hud.notice(t('notice.paseSalidaBlocked'));
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
            // rare events nothing else on screen explains get a short notice in the top bar
            if (!replay) {
              if (ev.winnerTeam === null) this.hud.notice(t('notice.void'));
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
        if (!mustPass && h && h.chain.length === 0 && h.handNo === 1 && m.rules.firstStarter === 'double6') this.hud.notice(t('notice.openDouble6'));
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
            { names: this.names, handsWon: match.handsWon, avatars: this.settings.avatars !== false },
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
  return (ev.winnerTeam === team ? ev.points : 0) + ev.bonuses.filter((b) => b.team === team).reduce((a, b) => a + b.points, 0);
}
