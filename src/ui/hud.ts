import type { Pip, Seat } from '../contracts';
import { h, prefersReducedMotion } from './dom';
import { t } from './i18n';
import { iconBtn, ICONS } from './overlay';
import { faceSvg } from './tiles';

/**
 * In-game HUD. Built once; per-event updates only write text nodes, swap tiny fixed-size SVGs,
 * and animate transform/opacity — no layout-affecting style writes during play.
 */
export class Hud {
  readonly el: HTMLElement;
  private usName = h('span.team-name');
  private themName = h('span.team-name');
  private usPts = h('span.team-pts', '0');
  private themPts = h('span.team-pts', '0');
  private usFill = h('span.fill');
  private themFill = h('span.fill');
  private handNo = h('span.hand-no');
  private target = h('span.target');
  private endL = h('span.end');
  private endR = h('span.end');
  private endsBox = h('div.ends', { 'aria-label': '' }, this.endL, h('span.ends-dot'), this.endR);
  /** short self-dismissing notice for rare events (under the hand counter, never over the felt) */
  private noticeEl = h('div.notice', { role: 'status', 'aria-live': 'polite' });
  private notices: string[] = [];
  private noticeBusy = false;
  private noticeTimer = 0;
  private bubbles: HTMLElement[];
  private pauseBtn: HTMLButtonElement;
  private scores: [number, number] = [0, 0];
  private targetN: number | null = null;
  private hand = 0;
  private lastEnds: { left: Pip; right: Pip } | null = null;

  constructor(onPause: () => void) {
    this.pauseBtn = iconBtn(ICONS.pause, t('hud.pause'), onPause, 'pause-btn');
    this.bubbles = [0, 1, 2, 3].map(() => h('div.bubble', { 'aria-live': 'polite' }));
    this.el = h(
      'div.hud',
      h(
        'div.hud-top',
        h(
          'div.score-card',
          h('div.team.us', h('div.team-row', this.usName, this.usPts), h('span.bar', this.usFill)),
          h('div.team.them', h('div.team-row', this.themName, this.themPts), h('span.bar', this.themFill)),
        ),
        h('div.hud-center', h('div.hud-info', h('div.hand-line', this.handNo, h('span.sep', '·'), this.target), this.endsBox), this.noticeEl),
        this.pauseBtn,
      ),
      ...this.bubbles.map((b, s) => h('div.bubble-anchor', { class: `seat-${s}` }, b)),
    );
    this.relabel();
    this.setEnds(null);
  }

  relabel(): void {
    this.usName.textContent = t('hud.us');
    this.themName.textContent = t('hud.them');
    this.pauseBtn.setAttribute('aria-label', t('hud.pause'));
    this.endsBox.setAttribute('aria-label', t('hud.ends'));
    this.setHand(this.hand);
    this.setTarget(this.targetN);
  }

  show(on: boolean): void {
    this.el.classList.toggle('on', on);
  }

  setHand(n: number): void {
    this.hand = n;
    this.handNo.textContent = n ? t('hud.hand', { n }) : '';
  }

  setTarget(n: number | null): void {
    this.targetN = n;
    this.target.textContent = n ? t('hud.target', { n }) : '';
    this.target.previousElementSibling?.classList.toggle('hidden', !n);
    this.updateBars();
  }

  setScores(s: [number, number], bump = false): void {
    const changed = [s[0] !== this.scores[0], s[1] !== this.scores[1]];
    this.scores = [s[0], s[1]];
    this.usPts.textContent = String(s[0]);
    this.themPts.textContent = String(s[1]);
    this.updateBars();
    if (bump && !prefersReducedMotion()) {
      if (changed[0]) this.usPts.animate([{ transform: 'scale(1.6)' }, { transform: 'scale(1)' }], { duration: 450, easing: 'cubic-bezier(.2,1.6,.4,1)' });
      if (changed[1]) this.themPts.animate([{ transform: 'scale(1.6)' }, { transform: 'scale(1)' }], { duration: 450, easing: 'cubic-bezier(.2,1.6,.4,1)' });
    }
  }

  private updateBars() {
    const tgt = this.targetN ?? Math.max(100, ...this.scores);
    this.usFill.style.transform = `scaleX(${Math.min(1, this.scores[0] / tgt)})`;
    this.themFill.style.transform = `scaleX(${Math.min(1, this.scores[1] / tgt)})`;
  }

  setEnds(ends: { left: Pip; right: Pip } | null): void {
    if (!ends) {
      this.lastEnds = null;
      this.endsBox.classList.add('empty');
      this.endL.innerHTML = '';
      this.endR.innerHTML = '';
      return;
    }
    this.endsBox.classList.remove('empty');
    const prev = this.lastEnds;
    if (!prev || prev.left !== ends.left) this.swapFace(this.endL, ends.left);
    if (!prev || prev.right !== ends.right) this.swapFace(this.endR, ends.right);
    this.lastEnds = { ...ends };
  }

  private swapFace(el: HTMLElement, v: Pip) {
    el.innerHTML = faceSvg(v, 24);
    if (!prefersReducedMotion()) el.animate([{ transform: 'scale(.4) rotate(-20deg)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 260, easing: 'cubic-bezier(.2,1.4,.4,1)' });
  }

  /** Queue a short notice (rare events only); each shows ~2.3 s, one after another. */
  notice(text: string): void {
    if (this.notices.includes(text)) return;
    this.notices.push(text);
    if (!this.noticeBusy) this.nextNotice();
  }

  private nextNotice(): void {
    const txt = this.notices.shift();
    if (txt === undefined) {
      this.noticeBusy = false;
      return;
    }
    this.noticeBusy = true;
    this.noticeEl.textContent = txt;
    this.noticeEl.classList.add('on');
    this.noticeTimer = window.setTimeout(() => {
      this.noticeEl.classList.remove('on');
      this.noticeTimer = window.setTimeout(() => this.nextNotice(), 320);
    }, 2300);
  }

  private clearNotices(): void {
    clearTimeout(this.noticeTimer);
    this.notices = [];
    this.noticeBusy = false;
    this.noticeEl.classList.remove('on');
  }

  say(seat: Seat, text: string, ms = 1400): void {
    const b = this.bubbles[seat];
    b.textContent = text;
    b.getAnimations().forEach((a) => a.cancel());
    const rm = prefersReducedMotion();
    b.animate(
      rm
        ? [{ opacity: 0 }, { opacity: 1, offset: 0.1 }, { opacity: 1, offset: 0.85 }, { opacity: 0 }]
        : [
            { opacity: 0, transform: 'scale(.3)' },
            { opacity: 1, transform: 'scale(1.08)', offset: 0.1 },
            { opacity: 1, transform: 'scale(1)', offset: 0.16 },
            { opacity: 1, transform: 'scale(1)', offset: 0.85 },
            { opacity: 0, transform: 'scale(.9)' },
          ],
      { duration: ms, easing: 'ease-out' },
    );
  }

  reset(): void {
    this.setScores([0, 0]);
    this.setEnds(null);
    this.setHand(0);
    this.clearNotices();
    this.bubbles.forEach((b) => b.getAnimations().forEach((a) => a.cancel()));
  }
}
