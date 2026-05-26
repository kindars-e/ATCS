# v6 — LoRa Range Investigation, Fix & Out-of-Range Detection

This round investigates the "messages stop past ~1 meter" problem and adds an
out-of-range detection + signal diagnostics system. Written for someone new to
ESP32 firmware, LoRa radio, and React, so it explains the *why* throughout.

---

## 1. THE ROOT CAUSE — read this first (it's hardware)

**Your range problem is an antenna/frequency mismatch, not a software bug.**

- Your radio module is an **SX1278 / RFM96 / Ra-01** — a **433 MHz-only** chip.
- Your firmware is correctly set to **433 MHz**.
- But your antenna is a **915 / 868 MHz** antenna.

An antenna is a tuned device, like a guitar string — it only radiates
efficiently at the frequency it was built for. Feeding a 915 MHz antenna a
433 MHz signal means almost no energy actually leaves the antenna; most of it
reflects back into the radio chip. The tiny bit that leaks out is still strong
enough to hear at a few centimeters, but it collapses below the receiver's
sensitivity just past ~1 meter. That "works touching, dead at 1 m, total (not
gradual) failure" pattern is the textbook fingerprint of a band mismatch.

### The fix is hardware
> **Fit a 433 MHz antenna on BOTH nodes.** Look for: "433 MHz" stated explicitly,
> a connector that matches your board (usually U.FL/IPEX → SMA, or direct SMA),
> and a simple 433 spring/duck antenna for testing (a 433 dipole for long range
> later). Avoid 2.4 GHz "WiFi antennas" — wrong band too.

No firmware setting can compensate for the wrong-band antenna. Also: running a
transmitter into a badly mismatched antenna reflects power back into the chip
and **can damage it over time**, so swap the antenna before more testing.

The frequency stays **433 MHz** in firmware because that's correct for this
module — and 433/868 MHz are the license-free bands for your region (Tanzania),
whereas 915 MHz is the Americas/Australia band.

---

## 2. Firmware robustness fixes (worth doing once the antenna is correct)

While investigating I found real weaknesses in the radio init. These don't fix
the antenna issue but make the link far more reliable at distance once the
antenna is right. All in `arduino/02.ranger_rola/02.ranger_rola.ino`.

### a) Explicit sync word
```cpp
#define LORA_SYNC_WORD 0xF3
LoRa.setSyncWord(LORA_SYNC_WORD);
```
The sync word is a "network id" — two LoRa radios only accept each other's
packets if it matches. We set an explicit private value (not the 0x12 LoRaWAN
default) so the link is deterministic and ignores stray traffic. **Every node
must use the same value.**

### b) CRC enabled
```cpp
LoRa.enableCrc();
```
Without CRC the receiver accepts corrupted packets and passes garbage to the
app. With it, damaged packets (common at the edge of range) are silently
dropped. This directly improves "reliability as distance grows".

