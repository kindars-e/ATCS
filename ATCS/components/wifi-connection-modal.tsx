import React, { useState, useEffect, useCallback } from 'react';
import {
  Wifi, WifiOff, Settings, RefreshCw, ChevronRight, Shield,
  ChevronDown, ChevronUp, Terminal, Smartphone, Monitor, Cpu,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
// [STEP 2 — RUNTIME STABILITY] Real OS-level network state, replacing the
// previous approach of inferring connectivity purely from whether a raw
// WebSocket connect attempt timed out. Knowing there's no Wi-Fi link at all
// lets us skip the multi-second WS timeout entirely and show the correct
// status immediately; it also lets us auto-retry the moment Wi-Fi changes
// instead of requiring a manual "Retry" tap.
import { Network } from '@capacitor/network';

interface WiFiConnectionModalProps {
  onConnected: () => void;
}

declare global {
  interface Window {
    Capacitor?: {
      isNativePlatform(): boolean;
      platform: string;
      isPluginAvailable(name: string): boolean;
    };
  }
}

const SETUP_STEPS = [
  {
    icon: Cpu,
    title: "Flash the firmware",
    detail: "Open Arduino IDE → select your board (ESP32) → open ranger_rola.ino → click Upload.",
  },
  {
    icon: Wifi,
    title: "Power on the Rola node",
    detail: "The blue LED will blink once the Wi-Fi access point is ready (takes ~5 s).",
  },
  {
    icon: Smartphone,
    title: "Connect your phone/PC to Ranger Wi-Fi",
    detail: 'Go to Settings → Wi-Fi and join "Ranger-XXXX" (password: ranger123). Your device will show "no internet" — that is normal.',
  },
  {
    icon: Monitor,
    title: "Open this app",
    detail: "Return here and tap Retry. The app connects to ws://192.168.4.1:8765 automatically.",
  },
  {
    icon: Terminal,
    title: "Running in development (optional)",
    detail: "npm install && npm run dev  →  open http://localhost:3000  →  connect PC Wi-Fi to the Ranger hotspot.",
  },
];

export default function WiFiConnectionModal({ onConnected }: WiFiConnectionModalProps) {
  const [isChecking, setIsChecking] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'checking' | 'not-connected' | 'connected'>('checking');
  const [debugInfo, setDebugInfo] = useState('');
  const [showGuide, setShowGuide] = useState(false);

  const checkConnection = useCallback(async () => {
    setIsChecking(true);
    setDebugInfo('Checking connection to Ranger…');

    // [STEP 2 — FIX] Ask the OS first, but only to rule out "no radio link at
    // all" (Wi-Fi off / airplane mode). We deliberately do NOT use Capacitor's
    // `connected` boolean here: on Android it requires NET_CAPABILITY_VALIDATED
    // (i.e. the OS confirmed real internet access) — and the Ranger node's
    // hotspot has NO internet by design, so `connected` would always be false
    // even when correctly joined to the node, permanently short-circuiting this
    // check before the WebSocket was ever tried. `connectionType` reflects the
    // actual radio transport (wifi/cellular/none) regardless of internet
    // validation, so checking for `'none'` is the correct "is there any radio
    // link at all" signal without assuming internet exists.
    try {
      const netStatus = await Network.getStatus();
      if (netStatus.connectionType === 'none') {
        setConnectionStatus('not-connected');
        setDebugInfo('Wi-Fi is off — turn it on and join the Ranger network first.');
        setIsChecking(false);
        return;
      }
    } catch {
      // Network plugin unavailable (e.g. very old platform) — fall through
      // to the WebSocket-based check exactly as before.
    }

    try {
      if (window.Capacitor) {
        const ws = new WebSocket('ws://192.168.4.1:8765');
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 4000);
          ws.onopen  = () => { clearTimeout(timeout); ws.close(); resolve(true); };
          ws.onerror = () => { clearTimeout(timeout); reject(new Error('failed')); };
        });
        setConnectionStatus('connected');
        setDebugInfo('Connected to Ranger network!');
        setTimeout(() => onConnected(), 800);
      } else {
        // Web / dev mode — attempt real WS, fall back to dev skip
        try {
          const ws = new WebSocket('ws://192.168.4.1:8765');
          await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 3000);
            ws.onopen  = () => { clearTimeout(timeout); ws.close(); resolve(true); };
            ws.onerror = () => { clearTimeout(timeout); reject(new Error('failed')); };
          });
          setConnectionStatus('connected');
          setDebugInfo('Connected!');
          setTimeout(() => onConnected(), 800);
        } catch {
          // In dev, still allow manual skip
          setConnectionStatus('not-connected');
          setDebugInfo('Ranger not found on 192.168.4.1 — connect to Ranger Wi-Fi first.');
        }
      }
    } catch {
      setConnectionStatus('not-connected');
      setDebugInfo('Not connected to Ranger Wi-Fi');
    } finally {
      setIsChecking(false);
    }
  }, [onConnected]);

  useEffect(() => { checkConnection(); }, [checkConnection]);

  // [STEP 2] If the OS-reported network state changes while this screen is
  // showing (user joins/leaves Wi-Fi without leaving the app), re-run the
  // check automatically instead of requiring a manual "Retry" tap.
  useEffect(() => {
    let removeListener: (() => void) | undefined;
    let cancelled = false;

    Network.addListener('networkStatusChange', () => {
      checkConnection();
    }).then((handle) => {
      if (cancelled) handle.remove();
      else removeListener = () => handle.remove();
    });

    return () => {
      cancelled = true;
      removeListener?.();
    };
  }, [checkConnection]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-start bg-gray-900 overflow-y-auto">
      <div className="w-full max-w-md px-6 py-10">

        {/* Status icon + title */}
        <div className="text-center mb-8">
          <div className="w-24 h-24 mx-auto mb-4 relative">
            {connectionStatus === 'checking' || isChecking ? (
              <div className="absolute inset-0 bg-blue-600 rounded-full flex items-center justify-center animate-pulse">
                <Wifi className="w-12 h-12 text-white" />
              </div>
            ) : connectionStatus === 'not-connected' ? (
              <div className="absolute inset-0 bg-gray-800 rounded-full flex items-center justify-center">
                <WifiOff className="w-12 h-12 text-gray-400" />
              </div>
            ) : (
              <div className="absolute inset-0 bg-green-600 rounded-full flex items-center justify-center">
                <Wifi className="w-12 h-12 text-white" />
              </div>
            )}
          </div>

          <h2 className="text-2xl font-bold text-white mb-2">
            {connectionStatus === 'checking' || isChecking
              ? 'Searching for Ranger…'
              : connectionStatus === 'not-connected'
              ? 'Ranger Not Found'
              : 'Connected!'}
          </h2>
          <p className="text-gray-400 text-sm">
            {connectionStatus === 'checking' || isChecking
              ? 'Looking for your Ranger device on the local network'
              : connectionStatus === 'not-connected'
              ? 'Connect your device to the Ranger Wi-Fi hotspot'
              : 'Starting ATCS…'}
          </p>
        </div>

        {/* Quick steps (always shown when not connected) */}
        {connectionStatus === 'not-connected' && !isChecking && (
          <div className="bg-gray-800 rounded-2xl p-4 mb-4">
            <h3 className="text-white font-semibold mb-3 flex items-center gap-2">
              <Wifi className="w-4 h-4 text-blue-400" /> Quick setup
            </h3>
            <ol className="space-y-2 text-sm text-gray-300">
              <li className="flex items-start gap-2">
                <span className="text-blue-400 font-bold shrink-0">1.</span>
                Power on the Ranger node and wait for the LED to blink
              </li>
              <li className="flex items-start gap-2">
                <span className="text-blue-400 font-bold shrink-0">2.</span>
                Open Wi-Fi settings → connect to{" "}
                <span className="font-mono bg-gray-700 px-1.5 py-0.5 rounded text-xs">Ranger-XXXX</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-blue-400 font-bold shrink-0">3.</span>
                Come back here and tap <span className="text-white font-medium">Retry</span>
              </li>
            </ol>
          </div>
        )}

        {/* Full setup guide toggle */}
        {connectionStatus === 'not-connected' && !isChecking && (
          <button
            onClick={() => setShowGuide((v) => !v)}
            className="w-full flex items-center justify-between text-sm text-gray-400 hover:text-white transition-colors px-1 mb-4"
          >
            <span className="font-medium">Full setup &amp; developer guide</span>
            {showGuide ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
        )}

        {showGuide && (
          <div className="bg-gray-800 rounded-2xl p-4 mb-4 space-y-4">
            {SETUP_STEPS.map((step, i) => (
              <div key={i} className="flex gap-3">
                <div className="shrink-0 w-8 h-8 bg-gray-700 rounded-lg flex items-center justify-center">
                  <step.icon className="w-4 h-4 text-blue-400" />
                </div>
                <div>
                  <p className="text-white text-sm font-medium">{step.title}</p>
                  <p className="text-gray-400 text-xs mt-0.5 leading-relaxed">{step.detail}</p>
                </div>
              </div>
            ))}

            <div className="bg-gray-900/60 rounded-xl p-3 mt-2">
              <p className="text-xs text-gray-500 font-medium mb-1">WebSocket endpoint</p>
              <p className="font-mono text-xs text-blue-300">ws://192.168.4.1:8765</p>
              <p className="text-xs text-gray-500 mt-1">
                The Ranger node creates its own Wi-Fi hotspot — you connect directly, no router needed.
              </p>
            </div>
          </div>
        )}

        {/* Debug info */}
        {debugInfo && (
          <p className="text-center text-xs text-gray-500 mb-4">{debugInfo}</p>
        )}

        {/* Buttons */}
        <div className="space-y-3">
          {connectionStatus === 'not-connected' && !isChecking && (
            <>
              <Button
                onClick={checkConnection}
                className="w-full bg-blue-600 hover:bg-blue-700 text-white py-6 text-lg rounded-xl"
                disabled={isChecking}
              >
                <RefreshCw className={`w-5 h-5 mr-2 ${isChecking ? 'animate-spin' : ''}`} />
                Retry Connection
              </Button>

              <Button
                onClick={() => {
                  const msg = window.Capacitor?.isNativePlatform()
                    ? 'Go to Settings → Wi-Fi → connect to "Ranger-XXXX"'
                    : 'Open your Wi-Fi settings and connect to "Ranger-XXXX" (password: ranger123)';
                  alert(msg);
                }}
                variant="outline"
                className="w-full border-gray-700 text-gray-300 hover:bg-gray-800 py-6 text-lg rounded-xl"
              >
                <Settings className="w-5 h-5 mr-2" />
                Open Wi-Fi Settings
                <ChevronRight className="w-5 h-5 ml-auto" />
              </Button>
            </>
          )}

          {/* Dev skip */}
          {connectionStatus === 'not-connected' && !isChecking && (
            <Button
              onClick={() => onConnected()}
              variant="ghost"
              className="w-full text-gray-600 hover:text-gray-400 text-sm"
            >
              Skip (dev / demo mode)
            </Button>
          )}
        </div>

        <div className="mt-8 flex items-center justify-center gap-2 text-xs text-gray-600">
          <Shield className="w-3.5 h-3.5" />
          <span>Direct local connection · no internet required</span>
        </div>
      </div>
    </div>
  );
}
