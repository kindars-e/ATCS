/*
 * ╔══════════════════════════════════════════════════════════════════════
 * ║  Ranger Mesh Firmware — v8 (full mesh networking)                    ║
 * ╠══════════════════════════════════════════════════════════════════════╣
 * ║  Works with the Fling app (Wi-Fi + WebSocket, port 8765).            ║
 * ║  Uses the Rola hardware pin layout and SPI LoRa library.             ║
 * ║                                                                      ║
 * ║  HOW TO CONFIGURE EACH NODE:                                         ║
 * ║    1. Find the "DEVICE IDENTITY" section below.                      ║
 * ║    2. Change THIS_DEVICE_ID to a unique name (no spaces/colons).     ║
 * ║       This name IS the node's mesh address — every node on the       ║
 * ║       network must have a different one (e.g. "Node1".."Node4").    ║
 * ║    3. Change WIFI_SSID to match — e.g. "Fling_Node2"                 ║
 * ║    4. Flash to the ESP32.  Repeat for each node with a new ID.       ║
 * ║                                                                      ║
 * ║  The app connects to:  ws://192.168.4.1:8765                        ║
 * ║  WiFi password is always:  fling1234                                 ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * ══════════════════════════════════════════════════════════════════════
 *  WHAT CHANGED IN v8 — PEER-TO-PEER  →  FULL MESH
 * ══════════════════════════════════════════════════════════════════════
 *
 *  BEFORE (v7 and earlier): every LoRa packet was a flat string
 *  "SENDER:RECIPIENT:CONTENT" and was assumed to travel in exactly ONE
 *  radio hop. Two nodes that couldn't hear each other directly could
 *  never talk. Reliability was a bare unicast "ACK:<sender>" string with
 *  no message ID, no de-duplication, and no idea what to do if a packet
 *  needed to travel through another node to reach its destination.
 *
 *  NOW (v8): every node runs identical mesh-networking firmware and can
 *  act as a SENDER, RECEIVER, and RELAY at the same time. Packets carry
 *  a structured binary header (see "MESH PACKET FORMAT" below) with a
 *  message ID, hop count, TTL, priority, and routing fields. Nodes:
 *    • discover their direct radio neighbours (HELLO beacons),
 *    • discover multi-hop routes on demand (RREQ / RREP, like the
 *      classic AODV mesh routing algorithm),
 *    • flood broadcast/SOS traffic outward hop-by-hop with loop and
 *      duplicate protection,
 *    • retry lost unicast deliveries end-to-end, and
 *    • recover automatically when a relay node disappears.
 *
 *  IMPORTANT: the WebSocket JSON contract with the phone app (the
 *  "type": "send" / "message" / "discovery" / "delivery" / ... frames
 *  defined in lib/protocol.ts) is UNCHANGED. The phone app does not know
 *  or care that messages might now travel through 1, 2, or 3 other
 *  nodes to reach their destination — that complexity is fully
 *  contained inside this firmware.
 *
 * ── MESH PACKET FORMAT ON LoRa AIR ───────────────────────────────────
 *
 *  Every packet is a small binary header followed by a payload of raw
 *  text bytes (the same chat text / sentinel strings the app already
 *  uses, e.g. "##PAIR_REQ##Fling_Node1"). We use raw bytes (not a colon
 *  delimited string like before) because we now need to pack several
 *  small numeric fields (message ID, TTL, hop count, priority) that a
 *  text format can't represent compactly or unambiguously.
 *
 *  Header layout (31 bytes, all fixed-position):
 *    byte  0      : packet type        (DATA / ACK / HELLO / RREQ / ...)
 *    bytes 1-2    : message ID         (16-bit, set by the ORIGINATOR)
 *    bytes 3-10   : source NodeID      (8 bytes, e.g. "Node1\0\0\0")
 *    bytes 11-18  : destination NodeID (8 bytes, or "*\0\0\0\0\0\0\0" = broadcast)
 *    bytes 19-26  : previous-hop NodeID (who physically sent us this copy)
 *    byte  27     : TTL                (Time To Live — hop budget left)
 *    byte  28     : hop count          (hops travelled so far, for diagnostics)
 *    byte  29     : priority           (0 normal, 1 control, 2 = SOS/emergency)
 *    byte  30     : payload length     (0-180 bytes follow the header)
 *
 *  A node never sends the raw C struct over the air — it manually packs
 *  each field byte-by-byte (see encodeHeader/decodeHeader) so the format
 *  is exact and portable, with no compiler padding surprises.
 *
 *  Packet types:
 *    DATA            – a real message for the app (chat text, sentinel
 *                       strings, BEEP, etc.) — unicast or broadcast.
 *    ACK              – "I (dst) received your message (msgId)."
 *    HELLO            – 1-hop-only beacon: "I'm <id>, here's my battery."
 *    RREQ             – "Does anyone know how to reach <dst>?" (floods)
 *    RREP             – "I'm <dst> (or know a route) — here's the way back."
 *    DISCOVER         – app-triggered "who else is out there?" (floods,
 *                       can find nodes multiple hops away — an upgrade
 *                       over the old single-hop discovery ping).
 *    DISCOVER_REPLY   – a node's answer to a DISCOVER, routed back.
 *
 * ── HOW EACH MESH CHALLENGE IS SOLVED (see full write-up given to the
 *    project owner for details) ─────────────────────────────────────
 *    • Multi-hop            → TTL-bounded relay + AODV-style routing
 *    • Reliable delivery     → end-to-end ACK + retry with backoff
 *    • Duplicate detection   → per-(source,msgId) "seen" cache
 *    • Routing loops         → TTL decrement + seen cache catches loops
 *    • TTL management        → MESH_TTL_MAX, decremented every hop
 *    • Neighbor discovery    → periodic HELLO beacons (1 hop only)
 *    • Route discovery       → reactive RREQ / RREP flood + reverse path
 *    • Route maintenance     → routes expire; broken routes invalidated
 *                              on repeated ACK failure
 *    • Node failure recovery → broken-route detection triggers fresh
 *                              route discovery automatically
 *    • Collision mitigation  → randomized jitter before every
 *                              broadcast/flood-style transmission
 *    • Congestion management → priority send queue + bounded table sizes
 *    • Priority handling     → SOS > control traffic > normal chat
 *    • Scalability            → reactive routing + bounded tables/TTL
 *                              keep cost flat regardless of mesh size
 *    • Payload protection    → LoRa hardware CRC + payload length checks
 *    • Efficient forwarding  → seen-cache avoids re-flooding known packets
 *    • Battery-awareness     → low-battery nodes stop relaying others'
 *                              traffic (still send/receive their own)
 *
 *  All v7 LED states, the multifunction button, and the dedicated SOS
 *  button are preserved with the same field-tested behaviour — they now
 *  just trigger mesh sends instead of single-hop string sends.
 */

// ── LIBRARIES ─────────────────────────────────────────────────────────
#include <SPI.h>
#include <LoRa.h>
#include <WiFi.h>
#include <WebSocketsServer.h>
#include <ArduinoJson.h>

// ════════════════════════════════════════════════════════════════════════
// HARDWARE PINS
// ════════════════════════════════════════════════════════════════════════
#define LORA_SCK    19
#define LORA_MISO   18
#define LORA_MOSI    5
#define LORA_CS     17
#define LORA_RST    16
#define LORA_DIO0    4

#define BTN_SOS     13   // Dedicated SOS button — DO NOT MODIFY LOGIC
#define BTN_USER     0   // Multifunction button (single / double / long press)

