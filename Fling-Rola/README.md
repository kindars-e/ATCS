# Fling × Rola — Offline LoRa Messenger

**Owner:** UDOM  |  **Engineer:** Anwar A Kivuruga

An offline peer-to-peer messenger that runs entirely without the internet.
Two (or more) ESP32 Rola nodes communicate over LoRa radio.  Each node
creates its own Wi-Fi hotspot.  A phone or PC browser connects to that
hotspot and opens the Fling web app to send and receive messages.

---

## Architecture Overview

```
Phone / PC browser
       │  Wi-Fi  (192.168.4.1:8765  WebSocket)
       ▼
  ESP32 Rola Node A   ←─── LoRa 433 MHz ───→   ESP32 Rola Node B
  (SSID: Fling_Node1)                           (SSID: Fling_Node2)
       │                                                │
  PC 1 browser                                   PC 2 browser
```

- **No internet required** — everything is local.
- **No Bluetooth** — all phone↔node communication uses Wi-Fi + WebSocket.
- **LoRa** carries messages between nodes (up to several km in open terrain
  with SF12 / 433 MHz settings).

---

## Hardware — Rola Node

| Component | Pin |
|-----------|-----|
| LoRa SCK  | 19  |
| LoRa MISO | 18  |
| LoRa MOSI | 5   |
| LoRa CS   | 17  |
| LoRa RST  | 16  |
| LoRa DIO0 | 4   |
| LED Green | 2   |
| LED Blue  | 14  |
| LED Red   | 12  |
| BTN SOS   | 13  |
| BTN USER  | 0   |

---

## Firmware Setup

The firmware file is `arduino/ranger_rola.ino`.

### Required libraries (install via Arduino Library Manager)

- **LoRa** by Sandeep Mistry
- **WebSockets** by Markus Sattler  (`WebSocketsServer`)
- **ArduinoJson** by Benoit Blanchon

### Flashing

1. Open `arduino/ranger_rola.ino` in the Arduino IDE.
2. Find the **DEVICE IDENTITY** section and set:
   ```cpp
   #define THIS_DEVICE_ID  "Node1"       // unique name for THIS node
   #define WIFI_SSID       "Fling_Node1" // Wi-Fi hotspot name
   #define WIFI_PASS       "fling1234"
   ```
3. Select your ESP32 board and COM port.
4. Upload.
5. Repeat with `THIS_DEVICE_ID = "Node2"` / `WIFI_SSID = "Fling_Node2"` for
   the second node.

> **Important:** Every node must use the same LoRa frequency, spreading
> factor, bandwidth, and coding rate.  The defaults (433 MHz / SF12 /
> 125 kHz / CR4/8) are set in the `#define` section.

---

## App Setup

### Prerequisites

```bash
node -v   # 18 or higher
npm -v    # 9 or higher
```

### Install & run

```bash
cd Fling-Rola
npm install
npm run dev        # opens http://localhost:3000
```

### Build for production / PWA

```bash
npm run build
npm start
```

---

## Development & Testing with Two PCs

This is the recommended workflow while you have two PCs and two Rola nodes
but no phones yet.

### Network setup

```
Node 1 (SSID: Fling_Node1)          Node 2 (SSID: Fling_Node2)
      │                                       │
  PC 1 Wi-Fi                             PC 2 Wi-Fi
  http://localhost:3000                  http://localhost:3000
```

Both PCs run the same app code (`npm run dev`) independently.

### Step-by-step

1. Power on **Node 1**.  Its Wi-Fi SSID `Fling_Node1` appears in Wi-Fi
   settings.
2. On **PC 1**, connect to `Fling_Node1` (password: `fling1234`).
3. Open `http://localhost:3000` in the browser on PC 1.
4. The app will auto-detect the node and show "Connected".
5. Repeat steps 1–4 on PC 2 with Node 2 / `Fling_Node2`.
6. In the app on PC 1, tap **+** → **Scan** (or **Manual**) to add Node2 as
   a contact.
7. Open a chat with Node2 and send a message.  It travels:
   ```
   PC 1 browser → WebSocket → Node 1 → LoRa air → Node 2 → WebSocket → PC 2 browser
   ```

