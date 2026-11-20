import 'kuavatars/avatars.css';
import 'kuavatars/editor.css';
import './ui/styles.css';
import type { App } from './app/app';
import { initAudio } from './audio/sfx';
import { installErrorLog } from './app/errorLog';
import { loadSave, saveSummary } from './app/save';
import { loadEngine, loadTableView } from './app/modules';
import { loadSettings, saveSettings } from './app/settings';
import { h, setReducedMotionPref } from './ui/dom';
import { setLang, t } from './ui/i18n';
import { buildMenu } from './ui/menu';
import { Overlay } from './ui/overlay';
import { setTileTheme } from './ui/tiles';
import { rememberedRoom } from './net/identity';

/*
 * Start-up order (cheap Android WebViews are slow to parse three.js):
 *   1. boot chunk: engine + settings + overlay + menu → the menu is painted right away;
 *   2. then App (game screens) + the renderer chunk (three.js) load behind it; once ready the App
 *      takes over the menu in place (same DOM, animations kept in step) and the table fades in.
 * A tap on the early menu waits for step 2 with a spinner on the button, then is replayed.
 */

function lockDownGestures() {
  // no context menu / text selection / pinch zoom / double-tap zoom inside the game
  document.addEventListener('contextmenu', (e) => {
    if (!(e.target as HTMLElement).closest('input, textarea')) e.preventDefault();
  });
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });
  document.addEventListener(
    'touchmove',
    (e) => {
      if (e.touches.length > 1) e.preventDefault();
    },
    { passive: false },
  );
}

const mark = (name: string) => performance.mark?.(`kudo:${name}`);

/** resolves after the current frame has been painted (or soon anyway: rAF is paused in background tabs) */
const afterPaint = () =>
  new Promise<void>((r) => {
    requestAnimationFrame(() => setTimeout(r, 0));
    setTimeout(r, 200);
  });

function hideBootSplash() {
  const boot = document.getElementById('boot');
  if (!boot) return;
  boot.style.transition = 'opacity .3s';
  boot.style.opacity = '0';
  setTimeout(() => boot.remove(), 350);
}

type AnimKey = string;

/** running CSS animations under `root`, keyed by element path + animation name */
function animSnapshot(root: HTMLElement): Map<AnimKey, number> {
  const out = new Map<AnimKey, number>();
  if (!root.getAnimations) return out;
  for (const a of root.getAnimations({ subtree: true })) {
    const k = animKey(root, a);
    if (k && typeof a.currentTime === 'number') out.set(k, a.currentTime);
  }
  return out;
}

function animKey(root: HTMLElement, a: Animation): AnimKey | null {
  const name = (a as CSSAnimation).animationName;
  let el = (a.effect as KeyframeEffect | null)?.target as Element | null;
  if (!name || !el) return null;
  const path: number[] = [];
  while (el && el !== root) {
    const parent: Element | null = el.parentElement;
    if (!parent) return null;
    path.push(Array.prototype.indexOf.call(parent.children, el));
    el = parent;
  }
  return `${path.reverse().join('.')}|${name}`;
}

