import type { FaceSpec } from 'kuavatars/faces';
/**
 * Online play screens and cards: the "Jugar en línea" screen (create / join), the room lobby (the same
 * table-with-seats look as the new-game screen), the seat sheet (sit here or pick a CPU character),
 * the room rules sheet, the in-game menu (the match keeps going) and the quick-phrase grid.
 * Pure builders: the online controller (src/app/online.ts) owns the state and the connection.
 */
import type { GameMode, RuleSettings, Seat, TableStyle } from '../contracts';
import { canFullscreen } from '../app/fullscreen';
import type { PublicRoom, QuickPhraseId, SeatOccupant } from '../net/protocol';
import { QUICK_PHRASES, ROOM_CODE_LENGTH, MAX_NAME_LENGTH } from '../net/protocol';
import { Perspective } from '../net/perspective';
import { displayCode, filterCodeChars } from '../net/identity';
import { character, ROSTER } from '../roster';
import { tableThumb } from '../render';
import { h } from './dom';
import { loc, t, type Key } from './i18n';
import { btn, ICONS, segmented } from './overlay';
import { screenHeader } from './howto';
import { staticFace } from './avatars';
import { levelBadge } from './newgame';
import { audioToggle, fullscreenToggle, type AudioKey } from './summary';
import { SEATS_FOR } from '../contracts';

export const ONLINE_ICONS = {
  globe:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.6" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M3.6 12h16.8M12 3.4c2.4 2.4 3.6 5.3 3.6 8.6s-1.2 6.2-3.6 8.6c-2.4-2.4-3.6-5.3-3.6-8.6s1.2-6.2 3.6-8.6z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"/></svg>',
  share:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="18" cy="5.5" r="2.6"/><circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="18.5" r="2.6"/><path d="M8.3 10.8l7.4-4M8.3 13.2l7.4 4" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
  chat: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5.5h14a2 2 0 0 1 2 2v7.2a2 2 0 0 1-2 2h-7.4L7 20v-3.3H5a2 2 0 0 1-2-2V7.5a2 2 0 0 1 2-2z"/><circle cx="8.4" cy="11.1" r="1.25" fill="#2a160d"/><circle cx="12" cy="11.1" r="1.25" fill="#2a160d"/><circle cx="15.6" cy="11.1" r="1.25" fill="#2a160d"/></svg>',
  exit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4.5H6.5A1.5 1.5 0 0 0 5 6v12a1.5 1.5 0 0 0 1.5 1.5H14" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"/><path d="M11 12h9M16.5 8l3.8 4-3.8 4" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

const icon = (svg: string) => h('span.btn-icon', { html: svg });

// ───────────────────────── "Jugar en línea" ─────────────────────────

export interface OnlineHomeOpts {
  name: string;
  face: number | FaceSpec;
  avatars: boolean;
  /** prefilled code (from a link that failed, or the last one typed) */
  code?: string;
  onName(name: string): void;
  onCreate(): void;
  onJoin(code: string): void;
  onBack(): void;
}

export interface OnlineHome {
  el: HTMLElement;
  setError(msg: string | null): void;
  setBusy(which: 'create' | 'join' | null): void;
  /** focus the name field (the first time, when there is no name yet) */
  askName(): void;
}

export function buildOnlineHome(o: OnlineHomeOpts): OnlineHome {
  let name = o.name;
  // ── who am I ──
  const faceEl = h('span.oh-face', o.avatars ? h('span.face-static', staticFace(o.face, 'happy')) : h('span.ng-letter', (name || '?').slice(0, 1).toUpperCase()));
  const nameInput = h('input.oh-name-input', {
    type: 'text',
    maxlength: MAX_NAME_LENGTH,
    autocomplete: 'nickname',
    enterkeyhint: 'done',
    spellcheck: 'false',
    placeholder: t('online.namePlaceholder'),
    'aria-label': t('online.nameLabel'),
  }) as HTMLInputElement;
  nameInput.value = name;
  const commitName = () => {
    const v = nameInput.value.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
    nameInput.value = v;
    if (v !== name) {
      name = v;
      o.onName(v);
    }
    if (!o.avatars) faceEl.replaceChildren(h('span.ng-letter', (name || '?').slice(0, 1).toUpperCase()));
    who.classList.toggle('need', !name);
  };
  nameInput.addEventListener('change', commitName);
  nameInput.addEventListener('blur', commitName);
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') nameInput.blur();
  });
  const who = h('label.oh-who', faceEl, h('span.oh-who-text', h('span.oh-who-k', t('online.playingAs')), nameInput));
  who.classList.toggle('need', !name);

  // ── create ──
  const create = btn(t('online.create'), () => guard(() => o.onCreate()), 'primary lg oh-create', icon(ONLINE_ICONS.plus));
  create.dataset.autofocus = '';

  // ── join ──
  const codeInput = h('input.oh-code-input', {
    type: 'text',
    inputmode: 'text',
    autocapitalize: 'characters',
    autocomplete: 'off',
    autocorrect: 'off',
    spellcheck: 'false',
    enterkeyhint: 'go',
    maxlength: ROOM_CODE_LENGTH + 5,
    placeholder: '••••',
    'aria-label': t('online.codeLabel'),
  }) as HTMLInputElement;
  codeInput.value = filterCodeChars(o.code ?? '');
  const join = btn(t('online.join'), () => guard(() => o.onJoin(codeInput.value)), 'secondary oh-join');
  const syncJoin = () => (join.disabled = codeInput.value.length !== ROOM_CODE_LENGTH || busy !== null);
  codeInput.addEventListener('input', () => {
    // auto upper-case, alphabet only; a pasted "KUDO-7KQM" or link keeps just the code
    let v = codeInput.value.toUpperCase();
    const m = /KUDO-?([A-Z0-9]{4})/.exec(v) ?? /SALA=([A-Z0-9]{4})/.exec(v);
    if (m) v = m[1];
    const f = filterCodeChars(v);
    if (f !== codeInput.value) codeInput.value = f;
    setError(null);
    syncJoin();
  });
  codeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !join.disabled) join.click();
  });
  const codeBox = h('label.oh-code', h('span.oh-code-prefix', 'KUDO-'), codeInput);

  const err = h('p.oh-error', { role: 'alert', 'aria-live': 'assertive' });
  err.hidden = true;
  let busy: 'create' | 'join' | null = null;

  const guard = (fn: () => void) => {
    commitName();
    if (!name) {
      setError(t('online.nameNeeded'));
      nameInput.focus();
      return;
    }
    if (busy) return;
    fn();
  };
  const setError = (msg: string | null) => {
    err.hidden = !msg;
    err.textContent = msg ?? '';
  };
  const setBusy = (which: 'create' | 'join' | null) => {
    busy = which;
    create.classList.toggle('is-loading', which === 'create');
    join.classList.toggle('is-loading', which === 'join');
    create.disabled = which !== null;
    syncJoin();
  };
  syncJoin();

  const el = h(
    'section.screen.panel-screen.online-home',
    screenHeader(t('online.title'), o.onBack),
    h(
      'div.scroll.oh-scroll',
      h(
        'div.oh-body',
        h('p.oh-intro', t('online.intro')),
        who,
        create,
        h('div.oh-or', h('span', t('online.or'))),
        h('div.oh-join-row', codeBox, join),
        err,
      ),
    ),
  );
  return {
    el,
    setError,
    setBusy,
    askName: () => requestAnimationFrame(() => nameInput.focus({ preventScroll: true })),
  };
}