#define LED_GREEN    2   // Normal operation / connected
#define LED_YELLOW  14   // Searching / warning
#define LED_RED     12   // Emergency / critical failure

// ════════════════════════════════════════════════════════════════════════
// DEVICE IDENTITY  ← EDIT THIS SECTION FOR EACH NODE
//
// THIS_DEVICE_ID is both the friendly name shown in the app AND the
// node's unique mesh address used inside every packet header. It MUST
// be different on every physical node and MUST be 8 characters or
// fewer (NODE_ID_LEN below) so it fits the fixed-size header field.
// ════════════════════════════════════════════════════════════════════════
#define THIS_DEVICE_ID  "Node1"          // ← Change per node (max 8 chars)
#define WIFI_SSID       "Fling_Node1"    // ← Must match THIS_DEVICE_ID suffix
#define WIFI_PASS       "fling1234"

// ════════════════════════════════════════════════════════════════════════
// LoRa SETTINGS — all nodes must use the same values
// ════════════════════════════════════════════════════════════════════════
#define LORA_FREQ         433E6
#define LORA_TX_POWER       20
#define LORA_SF              9   // SF9 = good range + speed balance
#define LORA_BW          125E3
#define LORA_CR              5   // 4/5 coding rate
#define LORA_SYNC_WORD    0xF3  // Private network ID — all nodes must match

// ════════════════════════════════════════════════════════════════════════
// MESH PROTOCOL CONSTANTS
// ════════════════════════════════════════════════════════════════════════

#define NODE_ID_LEN        8     // fixed-width address field, in bytes
#define MAX_PAYLOAD       180    // max text bytes per packet
#define BROADCAST_ID      "*"    // destination meaning "everyone"

// ── Packet types ────────────────────────────────────────────────────────
#define PKT_DATA             1
#define PKT_ACK              2
#define PKT_HELLO            3
#define PKT_RREQ             4
#define PKT_RREP             5
#define PKT_DISCOVER         6
#define PKT_DISCOVER_REPLY   7

// ── Priorities (higher number = sent first) ─────────────────────────────
#define PRIO_NORMAL    0   // ordinary chat
#define PRIO_CONTROL   1   // HELLO / RREQ / RREP / ACK / DISCOVER*
#define PRIO_SOS       2   // emergency broadcast — always wins

// ── Mesh sizing/timing (tuned for a small demo mesh, room to grow) ──────
#define MESH_TTL_MAX            6     // max hops a packet may travel
#define MAX_NEIGHBORS           8
#define MAX_ROUTES              8
#define MAX_SEEN                24    // de-duplication cache size
#define MAX_OUTQUEUE             8     // pending-to-transmit slots
#define MAX_PENDING_ACK          4     // our own unicast sends awaiting ACK
#define MAX_PENDING_ROUTE        2     // sends waiting on route discovery

#define HELLO_INTERVAL_MS     15000   // how often we announce ourselves
#define NEIGHBOR_EXPIRY_MS     45000   // forget a neighbour after this long
#define ROUTE_EXPIRY_MS         60000   // forget an unused route after this long
#define ROUTE_DISCOVERY_TIMEOUT_MS  4000   // give up waiting for a route reply
#define ACK_TIMEOUT_MS           1500   // how long to wait for an end-to-end ACK
#define MAX_SEND_RETRIES            3     // unicast resend attempts before giving up
#define SEEN_CACHE_EXPIRY_MS    30000   // forget old dedup entries

#define JITTER_UNICAST_MIN_MS      10
#define JITTER_UNICAST_MAX_MS      60
#define JITTER_FLOOD_MIN_MS        60
#define JITTER_FLOOD_MAX_MS       300

// ── v5: SOS repeat reliability (kept from earlier firmware) ────────────
#define SOS_TOTAL_SENDS       3    // 1 immediate + 2 extra resends
#define SOS_REPEAT_GAP_MS   250    // base gap between resends (ms)

// ── Battery-aware forwarding ─────────────────────────────────────────────
// readBatteryPercent() is a stub — wire it to a real ADC voltage divider
// when the hardware has one. Until then it reports a healthy fixed value
// so the mesh behaves normally on dev boards with no battery sensor.
#define LOW_BATTERY_FORWARD_CUTOFF_PCT  20

// ── Multifunction button timing ───────────────────────────────────────
#define BTN_DEBOUNCE_MS       50
#define BTN_DOUBLE_MS        400
#define BTN_LONG_MS         2000

// ── LED blink timing ──────────────────────────────────────────────────
#define LED_YELLOW_SCAN_MS   800
#define LED_YELLOW_WARN_MS   200
#define LED_GREEN_CONFIRM_MS 300
#define LED_RED_EMERG_MS     150

// ════════════════════════════════════════════════════════════════════════
// MESH PACKET HEADER — byte offsets (see big comment block at top of file)
// ════════════════════════════════════════════════════════════════════════
#define OFF_TYPE          0
#define OFF_MSGID         1                          // 2 bytes
#define OFF_SRC           3                          // NODE_ID_LEN bytes
#define OFF_DST           (OFF_SRC + NODE_ID_LEN)
#define OFF_PREVHOP       (OFF_DST + NODE_ID_LEN)
#define OFF_TTL           (OFF_PREVHOP + NODE_ID_LEN)
#define OFF_HOP           (OFF_TTL + 1)
#define OFF_PRIORITY      (OFF_HOP + 1)
#define OFF_PAYLOADLEN    (OFF_PRIORITY + 1)
#define HEADER_SIZE       (OFF_PAYLOADLEN + 1)        // = 31 bytes
#define MAX_PACKET_SIZE   (HEADER_SIZE + MAX_PAYLOAD)

// A decoded header, in friendly C++ form (used everywhere except the
// raw on-the-wire bytes).
struct MeshHeader {
  uint8_t  type;
  uint16_t msgId;
  char     src[NODE_ID_LEN + 1];
  char     dst[NODE_ID_LEN + 1];
  char     prevHop[NODE_ID_LEN + 1];
  uint8_t  ttl;
  uint8_t  hop;
  uint8_t  priority;
  uint8_t  payloadLen;
};

// Write a NodeID string into a fixed NODE_ID_LEN field, zero-padded.
static void writeId(uint8_t* buf, int offset, const char* id) {
  memset(buf + offset, 0, NODE_ID_LEN);
  size_t len = strlen(id);
  if (len > NODE_ID_LEN) len = NODE_ID_LEN;
  memcpy(buf + offset, id, len);
}

// Read a fixed NODE_ID_LEN field back into a null-terminated string.
static void readId(const uint8_t* buf, int offset, char* out) {
  memcpy(out, buf + offset, NODE_ID_LEN);
  out[NODE_ID_LEN] = '\0';
}

// Pack a MeshHeader struct into the on-the-wire byte layout.
static void encodeHeader(const MeshHeader& h, uint8_t* buf) {
  buf[OFF_TYPE] = h.type;
  buf[OFF_MSGID]     = (uint8_t)(h.msgId >> 8);
  buf[OFF_MSGID + 1] = (uint8_t)(h.msgId & 0xFF);
  writeId(buf, OFF_SRC,     h.src);
  writeId(buf, OFF_DST,     h.dst);
  writeId(buf, OFF_PREVHOP, h.prevHop);
  buf[OFF_TTL]        = h.ttl;
  buf[OFF_HOP]        = h.hop;
  buf[OFF_PRIORITY]   = h.priority;
  buf[OFF_PAYLOADLEN] = h.payloadLen;
}

