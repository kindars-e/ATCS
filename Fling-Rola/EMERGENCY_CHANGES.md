# Emergency Conversation — Fix & Redesign

This document explains every change made to turn the **Emergency** conversation
into a true shared broadcast channel. It is written for someone still learning
React, Next.js, WebSockets, and ESP32/LoRa firmware, so it explains the *why*
as well as the *what*.

---

## 1. The one-sentence summary

> The firmware was already broadcasting emergency messages correctly and already
> told the app "this was a broadcast" — but **the app threw that information away**,
> so received emergency messages landed in private chats instead of the shared
> Emergency conversation.

The fix threads a single boolean — `broadcast` — from the firmware, through the
WebSocket, through the decoder, into the React state, and finally into the UI.

---

## 2. How a message physically travels (mental model)

```
User A types in Emergency  ──► App A sends WebSocket {type:"send", recipient:"*", data:"..."}
                                     │
                                     ▼
                            Firmware A builds LoRa packet  "A:*:..."   (":" separates SENDER:RECIPIENT:CONTENT)
                                     │  radio
                                     ▼
        Firmware B, C, D each hear the packet. recipient is "*", so it is "for everyone".
                                     │
                                     ▼
        Each firmware sends its app a WebSocket frame:
            { type:"message", sender:"A", data:"...", broadcast:true }   ◄── the key field
                                     │
                                     ▼
        Each app reads broadcast:true ──► stores the message in the "*" (Emergency) thread,
        NOT in a private "A" thread. It also tags the bubble with sender = "A".
```

The LoRa packet format `SENDER:RECIPIENT:CONTENT` and the `"*"` = broadcast
convention were already in the project. We did **not** change them.

---

## 3. What was broken, file by file

| Layer | File | Problem |
|---|---|---|
| Firmware | `arduino/02.ranger_rola/02.ranger_rola.ino` | Already sent `broadcast:true` for received broadcasts ✅ — but the **physical SOS/USER button** echoed its *local* confirmation with `broadcast:false`, so a button press would have created a junk private thread. |
| WebSocket hook | `hooks/use-ranger-connection.ts` | Read `sender` and `data` but **never read `broadcast`** — the flag died here. |
| Protocol | `lib/protocol.ts` | `decodeMessage` and the message types had no concept of a broadcast flag. |
| Main app | `components/fling-app.tsx` | Filed **every** received message under the sender's private thread. A stale comment even admitted "we cannot distinguish broadcast from direct". |
| Persistence | `lib/storage.ts` | Messages were **never saved** — refreshing the page wiped the entire Emergency history. |
| UI | `components/chat-view.tsx` | Emergency bubbles showed a generic "Emergency Broadcast" label instead of *who* sent the message. |

---

## 4. The changes, explained

### 4.1 Protocol — `lib/protocol.ts`

We added an optional `broadcast` field to the incoming message frame and to the
decoded text message, then made `decodeMessage` pass it through:

```ts
export function decodeMessage(frame: {
  sender: string;
  data: string;
  broadcast?: boolean;          // NEW
}): DecodedMessage {
  const broadcast = frame.broadcast === true;   // normalise undefined → false
  // ...sentinels for location/pairing are always point-to-point, so we ignore
  //    the flag for them...
  return { kind: "text", sender, content: data, broadcast };   // pass it through
}
```

**Why a boolean and not, say, a new message type?** Because the radio still does
exactly the same thing for broadcast and unicast text — only the *routing* in the
app differs. A flag keeps the protocol surface tiny and backwards-compatible:
any frame *without* the flag is simply treated as `broadcast:false`.

### 4.2 WebSocket hook — `hooks/use-ranger-connection.ts`

The hook is the bridge between the raw WebSocket and the rest of the React app.
It now reads the flag and includes it in the `text` event it emits:

```ts
const isBroadcast = (frame.broadcast as boolean | undefined) === true;
const decoded = decodeMessage({ sender, data, broadcast: isBroadcast });
if (decoded.kind === "text") {
  emit({ kind: "text", sender, content, broadcast: decoded.broadcast });  // NEW field
}
```

**Beginner note on hooks:** a custom hook (`useRangerConnection`) is just a
function that uses React's built-in hooks internally. This one owns the WebSocket
and calls a callback (`onEvent`) whenever something arrives. The component using
it doesn't care *how* the data arrived — only that it gets typed events.

### 4.3 Routing — `components/fling-app.tsx` (the heart of the fix)

The `"text"` case of `handleRangerEvent` now decides the destination thread:

```ts
const isBroadcast = event.broadcast === true;
const threadId = isBroadcast ? EMERGENCY_BROADCAST_ID : senderId;   // "*" vs private
```

Three extra behaviours were added around that core line:

1. **Own-echo handling.** When *we* press the physical SOS button, the firmware
   echoes the message back to us with our own `sender` id. We detect this
   (`senderId === myDeviceIdRef.current`) and render it as our own sent bubble
   (`isMe: true`) instead of an incoming "Ranger me" message.

