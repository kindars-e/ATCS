# Step 4B — Communication Hardening & Field Readiness

This round implements the remaining non-critical reliability/diagnostics
items identified during the Step 3 review and approved for Step 4B: SOS
delivery confirmation, route-discovery retry, queue overflow handling,
battery telemetry, firmware stats in the app, and several error-handling/
user-feedback gaps that were found while wiring the above. It builds on
Step 4A (signal-quality redesign, scan auto-clear, route recovery after ACK
failure) without changing the overall architecture.

Out of scope for this round (explicitly deferred): SOS acknowledgment
*enhancements* beyond the lightweight confirmation below, queue *resizing*,
heartbeat redesign, deeper battery hardware work, and UI redesign unrelated
to the items below. Also deferred: automatic resend of a message once a
previously-unreachable destination becomes reachable again — a real gap
found during field testing, but a separate behavior change from anything
approved in this round.

---

## 1. Lightweight SOS delivery confirmation

**Problem:** broadcast/SOS messages got zero delivery confirmation. The
firmware resends an SOS 3× for RF resilience, but the sender had no way to
know if *anyone* actually received it.

**Why not just ACK every broadcast the normal way:** a full ACK from every
node that ever hears a flood would multiply traffic by the number of nodes —
an "ACK storm," exactly what broadcast flooding is supposed to avoid.

**The fix:** every node that receives a fresh (non-duplicate) emergency
broadcast does two cheap things, using data the packet *already carries*:
1. Learns a reverse route back to the original sender from the packet's own
   header fields (`addOrUpdateRoute(h.src, h.prevHop, h.hop)`) — the same
   trick RREQ already uses, no extra packets.
2. Sends exactly **one** small unicast control packet (`PKT_SOS_ACK`) back
   toward the sender along that route. Best-effort — if there's no route
   somehow, it's just dropped, never retried.

This is bounded by mesh size (one ack per node that received the broadcast,
not per retransmission — the firmware's existing duplicate cache already
prevents a node from acking its own 3 redundant copies twice), not a flood.

The original sender gets one `{"type":"delivery","status":"sos_received","from":"NodeX"}`
WS frame per confirming node. The app marks the most recent Emergency-thread
message "delivered" on the **first** one it sees; later ones from other
nodes are a harmless no-op.

**Files:** `V2_ranger_rola.ino` (`PKT_SOS_ACK`, `sendSosAck()`, PKT_DATA
broadcast branch), `lib/protocol.ts`, `hooks/use-ranger-connection.ts`
(`sos-delivered` event), `components/fling-app.tsx`.

---

## 2. Route discovery robustness — controlled RREQ retry

**Problem:** a route discovery sent exactly one RREQ flood and gave up after
4 seconds. On a lossy RF link, a single lost broadcast meant an instant "no
route" failure with no second chance.

**The fix:** `ROUTE_DISCOVERY_TIMEOUT_MS` is now a *total budget* (6s) across
up to `MAX_RREQ_ATTEMPTS` (2) tries — one initial RREQ, and one controlled
retry at the 3s mark if no RREP has arrived yet. Still strictly bounded:
`attemptsLeft` only ever decrements, so this can never loop, and it adds at
most one extra RREQ flood per failed discovery — not unbounded traffic.

**Files:** `V2_ranger_rola.ino` (`PendingRouteItem.attemptsLeft`/`nextRetryAt`,
`addPendingRoute()`, `pendingRouteTick()`).

---

## 3. Queue overflow detection + handling

**Problem:** when the 8-slot outgoing queue (`MAX_OUTQUEUE`) was full, the
*newest* packet was always silently dropped — even if it was an SOS and the
queue was full of ordinary chat. No visibility into how often this happened.

**The fix (no resizing — explicitly out of scope):**
- **Detection:** a new `pktDroppedQueueFull` counter, included in the
  periodic `stats` WS frame.
