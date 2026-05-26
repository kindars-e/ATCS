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
//   device_info – sent once when WebSocket connects
//   stats       – periodic health counters (ignored by app)
//   delivery    – ACK: remote node confirmed it received our message
//   discovery   – a nearby node replied to our discovery ping
//
// LoRa DATA SENTINELS (embedded in message.data field):
//   ##LOCATION_REQUEST##                  – requester asks for responder's GPS
//   ##LOCATION_RESPONSE##lat,lng,acc      – responder sends their GPS back
//   ##PAIR_REQ##senderName                – [NEW] node A asks to pair with node B
//   ##PAIR_ACK##senderName                – [NEW] node B accepts pairing
// ─────────────────────────────────────────────────────────────────────────────

import {
  PAIR_REQUEST_SENTINEL,
  PAIR_ACCEPT_SENTINEL,
} from "./constants";

// Sentinel strings for location sharing (must match firmware #defines).
const LOCATION_REQUEST_SENTINEL  = "##LOCATION_REQUEST##";
const LOCATION_RESPONSE_SENTINEL = "##LOCATION_RESPONSE##";

// ── Outgoing frame union ──────────────────────────────────────────────────────
export type OutgoingFrame =
  | { type: "send";     recipient: string; data: string }
  | { type: "beep";     recipient: string }
  | { type: "discover" }
  // [v5 WIFI-STABILITY] Heartbeat ping the app sends to verify the link is alive.
  | { type: "ping" };

// ── Incoming frame union ──────────────────────────────────────────────────────
export type IncomingFrame =
  // [NEW] broadcast?: true when this message arrived as a LoRa "*" broadcast.
  | { type: "message";     sender: string; data: string; rssi?: number; broadcast?: boolean }
  | { type: "location";    sender: string; lat: number; lng: number; accuracy?: number }
  | { type: "device_info"; deviceId: string; deviceName: string; frequency?: number;
                           spreadingFactor?: number; bandwidth?: number }
  | { type: "stats";       [key: string]: unknown }
  | { type: "delivery";    status: "delivered" }
  | { type: "discovery";   deviceId: string; rssi?: number };

// ── Decoded message types ─────────────────────────────────────────────────────
export type DecodedMessage =
  // [NEW] broadcast carries through from the firmware so the app can route
  // emergency broadcasts into the shared Emergency thread.
  | { kind: "text";              sender: string; content: string; broadcast: boolean }
  | { kind: "location-request";  sender: string }
  | { kind: "location-response"; sender: string; lat: number; lng: number; accuracy: number }
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
      kind:     "location-response",
      sender,
      lat:      Number(latStr),
      lng:      Number(lngStr),
      accuracy: Number(accStr) || 10,
    };
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

export function encodeLocationResponse(
  recipient: string,
  lat:      number,
  lng:      number,
  accuracy: number,
): OutgoingFrame {
  return {
    type: "send",
    recipient,
    data: `${LOCATION_RESPONSE_SENTINEL}${lat},${lng},${accuracy}`,
  };
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
