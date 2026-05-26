# Message Deletion + Settings Cleanup — Changes

This round adds a full message-deletion system and removes the unused Settings
button. It is written for someone still learning React, Next.js, state
management, and local storage, so it explains the *why* as well as the *what*.

---

## 1. The one big idea (read this first)

There is **one** place that holds all messages: a React state variable in
`fling-app.tsx` called `messages`. It is a map of `deviceId → Message[]`
(each conversation is one entry, including the Emergency thread under the key
`"*"`).

An existing effect saves it automatically:

```ts
useEffect(() => { writeMessages(messages); }, [messages]);
```

Because of this one line, **everything follows from updating the state**:

- Update `messages` → React re-renders the chat → the message vanishes instantly.
- The same change triggers the effect → it writes to localStorage → the deletion
  survives a reload.

So all three delete handlers do exactly one thing: produce a new `messages`
object with the unwanted messages removed. We never write to storage by hand,
and we never touch the WebSocket/LoRa layer — so deletion cannot affect radio
communication.

> Why "produce a NEW object" and not edit the old one? React decides whether to
> re-render by comparing references (`oldMessages === newMessages`). If you
> mutate the existing object, the reference is the same and React may not
> re-render. Always returning a fresh object/array is the golden rule of React
> state.

---

## 2. Files changed

| File | What changed |
|---|---|
| `components/fling-app.tsx` | Added three delete handlers; passed them into `ChatView`. |
| `components/chat-view.tsx` | Added the deletion UI (single delete, multi-select, clear-all) and the confirm dialog. |
| `components/contacts-view.tsx` | Removed the dead Settings button and its unused import. |

No storage, type, or protocol files needed changing — the existing
`readMessages`/`writeMessages` and `Message` type already support everything.

---

## 3. The three delete handlers (`fling-app.tsx`)

All three live just after `deleteContact` and follow the same pattern.

```ts
// Delete ONE message from a thread.
const deleteMessage = useCallback((threadId: string, messageId: string) => {
  setMessages((prev) => {
    const thread = prev[threadId];
    if (!thread) return prev;
    const filtered = thread.filter((m) => m.id !== messageId);   // keep all EXCEPT this id
    return { ...prev, [threadId]: filtered };                    // new object, new array
  });
}, []);

// Delete MANY selected messages at once.
const deleteMessages = useCallback((threadId: string, messageIds: string[]) => {
  if (messageIds.length === 0) return;
  setMessages((prev) => {
    const thread = prev[threadId];
    if (!thread) return prev;
    const idsToRemove = new Set(messageIds);                     // Set = fast "is this id in the list?"
    const filtered = thread.filter((m) => !idsToRemove.has(m.id));
    return { ...prev, [threadId]: filtered };
  });
}, []);

// Clear an ENTIRE conversation but keep the thread (and contact) in place.
const clearConversation = useCallback((threadId: string) => {
  setMessages((prev) => {
    if (!prev[threadId] || prev[threadId].length === 0) return prev;
    return { ...prev, [threadId]: [] };                          // empty array, not deleted key
  });
}, []);
```

Notes for learning:
- `useCallback(..., [])` keeps each function's identity stable across renders so
  React doesn't see them as "new" props every time. (Same technique the existing
  handlers use.)
- `clearConversation` keeps the key with an empty array `[]` rather than deleting
  it. For a normal chat this means the conversation stays open but empty; for the
  Emergency thread it means the Emergency contact is preserved and only its
  history is wiped.
- We pass `threadId` in from the parent, so the handlers are generic — the exact
  same code clears a private chat or the emergency channel.

They are wired into `ChatView` like this (the parent already knows the current
thread, so the child only deals with message ids):

```tsx
onDeleteMessage={(messageId) => deleteMessage(currentContact.deviceId, messageId)}
onDeleteMessages={(messageIds) => deleteMessages(currentContact.deviceId, messageIds)}
onClearConversation={() => clearConversation(currentContact.deviceId)}
```

---

## 4. The deletion UI (`chat-view.tsx`)

The view now owns a little local UI state (this is *view* state, not *data* —
it's fine to keep it here and not in the parent):

```ts
const [selectionMode, setSelectionMode] = useState(false);          // are we multi-selecting?
const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set()); // which are checked
const [showClearConfirm, setShowClearConfirm] = useState(false);    // confirm dialog open?
const [longPressMessageId, setLongPressMessageId] = useState<string | null>(null);
```

Three ways to delete:

1. **Single message** — hover a bubble on desktop (or long-press on mobile) to
   reveal a small red trash button on that bubble. Tapping it calls
   `onDeleteMessage(message.id)`.
2. **Multiple messages** — tap the check icon in the header to enter selection
   mode. Each row gets a checkbox; tapping a row toggles it. The header turns
   into a toolbar showing "N selected" with a delete button that calls
   `onDeleteMessages([...selectedIds])`.
3. **Clear all** — the red trash icon in the header opens a confirmation dialog;
   confirming calls `onClearConversation()`.

A `useEffect` resets the selection state whenever you switch conversations, so
you never carry a half-finished selection into another chat:

```ts
useEffect(() => {
  setSelectionMode(false);
  setSelectedIds(new Set());
  setLongPressMessageId(null);
}, [contact.deviceId]);
```

This all works identically in the Emergency chat — the emergency banner just
hides while you're in selection mode to keep the toolbar clean.

Small refactor: the message status checkmarks used to be hand-written inline
`<svg>` blocks. They're now the `Check` / `CheckCheck` icons from `lucide-react`
(already a dependency) — same look, much less code.

---

## 5. Settings button removal (`contacts-view.tsx`)

The header had this button:

```tsx
<button className="p-3 rounded-xl hover:bg-gray-800 transition-colors group">
  <Settings className="h-5 w-5 ..." />
</button>
```

It had **no `onClick`** — it did nothing. It's been removed, along with the now-
unused `Settings` import. A comment marks the spot so it's easy to reintroduce a
real Settings screen later.

> Note: the "Open Wi-Fi Settings" button in `wifi-connection-modal.tsx` was left
> alone — that one opens the *phone's* network settings (a real, working
> feature) and is unrelated to the dead in-app Settings icon.

---

## 6. How to run

```bash
cd Fling-Rola
npm install      # installs dependencies for YOUR platform
npm run dev      # http://localhost:3000
# or: npm run build && npm run start
```

`node_modules/` is intentionally not in the ZIP — run `npm install` to get the
platform-correct native binaries (Tailwind's CSS engine ships per-OS binaries).

---

## 7. Test checklist

1. Open any private chat with a few messages.
2. Hover a message (desktop) or long-press it (mobile) → a red trash button
   appears → tap it → ✅ that one message disappears instantly.
3. Tap the check icon in the header → tap several messages → ✅ checkmarks appear
   and the header shows the count → tap the toolbar trash → ✅ all selected
   messages vanish.
4. Tap the red trash icon in the header → confirm → ✅ the whole conversation
   empties and shows the "No messages yet" state.
5. Repeat 2–4 inside the **Emergency** chat → ✅ identical behaviour.
6. Reload the app (or restart it) → ✅ the deletions are still gone (persisted).
7. Confirm the Settings icon is gone from the main contacts screen, and that
   sending/receiving messages still works normally → ✅ LoRa unaffected.