- **Handling:** if the queue is full, the new packet may *preempt* the
  single lowest-priority queued item, but only if it strictly outranks it
  (`priority > outQueue[worst].priority`). An SOS can bump a queued chat
  message; a chat message can never bump another chat message. This uses
  the existing fixed-size table smarter — it doesn't grow it.

**Files:** `V2_ranger_rola.ino` (`enqueueRaw()`, periodic stats block).

---

## 4. Complete battery telemetry (firmware → app)

**Problem:** the firmware already collected battery data — its own
(`readBatteryPercent()`) and neighbors' (via HELLO beacons, already stored
in the internal neighbor table) — but never told the phone any of it. The
data existed; the wire was just never connected.

**The fix — reusing existing traffic, not adding any:**
- **Own node:** added to `device_info` (on connect) and the periodic `stats`
  frame (already being sent every 5s) — zero new transmissions.
- **Direct neighbors:** added to the `neighbor` WS frame introduced in Step
  4A for the HELLO relay — the battery byte was already being read off that
  same beacon, just never forwarded.
- **Discovered nodes (possibly multi-hop):** the `DISCOVER_REPLY` packet's
  payload grew from 1 byte (hop count) to 2 bytes (hop count + battery) —
  one extra byte on an already-existing reply, not a new packet type.

On current dev boards this always reads 100% — there's no fuel gauge wired
(`readBatteryPercent()` is a documented stub). The plumbing is complete
end-to-end regardless; real percentages will appear automatically once real
ADC hardware is added, with no further code changes needed on either side.

**Files:** `V2_ranger_rola.ino` (`device_info`, `stats`, `neighbor`,
`DISCOVER_REPLY`), `lib/types.ts` (`Contact.battery`), `lib/protocol.ts`,
`hooks/use-ranger-connection.ts`, `components/fling-app.tsx`,
`components/contacts-view.tsx`, `components/add-device-modal.tsx`.

---

## 5. Firmware statistics integration into the app

**Problem:** the firmware's periodic `stats` frame (messages sent/received,
uptime, forwarded/dropped packet counts, route discoveries) existed and was
already being broadcast every 5 seconds — but the app's WebSocket handler
had no case for `"stats"` at all. It hit the `default: break` and was
silently discarded. The only way to see this data was the Arduino Serial
Monitor.

**The fix:** `use-ranger-connection.ts` now parses the `stats` frame into a
`NodeStats` object exposed from the hook; a new **Node Diagnostics** panel
(`components/node-stats-modal.tsx`), opened by tapping the
frequency/battery readout in the Contacts header, shows it live.

This same header readout was also fixed while touching it: it previously
showed a **hardcoded, wrong** "915MHz / 12km" — the firmware actually runs
433MHz, and "12km" was an unverified range claim (field testing this round
showed real range is far below that with stock antennas). It now shows the
real configured frequency and the node's actual battery reading.

**Files:** `hooks/use-ranger-connection.ts`, `lib/types.ts` (`NodeStats`),
`components/node-stats-modal.tsx` (new), `components/contacts-view.tsx`,
`components/fling-app.tsx`.

---

## 6. Error handling and user feedback improvements

Found while wiring the above — these are real, pre-existing gaps, not new
behavior changes:

- **Permanent delivery failure was invisible to the user.** The firmware
  has sent `{"type":"delivery","status":"failed","dest":"..."}` since Step
  4A's route-recovery work, but `use-ranger-connection.ts` only ever checked
  for `status === "delivered"` — a failure was silently dropped. A message
  that exhausted all retries just sat there with no visual difference from
  one still in flight. Fixed: a `delivery-failed` event now marks the
  message "failed" (by destination, regardless of which chat is currently
  open — unlike the existing delivery-confirmed path, a failure needs to
  reach the user even if they've navigated away) and raises a transient
  banner naming the contact.
- **The chat bubble for a "failed" message had no tick icon at all** — only
  a red background, easy to miss. Added an ✕ icon alongside the existing
  sending/sent/delivered/read ticks.
- **The Contacts header's frequency/range readout was actively wrong**
  (see item 5) — fixed as part of wiring real stats into the same space.

**Files:** `hooks/use-ranger-connection.ts`, `components/fling-app.tsx`,
`components/chat-view.tsx`, `components/contacts-view.tsx`.

---

## Protocol changes

All additive — old firmware/app builds ignore fields and frame types they
don't recognize, nothing existing was removed or renamed:

- New WS frame type: `neighbor` battery field (extends a Step-4A-introduced
  frame), `discovery` battery field, `device_info` battery field, `stats`
  `pktDroppedQueueFull` + `battery` fields.
- New `delivery` status values: `"failed"` and `"sos_received"` (alongside
  the existing `"delivered"`).
- New LoRa packet type: `PKT_SOS_ACK` (8) — a new *kind* of packet on the
  air, but a single small unicast control packet per confirming node, not a
  new broadcast/flood category.
- `DISCOVER_REPLY` payload grew from 1 byte to 2 bytes (battery appended).
  Old-format 1-byte replies are still handled correctly (battery field
  simply omitted, not read out of bounds).

## Backward compatibility

No breaking changes. A node running pre-Step-4B firmware talking to a
post-Step-4B phone (or vice versa) continues to work — the new fields and
frame are all optional/additive. All nodes on the same mesh should still run
the same firmware build for the *mesh* features (RREQ retry, SOS ack
routing) to actually take effect, but nothing breaks if they don't.

## New risks identified

- The SOS-ack reverse-route learning (`addOrUpdateRoute` on every broadcast
  receipt) adds entries to the same bounded 8-slot route table used for
  everything else — under a very busy mesh with frequent broadcasts, this
  could evict a route that was about to be reused for unrelated unicast
  traffic slightly sooner than before. Low risk at current mesh sizes.
- Queue preemption means a queued normal-chat packet can now be evicted
  (and effectively dropped) by a higher-priority packet under congestion,
  where previously only the *newest* arriving packet was ever at risk. This
  is the intended tradeoff (SOS/control traffic should win), but it changes
  *which* packet gets dropped under sustained congestion.
- `MAX_RREQ_ATTEMPTS`/`RREQ_RETRY_INTERVAL_MS` together with Step 4A's
  one-cycle ACK recovery mean the worst-case time before a message is
  finally reported failed is now longer (roughly 15s vs. the previous ~8s)
  — more patient, but a user staring at "sending..." will wait longer
  before seeing a definitive failure.

## Validation performed

- `npx tsc --noEmit` — clean, no type errors.
- `npm run build` — clean production build (Next.js static export).
- Full manual re-read of every changed region of the firmware file,
  checking brace/control-flow consistency, call-site argument consistency
  (no Arduino default-argument prototype-hoisting issues — see the existing
  in-file note on that gotcha), and buffer-bounds safety for the
  `DISCOVER_REPLY` payload extension.
- **Not yet performed:** an actual Arduino compile/upload, or real
  multi-node field testing of SOS ack delivery, RREQ retry behavior under
  induced packet loss, or queue preemption under deliberately induced
  congestion. These should be the next step before considering Step 4B
  field-ready.

## Recommendations before final field testing

1. Flash and field-test on real hardware — none of this round's firmware
   changes have been compiled/uploaded yet, only carefully reviewed.
2. Specifically exercise the SOS-ack path with 2+ receiving nodes to confirm
   the sender sees `sos_received` and the Emergency-thread message flips to
   delivered.
3. Test route-discovery retry by temporarily powering off a relay node
   mid-route-discovery to confirm the controlled retry actually fires (watch
   Serial output for a second `routeDiscoveries` bump within ~3s).
4. Consider the still-open "auto-resend when a destination becomes
   reachable again" gap (see Known Limitations in `README.md`) for a future
   round — it's the most field-relevant gap left after this one.