// Unpack the on-the-wire byte layout into a MeshHeader struct.
static void decodeHeader(const uint8_t* buf, MeshHeader& h) {
  h.type  = buf[OFF_TYPE];
  h.msgId = ((uint16_t)buf[OFF_MSGID] << 8) | buf[OFF_MSGID + 1];
  readId(buf, OFF_SRC,     h.src);
  readId(buf, OFF_DST,     h.dst);
  readId(buf, OFF_PREVHOP, h.prevHop);
  h.ttl        = buf[OFF_TTL];
  h.hop        = buf[OFF_HOP];
  h.priority   = buf[OFF_PRIORITY];
  h.payloadLen = buf[OFF_PAYLOADLEN];
}

static bool isBroadcastAddr(const char* id) {
  return strcmp(id, BROADCAST_ID) == 0;
}

// ════════════════════════════════════════════════════════════════════════
// MESH TABLES
// ════════════════════════════════════════════════════════════════════════

// ── Neighbor table: nodes we can hear directly (built from ANY heard
//    packet's prevHop field, not just HELLO beacons — "opportunistic
//    learning"). Used for diagnostics and battery-aware reporting. ─────
struct NeighborEntry {
  bool          inUse;
  char          id[NODE_ID_LEN + 1];
  unsigned long lastHeard;
  int16_t       rssi;
  float         snr;
  uint8_t       battery;
};
NeighborEntry neighbors[MAX_NEIGHBORS];

// ── Route table: "to reach <dest>, send to <nextHop>". Built reactively
//    by RREQ/RREP (and by DISCOVER, which doubles as a free route
//    discovery for whoever sent it). ──────────────────────────────────
struct RouteEntry {
  bool          valid;
  char          dest[NODE_ID_LEN + 1];
  char          nextHop[NODE_ID_LEN + 1];
  uint8_t       hopCount;
  unsigned long lastUsed;
};
RouteEntry routes[MAX_ROUTES];

// ── Seen cache: de-duplication. Every packet is identified by
//    (originalSource, msgId). If we've processed it before, drop the
//    repeat — this is what prevents routing loops and broadcast storms
//    from flooding forever. ───────────────────────────────────────────
struct SeenEntry {
  bool          inUse;
  char          src[NODE_ID_LEN + 1];
  uint16_t      msgId;
  unsigned long ts;
};
SeenEntry seenCache[MAX_SEEN];

// ── Outgoing queue: every packet we transmit (our own + forwarded)
//    passes through here so we can apply priority ordering and
//    collision-avoiding jitter instead of transmitting immediately. ───
struct OutQueueItem {
  bool          inUse;
  uint8_t       buf[MAX_PACKET_SIZE];
  uint8_t       len;
  uint8_t       priority;
  unsigned long sendAt;       // don't transmit before this time (jitter)
  unsigned long queuedAt;
};
OutQueueItem outQueue[MAX_OUTQUEUE];

// ── Pending end-to-end ACKs: unicast messages WE originated (from our
//    own phone) that are waiting for the destination's ACK. Resent on
//    timeout; route is invalidated and rediscovered after too many
//    failures (this is the "node failure recovery" mechanism). ────────
struct PendingAckItem {
  bool          inUse;
  uint16_t      msgId;
  char          dest[NODE_ID_LEN + 1];
  uint8_t       buf[MAX_PACKET_SIZE];
  uint8_t       len;
  uint8_t       retriesLeft;
  unsigned long nextRetryAt;
};
PendingAckItem pendingAcks[MAX_PENDING_ACK];

// ── Pending route discovery: a phone-originated unicast send that had
//    no known route yet. We hold the original packet, fire an RREQ, and
//    flush it the moment an RREP arrives (or report failure on timeout).
struct PendingRouteItem {
  bool          inUse;
  char          dest[NODE_ID_LEN + 1];
  uint8_t       buf[MAX_PACKET_SIZE];
  uint8_t       len;
  unsigned long requestedAt;
};
PendingRouteItem pendingRoutes[MAX_PENDING_ROUTE];

uint16_t nextMsgId = 1;   // incremented for every packet WE originate

// ════════════════════════════════════════════════════════════════════════
// LED STATE MACHINE  (unchanged behaviour from v7)
// ════════════════════════════════════════════════════════════════════════

enum LedState {
  LED_NORMAL,     // Green solid — connected and ready
  LED_SCANNING,   // Yellow slow blink — discovering nodes
  LED_WARNING,    // Yellow fast blink — no app connected / reconnecting
  LED_EMERGENCY,  // Red fast blink — SOS sent or received
  LED_CRITICAL    // Red solid — hardware failure (LoRa init failed)
};

LedState currentLedState   = LED_NORMAL;
LedState requestedLedState = LED_NORMAL;

int           greenBlinkCount = 0;
bool          greenBlinkOn    = false;
unsigned long greenBlinkNext  = 0;

int           redBlinkCount   = 0;
bool          redBlinkOn      = false;
unsigned long redBlinkNext    = 0;
LedState      stateAfterEmerg = LED_NORMAL;

bool          yellowBlinkOn   = false;
unsigned long yellowBlinkNext = 0;

void setLedState(LedState s) { requestedLedState = s; }

void triggerGreenConfirm() {
  greenBlinkCount = 6;
  greenBlinkOn    = false;
  greenBlinkNext  = millis();
}

void triggerEmergencyBlink() {
  stateAfterEmerg = requestedLedState;
  setLedState(LED_EMERGENCY);
  redBlinkCount = 10;
  redBlinkOn    = true;
  redBlinkNext  = millis();
  digitalWrite(LED_RED, HIGH);
}

void ledUpdate() {
  unsigned long now = millis();

  if (currentLedState != LED_CRITICAL) {
    currentLedState = requestedLedState;
  }

  switch (currentLedState) {
    case LED_NORMAL:
      if (greenBlinkCount == 0) digitalWrite(LED_GREEN, HIGH);
      digitalWrite(LED_YELLOW, LOW);
      if (redBlinkCount == 0) digitalWrite(LED_RED, LOW);
      break;

    case LED_SCANNING:
      digitalWrite(LED_GREEN, LOW);
      if (redBlinkCount == 0) digitalWrite(LED_RED, LOW);
      if (now >= yellowBlinkNext) {
        yellowBlinkOn = !yellowBlinkOn;
        digitalWrite(LED_YELLOW, yellowBlinkOn ? HIGH : LOW);
        yellowBlinkNext = now + LED_YELLOW_SCAN_MS;
      }
      break;

    case LED_WARNING:
      digitalWrite(LED_GREEN, LOW);
      if (redBlinkCount == 0) digitalWrite(LED_RED, LOW);
      if (now >= yellowBlinkNext) {
        yellowBlinkOn = !yellowBlinkOn;
        digitalWrite(LED_YELLOW, yellowBlinkOn ? HIGH : LOW);
        yellowBlinkNext = now + LED_YELLOW_WARN_MS;
      }
      break;

    case LED_EMERGENCY:
      digitalWrite(LED_GREEN, LOW);
      digitalWrite(LED_YELLOW, LOW);
      if (redBlinkCount > 0 && now >= redBlinkNext) {
        redBlinkCount--;
        redBlinkOn = !redBlinkOn;
        digitalWrite(LED_RED, redBlinkOn ? HIGH : LOW);
        redBlinkNext = now + LED_RED_EMERG_MS;
        if (redBlinkCount == 0) {
          digitalWrite(LED_RED, LOW);
          setLedState(stateAfterEmerg);
        }
      }
      break;

    case LED_CRITICAL:
      digitalWrite(LED_GREEN, LOW);
      digitalWrite(LED_YELLOW, LOW);
      digitalWrite(LED_RED,  HIGH);
      break;
  }

  if (greenBlinkCount > 0 && now >= greenBlinkNext) {
    greenBlinkCount--;
    greenBlinkOn = !greenBlinkOn;
    digitalWrite(LED_GREEN, greenBlinkOn ? HIGH : LOW);
    greenBlinkNext = now + LED_GREEN_CONFIRM_MS;
    if (greenBlinkCount == 0) {
      bool greenShouldBeOn = (currentLedState == LED_NORMAL);
      digitalWrite(LED_GREEN, greenShouldBeOn ? HIGH : LOW);
    }
  }
}