### c) Explicit PA_BOOST output pin
```cpp
LoRa.setTxPower(LORA_TX_POWER, PA_OUTPUT_PA_BOOST_PIN);
```
Ra-01/RFM96 modules route the antenna through the chip's PA_BOOST amplifier
(that's what enables up to 20 dBm). Naming the pin explicitly guarantees full
power reaches the antenna instead of relying on a library default.

### d) Spreading Factor 7 → 9
```cpp
#define LORA_SF 9   // was 7
```
SF7 (set in v5) is fastest but the *shortest range / weakest sensitivity*. SF9
is a better balance for a range-focused build: more reach, still well under a
second per message. **Both nodes must match** (`lib/constants.ts` updated to 9
for display).

### e) SNR diagnostics
```cpp
float snr = LoRa.packetSnr();   // forwarded alongside RSSI
```
SNR (signal-to-noise) reveals true link quality even when RSSI looks okay. Now
reported with every received packet so the app can show accurate status.

---

## 3. App: Out-of-Range detection + signal diagnostics

### The data flow
The firmware already reports RSSI per packet; now it adds SNR. These flow:
`firmware → WebSocket frame → use-ranger-connection event → fling-app → Contact`.

### Three pieces in `components/fling-app.tsx`

**1. A pure classifier** decides a node's status from how long since we last
heard it and its last RSSI:
```ts
function classifyStatus(ageMs, rssi): RangeStatus {
  if (ageMs > NODE_OFFLINE_MS) return "out-of-range"; // 90 s silence
  if (ageMs > NODE_STALE_MS)   return "weak";          // 30 s silence
  if (rssi < RSSI_MIN_DBM)  return "out-of-range";     // -120 dBm
  if (rssi < RSSI_WEAK_DBM) return "weak";             // -100 dBm
  return "online";
}
```

**2. `recordNodeHeard(id, rssi, snr)`** is called from every event that proves a
node is reachable (text message, discovery reply, location). It updates that
node's `rssi`, `snr`, `lastSeen`, and status in one immutable state update.

**3. A periodic range monitor** (a `setInterval` in a `useEffect`) is the key to
detecting *silence*. There's no event for "a node went quiet", so every 5 s the
monitor re-checks each node's age and re-classifies it. When a node's status
*changes*, it shows a one-off banner ("Ranger B is out of range" / "weak signal"
/ "back online"). A ref (`prevStatusRef`) remembers the previous status so we
only notify on a real transition, not every tick.

> Why a timer instead of pure events? Events tell you when something *arrives*.
> "Out of range" is the *absence* of arrivals — only a clock can detect that.

### The UI — `components/signal-indicator.tsx` (new)
A small reusable component with two variants:
- `variant="dot"` — a coloured status dot on the contact avatar (emerald =
  online, amber = weak, red = out of range).
- `variant="full"` — signal bars (from RSSI) + a coloured label + the RSSI value
  in dBm.

It's wired into the contact list (`contacts-view.tsx`) and the chat header
(`chat-view.tsx`). The Emergency channel keeps a static indicator since it's a
broadcast pseudo-node, not a single radio link.

### New constants (`lib/constants.ts`)
```ts
RSSI_WEAK_DBM = -100;        // weaker than this = "weak"
RSSI_MIN_DBM  = -120;        // weaker than this = "out of range"
NODE_STALE_MS   = 30_000;    // 30 s quiet = "weak"
NODE_OFFLINE_MS = 90_000;    // 90 s quiet = "out of range"
RANGE_CHECK_INTERVAL_MS = 5_000;  // monitor tick
```

---

## 4. Files changed

| File | Change |
|---|---|
| `arduino/02.ranger_rola/02.ranger_rola.ino` | sync word, CRC, explicit PA_BOOST, SF 7→9, SNR reporting; hardware note in header. Frequency stays 433 MHz. |
| `lib/constants.ts` | SF→9; RSSI/timeout/interval thresholds. |
| `lib/types.ts` | `Contact` gains `rssi`/`snr`; new `RangeStatus` type. |
| `hooks/use-ranger-connection.ts` | rssi/snr threaded through text + discovery events. |
| `components/signal-indicator.tsx` | NEW reusable status/signal component. |
| `components/fling-app.tsx` | classifier, `recordNodeHeard`, range monitor, notification banner. |
| `components/contacts-view.tsx` | range-aware avatar dot + full signal line per contact. |
| `components/chat-view.tsx` | range status in the chat header for real nodes. |

---

## 5. How to run

```bash
cd Fling-Rola
npm install
npm run dev     # http://localhost:3000   (or: npm run build && npm run start)
```

Firmware: open `arduino/02.ranger_rola/02.ranger_rola.ino`, set `THIS_DEVICE_ID`
+ `WIFI_SSID` per node, flash each ESP32. **Re-flash every node** (same SF9 +
sync word) and **fit a 433 MHz antenna on each**.

`node_modules/` isn't in the ZIP — run `npm install`.

---

## 6. Test checklist

1. **Fit 433 MHz antennas on both nodes** (the actual range fix).
2. Re-flash both nodes with this firmware (SF9, sync word 0xF3, CRC on).
3. Send a message close up → ✅ delivers.
4. Walk the nodes apart outdoors → ✅ should now hold far past 1 m (the wrong
   antenna was the wall; 433 + SF9 + CRC should give real outdoor range).
5. Watch a contact's signal line → ✅ bars + RSSI update as you move.
6. Move a node far enough / power it off → after ~30 s it shows "weak", after
   ~90 s "out of range", with a banner notification. ✅
7. Bring it back / scan → ✅ it flips back to "online" with a "back online"
   banner.

> If it STILL fails at ~1 m even with a confirmed 433 MHz antenna on both nodes,
> the remaining suspects are a bad U.FL/SMA connector or a damaged transmitter
> (possibly from prior mismatched use) — both hardware, not code.
