// ─────────────────────────────────────────────────────────────────────────────
// lib/constants.ts
//
// Central place for every magic number in the Fling app.
// ─────────────────────────────────────────────────────────────────────────────

// ── WebSocket endpoint ────────────────────────────────────────────────────────
export const RANGER_WS_URL = "ws://192.168.4.1:8765";

// ── Radio defaults ────────────────────────────────────────────────────────────
// [v6] RADIO_SPREADING_FACTOR 7 → 9 to match the firmware's range-balanced LoRa
// setting. Display/default only; the real radio config lives in the firmware.
// (Frequency stays 433 MHz — this module is 433-only and needs a 433 antenna.)
export const RADIO_FREQUENCY_HZ      = 433_000_000;
export const RADIO_SPREADING_FACTOR  = 9;
export const RADIO_BANDWIDTH_HZ      = 125_000;

// ── WebSocket connection behaviour ───────────────────────────────────────────
export const CONNECT_TIMEOUT_MS       = 5_000;
// [v5] DEPRECATED: replaced by the real ping/pong heartbeat below
// (PING_INTERVAL_MS / PONG_TIMEOUT_MS). Kept only so nothing that might still
// import it breaks; safe to delete once you're sure it's unused.
export const HEALTH_CHECK_INTERVAL_MS = 3_000;
export const MAX_RECONNECT_ATTEMPTS   = 10;
export const RECONNECT_BASE_DELAY_MS  = 1_000;
export const RECONNECT_MAX_DELAY_MS   = 5_000;

// [v5 WIFI-STABILITY] App-side heartbeat.
//   The firmware now answers WebSocket-level PINGs, but the browser WebSocket
//   API doesn't expose ping/pong to JavaScript. So instead the app sends a tiny
//   application-level "ping" frame every PING_INTERVAL_MS and expects ANY
//   message back from the firmware within PONG_TIMEOUT_MS. If nothing arrives,
//   the socket is treated as dead and force-reconnected. This is what catches a
//   silently-dead connection that still *looks* OPEN to the browser.
export const PING_INTERVAL_MS = 5_000;
export const PONG_TIMEOUT_MS  = 8_000;

// ── [v6 RANGE DETECTION] Per-node signal quality + reachability ───────────────
// These classify each remote node's link into a status the user can read at a
// glance, using the RSSI the firmware reports and how long since we last heard.
//
// RSSI (Received Signal Strength Indicator) is in dBm and is always NEGATIVE;
// closer to 0 = stronger. Typical LoRa: -40 (very close) … -120 (far/edge).
//   stronger than RSSI_WEAK_DBM     → "online"  (good signal)
//   between WEAK and MIN            → "weak"    (works, but fragile)
//   weaker than RSSI_MIN_DBM        → effectively unusable
export const RSSI_WEAK_DBM = -100;   // below this (e.g. -105) = weak signal
export const RSSI_MIN_DBM  = -120;   // below this = basically out of range

// Reachability is time-based: silence is the strongest sign a node left range.
//   quiet longer than NODE_STALE_MS   → degrade to "weak"
//   quiet longer than NODE_OFFLINE_MS → "out of range"
// Any received packet (message/discovery/location) resets a node's clock.
export const NODE_STALE_MS   = 30_000;   // 30 s quiet → "weak"
export const NODE_OFFLINE_MS = 90_000;   // 90 s quiet → "out of range"

// How often the app re-evaluates every node's status (ms). A steady tick is
// what makes statuses update dynamically without the user doing anything.
export const RANGE_CHECK_INTERVAL_MS = 5_000;

// ── UI timing ─────────────────────────────────────────────────────────────────
export const SPLASH_DURATION_MS = 3_000;

// ── Special recipient IDs ──────────────────────────────────────────────────────
// "*" means broadcast to every node that receives the LoRa packet.
export const EMERGENCY_BROADCAST_ID = "*";

// ── Local storage keys ────────────────────────────────────────────────────────
export const TRAILS_STORAGE_KEY   = "fling-trails";
export const CONTACTS_STORAGE_KEY = "fling-contacts";
// [NEW] Persist conversation threads (especially the Emergency thread) so the
// emergency history survives a page reload / app restart. Previously messages
// lived only in React state and were lost on refresh.
export const MESSAGES_STORAGE_KEY = "fling-messages";

// ── Discovery ─────────────────────────────────────────────────────────────────
// How long each scan window lasts before auto-restarting (ms).
// [NEW] Reduced to 5 s so each individual scan completes faster.
export const DISCOVERY_SCAN_DURATION_MS = 5_000;

// [NEW] How long continuous background scanning runs before giving up (ms).
// 0 = scan forever until the user manually stops.
export const CONTINUOUS_SCAN_MAX_MS = 0;

// [NEW] Gap between automatic re-pings during continuous scan (ms).
// After each 5-second window we wait this long before sending the next ping.
export const DISCOVERY_REPOLL_DELAY_MS = 1_000;

// ── Pairing protocol sentinels ────────────────────────────────────────────────
// [NEW] These strings travel inside LoRa "data" fields to carry pairing info.
// Both must match the #define values in ranger_rola.ino.
// Format: ##PAIR_REQ##<senderName>  e.g. ##PAIR_REQ##Fling_Node1
export const PAIR_REQUEST_SENTINEL  = "##PAIR_REQ##";
export const PAIR_ACCEPT_SENTINEL   = "##PAIR_ACK##";
