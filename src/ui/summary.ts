import type { Bonus, GameEvent, Seat, Team } from '../contracts';
import { countUp, h, prefersReducedMotion } from './dom';
import { canFullscreen, toggleFullscreen } from '../app/fullscreen';
import { loc, t } from './i18n';
import { btn, ICONS } from './overlay';
import { tileSvg } from './tiles';
import { faceOfSeat, staticFace, type AvatarExpr } from './avatars';

type HandEnd = Extract<GameEvent, { type: 'handEnd' }>;
type MatchEnd = Extract<GameEvent, { type: 'matchEnd' }>;

export interface SummaryCtx {
  names: [string, string, string, string];
  handNo: number;
  prevScores: [number, number];
  target: number | null;
  matchOver: boolean;
  speed: number; // 1 normal, <1 faster
  /** show the players' faces (Ajustes → Avatares); default on */
  avatars?: boolean;
  /** individual mode: the seats in play (turn order) and the scores by seat before this hand end */
  seats?: Seat[];
  prevSeatScores?: number[];
}

// ───────────────────────── individual mode ─────────────────────────

/** seats in play from the human, in turn order */
const fromHuman = (seats: readonly Seat[]): Seat[] => {
  const i = Math.max(0, seats.indexOf(0));
  return [...seats.slice(i), ...seats.slice(0, i)];
};

function soloFace(s: Seat, avatars: boolean, names: readonly string[], expr: AvatarExpr): HTMLElement {
  return avatars ? h('span.avatar.has-face', h('span.face-static', staticFace(faceOfSeat(s), expr))) : h('span.avatar', names[s].slice(0, 1).toUpperCase());
}

/** individual: the hand's arithmetic, one short line each (all bonuses belong to the winner) */
function soloCalcLines(ev: HandEnd, names: readonly string[]): { lines: CalcLine[]; scored: number } {
  const lines: CalcLine[] = [];
  let run = 0;
  if (ev.winnerSeat !== null) {
    run = ev.points;
    const raw = ev.rawPips ?? ev.points;
    lines.push({
      text: !ev.rounding || ev.rounding === 'none' ? t('summary.lineOthersNone', { pts: ptsText(ev.points) }) : t('summary.lineOthers', { pips: raw, pts: ptsText(ev.points) }),
    });
    for (const b of ev.bonuses) {
      run += b.points;
      lines.push({ text: b.kind === 'double' ? t('summary.lineCapicua', { n: run }) : `${loc(b.label)} +${b.points} → ${run}` });
    }
  }
  for (const b of ev.earlyBonuses ?? []) lines.push({ text: `${loc(b.label)} +${b.points} · ${names[b.seat ?? 0]} · ${t('summary.early')}`, cls: 'muted' });
  return { lines, scored: run };
}

/** individual: one row per player (face, name, score counting up, a bar toward the target) */
function soloScoreBlock(order: Seat[], names: readonly string[], prev: readonly number[], target: number | null, avatars: boolean) {
  const tgt = target ?? 100;
  const rows = order.map((s) => {
    const num = h('span.big-num', String(prev[s] ?? 0));
    const fill = h('span.fill');
    fill.style.transform = `scaleX(${Math.min(1, (prev[s] ?? 0) / tgt)})`;
    const el = h(
      'div.solo-score-row',
      { class: s === 0 ? 'me' : '' },
      h('span.solo-face', avatars ? h('span.face-static', staticFace(faceOfSeat(s), 'idle')) : h('span.solo-letter', names[s].slice(0, 1).toUpperCase())),
      h('span.score-name', names[s]),
      num,
      h('span.bar', fill),
    );
    return { s, el, num, fill };
  });
  const el = h('div.score-block.solo-block', ...rows.map((r) => r.el), target ? h('div.score-target', t('hud.target', { n: target })) : null);
  const animate = async (to: readonly number[], ms: number) => {
    for (const r of rows) {
      r.fill.style.transition = `transform ${ms}ms cubic-bezier(.2,.8,.2,1)`;
      r.fill.style.transform = `scaleX(${Math.min(1, (to[r.s] ?? 0) / tgt)})`;
    }
    await Promise.all(rows.map((r) => countUp(r.num, prev[r.s] ?? 0, to[r.s] ?? 0, ms)));
    for (const r of rows)
      if ((to[r.s] ?? 0) !== (prev[r.s] ?? 0) && !prefersReducedMotion())
        r.num.animate([{ transform: 'scale(1.25)' }, { transform: 'scale(1)' }], { duration: 380, easing: 'cubic-bezier(.2,1.6,.4,1)' });
  };
  return { el, animate };
}

