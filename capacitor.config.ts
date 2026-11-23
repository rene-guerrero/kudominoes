import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.kudominoes.app',
  appName: 'Kudominoes',
  webDir: 'dist',
  // dark background behind the WebView while it boots (matches the game's boot screen)
  backgroundColor: '#0a1c2e',
  android: {
    backgroundColor: '#0a1c2e',
    allowMixedContent: false,
    webContentsDebuggingEnabled: false,
  },
};

export default config;
