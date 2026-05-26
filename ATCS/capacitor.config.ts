import type { CapacitorConfig } from '@capacitor/cli';
import { KeyboardResize } from '@capacitor/keyboard'; // <-- 1. Import the enum

const config: CapacitorConfig = {
  // [ATCS] Display name shown under the app icon. The appId (bundle identifier)
  // is intentionally left as-is — changing it is a technical/signing concern,
  // not branding, and would affect app-store identity and installed-app upgrades.
  appId: 'com.fling.app',
  appName: 'ATCS',
  webDir: 'out',
  server: {
    iosScheme: 'capacitor',
    cleartext: true,
    allowNavigation: [
      'ws://192.168.4.1:8765',
      'ws://192.168.4.1:*',
      'ws://*/*'
    ]
  },
  ios: {
    allowsLinkPreview: false,
    limitsNavigationsToAppBoundDomains: false
  },
  plugins: {
    Keyboard: {
      resize: KeyboardResize.Body, // <-- 2. Use the enum member here
      resizeOnFullScreen: true,
    },
  },
};

export default config;
