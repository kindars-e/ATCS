// ─────────────────────────────────────────────────────────────────────────────
// components/add-device-modal.tsx
//
// Replaces the previous three-tab (Scan / QR / Manual) dialog.
//
// PER NEW REQUIREMENTS:
//   • Manual entry tab is REMOVED.
//   • Two tabs remain: "Scan" (auto-discover) and "QR Code".
//   • The Scan tab now uses CONTINUOUS scanning — it automatically re-pings
//     every few seconds without the user pressing a button again.
//   • When the user taps "Add" on a discovered node, a pair request is sent
//     automatically via LoRa so the other side adds us without manual action.
//
// HOW CONTINUOUS SCANNING WORKS (for beginners):
//   A normal scan fires ONE discovery ping and waits 5 s for replies.
//   Continuous scanning fires a ping, waits 5 s, then immediately fires
//   another ping — over and over — until the user taps "Stop Scanning"
//   or closes the modal.  Each ping can surface NEW nodes that came online
//   since the last ping.  Previously discovered nodes stay in the list.
//
// HOW AUTOMATIC PAIRING WORKS:
//   When you tap "Add" on a node:
//     1. We send ##PAIR_REQ##<ourName> to that node over LoRa.
//     2. The firmware relays it to their app.
//     3. Their app automatically replies with ##PAIR_ACK##<theirName>.
//     4. We receive the ACK and add them as a contact.
//   This means ONLY ONE person needs to tap "Add" — the other side pairs
//   automatically without any manual steps.
// ─────────────────────────────────────────────────────────────────────────────

"use client";

import React, { useState, useRef, useCallback, useEffect } from "react";
import { X, Scan, Radio, Plus, Check, Loader2, StopCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  RADIO_FREQUENCY_HZ,
  RADIO_SPREADING_FACTOR,
  RADIO_BANDWIDTH_HZ,
  DISCOVERY_SCAN_DURATION_MS,
  DISCOVERY_REPOLL_DELAY_MS,
} from "@/lib/constants";
import type { Contact } from "@/lib/types";

export interface DiscoveredNode {
  deviceId: string;
  rssi?:    number;
}

interface AddDeviceModalProps {
  onAdd:              (contact: Contact) => void;
  onClose:            () => void;
  connectedDeviceId:  string;
  connectedDeviceName: string;   // [NEW] our own device name, included in pair requests
  onDiscover:         () => void;
  discoveredNodes:    DiscoveredNode[];
  isDiscovering:      boolean;
  // [NEW] Called when user taps "Add" — sends the pair request LoRa packet.
  onPairRequest:      (targetId: string) => void;
}

function makeContact(deviceId: string, deviceName: string): Contact {
  return {
    deviceId,
    deviceName: deviceName || `Ranger ${deviceId}`,
    frequency:       RADIO_FREQUENCY_HZ,
    spreadingFactor: RADIO_SPREADING_FACTOR,
    bandwidth:       RADIO_BANDWIDTH_HZ,
    unreadCount:     0,
    status:          "offline",
    lastSeen:        new Date(),
  };
}

function parseQrUri(raw: string): { deviceId: string; deviceName: string } | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "fling:") return null;
    const id   = url.searchParams.get("id")   ?? "";
    const name = url.searchParams.get("name") ?? "";
    if (!id) return null;
    return { deviceId: id, deviceName: name || `Ranger ${id}` };
  } catch {
    return null;
  }
}

type Tab = "discover" | "qr";

