// ─────────────────────────────────────────────────────────────────────────────
// hooks/use-ranger-connection.ts
//
// React hook that manages the WebSocket connection to the Ranger node.
//
// HOW IT WORKS (for beginners):
//   A "hook" in React is a reusable piece of logic that a component can "plug
//   in" to get certain capabilities.  This hook manages the network connection:
//   1. When enabled=true it opens a WebSocket to ws://192.168.4.1:8765.
//   2. Every JSON message from the firmware is decoded and forwarded via onEvent.
//   3. If the connection drops it reconnects automatically (exponential back-off).
//   4. The send() function lets the rest of the app send commands to the node.
//
// [NEW] Additional events emitted:
//   pair-request  – another node wants to pair with us
//   pair-accepted – the node we sent a pair request to has accepted
//
// [STEP 2 — RUNTIME STABILITY] Android lifecycle + network awareness.
//   A WebSocket that reads readyState===OPEN is not proof the link is alive:
//   Android can freeze this app's JS timers while it's backgrounded (screen
//   locked / another app in front), and/or the OS can drop Wi-Fi entirely,
//   without ever firing a clean `onclose`. Two Capacitor plugins close that
//   gap:
//     @capacitor/app     – tells us when the app resumes/pauses. On resume we
//                          don't wait for the next scheduled heartbeat tick
//                          (which may have been frozen) — we verify the
//                          connection immediately. On pause we stop the
//                          heartbeat timer so we're not burning battery
//                          pinging a socket Android is about to suspend.
//     @capacitor/network – tells us the REAL OS-level Wi-Fi state, instead of
//                          inferring connectivity purely from a WebSocket
//                          connect/timeout. A network loss flips the UI state
//                          immediately rather than waiting for the socket to
//                          eventually time out.
//   Both plugins ship a web-platform fallback (visibility/online events), so
//   this still works unchanged in a plain browser during `npm run dev`.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from "react";
import { App, type AppState } from "@capacitor/app";
import { Network, type ConnectionStatus } from "@capacitor/network";
import {
  CONNECT_TIMEOUT_MS,
  MAX_RECONNECT_ATTEMPTS,
  PING_INTERVAL_MS,
  PONG_TIMEOUT_MS,
  RANGER_WS_URL,
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
} from "@/lib/constants";
import { decodeMessage, type OutgoingFrame } from "@/lib/protocol";
import type { ConnectionState } from "@/lib/types";

// ── Events the hook can emit to the rest of the app ──────────────────────────
export type RangerEvent =
  // [NEW] broadcast: true when this text arrived as a LoRa "*" broadcast
  // (an emergency message). The app routes broadcasts into the Emergency thread.
  | { kind: "text";               sender: string; content: string; broadcast: boolean; rssi?: number; snr?: number }
  | { kind: "location-request";   sender: string }
  | { kind: "location-response";  sender: string; lat: number; lng: number; accuracy: number }
  | { kind: "location-broadcast"; sender: string; lat: number; lng: number; accuracy: number }
  | { kind: "frequency-update";   frequency: number }
  | { kind: "delivery-confirmed" }
  // [STEP 4A] hops: how many mesh hops away the discovered node is. Used to
  // tag the RSSI reading as direct (0) vs relayed (>0) — see signalHopDistance.
  | { kind: "node-discovered";    deviceId: string; rssi?: number; snr?: number; hops?: number }
  // [STEP 4A] Relayed RSSI/SNR from a direct neighbor's HELLO beacon — no new
  // LoRa traffic, just the firmware forwarding a reading it already had.
  | { kind: "neighbor-heard";     deviceId: string; rssi?: number; snr?: number }
  // [NEW] Another node sent us a ##PAIR_REQ## over LoRa.
  | { kind: "pair-request";       sender: string; senderName: string }
  // [NEW] A node we paired with replied with ##PAIR_ACK## — add them to contacts.
  | { kind: "pair-accepted";      sender: string; senderName: string };

interface UseRangerConnectionOptions {
  enabled:  boolean;
  onEvent:  (event: RangerEvent) => void;
}

interface UseRangerConnectionResult {
  connectionState:     ConnectionState;
  isOnline:            boolean;
  connectedDeviceId:   string;
  connectedDeviceName: string;   // [NEW] firmware's WIFI_SSID (our display name)
  lastConnectionError: string;
  reconnectAttempts:   number;
  send:                (frame: OutgoingFrame) => boolean;
  reconnect:           () => void;
}

