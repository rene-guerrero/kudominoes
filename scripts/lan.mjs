// Local play, PC dev host: builds the game, then serves it on the local network together with the room
// server (the same RoomCore the Worker runs), so browsers on the same Wi-Fi (PC, phone) can play with no
// internet. Usage:
//   npm run lan                 (build, then serve on port 8787 or the next free one)
//   npm run lan -- --no-build   (serve the existing dist/)
//   npm run lan -- --port 9000
// Windows asks once to let Node through the firewall: allow it on private networks.
import { resolve } from 'node:path';
import { build, createServer } from 'vite';
import { serveLan } from 'kunet/node';

const root = resolve(import.meta.dirname, '..');
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? null : process.argv[i + 1];
};

if (!process.argv.includes('--no-build')) {
  console.log('[lan] building the game…');
  await build({ root, logLevel: 'warn' });
}

// load the TypeScript room core through Vite (no separate server build)
const vite = await createServer({
  root,
  configFile: resolve(root, 'vite.config.ts'),
  server: { middlewareMode: true, hmr: false, watch: null },
  appType: 'custom',
  ssr: { noExternal: ['kunet', 'kuavatars'] },
  optimizeDeps: { noDiscovery: true, include: [] },
  logLevel: 'warn',
});
const { makeCore, CODE_RULES, normalizeCode, GAME_ID } = await vite.ssrLoadModule('/src/net/room/local.ts');
const { LocalHost } = await vite.ssrLoadModule('kunet');

const host = new LocalHost(makeCore, { codes: CODE_RULES, maxRooms: 8 });
const lan = await serveLan({
  root: resolve(root, 'dist'),
  game: GAME_ID,
  host,
  normalizeCode: (s) => normalizeCode(s) ?? '',
  port: Number(arg('--port') ?? 8787),
  name: 'PC',
});

console.log('\n  Kudominoes — jugar con amigos (red local)\n');
console.log(`  En este PC:        ${lan.urls[0]}`);
for (const u of lan.urls.slice(1)) console.log(`  Otros dispositivos: ${u}`);
if (lan.urls.length === 1) console.log('  (no se encontró ninguna red local: conecta el PC a una red Wi-Fi)');
console.log('\n  Ctrl+C para cerrar.\n');

const stop = async () => {
  host.stop();
  await lan.close();
  await vite.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
// Windows does not always pass Ctrl+C / a killed terminal on to child processes: exit with the parent
const parent = process.ppid;
setInterval(() => {
  try {
    process.kill(parent, 0);
  } catch {
    void stop();
  }
}, 2000).unref();