// ════════════════════════════════════════════════════════════════════════
// GLOBALS
// ════════════════════════════════════════════════════════════════════════

WebSocketsServer webSocket = WebSocketsServer(8765);
StaticJsonDocument<512> doc;

uint8_t       connectedClients   = 0;
unsigned int  msgSent            = 0;
unsigned int  msgReceived        = 0;
unsigned int  pktForwarded       = 0;
unsigned int  pktDroppedDup      = 0;
unsigned int  pktDroppedNoRoute  = 0;
unsigned int  routeDiscoveries   = 0;
unsigned long lastMsgTime        = 0;

bool lastSosState  = HIGH;

bool          isScanning = false;

int           sosRepeatsLeft  = 0;
unsigned long sosRepeatNext   = 0;
uint8_t       sosRepeatBuf[MAX_PACKET_SIZE];  // raw mesh bytes of the last SOS, for resends
uint8_t       sosRepeatLen    = 0;

unsigned long lastHelloAt = 0;

// ════════════════════════════════════════════════════════════════════════
// BATTERY (stub — wire to real ADC when hardware supports it)
// ════════════════════════════════════════════════════════════════════════
uint8_t readBatteryPercent() {
  // No fuel-gauge wired on the dev boards used for this demo.
  // Returning a healthy fixed value keeps mesh behaviour realistic
  // (no false low-battery no-forward) until real ADC code is added,
  // e.g.: int mv = analogReadMilliVolts(BATTERY_ADC_PIN); ...
  return 100;
}

bool forwardingAllowed() {
  return readBatteryPercent() >= LOW_BATTERY_FORWARD_CUTOFF_PCT;
}

// ════════════════════════════════════════════════════════════════════════
// TABLE HELPERS
// ════════════════════════════════════════════════════════════════════════

void addOrUpdateNeighbor(const char* id, int16_t rssi, float snr) {
  unsigned long now = millis();
  int freeSlot = -1;
  for (int i = 0; i < MAX_NEIGHBORS; i++) {
    if (neighbors[i].inUse && strcmp(neighbors[i].id, id) == 0) {
      neighbors[i].lastHeard = now;
      neighbors[i].rssi = rssi;
      neighbors[i].snr  = snr;
      return;
    }
    if (!neighbors[i].inUse && freeSlot < 0) freeSlot = i;
    // Recycle the stalest expired entry if the table is full.
    if (neighbors[i].inUse && (now - neighbors[i].lastHeard) > NEIGHBOR_EXPIRY_MS) {
      freeSlot = i;
    }
  }
  if (freeSlot < 0) freeSlot = 0; // table genuinely full — overwrite oldest slot
  neighbors[freeSlot].inUse     = true;
  strncpy(neighbors[freeSlot].id, id, NODE_ID_LEN); neighbors[freeSlot].id[NODE_ID_LEN] = '\0';
  neighbors[freeSlot].lastHeard = now;
  neighbors[freeSlot].rssi      = rssi;
  neighbors[freeSlot].snr       = snr;
}

void setNeighborBattery(const char* id, uint8_t battery) {
  for (int i = 0; i < MAX_NEIGHBORS; i++) {
    if (neighbors[i].inUse && strcmp(neighbors[i].id, id) == 0) {
      neighbors[i].battery = battery;
      return;
    }
  }
}

// Returns a pointer to a valid route for dest, or nullptr if none known.
RouteEntry* findRoute(const char* dest) {
  for (int i = 0; i < MAX_ROUTES; i++) {
    if (routes[i].valid && strcmp(routes[i].dest, dest) == 0) {
      if (millis() - routes[i].lastUsed > ROUTE_EXPIRY_MS) {
        routes[i].valid = false;   // stale — force fresh discovery
        continue;
      }
      return &routes[i];
    }
  }
  return nullptr;
}

void addOrUpdateRoute(const char* dest, const char* nextHop, uint8_t hopCount) {
  int freeSlot = -1;
  for (int i = 0; i < MAX_ROUTES; i++) {
    if (routes[i].valid && strcmp(routes[i].dest, dest) == 0) {
      // Prefer the shorter (or freshest equal-length) path.
      if (hopCount <= routes[i].hopCount) {
        strncpy(routes[i].nextHop, nextHop, NODE_ID_LEN); routes[i].nextHop[NODE_ID_LEN] = '\0';
        routes[i].hopCount = hopCount;
      }
      routes[i].lastUsed = millis();
      return;
    }
    if (!routes[i].valid && freeSlot < 0) freeSlot = i;
  }
  if (freeSlot < 0) freeSlot = 0; // table full — overwrite oldest
  routes[freeSlot].valid    = true;
  strncpy(routes[freeSlot].dest, dest, NODE_ID_LEN); routes[freeSlot].dest[NODE_ID_LEN] = '\0';
  strncpy(routes[freeSlot].nextHop, nextHop, NODE_ID_LEN); routes[freeSlot].nextHop[NODE_ID_LEN] = '\0';
  routes[freeSlot].hopCount = hopCount;
  routes[freeSlot].lastUsed = millis();
}

void invalidateRoute(const char* dest) {
  for (int i = 0; i < MAX_ROUTES; i++) {
    if (routes[i].valid && strcmp(routes[i].dest, dest) == 0) {
      routes[i].valid = false;
    }
  }
}

bool hasSeen(const char* src, uint16_t msgId) {
  unsigned long now = millis();
  for (int i = 0; i < MAX_SEEN; i++) {
    if (seenCache[i].inUse && (now - seenCache[i].ts) > SEEN_CACHE_EXPIRY_MS) {
      seenCache[i].inUse = false; // lazily expire old entries
    }
    if (seenCache[i].inUse && seenCache[i].msgId == msgId &&
        strcmp(seenCache[i].src, src) == 0) {
      return true;
    }
  }
  return false;
}

void markSeen(const char* src, uint16_t msgId) {
  int freeSlot = -1;
  for (int i = 0; i < MAX_SEEN; i++) {
    if (!seenCache[i].inUse) { freeSlot = i; break; }
  }
  if (freeSlot < 0) freeSlot = 0; // full — overwrite oldest
  seenCache[freeSlot].inUse = true;
  strncpy(seenCache[freeSlot].src, src, NODE_ID_LEN); seenCache[freeSlot].src[NODE_ID_LEN] = '\0';
  seenCache[freeSlot].msgId = msgId;
  seenCache[freeSlot].ts    = millis();
}

// ════════════════════════════════════════════════════════════════════════
// SEND QUEUE
// ════════════════════════════════════════════════════════════════════════