function buildSoloHandSummary(ev: HandEnd, ctx: SummaryCtx, onContinue: () => void): HTMLElement {
  const order = fromHuman(ctx.seats ?? [0, 1, 2, 3]);
  const avatars = ctx.avatars !== false;
  const w = ev.winnerSeat;
  let title: string;
  let sub: string;
  let tone: 'win' | 'lose' | 'void';
  if (w === null) {
    title = t('summary.void');
    sub = t('summary.voidBody');
    tone = 'void';
  } else {
    title = ev.reason === 'domino' ? t('summary.domino') : t('summary.tranque');
    if (w === 0) sub = ev.reason === 'domino' ? t('summary.dominoYou') : t('summary.tranqueYou');
    else sub = ev.reason === 'domino' ? t('summary.dominoBy', { name: ctx.names[w] }) : t('summary.tranqueBy', { name: ctx.names[w] });
    tone = w === 0 ? 'win' : 'lose';
  }
  const faceFor = (s: Seat): AvatarExpr => (w === null ? 'meh' : w === s ? 'happy' : 'sad');
  const seatChip = (s: Seat, i: number) =>
    h(
      'div.sum-seat',
      { class: `${s === 0 ? 'us' : 'them'}${w === s ? ' winner' : ''}`, style: `--i:${i}`, title: `${ctx.names[s]} · ${t('summary.pips', { n: ev.pipCounts[s] })}` },
      h('div.sum-seat-top', soloFace(s, avatars, ctx.names, faceFor(s)), h('span.sum-seat-pips', String(ev.pipCounts[s]))),
      h('span.sum-seat-tiles', { html: (ev.remaining[s] ?? []).map((tl) => tileSvg(tl.a, tl.b, { size: 8 })).join('') }),
    );
  const { lines, scored } = soloCalcLines(ev, ctx.names);
  const pointsLine =
    w === null
      ? null
      : h(
          'div.sum-points',
          { class: w === 0 ? 'us' : 'them' },
          h('span.points-big', `+${scored}`),
          h('span.points-label', w === 0 ? t('summary.pointsYou', { n: scored }) : t('summary.pointsBy', { name: ctx.names[w], n: scored })),
        );
  const calc = lines.length ? h('ul.sum-calc', ...lines.map((l, i) => h('li', { class: l.cls ?? '', style: `--i:${i}` }, l.text))) : null;
  const prev = ctx.prevSeatScores ?? [0, 0, 0, 0];
  const score = soloScoreBlock(order, ctx.names, prev, ctx.target, avatars);
  const cont = btn(ctx.matchOver ? t('summary.toMatchEnd') : t('summary.continue'), onContinue, 'primary lg');
  cont.dataset.autofocus = '';
  const body = h(
    'div.sum-body',
    h('div.sum-main', h('div.sum-seats', { 'aria-label': t('summary.remaining'), class: `n${order.length}` }, ...order.map(seatChip)), calc),
    h('div.sum-side', pointsLine, score.el),
  );
  const card = h(
    'div.card.sheet.summary.solo',
    { class: `tone-${tone}` },
    h('header.sum-head', h('div.kicker', t('summary.hand', { n: ctx.handNo })), h('h2.summary-title', title), h('p.summary-sub', sub)),
    body,
    h('footer.sum-foot', cont),
  );
  scrollFades(body);
  const delay = prefersReducedMotion() ? 0 : 550 * ctx.speed;
  setTimeout(() => void score.animate(ev.seatScores ?? prev, 1100 * ctx.speed), delay);
  return card;
}

