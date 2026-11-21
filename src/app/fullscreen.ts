/**
 * Fullscreen in a browser tab. Android browsers let a page go fullscreen from a tap; iPhones (every iOS
 * browser runs on WebKit) only do it for video, so there the button is hidden and adding the game to the
 * home screen is the way (the manifest opens it fullscreen). An installed app / home-screen icon is
 * already fullscreen, so nothing shows there either.
 */

import { t } from '../ui/i18n';

const doc = document as Document & { webkitFullscreenEnabled?: boolean; webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> };
type FsEl = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };

const native = (): boolean => !!(window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.();
/** opened from an iPhone home-screen icon (always fullscreen there, and the API is missing anyway) */
const iosHomeScreen = (): boolean => (navigator as Navigator & { standalone?: boolean }).standalone === true;

/**
 * A fullscreen button makes sense here: the browser supports it, and this isn't the Android app or an
 * iPhone home-screen icon. (Not judged by `display-mode`: a browser that is already fullscreen, e.g. after
 * a reload in fullscreen, reports `display-mode: fullscreen` too, which used to hide the button.)
 */
export function canFullscreen(): boolean {
  return !native() && !iosHomeScreen() && !!(doc.fullscreenEnabled || doc.webkitFullscreenEnabled);
}

export function isFullscreen(): boolean {
  return !!(doc.fullscreenElement || doc.webkitFullscreenElement);
}

/** go fullscreen (must run inside a tap); quietly does nothing where it isn't allowed */
export async function enterFullscreen(): Promise<void> {
  if (!canFullscreen() || isFullscreen()) return;
  const el = document.documentElement as FsEl;
  try {
    if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' });
    else await el.webkitRequestFullscreen?.();
  } catch {
    /* refused (no gesture, policy): stay as is */
  }
}

/** the browser's own fullscreen (F11): the page fills the screen but no element is fullscreen */
function browserFullscreen(): boolean {
  return !isFullscreen() && Math.abs(innerHeight - screen.height) <= 2 && Math.abs(innerWidth - screen.width) <= 2;
}

/** a short message at the top of the screen */
function toast(text: string): void {
  const el = document.createElement('div');
  el.className = 'fs-toast';
  el.setAttribute('role', 'status');
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.classList.add('out'), 2600);
  setTimeout(() => el.remove(), 3100);
}

export async function toggleFullscreen(): Promise<void> {
  // a page can't leave the browser's F11 fullscreen; only F11 can, so say so
  if (browserFullscreen()) return toast(t('menu.fullscreenF11'));
  if (!isFullscreen()) return enterFullscreen();
  try {
    if (doc.exitFullscreen) await doc.exitFullscreen();
    else await doc.webkitExitFullscreen?.();
  } catch {
    /* ignore */
  }
}