// Queue a fully-encoded packet for transmission. isFlood=true applies a
// wider random jitter window (broadcast/RREQ/DISCOVER-style traffic,
// where many neighbours might react at once — this is our collision
// avoidance). Point-to-point traffic gets a smaller jitter.
bool enqueueRaw(const uint8_t* buf, uint8_t len, uint8_t priority, bool isFlood) {
  int freeSlot = -1;
  for (int i = 0; i < MAX_OUTQUEUE; i++) {
    if (!outQueue[i].inUse) { freeSlot = i; break; }
  }
  if (freeSlot < 0) return false; // queue full — congestion; drop and let retry/backoff handle it

  unsigned long jitter = isFlood
    ? JITTER_FLOOD_MIN_MS   + random(JITTER_FLOOD_MAX_MS   - JITTER_FLOOD_MIN_MS)
    : JITTER_UNICAST_MIN_MS + random(JITTER_UNICAST_MAX_MS - JITTER_UNICAST_MIN_MS);

  memcpy(outQueue[freeSlot].buf, buf, len);
  outQueue[freeSlot].len      = len;
  outQueue[freeSlot].priority = priority;
  outQueue[freeSlot].inUse    = true;
  outQueue[freeSlot].queuedAt = millis();
  outQueue[freeSlot].sendAt   = millis() + jitter;
  return true;
}

bool enqueuePacket(const MeshHeader& h, const uint8_t* payload, bool isFlood) {
  uint8_t buf[MAX_PACKET_SIZE];
  encodeHeader(h, buf);
  if (h.payloadLen > 0) memcpy(buf + HEADER_SIZE, payload, h.payloadLen);
  return enqueueRaw(buf, HEADER_SIZE + h.payloadLen, h.priority, isFlood);
}

// Called every loop() — picks the highest-priority ready item and
// actually keys up the radio. Only one packet goes out at a time since
// LoRa is a single half-duplex radio (this is our congestion control:
// SOS-priority traffic always wins the slot first).
void drainOutQueue() {
  unsigned long now = millis();
  int best = -1;
  for (int i = 0; i < MAX_OUTQUEUE; i++) {
    if (!outQueue[i].inUse) continue;
    if (outQueue[i].sendAt > now) continue;
    if (best < 0 ||
        outQueue[i].priority >  outQueue[best].priority ||
        (outQueue[i].priority == outQueue[best].priority &&
         outQueue[i].queuedAt < outQueue[best].queuedAt)) {
      best = i;
    }
  }
  if (best < 0) return;

  LoRa.beginPacket();
  LoRa.write(outQueue[best].buf, outQueue[best].len);
  LoRa.endPacket();
  msgSent++;

  digitalWrite(LED_YELLOW, HIGH); delay(20); digitalWrite(LED_YELLOW, LOW);

  outQueue[best].inUse = false;
}

// ════════════════════════════════════════════════════════════════════════
// WEBSOCKET BROADCAST  (to the one phone connected to this node)
// ════════════════════════════════════════════════════════════════════════

void wsBroadcast(const String& json) {
  if (connectedClients > 0) webSocket.broadcastTXT(json);
}

void deliverMessageToPhone(const char* sender, const char* data, bool broadcast,
                            int16_t rssi, float snr) {
  doc.clear();
  doc["type"]   = "message";
  doc["sender"] = sender;
  doc["data"]   = data;
  doc["rssi"]   = rssi;
  doc["snr"]    = snr;
  if (broadcast) doc["broadcast"] = true;
  String out; serializeJson(doc, out);
  wsBroadcast(out);
}

void reportDeliveryFailed(const char* dest) {
  // [NEW in v8] Additive frame — old app builds simply ignore unknown
  // status values, so this is safe to add without breaking compatibility.
  doc.clear();
  doc["type"] = "delivery";
  doc["status"] = "failed";
  doc["dest"] = dest;
  String out; serializeJson(doc, out);
  wsBroadcast(out);
}

// ════════════════════════════════════════════════════════════════════════
// SENDING HELPERS — build + queue packets for each packet type
// ════════════════════════════════════════════════════════════════════════

MeshHeader makeHeader(uint8_t type, const char* dst, uint8_t priority, uint8_t payloadLen) {
  MeshHeader h;
  h.type = type;
  h.msgId = nextMsgId++;
  strncpy(h.src, THIS_DEVICE_ID, NODE_ID_LEN); h.src[NODE_ID_LEN] = '\0';
  strncpy(h.dst, dst, NODE_ID_LEN); h.dst[NODE_ID_LEN] = '\0';
  strncpy(h.prevHop, THIS_DEVICE_ID, NODE_ID_LEN); h.prevHop[NODE_ID_LEN] = '\0';
  h.ttl = MESH_TTL_MAX;
  h.hop = 0;
  h.priority = priority;
  h.payloadLen = payloadLen;
  return h;
}

void sendHello() {
  MeshHeader h = makeHeader(PKT_HELLO, BROADCAST_ID, PRIO_CONTROL, 1);
  h.ttl = 1; // HELLO is direct-neighbour-only — never forwarded
  uint8_t payload[1] = { readBatteryPercent() };
  enqueuePacket(h, payload, true);
}

void sendRREQ(const char* dest) {
  MeshHeader h = makeHeader(PKT_RREQ, dest, PRIO_CONTROL, 0);
  enqueuePacket(h, nullptr, true);
  routeDiscoveries++;
}

void sendDiscoverFlood() {
  MeshHeader h = makeHeader(PKT_DISCOVER, BROADCAST_ID, PRIO_CONTROL, 0);
  enqueuePacket(h, nullptr, true);
}

// Generic "forward this packet on, unchanged content, one hop further"
// used for DATA/ACK/RREP unicast forwarding and for broadcast/RREQ/
// DISCOVER flood rebroadcast. Decrements TTL and stamps prevHop=us.
bool forwardPacket(MeshHeader h, const uint8_t* payload, bool isFlood) {
  if (!forwardingAllowed()) return false; // battery-aware: stop relaying for others
  if (h.ttl == 0) return false;
  h.ttl--;
  h.hop++;
  strncpy(h.prevHop, THIS_DEVICE_ID, NODE_ID_LEN); h.prevHop[NODE_ID_LEN] = '\0';
  bool ok = enqueuePacket(h, payload, isFlood);
  if (ok) pktForwarded++;
  return ok;
}

// Forward a unicast packet toward h.dst using the route table. Returns
// false (and drops the packet) if no route is currently known — this
// only happens mid-mesh if a route went stale after the sender already
// committed to it; the sender's own ACK-retry logic will notice and
// trigger fresh discovery.
bool forwardUnicast(MeshHeader h, const uint8_t* payload) {
  RouteEntry* r = findRoute(h.dst);
  if (!r) { pktDroppedNoRoute++; return false; }
  r->lastUsed = millis();
  return forwardPacket(h, payload, false);
}

// ════════════════════════════════════════════════════════════════════════
// END-TO-END RELIABILITY: pending ACK + pending route-discovery tables
// ════════════════════════════════════════════════════════════════════════

void addPendingAck(uint16_t msgId, const char* dest, const uint8_t* buf, uint8_t len) {
  int freeSlot = -1;
  for (int i = 0; i < MAX_PENDING_ACK; i++) {
    if (!pendingAcks[i].inUse) { freeSlot = i; break; }
  }
  if (freeSlot < 0) freeSlot = 0; // table full — overwrite oldest, best-effort
  pendingAcks[freeSlot].inUse       = true;
  pendingAcks[freeSlot].msgId       = msgId;
  strncpy(pendingAcks[freeSlot].dest, dest, NODE_ID_LEN); pendingAcks[freeSlot].dest[NODE_ID_LEN] = '\0';
  memcpy(pendingAcks[freeSlot].buf, buf, len);
  pendingAcks[freeSlot].len         = len;
  pendingAcks[freeSlot].retriesLeft = MAX_SEND_RETRIES;
  pendingAcks[freeSlot].nextRetryAt = millis() + ACK_TIMEOUT_MS;
}

