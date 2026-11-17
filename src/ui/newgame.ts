import type { GameMode, Lineup, TableStyle } from '../contracts';
import { character, LEVEL_STARS, ROSTER, type Character } from '../roster';
import { tableThumb } from '../render';
import { h, prefersReducedMotion } from './dom';
import { loc, t, type Key } from './i18n';
import { btn, ICONS, segmented } from './overlay';
import { screenHeader } from './howto';
import { liveFace, staticFace } from './avatars';

type Slot = 1 | 2 | 3;
type Opp = 1 | 2 | 3;
/** pairs: partner first (the default active seat), then rival 1 (right, seat 1) and rival 2 (left, seat 3) */
const SLOTS: Slot[] = [2, 1, 3];
const PICK_TITLE: Record<Slot, Key> = { 2: 'newgame.pickPartner', 1: 'newgame.pickRival1', 3: 'newgame.pickRival2' };
/** individual: the opponents' seats by count, in turn order (1 opponent sits across, 2 at the sides) */
const SOLO_SLOTS: Record<Opp, Slot[]> = { 1: [2], 2: [1, 3], 3: [1, 2, 3] };
const SOLO_TITLES: Key[] = ['newgame.pickRival1', 'newgame.pickRival2', 'newgame.pickRival3'];

const DICE =
  '<svg viewBox="0 0 48 48" aria-hidden="true" focusable="false"><rect x="7" y="7" width="34" height="34" rx="9" fill="#FFF6E6" stroke="#2A160D" stroke-width="2.5"/><circle cx="16.5" cy="16.5" r="3.4" fill="#2A160D"/><circle cx="24" cy="24" r="3.4" fill="#2A160D"/><circle cx="31.5" cy="31.5" r="3.4" fill="#2A160D"/><circle cx="31.5" cy="16.5" r="3.4" fill="#2A160D"/><circle cx="16.5" cy="31.5" r="3.4" fill="#2A160D"/></svg>';
const SPARK = '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8 1.5 9.6 6.4 14.5 8 9.6 9.6 8 14.5 6.4 9.6 1.5 8 6.4 6.4Z" fill="currentColor"/></svg>';

const levelLabel = (c: Character) => t(`settings.difficulty.${c.level}` as Key);

/** stars for easy/normal/hard (1–3 of 3); the master level gets its own badge */
export function levelBadge(c: Character): HTMLElement {
  const aria = t('newgame.level', { level: levelLabel(c) });
  if (c.level === 'master') return h('span.lvl.master', { 'aria-label': aria, title: aria }, h('span.lvl-spark', { html: SPARK }), levelLabel(c));
  const n = LEVEL_STARS[c.level];
  return h(
    'span.lvl',
    { 'aria-label': aria, title: aria },
    ...[1, 2, 3].map((i) => h('span.star', { class: i <= n ? 'on' : '', 'aria-hidden': 'true' }, '★')),
  );
}

export interface NewGameStart {
  mode: GameMode;
  /** the characters in seats 1..3 (individual: the seats not in play hold unused characters) */
  lineup: Lineup;
  /** 4 in pairs; 2–4 in individual */
  players: 2 | 3 | 4;
}

export interface NewGameOpts {
  /** the mode chosen last time */
  mode: GameMode;
  /** last pairs selection (character ids; a stored 'random' is drawn here) */
  lineup: Lineup;
  /** last individual selection: number of opponents and the opponents in order */
  soloOpponents: Opp;
  soloLineup: string[];
  avatars: boolean;
  /** the human's face index and name for the bottom seat */
  humanFace: number;
  humanName: string;
  tableStyle: TableStyle;
  /** the rules preset name of a mode ("Cubano clásico" / "Personalizado") */
  presetName(mode: GameMode): string;
  onChange(l: Lineup): void;
  onSoloChange(list: string[], opponents: Opp): void;
  onMode(mode: GameMode): void;
  onRules(mode: GameMode): void;
  onStart(o: NewGameStart): void;
  onBack(): void;
}

const SHEET_MQ = '(orientation: portrait) and (max-width: 760px)';
/** phone portrait: the grid lives in a bottom sheet */
const sheetMode = () => window.matchMedia(SHEET_MQ).matches;