### Development bypass (no hardware)

The `WiFiConnectionModal` has a **Skip (Dev Mode)** button visible when
`NODE_ENV=development`.  Click it to enter the app without a real node.
Messages will show as "failed" since there is no actual WebSocket, but you
can test the UI.

### Serial Monitor

Open the Arduino Serial Monitor (115200 baud) to watch every LoRa packet,
ACK, and WebSocket event in real time.  Useful for debugging.

---

## Device Pairing

Three methods are available in the **Add Device** screen:

| Method | When to use |
|--------|-------------|
| **Scan** (Auto-discover) | Both nodes are powered on and within LoRa range. Sends a ping; nodes reply automatically. |
| **QR Code** | Print / display a QR on the node enclosure. QR encodes `fling://pair?id=Node2&name=Fling_Node2`. |
| **Manual** | Development / no camera. Type the Node ID directly. |

### Generating a QR code for a node

Any online QR generator works.  The content to encode is:

```
fling://pair?id=Node2&name=Fling_Node2
```

Replace `Node2` and `Fling_Node2` with the actual values from the firmware.

---

## LoRa Packet Format

All packets on the LoRa air interface use the format:

```
SENDER:RECIPIENT:CONTENT
```

Examples:

```
Node1:Node2:Hello there
Node1:*:SOS Tafadhali! Naomba msaada wa haraka.
Node1:*:##DISCOVERY_PING##
Node2:Node1:##DISCOVERY_PONG##
Node1:Node2:##LOCATION_RESPONSE##-6.7924,39.2083,5.0
ACK:Node1
```

`*` means broadcast (all nodes accept it).

---

## WebSocket JSON Frames

### App → Firmware

```jsonc
{ "type": "send",     "recipient": "Node2", "data": "Hello" }
{ "type": "beep",     "recipient": "Node2" }
{ "type": "discover" }   // triggers discovery ping
```

### Firmware → App

```jsonc
{ "type": "device_info", "deviceId": "Node1", "deviceName": "Fling_Node1",
  "frequency": 433000000, "spreadingFactor": 12, "bandwidth": 125000 }

{ "type": "message",  "sender": "Node2", "data": "Hello", "rssi": -72 }

{ "type": "delivery", "status": "delivered" }

{ "type": "discovery","deviceId": "Node2", "rssi": -68 }

{ "type": "stats",    "messagesSent": 3, "messagesReceived": 4,
  "uptime": 120, "connectedClients": 1 }
```

---

## File Reference

| File | What changed |
|------|-------------|
| `arduino/ranger_rola.ino` | **New unified firmware** — Rola pins + Fling protocol |
| `lib/constants.ts` | Added `CONTACTS_STORAGE_KEY`, `DISCOVERY_SCAN_DURATION_MS` |
| `lib/protocol.ts` | Added `encodeDiscovery()`, `delivery` and `discovery` frame types |
| `lib/storage.ts` | Added `readContacts()` / `writeContacts()` |
| `hooks/use-ranger-connection.ts` | Handles `delivery` and `discovery` frames; emits new event kinds |
| `components/add-device-modal.tsx` | **New** — QR / auto-discover / manual pairing UI |
| `components/fling-app.tsx` | Wires discovery, delivery ACK, contact persistence |

All other files are **unchanged** from original Fling.

---

## Moving to Phones

When you are ready to test on phones:

1. Build the app: `npm run build && npm start`
2. On each phone, connect to the node's Wi-Fi hotspot.
3. Open the browser and navigate to `http://192.168.4.1:3000`
   — OR —
   install the PWA (tap "Add to Home Screen") for a native-app feel.
4. For a native Capacitor build: `npx cap sync && npx cap open android`

---

## LED Status Reference

| LED | Meaning |
|-----|---------|
| Green solid | Node ready |
| Green blink (3×) | ACK received — message delivered |
| Blue blink | LoRa TX or RX event |
| Red blink (5×) | SOS broadcast triggered |
| Red solid | Hardware fault (LoRa init failed) |