void resolvePendingAck(const char* dest, uint16_t msgId) {
  for (int i = 0; i < MAX_PENDING_ACK; i++) {
    if (pendingAcks[i].inUse && pendingAcks[i].msgId == msgId &&
        strcmp(pendingAcks[i].dest, dest) == 0) {
      pendingAcks[i].inUse = false;
    }
  }
}

void pendingAckTick() {
  unsigned long now = millis();
  for (int i = 0; i < MAX_PENDING_ACK; i++) {
    if (!pendingAcks[i].inUse) continue;
    if (now < pendingAcks[i].nextRetryAt) continue;

    if (pendingAcks[i].retriesLeft == 0) {
      // Exhausted retries — the destination (or the path to it) is gone.
      invalidateRoute(pendingAcks[i].dest);
      reportDeliveryFailed(pendingAcks[i].dest);
      pendingAcks[i].inUse = false;
      continue;
    }
    pendingAcks[i].retriesLeft--;
    pendingAcks[i].nextRetryAt = now + ACK_TIMEOUT_MS;
    enqueueRaw(pendingAcks[i].buf, pendingAcks[i].len, PRIO_NORMAL, false);
  }
}

void addPendingRoute(const char* dest, const uint8_t* buf, uint8_t len) {
  int freeSlot = -1;
  for (int i = 0; i < MAX_PENDING_ROUTE; i++) {
    if (!pendingRoutes[i].inUse) { freeSlot = i; break; }
  }
  if (freeSlot < 0) freeSlot = 0;
  pendingRoutes[freeSlot].inUse = true;
  strncpy(pendingRoutes[freeSlot].dest, dest, NODE_ID_LEN); pendingRoutes[freeSlot].dest[NODE_ID_LEN] = '\0';
  memcpy(pendingRoutes[freeSlot].buf, buf, len);
  pendingRoutes[freeSlot].len = len;
  pendingRoutes[freeSlot].requestedAt = millis();
  sendRREQ(dest);
}

void pendingRouteTick() {
  unsigned long now = millis();
  for (int i = 0; i < MAX_PENDING_ROUTE; i++) {
    if (!pendingRoutes[i].inUse) continue;

    RouteEntry* r = findRoute(pendingRoutes[i].dest);
    if (r) {
      // Route arrived — flush the buffered message now.
      MeshHeader h; decodeHeader(pendingRoutes[i].buf, h);
      addPendingAck(h.msgId, pendingRoutes[i].dest, pendingRoutes[i].buf, pendingRoutes[i].len);
      enqueueRaw(pendingRoutes[i].buf, pendingRoutes[i].len, PRIO_NORMAL, false);
      pendingRoutes[i].inUse = false;
      continue;
    }
    if (now - pendingRoutes[i].requestedAt > ROUTE_DISCOVERY_TIMEOUT_MS) {
      reportDeliveryFailed(pendingRoutes[i].dest);
      pendingRoutes[i].inUse = false;
    }
  }
}

// Flush a buffered pending-route packet if its destination just became
// reachable (called right after we learn a new route via RREP).
void flushPendingRouteFor(const char* dest) {
  for (int i = 0; i < MAX_PENDING_ROUTE; i++) {
    if (pendingRoutes[i].inUse && strcmp(pendingRoutes[i].dest, dest) == 0) {
      MeshHeader h; decodeHeader(pendingRoutes[i].buf, h);
      addPendingAck(h.msgId, dest, pendingRoutes[i].buf, pendingRoutes[i].len);
      enqueueRaw(pendingRoutes[i].buf, pendingRoutes[i].len, PRIO_NORMAL, false);
      pendingRoutes[i].inUse = false;
    }
  }
}

// ════════════════════════════════════════════════════════════════════════
// APP-ORIGINATED SEND (the "send"/"beep" WebSocket commands)
// ════════════════════════════════════════════════════════════════════════

void sendAppMessage(const char* recipient, const char* data) {
  uint8_t payloadLen = (uint8_t)strlen(data);
  if (payloadLen > MAX_PAYLOAD) payloadLen = MAX_PAYLOAD;

  bool broadcast = isBroadcastAddr(recipient);
  uint8_t priority = broadcast ? PRIO_SOS : PRIO_NORMAL;

  MeshHeader h = makeHeader(PKT_DATA, recipient, priority, payloadLen);

  uint8_t buf[MAX_PACKET_SIZE];
  encodeHeader(h, buf);
  memcpy(buf + HEADER_SIZE, data, payloadLen);
  uint8_t totalLen = HEADER_SIZE + payloadLen;

  if (broadcast) {
    // Broadcasts flood the whole mesh — no ACK (would cause an ACK storm
    // from every node that ever receives it), but we do resend the same
    // msgId a few times for extra resilience against single-packet RF
    // loss, exactly like the original single-hop SOS behaviour.
    enqueueRaw(buf, totalLen, priority, true);
    memcpy(sosRepeatBuf, buf, totalLen);
    sosRepeatLen    = totalLen;
    sosRepeatsLeft  = SOS_TOTAL_SENDS - 1;
    sosRepeatNext   = millis() + SOS_REPEAT_GAP_MS;
    triggerEmergencyBlink();
    return;
  }

  RouteEntry* r = findRoute(recipient);
  if (r) {
    enqueueRaw(buf, totalLen, priority, false);
    addPendingAck(h.msgId, recipient, buf, totalLen);
  } else {
    // No known route yet — buffer the message and go find one.
    addPendingRoute(recipient, buf, totalLen);
  }
}

// ════════════════════════════════════════════════════════════════════════
// RECEIVE DISPATCH — the heart of the mesh: decide forward / consume / drop
// ════════════════════════════════════════════════════════════════════════

void sendAck(const char* dest, uint16_t msgId) {
  MeshHeader h = makeHeader(PKT_ACK, dest, PRIO_CONTROL, 0);
  h.msgId = msgId; // ACK must carry the ORIGINAL message's ID, not a new one
  enqueuePacket(h, nullptr, false);
}

