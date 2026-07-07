// ─────────────────────────────────────────────────────────────────────────────
// lib/storage.ts
//
// Thin wrappers around localStorage so every part of the app reads and
// writes the same keys.  The data survives page reloads.
// ─────────────────────────────────────────────────────────────────────────────

import { CONTACTS_STORAGE_KEY, MESSAGES_STORAGE_KEY, WAYPOINTS_STORAGE_KEY } from "./constants";
import type { Contact, Message } from "./types";

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
      lastSeen:        c.lastSeen        ? new Date(c.lastSeen)        : undefined,
      // [STEP 4A/6 FIX] signalSampledAt was added in Step 4A and stored as
      // an ISO string in JSON. SignalIndicator calls .getTime() on it, which
      // throws if it is still a string — crashing the app on every render.
      signalSampledAt: c.signalSampledAt ? new Date(c.signalSampledAt) : undefined,
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

// ── [STEP 9] Named Waypoints ──────────────────────────────────────────────────
// A flat list of named GPS locations for the redesigned navigation system.
// Each waypoint is a saved coordinate with a name and optional type tag.

export interface NamedWaypoint {
  id: string;
  name: string;
  lat: number;
  lng: number;
  type: "waypoint" | "camp" | "water" | "danger" | "sos" | "interest";
  createdAt: Date;
  notes?: string;
  /** [STEP 14] The real mesh device id behind this waypoint, when it came
      from an actual node (e.g. an SOS location) rather than a manually
      placed pin — lets navigation still offer Beep for a real "node in
      trouble", not just a static coordinate. */
  sourceDeviceId?: string;
}

export function readWaypoints(): NamedWaypoint[] {
  if (typeof window === "undefined") return [];
  const raw = window.localStorage.getItem(WAYPOINTS_STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as NamedWaypoint[];
    return parsed.map((w) => ({ ...w, createdAt: new Date(w.createdAt) }));
  } catch {
    return [];
  }
}

export function writeWaypoints(waypoints: NamedWaypoint[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(WAYPOINTS_STORAGE_KEY, JSON.stringify(waypoints));
  } catch { /* quota exceeded — fail quietly */ }
}
