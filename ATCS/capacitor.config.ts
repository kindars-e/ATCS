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
  // [FIX — C. Connecting to the actual node] The app's own page loads over
  // https://localhost (Capacitor's default Android scheme). Opening a plain
  // ws://192.168.4.1:8765 socket from that secure origin is "mixed content,"
  // and Chromium's WebView blocks it at the WebView layer before the request
  // ever reaches the network — regardless of Wi-Fi routing, regardless of
  // server.cleartext above (that flag only covers native/Capacitor-plugin
  // networking, not resource loads made by page JS like `new WebSocket(...)`).
  // This is why the app could never reach the node even on an isolated,
  // single, correctly-joined Wi-Fi network. allowMixedContent tells the
  // Android WebView to allow insecure requests from the secure page.
  android: {
    allowMixedContent: true,
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