function buildSoloMatchEnd(
  ev: MatchEnd,
  ctx: { names: [string, string, string, string]; avatars?: boolean; seats: Seat[]; seatHandsWon?: number[] },
  onRematch: () => void,
  onMenu: () => void,
): HTMLElement {
  const w = ev.winnerSeat ?? 0;
  const won = w === 0;
  const avatars = ctx.avatars !== false;
  const sc = ev.seatScores ?? [0, 0, 0, 0];
  const order = fromHuman(ctx.seats);
  const faces = avatars
    ? h(
        'div.me-faces',
        ...order.map((s, i) =>
          h(
            'div.me-face',
            { class: `${s === 0 ? 'us' : 'them'} ${s === w ? 'win' : 'lose'}`, style: `--i:${i}`, title: ctx.names[s] },
            h('span.face-static', staticFace(faceOfSeat(s), s === w ? 'happy' : 'sad', s === w ? { gy: -0.8 } : { gy: 0.9 })),
            h('span.me-name', ctx.names[s]),
          ),
        ),
      )
    : null;
  // standings: highest score first (ties keep the turn order from the human)
  const ranked = order.slice().sort((a, b) => sc[b] - sc[a]);
  const handsTxt = (n: number) => (n === 1 ? t('match.hands1') : t('match.handsShort', { n }));
  const standings = h(
    'ol.standings',
    { 'aria-label': t('match.standings') },
    ...ranked.map((s, i) =>
      h(
        'li.standing',
        { class: `${s === 0 ? 'me' : ''}${s === w ? ' first' : ''}`, style: `--i:${i}` },
        h('span.st-rank', String(i + 1)),
        h('span.st-name', ctx.names[s]),
        h('span.st-hands', handsTxt(ctx.seatHandsWon?.[s] ?? 0)),
        h('span.st-pts', String(sc[s])),
      ),
    ),
  );
  const confetti = won && !prefersReducedMotion() ? h('div.confetti', ...Array.from({ length: 36 }, (_, i) => h('i', { style: `--i:${i};--x:${(i * 37) % 100};--d:${(i * 53) % 10}` }))) : null;
  const rematch = btn(t('match.rematch'), onRematch, 'primary lg', h('span.btn-icon', { html: ICONS.resume }));
  rematch.dataset.autofocus = '';
  return h(
    'div.card.sheet.match-end.solo',
    { class: won ? 'tone-win' : 'tone-lose' },
    confetti,
    h(
      'div.sheet-a',
      h('div.trophy', { html: won ? trophySvg : cloudSvg }),
      h('h2.summary-title', won ? t('match.winSolo') : t('match.loseSolo', { name: ctx.names[w] })),
      faces,
    ),
    h('div.sheet-b', standings, h('div.sheet-actions', btn(t('match.menu'), onMenu, 'ghost lg', h('span.btn-icon', { html: ICONS.home })), rematch)),
  );
}

function bonusList(bonuses: Bonus[], early: Bonus[] = [], base = 0): HTMLElement | null {
  if (!bonuses.length && !early.length) return null;
  const item = (b: Bonus, i: number, done: boolean) =>
    h(
      'li.bonus',
      { class: `${b.team === 0 ? 'us' : 'them'}${done ? ' early' : ''}`, style: `--i:${i}` },
      h('span.bonus-pts', b.points ? `+${b.points}` : '★'),
      // capicúa ×2 shows its arithmetic: "Capicúa ×2 = 14"
      h('span.bonus-label', b.kind === 'double' ? t('summary.capicuaDouble', { n: base + b.points }) : loc(b.label), done ? h('span.bonus-note', ` · ${t('summary.early')}`) : null),
      h('span.bonus-team', b.team === 0 ? t('team.us') : t('team.them')),
    );
  return h('ul.bonuses', ...early.map((b, i) => item(b, i, true)), ...bonuses.map((b, i) => item(b, i + early.length, false)));
}

const ptsText = (n: number) => (n === 1 ? t('summary.pts1') : t('summary.ptsN', { n }));

interface CalcLine {
  text: string;
  /** 'us' / 'them' tint, 'held' = went abajo, 'muted' = already counted earlier */
  cls?: string;
}

/**
 * The hand's arithmetic, one short line each: "Fichas: 65 → 7 puntos", "Capicúa ×2 → 14",
 * "Abajo +4 → 18", "Pase de salida +2 · ya sumado". Returns the lines and the points the winning
 * team actually scored in this hand-end (0 when they went abajo).
 */
