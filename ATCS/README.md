# ATCS (Fling × Rola) — Offline LoRa Mesh Messenger

**Owner:** UDOM  |  **Engineer:** Anwar A Kivuruga

An offline messenger that runs entirely without the internet or cellular
network. ESP32 "Rola" nodes form a **multi-hop LoRa mesh** (AODV-style
routing, not a single-hop link) — two nodes that can't hear each other
directly can still talk through intermediate relay nodes. Each node creates
its own Wi-Fi hotspot; a phone connects to that hotspot and uses the ATCS
app (a Capacitor-wrapped build of this Next.js app — see "Android App" below)
to send and receive messages.

---

## Architecture Overview

```
Phone (ATCS Android app)
       │  Wi-Fi  (192.168.4.1:8765  WebSocket)
       ▼
  ESP32 Rola Node A  ←LoRa→  Node B (relay)  ←LoRa→  Node C
  (SSID: ATCS_Node1)                                  (SSID: ATCS_Node3)
       │                                                    │
  Phone A                                              Phone C
```

- **No internet required** — everything is local.
- **No Bluetooth** — all phone↔node communication uses Wi-Fi + WebSocket.
- **LoRa mesh** carries messages between nodes, including through relays
  multiple hops away (`MESH_TTL_MAX` = 6 hops, reactive AODV-style routing).
- **Real-world range is far below any marketed LoRa distance figures**
  (e.g. "10km"/"12km" claims) unless you have clear line-of-sight and a
  proper antenna. The small spring/helical antennas bundled with cheap LoRa
  modules are the weakest antenna type available — see **Known Limitations**
  below before relying on this for long-range field use.

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
| LED Yellow| 14  |
| LED Red   | 12  |
| BTN SOS   | 13  |
| BTN USER  | 0   |

> **Note:** GPIO12 (LED Red) and GPIO0 (BTN USER) are ESP32 strapping pins.
> They only affect boot mode/flash-voltage selection in the brief moment
> right at power-on, before this firmware's own GPIO configuration takes
> effect — not a concern in normal operation, but worth knowing if a board
> ever fails to boot at all (different symptom from the LED-solid-red
> *application* state below, which happens well after boot).

---

## Firmware Setup

The firmware file is
[`arduino/02.ranger_rola/V2_ranger_rola/V2_ranger_rola.ino`](arduino/02.ranger_rola/V2_ranger_rola/V2_ranger_rola.ino)
— a full mesh-networking rewrite (AODV-style routing, multi-hop relay, ACK +
retry, route recovery, lightweight SOS delivery confirmation). The WebSocket
JSON contract with the app is unchanged across all of that — the phone never
knows or cares how many hops a message actually traveled.

### Required libraries (install via Arduino Library Manager)

- **LoRa** by Sandeep Mistry
- **WebSockets** by Markus Sattler  (`WebSocketsServer`)
- **ArduinoJson** by Benoit Blanchon

### Flashing

1. Open the `.ino` file above in the Arduino IDE.
2. Find the **DEVICE IDENTITY** section and set:
   ```cpp
   #define THIS_DEVICE_ID  "Node1"        // unique mesh address for THIS node (max 8 chars)
   #define WIFI_SSID       "ATCS_Node1"   // Wi-Fi hotspot name
   #define WIFI_PASS       "atcs1234"
   ```
3. Select your ESP32 board and COM port.
4. Upload.
5. Repeat with a different `THIS_DEVICE_ID` / `WIFI_SSID` for every other
   node — every node on the mesh must have a unique ID.

> **Important:** Every node must use the same LoRa frequency, spreading
> factor, bandwidth, coding rate, and sync word (`LORA_SYNC_WORD`) — see the
> **LoRa SETTINGS** `#define` block. Current defaults: 433 MHz / SF9 /
> 125 kHz / CR4/5.