// ───────────────────────── lobby ─────────────────────────

export interface LobbyOpts {
  code: string;
  avatars: boolean;
  tableStyle: TableStyle;
  myId: string;
  presetName(mode: GameMode, rules: RuleSettings): string;
  onShare(): void;
  onSeat(seat: Seat): void;
  onMode(mode: GameMode, count: number): void;
  onRules(): void;
  onStart(): void;
  onLeave(): void;
}

export interface Lobby {
  el: HTMLElement;
  update(room: PublicRoom, me: { seat: Seat | null; isHost: boolean }): void;
  /** connection line under the code ('' = connected) */
  setConn(text: string): void;
  flashCopied(): void;
}

const POS = ['bottom', 'right', 'top', 'left'] as const;

export function activeSeatsOf(room: Pick<PublicRoom, 'mode' | 'playerCount'>): Seat[] {
  return room.mode === 'pairs' ? [0, 1, 2, 3] : SEATS_FOR[Math.max(2, Math.min(4, room.playerCount)) as 2 | 3 | 4].slice();
}

export function occupantName(o: SeatOccupant): string {
  if (o.kind === 'human') return o.name || t('seat.player');
  if (o.kind === 'cpu') return character(o.characterId).name;
  return t('lobby.free');
}

export function buildLobby(o: LobbyOpts): Lobby {
  // ── table ──
  const felt = h('div.ng-table.lobby-table', { role: 'group', 'aria-label': t('newgame.players') });
  const seatEls = POS.map((pos) => {
    const face = h('span.ng-seat-face');
    const name = h('span.ng-seat-name');
    const meta = h('span.ng-seat-meta');
    const b = h('button.ng-seat', { type: 'button', class: `pos-${pos}` }, face, name, meta);
    felt.append(b);
    return { b, face, name, meta, serverSeat: 0 as Seat };
  });
  seatEls.forEach((s) => s.b.addEventListener('click', () => o.onSeat(s.serverSeat)));
  const paintFelt = () => {
    const r = felt.getBoundingClientRect();
    if (r.width < 20 || r.height < 20) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const u = Math.min(r.width, r.height);
    felt.style.setProperty('--fr', `${Math.max(3, Math.round(u * 0.1))}px`);
    felt.style.borderRadius = `${u * 0.12}px`;
    felt.style.backgroundImage = `url(${tableThumb(o.tableStyle, Math.round((r.width * dpr) / 8) * 8, Math.round((r.height * dpr) / 8) * 8)})`;
  };
  const fitFelt = () => {
    const box = felt.parentElement;
    if (!box) return;
    const W = box.clientWidth;
    const H = box.clientHeight;
    if (W < 20 || H < 20) return;
    const aspect = Math.max(0.72, Math.min(1.35, W / H));
    let w = Math.min(W, 560);
    let hh = w / aspect;
    if (hh > H) {
      hh = H;
      w = hh * aspect;
    }
    felt.style.width = `${Math.round(w)}px`;
    felt.style.height = `${Math.round(hh)}px`;
  };
  const feltBox = h('div.ng-felt-box.lobby-felt-box', felt);
  const ro = new ResizeObserver(() => {
    if (!felt.isConnected) return void ro.disconnect();
    fitFelt();
    paintFelt();
  });
  ro.observe(feltBox);
  ro.observe(felt);

  // ── code card ──
  const share = btn(t('lobby.share'), o.onShare, 'secondary lobby-share', icon(ONLINE_ICONS.share));
  const copied = h('span.lobby-copied', { role: 'status', 'aria-live': 'polite' });
  const conn = h('span.lobby-conn', { role: 'status', 'aria-live': 'polite' });
  const codeCard = h(
    'div.lobby-code',
    h('div.lobby-code-text', h('span.lobby-code-k', t('lobby.code')), h('span.lobby-code-v', displayCode(o.code)), h('span.lobby-sub', copied, conn)),
    share,
  );

  // ── mode, rules, start ──
  const modeRow = h('div.ng-mode.lobby-mode');
  const status = h('p.lobby-status');
  const rulesValue = h('span.preset-v');
  const rulesLink = h('button.link-btn', { type: 'button' }, t('newgame.change'));
  rulesLink.addEventListener('click', o.onRules);
  const rulesDot = h('span.ng-dot', '·');
  const rulesLine = h('div.ng-rules', h('span.preset-k', `${t('newgame.rules')}:`), rulesValue, rulesDot, rulesLink);
  const start = btn(t('lobby.start'), o.onStart, 'primary lobby-start', icon(ICONS.play));
  const wait = h('p.lobby-wait', h('span.lobby-wait-dot'), t('lobby.waitHost'));
  const foot = h('div.ng-foot.lobby-foot', rulesLine, status, start, wait);

  let lastModeKey = '';
  const el = h(
    'section.screen.panel-screen.newgame.ng2.lobby',
    screenHeader(t('lobby.title'), o.onLeave),
    h('div.ng-body', h('div.ng-left', modeRow, feltBox), h('div.ng-right', codeCard, foot)),
  );

  const update = (room: PublicRoom, me: { seat: Seat | null; isHost: boolean }) => {
    const act = activeSeatsOf(room);
    // a fixed map of the table (first seat at the bottom): changing seats moves you, not the table.
    // In the game itself the player is always at the bottom.
    const p = new Perspective(act[0], room.mode, act);
    const myPos = me.seat === null ? null : ([0, 1, 2, 3] as Seat[]).find((q) => p.server(q) === me.seat) ?? null;
    for (const pos of [0, 1, 2, 3] as Seat[]) {
      const s = p.server(pos);
      const el = seatEls[pos];
      el.serverSeat = s;
      const used = act.includes(s);
      el.b.hidden = !used;
      if (!used) continue;
      const occ = room.seats[s] ?? { kind: 'empty' };
      const mine = occ.kind === 'human' && occ.playerId === o.myId;
      const partner = myPos === null ? pos === 0 || (room.mode === 'pairs' && pos === 2) : pos === myPos || (room.mode === 'pairs' && (pos + 2) % 4 === myPos);
      el.b.className = `ng-seat pos-${POS[pos]} ${partner ? 'us' : 'them'} occ-${occ.kind}${mine ? ' me' : ''}`;
      if (occ.kind === 'human') {
        el.face.replaceChildren(o.avatars ? h('span.face-static', staticFace(occ.face, 'idle')) : h('span.ng-letter', occupantName(occ).slice(0, 1).toUpperCase()));
        el.name.textContent = occupantName(occ);
        const host = occ.playerId === room.hostId;
        el.meta.replaceChildren(
          h('span.conn-dot', { class: occ.connected ? 'on' : 'off', title: occ.connected ? '' : t('lobby.offline') }),
          h('span', mine ? t('lobby.you') : host ? t('lobby.host') : occ.connected ? '' : t('lobby.offline')),
          ...(mine && host ? [h('span.lobby-host-tag', `· ${t('lobby.host')}`)] : []),
        );
        el.b.setAttribute('aria-label', `${occupantName(occ)}${host ? `, ${t('lobby.host')}` : ''}`);
        el.b.disabled = true;
      } else if (occ.kind === 'cpu') {
        const c = character(occ.characterId);
        el.face.replaceChildren(o.avatars ? h('span.face-static', staticFace(c.face, 'idle')) : h('span.ng-letter', c.name.slice(0, 1)));
        el.name.textContent = c.name;
        el.meta.replaceChildren(levelBadge(c));
        el.b.setAttribute('aria-label', `${c.name}, ${t(`settings.difficulty.${c.level}` as Key)}`);
        el.b.disabled = false;
      } else {
        el.face.replaceChildren(h('span.lobby-empty', { html: ONLINE_ICONS.plus }));
        el.name.textContent = t('lobby.free');
        el.meta.replaceChildren(h('span', me.isHost ? t('lobby.randomCpu') : t('lobby.tapToSit')));
        el.b.setAttribute('aria-label', `${t('lobby.free')}: ${t('lobby.tapToSit')}`);
        el.b.disabled = false;
      }
    }
    // mode row: host = controls; others = a label
    const modeKey = `${me.isHost}|${room.mode}|${room.playerCount}`;
    if (modeKey !== lastModeKey) {
      lastModeKey = modeKey;
      if (me.isHost) {
        const modeSeg = segmented<GameMode>(
          (['pairs', 'individual'] as GameMode[]).map((m) => ({ value: m, label: t(`mode.${m}` as Key) })),
          room.mode,
          (v) => o.onMode(v, v === 'pairs' ? 4 : Math.max(2, Math.min(4, room.playerCount === 4 && room.mode === 'pairs' ? 3 : room.playerCount))),
          t('mode.label'),
        );
        modeSeg.classList.add('seg-mode');
        const cnt = segmented<number>(
          [2, 3, 4].map((n) => ({ value: n, label: String(n) })),
          room.playerCount,
          (v) => o.onMode('individual', v),
          t('newgame.players'),
        );
        cnt.classList.add('seg-opp');
        const opp = h('div.ng-opp', h('span.ng-opp-label', t('newgame.players')), cnt);
        opp.hidden = room.mode !== 'individual';
        modeRow.replaceChildren(modeSeg, opp);
      } else {
        modeRow.replaceChildren(h('span.lobby-mode-label', room.mode === 'pairs' ? t('mode.pairs') : `${t('mode.individual')} · ${room.playerCount}`));
      }
    }
    rulesValue.textContent = o.presetName(room.mode, room.rules);
    rulesLink.hidden = !me.isHost;
    rulesDot.hidden = !me.isHost;
    const humans = act.filter((s) => room.seats[s]?.kind === 'human').length;
    status.textContent = `${humans === 1 ? t('lobby.players1') : t('lobby.players', { n: humans, total: act.length })} · ${t('lobby.cpuNote')}`;
    start.hidden = !me.isHost;
    start.disabled = humans === 0;
    wait.hidden = me.isHost;
  };

  let copiedTimer = 0;
  return {
    el,
    update,
    setConn: (text) => {
      conn.textContent = text;
      el.classList.toggle('net-down', !!text);
    },
    flashCopied: () => {
      copied.textContent = t('lobby.copied');
      clearTimeout(copiedTimer);
      copiedTimer = window.setTimeout(() => (copied.textContent = ''), 2200);
    },
  };
}