async function boot() {
  installErrorLog();
  // dev: main-thread stalls (a hang looks like a frozen UI on a slow phone)
  if (import.meta.env.DEV && typeof PerformanceObserver !== 'undefined') {
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) if (e.duration > 250) console.warn(`[kudominoes] long task ${Math.round(e.duration)} ms`);
      }).observe({ type: 'longtask', buffered: true });
    } catch {
      /* longtask not supported */
    }
  }
  lockDownGestures();
  const uiRoot = document.getElementById('ui')!;
  const tableEl = document.getElementById('table')!;
  const fail = (err: unknown) => {
    console.error(err);
    if (!uiRoot.querySelector('.boot-error')) uiRoot.append(h('div.boot-error', t('loading.error')));
  };
  try {
    const { engine, mock } = await loadEngine();
    const settings = loadSettings(engine);
    saveSettings(settings);
    setLang(settings.language);
    setTileTheme(settings.tileTheme ?? 'dark');
    setReducedMotionPref(!!settings.reducedMotion);
    initAudio({ sound: settings.sound, music: settings.music, vibration: settings.vibration });
    if (mock) document.body.dataset.mock = '1';
    const overlay = new Overlay(uiRoot);

    // ── 1. early menu (same builder and data as App.showMenu) ──
    const s = loadSave();
    const save = s ? saveSummary(s) : null;
    const noop = () => {};
    const early = buildMenu({ save, onPlay: noop, onContinue: noop, onSettings: noop, onHowto: noop, onAbout: noop, onOnline: noop, onFriends: noop });
    overlay.showScreen(early);
    hideBootSplash();
    mark('menu');

    // ── 2. App + renderer behind the menu ──
    const appReady: Promise<App> = afterPaint()
      .then(() => Promise.all([import('./app/app'), loadTableView()]))
      .then(([{ App }, createTableView]) => {
        const app = new App({ engine, createTableView, settings, overlay, tableEl });
        // dev-only handle for debugging from the console (stripped from production builds)
        if (import.meta.env.DEV) (window as unknown as { __kudo: unknown }).__kudo = { app, engine };
        mark('app');
        if (overlay.screen === early) adoptMenu(app);
        // online: a share link (?sala=XXXX) or a reload inside a room joins it (the online code loads lazily)
        const link = new URLSearchParams(location.search).get('sala');
        const sala = link ?? rememberedRoom();
        if (sala && !waiting) void app.openOnline(sala, !link).catch((e) => console.error('[online] join failed', e));
        // let the canvas paint its first frame, then fade the table (idle ring) in
        requestAnimationFrame(() => requestAnimationFrame(() => tableEl.classList.add('kd-ready')));
        return app;
      });
    appReady.catch(fail);

    /** App draws its own menu in place of the early one, without replaying the intro animations. */
    const adoptMenu = (a: App): HTMLElement | null => {
      const times = animSnapshot(early);
      const cls = early.className;
      a.showMenu();
      const next = overlay.screen;
      if (!next || next === early) return next;
      early.remove();
      next.className = cls.replace(/\bleaving\b/, '').trim();
      if (next.getAnimations) {
        for (const anim of next.getAnimations({ subtree: true })) {
          const k = animKey(next, anim);
          const tm = k ? times.get(k) : undefined;
          if (tm !== undefined) anim.currentTime = tm;
        }
      }
      return next;
    };

    // taps on the early menu: wait for the App, then replay the tap on its menu
    let waiting = false;
    early.querySelectorAll('button').forEach((b, i) => {
      b.addEventListener('click', () => {
        if (waiting || overlay.screen !== early) return;
        waiting = true;
        b.classList.add('is-loading');
        b.setAttribute('aria-busy', 'true');
        appReady
          .then(() => {
            // App took over already (adoptMenu ran when it became ready); replay on its button
            const menu = overlay.screen;
            (menu?.querySelectorAll('button')[i] as HTMLButtonElement | undefined)?.click();
          })
          .catch(() => {
            b.classList.remove('is-loading');
            b.removeAttribute('aria-busy');
            waiting = false;
          });
      });
    });
  } catch (err) {
    fail(err);
    hideBootSplash();
  }
}

/** Offline/installable web build: register the service worker in production web only (not in Capacitor). */
function registerServiceWorker() {
  const native = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.();
  // a page a local host served (Jugar con amigos) never installs the web build's offline cache
  if ((window as unknown as { __KUNET_LOCAL__?: unknown }).__KUNET_LOCAL__) return;
  if (!import.meta.env.PROD || native || !('serviceWorker' in navigator) || (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1')) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('[kudominoes] service worker not registered', e));
  });
}

void boot();
registerServiceWorker();