> **Upload troubleshooting:** if Arduino IDE fails with "Failed to install
> platform" or a network error, that's the board-package *download* failing,
> not your code — retry, check antivirus/firewall interference, or try a
> different network. If upload then fails with "No serial data received,"
> close any open Serial Monitor on that port first (it locks the port), or
> manually enter bootloader mode (hold BOOT, tap EN/RST, keep holding BOOT
> through the start of Upload). If a board boots but a Serial Monitor shows
> nothing past the ROM bootloader lines (`ets Jul 29 2019...`) even from a
> sketch with no custom code, that's a board/flash/power-level fault, not a
> firmware bug — try a different USB cable/port first, then a full
> `Tools → Erase Flash` before re-uploading.

---

## App Setup

### Prerequisites

```bash
node -v   # 18 or higher
npm -v    # 9 or higher
```

### Install & run

```bash
cd ATCS
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

Two methods are available in the **Add Device** screen (a "Manual" entry tab
existed in earlier versions and has been removed — pairing is QR or scan
only):

| Method | When to use |
|--------|-------------|
| **Scan** (Auto-discover, continuous) | Both nodes are powered on and within range (direct or multi-hop). Automatically re-pings every few seconds; tapping "Add" on a result sends a LoRa pair request and the other side adds you back automatically — only one person needs to tap "Add." |
| **QR Code** | Print / display a QR on the node enclosure. QR encodes `fling://pair?id=Node2&name=ATCS_Node2`. |

### Generating a QR code for a node

Any online QR generator works.  The content to encode is:

```
fling://pair?id=Node2&name=ATCS_Node2
```

Replace `Node2` and `ATCS_Node2` with the actual values from the firmware.

---

## LoRa Packet Format

Packets on the LoRa air interface are a small **binary mesh header** (31
bytes, fixed layout) followed by a raw payload — not the simple
colon-delimited string format used in early versions. The header carries a
message ID, source/destination/previous-hop node IDs, TTL, hop count,
priority, and payload length, which is what makes multi-hop relaying,
end-to-end ACK/retry, and de-duplication possible. See the
**MESH PACKET FORMAT** comment block at the top of the `.ino` file for the
exact byte layout and the full list of packet types (`DATA`, `ACK`, `HELLO`,
`RREQ`/`RREP`, `DISCOVER`/`DISCOVER_REPLY`, `SOS_ACK`).

The phone app never sees any of this — the WebSocket JSON contract below is
the same regardless of how many hops a message traveled.

---

## WebSocket JSON Frames

### App → Firmware

```jsonc
{ "type": "send",     "recipient": "Node2", "data": "Hello" }
{ "type": "beep",     "recipient": "Node2" }
{ "type": "discover" }   // triggers a multi-hop discovery flood
{ "type": "ping" }       // app-side heartbeat; firmware replies "pong"
```

### Firmware → App

```jsonc
{ "type": "device_info", "deviceId": "Node1", "deviceName": "ATCS_Node1",
  "frequency": 433000000, "spreadingFactor": 9, "bandwidth": 125000,
  "battery": 100 }

{ "type": "message",  "sender": "Node2", "data": "Hello", "rssi": -72,
  "snr": 7.5, "broadcast": false }

{ "type": "location", "sender": "Node2", "lat": -6.79, "lng": 39.20 }

// status is "delivered" (unicast ACK), "failed" (retries + rediscovery
// exhausted — dest identifies which contact), or "sos_received" (one node
// confirmed receipt of a broadcast SOS — from identifies which node; may
// arrive once per node that received it)
{ "type": "delivery", "status": "delivered" }
{ "type": "delivery", "status": "failed", "dest": "Node2" }
{ "type": "delivery", "status": "sos_received", "from": "Node3" }

// hops: how many mesh hops away; battery: that node's battery, if known
{ "type": "discovery","deviceId": "Node2", "rssi": -68, "hops": 1, "battery": 100 }

// relayed straight from a direct neighbor's existing HELLO beacon —
// no extra LoRa traffic, just forwarding a reading the firmware already had
{ "type": "neighbor",  "deviceId": "Node3", "rssi": -55, "snr": 9.2, "battery": 100 }

{ "type": "stats",    "messagesSent": 3, "messagesReceived": 4,
  "uptime": 120, "connectedClients": 1, "pktForwarded": 5,
  "pktDroppedDup": 0, "pktDroppedNoRoute": 0, "pktDroppedQueueFull": 0,
  "routeDiscoveries": 1, "battery": 100 }
```

