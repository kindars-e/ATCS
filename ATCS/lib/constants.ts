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

// ── [STEP 4A] Signal quality — RSSI-only, never time-based ────────────────────
// RSSI (Received Signal Strength Indicator) is in dBm and is always NEGATIVE;
// closer to 0 = stronger. Typical LoRa: -40 (very close) … -120 (far/edge).
//   stronger than RSSI_STRONG_DBM        → "strong"
//   between STRONG and WEAK              → "good"
//   weaker than RSSI_WEAK_DBM            → "weak" (fragile but still a link)
//   no reading at all                    → "unknown" (never fabricated)
export const RSSI_STRONG_DBM = -85;  // at/above this = strong signal
export const RSSI_WEAK_DBM   = -100; // below this = weak signal

// A signal reading older than this is shown as stale (muted + age label)
// rather than presented as if it were current.
export const SIGNAL_SAMPLE_STALE_MS = 60_000; // 60 s

// ── [STEP 4A / STEP 7] Reachability — time-only, never influenced by signal ──
// Silence is the strongest sign a node left range. Any received packet
// (message/discovery/location/relayed HELLO) resets a node's clock.
//
// [STEP 7] Timing recalibrated relative to HELLO_INTERVAL_MS (15 s):
//   NODE_STALE_MS  = 22 s  → goes stale after roughly 1.5 HELLO intervals.
//     A single slightly-late HELLO (up to 22 s) won't cause false "Stale",
//     but a genuinely missing HELLO does — giving fast, stable feedback.
//   NODE_OFFLINE_MS = 45 s → "offline" after ~3 missed HELLOs. Clearly
//     dead, not a transient RF hiccup.
//
// Previous values (30 s / 90 s) were too slow for field use: a node that
// was just powered off would appear "online" for up to 30 s.
export const NODE_STALE_MS   = 22_000;   // 22 s quiet → "stale"
export const NODE_OFFLINE_MS = 45_000;   // 45 s quiet → "offline"

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
export const CONTACTS_STORAGE_KEY  = "fling-contacts";
// [STEP 9] Flat list of named waypoints (GPS coordinates + label) for the
// redesigned navigation system. Separate key from trails to keep them simple.
export const WAYPOINTS_STORAGE_KEY = "fling-waypoints";
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

// ── [STEP 6] Location sharing — timing, thresholds, traffic minimization ─────
// The firmware has NO location-specific code at all — every location message
// is just opaque text riding the same generic mesh-routed "send" path as a
// chat message (ACK, retry, route discovery all apply automatically). All of
// the constants below are pure app-layer policy. Nothing here ever depends
// on the internet — the whole system, including this feature, must keep
// working with zero connectivity beyond the local Ranger Wi-Fi/LoRa link.

// A GPS reading worse than this is too imprecise to be useful for finding
// someone and is held back rather than transmitted (wastes airtime for a fix
// that won't actually help). The one exception is the automatic SOS location
// ping, which always sends the best available fix regardless of accuracy —
// during an emergency, an imprecise fix beats no fix at all.
// [STEP 11] Tightened from 200 → 100. 200 m was loose enough to let fixes
// through that were themselves comparable to a small town's worth of error —
// exactly the kind of reading that shows up on the receiver's end as
// nonsensical distance/bearing. 100 m is still generous enough that a
// difficult environment (dense forest, canyon) isn't starved of updates
// entirely, but no longer waves through the very worst fixes.
export const MAX_USEFUL_GPS_ACCURACY_M = 100;

// [STEP 6] Live share is now event-driven, not a fixed 3s interval:
//   - a fresh fix is sent as soon as the responder has moved at least
//     MIN_LOCATION_MOVE_M since the last successfully sent fix, OR
//   - LIVE_SHARE_HEARTBEAT_MS has elapsed with no movement (so the requester
//     still gets periodic proof the share is alive even while stationary).
// LIVE_SHARE_CHECK_INTERVAL_MS is just how often we re-evaluate those two
// conditions — not how often we transmit.
// [STEP 7] Thresholds tuned for real-world testing and demonstrations.
// Old values (15 m / 30 s / 5 s) caused no visible updates when walking
// slowly or in a small area.
// [STEP 11] MIN_LOCATION_MOVE_M raised 2 → 8 m. Consumer GPS jitters by
// several metres even standing perfectly still, so a 2 m threshold was
// crossed by pure noise almost every single check cycle — "stationary
// detection" never actually triggered, and a standing-still peer kept
// re-sending jittery near-duplicate fixes every ~2 s. 8 m sits above the
// typical GPS noise floor while still being covered in a couple of seconds
// at a normal walking pace, so real movement is still reported promptly.
export const MIN_LOCATION_MOVE_M          = 8;
export const LIVE_SHARE_HEARTBEAT_MS      = 10_000;
export const LIVE_SHARE_CHECK_INTERVAL_MS = 2_000;

// How long to wait for a location-request to be answered before giving up
// and showing an error instead of spinning forever.
export const LOCATION_REQUEST_TIMEOUT_MS = 20_000;

// A received location fix older than this is shown with a "stale" warning;
// older than LOCATION_LOST_MS it's shown as "may no longer be accurate"
// rather than silently presented as if it were live.
export const LOCATION_STALE_MS = 30_000;
export const LOCATION_LOST_MS  = 120_000;

// Debounce window for the automatic SOS location ping — the firmware already
// resends the same SOS 3x (with jitter) for RF resilience; this prevents us
// from firing a redundant GPS broadcast for each of those repeats.
export const SOS_LOCATION_DEBOUNCE_MS = 8_000;

// [STEP 7] How long a message stays "sent" before the UI assumes the
// firmware is retrying and shows a "Retrying…" state. Set just above
// the firmware's new ACK_TIMEOUT_MS (3 s) so the visual flip happens
// right after the first retry starts, not before.
export const ACK_RETRY_VISUAL_DELAY_MS = 3_500;