2. **Sender identity.** For broadcasts from *other* nodes we resolve a friendly
   name via `resolveSenderName()` — it returns the saved contact name if we know
   them, otherwise `"Ranger <id>"`. This is what produces **"Ranger B"** beside
   each emergency bubble.

3. **Follow-up private chat.** If an emergency arrives from a node we have never
   paired with, we auto-add it to contacts. That is what lets a receiver tap the
   sender afterwards and continue the conversation **privately** in the normal
   inbox — satisfying "the emergency conversation acts as the initial alert /
   discovery point, follow-up continues in direct chat".

**Beginner note on stale closures.** `handleRangerEvent` is wrapped in
`useCallback` so it keeps a stable identity (otherwise the WebSocket effect would
tear down and reconnect constantly). But a stable function "remembers" the
variables from when it was created — including an old `contacts` array. To always
read the *current* contacts without recreating the function, we mirror them into
a ref:

```ts
const contactsRef = useRef<Contact[]>(contacts);
useEffect(() => { contactsRef.current = contacts; }, [contacts]);   // keep it fresh
// ...inside the handler we read contactsRef.current, never the closure variable.
```

### 4.4 Persistence — `lib/storage.ts`

Messages now survive reloads. Two helpers mirror the existing contact helpers:

```ts
export function readMessages(): Record<string, Message[]> { /* localStorage + Date revival */ }
export function writeMessages(messages: Record<string, Message[]>): void { /* JSON.stringify */ }
```

JSON has no `Date` type, so timestamps are saved as strings and converted back to
`Date` objects on read (the UI calls `.toLocaleTimeString()` on them). In
`fling-app.tsx`, state is seeded from storage and saved on every change:

```ts
const [messages, setMessages] = useState(() => readMessages());   // load once
useEffect(() => { writeMessages(messages); }, [messages]);        // save on change
```

### 4.5 UI — `components/chat-view.tsx`

The emergency bubble now shows the per-message sender instead of a constant label:

```tsx
<span className="...">{message.senderName || "Emergency Broadcast"}</span>
```

All the existing emergency styling (red header, warning banner, glowing send
button) was preserved untouched.

### 4.6 Firmware — `arduino/02.ranger_rola/02.ranger_rola.ino`

Only the **physical button local echoes** changed. Both the SOS and USER buttons
broadcast over LoRa (`recipient = "*"`), so their *local* WebSocket confirmation
must also be flagged `broadcast:true` to land in this node's own Emergency thread:

```cpp
doc["sender"] = THIS_DEVICE_ID;
doc["data"]   = "SOS Tafadhali! Naomba msaada wa haraka.";
doc["broadcast"] = true;          // was false — now routes to Emergency thread
```

The packet format, ACK logic, discovery, and pairing were **not** touched.

---

## 5. Two small pre-existing issues fixed during build verification

These were unrelated to the emergency feature but blocked a clean `next build`:

1. **`app/manifest.ts` was a 0-byte file.** Next.js treats `manifest.ts` as a
   special metadata route that *requires* a default export, so the empty file
   broke the build. The app already ships a static `public/manifest.webmanifest`
   (referenced in `layout.tsx`), so the empty `manifest.ts` was redundant and was
   removed.

2. The build also needs the `Inter` Google Font, which downloads at build time —
   this is normal and works on any machine with internet access.

---

## 6. How to run

```bash
cd Fling-Rola
npm install        # installs dependencies for YOUR platform
npm run dev        # development server at http://localhost:3000
# or
npm run build && npm run start   # production build

# Firmware: open arduino/02.ranger_rola/02.ranger_rola.ino in the Arduino IDE,
# set THIS_DEVICE_ID and WIFI_SSID per node, and flash each ESP32.
```

> `node_modules/` is intentionally **not** included in the ZIP. Native binaries
> (like Tailwind's CSS engine) are platform-specific, so you must run
> `npm install` to get the correct ones for your computer.

---

## 7. End-to-end test checklist

1. Flash two (or more) nodes with **different** `THIS_DEVICE_ID` values.
2. Connect phone A to Node A's Wi-Fi, phone B to Node B's Wi-Fi; open the app on each.
3. On A, open **Emergency Broadcast** and send a message.
4. ✅ It appears in **A's** Emergency thread as a sent (orange) bubble.
5. ✅ It appears in **B's** Emergency thread tagged **"Ranger A"** — *not* in a private chat.
6. On B, reply inside the Emergency thread.
7. ✅ A sees B's reply in the Emergency thread tagged **"Ranger B"**.
8. ✅ "Ranger A" now appears in B's contact list — tap it to start a **private** chat.
9. Press the **physical SOS button** on Node A.
10. ✅ A sees its own SOS in its Emergency thread; B sees it tagged "Ranger A".
11. Reload the app. ✅ The Emergency history is still there (persistence).
