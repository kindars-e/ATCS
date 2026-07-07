// ─────────────────────────────────────────────────────────────────────────────
// components/fling-app.tsx
//
// Root component of the Fling application.
//
// [NEW] Changes in this version:
//
// 1. EMERGENCY BROADCAST ROUTING
//    Emergency messages use recipient="*" which the firmware broadcasts to
//    every node in range via LoRa.  The app correctly sends them via
//    encodeTextMessage("*", content).  Received emergency messages now
//    surface in the Emergency Broadcast thread (deviceId="*").
//    All nodes that receive a broadcast packet also display it immediately.
//
// 2. CONTINUOUS SCANNING
//    The AddDeviceModal now drives its own continuous scan internally.
//    fling-app just exposes startDiscovery() and the discoveredNodes state;
//    the modal calls startDiscovery() repeatedly on its own timer.
//
// 3. AUTOMATIC BI-DIRECTIONAL PAIRING
//    When node A taps "Add" on node B:
//      a. A sends ##PAIR_REQ##<A's name> to B over LoRa.
//      b. B's app auto-accepts: adds A as a contact and replies ##PAIR_ACK##<B's name>.
//      c. A receives ##PAIR_ACK## and adds B as a contact.
//    Neither side needs to do anything manually beyond the first "Add" tap.
//
// 4. MANUAL ENTRY REMOVED
//    AddDeviceModal no longer has a "Manual" tab.  Pairing is QR or scan only.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from "react";
import { Navigation, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useMobileKeyboard }    from "@/hooks/use-mobile-keyboard";
import { usePwaInstall }        from "@/hooks/use-pwa-install";
import {
  useRangerConnection,
  type RangerEvent,
} from "@/hooks/use-ranger-connection";
import {
  DISCOVERY_SCAN_DURATION_MS,
  EMERGENCY_BROADCAST_ID,
  LIVE_SHARE_CHECK_INTERVAL_MS,
  LIVE_SHARE_HEARTBEAT_MS,
  LOCATION_REQUEST_TIMEOUT_MS,
  MAX_USEFUL_GPS_ACCURACY_M,
  MIN_LOCATION_MOVE_M,
  NODE_OFFLINE_MS,
  NODE_STALE_MS,
  RADIO_BANDWIDTH_HZ,
  RADIO_FREQUENCY_HZ,
  RADIO_SPREADING_FACTOR,
  RANGE_CHECK_INTERVAL_MS,
  RSSI_STRONG_DBM,
  RSSI_WEAK_DBM,
  SOS_LOCATION_DEBOUNCE_MS,
  SPLASH_DURATION_MS,
  ACK_RETRY_VISUAL_DELAY_MS,
} from "@/lib/constants";
import {
  encodeBeep,
  encodeDiscovery,
  encodeLocationRequest,
  encodeLocationResponse,
  encodeLocationStop,
  encodeTextMessage,
  encodePairRequest,
  encodePairAccept,
} from "@/lib/protocol";
import { calculateDistance } from "@/lib/geo";
import { readContacts, writeContacts, readMessages, writeMessages } from "@/lib/storage";
import type {
  Contact,
  ContactLocation,
  Message,
  ReachabilityStatus,
  SignalQuality,
  View,
} from "@/lib/types";

import AddDeviceModal, { type DiscoveredNode } from "./add-device-modal";
// [STEP 18] Navigation is compass-only now — bearing/distance guidance to
// wherever a contact's location was last received, no visual map. The
// Waypoints list is still how a saved/SOS location is selected as the
// target; it just hands off straight to Compass.
import { WaypointManagerModal } from "./waypoint-manager-modal";
import { readWaypoints, writeWaypoints, type NamedWaypoint } from "@/lib/storage";
import WiFiConnectionModal from "./wifi-connection-modal";
import { SplashScreen }    from "./splash-screen";
import { CompassModal }    from "./compass-modal";
import { ContactsView }    from "./contacts-view";
import { ChatView }        from "./chat-view";
import { NodeStatsModal }  from "./node-stats-modal";

// ── Emergency Broadcast contact (always present, never persisted) ────────────
const EMERGENCY_CONTACT: Contact = {
  deviceId:        EMERGENCY_BROADCAST_ID,
  deviceName:      "Emergency Broadcast",
  frequency:       RADIO_FREQUENCY_HZ,
  spreadingFactor: RADIO_SPREADING_FACTOR,
  bandwidth:       RADIO_BANDWIDTH_HZ,
  unreadCount:     0,
  reachability:    "online",
};

// ── [STEP 4A] Pure classifiers — reachability and signal quality are fully
// independent. Neither one is allowed to see the other's input. ─────────────
//
// Reachability: ONLY lastSeen/elapsed time. Signal strength must never
// influence this — a node heard 0.5s ago is "online" even with a terrible
// reading; a node not heard from in 2 minutes is "offline" even with a
// perfect last-known reading.
function classifyReachability(ageMs: number): ReachabilityStatus {
  if (ageMs > NODE_OFFLINE_MS) return "offline";
  if (ageMs > NODE_STALE_MS)   return "stale";
  return "online";
}

// Signal quality: ONLY the RSSI value itself. Time since last contact must
// never influence this — it's purely "how good was the link, last time we
// actually measured it." Callers are responsible for separately surfacing
// how OLD that measurement is (see signalSampledAt / SIGNAL_SAMPLE_STALE_MS).
function classifySignalQuality(rssi?: number): SignalQuality {
  if (rssi === undefined) return "unknown"; // never fabricate a value
  if (rssi >= RSSI_STRONG_DBM) return "strong";
  if (rssi >= RSSI_WEAK_DBM)   return "good";
  return "weak";
}