function calcLines(ev: HandEnd): { lines: CalcLine[]; scored: number } {
  const lines: CalcLine[] = [];
  const team = ev.winnerTeam;
  const teamName = (x: Team) => (x === 0 ? t('team.us') : t('team.them'));
  let run = 0;
  if (team !== null) {
    run = ev.points;
    const raw = ev.rawPips ?? ev.points;
    lines.push({
      text: !ev.rounding || ev.rounding === 'none' ? t('summary.lineTilesNone', { pts: ptsText(ev.points) }) : t('summary.lineTiles', { pips: raw, pts: ptsText(ev.points) }),
    });
    for (const b of ev.bonuses) {
      if (b.team !== team) continue;
      run += b.points;
      lines.push({ text: b.kind === 'double' ? t('summary.lineCapicua', { n: run }) : `${loc(b.label)} +${b.points} → ${run}` });
    }
  }
  // bonuses of the other team (e.g. pase de los tres): credited to them
  for (const b of ev.bonuses) if (b.team !== team) lines.push({ text: `${loc(b.label)} +${b.points} · ${teamName(b.team)}`, cls: b.team === 0 ? 'us' : 'them' });
  if (team !== null && ev.abajoAdded !== undefined) lines.push({ text: t('summary.lineAbajoHeld', { pot: ev.abajoPot ?? ev.abajoAdded }), cls: 'held' });
  if (team !== null && ev.abajoClaimed) {
    run += ev.abajoClaimed;
    lines.push({ text: t('summary.lineAbajoClaim', { n: ev.abajoClaimed, total: run }), cls: 'claim' });
  }
  for (const b of ev.earlyBonuses ?? []) lines.push({ text: `${loc(b.label)} +${b.points} · ${teamName(b.team)} · ${b.abajo ? t('summary.noteAbajo') : t('summary.early')}`, cls: 'muted' });
  if (team === null && ev.abajoPot) lines.push({ text: t('summary.voidPot', { n: ev.abajoPot }), cls: 'held' });
  return { lines, scored: team !== null && ev.abajoAdded === undefined ? run : 0 };
}

/** keeps the scroll fades of a scrolling zone in sync (top/bottom edge only when there is more) */
function scrollFades(el: HTMLElement): void {
  const sync = () => {
    const more = el.scrollHeight - el.clientHeight > 2;
    el.classList.toggle('more-above', more && el.scrollTop > 2);
    el.classList.toggle('more-below', more && el.scrollTop + el.clientHeight < el.scrollHeight - 2);
  };
  el.addEventListener('scroll', sync, { passive: true });
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(sync).observe(el);
  requestAnimationFrame(sync);
  setTimeout(sync, 700); // after the entry animations
}

function scoreBlock(prev: [number, number], target: number | null) {
  const nums = [h('span.big-num', String(prev[0])), h('span.big-num', String(prev[1]))];
  const fills = [h('span.fill'), h('span.fill')];
  const tgt = target ?? 100;
  fills.forEach((f, i) => (f.style.transform = `scaleX(${Math.min(1, prev[i] / tgt)})`));
  const el = h(
    'div.score-block',
    ...[0, 1].map((i) =>
      h(
        'div.score-col',
        { class: i === 0 ? 'us' : 'them' },
        h('span.score-name', i === 0 ? t('team.us') : t('team.them')),
        nums[i],
        h('span.bar', fills[i]),
      ),
    ),
    target ? h('div.score-target', t('hud.target', { n: target })) : null,
  );
  const animate = async (to: [number, number], ms: number) => {
    fills.forEach((f, i) => {
      f.style.transition = `transform ${ms}ms cubic-bezier(.2,.8,.2,1)`;
      f.style.transform = `scaleX(${Math.min(1, to[i] / tgt)})`;
    });
    await Promise.all([countUp(nums[0], prev[0], to[0], ms), countUp(nums[1], prev[1], to[1], ms)]);
    [0, 1].forEach((i) => {
      if (to[i] !== prev[i] && !prefersReducedMotion())
        nums[i].animate([{ transform: 'scale(1.25)' }, { transform: 'scale(1)' }], { duration: 380, easing: 'cubic-bezier(.2,1.6,.4,1)' });
    });
  };
  return { el, animate };
}

