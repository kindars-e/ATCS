// ─────────────────────────────────────────────────────────────────────────────
// lib/storage.ts
//
// Thin wrappers around localStorage so every part of the app reads and
// writes the same keys.  The data survives page reloads.
// ─────────────────────────────────────────────────────────────────────────────

import { CONTACTS_STORAGE_KEY, MESSAGES_STORAGE_KEY, TRAILS_STORAGE_KEY } from "./constants";
import type { Contact, Message } from "./types";
import type { Trail } from "./types";

// ── Trail persistence (unchanged from original Fling) ────────────────────────

// [STEP 6] Revive Dates the same way readContacts()/readMessages() already
// do — JSON has no Date type, so timestamps come back as strings unless we
// convert them. This used to be done ad hoc, inline, inside
// components/waypoint-modal.tsx (with `endTime: null` instead of `undefined`
// for absent values, a type mismatch); centralizing it here means every
// caller gets the same correct behavior instead of duplicating it.
export function readTrails(): Trail[] {
  if (typeof window === "undefined") return [];
  const raw = window.localStorage.getItem(TRAILS_STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Trail[];
    return parsed.map((trail) => ({
      ...trail,
      startTime: new Date(trail.startTime),
      endTime:   trail.endTime ? new Date(trail.endTime) : undefined,
      waypoints: trail.waypoints.map((wp) => ({
        ...wp,
        timestamp: new Date(wp.timestamp),
      })),
    }));
  } catch {
    return [];
  }
}

export function writeTrails(trails: Trail[]): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(TRAILS_STORAGE_KEY, JSON.stringify(trails));
}

// ── Contact persistence (NEW) ─────────────────────────────────────────────────
// Contacts are saved so they survive a page reload.
// The Emergency Broadcast contact is always added at runtime and never stored.

export function readContacts(): Contact[] {
  if (typeof window === "undefined") return [];
  const raw = window.localStorage.getItem(CONTACTS_STORAGE_KEY);
  if (!raw) return [];
  try {
    // Dates are serialised as strings in JSON — convert them back.
    const parsed = JSON.parse(raw) as Contact[];
    return parsed.map((c) => ({
      ...c,
      lastSeen: c.lastSeen ? new Date(c.lastSeen) : undefined,
      location: c.location
        ? { ...c.location, timestamp: new Date(c.location.timestamp) }
        : undefined,
    }));
  } catch {
    return [];
  }
}

export function writeContacts(contacts: Contact[]): void {
  if (typeof window === "undefined") return;
  // Never persist the Emergency Broadcast entry — it is added by the app at startup.
  const toSave = contacts.filter((c) => c.deviceId !== "*");
  window.localStorage.setItem(CONTACTS_STORAGE_KEY, JSON.stringify(toSave));
}

// ── Message persistence (NEW) ─────────────────────────────────────────────────
// Conversation threads (a map of deviceId → Message[]) are saved so that the
// Emergency history — and normal chats — survive a page reload / app restart.
// Previously messages lived only in React state and were lost on every refresh.
//
// JSON has no Date type, so timestamps are serialised as ISO strings and we
// convert them back to Date objects on read (the UI calls .toLocaleTimeString()).

export function readMessages(): Record<string, Message[]> {
  if (typeof window === "undefined") return {};
  const raw = window.localStorage.getItem(MESSAGES_STORAGE_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, Message[]>;
    // Revive Date objects inside every message of every thread.
    const revived: Record<string, Message[]> = {};
    for (const [threadId, msgs] of Object.entries(parsed)) {
      revived[threadId] = msgs.map((m) => ({
        ...m,
        timestamp: new Date(m.timestamp),
      }));
    }
    return revived;
  } catch {
    return {};
  }
}

export function writeMessages(messages: Record<string, Message[]>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(MESSAGES_STORAGE_KEY, JSON.stringify(messages));
  } catch {
    // localStorage can throw if the quota is exceeded — fail quietly so a full
    // disk never crashes the emergency UI. The in-memory state still works.
  }
}
