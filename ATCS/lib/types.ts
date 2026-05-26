export type Contact = {
  deviceId: string;
  deviceName: string;
  frequency: number;
  spreadingFactor: number;
  bandwidth: number;
  lastSeen?: Date;
  unreadCount: number;
  avatar?: string;
  // [v6] status now includes range-aware values. The legacy values
  // ("online"/"offline"/"away") are kept so existing code keeps compiling; the
  // range monitor assigns the new "weak"/"out-of-range" values. See RangeStatus.
  status?: RangeStatus;
  location?: ContactLocation;
  // [v6 DIAGNOSTICS] Latest signal readings from the firmware for this node.
  //   rssi: dBm, always negative; closer to 0 = stronger (e.g. -55 strong, -110 weak)
  //   snr:  dB, signal vs noise; higher = cleaner (LoRa decodes down to ~ -20 dB)
  // Undefined until we've received at least one packet from the node.
  rssi?: number;
  snr?: number;
};

// [v6] All possible per-node link statuses.
//   online       – heard recently AND signal good
//   weak         – reachable but poor signal OR not heard in a while (fragile)
//   out-of-range – not heard for a long time; assumed unreachable
//   offline/away – legacy values, still accepted so older code compiles
export type RangeStatus =
  | "online"
  | "weak"
  | "out-of-range"
  | "offline"
  | "away";

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

export type MessageStatus = "sending" | "sent" | "delivered" | "read" | "failed";

export type View = "contacts" | "chat";

export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error"
  | "reconnecting";

export type Waypoint = {
  id: string;
  name: string;
  location: {
    lat: number;
    lng: number;
    accuracy: number;
  };
  timestamp: Date;
  type: "start" | "waypoint" | "camp" | "danger" | "water" | "interest";
  notes?: string;
};

export type Trail = {
  id: string;
  name: string;
  waypoints: Waypoint[];
  startTime: Date;
  endTime?: Date;
  totalDistance: number;
  active: boolean;
};

// Not in lib.dom.d.ts — Chromium-only PWA install event.
export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}
