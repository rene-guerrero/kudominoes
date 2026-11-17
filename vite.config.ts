import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  // relative base: GitHub Pages subpath and the Capacitor WebView both need it
  base: './',
  // the app version shown in Acerca de (src/ui/about.ts)
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  server: { port: 5173, host: true },
  build: {
    // es2020 keeps ?. / ?? native (Chrome 80+) and lowers class fields / ??= / ||= for older WebViews;
    // the code already needs Chrome 98+ at runtime anyway (structuredClone), so nothing is polyfilled.
    target: 'es2020',
    outDir: 'dist',
    // Only the boot chunk's static imports get <link rel="modulepreload"> in index.html (Vite's
    // default). The game chunk and three.js are preloaded by the dynamic import, after the menu paints.
    modulePreload: { polyfill: false },
    rollupOptions: {
      output: {
        manualChunks(id) {
          // three.js changes far less often than the game: its own long-cached vendor chunk. It stays one
          // chunk: three's package entry is a single pre-bundled module (~512 kB after tree-shaking), and
          // aliasing 'three' to its src/ to split it further costs ~20 kB and creates chunk cycles (TDZ errors).
          if (id.includes('/node_modules/three/')) return 'three';
        },
      },
    },
  },
});