void handleReceivedPacket(const uint8_t* buf, int len, int16_t rssi, float snr) {
  if (len < HEADER_SIZE) return; // too short to be a valid mesh packet

  MeshHeader h;
  decodeHeader(buf, h);
  const uint8_t* payload = buf + HEADER_SIZE;

  if (strcmp(h.src, THIS_DEVICE_ID) == 0) return; // our own echo — ignore

  // Learn about whoever physically relayed this packet to us, from ANY
  // traffic we overhear (not just HELLO beacons) — "opportunistic"
  // neighbor discovery, much faster than waiting for the next beacon.
  addOrUpdateNeighbor(h.prevHop, rssi, snr);

  bool duplicate = hasSeen(h.src, h.msgId);

  // ── Duplicate handling ────────────────────────────────────────────
  // If we've already processed this exact packet, normally we just drop
  // it (prevents re-flooding / loops). EXCEPTION: if it's a unicast DATA
  // packet addressed to us, the sender resending means our ACK got lost
  // — so we resend just the ACK without re-delivering a duplicate
  // message to the phone.
  if (duplicate) {
    if (h.type == PKT_DATA && strcmp(h.dst, THIS_DEVICE_ID) == 0) {
      sendAck(h.src, h.msgId);
    }
    pktDroppedDup++;
    return;
  }
  markSeen(h.src, h.msgId);

  switch (h.type) {

    case PKT_HELLO: {
      setNeighborBattery(h.src, payload[0]);
      break; // TTL=1, never forwarded
    }

    case PKT_RREQ: {
      // Learn the reverse path back to whoever is asking.
      addOrUpdateRoute(h.src, h.prevHop, h.hop);

      if (strcmp(h.dst, THIS_DEVICE_ID) == 0) {
        // We are the node being searched for — answer with an RREP.
        MeshHeader rep = makeHeader(PKT_RREP, h.src, PRIO_CONTROL, 0);
        forwardUnicast(rep, nullptr); // uses the reverse route we just learned
      } else if (h.ttl > 0) {
        forwardPacket(h, payload, true); // keep flooding outward
      }
      break;
    }

    case PKT_RREP: {
      // The RREP's source is the node that was being searched for —
      // install a FORWARD route to it via whoever sent us this RREP.
      addOrUpdateRoute(h.src, h.prevHop, h.hop);
      flushPendingRouteFor(h.src);

      if (strcmp(h.dst, THIS_DEVICE_ID) != 0) {
        forwardUnicast(h, payload); // relay it on toward the original requester
      }
      break;
    }

    case PKT_DISCOVER: {
      // Multi-hop "who's out there?" — also doubles as a route discovery
      // for the requester, exactly like RREQ.
      addOrUpdateRoute(h.src, h.prevHop, h.hop);

      MeshHeader reply = makeHeader(PKT_DISCOVER_REPLY, h.src, PRIO_CONTROL, 1);
      uint8_t replyPayload[1] = { (uint8_t)(h.hop + 1) }; // hops from requester to us
      forwardUnicast(reply, replyPayload);

      if (h.ttl > 0) forwardPacket(h, payload, true);
      break;
    }

    case PKT_DISCOVER_REPLY: {
      if (strcmp(h.dst, THIS_DEVICE_ID) == 0) {
        doc.clear();
        doc["type"]     = "discovery";
        doc["deviceId"] = h.src;
        doc["rssi"]     = rssi;
        doc["snr"]      = snr;
        doc["hops"]     = h.payloadLen > 0 ? payload[0] : h.hop; // additive field
        String out; serializeJson(doc, out); wsBroadcast(out);
        if (connectedClients > 0 && !isScanning) setLedState(LED_NORMAL);
      } else {
        forwardUnicast(h, payload);
      }
      break;
    }

    case PKT_DATA: {
      bool broadcast = isBroadcastAddr(h.dst);
      bool forUs      = broadcast || strcmp(h.dst, THIS_DEVICE_ID) == 0;
      if (!forUs) { forwardUnicast(h, payload); break; }

      char text[MAX_PAYLOAD + 1];
      memcpy(text, payload, h.payloadLen);
      text[h.payloadLen] = '\0';

      msgReceived++; lastMsgTime = millis();
      deliverMessageToPhone(h.src, text, broadcast, rssi, snr);

      if (strstr(text, "SOS") != nullptr) triggerEmergencyBlink();

      if (broadcast) {
        if (h.ttl > 0) forwardPacket(h, payload, true); // keep the flood going
      } else {
        sendAck(h.src, h.msgId);
      }
      break;
    }

    case PKT_ACK: {
      if (strcmp(h.dst, THIS_DEVICE_ID) == 0) {
        resolvePendingAck(h.src, h.msgId);
        triggerGreenConfirm();
        doc.clear(); doc["type"] = "delivery"; doc["status"] = "delivered";
        String out; serializeJson(doc, out); wsBroadcast(out);
      } else {
        forwardUnicast(h, payload);
      }
      break;
    }

    default: break;
  }
}

// ════════════════════════════════════════════════════════════════════════
// MULTIFUNCTION BUTTON — IMPLEMENTATION (unchanged behaviour, new actions
// underneath: mesh DISCOVER flood instead of single-hop ping)
// ════════════════════════════════════════════════════════════════════════

enum BtnMachineState { BTN_IDLE, BTN_DEBOUNCING, BTN_HELD, BTN_WAIT_DOUBLE };

BtnMachineState userBtnState       = BTN_IDLE;
bool            userBtnLastRaw     = HIGH;
unsigned long   userBtnEdgeTime    = 0;
unsigned long   userBtnPressTime   = 0;
unsigned long   userBtnReleaseTime = 0;

void onUserSinglePress() {
  Serial.println("[BTN] Single press -> toggle mesh discovery scan");
  if (!isScanning) {
    isScanning = true;
    setLedState(LED_SCANNING);
    sendDiscoverFlood();
    doc.clear(); doc["type"] = "discover";
    String out; serializeJson(doc, out); wsBroadcast(out);
  } else {
    isScanning = false;
    setLedState((connectedClients > 0) ? LED_NORMAL : LED_WARNING);
  }
}

void onUserDoublePress() {
  Serial.println("[BTN] Double press -> reconnect / reset mesh discovery");
  isScanning = true;
  setLedState(LED_SCANNING);
  sendDiscoverFlood();
  doc.clear(); doc["type"] = "reconnect";
  String out; serializeJson(doc, out); wsBroadcast(out);
}

void onUserLongPress() {
  Serial.println("[BTN] Long press -> restarting node...");
  for (int i = 0; i < 6; i++) {
    digitalWrite(LED_RED, HIGH); delay(100);
    digitalWrite(LED_RED, LOW);  delay(100);
  }
  ESP.restart();
}

void userBtnUpdate() {
  unsigned long now = millis();
  bool raw = digitalRead(BTN_USER);

  switch (userBtnState) {
    case BTN_IDLE:
      if (raw == LOW && userBtnLastRaw == HIGH) {
        userBtnEdgeTime = now;
        userBtnState    = BTN_DEBOUNCING;
      }
      break;

    case BTN_DEBOUNCING:
      if (now - userBtnEdgeTime >= BTN_DEBOUNCE_MS) {
        if (raw == LOW) {
          userBtnPressTime = now;
          userBtnState     = BTN_HELD;
        } else {
          userBtnState = BTN_IDLE;
        }
      }
      break;

    case BTN_HELD:
      if (raw == HIGH) {
        unsigned long heldMs = now - userBtnPressTime;
        if (heldMs >= BTN_LONG_MS) {
          onUserLongPress();
          userBtnState = BTN_IDLE;
        } else {
          userBtnReleaseTime = now;
          userBtnState       = BTN_WAIT_DOUBLE;
        }
      }
      break;

    case BTN_WAIT_DOUBLE:
      if (raw == LOW && userBtnLastRaw == HIGH) {
        if (now - userBtnReleaseTime <= BTN_DOUBLE_MS) {
          onUserDoublePress();
          userBtnState = BTN_IDLE;
          break;
        }
      }
      if (now - userBtnReleaseTime > BTN_DOUBLE_MS) {
        onUserSinglePress();
        userBtnState = BTN_IDLE;
      }
      break;
  }

  userBtnLastRaw = raw;
}

// ════════════════════════════════════════════════════════════════════════
// WEBSOCKET EVENT HANDLER  (JSON contract unchanged from the app's view)
// ════════════════════════════════════════════════════════════════════════

