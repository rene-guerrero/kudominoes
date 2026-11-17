import './ui/styles.css';
import { initAudio } from './audio/sfx';
import { App } from './app/app';
import { loadModules } from './app/modules';
import { loadSettings, saveSettings } from './app/settings';
import { h, setReducedMotionPref } from './ui/dom';
import { setLang, t } from './ui/i18n';
import { Overlay } from './ui/overlay';
import { setTileTheme } from './ui/tiles';

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

async function boot() {
  lockDownGestures();
  const uiRoot = document.getElementById('ui')!;
  const tableEl = document.getElementById('table')!;
  try {
    const { engine, createTableView, mock } = await loadModules();
    const settings = loadSettings(engine);
    saveSettings(settings);
    setLang(settings.language);
    setTileTheme(settings.tileTheme ?? 'dark');
    setReducedMotionPref(!!settings.reducedMotion);
    initAudio({ sound: settings.sound, music: settings.music, vibration: settings.vibration });
    const overlay = new Overlay(uiRoot);
    const app = new App({ engine, createTableView, settings, overlay, tableEl });
    app.showMenu();
    // dev-only handle for debugging from the console (stripped from production builds)
    if (import.meta.env.DEV) (window as unknown as { __kudo: unknown }).__kudo = { app, engine };
    if (mock) document.body.dataset.mock = '1';
  } catch (err) {
    console.error(err);
    uiRoot.append(h('div.boot-error', t('loading.error')));
  } finally {
    const boot = document.getElementById('boot');
    if (boot) {
      boot.style.transition = 'opacity .35s';
      boot.style.opacity = '0';
      setTimeout(() => boot.remove(), 400);
    }
  }
}

/** Offline/installable web build: register the service worker in production web only (not in Capacitor). */
function registerServiceWorker() {
  const native = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.();
  if (!import.meta.env.PROD || native || !('serviceWorker' in navigator) || (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1')) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('[kudominoes] service worker not registered', e));
  });
}

void boot();
registerServiceWorker();