export default function FlingApp() {

  const [isWiFiConnected, setIsWiFiConnected] = useState(false);
  const [showSplash,      setShowSplash]      = useState(true);
  const [view,            setView]            = useState<View>("contacts");
  const [currentContact,  setCurrentContact]  = useState<Contact | null>(null);

  const [contacts, setContacts] = useState<Contact[]>(() => [
    EMERGENCY_CONTACT,
    ...readContacts(),
  ]);

  const [showWaypoints,  setShowWaypoints]  = useState(false);
  // [STEP 8] Live user GPS, used by the Waypoints list for "distance to
  // waypoint" display. We use the raw browser API here (not the hook) to
  // keep this light — the hook's watchPosition is reserved for live-share
  // sessions, and Compass itself manages its own GPS watch internally.
  const [userGpsPosition, setUserGpsPosition] = useState<GeolocationPosition | null>(null);
  const waypointsGpsWatchIdRef = useRef<number | null>(null);
  // [STEP 12] Optional tap action for the location-session banner (e.g. "an
  // SOS location arrived — tap to navigate"). Most locationNotice messages
  // are plain informational text with no action, so this is a separate ref
  // rather than changing setLocationNotice's signature everywhere.
  const locationNoticeActionRef = useRef<(() => void) | null>(null);
  // [NEW] Messages are now seeded from localStorage so the Emergency thread and
  // private chats survive a page reload. readMessages() returns {} on first run.
  const [messages,       setMessages]       = useState<Record<string, Message[]>>(() => readMessages());
  const [inputValue,     setInputValue]     = useState("");
  const [showAddContact, setShowAddContact] = useState(false);
  const [showDeleteMenu, setShowDeleteMenu] = useState<string | null>(null);
  const [showCompass,    setShowCompass]    = useState(false);
  // [Step 9 — Issue 2] Active navigation contact: set when compass opens,
  // persists when compass is minimised so the session can be resumed.
  const [activeNavContact, setActiveNavContact] = useState<Contact | null>(null);
  // [STEP 14] Real device id to beep for the active nav session, when it's a
  // waypoint-sourced navigation for an actual node (SOS) rather than a
  // manually placed pin — see NamedWaypoint.sourceDeviceId.
  const [activeNavBeepDeviceId, setActiveNavBeepDeviceId] = useState<string | undefined>(undefined);

  // [v6 RANGE DETECTION] Transient banner shown when a node's reachability
  // changes (e.g. "Ranger B is out of range"). Auto-clears after a few seconds.
  const [rangeNotice, setRangeNotice] = useState<string | null>(null);
  // [STEP 4B] Transient banner for a permanently-failed delivery. Separate
  // from rangeNotice since it's triggered by a different signal and we don't
  // want one to silently clobber the other if both fire close together.
  const [deliveryNotice, setDeliveryNotice] = useState<string | null>(null);
  // [STEP 4B] Node diagnostics modal toggle.
  const [showNodeStats, setShowNodeStats] = useState(false);

  // Location state
  const [showLocationRequest,      setShowLocationRequest]      = useState(false);
  const [locationRequestStatus,    setLocationRequestStatus]    = useState<
    "requesting" | "waiting" | "locating" | "success" | "error"
  >("requesting");
  const [locationDebugMessage,     setLocationDebugMessage]     = useState("");
  const [showLocationPermission,   setShowLocationPermission]   = useState(false);
  // [STEP 9] When sharing is active the full-screen overlay is dismissed so
  // the user can use the rest of the app. A compact banner takes its place.
  const [liveSharingActive, setLiveSharingActive] = useState(false);
  const [incomingLocationRequest,  setIncomingLocationRequest]  = useState<
    { from: string; deviceName: string } | null
  >(null);
  // [STEP 6] Transient banner for location-session events (e.g. "X stopped
  // sharing their location") — same pattern as rangeNotice/deliveryNotice.
  const [locationNotice, setLocationNotice] = useState<string | null>(null);

  // [STEP 12] SOS mesh-confidence status (item 9). Unlike the other notice
  // banners (4-5s auto-dismiss), this is deliberately persistent — during an
  // actual emergency, reassurance that help is being coordinated shouldn't
  // silently disappear after a few seconds. Dismissed only by the user or by
  // sending/receiving a new SOS.
  const [sosStatus, setSosStatus] = useState<{ triggeredAt: number; confirmedBy: string[] } | null>(null);

  // [STEP 6] Live-share session state, mutated in place (a ref, not React
  // state) since it's read/written from timer callbacks and geolocation
  // callbacks, not rendered directly.
  //   targetId         — who we're sharing with
  //   lastSentAt        — ms timestamp of the last successfully sent fix
  //   lastSentPosition  — used to decide whether we've moved far enough to
  //                       justify sending again (event-driven, not fixed-interval)
  //   status            — "paused" while the WS connection is down; the
  //                       reconnect-recovery effect flips it back to
  //                       "active" and resumes immediately
  interface LiveShareSession {
    targetId: string;
    lastSentAt: number;
    lastSentPosition: { lat: number; lng: number } | null;
    status: "active" | "paused";
  }
  const liveShareSessionRef      = useRef<LiveShareSession | null>(null);
  const liveShareCheckTimerRef   = useRef<ReturnType<typeof setInterval> | null>(null);
  const liveShareTargetRef       = useRef<string | null>(null);
  const locationRequestTargetRef = useRef<Contact | null>(null);
  // [STEP 10] Monotonic counter for every location fix WE send (one-time
  // response or live-share update alike — both go through trySendPosition).
  // Never reset; only ever incremented. Lets a receiver detect and drop a
  // stale mesh retry that arrives after a newer fix already went through
  // (the mesh transport retries failed sends end-to-end but gives no
  // ordering guarantee across independent messages).
  const myLocationSeqRef = useRef(0);
  // [STEP 10] Last accepted seq PER SENDER, so an out-of-order/stale location
  // update can be dropped before it overwrites a fresher one on screen.
  const lastLocationSeqRef = useRef<Record<string, number>>({});
  // [STEP 6] Timeout handling for a one-time location request — fires if
  // the other side never responds.
  const locationRequestTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // [STEP 6] Debounces the automatic SOS location ping (see the "text"
  // event handler) so the firmware's 3x SOS resend doesn't trigger 3
  // separate location broadcasts for one logical emergency.
  const lastSosLocationRef = useRef<{ sender: string; at: number }>({ sender: "", at: 0 });

  // Discovery state
  const [isDiscovering,   setIsDiscovering]   = useState(false);
  const [discoveredNodes, setDiscoveredNodes] = useState<DiscoveredNode[]>([]);
  const discoveryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const lastSentIdRef   = useRef<Record<string, string>>({});
  // [STEP 7] Tracks per-message timers that flip "sent" → "retrying" after
  // ACK_RETRY_VISUAL_DELAY_MS without a delivery-confirmed event. Keyed by
  // message id; cleared on delivery-confirmed or delivery-failed.
  const retryTimerRef   = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  // [STEP 12] Failed-message auto-recovery. A permanently-failed chat send
  // (firmware exhausted retries + one rediscovery cycle) is remembered here
  // instead of just being abandoned — the moment this contact's reachability
  // flips back to online/stale (see the range-monitor effect below), it's
  // automatically resent once. Cleared as soon as that one retry fires, so a
  // rapidly-flapping contact can't trigger a resend loop.
  const failedRetryRef = useRef<Record<string, { msgId: string; content: string }>>({});
  // Populated further down (after sendFrame exists) and read from the
  // range-monitor effect above it — a ref indirection avoids the stale-
  // closure trap of that effect's empty dependency array ever seeing an
  // outdated sendFrame/isOnline.
  const retryFailedMessageRef = useRef<(deviceId: string) => void>(() => {});
  const messagesEndRef  = useRef<HTMLDivElement>(null);
  const myDeviceIdRef  = useRef("");
  const myDeviceNameRef = useRef(""); // [NEW] our firmware display name for pair requests
  // [NEW] A live mirror of the contacts list so the (stable) Ranger event
  // handler can resolve sender names without being re-created on every contact
  // change. Updated by the effect below whenever `contacts` changes.
  const contactsRef = useRef<Contact[]>(contacts);
  // [STEP 4A] Remembers each node's previous REACHABILITY across monitor
  // ticks so we only notify on a real transition (online → offline), not
  // every tick. Signal quality has no time-based decay, so it never needs
  // this kind of transition tracking.
  const prevStatusRef = useRef<Record<string, ReachabilityStatus>>({});
  const keyboardHeight   = useMobileKeyboard();
  const pwaInstall       = usePwaInstall();

  // [NEW] Keep contactsRef in sync with the latest contacts state.
  useEffect(() => { contactsRef.current = contacts; }, [contacts]);

  useEffect(() => { writeContacts(contacts); }, [contacts]);

  // [Step 9 — Issue 5] Auto-stop navigation when the contact goes offline.
  // The range monitor updates `contacts` every 5s; when the navigated contact
  // transitions to "offline" we close the compass and notify the user instead
  // of leaving them navigating to a ghost location.
  useEffect(() => {
    if (!showCompass || !activeNavContact) return;
    const live = contacts.find((c) => c.deviceId === activeNavContact.deviceId);
    if (live?.reachability === "offline") {
      setShowCompass(false);
      setRangeNotice(`Navigation stopped — ${activeNavContact.deviceName} is offline`);
    }
  }, [contacts, showCompass, activeNavContact]);
  // [NEW] Persist every change to the message threads so emergency history and
  // private conversations are not lost on reload.
  useEffect(() => { writeMessages(messages); }, [messages]);
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // ════════════════════════════════════════════════════════════════════════
  // [v6 RANGE DETECTION] Periodic range monitor.
  //
  // recordNodeHeard updates a node the moment we hear from it. But "out of
  // range" is the ABSENCE of packets — there's no event for silence. So this
  // timer ticks every RANGE_CHECK_INTERVAL_MS and re-classifies every node by
  // how long since lastSeen. When a node's status CHANGES, we show a one-off
  // banner so the user is actively notified that comms were lost or recovered.
  // ════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    const tick = () => {
      const now = Date.now();
      setContacts((prev) =>
        prev.map((c) => {
          if (c.deviceId === EMERGENCY_BROADCAST_ID) return c; // pseudo-node
          const ageMs = c.lastSeen ? now - c.lastSeen.getTime() : Infinity;
          // [STEP 4A] Reachability ONLY — signal strength never enters here.
          const next  = classifyReachability(ageMs);

          const before = prevStatusRef.current[c.deviceId];
          if (before && before !== next) {
            if (next === "offline") {
              setRangeNotice(`${c.deviceName} is out of range`);
            } else if (next === "stale") {
              setRangeNotice(`${c.deviceName} hasn't been heard from recently`);
            } else if (next === "online" && (before === "offline" || before === "stale")) {
              setRangeNotice(`${c.deviceName} is back online`);
              // [STEP 12] A route may have just recovered — automatically
              // retry any message that permanently failed while this
              // contact was unreachable, instead of leaving it failed
              // forever until the user notices and resends by hand.
              retryFailedMessageRef.current(c.deviceId);
            }
          }
          prevStatusRef.current[c.deviceId] = next;

          return c.reachability === next ? c : { ...c, reachability: next };
        }),
      );
    };
    const id = setInterval(tick, RANGE_CHECK_INTERVAL_MS);
    tick(); // run once immediately so statuses are correct on mount
    return () => clearInterval(id);
  }, []);

  // [v6] Auto-dismiss the range banner a few seconds after it appears.
  useEffect(() => {
    if (!rangeNotice) return;
    const id = setTimeout(() => setRangeNotice(null), 4000);
    return () => clearTimeout(id);
  }, [rangeNotice]);

  // [STEP 4B] Auto-dismiss the delivery-failed banner.
  useEffect(() => {
    if (!deliveryNotice) return;
    const id = setTimeout(() => setDeliveryNotice(null), 5000);
    return () => clearTimeout(id);
  }, [deliveryNotice]);

  // [STEP 6] Auto-dismiss the location-session banner.
  useEffect(() => {
    if (!locationNotice) return;
    const id = setTimeout(() => {
      setLocationNotice(null);
      locationNoticeActionRef.current = null; // [STEP 12] don't leave a stale tap action armed
    }, 5000);
    return () => clearTimeout(id);
  }, [locationNotice]);

  useEffect(() => {
    if (!showDeleteMenu) return;
    const fn = () => setShowDeleteMenu(null);
    document.addEventListener("click", fn);
    return () => document.removeEventListener("click", fn);
  }, [showDeleteMenu]);

  useEffect(() => {
    const t = setTimeout(() => setShowSplash(false), SPLASH_DURATION_MS);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    interface Workbox {
      addEventListener:    (event: string, handler: () => void) => void;
      messageSkipWaiting: () => void;
      register:           () => void;
    }
    const wb = (window as unknown as { workbox?: Workbox }).workbox;
    if (!("serviceWorker" in navigator) || !wb) return;
    wb.addEventListener("waiting", () => {
      if (confirm("A new version is available. Reload to update?")) {
        wb.messageSkipWaiting();
        wb.addEventListener("controlling", () => window.location.reload());
      }
    });
    wb.register();
  }, []);

  useEffect(() => {
    // Cleanup on unmount — stop the GPS watch.
    return () => {
      if (liveShareWatchIdRef.current !== null) {
        navigator.geolocation?.clearWatch(liveShareWatchIdRef.current);
      }
      if (liveShareCheckTimerRef.current) clearInterval(liveShareCheckTimerRef.current);
    };
  }, []);

  // ── Master location state reset (full teardown) ───────────────────────────
  const resetAllLocationState = useCallback(() => {
    // Stop continuous GPS watch when the session ends.
    if (liveShareWatchIdRef.current !== null) {
      navigator.geolocation?.clearWatch(liveShareWatchIdRef.current);
      liveShareWatchIdRef.current = null;
    }
    if (liveShareCheckTimerRef.current) {
      clearInterval(liveShareCheckTimerRef.current);
      liveShareCheckTimerRef.current = null;
    }
    if (locationRequestTimeoutRef.current) {
      clearTimeout(locationRequestTimeoutRef.current);
      locationRequestTimeoutRef.current = null;
    }
    liveShareSessionRef.current      = null;
    liveShareTargetRef.current       = null;
    locationRequestTargetRef.current = null;
    setShowLocationPermission(false);
    setShowLocationRequest(false);
    setIncomingLocationRequest(null);
    setLocationDebugMessage("");
    setLocationRequestStatus("requesting");
  }, []);

  useEffect(() => {
    if (!isWiFiConnected) resetAllLocationState();
  }, [isWiFiConnected, resetAllLocationState]);

  // ════════════════════════════════════════════════════════════════════════
  // [NEW] HELPER: resolve a node id to a friendly display name.
  // Used to label emergency messages, e.g. "Ranger Node3 replied". If we have
  // the node in our contacts we use their saved name, otherwise we fall back
  // to "Ranger <id>" so the sender is always identifiable.
  // We read from the contacts state via a ref-free closure by passing contacts
  // in, to avoid stale-closure bugs inside the event handler.
  // ════════════════════════════════════════════════════════════════════════
  const resolveSenderName = useCallback(
    (nodeId: string, contactList: Contact[]): string => {
      const known = contactList.find((c) => c.deviceId === nodeId);
      if (known && known.deviceId !== EMERGENCY_BROADCAST_ID) return known.deviceName;
      return `Ranger ${nodeId}`;
    },
    [],
  );

  // ════════════════════════════════════════════════════════════════════════
  // [NEW] HELPER: add or update a contact by deviceId
  // Called from pairing events to ensure we don't get duplicates.
  // ════════════════════════════════════════════════════════════════════════
  const upsertContact = useCallback((newContact: Contact) => {
    setContacts((prev) => {
      const exists = prev.find((c) => c.deviceId === newContact.deviceId);
      if (exists) {
        // Update name / status if they changed.
        return prev.map((c) =>
          c.deviceId === newContact.deviceId
            ? { ...c, deviceName: newContact.deviceName, reachability: "online" as const, lastSeen: new Date() }
            : c
        );
      }
      return [...prev, newContact];
    });
  }, []);

  // ════════════════════════════════════════════════════════════════════════
  // [v6 RANGE DETECTION] Record that we just heard from a node.
  // [STEP 4A] Updates two INDEPENDENT things, each only when proven:
  //   - reachability: ALWAYS set to "online" — any call here means we just
  //     proved this node is reachable (text, discovery, location, or a
  //     relayed HELLO), regardless of whether this particular frame carried
  //     a signal reading.
  //   - signal quality (rssi/snr/signalSampledAt/signalHopDistance): ONLY
  //     touched when THIS event actually carried a fresh rssi reading.
  //     Otherwise the previous reading (and its age) is left exactly as-is
  //     — we never fabricate or silently "refresh" a signal value just
  //     because the node proved reachable some other way.
  //   - [STEP 8] battery removed from all paths
  //     previous value is kept.
  // ════════════════════════════════════════════════════════════════════════
  const recordNodeHeard = useCallback(
    (deviceId: string, rssi?: number, snr?: number, hopDistance?: number, viaNodeId?: string) => {
      if (!deviceId || deviceId === EMERGENCY_BROADCAST_ID) return;
      const now = new Date();
      const hasSample = rssi !== undefined;

      // [STEP 12] Mesh awareness (item 7): surface a route-change notice —
      // e.g. a contact that was reached directly is now only reachable via
      // relay, or vice versa. Read from contactsRef (a snapshot, kept in
      // sync by its own effect) rather than inside the setContacts updater
      // below, which must stay a pure function of its previous state.
      if (hasSample && hopDistance !== undefined) {
        const existing = contactsRef.current.find((c) => c.deviceId === deviceId);
        const prevHop = existing?.signalHopDistance;
        if (prevHop !== undefined && prevHop !== hopDistance) {
          const name = existing?.deviceName || `Ranger ${deviceId}`;
          if (prevHop === 0 && hopDistance > 0) {
            setRangeNotice(`${name} is now reached via relay (${hopDistance} hop${hopDistance > 1 ? "s" : ""})`);
          } else if (prevHop > 0 && hopDistance === 0) {
            setRangeNotice(`${name} is now directly reachable`);
          } else {
            setRangeNotice(`Route to ${name} changed — now ${hopDistance} hop${hopDistance > 1 ? "s" : ""} away`);
          }
        }
      }

      setContacts((prev) =>
        prev.map((c) =>
          c.deviceId === deviceId
            ? {
                ...c,
                lastSeen:     now,
                reachability: "online",
                rssi:               hasSample ? rssi          : c.rssi,
                snr:                hasSample ? (snr ?? c.snr) : c.snr,
                signalSampledAt:    hasSample ? now            : c.signalSampledAt,
                signalHopDistance:  hasSample ? hopDistance    : c.signalHopDistance,
                // [STEP 19] Only meaningful once hopDistance > 0; direct
                // (0-hop) contacts have nothing to name, and the firmware
                // omits "via" from the frame in that case anyway.
                signalViaNodeId:    hasSample ? viaNodeId      : c.signalViaNodeId,
                signalQuality:      hasSample ? classifySignalQuality(rssi) : c.signalQuality,
                // [STEP 8] battery removed
              }
            : c,
        ),
      );
    },
    [],
  );

  // ════════════════════════════════════════════════════════════════════════
  // RANGER EVENT HANDLER
  // ════════════════════════════════════════════════════════════════════════
  const handleRangerEvent = useCallback((event: RangerEvent) => {
    switch (event.kind) {

      // ── Regular text message ─────────────────────────────────────────────
      case "text": {
        const senderId = event.sender;

        // [v6 RANGE DETECTION] A received message proves this node is reachable,
        // so refresh its signal readings + lastSeen + status right away.
        // [STEP 19] Also forward hops/via so the mesh-routing status
        // (Direct / Via <node>) stays live on every message, not just a
        // one-off discovery scan — previously this call omitted hop info
        // entirely, which silently wiped out whatever hop distance an
        // earlier discovery/HELLO had set.
        recordNodeHeard(senderId, event.rssi, event.snr, event.hops, event.via);

        // [STEP 6] Fix the Beep/"Find" button: it was sending literal text
        // "BEEP" which just showed up as a chat bubble — not the buzz the
        // UI's own label promises. Beep is always 1:1 (never broadcast), so
        // it's safe to special-case here without touching the protocol.
        // [STEP 8] Beep: vibrate + play an audible alert tone via Web Audio.
        // The VIBRATE manifest permission is now declared so the call
        // actually works on Android in Capacitor's WebView.
        if (!event.broadcast && event.content === "BEEP") {
          // [STEP 9] Louder, longer, more pulses — clearly audible during
          // an emergency even if the phone is in a pocket or bag.
          if (typeof navigator !== "undefined" && "vibrate" in navigator) {
            // 5 strong pulses: on 400 ms, off 150 ms, repeat
            navigator.vibrate([400, 150, 400, 150, 400, 150, 400, 150, 400]);
          }

          // [STEP 9] Audible alert via Web Audio. Key fix over Step 8:
          //   - Reuse a module-scoped AudioContext instead of creating a new
          //     one per beep (creates are expensive and may fail in background).
          //   - Call ctx.resume() before playing — Android WebView suspends
          //     the AudioContext whenever there's no prior user gesture on the
          //     currently active web page. resume() forces it back to running.
          //   - Increased volume: gain 1.0 (maximum) instead of 0.4.
          //   - Higher frequency: 1800Hz → 2200Hz (pierces ambient noise better).
          //   - Longer beep duration: 0.5s each.
          void (async () => {
            try {
              type WebkitWindow = Window & { webkitAudioContext?: typeof AudioContext };
              const AudioCtx = window.AudioContext || (window as WebkitWindow).webkitAudioContext;
              if (!AudioCtx) return;

              const ctx = new AudioCtx();

              // Resume if the context was suspended by the browser.
              if (ctx.state === "suspended") await ctx.resume();

              const playTone = (startAt: number, freq: number, duration: number) => {
                const osc  = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.type = "sine";
                osc.frequency.value = freq;
                // Full volume, then quick fade-out at the end.
                gain.gain.setValueAtTime(1.0, startAt);
                gain.gain.exponentialRampToValueAtTime(0.001, startAt + duration);
                osc.start(startAt);
                osc.stop(startAt + duration + 0.05);
              };

              // 3 ascending tones: 1800 Hz → 2200 Hz → 2600 Hz
              playTone(ctx.currentTime,        1800, 0.5);
              playTone(ctx.currentTime + 0.65, 2200, 0.5);
              playTone(ctx.currentTime + 1.30, 2600, 0.5);
            } catch {
              // Web Audio not available — vibration alone is the fallback.
            }
          })();
          return;
        }

        // ──────────────────────────────────────────────────────────────────
        // [FIXED] EMERGENCY BROADCAST ROUTING
        //
        // The firmware now tags every LoRa packet that was addressed to "*"
        // with `broadcast: true`. We use that flag here to decide WHICH thread
        // a received message belongs in:
        //
        //   • broadcast === true  → the shared Emergency thread (deviceId "*").
        //         Every node that hears the packet drops it into the SAME
        //         Emergency conversation, so it behaves like a group channel.
        //         We keep the original sender id + a friendly name on the
        //         message so the UI can show "Ranger B" beside each bubble.
        //
        //   • broadcast === false → the sender's private chat (deviceId =
        //         senderId), exactly like before. This is normal 1:1 messaging
        //         and is completely unaffected by the emergency changes.
        //
        // This is the single change that makes the Emergency section act as a
        // shared alert channel while leaving the private inbox untouched.
        // ──────────────────────────────────────────────────────────────────
        const isBroadcast = event.broadcast === true;

        // [NEW] A broadcast whose sender is OUR OWN device id is the firmware
        // echoing back an emergency we initiated locally (e.g. the physical SOS
        // button). Render it as our own outgoing message, not an incoming one.
        const isOwnEcho =
          isBroadcast &&
          !!myDeviceIdRef.current &&
          senderId === myDeviceIdRef.current;

        // [STEP 13] The Emergency thread doubles as a general "broadcast to
        // everyone" channel (per the design above) — NOT every message sent
        // there is a real emergency. Both the auto-location follow-up and the
        // SOS mesh-confidence banner used to fire on isOwnEcho alone, meaning
        // typing an ordinary message in the Emergency thread silently blasted
        // your GPS location and popped the "SOS Active" banner. Gate both on
        // the content actually containing "SOS" — matching the firmware's
        // own convention (it checks `strstr(text, "SOS")` to decide whether
        // to flash the emergency LED) — so only a genuine SOS (the hardware
        // button's fixed text, or the user literally typing "SOS") triggers
        // either behaviour.
        const isRealSos = isOwnEcho && event.content.includes("SOS");

        // [STEP 6] Automatically follow up our own emergency broadcast with
        // one best-effort GPS fix, broadcast the same way — no separate
        // request/approval round-trip needed during an actual emergency
        // (the sender may not be able to respond to a permission prompt).
        // Debounced per-sender so the firmware's 3x SOS resend (same
        // logical event, same msgId) can't trigger 3 separate broadcasts.
        if (isRealSos) {
          const now = Date.now();
          if (now - lastSosLocationRef.current.at > SOS_LOCATION_DEBOUNCE_MS) {
            lastSosLocationRef.current = { sender: senderId, at: now };
            // [STEP 12] Start (or restart) the SOS mesh-confidence banner —
            // gated by the same debounce as the location follow-up above, so
            // the firmware's 3x SOS resend (same logical event) doesn't reset
            // the confirmation count three times for one real emergency.
            setSosStatus({ triggeredAt: now, confirmedBy: [] });
            if (typeof navigator !== "undefined" && navigator.geolocation) {
              navigator.geolocation.getCurrentPosition(
                (pos) => {
                  // [STEP 6] Emergency exception to GPS accuracy validation:
                  // any fix is better than none on an SOS — unlike normal
                  // sharing, this is never held back for poor accuracy.
                  const { latitude, longitude, accuracy } = pos.coords;
                  myLocationSeqRef.current += 1;
                  sendFrame(encodeLocationResponse(EMERGENCY_BROADCAST_ID, latitude, longitude, accuracy, myLocationSeqRef.current));
                },
                () => { /* no GPS available — the SOS itself already went out; never block on this */ },
                { enableHighAccuracy: true, timeout: 8000, maximumAge: 10000 },
              );
            }
          }
        }

        // The thread this message will be stored under.
        const threadId = isBroadcast ? EMERGENCY_BROADCAST_ID : senderId;

        // Resolve a readable sender name only for emergency messages from OTHER
        // nodes (private chats already show the contact name in the header, and
        // our own messages don't need a "Ranger X" label). We read from
        // contactsRef (a live mirror) so this handler never goes stale.
        const senderName =
          isBroadcast && !isOwnEcho
            ? resolveSenderName(senderId, contactsRef.current)
            : undefined;

        const newMessage: Message = {
          id:         `${Date.now()}-${Math.random()}`,
          sender:     senderId,
          recipient:  isBroadcast ? EMERGENCY_BROADCAST_ID : (myDeviceIdRef.current || "me"),
          content:    event.content,
          timestamp:  new Date(),
          status:     "delivered",
          isMe:       isOwnEcho,   // [NEW] our own SOS echo renders as a sent bubble
          senderName,              // [NEW] used by the Emergency UI for identity
          broadcast:  isBroadcast, // [NEW] tags the bubble as an emergency message
        };

        setMessages((prev) => {
          const thread = prev[threadId] || [];
          // De-duplicate: LoRa can echo a packet, and for emergency messages the
          // firmware now intentionally RE-BROADCASTS the same SOS a few times
          // (with jitter) so it survives collisions. Those copies arrive within
          // ~1-2 s of each other, so we drop any identical content+sender that
          // we already received within a short window. Broadcasts get a slightly
          // wider window (4 s) to comfortably cover all re-broadcast copies;
          // normal messages keep a tight 1 s window so legitimate repeated texts
          // ("ok", "ok") aren't accidentally swallowed.
          const dedupWindowMs = isBroadcast ? 4000 : 1000;
          const exists = thread.some(
            (m) =>
              m.content === newMessage.content &&
              m.sender === newMessage.sender &&
              Math.abs(m.timestamp.getTime() - newMessage.timestamp.getTime()) < dedupWindowMs,
          );
          if (exists) return prev;
          return { ...prev, [threadId]: [...thread, newMessage] };
        });

        // [NEW] FOLLOW-UP PRIVATE CHAT SUPPORT
        // When an emergency arrives from a node we don't know yet, register it
        // as a contact (without disturbing the Emergency thread it was stored
        // in). This is what lets a receiver tap "Ranger A" and continue the
        // conversation privately in the normal inbox after the initial alert.
        // We never do this for our own echo or for the "*" pseudo-sender.
        if (isBroadcast && !isOwnEcho && senderId !== EMERGENCY_BROADCAST_ID) {
          const alreadyKnown = contactsRef.current.some(
            (c) => c.deviceId === senderId,
          );
          if (!alreadyKnown) {
            upsertContact({
              deviceId:        senderId,
              deviceName:      senderName || `Ranger ${senderId}`,
              frequency:       RADIO_FREQUENCY_HZ,
              spreadingFactor: RADIO_SPREADING_FACTOR,
              bandwidth:       RADIO_BANDWIDTH_HZ,
              unreadCount:     0,
              reachability:    "online",
              lastSeen:        new Date(),
            });
          }
        }

        // Bump the unread badge on whichever thread received the message, unless
        // the user is currently looking at that exact thread.
        setView((prevView) => {
          setCurrentContact((prevContact) => {
            const lookingAtThisThread =
              prevView === "chat" &&
              prevContact &&
              prevContact.deviceId === threadId;

            if (!lookingAtThisThread) {
              setContacts((prev) =>
                prev.map((c) =>
                  c.deviceId === threadId
                    ? {
                        ...c,
                        unreadCount: c.unreadCount + 1,
                        lastSeen: new Date(),
                        reachability: "online" as const,
                      }
                    : c,
                ),
              );
            }
            return prevContact;
          });
          return prevView;
        });
        return;
      }

      case "location-request": {
        setContacts((prev) => {
          const contact = prev.find((c) => c.deviceId === event.sender);
          setIncomingLocationRequest({
            from:       event.sender,
            deviceName: contact?.deviceName || `Ranger ${event.sender}`,
          });
          setShowLocationPermission(true);
          return prev;
        });
        return;
      }

      // [STEP 6] Handles BOTH a normal 1:1 response and a broadcast SOS
      // location ping (event.broadcast) — either way, a fresh fix for
      // event.sender is real and worth storing.
      case "location-response": {
        // [STEP 7] Forward rssi/snr so signal quality is updated on every
        // location fix received, not only on text messages.
        // [STEP 19] hops/via too — same reasoning as the "text" case above.
        recordNodeHeard(event.sender, event.rssi, event.snr, event.hops, event.via);

        // [STEP 10] Stale/out-of-order guard. The mesh transport retries a
        // failed unicast send end-to-end but gives no ordering guarantee
        // ACROSS independent sends — a retried older fix can legitimately
        // arrive after a newer one already went through (e.g. after a route
        // hiccup on a multi-hop path). Without this, that late retry would
        // silently overwrite a fresher position on screen. A large BACKWARD
        // jump (rather than a small one) is treated as the sender's app
        // having restarted (its counter resets to 0) rather than a stale
        // retry, so we don't get stuck permanently rejecting a peer's
        // legitimately fresh fixes after they relaunch.
        if (event.seq !== undefined) {
          const prevSeq = lastLocationSeqRef.current[event.sender];
          const RESET_JUMP = 5;
          const isStaleRetry =
            prevSeq !== undefined && event.seq <= prevSeq && (prevSeq - event.seq) < RESET_JUMP;
          if (isStaleRetry) return;
          lastLocationSeqRef.current[event.sender] = event.seq;
        }

        const newLocation: ContactLocation = {
          lat:       event.lat,
          lng:       event.lng,
          accuracy:  event.accuracy,
          timestamp: new Date(),
        };
        setContacts((prev) =>
          prev.map((c) =>
            c.deviceId === event.sender ? { ...c, location: newLocation } : c,
          ),
        );
        setCurrentContact((prev) =>
          prev?.deviceId === event.sender ? { ...prev, location: newLocation } : prev,
        );
        if (locationRequestTargetRef.current?.deviceId === event.sender) {
          // Response to our explicit one-time request — open compass.
          if (locationRequestTimeoutRef.current) {
            clearTimeout(locationRequestTimeoutRef.current);
            locationRequestTimeoutRef.current = null;
          }
          setLocationRequestStatus("success");
          setLocationDebugMessage("🎯 Live tracking started!");
          setShowLocationRequest(false);
          setShowCompass(true);
          setActiveNavContact(locationRequestTargetRef.current); // [Step 9]
          setActiveNavBeepDeviceId(undefined); // [STEP 14] real contact — no waypoint beep-target override
          setTimeout(() => setLocationDebugMessage(""), 2000);
        } else if (event.broadcast) {
          // [STEP 9] SOS auto-location: immediately save the sender's
          // coordinates as a named "SOS" waypoint so the receiver can
          // navigate with one tap — no separate location request needed.
          const senderName = contactsRef.current.find((c) => c.deviceId === event.sender)
            ?.deviceName || `Ranger ${event.sender}`;

          const sosWaypoint: NamedWaypoint = {
            id:             `sos-${event.sender}-${Date.now()}`,
            name:           `SOS — ${senderName}`,
            lat:            event.lat,
            lng:            event.lng,
            type:           "sos",
            createdAt:      new Date(),
            notes:          `Emergency location from ${senderName}`,
            sourceDeviceId: event.sender,
          };
          const existing = readWaypoints().filter((w) => w.type !== "sos" || w.id.split("-")[1] !== event.sender);
          writeWaypoints([...existing, sosWaypoint]);

          // [STEP 14] Tapping the notice opens Compass, same as every other
          // navigation entry point (waypoints, chat header, requested
          // locations) — the map is reached from there via its own icon,
          // not as a separate doorway.
          locationNoticeActionRef.current = () => {
            const sender = contactsRef.current.find((c) => c.deviceId === event.sender);
            const navContact: Contact = sender ?? {
              deviceId:        event.sender,
              deviceName:      senderName,
              frequency:       RADIO_FREQUENCY_HZ,
              spreadingFactor: RADIO_SPREADING_FACTOR,
              bandwidth:       RADIO_BANDWIDTH_HZ,
              unreadCount:     0,
              reachability:    "online",
              location:        { lat: event.lat, lng: event.lng, accuracy: 0, timestamp: new Date() },
            };
            setCurrentContact(navContact);
            setActiveNavContact(navContact);
            setActiveNavBeepDeviceId(undefined); // [STEP 14] real device id already on navContact
            setShowCompass(true);
          };
          setLocationNotice(`🆘 ${senderName} sent their location — tap to navigate`);
        }
        return;
      }

      // [STEP 6] The responder explicitly ended a live-share session —
      // surface it instead of letting the location silently go stale with
      // no explanation. We deliberately keep the last known location (still
      // useful) rather than clearing it; the Compass modal's own staleness
      // display communicates that it's no longer live.
      case "location-stop": {
        const name = contactsRef.current.find((c) => c.deviceId === event.sender)?.deviceName
          || `Ranger ${event.sender}`;
        locationNoticeActionRef.current = null; // [STEP 12] purely informational, no tap action
        setLocationNotice(`${name} stopped sharing their location`);

        // [STEP 13] If we're actively navigating to exactly the person who
        // just stopped sharing, end that session automatically instead of
        // just notifying and leaving the user navigating toward a location
        // that's no longer being updated.
        if (activeNavContact?.deviceId === event.sender) {
          setShowCompass(false);
          setActiveNavContact(null);
          setActiveNavBeepDeviceId(undefined);
        }
        return;
      }

      case "delivery-confirmed": {
        setCurrentContact((prev) => {
          if (!prev) return prev;
          const lastId = lastSentIdRef.current[prev.deviceId];
          if (lastId) {
            // [STEP 7] Cancel the "retrying" visual timer — the message was
            // delivered, so we never need to flip it to "retrying" state.
            if (retryTimerRef.current[lastId]) {
              clearTimeout(retryTimerRef.current[lastId]);
              delete retryTimerRef.current[lastId];
            }
            // [STEP 12] Delivery succeeded — nothing left to auto-retry.
            delete failedRetryRef.current[prev.deviceId];
            setMessages((msgs) => ({
              ...msgs,
              [prev.deviceId]: (msgs[prev.deviceId] || []).map((m) =>
                m.id === lastId ? { ...m, status: "delivered" as const } : m,
              ),
            }));
          }
          return prev;
        });
        return;
      }

      // [STEP 4B] Unicast delivery permanently failed. Unlike
      // delivery-confirmed above, this is NOT gated on "is that chat
      // currently open" — the user needs to know even if they've navigated
      // away, so we look the message up directly by dest and also raise a
      // visible notice.
      case "delivery-failed": {
        const dest = event.dest;
        if (dest) {
          const lastId = lastSentIdRef.current[dest];
          if (lastId) {
            // [STEP 7] Cancel the retry visual — we now have a definitive
            // "failed" from the firmware (all retries + route recovery done).
            if (retryTimerRef.current[lastId]) {
              clearTimeout(retryTimerRef.current[lastId]);
              delete retryTimerRef.current[lastId];
            }
            setMessages((msgs) => {
              const thread = msgs[dest] || [];
              // [STEP 12] Remember this failed send (content + id) so it can
              // be automatically retried once this contact's reachability
              // recovers — see retryFailedMessage below and the
              // offline/stale→online transition in the range-monitor effect.
              const failedMsg = thread.find((m) => m.id === lastId);
              if (failedMsg) {
                failedRetryRef.current[dest] = { msgId: lastId, content: failedMsg.content };
              }
              return {
                ...msgs,
                [dest]: thread.map((m) =>
                  m.id === lastId ? { ...m, status: "failed" as const } : m,
                ),
              };
            });
          }
          const name = contactsRef.current.find((c) => c.deviceId === dest)?.deviceName || `Ranger ${dest}`;
          setDeliveryNotice(`Message to ${name} could not be delivered`);
        }
        return;
      }

      // [STEP 4B] One node confirmed it received our SOS broadcast. Flips
      // the most recently sent Emergency-thread message to "delivered" on
      // the FIRST confirmation; later confirmations from other nodes are a
      // harmless no-op (the message is already marked delivered).
      case "sos-delivered": {
        const lastId = lastSentIdRef.current[EMERGENCY_BROADCAST_ID];
        if (lastId) {
          setMessages((msgs) => ({
            ...msgs,
            [EMERGENCY_BROADCAST_ID]: (msgs[EMERGENCY_BROADCAST_ID] || []).map((m) =>
              m.id === lastId ? { ...m, status: "delivered" as const } : m,
            ),
          }));
        }
        // [STEP 12] Feed the SOS mesh-confidence banner — every node that
        // actually received the broadcast reports exactly one of these, so
        // this is the real, mesh-wide "help is being coordinated" signal.
        setSosStatus((prev) => {
          if (!prev || prev.confirmedBy.includes(event.from)) return prev;
          return { ...prev, confirmedBy: [...prev.confirmedBy, event.from] };
        });
        return;
      }

      case "node-discovered": {
        // [NEW] Accumulate discovered nodes across multiple scan windows.
        // We never clear the list here — the modal manages that via resetDiscovery.
        setDiscoveredNodes((prev) => {
          if (prev.some((n) => n.deviceId === event.deviceId)) return prev;
          return [...prev, { deviceId: event.deviceId, rssi: event.rssi }];
        });
        recordNodeHeard(event.deviceId, event.rssi, event.snr, event.hops, event.via);
        return;
      }

      // [STEP 4A] Relayed HELLO reading for a DIRECT neighbor — no new LoRa
      // traffic was sent for this; the firmware just forwarded a reading it
      // already had from its existing HELLO_INTERVAL_MS beacon. hopDistance
      // is always 0 here since HELLO is direct-neighbor-only (TTL=1).
      case "neighbor-heard": {
        recordNodeHeard(event.deviceId, event.rssi, event.snr, 0);
        return;
      }

      case "frequency-update": {
        setContacts((prev) =>
          prev.map((c) => ({ ...c, frequency: event.frequency })),
        );
        return;
      }

      // ── [NEW] INCOMING PAIR REQUEST ─────────────────────────────────────
      // Another node sent us ##PAIR_REQ##<name>.
      // We automatically:
      //   1. Add them to our contacts list.
      //   2. Reply with ##PAIR_ACK##<our name> so they know the name to use.
      case "pair-request": {
        const newContact: Contact = {
          deviceId:        event.sender,
          deviceName:      event.senderName,
          frequency:       RADIO_FREQUENCY_HZ,
          spreadingFactor: RADIO_SPREADING_FACTOR,
          bandwidth:       RADIO_BANDWIDTH_HZ,
          unreadCount:     0,
          reachability:    "online",
          lastSeen:        new Date(),
        };
        upsertContact(newContact);

        // Reply with our own name so the requester can display us correctly.
        // Use our firmware device name if we have it, otherwise the device ID.
        const ourName = myDeviceNameRef.current || myDeviceIdRef.current || "FlingNode";
        sendFrame(encodePairAccept(event.sender, ourName));
        return;
      }

      // ── [NEW] PAIR ACCEPTED ─────────────────────────────────────────────
      // The node we sent a pair request to replied with ##PAIR_ACK##<name>.
      // Add them as a contact (or update their name if already present).
      case "pair-accepted": {
        const newContact: Contact = {
          deviceId:        event.sender,
          deviceName:      event.senderName,
          frequency:       RADIO_FREQUENCY_HZ,
          spreadingFactor: RADIO_SPREADING_FACTOR,
          bandwidth:       RADIO_BANDWIDTH_HZ,
          unreadCount:     0,
          reachability:    "online",
          lastSeen:        new Date(),
        };
        upsertContact(newContact);
        return;
      }
    }
    // [NEW] resolveSenderName is stable (useCallback with []); contacts are read
    // via contactsRef so they are intentionally NOT a dependency here.
  // [STEP 13] activeNavContact added — the location-stop case reads it
  // directly (not via a ref) to auto-close the matching navigation session.
  // Safe to let this callback's identity change often:
  // use-ranger-connection.ts consumes onEvent through onEventRef, which
  // resyncs every render, so there's no stale-listener/resubscription cost.
  }, [upsertContact, resolveSenderName, recordNodeHeard, activeNavContact]); // eslint-disable-line react-hooks/exhaustive-deps

  const {
    connectionState,
    isOnline,
    connectedDeviceId,
    connectedDeviceName,
    // [STEP 8] connectedDeviceBattery removed
    nodeStats,
    lastConnectionError,
    reconnectAttempts,
    send:     sendFrame,
    reconnect,
  } = useRangerConnection({
    enabled:  isWiFiConnected,
    onEvent:  handleRangerEvent,
  });

  useEffect(() => {
    myDeviceIdRef.current   = connectedDeviceId;
    myDeviceNameRef.current = connectedDeviceName;
  }, [connectedDeviceId, connectedDeviceName]);

  // ════════════════════════════════════════════════════════════════════════
  // DISCOVERY
  // The modal drives continuous scanning on its own; fling-app just
  // provides the startDiscovery() trigger and the accumulated results.
  // ════════════════════════════════════════════════════════════════════════
  const startDiscovery = useCallback(() => {
    if (!isOnline) return;
    setIsDiscovering(true);
    sendFrame(encodeDiscovery());

    if (discoveryTimerRef.current) clearTimeout(discoveryTimerRef.current);
    discoveryTimerRef.current = setTimeout(() => {
      setIsDiscovering(false);
    }, DISCOVERY_SCAN_DURATION_MS);
  }, [isOnline, sendFrame]);

  // [NEW] Reset the discovered nodes list — called when the modal opens.
  const resetDiscovery = useCallback(() => {
    setDiscoveredNodes([]);
  }, []);

  // ════════════════════════════════════════════════════════════════════════
  // CONTACTS
  // ════════════════════════════════════════════════════════════════════════
  const addContact = useCallback((contact: Contact) => {
    upsertContact(contact);
  }, [upsertContact]);

  const deleteContact = useCallback((deviceId: string) => {
    setContacts((prev) => prev.filter((c) => c.deviceId !== deviceId));
    setMessages((prev) => {
      const next = { ...prev };
      delete next[deviceId];
      return next;
    });
    setShowDeleteMenu(null);
  }, []);

  // ════════════════════════════════════════════════════════════════════════
  // [NEW] MESSAGE DELETION
  //
  // These three handlers all work the same way: they produce a NEW messages
  // object (never mutating the old one — React needs a fresh reference to
  // detect the change) with the unwanted messages removed.
  //
  // We do NOT call writeMessages() here. The existing effect
  //   useEffect(() => { writeMessages(messages); }, [messages]);
  // already saves to localStorage whenever `messages` changes, so updating the
  // state is enough for BOTH instant UI refresh AND persistence after reload.
  //
  // All three work for ANY thread, including the Emergency thread (deviceId
  // "*"), because they treat threadId as a plain key — no special casing.
  // None of them touch the WebSocket / LoRa layer, so deleting messages can
  // never affect radio communication.
  // ════════════════════════════════════════════════════════════════════════

  // Delete a SINGLE message from a thread by its id.
  const deleteMessage = useCallback((threadId: string, messageId: string) => {
    setMessages((prev) => {
      const thread = prev[threadId];
      if (!thread) return prev; // nothing to do — thread doesn't exist
      const filtered = thread.filter((m) => m.id !== messageId);
      return { ...prev, [threadId]: filtered };
    });
  }, []);

  // Delete MULTIPLE selected messages from a thread in one update.
  // Using a Set makes the "is this id in the delete list?" check fast and clean.
  const deleteMessages = useCallback((threadId: string, messageIds: string[]) => {
    if (messageIds.length === 0) return;
    setMessages((prev) => {
      const thread = prev[threadId];
      if (!thread) return prev;
      const idsToRemove = new Set(messageIds);
      const filtered = thread.filter((m) => !idsToRemove.has(m.id));
      return { ...prev, [threadId]: filtered };
    });
  }, []);

  // Clear an ENTIRE conversation's history. We keep the thread key with an
  // empty array (rather than deleting the key) so the conversation/contact
  // stays in place — only its messages are wiped. For the Emergency thread
  // this empties the shared alert history without removing the Emergency
  // contact itself.
  const clearConversation = useCallback((threadId: string) => {
    setMessages((prev) => {
      if (!prev[threadId] || prev[threadId].length === 0) return prev;
      return { ...prev, [threadId]: [] };
    });
  }, []);

  const openChat = useCallback((contact: Contact) => {
    setCurrentContact(contact);
    setView("chat");
    setContacts((prev) =>
      prev.map((c) =>
        c.deviceId === contact.deviceId ? { ...c, unreadCount: 0 } : c,
      ),
    );
  }, []);

  // [STEP 12] Failed-message auto-recovery. Called from the range-monitor
  // effect (via retryFailedMessageRef, to dodge that effect's stale-closure
  // problem) the instant a contact transitions offline/stale → online — a
  // route may have just recovered, so a message that permanently failed
  // while unreachable gets exactly one automatic resend instead of staying
  // failed forever until the user happens to notice and retype it. Only
  // applies to 1:1 chat: SOS/emergency sends are broadcasts that never reach
  // a "failed" state to begin with (fire-and-forget flood, no per-recipient
  // ACK), and location REQUESTS use a separate client-side timeout rather
  // than this firmware delivery-failed signal (see requestLocation below) —
  // both are structurally different from a plain unicast chat send.
  const retryFailedMessage = useCallback((deviceId: string) => {
    const failed = failedRetryRef.current[deviceId];
    if (!failed || !isOnline) return;
    delete failedRetryRef.current[deviceId]; // one automatic retry per failure — never a loop

    const { msgId, content } = failed;
    setMessages((prev) => ({
      ...prev,
      [deviceId]: (prev[deviceId] || []).map((m) =>
        m.id === msgId ? { ...m, status: "retrying" as const } : m,
      ),
    }));
    setDeliveryNotice(`Route recovered — resending message to ${
      contactsRef.current.find((c) => c.deviceId === deviceId)?.deviceName || `Ranger ${deviceId}`
    }`);

    // Reuses the EXACT SAME message id, so the existing "delivery-confirmed"
    // / "delivery-failed" WS event handlers (which look messages up by
    // lastSentIdRef) resolve this resend exactly like any other send —
    // "delivered" if it now goes through, or "failed" again (this time for
    // good — failedRetryRef was already cleared above, so it won't loop) if
    // the mesh still can't reach this contact.
    const sent = sendFrame(encodeTextMessage(deviceId, content));
    if (sent) lastSentIdRef.current[deviceId] = msgId;
  }, [isOnline, sendFrame]);

  useEffect(() => { retryFailedMessageRef.current = retryFailedMessage; }, [retryFailedMessage]);

  // ════════════════════════════════════════════════════════════════════════
  // MESSAGING
  // Emergency messages send to recipient="*" — the firmware broadcasts them.
  // ════════════════════════════════════════════════════════════════════════
  const sendMessage = async () => {
    if (!inputValue.trim() || !currentContact) return;

    // [NEW] Are we composing inside the shared Emergency thread? If so this
    // message is an emergency broadcast (recipient "*"). We tag it so the UI
    // renders it with the emergency styling and so persistence keeps the flag.
    const isEmergencyThread = currentContact.deviceId === EMERGENCY_BROADCAST_ID;

    // [STEP 12] A fresh manual send supersedes any earlier failed message to
    // this contact that was waiting for automatic retry-on-recovery — without
    // this, a later reachability flip could resend stale, already-superseded
    // text on top of whatever the user just sent.
    delete failedRetryRef.current[currentContact.deviceId];

    const msgId = Date.now().toString();
    const newMessage: Message = {
      id:        msgId,
      sender:    connectedDeviceId || "me",
      recipient: currentContact.deviceId,
      content:   inputValue,
      timestamp: new Date(),
      status:    isOnline ? "sending" : "failed",
      isMe:      true,
      offline:   !isOnline,
      broadcast: isEmergencyThread, // [NEW] mark our own emergency sends
    };

    setMessages((prev) => ({
      ...prev,
      [currentContact.deviceId]: [...(prev[currentContact.deviceId] || []), newMessage],
    }));

    // [NEW] For emergency contacts, deviceId is "*" — the firmware will
    // broadcast this to every node in LoRa range.  No ACK is expected.
    const sent = isOnline && sendFrame(encodeTextMessage(currentContact.deviceId, inputValue));

    if (sent) {
      lastSentIdRef.current[currentContact.deviceId] = msgId;
      const contactId = currentContact.deviceId;
      setMessages((prev) => ({
        ...prev,
        [contactId]: (prev[contactId] || []).map((m) =>
          m.id === msgId ? { ...m, status: "sent" as const } : m,
        ),
      }));

      // [STEP 7] After ACK_RETRY_VISUAL_DELAY_MS without a delivery-confirmed
      // event, flip "sent" → "retrying" so the user can see the mesh is
      // actively re-sending rather than silently hanging. Broadcasts ("*")
      // never get ACKs, so skip the timer for them.
      if (!isEmergencyThread) {
        retryTimerRef.current[msgId] = setTimeout(() => {
          setMessages((prev) => ({
            ...prev,
            [contactId]: (prev[contactId] || []).map((m) =>
              m.id === msgId && m.status === "sent" ? { ...m, status: "retrying" as const } : m,
            ),
          }));
          delete retryTimerRef.current[msgId];
        }, ACK_RETRY_VISUAL_DELAY_MS);
      }
    } else if ("serviceWorker" in navigator && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({
        type:    "QUEUE_OFFLINE_MESSAGE",
        message: {
          content:   inputValue,
          recipient: currentContact.deviceId,
          timestamp: new Date().toISOString(),
        },
      });
      navigator.serviceWorker.ready.then((reg) => {
        if ("sync" in reg) {
          (reg as unknown as { sync: { register: (tag: string) => void } }).sync.register("sync-messages");
        }
      });
    }

    setInputValue("");
  };

  // ════════════════════════════════════════════════════════════════════════
  // [STEP 6] LOCATION SHARING
  //
  // Both directions (one-time request/response and live sharing) are still
  // just chat-style text messages riding the SAME generic mesh-routed "send"
  // path used for everything else — the firmware has no location-specific
  // code at all, so every reliability behavior below (timeouts, duplicate
  // protection, staleness, accuracy gating, reconnect recovery) is purely
  // app-level policy layered on top of an already mesh-hardened transport.
  // No firmware change was needed for any of this.
  // ════════════════════════════════════════════════════════════════════════
  const requestLocation = () => {
    if (!currentContact) return;

    // [STEP 6] Duplicate request protection — ignore a second tap while a
    // request to this SAME contact is already in flight.
    if (
      locationRequestTargetRef.current?.deviceId === currentContact.deviceId &&
      (locationRequestStatus === "requesting" || locationRequestStatus === "waiting")
    ) {
      return;
    }

    if (!isOnline) {
      alert("Connection to Ranger network is down. Cannot send location request.");
      return;
    }
    resetAllLocationState();
    locationRequestTargetRef.current = currentContact;
    setShowLocationRequest(true);
    setLocationRequestStatus("requesting");
    setLocationDebugMessage("Sending location request…");

    const sent = sendFrame(encodeLocationRequest(currentContact.deviceId));
    if (!sent) {
      setLocationRequestStatus("error");
      setLocationDebugMessage("Connection lost. Please try again.");
      return;
    }
    setLocationRequestStatus("waiting");
    setLocationDebugMessage(`Waiting for ${currentContact.deviceName} to approve…`);

    // [STEP 6] Timeout handling — don't spin on "Waiting for Response"
    // forever if they never approve (closed the app, out of range, etc).
    locationRequestTimeoutRef.current = setTimeout(() => {
      setLocationRequestStatus("error");
      setLocationDebugMessage("No response — they may be offline or out of range.");
    }, LOCATION_REQUEST_TIMEOUT_MS);
  };

  // [STEP 6] Tied to connection state — a WS drop while genuinely waiting
  // on a response is a real failure, not something to silently hang on.
  useEffect(() => {
    if (!isOnline && (locationRequestStatus === "requesting" || locationRequestStatus === "waiting")) {
      if (locationRequestTimeoutRef.current) {
        clearTimeout(locationRequestTimeoutRef.current);
        locationRequestTimeoutRef.current = null;
      }
      setLocationRequestStatus("error");
      setLocationDebugMessage("Connection lost while waiting for a response.");
    }
  }, [isOnline, locationRequestStatus]);

  // ── [STEP 8] PERSISTENT LIVE LOCATION SHARING ─────────────────────────────
  // Root cause of the previous unreliability: the old implementation called
  // getCurrentPosition() every 2 seconds via setInterval. Android throttles
  // and kills those cold-start GPS requests the moment the screen locks or
  // the app is backgrounded. The fix is to use a SINGLE watchPosition() that
  // keeps the GPS lock continuously active. Android allows watchPosition to
  // survive lock/background when FOREGROUND_SERVICE_LOCATION is declared in
  // the manifest (now added in Step 8) and the Capacitor App plugin keeps
  // the JS engine alive.
  //
  // Session state lives here in refs (root component) so it survives any
  // view change — the user can navigate away and come back without losing it.
  const liveShareWatchIdRef   = useRef<number | null>(null);
  // Tracks position purely for heartbeat purposes when watchPosition fires
  // but we don't want to send (e.g. no movement, heartbeat not due yet).

  const stopLiveShare = useCallback(() => {
    const session = liveShareSessionRef.current;
    if (session) sendFrame(encodeLocationStop(session.targetId));
    if (liveShareWatchIdRef.current !== null) {
      navigator.geolocation?.clearWatch(liveShareWatchIdRef.current);
      liveShareWatchIdRef.current = null;
    }
    setLiveSharingActive(false); // [STEP 9] dismiss compact banner
    resetAllLocationState();
  }, [sendFrame, resetAllLocationState]);

  // Called from the watchPosition success callback and from the heartbeat
  // check. Returns true if a location frame was actually sent.
  const trySendPosition = useCallback(
    (pos: GeolocationPosition, isFirstSend: boolean): boolean => {
      const { latitude, longitude, accuracy } = pos.coords;
      const session = liveShareSessionRef.current;
      if (!session || session.status !== "active") return false;

      // Skip inaccurate fixes UNLESS it's the very first send — the requester
      // needs any position immediately even if GPS hasn't fully acquired yet.
      if (!isFirstSend && accuracy > MAX_USEFUL_GPS_ACCURACY_M) {
        setLocationDebugMessage(`Waiting for better GPS (±${Math.round(accuracy)}m)…`);
        return false;
      }

      myLocationSeqRef.current += 1;
      const sent = sendFrame(encodeLocationResponse(session.targetId, latitude, longitude, accuracy, myLocationSeqRef.current));
      if (!sent) {
        setLocationDebugMessage("Connection issue — update not delivered.");
        return false;
      }

      session.lastSentAt = Date.now();
      session.lastSentPosition = { lat: latitude, lng: longitude };
      setLocationDebugMessage(
        isFirstSend
          ? `🎯 Sharing live ✓ (±${Math.round(accuracy)}m)`
          : `Updated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} (±${Math.round(accuracy)}m)`,
      );
      return true;
    },
    [sendFrame],
  );

  const acceptLocationShare = useCallback(() => {
    if (!incomingLocationRequest) return;
    if (!navigator.geolocation) {
      setLocationDebugMessage("Geolocation not supported on this device.");
      return;
    }
    const targetId = incomingLocationRequest.from;
    liveShareTargetRef.current = targetId;
    liveShareSessionRef.current = {
      targetId,
      lastSentAt: 0,
      lastSentPosition: null,
      status: "active",
    };
    setLocationDebugMessage("Getting your location…");
    // [STEP 9] Dismiss the blocking full-screen overlay so the user can
    // freely navigate the app while sharing continues in the background.
    setShowLocationPermission(false);
    setLiveSharingActive(true);

    // Clear any previous watch before starting a new one.
    if (liveShareWatchIdRef.current !== null) {
      navigator.geolocation.clearWatch(liveShareWatchIdRef.current);
    }

    let isFirstCallback = true;

    // watchPosition keeps GPS locked continuously — survives phone lock and
    // app backgrounding. The callback fires whenever the GPS gets a new fix
    // (typically every 1-5 s on Android with enableHighAccuracy).
    liveShareWatchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const session = liveShareSessionRef.current;
        if (!session) return;

        const { latitude, longitude } = pos.coords;
        const sinceLastSend = Date.now() - session.lastSentAt;
        const moved = session.lastSentPosition
          ? calculateDistance(
              session.lastSentPosition.lat, session.lastSentPosition.lng,
              latitude, longitude,
            )
          : Infinity; // no prior fix — always send

        // Send if: first ever fix, OR meaningful movement, OR heartbeat due.
        if (isFirstCallback || moved >= MIN_LOCATION_MOVE_M || sinceLastSend >= LIVE_SHARE_HEARTBEAT_MS) {
          trySendPosition(pos, isFirstCallback);
          isFirstCallback = false;
        }
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          setLocationDebugMessage("Location permission denied. Enable in device settings.");
          stopLiveShare();
        } else {
          // TIMEOUT / POSITION_UNAVAILABLE — transient; keep the watch alive.
          setLocationDebugMessage("GPS signal weak — retrying…");
        }
      },
      {
        enableHighAccuracy: true,
        // No timeout on watchPosition — it keeps trying indefinitely.
        // maximumAge: 0 ensures we always get fresh positions, not cached.
        maximumAge: 0,
      },
    );
  }, [incomingLocationRequest, trySendPosition, stopLiveShare]);

  // Connection recovery: when WS comes back after a drop, mark session active
  // again (watchPosition is already running — no restart needed, just let the
  // next GPS callback fire and send).
  useEffect(() => {
    const session = liveShareSessionRef.current;
    if (!session) return;
    if (!isOnline && session.status === "active") {
      session.status = "paused";
      setLocationDebugMessage("Connection lost — will resume when reconnected.");
    } else if (isOnline && session.status === "paused") {
      session.status = "active";
      setLocationDebugMessage("Reconnected — resuming location sharing.");
    }
  }, [isOnline]);

  // App resume handler: if the user comes back from a lock/background and
  // watchPosition was killed by the OS (rare but possible), restart it.
  // The existing appStateChange effect in use-ranger-connection.ts handles
  // the WS reconnect; here we only need to restart GPS if necessary.
  useEffect(() => {
    // This ref access is safe — if watchPosition is alive, its ID is set;
    // if it was killed, the navigator returns false for the watch ID.
    // Since we can't truly detect OS-killed watches in JS, we rely on the
    // fact that watchPosition on Android with the FOREGROUND_SERVICE_LOCATION
    // permission should NOT be killed. This effect is a safety net.
    const handleAppResume = () => {
      const session = liveShareSessionRef.current;
      if (!session || session.status !== "active") return;
      if (liveShareWatchIdRef.current === null && navigator.geolocation) {
        // watchPosition was stopped — restart it.
        acceptLocationShare();
      }
    };
    window.addEventListener("focus", handleAppResume);
    return () => window.removeEventListener("focus", handleAppResume);
  }, [acceptLocationShare]);

  // ════════════════════════════════════════════════════════════════════════
  // [STEP 9] Waypoint navigation: open GPS-capture list modal + start GPS,
  // so the list can show live distance-to-waypoint.
  // ════════════════════════════════════════════════════════════════════════
  const openWaypointManager = useCallback(() => {
    if (navigator.geolocation && waypointsGpsWatchIdRef.current === null) {
      waypointsGpsWatchIdRef.current = navigator.geolocation.watchPosition(
        (pos) => setUserGpsPosition(pos),
        () => {},
        { enableHighAccuracy: true, maximumAge: 0 },
      );
    }
    setShowWaypoints(true);
  }, []);

  const handleNamedWaypointNavigate = useCallback((wp: NamedWaypoint) => {
    const navContact: Contact = {
      deviceId:        `waypoint-${wp.id}`,
      deviceName:      wp.name,
      frequency:       RADIO_FREQUENCY_HZ,
      spreadingFactor: RADIO_SPREADING_FACTOR,
      bandwidth:       RADIO_BANDWIDTH_HZ,
      unreadCount:     0,
      reachability:    "offline",
      location:        { lat: wp.lat, lng: wp.lng, accuracy: 0, timestamp: wp.createdAt },
    };
    setCurrentContact(navContact);
    setActiveNavContact(navContact); // [Step 9]
    setActiveNavBeepDeviceId(wp.sourceDeviceId); // [STEP 14]
    setShowCompass(true);
    setShowWaypoints(false);
  }, []);

  // ════════════════════════════════════════════════════════════════════════
  // [NEW] PAIR REQUEST VIA LORA (called by AddDeviceModal when "Add" tapped)
  // ════════════════════════════════════════════════════════════════════════
  const handlePairRequest = useCallback((targetId: string) => {
    const ourName = myDeviceNameRef.current || myDeviceIdRef.current || "FlingNode";
    sendFrame(encodePairRequest(targetId, ourName));
  }, [sendFrame]);

  // ════════════════════════════════════════════════════════════════════════
  // RENDER
  // ════════════════════════════════════════════════════════════════════════
  return (
    <>
      {/* [STEP 12] SOS mesh-confidence banner (item 9) — the mesh's flagship
          "help is being coordinated" reassurance. Deliberately persistent
          (no auto-dismiss timer, unlike the notices below) since this is the
          most important context a user can have during an actual emergency.
          Fully interactive (pointer-events-auto throughout, not just a tap
          zone) — it's a small panel, not a passing toast. */}
      {sosStatus && !showSplash && isWiFiConnected && (
        <div className="fixed top-0 left-0 right-0 z-50 flex justify-center pt-14 px-4">
          <div className="bg-red-950/95 border border-red-700 text-white text-sm px-4 py-3 rounded-xl shadow-lg shadow-red-900/50 flex flex-col gap-2 max-w-sm w-full animate-[fade-in_0.25s_ease-out]">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full bg-red-400 animate-pulse" />
                <span className="font-semibold">SOS Active</span>
              </div>
              <button
                onClick={() => setSosStatus(null)}
                className="text-red-300 hover:text-white transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="text-red-100">
              {sosStatus.confirmedBy.length === 0
                ? "Propagating through the mesh — waiting for confirmation…"
                : `${sosStatus.confirmedBy.length} node${sosStatus.confirmedBy.length > 1 ? "s" : ""} confirmed receipt — help is reachable.`}
            </p>
          </div>
        </div>
      )}

      {/* [v6 RANGE DETECTION] Transient notification banner. Slides in at the top
          when a node changes reachability (out of range / weak / back online) and
          auto-dismisses after a few seconds. pointer-events-none so it never
          blocks taps underneath. Hidden during splash/Wi-Fi setup. */}
      {rangeNotice && !showSplash && isWiFiConnected && (
        <div className="fixed top-0 left-0 right-0 z-50 flex justify-center pt-14 px-4 pointer-events-none">
          <div className="bg-gray-900/95 border border-gray-700 text-white text-sm px-4 py-2.5 rounded-xl shadow-lg flex items-center gap-2 animate-[fade-in_0.25s_ease-out]" style={{ marginTop: sosStatus ? 96 : 0 }}>
            <span className="h-2 w-2 rounded-full bg-orange-400 animate-pulse" />
            {rangeNotice}
          </div>
        </div>
      )}

      {/* [STEP 4B] Delivery-failed banner — stacks below the range notice
          (rare to see both at once) rather than sharing its state, so an
          unrelated reachability change can never silently swallow this. */}
      {deliveryNotice && !showSplash && isWiFiConnected && (
        <div className="fixed top-0 left-0 right-0 z-50 flex justify-center pt-14 px-4 pointer-events-none">
          <div className="bg-gray-900/95 border border-red-800 text-white text-sm px-4 py-2.5 rounded-xl shadow-lg flex items-center gap-2 animate-[fade-in_0.25s_ease-out]" style={{ marginTop: (sosStatus ? 96 : 0) + (rangeNotice ? 48 : 0) }}>
            <span className="h-2 w-2 rounded-full bg-red-500" />
            {deliveryNotice}
          </div>
        </div>
      )}

      {/* [STEP 6] Location-session banner (e.g. "X stopped sharing their
          location") — stacks below the other two banners. */}
      {locationNotice && !showSplash && isWiFiConnected && (
        <div className="fixed top-0 left-0 right-0 z-50 flex justify-center pt-14 px-4 pointer-events-none">
          <div
            // [STEP 12] pointer-events-auto re-enables taps on just this
            // banner (its container is pointer-events-none so it never
            // blocks the screen underneath) — only meaningful when an SOS
            // location notice armed a tap action above.
            onClick={() => {
              if (!locationNoticeActionRef.current) return;
              locationNoticeActionRef.current();
              locationNoticeActionRef.current = null;
              setLocationNotice(null);
            }}
            className={`bg-gray-900/95 border border-blue-800 text-white text-sm px-4 py-2.5 rounded-xl shadow-lg flex items-center gap-2 animate-[fade-in_0.25s_ease-out] pointer-events-auto ${
              locationNoticeActionRef.current ? "cursor-pointer hover:bg-gray-800/95" : ""
            }`}
            style={{ marginTop: (sosStatus ? 96 : 0) + (rangeNotice ? 48 : 0) + (deliveryNotice ? 48 : 0) }}
          >
            <span className="h-2 w-2 rounded-full bg-blue-400" />
            {locationNotice}
          </div>
        </div>
      )}


      {showSplash ? (
        <SplashScreen />
      ) : !isWiFiConnected ? (
        <WiFiConnectionModal onConnected={() => setIsWiFiConnected(true)} />
      ) : view === "contacts" ? (
        <ContactsView
          contacts={contacts}
          pwaInstall={pwaInstall}
          connectionState={connectionState}
          reconnectAttempts={reconnectAttempts}
          lastConnectionError={lastConnectionError}
          onShowNodeStats={() => setShowNodeStats(true)}
          showDeleteMenu={showDeleteMenu}
          onToggleDeleteMenu={setShowDeleteMenu}
          onShowWaypoints={openWaypointManager}
          onShowAddContact={() => {
            resetDiscovery();    // clear stale results when opening modal
            setShowAddContact(true);
          }}
          onOpenChat={openChat}
          onDeleteContact={deleteContact}
          onReconnect={reconnect}
        />
      ) : currentContact ? (
        <ChatView
          contact={currentContact}
          messages={messages[currentContact.deviceId] || []}
          inputValue={inputValue}
          onInputChange={setInputValue}
          isTyping={false}
          isOnline={isOnline}
          connectionState={connectionState}
          reconnectAttempts={reconnectAttempts}
          keyboardHeight={keyboardHeight}
          messagesEndRef={messagesEndRef}
          onBack={() => setView("contacts")}
          onRequestLocation={requestLocation}
          onSendMessage={sendMessage}
          onReconnect={reconnect}
          /* [NEW] message-deletion handlers — see fling-app deletion section.
             currentContact.deviceId is the thread key these operate on. */
          onDeleteMessage={(messageId) =>
            deleteMessage(currentContact.deviceId, messageId)
          }
          onDeleteMessages={(messageIds) =>
            deleteMessages(currentContact.deviceId, messageIds)
          }
          onClearConversation={() => clearConversation(currentContact.deviceId)}
        />
      ) : null}

      {/* ── Add Device Modal ─────────────────────────────────────────────── */}
      {showAddContact && (
        <AddDeviceModal
          onAdd={addContact}
          onClose={() => setShowAddContact(false)}
          connectedDeviceId={connectedDeviceId}
          connectedDeviceName={connectedDeviceName}
          onDiscover={startDiscovery}
          discoveredNodes={discoveredNodes}
          isDiscovering={isDiscovering}
          onPairRequest={handlePairRequest}
        />
      )}

      {/* ── [STEP 4B] Node diagnostics ───────────────────────────────────── */}
      {showNodeStats && (
        <NodeStatsModal
          deviceId={connectedDeviceId}
          deviceName={connectedDeviceName}
          frequencyHz={RADIO_FREQUENCY_HZ}
          spreadingFactor={RADIO_SPREADING_FACTOR}
          bandwidthHz={RADIO_BANDWIDTH_HZ}
          stats={nodeStats}
          contacts={contacts}
          onClose={() => setShowNodeStats(false)}
        />
      )}

      {/* ── [STEP 9] Waypoint manager (GPS-capture list, replaces Leaflet map) */}
      {showWaypoints && (
        <WaypointManagerModal
          userPosition={userGpsPosition}
          onNavigate={handleNamedWaypointNavigate}
          onClose={() => {
            setShowWaypoints(false);
            if (waypointsGpsWatchIdRef.current !== null) {
              navigator.geolocation?.clearWatch(waypointsGpsWatchIdRef.current);
              waypointsGpsWatchIdRef.current = null;
            }
          }}
        />
      )}

      {/* ── Outgoing location request overlay ───────────────────────────── */}
      {showLocationRequest && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-gray-800 rounded-3xl p-6 max-w-md w-full shadow-2xl">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-2xl font-bold text-white">Location Request</h2>
              <Button
                variant="ghost" size="icon"
                onClick={resetAllLocationState}
                className="rounded-full text-gray-400 hover:text-white hover:bg-gray-700"
              >
                <X className="h-5 w-5" />
              </Button>
            </div>
            <div className="py-8 text-center">
              {locationRequestStatus === "waiting" && (
                <>
                  <div className="relative w-32 h-32 mx-auto mb-6">
                    <div className="absolute inset-0 bg-blue-500 rounded-full animate-ping opacity-25" />
                    <div className="w-32 h-32 bg-blue-600 rounded-full flex items-center justify-center shadow-2xl shadow-blue-500/50">
                      <Navigation className="h-16 w-16 text-white animate-pulse" />
                    </div>
                  </div>
                  <h3 className="text-xl font-semibold text-white mb-3">Waiting for Response</h3>
                  <p className="text-gray-300">{currentContact?.deviceName} needs to approve…</p>
                  <p className="text-xs text-gray-500 mt-3">The compass will open automatically when they respond.</p>
                </>
              )}
              {locationRequestStatus === "requesting" && (
                <>
                  <div className="w-32 h-32 mx-auto bg-gray-700 rounded-full flex items-center justify-center mb-6 animate-pulse">
                    <Navigation className="h-16 w-16 text-gray-400" />
                  </div>
                  <h3 className="text-xl font-semibold text-white mb-3">Requesting Location</h3>
                  <p className="text-gray-300">Sending request to {currentContact?.deviceName}…</p>
                </>
              )}
              {/* [STEP 6] Timeout / connection-loss while waiting now ends in a
                  clear error state instead of spinning or hanging forever. */}
              {locationRequestStatus === "error" && (
                <>
                  <div className="w-32 h-32 mx-auto bg-red-600/20 rounded-full flex items-center justify-center mb-6">
                    <X className="h-16 w-16 text-red-400" />
                  </div>
                  <h3 className="text-xl font-semibold text-white mb-3">No Response</h3>
                  <p className="text-gray-300">Tap the X above to close, then try again.</p>
                </>
              )}
              {locationDebugMessage && (
                <p className="mt-6 text-xs text-yellow-500 animate-pulse">{locationDebugMessage}</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* [Step 9 — Issue 3] Live-sharing pill — repositioned from bottom-0
          (which covered the chat input) to a slim floating strip just below
          the header/status bar area (top-14 ≈ 56px). This is consistent with
          how modern navigation apps surface persistent session indicators
          without blocking any interactive content. */}
      {liveSharingActive && (
        <div className="fixed top-14 left-0 right-0 z-40 flex justify-center px-4 pointer-events-auto">
          <div className="bg-emerald-900/95 border border-emerald-700 rounded-2xl px-4 py-2.5
                          flex items-center gap-3 shadow-xl max-w-xs w-full">
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-400 animate-pulse flex-shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-white truncate">Sharing live location</p>
              {locationDebugMessage && (
                <p className="text-xs text-emerald-300 truncate">{locationDebugMessage}</p>
              )}
            </div>
            <Button
              onClick={stopLiveShare}
              size="sm"
              className="bg-red-600 hover:bg-red-700 text-white rounded-xl px-3 flex-shrink-0 text-xs"
            >
              Stop
            </Button>
          </div>
        </div>
      )}

      {/* ── Incoming location permission request (consent only, dismissed on accept) ── */}
      {showLocationPermission && incomingLocationRequest && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-gray-800 rounded-3xl p-6 max-w-md w-full shadow-2xl">
            <div className="py-4 text-center">
              <div className="w-24 h-24 mx-auto bg-blue-600 rounded-full flex items-center justify-center mb-6 shadow-2xl shadow-blue-500/30 animate-pulse">
                <Navigation className="h-12 w-12 text-white" />
              </div>
              <h3 className="text-xl font-semibold text-white mb-3">Location Request</h3>
              <p className="text-gray-300 mb-2 px-4">
                <span className="text-white font-medium">{incomingLocationRequest.deviceName}</span>{" "}
                wants to track your location live
              </p>
              <>
                <p className="text-gray-400 text-xs mb-6 px-4">
                  Once you accept, you can use the rest of the app normally.
                  A banner at the bottom shows sharing is active.
                </p>
                {locationDebugMessage && (
                  <p className="text-xs text-yellow-500 mb-4 animate-pulse">{locationDebugMessage}</p>
                )}
                <div className="flex gap-3">
                  <Button
                    variant="outline"
                    onClick={resetAllLocationState}
                    className="flex-1 border-gray-600 text-gray-300 hover:bg-gray-700"
                  >
                    Decline
                  </Button>
                  <Button
                    onClick={acceptLocationShare}
                    className="flex-1 bg-blue-600 hover:bg-blue-700 text-white"
                  >
                    Share Live Location
                  </Button>
                </div>
              </>
            </div>
          </div>
        </div>
      )}

      {/* [STEP 16] Navigation resume pill — shown when a nav session is
          active but the compass has been minimised (X pressed). Tapping the
          text reopens the compass; the small X ends the session completely. */}
      {activeNavContact && !showCompass && (
        <div className="fixed top-14 left-0 right-0 z-40 flex justify-center px-4 pointer-events-auto">
          <div className="bg-blue-900/95 border border-blue-700 rounded-2xl px-4 py-2.5
                          flex items-center gap-3 shadow-xl max-w-xs w-full">
            <span className="h-2.5 w-2.5 rounded-full bg-blue-400 animate-pulse flex-shrink-0" />
            <button
              onClick={() => setShowCompass(true)}
              className="text-sm font-semibold text-white truncate flex-1 text-left"
            >
              Navigate → {activeNavContact.deviceName}
            </button>
            <button
              onClick={() => {
                setActiveNavContact(null);
                setActiveNavBeepDeviceId(undefined);
                resetAllLocationState();
              }}
              className="p-1 text-blue-400 hover:text-white flex-shrink-0"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* ── Compass / navigation ─────────────────────────────────────────── */}
      {showCompass && currentContact && (
        <CompassModal
          // [STEP 15] Force a fresh instance per navigation TARGET (not just
          // per render) — without this, switching from one contact/waypoint
          // to another reused the same mounted CompassModal, and its
          // internal EMA-smoothed distance/bearing refs carried over from
          // the PREVIOUS target instead of resetting. That's what made two
          // nodes standing right next to each other read as ~35m apart: the
          // displayed distance was still blending toward the old target's
          // (much larger) distance. A `key` on identity forces React to
          // unmount/remount instead of reusing state across targets.
          key={currentContact.deviceId}
          // [Step 9 — Issue 5] Pass the LIVE contact from the contacts array
          // (not the stale snapshot in currentContact) so the compass receives
          // real-time reachability updates from the range monitor.
          contact={contacts.find((c) => c.deviceId === currentContact.deviceId) ?? currentContact}
          onBeep={(deviceId) => sendFrame(encodeBeep(deviceId))}
          beepDeviceId={activeNavBeepDeviceId}
          // [STEP 19] Resolve the relaying node's id to a friendly name —
          // CompassModal only ever sees this one contact, not the full list.
          viaNodeName={(() => {
            const viaId = (contacts.find((c) => c.deviceId === currentContact.deviceId) ?? currentContact).signalViaNodeId;
            return viaId ? resolveSenderName(viaId, contacts) : undefined;
          })()}
          // [STEP 16] X minimizes: hides Compass but keeps the session alive
          // in the background — resumable via the small banner below.
          onMinimize={() => setShowCompass(false)}
          // Reachable from the offline-contact / no-location / permission-
          // denied edge screens, and from the resume banner's own X below.
          // A full teardown.
          onClose={() => {
            setShowCompass(false);
            setActiveNavContact(null);
            setActiveNavBeepDeviceId(undefined);
            resetAllLocationState();
          }}
        />
      )}
    </>
  );
}
