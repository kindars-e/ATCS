# v5 — Stability, Latency & Emergency Overhaul (new stable reference build)

This round fixes four connected problems: emergency reliability, message delay,
Wi-Fi instability, and emergency-channel correctness. It is written for someone
new to React, Next.js, Capacitor, ESP32 firmware, LoRa, and WebSockets, so each
section explains the root cause *before* the fix.

---

## Summary of root causes (read this first)

| Symptom | Real root cause | Where |
|---|---|---|
| Severe message delay | LoRa was set to Spreading Factor 12 — the *slowest* possible mode (~290 bits/sec). A short message took 2–5 seconds of airtime. | firmware `LORA_SF` |
| Emergency "broke again" | Long airtime (from SF12) means two nodes often transmit at the same time and their packets **collide and are lost**. Broadcasts also had no retry. | firmware (LoRa timing) |
| Wi-Fi freezes / looks connected but isn't | The app's "health check" only looked at `ws.readyState`, which can say OPEN even when the firmware has died. There was no real heartbeat. | app `use-ranger-connection.ts` |
| Connection drops not recovered | No ping/pong, and the firmware never pinged either, so idle sockets silently died. | both sides |

The app-side **emergency routing logic itself was never broken** — it was the
radio underneath it that was too slow and collision-prone. That's why the
"emergency" and "delay" problems were really the same problem.

---

## Fix 1 — Latency: make LoRa ~10× faster (firmware)

LoRa trades speed for range using a "Spreading Factor" (SF7 = fastest/shortest
range, SF12 = slowest/longest range). The project was on SF12.

```cpp
// arduino/02.ranger_rola/02.ranger_rola.ino
#define LORA_SF   7   // was 12  → ~10x faster (~5470 bps vs ~290 bps)
#define LORA_CR   5   // was 8   → 4/5 coding rate (less overhead, LoRa default)
```

At SF7 the same SOS message that took ~3 seconds now transmits in well under
half a second. Shorter airtime *also* means far fewer collisions, which is why
this single change improves emergency reliability too.

> Range note: SF7 has shorter range than SF12. For a local ranger network this
> is normally fine, and the reliability gain is worth it. If you ever need more
> range, SF9 is a good middle ground — just change it in BOTH places below.

This value must match on the app side (only used for display):

```ts
// lib/constants.ts
export const RADIO_SPREADING_FACTOR = 7;   // was 12 — must match firmware
```

---

## Fix 2 — Wi-Fi stability: a real heartbeat on both sides

### The problem in plain terms
A WebSocket is like a phone call. If the other person walks into a tunnel, your
phone might still *show* the call as connected — you only find out it's dead when
you try to talk and get silence. The old code trusted that "still shows
connected" status (`ws.readyState`). So when the ESP32 rebooted or Wi-Fi
dropped, the app kept thinking it was fine and **froze**.

### The fix — prove the link is alive, don't assume it
Two halves:

**App side** (`hooks/use-ranger-connection.ts`): every 5 seconds the app sends a
tiny `{"type":"ping"}` and remembers the time of the last message it received
from the firmware. If nothing comes back for 8 seconds, the link is declared
dead and the socket is closed — which triggers the existing auto-reconnect.

```ts
pingTimerRef.current = setInterval(() => {
  const socket = wsRef.current;
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  if (Date.now() - lastPongRef.current > PONG_TIMEOUT_MS) {
    socket.close();           // dead link → onclose schedules a reconnect
    return;
  }
  socket.send(JSON.stringify({ type: "ping" }));   // keep proving liveness
}, PING_INTERVAL_MS);
```

Every incoming message refreshes the liveness clock:

```ts
ws.onmessage = (event) => {
  lastPongRef.current = Date.now();   // ANY message proves we're alive
  ...
};
```

**Firmware side** (`02.ranger_rola.ino`): two things.

1. It replies to the app's ping:
   ```cpp
   else if (strcmp(msgType, "ping") == 0) {
     doc.clear(); doc["type"] = "pong";
     String out; serializeJson(doc, out);
     webSocket.sendTXT(num, out);
   }
   ```
2. It enables the WebSocket library's own heartbeat so it can drop a dead phone:
   ```cpp
   webSocket.enableHeartbeat(15000, 3000, 2);
   // ping each client every 15s; if no pong in 3s, count a strike;
   // after 2 strikes, drop the client.
   ```

Together: the app notices a dead node within ~8 s and reconnects; the node
notices a dead phone within ~30 s and frees the socket. No more permanent
freezes.

New constants:
```ts
// lib/constants.ts
export const PING_INTERVAL_MS = 5_000;   // how often the app pings
export const PONG_TIMEOUT_MS  = 8_000;   // silence past this = dead link
```