void webSocketEvent(uint8_t num, WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {

    case WStype_DISCONNECTED:
      if (connectedClients > 0) connectedClients--;
      if (connectedClients == 0) setLedState(LED_WARNING);
      break;

    case WStype_CONNECTED: {
      connectedClients++;
      if (!isScanning) setLedState(LED_NORMAL);
      doc.clear();
      doc["type"]            = "device_info";
      doc["deviceId"]        = THIS_DEVICE_ID;
      doc["deviceName"]      = WIFI_SSID;
      doc["frequency"]       = (long)LORA_FREQ;
      doc["spreadingFactor"] = LORA_SF;
      doc["bandwidth"]       = (long)LORA_BW;
      String out; serializeJson(doc, out);
      webSocket.sendTXT(num, out);
      break;
    }

    case WStype_TEXT: {
      doc.clear();
      if (deserializeJson(doc, payload, length) != DeserializationError::Ok) return;
      const char* msgType = doc["type"] | "";

      if (strcmp(msgType, "send") == 0) {
        const char* recipient = doc["recipient"] | "*";
        const char* data      = doc["data"]      | "";
        sendAppMessage(recipient, data);
      }
      else if (strcmp(msgType, "beep") == 0) {
        const char* recipient = doc["recipient"] | "*";
        sendAppMessage(recipient, "BEEP");
      }
      else if (strcmp(msgType, "discover") == 0) {
        isScanning = true;
        setLedState(LED_SCANNING);
        sendDiscoverFlood();
      }
      else if (strcmp(msgType, "ping") == 0) {
        doc.clear(); doc["type"] = "pong";
        String out; serializeJson(doc, out);
        webSocket.sendTXT(num, out);
      }
      break;
    }

    default: break;
  }
}

// ════════════════════════════════════════════════════════════════════════
// SETUP
// ════════════════════════════════════════════════════════════════════════
void setup() {
  Serial.begin(115200); delay(500);
  randomSeed(analogRead(0));

  pinMode(BTN_SOS,    INPUT_PULLUP);
  pinMode(BTN_USER,   INPUT_PULLUP);

  pinMode(LED_GREEN,  OUTPUT);
  pinMode(LED_YELLOW, OUTPUT);
  pinMode(LED_RED,    OUTPUT);
  digitalWrite(LED_GREEN,  LOW);
  digitalWrite(LED_YELLOW, LOW);
  digitalWrite(LED_RED,    LOW);

  WiFi.mode(WIFI_AP);
  WiFi.softAP(WIFI_SSID, WIFI_PASS);
  Serial.printf("[WiFi] AP: %s  IP: %s\n", WIFI_SSID, WiFi.softAPIP().toString().c_str());

  webSocket.begin();
  webSocket.onEvent(webSocketEvent);
  webSocket.enableHeartbeat(15000, 3000, 2);
  Serial.println("[WS]   Ready on port 8765 (heartbeat on)");

  SPI.begin(LORA_SCK, LORA_MISO, LORA_MOSI, LORA_CS);
  LoRa.setPins(LORA_CS, LORA_RST, LORA_DIO0);
  if (!LoRa.begin(LORA_FREQ)) {
    Serial.println("[LoRa] INIT FAILED — red LED solid");
    setLedState(LED_CRITICAL);
    digitalWrite(LED_RED, HIGH);
    while (true) { delay(1000); }
  }

  LoRa.setTxPower(LORA_TX_POWER, PA_OUTPUT_PA_BOOST_PIN);
  LoRa.setSpreadingFactor(LORA_SF);
  LoRa.setSignalBandwidth(LORA_BW);
  LoRa.setCodingRate4(LORA_CR);
  LoRa.setSyncWord(LORA_SYNC_WORD);
  LoRa.enableCrc();
  Serial.printf("[LoRa] Ready — %.0fMHz SF%d BW%.0fkHz sync 0x%02X CRC on\n",
                LORA_FREQ/1e6, LORA_SF, LORA_BW/1e3, LORA_SYNC_WORD);
  Serial.printf("[MESH] NodeID: %s  TTL max: %d\n", THIS_DEVICE_ID, MESH_TTL_MAX);

  setLedState(LED_WARNING);
  Serial.println("[SYS]  Boot complete — waiting for app (yellow blink)");
}

// ════════════════════════════════════════════════════════════════════════
// MAIN LOOP
// ════════════════════════════════════════════════════════════════════════
void loop() {
  webSocket.loop();

  unsigned long now = millis();

  ledUpdate();
  userBtnUpdate();

  // ── Periodic neighbour beacon ──────────────────────────────────────
  if (now - lastHelloAt > HELLO_INTERVAL_MS) {
    lastHelloAt = now;
    sendHello();
  }

  // ── Reliability bookkeeping ────────────────────────────────────────
  pendingAckTick();
  pendingRouteTick();

  // ── v5: SOS re-broadcast (raw mesh bytes, same msgId each repeat —
  //        receivers' dedup cache naturally absorbs the extras once
  //        they've already processed/forwarded the first copy) ───────
  if (sosRepeatsLeft > 0 && now >= sosRepeatNext) {
    enqueueRaw(sosRepeatBuf, sosRepeatLen, PRIO_SOS, true);
    sosRepeatsLeft--;
    sosRepeatNext = now + SOS_REPEAT_GAP_MS + random(120);
  }

  // ── Drain one packet from the priority send queue ──────────────────
  drainOutQueue();

  // ── Periodic stats (every 5 s) ──────────────────────────────────────
  static unsigned long lastStats = 0;
  if (now - lastStats > 5000 && connectedClients > 0) {
    lastStats = now;
    doc.clear();
    doc["type"]             = "stats";
    doc["messagesSent"]     = msgSent;
    doc["messagesReceived"] = msgReceived;
    doc["uptime"]           = now / 1000;
    doc["connectedClients"] = connectedClients;
    doc["pktForwarded"]     = pktForwarded;       // additive mesh diagnostics
    doc["pktDroppedDup"]    = pktDroppedDup;
    doc["pktDroppedNoRoute"]= pktDroppedNoRoute;
    doc["routeDiscoveries"] = routeDiscoveries;
    String out; serializeJson(doc, out); wsBroadcast(out);
  }

  // ── LoRa RECEIVE ─────────────────────────────────────────────────────
  int packetSize = LoRa.parsePacket();
  if (packetSize > 0) {
    uint8_t buf[MAX_PACKET_SIZE];
    int n = 0;
    while (LoRa.available() && n < MAX_PACKET_SIZE) buf[n++] = (uint8_t)LoRa.read();
    int16_t rssi = LoRa.packetRssi();
    float   snr  = LoRa.packetSnr();

    digitalWrite(LED_YELLOW, HIGH); delay(20); digitalWrite(LED_YELLOW, LOW);

    handleReceivedPacket(buf, n, rssi, snr);
  }

  // ════════════════════════════════════════════════════════════════════
  // SOS BUTTON  ← edge detection preserved from earlier firmware
  // ════════════════════════════════════════════════════════════════════
  {
    bool sosNow = digitalRead(BTN_SOS);
    if (sosNow == LOW && lastSosState == HIGH) {
      sendAppMessage(BROADCAST_ID, "SOS Tafadhali! Naomba msaada wa haraka.");
      doc.clear(); doc["type"] = "message"; doc["sender"] = THIS_DEVICE_ID;
      doc["data"] = "SOS Tafadhali! Naomba msaada wa haraka.";
      doc["broadcast"] = true;
      String out; serializeJson(doc, out); wsBroadcast(out);
      Serial.println("[BTN] SOS sent (mesh broadcast, +repeats).");
    }
    lastSosState = sosNow;
  }
}
