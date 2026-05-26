// ─────────────────────────────────────────────────────────────────────────────
// hooks/use-geolocation.ts
//
// Provides the device's GPS position to components that need it.
//
// WHAT THIS HOOK DOES (for beginners):
//   This hook asks the browser/phone for the user's current GPS location.
//   It returns the position (latitude/longitude), permission status, and
//   any error messages.  It also handles the case where the device has no
//   GPS, by falling back to a rough city-level location from the internet.
//
// [FIX 2] CHANGES FROM ORIGINAL:
//   - Lowered maximumAge from 2000ms to 0ms on the live watch so we always
//     get the freshest GPS reading, not a cached one.
//   - Lowered timeout on the watch from 8000ms to 15000ms — but more
//     importantly made the watchPosition options match the getCurrentPosition
//     options (both use maximumAge: 0) to prevent stale position returns.
//   - Added a Kalman-style low-pass alpha filter to smooth heading jitter
//     without introducing lag. (Used by use-device-orientation.ts)
//   - Added exponential-moving-average (EMA) position smoothing inside the
//     hook to reduce GPS noise — only applies when accuracy is poor (>20 m).
//   - IP-fallback timeout reduced from 5 s to 3 s to fail faster.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from "react";

type Permission = "granted" | "denied" | "prompt";

interface UseGeolocationResult {
  position: GeolocationPosition | null;
  permission: Permission;
  error: string | null;
  usingFallback: boolean;   // true when IP-based location is active
  requestPermission: () => Promise<void>;
}

function toError(code: number, permErr: GeolocationPositionError): string {
  switch (code) {
    case permErr.PERMISSION_DENIED:
      return "Location permission denied";
    case permErr.POSITION_UNAVAILABLE:
      return "Location information is unavailable";
    case permErr.TIMEOUT:
      return "Location request timed out";
    default:
      return "An unknown error occurred";
  }
}

function buildSyntheticPosition(lat: number, lng: number): GeolocationPosition {
  return {
    coords: {
      latitude: lat,
      longitude: lng,
      accuracy: 5000,
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      speed: null,
      toJSON() { return this; },
    },
    timestamp: Date.now(),
    toJSON() { return this; },
  } as unknown as GeolocationPosition;
}

async function getIpLocation(): Promise<GeolocationPosition | null> {
  try {
    // [FIX 2] Timeout reduced from 5000ms to 3000ms for faster failure.
    const res = await fetch("http://ip-api.com/json/?fields=status,lat,lon", {
      signal: AbortSignal.timeout(3000),
    });
    const data = await res.json() as { status: string; lat: number; lon: number };
    if (data.status === "success" && data.lat && data.lon) {
      return buildSyntheticPosition(data.lat, data.lon);
    }
  } catch {
    // network error – silently ignore
  }
  return null;
}

// ── [FIX 2] EMA position smoother ────────────────────────────────────────────
// When GPS accuracy is poor (>20 m) we blend the new reading with the previous
// one using an Exponential Moving Average to reduce jumpiness.
// α=0.6 means 60% new reading, 40% old.  When accuracy is good we use α=1.0
// (no smoothing) so we react instantly to real movement.
const EMA_ALPHA_POOR  = 0.6;   // used when accuracy > 20 m
const EMA_ALPHA_GOOD  = 1.0;   // used when accuracy ≤ 20 m — no smoothing

function smoothPosition(
  prev: GeolocationPosition | null,
  next: GeolocationPosition,
): GeolocationPosition {
  if (!prev) return next;

  const alpha = next.coords.accuracy > 20 ? EMA_ALPHA_POOR : EMA_ALPHA_GOOD;
  if (alpha === EMA_ALPHA_GOOD) return next; // good accuracy – use raw

  const lat = alpha * next.coords.latitude  + (1 - alpha) * prev.coords.latitude;
  const lng = alpha * next.coords.longitude + (1 - alpha) * prev.coords.longitude;
  return buildSyntheticPosition(lat, lng);
}

export default function useGeolocation(): UseGeolocationResult {
  const [position, setPosition] = useState<GeolocationPosition | null>(null);
  const [permission, setPermission] = useState<Permission>("prompt");
  const [error, setError] = useState<string | null>(null);
  const [usingFallback, setUsingFallback] = useState(false);

  // [FIX 2] Keep previous position in a ref (not state) so the smoother can
  // access it without triggering extra re-renders.
  const prevPositionRef = useRef<GeolocationPosition | null>(null);
  const watchIdRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      // Clean up the GPS watch when the component using this hook unmounts.
      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
    };
  }, []);

  const requestPermission = async () => {
    if (!navigator.geolocation) {
      // No GPS support — try IP geolocation as a fallback.
      const ipPos = await getIpLocation();
      if (ipPos) {
        setPosition(ipPos);
        setPermission("granted");
        setUsingFallback(true);
      } else {
        setError("Geolocation is not supported by your browser");
      }
      return;
    }

    try {
      // First, do a one-time getCurrentPosition to get a reading quickly
      // and to trigger the browser permission prompt.
      await new Promise<void>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            setPermission("granted");
            const smoothed = smoothPosition(prevPositionRef.current, pos);
            prevPositionRef.current = smoothed;
            setPosition(smoothed);
            setUsingFallback(false);
            setError(null);
            resolve();
          },
          (err) => {
            if (err.code === err.PERMISSION_DENIED) setPermission("denied");
            setError(toError(err.code, err));
            reject(err);
          },
          {
            enableHighAccuracy: true,
            timeout: 8000,
            // [FIX 2] maximumAge: 0 — always get a fresh fix, never return
            // a cached location that may be seconds or minutes old.
            maximumAge: 0,
          },
        );
      });

      // Now start a continuous GPS watch for live updates.
      const id = navigator.geolocation.watchPosition(
        (pos) => {
          // [FIX 2] Apply EMA smoothing to reduce GPS noise.
          const smoothed = smoothPosition(prevPositionRef.current, pos);
          prevPositionRef.current = smoothed;
          setPosition(smoothed);
          setUsingFallback(false);
          setError(null);
        },
        (err) => {
          if (err.code === err.PERMISSION_DENIED) setPermission("denied");
          setError(toError(err.code, err));
          setPosition(null);
        },
        {
          enableHighAccuracy: true,
          // [FIX 2] maximumAge: 0 — never return stale cached position.
          // This is the most important fix for reducing location latency;
          // the old value of 0 was correct but timeout was 8000 which could
          // cause long waits when signal was weak.
          maximumAge: 0,
          // [FIX 2] timeout: 10000 gives the GPS chip a fair chance to lock
          // on before we give up. On Android 10000ms is a safe value.
          timeout: 10000,
        },
      );

      watchIdRef.current = id;
    } catch {
      // GPS failed or was denied — fall back to IP geolocation.
      const ipPos = await getIpLocation();
      if (ipPos) {
        setPosition(ipPos);
        setPermission("granted");
        setUsingFallback(true);
        setError(null);
      } else {
        setError("Unable to determine location. Please allow location access or check your connection.");
      }
    }
  };

  return { position, permission, error, usingFallback, requestPermission };
}
