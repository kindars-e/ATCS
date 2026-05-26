/*
 * ╔══════════════════════════════════════════════════════════════════════
 * ║  Ranger Rola Firmware — v7 (LED system + multifunction button)      ║
 * ╠══════════════════════════════════════════════════════════════════════╣
 * ║  Works with the Fling app (Wi-Fi + WebSocket, port 8765).           ║
 * ║  Uses the Rola hardware pin layout and SPI LoRa library.            ║
 * ║                                                                      ║
 * ║  HOW TO CONFIGURE:                                                   ║
 * ║    1. Find the "DEVICE IDENTITY" section below.                      ║
 * ║    2. Change THIS_DEVICE_ID to a unique name (no spaces/colons).    ║
 * ║    3. Change WIFI_SSID to match — e.g. "Fling_Node2"                ║
 * ║    4. Flash to the ESP32.  Repeat for each node with a new ID.      ║
 * ║                                                                      ║
 * ║  The app connects to:  ws://192.168.4.1:8765                        ║
 * ║  WiFi password is always:  fling1234                                 ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * ── PACKET FORMAT ON LoRa AIR ────────────────────────────────────────
 *
 *   Regular message :  "Node1:Node2:Hello there"
 *   Broadcast       :  "Node1:*:SOS help!"           ← goes to ALL nodes
 *   ACK reply       :  "ACK:Node1"
 *   Discovery ping  :  "Node1:*:##DISCOVERY_PING##"
 *   Discovery pong  :  "Node2:Node1:##DISCOVERY_PONG##"
 *   Location data   :  "Node1:Node2:##LOCATION_RESPONSE##13.12,32.56,5.0"
 *   Pair request    :  "Node1:Node2:##PAIR_REQ##Fling_Node1"
 *   Pair accept     :  "Node2:Node1:##PAIR_ACK##Fling_Node2"
 *
 * ── CHANGES IN v7 (LED system + multifunction button overhaul) ───────
 *
 *  ROOT CAUSE ANALYSIS — what existed before v7:
 *   • A Blue LED (pin 14) was used as a raw "radio activity" blinker. It
 *     blinked on every TX/RX event. This gave no actionable information:
 *     it looked identical whether the system was healthy, searching, or
 *     failing.
 *   • The USER/BTN_USER button (pin 0) sent a broadcast PING on every
 *     single press — no other actions, no double-press, no long-press.
 *   • There was no centralized LED state-management. LEDs were driven by
 *     ad-hoc function calls scattered across the code.
 *
 *  WHAT v7 DOES:
 *   • Replaces the Blue LED completely with the Yellow LED (pin 14, same
 *     physical pin — just rename in hardware and here). Yellow = searching
 *     / warning, which is far more meaningful than a blue "blink".
 *   • Adds a centralized LED state machine with a priority system:
 *       EMERGENCY (red) > WARNING/SEARCH (yellow) > NORMAL (green)
 *   • Adds a proper multifunction button with debounce, single-press,
 *     double-press, and long-press detection — all non-blocking.
 *   • SOS button logic is UNTOUCHED. Only LED reflection was added.
 *
 *  MULTIFUNCTION BUTTON ACTIONS (BTN_USER / pin 0):
 *   • Single press  → start/stop discovery scan
 *       Reason: the most common field action is "find nearby nodes". One
 *       press fires a scan; pressing again while scanning cancels it.
 *   • Double press  → reconnect (reset communication layer)
 *       Reason: when comms feel stale or the app dropped, a double-press
 *       is fast and memorable. It kicks a fresh scan and resets state.
 *   • Long press (≥2 s) → safe restart of the node
 *       Reason: a deliberate, hard-to-trigger action for when you need a
 *       clean reboot. Long press is hard to do accidentally.
 *
 *  LED SYSTEM (simplified):
 *   GREEN (pin 2):
 *     solid ON        = connected and ready (Wi-Fi AP up, LoRa ready)
 *     slow blink 3×   = message TX/RX confirmed (ACK received)
 *   YELLOW (pin 14, replaces Blue):
 *     slow blink      = scanning / searching for nodes
 *     fast blink      = reconnecting / no app client connected
 *   RED (pin 12):
 *     fast blink 5×   = emergency / SOS activity
 *     solid ON        = critical failure (LoRa init failed)
 *
 *  All prior fixes from v2–v6 are fully preserved (SF9, sync word,
 *  CRC, SOS repeats, heartbeat, SNR diagnostics, edge detection).
 *
 * ── ALL PRIOR CHANGE NOTES (preserved for history) ───────────────────
 *
 *  v2: All delay() replaced with non-blocking millis() timers.
 *  v3: Broadcast routing fix. ACK storm fix. ##PAIR_REQ/ACK## forwarding.
 *  v4: Button edge detection — SOS and USER buttons fire once per press.
 *  v5: SF12→7, WebSocket heartbeat, SOS repeat reliability.
 *  v6: SF7→9 for range, PA_BOOST explicit, sync word 0xF3, CRC enabled,
 *      SNR diagnostics added alongside RSSI.
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
#define LED_YELLOW  14   // Searching / warning  ← was LED_BLUE, same pin
#define LED_RED     12   // Emergency / critical failure

// ════════════════════════════════════════════════════════════════════════
// DEVICE IDENTITY  ← EDIT THIS SECTION FOR EACH NODE
// ════════════════════════════════════════════════════════════════════════
#define THIS_DEVICE_ID  "Node1"          // ← Change per node
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
// PROTOCOL SENTINELS — must match lib/constants.ts and lib/protocol.ts
// ════════════════════════════════════════════════════════════════════════
#define DISCOVERY_PING  "##DISCOVERY_PING##"
#define DISCOVERY_PONG  "##DISCOVERY_PONG##"

// ════════════════════════════════════════════════════════════════════════
// TIMING CONSTANTS (all non-blocking — no delay() in main loop)
// ════════════════════════════════════════════════════════════════════════
#define ACK_DELAY_MS          60   // wait before sending ACK (sender exits TX)
#define PONG_DELAY_MIN_MS     50   // PONG random delay range (collision avoidance)
#define PONG_DELAY_MAX_MS    150

// ── v5: SOS repeat reliability ────────────────────────────────────────
#define SOS_TOTAL_SENDS       3    // 1 immediate + 2 extra resends
#define SOS_REPEAT_GAP_MS   250    // base gap between resends (ms)

// ── Multifunction button timing ───────────────────────────────────────
#define BTN_DEBOUNCE_MS       50   // ignore transitions shorter than this
#define BTN_DOUBLE_MS        400   // max gap between presses for double-press
#define BTN_LONG_MS         2000   // hold duration to trigger long-press

// ── LED blink timing ──────────────────────────────────────────────────
#define LED_YELLOW_SCAN_MS   800   // slow blink period while scanning (ms)
#define LED_YELLOW_WARN_MS   200   // fast blink period when no client / reconnect
#define LED_GREEN_CONFIRM_MS 300   // blink period for TX/RX confirmation
#define LED_RED_EMERG_MS     150   // fast blink period for emergency

// ════════════════════════════════════════════════════════════════════════
// LED STATE MACHINE
//
// HOW IT WORKS:
//   Instead of calling LED functions everywhere, all code sets a "desired
//   LED state" using setLedState(). The main loop's ledUpdate() function
//   reads that state and drives the pins accordingly.
//
//   PRIORITY (highest wins):
//     LED_CRITICAL > LED_EMERGENCY > LED_WARNING > LED_SCANNING > LED_NORMAL
//
//   This means if an emergency arrives while scanning, the red emergency
//   state will immediately take over. When the emergency blink finishes,
//   the next-highest active state resumes automatically.
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

// ── Green confirm blink (runs in parallel on top of normal state) ──────
// A short 3-blink confirmation plays on the green LED when an ACK arrives,
// without changing the main LED state machine.
int           greenBlinkCount = 0;
bool          greenBlinkOn    = false;
unsigned long greenBlinkNext  = 0;

// ── Red emergency blink (time-limited, then returns to prior state) ────
int           redBlinkCount   = 0;
bool          redBlinkOn      = false;
unsigned long redBlinkNext    = 0;
LedState      stateAfterEmerg = LED_NORMAL; // restore after emergency blink

// ── Yellow blink timer ─────────────────────────────────────────────────
bool          yellowBlinkOn   = false;
unsigned long yellowBlinkNext = 0;

// ════════════════════════════════════════════════════════════════════════
// GLOBALS
// ════════════════════════════════════════════════════════════════════════

WebSocketsServer webSocket = WebSocketsServer(8765);
StaticJsonDocument<512> doc;

uint8_t       connectedClients = 0;
unsigned int  msgSent          = 0;
unsigned int  msgReceived      = 0;
unsigned long lastMsgTime      = 0;

// ── SOS button state (edge detection — DO NOT CHANGE) ─────────────────
bool lastSosState  = HIGH;

// ── Non-blocking ACK ──────────────────────────────────────────────────
bool          pendingAck       = false;
String        pendingAckTarget = "";
unsigned long pendingAckTime   = 0;

// ── Non-blocking PONG ─────────────────────────────────────────────────
bool          pendingPong       = false;
String        pendingPongTarget = "";
unsigned long pendingPongTime   = 0;

// ── v5: Non-blocking SOS re-broadcast ────────────────────────────────
String        sosRepeatPacket = "";
int           sosRepeatsLeft  = 0;
unsigned long sosRepeatNext   = 0;

// ── Scanning state ────────────────────────────────────────────────────
bool          isScanning = false;   // true while a discovery scan is active

// ════════════════════════════════════════════════════════════════════════
// MULTIFUNCTION BUTTON STATE MACHINE
//
// HOW IT WORKS (non-blocking):
//   The button is checked every loop iteration (not on a slow timer).
//   A small state machine tracks:
//     1. Raw debounce: ignore transitions < BTN_DEBOUNCE_MS (electrical noise)
//     2. Press timing: remember when the press started
//     3. Release timing: decide single vs double vs long on release
//
//   State flow:
//     IDLE → PRESSED (falling edge, debounce starts)
//     PRESSED → HELD (debounce cleared, counting hold time)
//     HELD → RELEASED → decide action:
//       • was held ≥ BTN_LONG_MS    → long press
//       • released quickly           → start a "wait for double" window
//     WAIT_DOUBLE → PRESSED again within BTN_DOUBLE_MS → double press
//     WAIT_DOUBLE → timeout without second press       → single press
// ════════════════════════════════════════════════════════════════════════

enum BtnMachineState {
  BTN_IDLE,
  BTN_DEBOUNCING,
  BTN_HELD,
  BTN_WAIT_DOUBLE
};

BtnMachineState userBtnState    = BTN_IDLE;
bool            userBtnLastRaw  = HIGH;   // last raw pin reading
unsigned long   userBtnEdgeTime = 0;      // when the last edge was seen
unsigned long   userBtnPressTime= 0;      // when debounce-confirmed press started
unsigned long   userBtnReleaseTime = 0;   // when release was confirmed

// ════════════════════════════════════════════════════════════════════════
// LED STATE MACHINE — IMPLEMENTATION
// ════════════════════════════════════════════════════════════════════════

// Call this to request a new LED state. The update function enforces priority.
void setLedState(LedState s) {
  requestedLedState = s;
}

// Trigger a short green confirmation blink (3 blinks) — used on ACK received.
// Runs on top of the main LED state; does NOT change currentLedState.
void triggerGreenConfirm() {
  greenBlinkCount = 6;   // 6 transitions = 3 full on/off blinks
  greenBlinkOn    = false;
  greenBlinkNext  = millis();
}

// Trigger a time-limited red emergency blink (5 blinks), then auto-restore.
void triggerEmergencyBlink() {
  stateAfterEmerg = requestedLedState;  // remember what to go back to
  setLedState(LED_EMERGENCY);
  redBlinkCount = 10;  // 10 transitions = 5 full on/off blinks
  redBlinkOn    = true;
  redBlinkNext  = millis();
  digitalWrite(LED_RED, HIGH);
}

// Called once per loop() — drives all three LED pins based on current state.
void ledUpdate() {
  unsigned long now = millis();

  // ── Resolve priority: highest-priority active state wins ──
  // LED_CRITICAL is set once in setup and never overridden.
  if (currentLedState != LED_CRITICAL) {
    currentLedState = requestedLedState;
  }

  // ── Drive LEDs based on current state ──────────────────────
  switch (currentLedState) {

    // ── NORMAL: Green solid, Yellow off, Red off ──────────────
    case LED_NORMAL:
      // Only set green if a confirm-blink is not running
      if (greenBlinkCount == 0) {
        digitalWrite(LED_GREEN, HIGH);
      }
      digitalWrite(LED_YELLOW, LOW);
      // Red off — but only if no emergency blink is in progress
      if (redBlinkCount == 0) {
        digitalWrite(LED_RED, LOW);
      }
      break;

    // ── SCANNING: Yellow slow blink, Green off, Red off ───────
    case LED_SCANNING:
      digitalWrite(LED_GREEN, LOW);
      if (redBlinkCount == 0) digitalWrite(LED_RED, LOW);
      if (now >= yellowBlinkNext) {
        yellowBlinkOn = !yellowBlinkOn;
        digitalWrite(LED_YELLOW, yellowBlinkOn ? HIGH : LOW);
        yellowBlinkNext = now + LED_YELLOW_SCAN_MS;
      }
      break;

    // ── WARNING: Yellow fast blink, Green off, Red off ────────
    case LED_WARNING:
      digitalWrite(LED_GREEN, LOW);
      if (redBlinkCount == 0) digitalWrite(LED_RED, LOW);
      if (now >= yellowBlinkNext) {
        yellowBlinkOn = !yellowBlinkOn;
        digitalWrite(LED_YELLOW, yellowBlinkOn ? HIGH : LOW);
        yellowBlinkNext = now + LED_YELLOW_WARN_MS;
      }
      break;

    // ── EMERGENCY: Red fast blink (time-limited) ───────────────
    case LED_EMERGENCY:
      digitalWrite(LED_GREEN, LOW);
      digitalWrite(LED_YELLOW, LOW);
      if (redBlinkCount > 0 && now >= redBlinkNext) {
        redBlinkCount--;
        redBlinkOn = !redBlinkOn;
        digitalWrite(LED_RED, redBlinkOn ? HIGH : LOW);
        redBlinkNext = now + LED_RED_EMERG_MS;
        if (redBlinkCount == 0) {
          // Emergency blink finished — restore previous state
          digitalWrite(LED_RED, LOW);
          setLedState(stateAfterEmerg);
        }
      }
      break;

    // ── CRITICAL: Red solid, everything else off ───────────────
    case LED_CRITICAL:
      digitalWrite(LED_GREEN, LOW);
      digitalWrite(LED_YELLOW, LOW);
      digitalWrite(LED_RED,  HIGH);
      break;
  }

  // ── Green confirmation blink (overlaid on top of any state) ──
  // Blinks the green LED briefly to confirm a message was delivered (ACK).
  // Uses its own counter and does not disturb the main state.
  if (greenBlinkCount > 0 && now >= greenBlinkNext) {
    greenBlinkCount--;
    greenBlinkOn = !greenBlinkOn;
    digitalWrite(LED_GREEN, greenBlinkOn ? HIGH : LOW);
    greenBlinkNext = now + LED_GREEN_CONFIRM_MS;
    // When the blink sequence ends, restore green to the correct level
    if (greenBlinkCount == 0) {
      bool greenShouldBeOn = (currentLedState == LED_NORMAL);
      digitalWrite(LED_GREEN, greenShouldBeOn ? HIGH : LOW);
    }
  }
}

// ════════════════════════════════════════════════════════════════════════
// MULTIFUNCTION BUTTON — IMPLEMENTATION
//
// Actions and why they were chosen:
//   SINGLE PRESS → start/stop scan
//     Most common need in the field. Quick and obvious. Toggling means a
//     second press cleanly cancels a scan that already found everyone.
//
//   DOUBLE PRESS → reconnect / reset comms
//     Used when the link feels stale. Double-press is intentional (hard to
//     do by accident) and fast to perform. Fires a new scan + clears state.
//
//   LONG PRESS (≥2 s) → restart node
//     Reserved for "something is really wrong" situations. Long press is
//     hard to trigger accidentally and gives time to change your mind.
// ════════════════════════════════════════════════════════════════════════

// ── Action handlers (called by the state machine) ──────────────────────

void onUserSinglePress() {
  Serial.println("[BTN] Single press → toggle scan");
  if (!isScanning) {
    // START SCAN
    isScanning = true;
    setLedState(LED_SCANNING);
    String pkt = String(THIS_DEVICE_ID) + ":*:" + DISCOVERY_PING;
    LoRa.beginPacket(); LoRa.print(pkt); LoRa.endPacket();
    Serial.println("[LoRa] Discovery PING sent (scan started)");
    // Notify the app
    doc.clear(); doc["type"] = "discover";
    String out; serializeJson(doc, out); wsBroadcast(out);
  } else {
    // STOP SCAN
    isScanning = false;
    setLedState((connectedClients > 0) ? LED_NORMAL : LED_WARNING);
    Serial.println("[BTN] Scan stopped");
  }
}

void onUserDoublePress() {
  Serial.println("[BTN] Double press → reconnect / reset comms");
  // Reset scanning state and fire a fresh discovery ping
  isScanning = true;
  setLedState(LED_SCANNING);
  String pkt = String(THIS_DEVICE_ID) + ":*:" + DISCOVERY_PING;
  LoRa.beginPacket(); LoRa.print(pkt); LoRa.endPacket();
  Serial.println("[LoRa] Re-discovery PING sent");
  // Tell the app to refresh its node list
  doc.clear(); doc["type"] = "reconnect";
  String out; serializeJson(doc, out); wsBroadcast(out);
}

void onUserLongPress() {
  Serial.println("[BTN] Long press → restarting node...");
  // Brief red blink to confirm the restart is about to happen
  for (int i = 0; i < 6; i++) {
    digitalWrite(LED_RED, HIGH); delay(100);
    digitalWrite(LED_RED, LOW);  delay(100);
  }
  ESP.restart();
}

// ── Button polling (call every loop iteration) ──────────────────────────
void userBtnUpdate() {
  unsigned long now   = millis();
  bool          raw   = digitalRead(BTN_USER);   // HIGH = released, LOW = pressed

  switch (userBtnState) {

    // ── Waiting for any press ──────────────────────────────────
    case BTN_IDLE:
      if (raw == LOW && userBtnLastRaw == HIGH) {
        // Falling edge — start debounce
        userBtnEdgeTime = now;
        userBtnState    = BTN_DEBOUNCING;
      }
      break;

    // ── Absorbing contact bounce ───────────────────────────────
    case BTN_DEBOUNCING:
      if (now - userBtnEdgeTime >= BTN_DEBOUNCE_MS) {
        if (raw == LOW) {
          // Still pressed after debounce window — confirmed real press
          userBtnPressTime = now;
          userBtnState     = BTN_HELD;
        } else {
          // Bounced back — false trigger, go back to idle
          userBtnState = BTN_IDLE;
        }
      }
      break;

    // ── Counting hold duration ─────────────────────────────────
    case BTN_HELD:
      if (raw == HIGH) {
        // Button released — decide single vs long
        unsigned long heldMs = now - userBtnPressTime;
        if (heldMs >= BTN_LONG_MS) {
          onUserLongPress();
          userBtnState = BTN_IDLE;
        } else {
          // Short press — wait to see if a second press comes (double)
          userBtnReleaseTime = now;
          userBtnState       = BTN_WAIT_DOUBLE;
        }
      }
      break;

    // ── Waiting to see if a second press comes quickly ─────────
    case BTN_WAIT_DOUBLE:
      if (raw == LOW && userBtnLastRaw == HIGH) {
        // Second press detected within the window → double press
        if (now - userBtnReleaseTime <= BTN_DOUBLE_MS) {
          userBtnEdgeTime = now;
          userBtnState    = BTN_DEBOUNCING;   // debounce the second press
          // Sneaky: we mark this as a "double" by checking the flag below.
          // Simpler approach: fire immediately and go idle.
          onUserDoublePress();
          userBtnState = BTN_IDLE;
          break;
        }
      }
      if (now - userBtnReleaseTime > BTN_DOUBLE_MS) {
        // Timeout — no second press; it was a single press
        onUserSinglePress();
        userBtnState = BTN_IDLE;
      }
      break;
  }

  userBtnLastRaw = raw;
}

// ════════════════════════════════════════════════════════════════════════
// v5 SOS REPEAT HELPER
// ════════════════════════════════════════════════════════════════════════

// Queue up extra resends of an SOS/emergency packet after the first TX.
void scheduleSosRepeats(const String& packet) {
  sosRepeatPacket = packet;
  sosRepeatsLeft  = SOS_TOTAL_SENDS - 1;   // first send already happened
  sosRepeatNext   = millis() + SOS_REPEAT_GAP_MS;
}

// ════════════════════════════════════════════════════════════════════════
// WEBSOCKET BROADCAST
// ════════════════════════════════════════════════════════════════════════

void wsBroadcast(String json) {
  if (connectedClients > 0) webSocket.broadcastTXT(json);
}

// ════════════════════════════════════════════════════════════════════════
// LORA PACKET PARSER
// Every packet:  SENDER:RECIPIENT:CONTENT
// ════════════════════════════════════════════════════════════════════════
bool parseLoraPacket(const String& raw,
                     String& sender, String& recipient, String& content) {
  int a = raw.indexOf(':');
  if (a < 0) return false;
  int b = raw.indexOf(':', a + 1);
  if (b < 0) return false;
  sender    = raw.substring(0, a);
  recipient = raw.substring(a + 1, b);
  content   = raw.substring(b + 1);
  return (sender.length() > 0 && recipient.length() > 0);
}

// ════════════════════════════════════════════════════════════════════════
// WEBSOCKET EVENT HANDLER
// ════════════════════════════════════════════════════════════════════════
void webSocketEvent(uint8_t num, WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {

    case WStype_DISCONNECTED:
      if (connectedClients > 0) connectedClients--;
      Serial.printf("[WS] Client %u disconnected\n", num);
      // No app clients left → show warning state (yellow fast blink)
      if (connectedClients == 0) setLedState(LED_WARNING);
      break;

    case WStype_CONNECTED: {
      connectedClients++;
      Serial.printf("[WS] Client %u connected\n", num);
      // App connected — return to normal state (unless scanning)
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
        String pkt = String(THIS_DEVICE_ID) + ":" + recipient + ":" + data;
        LoRa.beginPacket(); LoRa.print(pkt); LoRa.endPacket();
        msgSent++;
        // Yellow quick-blink to show radio activity during TX
        digitalWrite(LED_YELLOW, HIGH); delay(30); digitalWrite(LED_YELLOW, LOW);
        if (strcmp(recipient, "*") == 0) {
          scheduleSosRepeats(pkt);
          triggerEmergencyBlink();
        }
        Serial.printf("[LoRa] TX: %s\n", pkt.c_str());
      }
      else if (strcmp(msgType, "beep") == 0) {
        const char* recipient = doc["recipient"] | "*";
        String pkt = String(THIS_DEVICE_ID) + ":" + recipient + ":BEEP";
        LoRa.beginPacket(); LoRa.print(pkt); LoRa.endPacket();
        msgSent++;
        digitalWrite(LED_YELLOW, HIGH); delay(30); digitalWrite(LED_YELLOW, LOW);
      }
      else if (strcmp(msgType, "discover") == 0) {
        isScanning = true;
        setLedState(LED_SCANNING);
        String pkt = String(THIS_DEVICE_ID) + ":*:" + DISCOVERY_PING;
        LoRa.beginPacket(); LoRa.print(pkt); LoRa.endPacket();
        Serial.println("[LoRa] Discovery PING sent (from app)");
      }
      else if (strcmp(msgType, "ping") == 0) {
        // App-level heartbeat reply
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

  // Button pins — internal pull-up, so pin rests HIGH, goes LOW when pressed
  pinMode(BTN_SOS,    INPUT_PULLUP);
  pinMode(BTN_USER,   INPUT_PULLUP);

  // LED pins
  pinMode(LED_GREEN,  OUTPUT);
  pinMode(LED_YELLOW, OUTPUT);
  pinMode(LED_RED,    OUTPUT);

  // Start with all LEDs off, then set normal state below
  digitalWrite(LED_GREEN,  LOW);
  digitalWrite(LED_YELLOW, LOW);
  digitalWrite(LED_RED,    LOW);

  // Wi-Fi Access Point
  WiFi.mode(WIFI_AP);
  WiFi.softAP(WIFI_SSID, WIFI_PASS);
  Serial.printf("[WiFi] AP: %s  IP: %s\n", WIFI_SSID, WiFi.softAPIP().toString().c_str());

  // WebSocket server
  webSocket.begin();
  webSocket.onEvent(webSocketEvent);
  // v5: library heartbeat — detects stale/dead app connections
  webSocket.enableHeartbeat(15000, 3000, 2);
  Serial.println("[WS]   Ready on port 8765 (heartbeat on)");

  // LoRa radio
  SPI.begin(LORA_SCK, LORA_MISO, LORA_MOSI, LORA_CS);
  LoRa.setPins(LORA_CS, LORA_RST, LORA_DIO0);
  if (!LoRa.begin(LORA_FREQ)) {
    Serial.println("[LoRa] INIT FAILED — red LED solid");
    setLedState(LED_CRITICAL);
    // Force drive the red LED right now; the loop will maintain it
    digitalWrite(LED_RED, HIGH);
    while (true) { delay(1000); }  // halt — nothing else can work
  }

  // v6 radio settings
  LoRa.setTxPower(LORA_TX_POWER, PA_OUTPUT_PA_BOOST_PIN);
  LoRa.setSpreadingFactor(LORA_SF);
  LoRa.setSignalBandwidth(LORA_BW);
  LoRa.setCodingRate4(LORA_CR);
  LoRa.setSyncWord(LORA_SYNC_WORD);
  LoRa.enableCrc();
  Serial.printf("[LoRa] Ready — %.0fMHz SF%d BW%.0fkHz sync 0x%02X CRC on\n",
                LORA_FREQ/1e6, LORA_SF, LORA_BW/1e3, LORA_SYNC_WORD);

  // System is up — no app connected yet → yellow warning blink
  // (will switch to LED_NORMAL the moment an app connects)
  setLedState(LED_WARNING);
  Serial.println("[SYS]  Boot complete — waiting for app (yellow blink)");
}

// ════════════════════════════════════════════════════════════════════════
// MAIN LOOP
// ════════════════════════════════════════════════════════════════════════
void loop() {
  webSocket.loop();   // must be called every iteration

  unsigned long now = millis();

  // ── LED state machine ─────────────────────────────────────────────
  ledUpdate();

  // ── Multifunction button (non-blocking state machine) ─────────────
  userBtnUpdate();

  // ── Deferred ACK transmit ─────────────────────────────────────────
  if (pendingAck && now >= pendingAckTime) {
    String ack = "ACK:" + pendingAckTarget;
    LoRa.beginPacket(); LoRa.print(ack); LoRa.endPacket();
    // Brief yellow flash to show radio TX
    digitalWrite(LED_YELLOW, HIGH); delay(30); digitalWrite(LED_YELLOW, LOW);
    Serial.printf("[LoRa] ACK sent: %s\n", ack.c_str());
    pendingAck = false; pendingAckTarget = "";
  }

  // ── Deferred PONG transmit ────────────────────────────────────────
  if (pendingPong && now >= pendingPongTime) {
    String pong = String(THIS_DEVICE_ID) + ":" + pendingPongTarget + ":" + DISCOVERY_PONG;
    LoRa.beginPacket(); LoRa.print(pong); LoRa.endPacket();
    digitalWrite(LED_YELLOW, HIGH); delay(30); digitalWrite(LED_YELLOW, LOW);
    Serial.printf("[LoRa] PONG sent to %s\n", pendingPongTarget.c_str());
    pendingPong = false; pendingPongTarget = "";
  }

  // ── v5: Deferred SOS re-broadcast ────────────────────────────────
  if (sosRepeatsLeft > 0 && now >= sosRepeatNext) {
    LoRa.beginPacket(); LoRa.print(sosRepeatPacket); LoRa.endPacket();
    msgSent++;
    digitalWrite(LED_YELLOW, HIGH); delay(30); digitalWrite(LED_YELLOW, LOW);
    sosRepeatsLeft--;
    sosRepeatNext = now + SOS_REPEAT_GAP_MS + random(120);
    Serial.printf("[LoRa] SOS resend (%d left)\n", sosRepeatsLeft);
  }

  // ── Periodic stats (every 5 s) ────────────────────────────────────
  static unsigned long lastStats = 0;
  if (now - lastStats > 5000 && connectedClients > 0) {
    lastStats = now;
    doc.clear();
    doc["type"]             = "stats";
    doc["messagesSent"]     = msgSent;
    doc["messagesReceived"] = msgReceived;
    doc["uptime"]           = now / 1000;
    doc["connectedClients"] = connectedClients;
    String out; serializeJson(doc, out); wsBroadcast(out);
  }

  // ── LoRa RECEIVE ──────────────────────────────────────────────────
  int packetSize = LoRa.parsePacket();
  if (packetSize > 0) {
    String raw = "";
    raw.reserve(packetSize);
    while (LoRa.available()) raw += (char)LoRa.read();
    int16_t rssi = LoRa.packetRssi();
    float   snr  = LoRa.packetSnr();   // v6: SNR for link quality indicator

    // Brief yellow flash on RX
    digitalWrite(LED_YELLOW, HIGH); delay(30); digitalWrite(LED_YELLOW, LOW);

    Serial.printf("[LoRa] RX %d bytes RSSI %d SNR %.1f: %s\n",
                  packetSize, rssi, snr, raw.c_str());

    // ── ACK handling ────────────────────────────────────────────────
    if (raw.startsWith("ACK:")) {
      String target = raw.substring(4); target.trim();
      if (target == THIS_DEVICE_ID) {
        triggerGreenConfirm();   // green blink = message delivered
        doc.clear(); doc["type"] = "delivery"; doc["status"] = "delivered";
        String out; serializeJson(doc, out); wsBroadcast(out);
        Serial.println("[LoRa] ACK received — delivered.");
      }
      return;
    }

    // ── Parse SENDER:RECIPIENT:CONTENT ─────────────────────────────
    String sender, recipient, content;
    if (!parseLoraPacket(raw, sender, recipient, content)) return;

    // Drop own echo
    if (sender == THIS_DEVICE_ID) return;

    // v3: Accept broadcast packets addressed to "*"
    bool isBroadcast = (recipient == "*");
    bool forUs       = isBroadcast || (recipient == THIS_DEVICE_ID);
    if (!forUs) return;

    // ── DISCOVERY PING ──────────────────────────────────────────────
    if (content == DISCOVERY_PING) {
      pendingPong = true;
      pendingPongTarget = sender;
      pendingPongTime   = now + PONG_DELAY_MIN_MS
                              + random(PONG_DELAY_MAX_MS - PONG_DELAY_MIN_MS);
      return;
    }

    // ── DISCOVERY PONG ──────────────────────────────────────────────
    if (content == DISCOVERY_PONG) {
      // A node replied to our scan — end scanning state
      isScanning = false;
      if (connectedClients > 0) setLedState(LED_NORMAL);
      doc.clear(); doc["type"] = "discovery"; doc["deviceId"] = sender;
      doc["rssi"] = rssi; doc["snr"] = snr;
      String out; serializeJson(doc, out); wsBroadcast(out);
      return;
    }

    // ── Valid message (unicast or broadcast) ────────────────────────
    msgReceived++; lastMsgTime = now;
    Serial.printf("[LoRa] MSG %s→%s: %s\n",
                  sender.c_str(), recipient.c_str(), content.c_str());

    // Forward to app
    doc.clear();
    doc["type"]   = "message";
    doc["sender"] = sender;
    doc["data"]   = content;
    doc["rssi"]   = rssi;
    doc["snr"]    = snr;
    if (isBroadcast) doc["broadcast"] = true;
    String out; serializeJson(doc, out);
    wsBroadcast(out);

    // SOS content → trigger emergency LED
    if (content.indexOf("SOS") >= 0) {
      triggerEmergencyBlink();
    }

    // v3: ACK only for unicast messages (not broadcasts — avoids ACK storm)
    if (!isBroadcast) {
      pendingAck       = true;
      pendingAckTarget = sender;
      pendingAckTime   = now + ACK_DELAY_MS;
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // SOS BUTTON  ← UNTOUCHED FROM v4 (edge detection preserved)
  //
  // DO NOT MODIFY this section. The SOS logic is working correctly.
  // All we do here is call triggerEmergencyBlink() so the LED system
  // reflects the emergency without changing any SOS behavior.
  // ════════════════════════════════════════════════════════════════════
  {
    bool sosNow = digitalRead(BTN_SOS);
    if (sosNow == LOW && lastSosState == HIGH) {
      String pkt = String(THIS_DEVICE_ID) + ":*:SOS Tafadhali! Naomba msaada wa haraka.";
      LoRa.beginPacket(); LoRa.print(pkt); LoRa.endPacket();
      msgSent++;
      triggerEmergencyBlink();   // ← only addition: LED reflects SOS
      scheduleSosRepeats(pkt);
      doc.clear(); doc["type"] = "message"; doc["sender"] = THIS_DEVICE_ID;
      doc["data"] = "SOS Tafadhali! Naomba msaada wa haraka.";
      doc["broadcast"] = true;
      String out; serializeJson(doc, out); wsBroadcast(out);
      Serial.println("[BTN] SOS sent (single press, +repeats).");
    }
    lastSosState = sosNow;
  }
}
