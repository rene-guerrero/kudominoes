import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.kudominoes.app',
  appName: 'Kudominoes',
  webDir: 'dist',
  // dark background behind the WebView while it boots (matches the game's boot screen)
  backgroundColor: '#2a160d',
  android: {
    backgroundColor: '#2a160d',
    allowMixedContent: false,
    webContentsDebuggingEnabled: false,
  },
};

export default config;
