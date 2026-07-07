export type Contact = {
  deviceId: string;
  deviceName: string;
  frequency: number;
  spreadingFactor: number;
  bandwidth: number;
  lastSeen?: Date;
  unreadCount: number;
  avatar?: string;
  // [STEP 4A] Reachability — derived ONLY from lastSeen + elapsed time.
  // Signal strength must never influence this value (see classifyReachability
  // in fling-app.tsx). Replaces the old combined RangeStatus field.
  reachability?: ReachabilityStatus;
  // [STEP 4A DIAGNOSTICS] Latest signal readings from the firmware for this
  // node, and signalQuality — derived ONLY from rssi/snr (see
  // classifySignalQuality in fling-app.tsx). Elapsed time must never
  // influence this value; use signalSampledAt to judge how fresh it is.
  //   rssi: dBm, always negative; closer to 0 = stronger (e.g. -55 strong, -110 weak)
  //   snr:  dB, signal vs noise; higher = cleaner (LoRa decodes down to ~ -20 dB)
  // All undefined until we've received at least one signal-bearing frame
  // (message, discovery reply, or a relayed HELLO) from the node.
  rssi?: number;
  snr?: number;
  signalQuality?: SignalQuality;
  signalSampledAt?: Date;     // when rssi/snr was actually measured
  signalHopDistance?: number; // 0 = direct neighbor (HELLO-relay), >0 = relayed/multi-hop
  // [STEP 19] The direct neighbor's device id that physically relayed the
  // most recent message/location from this contact — undefined when
  // signalHopDistance is 0 (direct) or simply not yet known. Resolved to a
  // display name via the contacts list at render time, not stored here.
  signalViaNodeId?: string;
  location?: ContactLocation;
  // [STEP 8] battery removed — no hardware to read it from.
};

// [STEP 4B] Periodic firmware health/diagnostics counters, surfaced as-is
// from the firmware's "stats" WS frame (sent every 5s while a phone is
// connected). Purely informational — nothing in the app logic depends on it.
// [STEP 7] NodeStats updated to match the corrected firmware field names.
//   pktSent      = total LoRa packets sent (HELLOs, ACKs, RREQs, data …)
//   appMsgSent   = only user-originated messages (chat, beep, location)
// The old "messagesSent" field was pktSent under a misleading name.
export type NodeStats = {
  pktSent: number;          // all LoRa transmissions
  appMsgSent: number;       // user messages only
  messagesReceived: number;
  uptime: number;           // seconds since boot
  connectedClients: number;
  pktForwarded: number;
  pktDroppedDup: number;
  pktDroppedNoRoute: number;
  pktDroppedQueueFull: number;
  routeDiscoveries: number;
  // [STEP 8] battery removed
};

// [STEP 4A] Time-only reachability. Never influenced by signal strength.
//   online  – heard from within NODE_STALE_MS
//   stale   – not heard from in a while, but not yet given up on
//   offline – not heard from in NODE_OFFLINE_MS or longer; assumed unreachable
export type ReachabilityStatus = "online" | "stale" | "offline";

// [STEP 4A] Signal-only quality. Never influenced by time since last contact.
//   strong  – excellent RSSI
//   good    – usable, comfortable margin
//   weak    – fragile but technically working
//   unknown – no rssi reading has ever arrived for this node yet
export type SignalQuality = "strong" | "good" | "weak" | "unknown";

export type ContactLocation = {
  lat: number;
  lng: number;
  accuracy: number;
  timestamp: Date;
};

export type Message = {
  id: string;
  sender: string;
  recipient: string;
  content: string;
  timestamp: Date;
  status: MessageStatus;
  isMe: boolean;
  offline?: boolean;
  // [NEW] Human-readable name of the sender, used in the shared Emergency
  // thread so received messages can show "Ranger B" instead of a raw node id.
  // Undefined for our own messages and for normal private chats.
  senderName?: string;
  // [NEW] True when this message arrived/was sent as an emergency broadcast.
  // Lets the UI tag individual bubbles inside the Emergency thread.
  broadcast?: boolean;
};

// [STEP 7] "retrying" added: shown after ACK_RETRY_VISUAL_DELAY_MS of
// being in "sent" state without a delivery confirmation, so the user can
// see the mesh is actively re-sending rather than silently hanging. The
// message stays "retrying" until a delivery-confirmed or delivery-failed
// event arrives from the firmware.
export type MessageStatus = "sending" | "sent" | "retrying" | "delivered" | "read" | "failed";

export type View = "contacts" | "chat";

export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error"
  | "reconnecting";

// Not in lib.dom.d.ts — Chromium-only PWA install event.
export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}