---

## Android App

The phone app is this same Next.js codebase wrapped with
[Capacitor](https://capacitorjs.com/) (`npx cap add android`, project lives
in `android/`) — not a separate native rewrite. Build pipeline:

```bash
npm run build          # static export to out/
npx cap sync android   # copies the build + native config into android/
# then open android/ in Android Studio, or:
cd android && ./gradlew assembleDebug
```

Two Android-specific things the web version doesn't need:
- **`android.allowMixedContent: true`** in `capacitor.config.ts` — without
  it, the WebView blocks the `ws://` connection to the node as "mixed
  content" (the app page loads over `https://localhost`), and the app gets
  stuck unable to connect even on a perfectly good Wi-Fi link.
- **Native Wi-Fi binding** in `MainActivity.java` — when the phone has both
  the node's (no-internet) Wi-Fi and mobile data active simultaneously,
  Android can route the WebSocket over cellular by default since it's the
  "validated" network. `MainActivity` explicitly binds the process to the
  Wi-Fi link so traffic actually reaches the node.

---

## Known Limitations

- **Real-world LoRa range is heavily antenna- and environment-dependent.**
  Any "Xkm" figure assumes open line-of-sight and a proper antenna — the
  small spring/helical antennas bundled with cheap LoRa modules are the
  weakest type available and will perform far below that in practice.
  Upgrading to a 433MHz-tuned quarter-wave whip or a 3-5dBi antenna is the
  single highest-leverage range improvement available.
- **Battery telemetry is fully wired end-to-end but the underlying reading
  is a fixed stub** (`readBatteryPercent()` always returns 100) — no fuel
  gauge is wired on current dev boards. Real battery percentages will show
  up automatically once ADC hardware is added; no further plumbing changes
  needed.
- **Mesh tables are bounded for a small demo mesh, not a large deployment**:
  `MAX_NEIGHBORS`/`MAX_ROUTES` = 8, `MAX_OUTQUEUE` = 8, `MAX_PENDING_ACK` = 4,
  `MAX_PENDING_ROUTE` = 2. These are fixed-size (no dynamic allocation, no
  memory-leak risk) but a much larger or busier mesh would need them resized
  and re-tuned.
- **SOS delivery confirmation is best-effort, not guaranteed.** Each node
  that receives an emergency broadcast sends one lightweight unicast
  confirmation back — if that single confirmation packet is lost, the
  sender simply doesn't find out that particular node received it (the
  broadcast itself still gets 3 redundant transmissions for RF resilience,
  independent of the confirmation).
- **Route recovery and RREQ retry are deliberately bounded**, not infinite:
  one rediscovery cycle after ACK-retry exhaustion, one retry per route
  discovery attempt. A genuinely unreachable destination still ends in a
  reported failure — just after a longer, smarter attempt than a single
  immediate failure.
- **No automatic resend when a link recovers.** If a message fails outright
  (see above) and the destination becomes reachable again later, nothing
  automatically retries it — the user must resend manually. (A proposed fix
  for this — reachability-triggered automatic retry — has been scoped but
  not yet implemented.)

---

## LED Status Reference

| LED | Meaning |
|-----|---------|
| Green solid | Normal — phone connected, ready |
| Green blink (6×) | End-to-end ACK received — message delivered |
| Yellow slow blink | Scanning for nodes (discovery in progress) |
| Yellow fast blink | No phone connected yet / reconnecting |
| Red fast blink (10×) | SOS broadcast sent or received |
| Red solid | Critical hardware fault — LoRa radio failed to initialize at boot (see firmware setup troubleshooting above; this is a board/wiring/power issue, not a code issue) |