export default function AddDeviceModal({
  onAdd,
  onClose,
  connectedDeviceId,
  connectedDeviceName,
  onDiscover,
  discoveredNodes,
  isDiscovering,
  onPairRequest,
}: AddDeviceModalProps) {

  const [tab,        setTab]        = useState<Tab>("discover");
  const [qrError,    setQrError]    = useState("");
  const [added,      setAdded]      = useState<string | null>(null);

  // [NEW] Track whether continuous scanning is active so we can show a
  // "Stop Scanning" button.
  const [continuousActive, setContinuousActive] = useState(false);
  const continuousTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const continuousAliveRef  = useRef(false);   // guards async closure

  const videoRef   = useRef<HTMLVideoElement>(null);
  const streamRef  = useRef<MediaStream | null>(null);
  const scannerRef = useRef<number | null>(null);

  // ── [NEW] Continuous scan logic ────────────────────────────────────────────
  //
  // How it works:
  //   startContinuousScan() fires one discovery ping immediately, then
  //   schedules another ping after (DISCOVERY_SCAN_DURATION_MS + REPOLL_DELAY_MS).
  //   This repeats until stopContinuousScan() is called.
  //
  // Why we need continuousAliveRef:
  //   JavaScript timers run asynchronously.  If the user closes the modal
  //   before the timer fires, we must NOT call onDiscover again.  The ref
  //   acts as a cancellation flag — if it's false the timer callback does
  //   nothing.

  const stopContinuousScan = useCallback(() => {
    continuousAliveRef.current = false;
    setContinuousActive(false);
    if (continuousTimerRef.current) {
      clearTimeout(continuousTimerRef.current);
      continuousTimerRef.current = null;
    }
  }, []);

  const startContinuousScan = useCallback(() => {
    // If already running, stop first so we don't stack timers.
    stopContinuousScan();

    continuousAliveRef.current = true;
    setContinuousActive(true);

    // Fire the first ping immediately.
    onDiscover();

    // Schedule subsequent pings.
    const scheduleNext = () => {
      if (!continuousAliveRef.current) return;
      continuousTimerRef.current = setTimeout(() => {
        if (!continuousAliveRef.current) return;
        onDiscover();
        scheduleNext();
      }, DISCOVERY_SCAN_DURATION_MS + DISCOVERY_REPOLL_DELAY_MS);
    };
    scheduleNext();
  }, [onDiscover, stopContinuousScan]);

  // Start continuous scan as soon as the "discover" tab is shown.
  useEffect(() => {
    if (tab === "discover") {
      startContinuousScan();
    } else {
      stopContinuousScan();
    }
    // Clean up when the modal is closed or the tab changes.
    return () => stopContinuousScan();
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  // Also stop scanning when the modal unmounts.
  useEffect(() => {
    return () => {
      stopContinuousScan();
      stopCamera();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── QR camera helpers ──────────────────────────────────────────────────────
  const startCamera = useCallback(async () => {
    setQrError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play();
      }
      if ("BarcodeDetector" in window) {
        const detector = new (window as unknown as {
          BarcodeDetector: new (opts: { formats: string[] }) => {
            detect: (src: HTMLVideoElement) => Promise<{ rawValue: string }[]>;
          };
        }).BarcodeDetector({ formats: ["qr_code"] });

        const scan = async () => {
          if (!videoRef.current) return;
          try {
            const codes = await detector.detect(videoRef.current);
            if (codes.length > 0) {
              stopCamera();
              handleQrResult(codes[0].rawValue);
              return;
            }
          } catch {/* frame not ready */}
          scannerRef.current = requestAnimationFrame(scan);
        };
        scannerRef.current = requestAnimationFrame(scan);
      } else {
        setQrError(
          "Your browser does not support BarcodeDetector. " +
          "Use Chrome, or paste the fling:// URI in the field below.",
        );
      }
    } catch {
      setQrError("Camera access denied.");
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const stopCamera = useCallback(() => {
    if (scannerRef.current)  cancelAnimationFrame(scannerRef.current);
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, []);

  const handleQrResult = (raw: string) => {
    const parsed = parseQrUri(raw);
    if (!parsed) {
      setQrError(`Unrecognised QR code: "${raw}"`);
      return;
    }
    handleAdd(parsed.deviceId, parsed.deviceName, false); // QR pair doesn't need LoRa request
  };

  // ── [NEW] Add a contact + send pair request ────────────────────────────────
  //
  // sendPairReq = true  → this came from the Scan tab; send a LoRa pair
  //                        request so the other node adds us automatically.
  // sendPairReq = false → came from QR code; we add the contact locally and
  //                        also send a pair request so the other side adds us.
  const handleAdd = (deviceId: string, deviceName: string, sendPairReq = true) => {
    if (!deviceId.trim()) return;
    const contact = makeContact(deviceId.trim(), deviceName.trim());
    onAdd(contact);

    // [NEW] Always send a pair request so the other node learns our name.
    // For QR pairing this still helps because the other side doesn't have us.
    if (sendPairReq) {
      onPairRequest(deviceId.trim());
    }

    setAdded(deviceId);
    setTimeout(() => {
      setAdded(null);
      onClose();
    }, 1800);
  };

  const handleClose = () => {
    stopCamera();
    stopContinuousScan();
    onClose();
  };

  // ── RSSI → signal-strength label helper ───────────────────────────────────
  const rssiLabel = (rssi?: number) => {
    if (rssi === undefined) return "";
    if (rssi >= -60) return "Excellent";
    if (rssi >= -75) return "Good";
    if (rssi >= -90) return "Fair";
    return "Weak";
  };

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-gray-800 rounded-3xl p-6 max-w-md w-full shadow-2xl">

        {/* Header */}
        <div className="flex justify-between items-center mb-5">
          <h2 className="text-2xl font-bold text-white">Add Device</h2>
          <Button
            variant="ghost" size="icon"
            onClick={handleClose}
            className="rounded-full text-gray-400 hover:text-white hover:bg-gray-700"
          >
            <X className="h-5 w-5" />
          </Button>
        </div>

        {/* Tab bar — only Scan and QR now; Manual is removed */}
        <div className="flex gap-2 mb-6 bg-gray-700/50 rounded-xl p-1">
          {(["discover", "qr"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => { stopCamera(); setTab(t); }}
              className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${
                tab === t
                  ? "bg-blue-600 text-white"
                  : "text-gray-400 hover:text-white"
              }`}
            >
              {t === "discover" && <><Radio className="inline h-3.5 w-3.5 mr-1" />Scan</>}
              {t === "qr"       && <><Scan  className="inline h-3.5 w-3.5 mr-1" />QR Code</>}
            </button>
          ))}
        </div>

        {/* ── TAB: AUTO-DISCOVER ──────────────────────────────────────────── */}
        {tab === "discover" && (
          <div className="text-center">
            {/* Status line */}
            <div className="flex items-center justify-center gap-2 mb-3">
              {isDiscovering ? (
                <p className="text-blue-400 text-sm flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Scanning… (auto-repeating)
                </p>
              ) : (
                <p className="text-gray-400 text-sm">
                  Scan will restart automatically
                </p>
              )}
            </div>

            {/* Stop button — shown while continuous scan is running */}
            {continuousActive ? (
              <Button
                onClick={stopContinuousScan}
                variant="outline"
                className="border-red-600 text-red-400 hover:bg-red-900/20 rounded-full px-6 py-2 mb-4"
              >
                <StopCircle className="h-4 w-4 mr-2" />
                Stop Scanning
              </Button>
            ) : (
              <Button
                onClick={startContinuousScan}
                className="bg-blue-600 hover:bg-blue-700 text-white rounded-full px-6 py-2 mb-4"
              >
                <Radio className="h-4 w-4 mr-2" />
                Start Scanning
              </Button>
            )}

            {/* Discovered nodes list */}
            {discoveredNodes.length > 0 && (
              <div className="space-y-2 mt-2 max-h-56 overflow-y-auto">
                {discoveredNodes
                  .filter((n) => n.deviceId !== connectedDeviceId)
                  .map((n) => (
                    <div
                      key={n.deviceId}
                      className="flex items-center justify-between bg-gray-700 rounded-xl px-4 py-3"
                    >
                      <div className="text-left">
                        <p className="text-white font-medium">Ranger {n.deviceId}</p>
                        {n.rssi !== undefined && (
                          <p className="text-gray-400 text-xs">
                            {n.rssi} dBm — {rssiLabel(n.rssi)}
                          </p>
                        )}
                      </div>
                      {added === n.deviceId
                        ? (
                          <div className="flex items-center gap-1 text-green-400 text-sm">
                            <Check className="h-5 w-5" />
                            <span>Pairing…</span>
                          </div>
                        ) : (
                          <Button
                            size="sm"
                            onClick={() => handleAdd(n.deviceId, `Ranger ${n.deviceId}`, true)}
                            className="bg-blue-600 hover:bg-blue-700 text-white rounded-full px-4"
                          >
                            <Plus className="h-4 w-4 mr-1" />Add
                          </Button>
                        )}
                    </div>
                  ))}
              </div>
            )}

            {discoveredNodes.filter((n) => n.deviceId !== connectedDeviceId).length === 0 && (
              <p className="text-gray-500 text-xs mt-3">
                {continuousActive
                  ? "Searching… make sure the other node is powered on and within range."
                  : "Tap Start Scanning to find nearby nodes."}
              </p>
            )}

            {/* Info about auto-pairing */}
            <p className="text-gray-600 text-xs mt-4 leading-relaxed">
              When you tap <strong className="text-gray-400">Add</strong>, a pair request is sent
              automatically — the other device will add you without any manual steps.
            </p>
          </div>
        )}

        {/* ── TAB: QR CODE ───────────────────────────────────────────────── */}
        {tab === "qr" && (
          <div className="text-center">
            <p className="text-gray-400 text-sm mb-4">
              Point your camera at the QR code on the other Rola node or its
              printed setup sheet.
            </p>

            <div className="relative mx-auto w-64 h-64 bg-black rounded-xl overflow-hidden mb-4">
              <video ref={videoRef} className="w-full h-full object-cover" muted playsInline />
              <div className="absolute inset-4 border-2 border-white/30 rounded-lg pointer-events-none" />
            </div>

            {qrError && (
              <p className="text-red-400 text-xs mb-3">{qrError}</p>
            )}

            {!streamRef.current ? (
              <Button
                onClick={startCamera}
                className="bg-blue-600 hover:bg-blue-700 text-white rounded-full px-6"
              >
                <Scan className="h-4 w-4 mr-2" />Open Camera
              </Button>
            ) : (
              <Button
                onClick={stopCamera}
                variant="outline"
                className="border-gray-600 text-gray-300 rounded-full px-6"
              >
                Stop Camera
              </Button>
            )}

            {/* Development fallback: paste the fling:// URI */}
            <p className="text-gray-600 text-xs mt-4">
              In development? Paste the URI below:
            </p>
            <input
              type="text"
              placeholder="fling://pair?id=Node2&name=Fling_Node2"
              onBlur={(e) => { if (e.target.value) handleQrResult(e.target.value); }}
              className="mt-2 w-full bg-gray-700 text-white text-xs rounded-lg px-3 py-2 outline-none placeholder-gray-500"
            />

            {/* Show QR URI for THIS node so the other person can scan us */}
            <div className="mt-5 bg-gray-700/50 rounded-xl p-3 text-left">
              <p className="text-xs text-gray-400 font-medium mb-1">
                Let others scan YOU:
              </p>
              <p className="text-xs text-blue-400 font-mono break-all">
                {connectedDeviceId
                  ? `fling://pair?id=${connectedDeviceId}&name=${encodeURIComponent(connectedDeviceName || connectedDeviceId)}`
                  : "(connect to a node first)"}
              </p>
              <p className="text-xs text-gray-500 mt-1">
                Copy this URI into any QR generator and print it on your node.
              </p>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
