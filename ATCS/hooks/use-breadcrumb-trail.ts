// ─────────────────────────────────────────────────────────────────────────────
// hooks/use-breadcrumb-trail.ts
//
// [STEP 11] Breadcrumb / trail recording — record the user's own path over
// time so it can be retraced or reviewed later (a "how did I get here"
// safety net, distinct from waypoints which are single named points the user
// deliberately saves).
//
// This revives the existing `Trail`/`Waypoint` data model (lib/types.ts,
// lib/storage.ts) that was already built for the original Leaflet map but
// had nothing writing to it in the live app — the map component drew trails,
// but no feature ever recorded one, so `useActiveTrailCount()`'s badge always
// read zero in practice.
//
// Deliberately coarser-grained than live-location sharing: a trail is a
// route record, not a real-time feed, so points are captured every
// BREADCRUMB_MIN_MOVE_M of movement (or BREADCRUMB_MAX_INTERVAL_MS of no
// movement, so a long stationary pause is still visible in the trail) rather
// than every couple of metres — that keeps storage growth and re-render
// churn reasonable across a multi-hour recording.
//
// Recording state lives here, at the component that mounts this hook once
// (fling-app.tsx), specifically so it keeps running in the background across
// opening/closing the Waypoints or Map modals — those are just VIEWS onto
// this hook's state, not owners of it.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from "react";
import { calculateDistance } from "@/lib/geo";
import { readTrails, writeTrails } from "@/lib/storage";
import type { Trail, Waypoint } from "@/lib/types";

const BREADCRUMB_MIN_MOVE_M       = 15;    // coarser than live-share's 8 m — this is a route record, not a live feed
const BREADCRUMB_MAX_INTERVAL_MS  = 30_000; // still capture periodically even while stationary

export function useBreadcrumbTrail() {
  const [activeTrail, setActiveTrail] = useState<Trail | null>(null);
  const watchIdRef        = useRef<number | null>(null);
  const lastPointRef       = useRef<{ lat: number; lng: number } | null>(null);
  const lastRecordedAtRef  = useRef<number>(0);

  // Resume an in-progress recording if the app reloaded mid-trail.
  useEffect(() => {
    const existing = readTrails().find((t) => t.active);
    if (existing) setActiveTrail(existing);
  }, []);

  const persistTrail = useCallback((trail: Trail) => {
    const trails = readTrails();
    const idx = trails.findIndex((t) => t.id === trail.id);
    if (idx >= 0) trails[idx] = trail;
    else trails.push(trail);
    writeTrails(trails);
    setActiveTrail(trail);
  }, []);

  const appendPoint = useCallback((pos: GeolocationPosition, trailId: string) => {
    const { latitude, longitude, accuracy } = pos.coords;
    const trails = readTrails();
    const idx = trails.findIndex((t) => t.id === trailId);
    if (idx < 0) return; // trail was deleted/stopped elsewhere — nothing to append to

    const trail = trails[idx];
    const lastWp = trail.waypoints[trail.waypoints.length - 1];
    const legDistance = lastWp
      ? calculateDistance(lastWp.location.lat, lastWp.location.lng, latitude, longitude)
      : 0;

    const wp: Waypoint = {
      id: Date.now().toString(),
      name: `Point ${trail.waypoints.length + 1}`,
      location: { lat: latitude, lng: longitude, accuracy },
      timestamp: new Date(),
      type: "waypoint",
    };

    const updated: Trail = {
      ...trail,
      waypoints: [...trail.waypoints, wp],
      totalDistance: trail.totalDistance + legDistance,
    };
    trails[idx] = updated;
    writeTrails(trails);
    setActiveTrail(updated);
  }, []);

  const startRecording = useCallback((name?: string) => {
    if (!navigator.geolocation || watchIdRef.current !== null) return;

    const trail: Trail = {
      id: Date.now().toString(),
      name: name?.trim() || `Trail ${new Date().toLocaleString([], {
        month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
      })}`,
      waypoints: [],
      startTime: new Date(),
      totalDistance: 0,
      active: true,
    };
    persistTrail(trail);
    lastPointRef.current = null;
    lastRecordedAtRef.current = 0;

    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        const now = Date.now();
        const moved = lastPointRef.current
          ? calculateDistance(lastPointRef.current.lat, lastPointRef.current.lng, latitude, longitude)
          : Infinity; // no prior point — always record the first fix
        const dueForHeartbeat = now - lastRecordedAtRef.current >= BREADCRUMB_MAX_INTERVAL_MS;

        if (moved >= BREADCRUMB_MIN_MOVE_M || dueForHeartbeat) {
          appendPoint(pos, trail.id);
          lastPointRef.current = { lat: latitude, lng: longitude };
          lastRecordedAtRef.current = now;
        }
      },
      () => { /* transient GPS errors — keep the watch alive, just skip this fix */ },
      { enableHighAccuracy: true, maximumAge: 0 },
    );
  }, [persistTrail, appendPoint]);

  const stopRecording = useCallback(() => {
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    setActiveTrail((prev) => {
      if (!prev) return prev;
      const trails = readTrails();
      const idx = trails.findIndex((t) => t.id === prev.id);
      if (idx >= 0) {
        trails[idx] = { ...trails[idx], active: false, endTime: new Date() };
        writeTrails(trails);
      }
      return null;
    });
  }, []);

  const deleteTrail = useCallback((id: string) => {
    writeTrails(readTrails().filter((t) => t.id !== id));
  }, []);

  useEffect(() => {
    return () => {
      if (watchIdRef.current !== null) navigator.geolocation?.clearWatch(watchIdRef.current);
    };
  }, []);

  return {
    activeTrail,
    isRecording: activeTrail !== null,
    startRecording,
    stopRecording,
    deleteTrail,
  };
}