export function buildHandSummary(ev: HandEnd, ctx: SummaryCtx, onContinue: () => void): HTMLElement {
  if (ctx.seats) return buildSoloHandSummary(ev, ctx, onContinue);
  const winName = ev.winnerSeat !== null ? ctx.names[ev.winnerSeat] : '';
  let title: string;
  let sub: string;
  let tone: 'win' | 'lose' | 'void';
  if (ev.winnerTeam === null) {
    title = t('summary.void');
    sub = t('summary.voidBody');
    tone = 'void';
  } else {
    title = ev.reason === 'domino' ? t('summary.domino') : t('summary.tranque');
    if (ev.winnerSeat === 0) sub = ev.reason === 'domino' ? t('summary.dominoYou') : t('summary.tranqueYou');
    else sub = ev.reason === 'domino' ? t('summary.dominoBy', { name: winName }) : t('summary.tranqueBy', { name: winName });
    tone = ev.winnerTeam === 0 ? 'win' : 'lose';
  }

  const faceFor = (s: Seat): AvatarExpr =>
    ev.winnerTeam === null ? 'meh' : ev.winnerSeat === s ? 'happy' : s % 2 === ev.winnerTeam ? 'smug' : 'sad';
  // one row of four compact chips: face + pips, the tiles left in tiny dominoes under them
  const seatChip = (s: Seat, i: number) =>
    h(
      'div.sum-seat',
      { class: `${s % 2 === 0 ? 'us' : 'them'}${ev.winnerSeat === s ? ' winner' : ''}`, style: `--i:${i}`, title: `${ctx.names[s]} · ${t('summary.pips', { n: ev.pipCounts[s] })}` },
      h(
        'div.sum-seat-top',
        ctx.avatars !== false
          ? h('span.avatar.has-face', h('span.face-static', staticFace(faceOfSeat(s), faceFor(s))))
          : h('span.avatar', ctx.names[s].slice(0, 1).toUpperCase()),
        h('span.sum-seat-pips', String(ev.pipCounts[s])),
      ),
      h('span.sum-seat-tiles', { html: (ev.remaining[s] ?? []).map((tl) => tileSvg(tl.a, tl.b, { size: 8 })).join('') }),
    );

  const { lines, scored } = calcLines(ev);
  const held = ev.winnerTeam !== null && ev.abajoAdded !== undefined;
  const pointsLine =
    ev.winnerTeam === null
      ? null
      : h(
          'div.sum-points',
          { class: `${ev.winnerTeam === 0 ? 'us' : 'them'}${held ? ' held' : ''}` },
          h('span.points-big', held ? String(ev.abajoAdded) : `+${scored}`),
          h(
            'span.points-label',
            held
              ? t(ev.winnerTeam === 0 ? 'summary.abajoHeldUs' : 'summary.abajoHeldThem')
              : ev.winnerTeam === 0
                ? t('summary.pointsUs', { n: scored })
                : t('summary.pointsThem', { n: scored }),
          ),
        );
  const calc = lines.length ? h('ul.sum-calc', ...lines.map((l, i) => h('li', { class: l.cls ?? '', style: `--i:${i}` }, l.text))) : null;

  const score = scoreBlock(ctx.prevScores, ctx.target);
  const cont = btn(ctx.matchOver ? t('summary.toMatchEnd') : t('summary.continue'), onContinue, 'primary lg');
  cont.dataset.autofocus = '';

  // fixed header + footer; only the calculations zone in between scrolls when the screen is short
  const body = h(
    'div.sum-body',
    h('div.sum-main', h('div.sum-seats', { 'aria-label': t('summary.remaining') }, ...([0, 2, 1, 3] as Seat[]).map(seatChip)), calc),
    h('div.sum-side', pointsLine, score.el),
  );
  const card = h(
    'div.card.sheet.summary',
    { class: `tone-${tone}` },
    h('header.sum-head', h('div.kicker', t('summary.hand', { n: ctx.handNo })), h('h2.summary-title', title), h('p.summary-sub', sub)),
    body,
    h('footer.sum-foot', cont),
  );
  scrollFades(body);
  const delay = prefersReducedMotion() ? 0 : 550 * ctx.speed;
  setTimeout(() => void score.animate(ev.scores, 1100 * ctx.speed), delay);
  return card;
}