/**
 * Character selection: the mode switch (Parejas | Individual), a small top-down table with the seats as
 * in the game and one 5×2 grid of all ten characters. Pairs: partner on top, rivals left/right, you at the
 * bottom. Individual: 1–3 opponents (across; at the sides; or all three seats), no partner. Tap a seat to
 * make it active, tap a character to seat it there; a character seated elsewhere swaps seats. On wide
 * layouts the grid sits beside the table; on a phone in portrait it slides up as a bottom sheet.
 */
export function buildNewGame(o: NewGameOpts): HTMLElement {
  // a stored 'random' (older choice) is resolved now: the seats always show real characters
  const pool = ROSTER.map((c) => c.id);
  const seen = new Set<string>();
  const fix = (id: string) => {
    const v = pool.includes(id) && !seen.has(id) ? id : (pool.find((x) => !seen.has(x) && !Object.values(o.lineup).includes(x)) ?? pool.find((x) => !seen.has(x))!);
    seen.add(v);
    return v;
  };
  const l2 = fix(o.lineup[2]);
  const l1 = fix(o.lineup[1]);
  const l3 = fix(o.lineup[3]);
  let lu: Lineup = { 1: l1, 2: l2, 3: l3 };
  // individual: three distinct opponents in order (only the first `opp` play)
  const sl: string[] = [];
  for (const id of [...o.soloLineup, 'carlos', 'rosa', 'andres', ...pool]) if (pool.includes(id) && !sl.includes(id) && sl.length < 3) sl.push(id);
  let opp: Opp = o.soloOpponents;
  let mode: GameMode = o.mode;

  const slots = (): Slot[] => (mode === 'pairs' ? SLOTS : SOLO_SLOTS[opp]);
  const idAt = (s: Slot): string => (mode === 'pairs' ? lu[s] : sl[SOLO_SLOTS[opp].indexOf(s)]);
  const titleOf = (s: Slot): Key => (mode === 'pairs' ? PICK_TITLE[s] : opp === 1 ? 'newgame.pickRival' : SOLO_TITLES[SOLO_SLOTS[opp].indexOf(s)]);
  let active: Slot = slots()[0];
  let shown: string = idAt(active); // the character described under the grid

  // ── table with seats ──
  const felt = h('div.ng-table', { role: 'group', 'aria-label': t('newgame.players') });
  const seatEls = new Map<Slot, { btn: HTMLButtonElement; face: HTMLElement; name: HTMLElement; meta: HTMLElement }>();
  const faceNode = (c: Character, live: boolean): HTMLElement =>
    o.avatars ? h('span.face-static', live ? liveFace(c.face, 'idle').el : staticFace(c.face, 'idle')) : h('span.ng-letter', c.name.slice(0, 1));
  for (const s of SLOTS) {
    const face = h('span.ng-seat-face');
    const name = h('span.ng-seat-name');
    const meta = h('span.ng-seat-meta');
    const b = h('button.ng-seat', { type: 'button', class: `pos-${s === 2 ? 'top' : s === 1 ? 'right' : 'left'}` }, face, name, meta);
    b.addEventListener('click', () => {
      setActive(s);
      if (sheetMode()) openSheet();
    });
    seatEls.set(s, { btn: b, face, name, meta });
    felt.append(b);
  }
  const me = h(
    'div.ng-seat.pos-bottom.us.me',
    h('span.ng-seat-face', o.avatars ? h('span.face-static', staticFace(o.humanFace, 'idle')) : h('span.ng-letter', o.humanName.slice(0, 1))),
    h('span.ng-seat-name', o.humanName),
  );
  felt.append(me);
  // the felt wears the current table look (frame + cloth), re-rendered at its real size
  const paintFelt = () => {
    const r = felt.getBoundingClientRect();
    if (r.width < 20 || r.height < 20) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    // same proportions as the thumbnail: frame = 10 %, corner radius = 12 % of the short side
    const u = Math.min(r.width, r.height);
    felt.style.setProperty('--fr', `${Math.max(3, Math.round(u * 0.1))}px`);
    felt.style.borderRadius = `${u * 0.12}px`;
    felt.style.backgroundImage = `url(${tableThumb(o.tableStyle, Math.round((r.width * dpr) / 8) * 8, Math.round((r.height * dpr) / 8) * 8)})`;
  };
  // the table keeps a table-like shape inside whatever room it has (portrait: taller, landscape: wider)
  const fitFelt = () => {
    const box = felt.parentElement;
    if (!box) return;
    const W = box.clientWidth;
    const H = box.clientHeight;
    if (W < 20 || H < 20) return;
    const aspect = sheetMode() ? 0.74 : 1.12; // width / height
    let w = Math.min(W, 560);
    let hh = w / aspect;
    if (hh > H) {
      hh = H;
      w = hh * aspect;
    }
    felt.style.width = `${Math.round(w)}px`;
    felt.style.height = `${Math.round(hh)}px`;
  };
  const feltRo = new ResizeObserver(() => {
    if (!felt.isConnected) return void feltRo.disconnect();
    fitFelt();
    paintFelt();
  });
  feltRo.observe(felt);

  const renderSeat = (s: Slot) => {
    const el = seatEls.get(s)!;
    const inUse = slots().includes(s);
    el.btn.hidden = !inUse;
    if (!inUse) return;
    const partner = mode === 'pairs' && s === 2;
    el.btn.classList.toggle('us', partner);
    el.btn.classList.toggle('them', !partner);
    const c = character(idAt(s));
    el.face.replaceChildren(faceNode(c, true));
    el.name.textContent = c.name;
    const role = partner ? t('newgame.rolePartner') : t('role.rival');
    el.meta.replaceChildren(c.level === 'master' ? levelBadge(c) : h('span', `${role} · ${levelLabel(c)}`));
    el.btn.setAttribute('aria-label', `${t(titleOf(s))}: ${c.name}, ${levelLabel(c)}`);
  };
  const renderSeats = () => {
    for (const s of SLOTS) renderSeat(s);
    felt.classList.toggle('solo', mode === 'individual');
    felt.dataset.opp = mode === 'individual' ? String(opp) : '';
  };

  // ── grid of characters ──
  const title = h('h3.ng-pick-title');
  const grid = h('div.ng-grid', { role: 'listbox', 'aria-label': t('newgame.players') });
  const desc = h('p.ng-desc', { 'aria-live': 'polite' });
  const describe = (id: string) => {
    shown = id;
    const c = character(id);
    desc.replaceChildren(h('strong', c.name), h('span.ng-desc-style', ` · ${loc(c.tag)}. `), loc(c.desc));
  };
  const cells = ROSTER.map((c) => {
    const tag = h('span.ng-cell-seat');
    const b = h(
      'button.ng-cell',
      { type: 'button', role: 'option', 'aria-label': `${c.name} · ${levelLabel(c)} · ${loc(c.tag)}`, class: c.level === 'master' ? 'is-master' : '' },
      h('span.ng-cell-face', o.avatars ? h('span.face-static', staticFace(c.face, 'idle')) : h('span.ng-letter', c.name.slice(0, 1))),
      h('span.ng-cell-name', h('span.nm-full', c.name), h('span.nm-short', c.short ?? c.name)),
      levelBadge(c),
      tag,
    );
    b.addEventListener('click', () => pick(c.id));
    b.addEventListener('pointerenter', (e) => {
      if (e.pointerType === 'mouse') describe(c.id);
    });
    b.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse') describe(idAt(active));
    });
    b.addEventListener('focus', () => describe(c.id));
    b.addEventListener('keydown', (e) => {
      const i = ROSTER.indexOf(c);
      const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowDown' ? 5 : e.key === 'ArrowUp' ? -5 : 0;
      if (!d) return;
      e.preventDefault();
      const j = i + d;
      if (j >= 0 && j < ROSTER.length) cells[j].b.focus();
    });
    grid.append(b);
    return { id: c.id, b, tag };
  });

  const refresh = () => {
    for (const s of SLOTS) {
      const el = seatEls.get(s)!;
      el.btn.classList.toggle('active', s === active);
      el.btn.setAttribute('aria-pressed', String(s === active));
    }
    title.textContent = t(titleOf(active));
    for (const cell of cells) {
      const seat = slots().find((s) => idAt(s) === cell.id) ?? null;
      const here = seat === active;
      cell.b.setAttribute('aria-selected', String(here));
      cell.b.classList.toggle('elsewhere', seat !== null && !here);
      cell.tag.textContent = seat !== null && !here ? (mode === 'pairs' && seat === 2 ? t('newgame.rolePartner') : t('role.rival')) : '';
    }
    describe(shown);
  };

  const setActive = (s: Slot) => {
    active = s;
    shown = idAt(s);
    refresh();
  };

  const bump = (s: Slot) => {
    if (prefersReducedMotion()) return;
    seatEls.get(s)!.face.animate([{ transform: 'scale(.82)' }, { transform: 'scale(1.06)', offset: 0.6 }, { transform: 'scale(1)' }], { duration: 320, easing: 'ease-out' });
  };

  const emit = () => {
    if (mode === 'pairs') o.onChange({ ...lu });
    else o.onSoloChange(sl.slice(), opp);
  };

  const pick = (id: string) => {
    const prev = idAt(active);
    if (prev !== id) {
      let other: Slot | null;
      if (mode === 'pairs') {
        other = SLOTS.find((s) => lu[s] === id) ?? null;
        const next = { ...lu };
        // never a dead end: a character seated elsewhere swaps with the active seat's character
        if (other !== null) next[other] = prev;
        next[active] = id;
        lu = next;
      } else {
        // the three remembered opponents stay distinct: swap places in the list
        const ai = SOLO_SLOTS[opp].indexOf(active);
        const oi = sl.indexOf(id);
        if (oi >= 0) sl[oi] = prev;
        sl[ai] = id;
        other = oi >= 0 && oi < opp ? SOLO_SLOTS[opp][oi] : null;
      }
      renderSeat(active);
      if (other !== null) renderSeat(other);
      emit();
      bump(active);
      if (other !== null) bump(other);
    }
    shown = id;
    refresh();
    if (sheetMode()) closeSheet();
  };

  // ── mode switch (Parejas | Individual) and the number of opponents ──
  const oppCtl = h('div.ng-opp', h('span.ng-opp-label', t('newgame.opponents')));
  const oppSeg = segmented<number>(
    [1, 2, 3].map((n) => ({ value: n, label: String(n) })),
    opp,
    (v) => {
      opp = v as Opp;
      active = slots()[0];
      shown = idAt(active);
      renderSeats();
      refresh();
      emit();
    },
    t('newgame.opponentsAria'),
  );
  oppSeg.classList.add('seg-opp');
  oppCtl.append(oppSeg);
  const rulesValue = h('span.preset-v');
  const modeSeg = segmented<GameMode>(
    (['pairs', 'individual'] as GameMode[]).map((m) => ({ value: m, label: t(`mode.${m}` as Key) })),
    mode,
    (v) => {
      mode = v;
      active = slots()[0];
      shown = idAt(active);
      applyMode();
      renderSeats();
      refresh();
      o.onMode(mode);
    },
    t('mode.label'),
  );
  modeSeg.classList.add('seg-mode');
  const modeRow = h('div.ng-mode', modeSeg, oppCtl);
  const applyMode = () => {
    oppCtl.hidden = mode !== 'individual';
    rulesValue.textContent = o.presetName(mode);
  };

  // ── bottom sheet (phone portrait) ──
  const scrim = h('div.ng-scrim');
  const handle = h('div.ng-handle', { 'aria-hidden': 'true' });
  const pickPanel = h('section.ng-pick', handle, title, grid, desc);
  let sheetOpen = false;
  let root: HTMLElement;
  const openSheet = () => {
    sheetOpen = true;
    pickPanel.classList.add('open');
    scrim.classList.add('open');
    root.classList.add('sheet-open');
    requestAnimationFrame(() => (cells.find((c) => c.id === idAt(active))?.b ?? cells[0].b).focus({ preventScroll: true }));
  };
  const closeSheet = () => {
    if (!sheetOpen) return;
    sheetOpen = false;
    pickPanel.classList.remove('open');
    scrim.classList.remove('open');
    root.classList.remove('sheet-open');
    pickPanel.style.transform = '';
    seatEls.get(active)!.btn.focus({ preventScroll: true });
  };
  scrim.addEventListener('click', closeSheet);
  // swipe the sheet down (from its handle / title) to close it
  let drag: { y: number; id: number } | null = null;
  pickPanel.addEventListener('pointerdown', (e) => {
    if (!sheetOpen || !(e.target === handle || e.target === title || e.target === pickPanel)) return;
    drag = { y: e.clientY, id: e.pointerId };
    pickPanel.setPointerCapture(e.pointerId);
    pickPanel.style.transition = 'none';
  });
  pickPanel.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    pickPanel.style.transform = `translateY(${Math.max(0, e.clientY - drag.y)}px)`;
  });
  const endDrag = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = e.clientY - drag.y;
    drag = null;
    pickPanel.style.transition = '';
    pickPanel.style.transform = '';
    if (dy > 60) closeSheet();
  };
  pickPanel.addEventListener('pointerup', endDrag);
  pickPanel.addEventListener('pointercancel', endDrag);
  // Escape / Android back close the sheet first (before the app's "back to menu")
  const onKey = (e: KeyboardEvent) => {
    if (!root.isConnected) return void window.removeEventListener('keydown', onKey, true);
    if (sheetOpen && (e.key === 'Escape' || e.key === 'GoBack' || e.key === 'BrowserBack')) {
      e.stopImmediatePropagation();
      e.preventDefault();
      closeSheet();
    }
  };
  window.addEventListener('keydown', onKey, true);
  window.matchMedia(SHEET_MQ).addEventListener?.('change', () => closeSheet());

  // ── footer: rules line + Sorpréndeme + Comenzar ──
  const rulesLink = h('button.link-btn', { type: 'button' }, t('newgame.change'));
  rulesLink.addEventListener('click', () => o.onRules(mode));
  const rulesLine = h('div.ng-rules', h('span.preset-k', `${t('newgame.rules')}:`), rulesValue, h('span.ng-dot', '·'), rulesLink);
  let shuffling = 0;
  const draw = (): string[] => {
    const p = ROSTER.map((c) => c.id);
    const d = () => p.splice(Math.floor(Math.random() * p.length), 1)[0];
    return [d(), d(), d()];
  };
  const surprise = btn(
    t('newgame.surprise'),
    () => {
      const settle = () => {
        const ids = draw();
        if (mode === 'pairs') lu = { 1: ids[0], 2: ids[1], 3: ids[2] };
        else sl.splice(0, 3, ...ids);
        renderSeats();
        shown = idAt(active);
        refresh();
        emit();
        for (const s of slots()) bump(s);
      };
      if (prefersReducedMotion()) return settle();
      // a short shuffle: the seats flick through faces before they settle
      const my = ++shuffling;
      let n = 0;
      const step = () => {
        if (my !== shuffling || !root.isConnected) return;
        if (++n >= 7) return settle();
        const tmp = draw();
        slots().forEach((s, i) => {
          const el = seatEls.get(s)!;
          el.face.replaceChildren(faceNode(character(tmp[i]), false));
          el.name.textContent = character(tmp[i]).name;
        });
        setTimeout(step, 60 + n * 14);
      };
      step();
    },
    'ghost ng-surprise',
    h('span.btn-icon', { html: DICE }),
  );
  const start = btn(
    t('newgame.start'),
    () => {
      if (mode === 'pairs') return o.onStart({ mode, lineup: { ...lu }, players: 4 });
      // seats in play get the chosen opponents; the others hold unused characters (never seen)
      const used = new Set(SOLO_SLOTS[opp].map((s) => idAt(s)));
      const spare = pool.filter((id) => !used.has(id));
      const l = { 1: '', 2: '', 3: '' } as Lineup;
      for (const s of SLOTS) l[s] = SOLO_SLOTS[opp].includes(s) ? idAt(s) : spare.shift()!;
      o.onStart({ mode, lineup: l, players: (opp + 1) as 2 | 3 | 4 });
    },
    'primary ng-start',
    h('span.btn-icon', { html: ICONS.play }),
  );
  start.dataset.autofocus = '';
  const foot = h('div.ng-foot', rulesLine, h('div.ng-buttons', surprise, start));

  const feltBox = h('div.ng-felt-box', felt);
  const left = h('div.ng-left', modeRow, feltBox);
  feltRo.observe(feltBox);
  root = h(
    'section.screen.panel-screen.newgame.ng2',
    screenHeader(t('newgame.title'), o.onBack),
    h('div.ng-body', left, h('div.ng-right', pickPanel, foot)),
    scrim,
  );
  applyMode();
  renderSeats();
  refresh();
  return root;
}
