// ─────────────────────────────────────────────────────────────────────────────
// lib/protocol.ts
//
// Defines EVERY JSON frame that travels between the Fling app and the
// ESP32 firmware over the WebSocket connection, and every sentinel string
// embedded inside LoRa "data" payloads.
//
// OUTGOING frames (app → firmware via WebSocket):
//   send     – send a LoRa message to a specific recipient or broadcast
//   beep     – send a beep command to another node
//   discover – broadcast a discovery ping
//
// INCOMING frames (firmware → app via WebSocket):
//   message     – text or special payload received via LoRa.
//                 [NEW] May carry "broadcast": true when the LoRa packet was
//                 addressed to "*" (an emergency broadcast). The app uses this
//                 flag to route the message into the shared Emergency thread
//                 instead of the sender's private chat.
//   location    – location broadcast received via LoRa
//   device_info – sent once when WebSocket connects. [STEP 4B] now includes
//                 our own node's battery level.
//   stats       – [STEP 4B] periodic health/diagnostics counters, now
//                 surfaced in the app (see NodeStats in lib/types.ts).
//   delivery    – status: "delivered" (unicast ACK), "failed" (retries +
//                 rediscovery exhausted — STEP 4A), or "sos_received"
//                 ([STEP 4B] one node confirmed receipt of our SOS broadcast;
//                 may arrive multiple times, once per node that received it).
//   discovery   – a nearby node replied to our discovery ping. [STEP 4B] may
//                 include that node's battery level.
//   neighbor    – [STEP 4A] relayed RSSI/SNR from a direct neighbor's HELLO
//                 beacon. Reuses traffic that was already happening every
//                 HELLO_INTERVAL_MS — no new LoRa packets are sent for this.
//                 [STEP 4B] now also includes that neighbor's battery level.
//
// LoRa DATA SENTINELS (embedded in message.data field):
//   ##LREQ##                  – [STEP 6] requester asks for responder's GPS
//   ##LRESP##lat,lng,acc      – [STEP 6] responder sends a GPS fix back (used
//                               for both one-time responses and each live-share
//                               update — same format either way)
//   ##LSTOP##                 – [STEP 6] responder explicitly ended a live
//                               share session, so the requester can show
//                               "stopped sharing" instead of silently going stale
//   ##PAIR_REQ##senderName    – [NEW] node A asks to pair with node B
//   ##PAIR_ACK##senderName    – [NEW] node B accepts pairing
//
// [STEP 6] These sentinels are entirely an app-level convention — the
// firmware never inspects message content, just relays bytes — so shortening
// them (from ##LOCATION_REQUEST##/##LOCATION_RESPONSE##) is a pure airtime
// saving with no firmware change required. An app still running the old,
// longer sentinels simply won't recognise the new short ones and will show
// them as literal chat text instead of decoding them — a visible but
// non-crashing degradation, not a protocol break.
// ─────────────────────────────────────────────────────────────────────────────

import {
  PAIR_REQUEST_SENTINEL,
  PAIR_ACCEPT_SENTINEL,
} from "./constants";

// Sentinel strings for location sharing (app-level convention only — the
// firmware treats these as opaque text, identical to any chat message).
const LOCATION_REQUEST_SENTINEL  = "##LREQ##";
const LOCATION_RESPONSE_SENTINEL = "##LRESP##";
const LOCATION_STOP_SENTINEL     = "##LSTOP##";

// ── Outgoing frame union ──────────────────────────────────────────────────────
export type OutgoingFrame =
  | { type: "send";     recipient: string; data: string }
  | { type: "beep";     recipient: string }
  | { type: "discover" }
  // [v5 WIFI-STABILITY] Heartbeat ping the app sends to verify the link is alive.
  | { type: "ping" };

// ── Incoming frame union ──────────────────────────────────────────────────────
// [STEP 6] Removed the unused `"location"` frame type — the firmware never
// actually sends a frame of that type (confirmed by full-text search of the
// firmware source); every location update arrives as an ordinary `"message"`
// frame whose `data` field decodes to a location-* DecodedMessage below. The
// `"location"`/`location-broadcast` handling that referenced it elsewhere was
// dead code and has been removed too.
export type IncomingFrame =
  // [NEW] broadcast?: true when this message arrived as a LoRa "*" broadcast.
  | { type: "message";     sender: string; data: string; rssi?: number; broadcast?: boolean }
  // [STEP 8] battery removed from all incoming frames
  | { type: "device_info"; deviceId: string; deviceName: string; frequency?: number;
                           spreadingFactor?: number; bandwidth?: number }
  | { type: "stats";       pktSent: number; appMsgSent: number; messagesReceived: number;
                           uptime: number; connectedClients: number; pktForwarded: number;
                           pktDroppedDup: number; pktDroppedNoRoute: number;
                           pktDroppedQueueFull: number; routeDiscoveries: number }
  | { type: "delivery";    status: "delivered" | "failed" | "sos_received"; dest?: string; from?: string }
  | { type: "discovery";   deviceId: string; rssi?: number; hops?: number }
  | { type: "neighbor";    deviceId: string; rssi?: number; snr?: number };