export function buildMatchEnd(
  ev: MatchEnd,
  ctx: { names: [string, string, string, string]; handsWon: [number, number]; avatars?: boolean; seats?: Seat[]; seatHandsWon?: number[] },
  onRematch: () => void,
  onMenu: () => void,
): HTMLElement {
  if (ctx.seats && ev.winnerSeat !== undefined) return buildSoloMatchEnd(ev, { ...ctx, seats: ctx.seats }, onRematch, onMenu);
  const won: boolean = (ev.winner as Team) === 0;
  // the four faces: winners beaming (and bouncing), losers glum
  const faces =
    ctx.avatars !== false
      ? h(
          'div.me-faces',
          ...([0, 2, 1, 3] as Seat[]).map((s, i) => {
            const w = s % 2 === ev.winner;
            return h(
              'div.me-face',
              { class: `${s % 2 === 0 ? 'us' : 'them'} ${w ? 'win' : 'lose'}`, style: `--i:${i}`, title: ctx.names[s] },
              h('span.face-static', staticFace(faceOfSeat(s), w ? 'happy' : 'sad', w ? { gy: -0.8 } : { gy: 0.9 })),
              h('span.me-name', ctx.names[s]),
            );
          }),
        )
      : null;
  const confetti = won && !prefersReducedMotion() ? h('div.confetti', ...Array.from({ length: 36 }, (_, i) => h('i', { style: `--i:${i};--x:${(i * 37) % 100};--d:${(i * 53) % 10}` }))) : null;
  const rematch = btn(t('match.rematch'), onRematch, 'primary lg', h('span.btn-icon', { html: ICONS.resume }));
  rematch.dataset.autofocus = '';
  return h(
    'div.card.sheet.match-end',
    { class: won ? 'tone-win' : 'tone-lose' },
    confetti,
    h(
      'div.sheet-a',
      h('div.trophy', { html: won ? trophySvg : cloudSvg }),
      h('h2.summary-title', won ? t('match.win') : t('match.lose')),
      h('p.summary-sub', won ? t('match.winSub', { partner: ctx.names[2] }) : t('match.loseSub')),
      faces,
    ),
    h(
      'div.sheet-b',
      h(
      'div.final-score',
      h('div.fs-col.us', h('span.score-name', t('team.us')), h('span.big-num', String(ev.scores[0]))),
      h('span.fs-dash', '–'),
      h('div.fs-col.them', h('span.score-name', t('team.them')), h('span.big-num', String(ev.scores[1]))),
    ),
    h('p.hands-won', `${t('match.hands')}: ${ctx.handsWon[0]} – ${ctx.handsWon[1]}`),
    bonusList(ev.bonuses),
    h('div.sheet-actions', btn(t('match.menu'), onMenu, 'ghost lg', h('span.btn-icon', { html: ICONS.home })), rematch),
    ),
  );
}

export type AudioKey = 'sound' | 'music' | 'vibration';

/** square on/off icon button (aria-pressed); the "off" state shows the crossed, dimmed icon */
export function audioToggle(key: AudioKey, on: boolean, onChange: (key: AudioKey, on: boolean) => void): HTMLButtonElement {
  const label = t(`settings.${key}`);
  const b = h('button.icon-btn.audio-tg', { type: 'button', 'aria-pressed': String(on), 'aria-label': label, title: label, html: AUDIO_ICONS[key] });
  b.addEventListener('click', () => {
    on = !on;
    b.setAttribute('aria-pressed', String(on));
    onChange(key, on);
  });
  return b;
}

export function fullscreenToggle(): HTMLButtonElement {
  const label = t('menu.fullscreen');
  const b = h('button.icon-btn.audio-tg.fs-tg', { type: 'button', 'aria-label': label, title: label, html: ICONS.fullscreen });
  b.addEventListener('click', () => void toggleFullscreen());
  return b;
}

export function buildPause(o: {
  levels?: { name: string; level: string; partner: boolean }[];
  audio: Record<AudioKey, boolean>;
  onAudio(key: AudioKey, on: boolean): void;
  onResume(): void;
  onSettings(): void;
  onHowto(): void;
  onQuit(): void;
}): HTMLElement {
  const resume = btn(t('pause.resume'), o.onResume, 'primary lg', h('span.btn-icon', { html: ICONS.play }));
  resume.dataset.autofocus = '';
  const canVibrate = typeof navigator.vibrate === 'function';
  return h(
    'div.card.pause',
    h('h2.card-title', t('pause.title')),
    h(
      'div.stack',
      resume,
      // two equal halves: settings, how to play
      h(
        'div.pause-grid',
        btn(t('menu.settings'), o.onSettings, 'secondary', h('span.btn-icon', { html: ICONS.gear })),
        btn(t('menu.howto'), o.onHowto, 'secondary', h('span.btn-icon', { html: ICONS.book })),
      ),
      // equal icon toggles across the whole row: sound, music, vibration, fullscreen
      h(
        'div.pause-grid.pause-icons',
        audioToggle('sound', o.audio.sound, o.onAudio),
        audioToggle('music', o.audio.music, o.onAudio),
        canVibrate ? audioToggle('vibration', o.audio.vibration, o.onAudio) : null,
        canFullscreen() ? fullscreenToggle() : null,
      ),
      btn(t('pause.quit'), o.onQuit, 'ghost', h('span.btn-icon', { html: ICONS.home })),
    ),
  );
}

