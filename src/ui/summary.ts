import type { Bonus, GameEvent, Seat, Team } from '../contracts';
import { countUp, h, prefersReducedMotion } from './dom';
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

/** "65 en fichas → 70 → 7 puntos" (or "65 puntos en fichas" without rounding) */
function arithLine(ev: HandEnd): string | null {
  if (ev.winnerTeam === null || ev.rawPips === undefined) return null;
  if (!ev.rounding || ev.rounding === 'none') return t('summary.arithNone', { pips: ev.rawPips });
  return t('summary.arith', { pips: ev.rawPips, rounded: ev.points * 10, n: ev.points });
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
  const seatRow = (s: Seat) =>
    h(
      'div.seat-row',
      { class: `${s % 2 === 0 ? 'us' : 'them'} ${ev.winnerSeat === s ? 'winner' : ''}` },
      ctx.avatars !== false
        ? h('span.avatar.has-face', h('span.face-static', staticFace(faceOfSeat(s), faceFor(s))))
        : h('span.avatar', ctx.names[s].slice(0, 1).toUpperCase()),
      h('span.seat-name', ctx.names[s]),
      h('span.seat-tiles', { html: (ev.remaining[s] ?? []).map((tl) => tileSvg(tl.a, tl.b, { size: 13 })).join('') }),
      h('span.seat-pips', t('summary.pips', { n: ev.pipCounts[s] })),
    );

  const arith = arithLine(ev);
  const total = ev.points + ev.bonuses.filter((b) => b.team === ev.winnerTeam).reduce((a, b) => a + b.points, 0);
  const pointsLine =
    ev.winnerTeam === null
      ? null
      : h(
          'div.points-line',
          { class: ev.winnerTeam === 0 ? 'us' : 'them' },
          h('span.points-big', `+${total}`),
          h('span.points-label', ev.winnerTeam === 0 ? t('summary.pointsUs', { n: total }) : t('summary.pointsThem', { n: total })),
          arith ? h('span.points-arith', arith) : null,
        );

  const score = scoreBlock(ctx.prevScores, ctx.target);
  const cont = btn(ctx.matchOver ? t('summary.toMatchEnd') : t('summary.continue'), onContinue, 'primary lg');
  cont.dataset.autofocus = '';

  const card = h(
    'div.card.sheet.summary',
    { class: `tone-${tone}` },
    h(
      'div.sheet-a',
      h('div.kicker', t('summary.hand', { n: ctx.handNo })),
      h('h2.summary-title', title),
      h('p.summary-sub', sub),
      h('div.seats', h('div.team-col', seatRow(0), seatRow(2)), h('div.team-col', seatRow(1), seatRow(3))),
    ),
    h('div.sheet-b', pointsLine, bonusList(ev.bonuses, ev.earlyBonuses, ev.points), score.el, h('div.sheet-actions', cont)),
  );
  const delay = prefersReducedMotion() ? 0 : 550 * ctx.speed;
  setTimeout(() => void score.animate(ev.scores, 1100 * ctx.speed), delay);
  return card;
}

export function buildMatchEnd(
  ev: MatchEnd,
  ctx: { names: [string, string, string, string]; handsWon: [number, number]; avatars?: boolean },
  onRematch: () => void,
  onMenu: () => void,
): HTMLElement {
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

export function buildPause(o: {
  levels?: { name: string; level: string; partner: boolean }[];
  onResume(): void;
  onSettings(): void;
  onHowto(): void;
  onQuit(): void;
}): HTMLElement {
  const resume = btn(t('pause.resume'), o.onResume, 'primary lg', h('span.btn-icon', { html: ICONS.play }));
  resume.dataset.autofocus = '';
  return h(
    'div.card.pause',
    h('h2.card-title', t('pause.title')),
    h(
      'div.stack',
      resume,
      btn(t('menu.settings'), o.onSettings, 'secondary', h('span.btn-icon', { html: ICONS.gear })),
      btn(t('menu.howto'), o.onHowto, 'secondary', h('span.btn-icon', { html: ICONS.book })),
      btn(t('pause.quit'), o.onQuit, 'ghost', h('span.btn-icon', { html: ICONS.home })),
    ),
  );
}

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
export function buildStarterChooser(o: { names: readonly string[]; avatars: boolean; partnerWants: boolean; onPick(seat: Seat): void }): HTMLElement {
  const opt = (seat: Seat, label: string) => {
    const face = o.avatars
      ? h('span.st-face', h('span.face-static', staticFace(faceOfSeat(seat), seat === 2 && o.partnerWants ? 'happy' : 'idle')))
      : h('span.st-face.letter', o.names[seat].slice(0, 1).toUpperCase());
    const b = h('button.btn.st-opt', { type: 'button', class: seat === 0 ? 'primary' : 'secondary' }, face, h('span.btn-label', label));
    b.addEventListener('click', () => o.onPick(seat));
    return b;
  };
  const me = opt(0, t('starter.me'));
  me.dataset.autofocus = '';
  return h('div.card.starter-pick', h('h2.card-title', t('starter.title')), h('div.st-row', me, opt(2, t('starter.partner', { name: o.names[2] }))));
}