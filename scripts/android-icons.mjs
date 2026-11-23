// Regenerates the Android launcher icons from the web icons, so the app and the web build always match:
//   - mipmap-*/ic_launcher.png        legacy square icon (below API 26): public/icon.svg
//   - mipmap-*/ic_launcher_round.png  legacy round icon: public/icon-maskable.svg clipped to a circle
//   - mipmap-*/ic_launcher_background.png  adaptive layer (API 26+): public/icon-maskable.svg, full bleed;
//     the foreground layer is transparent (mipmap-anydpi-v26/ic_launcher*.xml)
// The SVGs use gradients and blur filters, so they are drawn by a real browser: headless Edge or Chrome
// (already on the machine, nothing installed). Its throwaway profile lives next to this repo, not on C:.
//   node scripts/android-icons.mjs
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RES = join(ROOT, 'android', 'app', 'src', 'main', 'res');
const TMP = join(ROOT, 'node_modules', '.cache', 'android-icons');
const LEGACY = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
const ADAPTIVE = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 };

const BROWSERS = [
  process.env.CHROME_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);
const browser = BROWSERS.find((p) => existsSync(p));
if (!browser) throw new Error('No Edge/Chrome found: set CHROME_PATH');

mkdirSync(TMP, { recursive: true });
const svg = (name) => 'data:image/svg+xml;base64,' + readFileSync(join(ROOT, 'public', name)).toString('base64');

/** draws `src` at size×size (optionally clipped to a circle) and writes the PNG to `out` */
function render(src, size, out, round = false) {
  const page = join(TMP, 'icon.html');
  writeFileSync(
    page,
    `<!doctype html><html><head><style>html,body{margin:0;background:transparent;overflow:hidden}` +
      `img{display:block;width:${size}px;height:${size}px;${round ? 'border-radius:50%;' : ''}}</style></head>` +
      `<body><img src="${src}"></body></html>`,
  );
  const shot = join(TMP, 'shot.png');
  rmSync(shot, { force: true });
  execFileSync(
    browser,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--default-background-color=00000000',
      `--user-data-dir=${join(TMP, 'profile')}`,
      `--window-size=${size},${size}`,
      `--screenshot=${shot}`,
      pathToFileURL(page).href,
    ],
    { stdio: 'ignore' },
  );
  if (!existsSync(shot)) throw new Error(`render failed: ${out}`);
  writeFileSync(out, readFileSync(shot));
}

const square = svg('icon.svg');
const full = svg('icon-maskable.svg');
for (const [d, px] of Object.entries(LEGACY)) {
  render(square, px, join(RES, `mipmap-${d}`, 'ic_launcher.png'));
  render(full, px, join(RES, `mipmap-${d}`, 'ic_launcher_round.png'), true);
}
for (const [d, px] of Object.entries(ADAPTIVE)) render(full, px, join(RES, `mipmap-${d}`, 'ic_launcher_background.png'));
console.log('android icons: written');