// ───────────────────────── seat sheet (host) ─────────────────────────

export function buildSeatSheet(o: {
  current: string | null;
  /** characters already seated elsewhere */
  taken: readonly string[];
  canSit: boolean;
  avatars: boolean;
  onSit(): void;
  onPick(id: string): void;
  onClear(): void;
  onClose(): void;
}): HTMLElement {
  const grid = h('div.ng-grid', { role: 'listbox', 'aria-label': t('lobby.pickCpu') });
  for (const c of ROSTER) {
    const here = c.id === o.current;
    const b = h(
      'button.ng-cell',
      { type: 'button', role: 'option', 'aria-selected': String(here), 'aria-label': `${c.name} · ${loc(c.tag)}`, class: `${c.level === 'master' ? 'is-master' : ''}${o.taken.includes(c.id) ? ' elsewhere' : ''}` },
      h('span.ng-cell-face', o.avatars ? h('span.face-static', staticFace(c.face, 'idle')) : h('span.ng-letter', c.name.slice(0, 1))),
      h('span.ng-cell-name', h('span.nm-full', c.name), h('span.nm-short', c.short ?? c.name)),
      levelBadge(c),
    );
    b.disabled = o.taken.includes(c.id);
    b.addEventListener('click', () => o.onPick(c.id));
    grid.append(b);
  }
  const sit = o.canSit ? btn(t('lobby.sitHere'), o.onSit, 'primary') : null;
  if (sit) sit.dataset.autofocus = '';
  const clear = btn(t('lobby.leaveFree'), o.onClear, 'ghost');
  return h(
    'div.card.seat-sheet',
    h('div.seat-sheet-head', h('h2.card-title', t('lobby.seatTitle')), h('button.icon-btn.seat-sheet-x', { type: 'button', 'aria-label': t('common.close'), html: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>', onclick: () => o.onClose() })),
    sit,
    h('h3.ng-pick-title', t('lobby.pickCpu')),
    grid,
    h('div.row.seat-sheet-foot', clear),
  );
}

// ───────────────────────── rules sheet (host) ─────────────────────────

export function buildRulesSheet(o: { options: { label: string; selected: boolean; onPick(): void }[]; onClose(): void }): HTMLElement {
  return h(
    'div.card.dialog.rules-sheet',
    h('h2.card-title', t('lobby.rulesTitle')),
    h(
      'div.stack.rules-opts',
      ...o.options.map((op) => {
        const b = h('button.btn.rules-opt', { type: 'button', class: op.selected ? 'primary' : 'secondary', 'aria-pressed': String(op.selected) }, h('span.btn-label', op.label));
        b.addEventListener('click', op.onPick);
        return b;
      }),
    ),
    h('div.row', btn(t('common.close'), o.onClose, 'ghost')),
  );
}

// ───────────────────────── in-game menu ─────────────────────────

export function buildOnlinePause(o: { audio: Record<AudioKey, boolean>; onAudio(key: AudioKey, on: boolean): void; onResume(): void; onLeave(): void }): HTMLElement {
  const resume = btn(t('online.backToGame'), o.onResume, 'primary lg', icon(ICONS.play));
  resume.dataset.autofocus = '';
  const canVibrate = typeof navigator.vibrate === 'function';
  return h(
    'div.card.pause.online-pause',
    h('h2.card-title', t('online.menuTitle')),
    h('p.online-pause-note', h('span.live-dot'), t('online.menuNote')),
    h(
      'div.stack',
      resume,
      h(
        'div.pause-grid.pause-icons',
        audioToggle('sound', o.audio.sound, o.onAudio),
        audioToggle('music', o.audio.music, o.onAudio),
        canVibrate ? audioToggle('vibration', o.audio.vibration, o.onAudio) : null,
        canFullscreen() ? fullscreenToggle() : null,
      ),
      btn(t('online.leave'), o.onLeave, 'ghost', icon(ONLINE_ICONS.exit)),
    ),
  );
}

// ───────────────────────── quick phrases ─────────────────────────

export const phraseText = (id: string): string => ((QUICK_PHRASES as readonly string[]).includes(id) ? t(`phrase.${id as QuickPhraseId}` as Key) : '');

export function buildPhraseGrid(onPick: (id: QuickPhraseId) => void): HTMLElement {
  return h(
    'div.qp-grid',
    { role: 'menu', 'aria-label': t('online.phrases') },
    ...QUICK_PHRASES.map((id) => {
      const b = h('button.qp-opt', { type: 'button', role: 'menuitem' }, phraseText(id));
      b.addEventListener('click', () => onPick(id));
      return b;
    }),
  );
}