// ── Decoded message types ─────────────────────────────────────────────────────
export type DecodedMessage =
  // [NEW] broadcast carries through from the firmware so the app can route
  // emergency broadcasts into the shared Emergency thread.
  | { kind: "text";              sender: string; content: string; broadcast: boolean }
  | { kind: "location-request";  sender: string }
  // [STEP 6] broadcast: true when this fix arrived via the automatic
  // SOS location ping ("*" recipient) rather than a normal 1:1 share.
  | { kind: "location-response"; sender: string; lat: number; lng: number; accuracy: number; broadcast: boolean }
  // [STEP 6] The responder explicitly ended a live-share session.
  | { kind: "location-stop";     sender: string }
  // [NEW] Pairing handshake messages decoded from raw LoRa data fields.
  | { kind: "pair-request";      sender: string; senderName: string }
  | { kind: "pair-accept";       sender: string; senderName: string };

// ─────────────────────────────────────────────────────────────────────────────
// DECODE a raw { sender, data, broadcast } frame into a typed DecodedMessage.
//
// [NEW] The optional `broadcast` argument comes straight from the firmware
// WebSocket frame. It is only meaningful for plain text messages — pairing
// and location sentinels are always point-to-point, so we ignore it for them.
// ─────────────────────────────────────────────────────────────────────────────
export function decodeMessage(frame: {
  sender: string;
  data: string;
  broadcast?: boolean;
}): DecodedMessage {
  const { sender, data } = frame;
  // Normalise to a real boolean so the rest of the app never deals with undefined.
  const broadcast = frame.broadcast === true;

  if (data === LOCATION_REQUEST_SENTINEL) {
    return { kind: "location-request", sender };
  }

  if (data.startsWith(LOCATION_RESPONSE_SENTINEL)) {
    const [latStr, lngStr, accStr] = data
      .slice(LOCATION_RESPONSE_SENTINEL.length)
      .split(",");
    return {
      kind:      "location-response",
      sender,
      lat:       Number(latStr),
      lng:       Number(lngStr),
      accuracy:  Number(accStr) || 10,
      broadcast,
    };
  }

  // [STEP 6] Live-share session explicitly ended: "##LSTOP##"
  if (data === LOCATION_STOP_SENTINEL) {
    return { kind: "location-stop", sender };
  }

  // [NEW] Pair request: "##PAIR_REQ##Fling_Node1"
  // Node A broadcasts this to tell Node B "I want to pair with you; my name is X".
  if (data.startsWith(PAIR_REQUEST_SENTINEL)) {
    const senderName = data.slice(PAIR_REQUEST_SENTINEL.length).trim();
    return { kind: "pair-request", sender, senderName: senderName || `Ranger ${sender}` };
  }

  // [NEW] Pair accept: "##PAIR_ACK##Fling_Node2"
  // Node B sends this back to tell Node A "I accepted; my name is Y".
  if (data.startsWith(PAIR_ACCEPT_SENTINEL)) {
    const senderName = data.slice(PAIR_ACCEPT_SENTINEL.length).trim();
    return { kind: "pair-accept", sender, senderName: senderName || `Ranger ${sender}` };
  }

  // [NEW] Plain text — pass the broadcast flag through so the app can decide
  // whether this belongs in the Emergency thread or a private chat.
  return { kind: "text", sender, content: data, broadcast };
}

// ─────────────────────────────────────────────────────────────────────────────
// ENCODE helpers
// ─────────────────────────────────────────────────────────────────────────────

export function encodeTextMessage(recipient: string, content: string): OutgoingFrame {
  return { type: "send", recipient, data: content };
}

export function encodeLocationRequest(recipient: string): OutgoingFrame {
  return { type: "send", recipient, data: LOCATION_REQUEST_SENTINEL };
}

// [STEP 6] lat/lng rounded to 6 decimal places (~11cm precision — finer than
// consumer GPS accuracy ever is) and accuracy rounded to the nearest metre.
// A raw JS float can print 15+ significant digits; bounding the precision
// keeps every location packet a predictable, minimal size on an already
// bandwidth-constrained LoRa link.
export function encodeLocationResponse(
  recipient: string,
  lat:      number,
  lng:      number,
  accuracy: number,
): OutgoingFrame {
  return {
    type: "send",
    recipient,
    data: `${LOCATION_RESPONSE_SENTINEL}${lat.toFixed(6)},${lng.toFixed(6)},${Math.round(accuracy)}`,
  };
}

// [STEP 6] Tells the requester this live-share session has explicitly ended,
// so they can show "stopped sharing" instead of the location silently going
// stale with no explanation.
export function encodeLocationStop(recipient: string): OutgoingFrame {
  return { type: "send", recipient, data: LOCATION_STOP_SENTINEL };
}

export function encodeBeep(recipient: string): OutgoingFrame {
  return { type: "beep", recipient };
}

export function encodeDiscovery(): OutgoingFrame {
  return { type: "discover" };
}

// [NEW] Send a pair request to a specific node.
// myName is the device name that will be shown in the recipient's contacts list.
export function encodePairRequest(recipient: string, myName: string): OutgoingFrame {
  return { type: "send", recipient, data: `${PAIR_REQUEST_SENTINEL}${myName}` };
}

// [NEW] Accept a pair request — reply to the sender with our own name.
export function encodePairAccept(recipient: string, myName: string): OutgoingFrame {
  return { type: "send", recipient, data: `${PAIR_ACCEPT_SENTINEL}${myName}` };
}