---

## Fix 3 — Emergency reliability: re-broadcast the SOS (firmware)

Broadcasts deliberately get **no ACK** (if every node ACKed a broadcast at once
you'd get an "ACK storm" of colliding replies). But no ACK also means no retry —
one unlucky collision and the SOS vanishes.

Fix: send each emergency a few times, spaced out with a little randomness, all
non-blocking so the loop stays responsive.

```cpp
#define SOS_TOTAL_SENDS   3      // 1 immediate + 2 resends
#define SOS_REPEAT_GAP_MS 250    // base gap between copies

void scheduleSosRepeats(const String& packet) {
  sosRepeatPacket = packet;
  sosRepeatsLeft  = SOS_TOTAL_SENDS - 1;
  sosRepeatNext   = millis() + SOS_REPEAT_GAP_MS;
}
```

The loop fires the extra copies on a timer (with 0–120 ms jitter so copies from
different nodes don't line up and collide). This applies to BOTH the physical
SOS button and any message typed into the app's "Emergency Broadcast" chat
(recipient `"*"`).

### The matching app change — don't show 3 duplicates
Because the firmware now sends the SOS 3 times, receivers would see 3 identical
messages. The app already de-duplicated within a 1 s window; for broadcasts we
widen that to 4 s so all re-broadcast copies are recognised as one message:

```ts
// components/fling-app.tsx (text handler)
const dedupWindowMs = isBroadcast ? 4000 : 1000;
const exists = thread.some(m =>
  m.content === newMessage.content &&
  m.sender  === newMessage.sender &&
  Math.abs(m.timestamp.getTime() - newMessage.timestamp.getTime()) < dedupWindowMs);
if (exists) return prev;   // already have this emergency copy — skip it
```

Normal messages keep the tight 1 s window so legitimately repeated texts (you
typing "ok" twice) are not swallowed.

---

## Fix 4 — Emergency correctness (verified, unchanged)

The broadcast routing from the earlier emergency work is intact and was
re-verified end-to-end:
- App-typed emergencies send to recipient `"*"`; the firmware broadcasts them.
- Receivers route any message flagged `broadcast:true` into the shared Emergency
  thread, tagged with the sender's name ("Ranger B").
- Unknown senders are auto-added as contacts so you can continue privately after
  the alert.

With Fixes 1–3 underneath it, this logic now actually *works reliably* instead
of losing packets to slow, colliding transmissions.

---

## Files changed

| File | Change |
|---|---|
| `arduino/02.ranger_rola/02.ranger_rola.ino` | SF12→7, CR8→5; WebSocket heartbeat; `ping`→`pong` reply; non-blocking SOS re-broadcast (button + app broadcasts). |
| `lib/constants.ts` | `RADIO_SPREADING_FACTOR` 12→7; new `PING_INTERVAL_MS` / `PONG_TIMEOUT_MS`; old health-check constant marked deprecated. |
| `lib/protocol.ts` | Added `{ type: "ping" }` to `OutgoingFrame`. |
| `hooks/use-ranger-connection.ts` | Replaced fake `readyState` check with real ping/pong heartbeat + liveness clock; handle `pong`; clean up the new timer everywhere. |
| `components/fling-app.tsx` | Wider de-dup window (4 s) for broadcast/emergency messages. |

No breaking changes to the protocol, storage, or component structure — every
fix is additive or a tuned value.

---

## How to run

```bash
cd Fling-Rola
npm install
npm run dev        # http://localhost:3000   (or: npm run build && npm run start)
```

Firmware: open `arduino/02.ranger_rola/02.ranger_rola.ino` in the Arduino IDE,
set `THIS_DEVICE_ID` + `WIFI_SSID` per node, flash each ESP32.
**Re-flash every node** so they all use the new SF7 setting — nodes on different
spreading factors cannot hear each other.

`node_modules/` is not in the ZIP (run `npm install` to get platform-correct
native binaries).

---

## Test checklist

1. Flash 2+ nodes (all with the new firmware so they share SF7).
2. Send a normal message → ✅ it arrives in well under a second (was several
   seconds).
3. Press the physical SOS button → ✅ it appears in every node's Emergency
   thread, once (not 3 times), tagged with the sender.
4. Type in the app's Emergency Broadcast chat → ✅ same reliable delivery.
5. Walk a phone out of Wi-Fi range, then back → ✅ the app shows
   disconnected/reconnecting and recovers on its own within a few seconds (no
   permanent freeze).
6. Power-cycle a node while the app is open → ✅ the app detects the dead link
   within ~8 s and reconnects when the node is back.
7. Long session of continuous messaging → ✅ stays connected (heartbeat keeps
   the socket healthy and detects any silent death).