export function useRangerConnection({
  enabled,
  onEvent,
}: UseRangerConnectionOptions): UseRangerConnectionResult {

  const [connectionState,     setConnectionState]     = useState<ConnectionState>("disconnected");
  const [isOnline,            setIsOnline]            = useState(false);
  const [lastConnectionError, setLastConnectionError] = useState("");
  const [connectedDeviceId,   setConnectedDeviceId]   = useState("");
  // [NEW] Store the firmware's display name (WIFI_SSID) so we can include it
  // in outgoing pair requests so the recipient knows what to call us.
  const [connectedDeviceName, setConnectedDeviceName] = useState("");
  const [reconnectAttempts,   setReconnectAttempts]   = useState(0);

  const wsRef               = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const healthCheckRef      = useRef<ReturnType<typeof setInterval> | null>(null);
  // [v5 WIFI-STABILITY] Heartbeat bookkeeping.
  //   lastPongRef  – timestamp (ms) of the last message of ANY kind we received
  //                  from the firmware. Updated on every incoming frame.
  //   pingTimerRef – interval that sends {"type":"ping"} and checks liveness.
  const lastPongRef         = useRef<number>(0);
  const pingTimerRef        = useRef<ReturnType<typeof setInterval> | null>(null);
  const attemptsRef         = useRef(0);
  const enabledRef          = useRef(enabled);
  const onEventRef          = useRef(onEvent);

  // [STEP 2] Tracks whether the OS currently reports a real network/Wi-Fi
  // link, independent of our own WebSocket's belief about its state.
  const networkConnectedRef = useRef(true);

  useEffect(() => { enabledRef.current = enabled; }, [enabled]);
  useEffect(() => { onEventRef.current = onEvent;  }, [onEvent]);

  // [STEP 2] Heartbeat start/stop pulled out of connect()'s onopen handler so
  // the app-lifecycle listener can stop it on background and restart it on
  // resume, without tearing down and reopening the WebSocket itself.
  const startHeartbeat = useCallback(() => {
    if (pingTimerRef.current) clearInterval(pingTimerRef.current);
    pingTimerRef.current = setInterval(() => {
      const socket = wsRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;

      if (Date.now() - lastPongRef.current > PONG_TIMEOUT_MS) {
        try { socket.close(); } catch { /* ignore */ }
        return;
      }
      try { socket.send(JSON.stringify({ type: "ping" })); } catch { /* ignore */ }
    }, PING_INTERVAL_MS);
  }, []);

  const stopHeartbeat = useCallback(() => {
    if (pingTimerRef.current) {
      clearInterval(pingTimerRef.current);
      pingTimerRef.current = null;
    }
  }, []);

  const connect = useCallback(() => {
    if (!enabledRef.current) return;
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    setConnectionState("connecting");

    let ws: WebSocket;
    try {
      ws = new WebSocket(RANGER_WS_URL);
    } catch {
      setConnectionState("error");
      setLastConnectionError("Failed to create WebSocket connection");
      return;
    }
    wsRef.current = ws;

    const connectTimeout = setTimeout(() => {
      if (ws.readyState === WebSocket.CONNECTING) {
        ws.close();
        setConnectionState("error");
        setLastConnectionError("Connection timeout — check your Wi-Fi connection");
      }
    }, CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      clearTimeout(connectTimeout);
      setConnectionState("connected");
      setIsOnline(true);
      setLastConnectionError("");
      attemptsRef.current = 0;
      setReconnectAttempts(0);
      lastPongRef.current = Date.now();   // seed liveness clock on connect

      // [v5 WIFI-STABILITY] REAL heartbeat (replaces the old fake check).
      //
      // The old code only looked at ws.readyState. But a socket can read OPEN
      // while the firmware has actually died/rebooted — the browser doesn't
      // find out until a send fails. That caused the "frozen but looks
      // connected" bug.
      //
      // Instead we now actively prove the link is alive: every PING_INTERVAL_MS
      // we send {"type":"ping"} and check that SOME message arrived from the
      // firmware within PONG_TIMEOUT_MS (any frame counts — the firmware replies
      // with "pong", and normal traffic counts too). If the link has gone
      // silent past the timeout, we treat the socket as dead and force a
      // reconnect rather than waiting forever.
      startHeartbeat();
    };

    ws.onclose = () => {
      clearTimeout(connectTimeout);
      setConnectionState("disconnected");
      setIsOnline(false);
      wsRef.current = null;

      // [v5] Stop the heartbeat — a new one starts when we reconnect (onopen).
      stopHeartbeat();
      if (healthCheckRef.current) {
        clearInterval(healthCheckRef.current);
        healthCheckRef.current = null;
      }

      if (enabledRef.current && attemptsRef.current < MAX_RECONNECT_ATTEMPTS) {
        const delay = Math.min(
          RECONNECT_BASE_DELAY_MS * 2 ** attemptsRef.current,
          RECONNECT_MAX_DELAY_MS,
        );
        attemptsRef.current += 1;
        setReconnectAttempts(attemptsRef.current);
        setConnectionState("reconnecting");
        reconnectTimeoutRef.current = setTimeout(connect, delay);
      } else if (attemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
        setConnectionState("error");
        setLastConnectionError("Max reconnection attempts reached. Check your connection.");
      }
    };

    ws.onerror = () => {
      clearTimeout(connectTimeout);
      setConnectionState("error");
      setLastConnectionError("Connection error — please try again");
    };

    // ── Incoming frame handler ──────────────────────────────────────────────
    ws.onmessage = (event) => {
      // [v5 WIFI-STABILITY] ANY message from the firmware proves the link is
      // alive, so refresh the liveness clock here before doing anything else.
      lastPongRef.current = Date.now();

      let frame: { type: string; [key: string]: unknown };
      try {
        frame = JSON.parse(event.data as string);
      } catch {
        return;
      }

      const emit = onEventRef.current;

      switch (frame.type) {

        // [v5] Heartbeat reply — no app action needed; the liveness clock above
        // already recorded it. We just swallow it so it doesn't hit `default`.
        case "pong":
          break;

        case "message": {
          // [NEW] Read the optional broadcast flag the firmware sets for LoRa
          // packets addressed to "*". decodeMessage threads it through to the
          // text event so fling-app can route it to the Emergency thread.
          const isBroadcast = (frame.broadcast as boolean | undefined) === true;
          // [v6] Pull signal readings from the frame to forward with the text.
          const rssi = frame.rssi as number | undefined;
          const snr  = frame.snr  as number | undefined;

          const decoded = decodeMessage({
            sender:    (frame.sender as string) ?? "unknown",
            data:      (frame.data   as string) ?? "",
            broadcast: isBroadcast,
          });

          if (decoded.kind === "text") {
            emit({
              kind:      "text",
              sender:    decoded.sender,
              content:   decoded.content,
              broadcast: decoded.broadcast,
              rssi,            // [v6] forward signal strength
              snr,             // [v6] forward signal-to-noise
            });

          } else if (decoded.kind === "location-request") {
            emit({ kind: "location-request", sender: decoded.sender });

          } else if (decoded.kind === "location-response") {
            emit({
              kind:     "location-response",
              sender:   decoded.sender,
              lat:      decoded.lat,
              lng:      decoded.lng,
              accuracy: decoded.accuracy,
            });

          // [NEW] Another node sent us ##PAIR_REQ## — forward to fling-app so
          // it can automatically accept and add the sender as a contact.
          } else if (decoded.kind === "pair-request") {
            emit({
              kind:       "pair-request",
              sender:     decoded.sender,
              senderName: decoded.senderName,
            });

          // [NEW] Our pair request was accepted — add the node as a contact.
          } else if (decoded.kind === "pair-accept") {
            emit({
              kind:       "pair-accepted",
              sender:     decoded.sender,
              senderName: decoded.senderName,
            });
          }
          break;
        }

        case "location": {
          emit({
            kind:     "location-broadcast",
            sender:   (frame.sender   as string) ?? "unknown",
            lat:      frame.lat       as number,
            lng:      frame.lng       as number,
            accuracy: (frame.accuracy as number | undefined) ?? 10,
          });
          break;
        }

        case "device_info": {
          setConnectedDeviceId(frame.deviceId as string);
          // [NEW] Store the device name (WIFI_SSID) for use in pair requests.
          setConnectedDeviceName((frame.deviceName as string) ?? "");
          const freq = frame.frequency as number | undefined;
          if (freq && freq !== 433_000_000) {
            emit({ kind: "frequency-update", frequency: freq });
          }
          break;
        }

        case "delivery": {
          if ((frame.status as string) === "delivered") {
            emit({ kind: "delivery-confirmed" });
          }
          break;
        }

        case "discovery": {
          emit({
            kind:     "node-discovered",
            deviceId: (frame.deviceId as string) ?? "",
            rssi:     frame.rssi as number | undefined,
            snr:      frame.snr  as number | undefined,   // [v6] forward SNR
            hops:     frame.hops as number | undefined,    // [STEP 4A]
          });
          break;
        }

        // [STEP 4A] Relayed HELLO reading for a direct neighbor.
        case "neighbor": {
          emit({
            kind:     "neighbor-heard",
            deviceId: (frame.deviceId as string) ?? "",
            rssi:     frame.rssi as number | undefined,
            snr:      frame.snr  as number | undefined,
          });
          break;
        }

        default:
          break;
      }
    };
  }, [startHeartbeat, stopHeartbeat]);

  useEffect(() => {
    if (enabled) connect();

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      if (healthCheckRef.current) {
        clearInterval(healthCheckRef.current);
        healthCheckRef.current = null;
      }
      // [v5] Also clear the heartbeat interval so it doesn't outlive the hook.
      if (pingTimerRef.current) {
        clearInterval(pingTimerRef.current);
        pingTimerRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [enabled, connect]);

  const send = useCallback((frame: OutgoingFrame): boolean => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(frame));
    return true;
  }, []);

  const reconnect = useCallback(() => {
    attemptsRef.current = 0;
    setReconnectAttempts(0);
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.close();
      wsRef.current = null;
    }
    connect();
  }, [connect]);

  // [STEP 2] Called on app resume (and after a network-returns event) to
  // confirm the connection is REALLY alive right now, instead of trusting
  // whatever state we were last in before a possible Android-induced freeze.
  //   - No socket / not OPEN            → reconnect immediately.
  //   - OPEN but heartbeat reply is old → treat as dead, reconnect.
  //   - OPEN and recently heard from    → send an immediate ping to refresh
  //                                       the liveness clock right now rather
  //                                       than waiting for the next tick.
  const verifyConnectionNow = useCallback(() => {
    if (!enabledRef.current) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reconnect();
      return;
    }
    if (Date.now() - lastPongRef.current > PONG_TIMEOUT_MS) {
      reconnect();
      return;
    }
    try {
      ws.send(JSON.stringify({ type: "ping" }));
    } catch {
      reconnect();
    }
  }, [reconnect]);

  // [STEP 2] Android lifecycle: on resume, verify the connection right away
  // (don't wait for a possibly-frozen heartbeat tick); on pause, stop the
  // heartbeat so we're not pinging a socket the OS may be about to suspend.
  // @capacitor/app has a web fallback (visibility/focus events), so this is
  // a no-op-safe addition in a plain browser during `npm run dev`.
  useEffect(() => {
    let removeListener: (() => void) | undefined;
    let cancelled = false;

    App.addListener("appStateChange", (state: AppState) => {
      if (state.isActive) {
        if (enabledRef.current) {
          startHeartbeat();
          verifyConnectionNow();
        }
      } else {
        stopHeartbeat();
      }
    }).then((handle) => {
      if (cancelled) handle.remove();
      else removeListener = () => handle.remove();
    });

    return () => {
      cancelled = true;
      removeListener?.();
    };
  }, [startHeartbeat, stopHeartbeat, verifyConnectionNow]);

  // [STEP 2] Real OS-level network awareness: a network loss flips the UI
  // state immediately (instead of waiting for the WebSocket to eventually
  // time out), and a network's return triggers an immediate reconnect
  // attempt instead of waiting on the backoff schedule.
  useEffect(() => {
    let removeListener: (() => void) | undefined;
    let cancelled = false;

    // [FIX] Deliberately NOT using ConnectionStatus.connected here: on Android
    // that requires NET_CAPABILITY_VALIDATED, meaning the OS confirmed real
    // internet access. The Ranger node's hotspot has no internet by design,
    // so `connected` would always read false while correctly joined to it —
    // which would force this hook into a permanent false "disconnected" state
    // the instant the OS re-evaluates network capabilities. `connectionType`
    // reflects the actual radio transport (wifi/cellular/none) regardless of
    // internet validation, so "none" is the correct "network is really gone"
    // signal for an intentionally-offline local network like this one.
    const hasLink = (status: ConnectionStatus) => status.connectionType !== "none";

    Network.getStatus().then((status) => {
      networkConnectedRef.current = hasLink(status);
    });

    Network.addListener("networkStatusChange", (status: ConnectionStatus) => {
      const wasConnected = networkConnectedRef.current;
      const isConnected  = hasLink(status);
      networkConnectedRef.current = isConnected;

      if (!isConnected) {
        // Real signal the network is gone — don't wait for the socket to
        // notice on its own; reflect it in the UI right now.
        setConnectionState("disconnected");
        setIsOnline(false);
      } else if (!wasConnected && enabledRef.current) {
        // Network just came back — try right away rather than waiting on
        // whatever backoff delay we were mid-way through.
        reconnect();
      }
    }).then((handle) => {
      if (cancelled) handle.remove();
      else removeListener = () => handle.remove();
    });

    return () => {
      cancelled = true;
      removeListener?.();
    };
  }, [reconnect]);

  return {
    connectionState,
    isOnline,
    connectedDeviceId,
    connectedDeviceName,
    lastConnectionError,
    reconnectAttempts,
    send,
    reconnect,
  };
}