// .on / .off parts are shown by the button's aria-pressed (styles.css → .audio-tg)
const STROKE = 'fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"';
const SLASH = `<path class="off" d="M4 4l16 16" ${STROKE}/>`;
const AUDIO_ICONS: Record<AudioKey, string> = {
  sound: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 9.2h3.6L11.8 5v14l-4.7-4.2H3.5z"/><path class="on" d="M15.2 9a4.2 4.2 0 0 1 0 6M17.9 6.3a8 8 0 0 1 0 11.4" ${STROKE}/><path class="off" d="M15.5 9.5l5 5M20.5 9.5l-5 5" ${STROKE}/></svg>`,
  music: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.5 17.2V6.4l10-2.2v10.6" ${STROKE}/><circle cx="7" cy="17.4" r="2.7"/><circle cx="17" cy="15" r="2.7"/>${SLASH}</svg>`,
  vibration: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="3.5" width="8" height="17" rx="2.2" ${STROKE}/><path class="on" d="M4.6 9v6M19.4 9v6M1.8 10.6v2.8M22.2 10.6v2.8" ${STROKE}/>${SLASH}</svg>`,
};

const trophySvg = `<svg viewBox="0 0 120 110" aria-hidden="true">
<path d="M30 14h60v22c0 20-13 36-30 36S30 56 30 36z" fill="#ffb627"/>
<path d="M30 22H14c0 18 8 28 20 30M90 22h16c0 18-8 28-20 30" fill="none" stroke="#ffb627" stroke-width="7" stroke-linecap="round"/>
<path d="M52 70h16l3 16H49z" fill="#e8981a"/><rect x="38" y="86" width="44" height="12" rx="4" fill="#7a3d1c"/>
<path d="M44 20h8v26c0 6 3 10 6 12-8-1-14-7-14-15z" fill="#fff" opacity=".35"/>
<circle cx="60" cy="38" r="9" fill="#fff6e6"/><circle cx="60" cy="38" r="3" fill="#2a160d"/></svg>`;
const cloudSvg = `<svg viewBox="0 0 120 110" aria-hidden="true">
<g transform="rotate(-12 60 55)"><rect x="40" y="16" width="40" height="78" rx="9" fill="#fff6e6"/><rect x="45" y="54" width="30" height="2.4" rx="1.2" fill="#b9a27f"/>
<circle cx="60" cy="35" r="5" fill="#c8231b"/><circle cx="51" cy="66" r="4.5" fill="#2a160d"/><circle cx="69" cy="82" r="4.5" fill="#2a160d"/></g>
<path d="M18 98q42-14 84 0" fill="none" stroke="#fff" stroke-opacity=".25" stroke-width="4" stroke-linecap="round"/></svg>`;

/** "¿Quién sale?": the human's pair picks its opener. Compact, sits near the hand, no timer. */
export function buildStarterChooser(o: {
  names: readonly string[];
  avatars: boolean;
  partnerWants: boolean;
  onPick(seat: Seat): void;
  /** online, the partner of the one who decides: say a wish instead ("Quiero salir" / "Sal tú") */
  labels?: { me: string; partner: string };
  note?: string;
}): HTMLElement {
  const opt = (seat: Seat, label: string) => {
    const face = o.avatars
      ? h('span.st-face', h('span.face-static', staticFace(faceOfSeat(seat), seat === 2 && o.partnerWants ? 'happy' : 'idle')))
      : h('span.st-face.letter', o.names[seat].slice(0, 1).toUpperCase());
    const b = h('button.btn.st-opt', { type: 'button', class: seat === 0 ? 'primary' : 'secondary' }, face, h('span.btn-label', label));
    b.addEventListener('click', () => o.onPick(seat));
    return b;
  };
  const me = opt(0, o.labels?.me ?? t('starter.me'));
  me.dataset.autofocus = '';
  return h(
    'div.card.starter-pick',
    h('h2.card-title', t('starter.title')),
    ...(o.note ? [h('p.st-note', o.note)] : []),
    h('div.st-row', me, opt(2, o.labels?.partner ?? t('starter.partner', { name: o.names[2] }))),
  );
}