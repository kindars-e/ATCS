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
  // [STEP 11] True from the moment GPS acquisition starts until either a
  // fix reaches GPS_WARMUP_GOOD_ACCURACY_M or GPS_WARMUP_MAX_WAIT_MS elapses
  // — whichever comes first. Consumer GPS chips commonly need several
  // seconds after a cold start to converge on their steady-state accuracy;
  // without this, the very first (often worst) fixes were fed straight into
  // navigation math, which is exactly when users first open the compass.
  // Callers should treat position as "not yet trustworthy for navigation"
  // while this is true, even though a value is already present.
  isWarmingUp: boolean;
  requestPermission: () => Promise<void>;
}

// [STEP 11] See isWarmingUp above.
const GPS_WARMUP_GOOD_ACCURACY_M = 30;
const GPS_WARMUP_MAX_WAIT_MS     = 6000;

// [STEP 6] This product's whole premise is operating with ZERO internet —
// the Ranger node's Wi-Fi hotspot has none by design. The IP-geolocation
// fallback below makes a real `fetch()` to a public internet API, which
// will simply hang for its full timeout and fail every time in the field.
// It's only ever actually useful on a developer's machine that has a normal
// internet connection (e.g. testing in a browser via `npm run dev` without
// a GPS chip) — so it must be explicitly opted into, never the default.
const ALLOW_IP_FALLBACK_BY_DEFAULT = false;

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

// ── [STEP 11] Position smoother ──────────────────────────────────────────────
// [FIX 2]'s original version blended lat/lng with an EMA when accuracy was
// poor, but built the returned position with `buildSyntheticPosition()` —
// a helper meant only for the IP-geolocation fallback, which hardcodes
// `accuracy: 5000`. That meant every time a real GPS fix's accuracy crossed
// 20 m (common indoors or right after acquiring a fix), the displayed "GPS
// accuracy" and every distance-vs-accuracy calculation downstream silently
// switched to a fabricated 5000 m value that had nothing to do with the
// actual fix. This is a direct, verified cause of "GPS accuracy becomes
// unrealistic" reports. The fix below blends ONLY lat/lng (accuracy is a
// radius, not a linear quantity — blending two accuracy numbers together
// isn't physically meaningful anyway) and always reports the NEW fix's real
// accuracy/altitude/heading/speed, never a fabricated placeholder.
//
// [STEP 11] Smoothing strength is also now a continuous function of accuracy
// instead of a binary switch at exactly 20 m — the old on/off jump meant a
// fix oscillating around that boundary got inconsistently smoothed from one
// reading to the next.
const SMOOTHING_GOOD_ACCURACY_M = 10;  // at/below this: trust the fix fully, no smoothing
const SMOOTHING_POOR_ACCURACY_M = 50;  // at/above this: maximum smoothing
const SMOOTHING_MAX_STRENGTH    = 0.6; // alpha floor at/above SMOOTHING_POOR_ACCURACY_M (60% old / 40% new)

function smoothingAlphaFor(accuracy: number): number {
  if (accuracy <= SMOOTHING_GOOD_ACCURACY_M) return 1.0; // no smoothing
  if (accuracy >= SMOOTHING_POOR_ACCURACY_M) return 1.0 - SMOOTHING_MAX_STRENGTH;
  const t = (accuracy - SMOOTHING_GOOD_ACCURACY_M) / (SMOOTHING_POOR_ACCURACY_M - SMOOTHING_GOOD_ACCURACY_M);
  return 1.0 - t * SMOOTHING_MAX_STRENGTH;
}

function blendPosition(
  prev: GeolocationPosition,
  next: GeolocationPosition,
  alpha: number,
): GeolocationPosition {
  const lat = alpha * next.coords.latitude  + (1 - alpha) * prev.coords.latitude;
  const lng = alpha * next.coords.longitude + (1 - alpha) * prev.coords.longitude;
  return {
    coords: {
      latitude:  lat,
      longitude: lng,
      // [STEP 11] Always the NEW fix's real accuracy — never fabricated.
      accuracy: next.coords.accuracy,
      altitude: next.coords.altitude,
      altitudeAccuracy: next.coords.altitudeAccuracy,
      heading: next.coords.heading,
      speed: next.coords.speed,
      toJSON() { return this; },
    },
    timestamp: next.timestamp,
    toJSON() { return this; },
  } as unknown as GeolocationPosition;
}

function smoothPosition(
  prev: GeolocationPosition | null,
  next: GeolocationPosition,
): GeolocationPosition {
  if (!prev) return next;
  const alpha = smoothingAlphaFor(next.coords.accuracy);
  if (alpha >= 1.0) return next; // good accuracy – use raw, no smoothing needed
  return blendPosition(prev, next, alpha);
}

export default function useGeolocation(
  opts: { allowIpFallback?: boolean } = {},
): UseGeolocationResult {
  const allowIpFallback = opts.allowIpFallback ?? ALLOW_IP_FALLBACK_BY_DEFAULT;
  const [position, setPosition] = useState<GeolocationPosition | null>(null);
  const [permission, setPermission] = useState<Permission>("prompt");
  const [error, setError] = useState<string | null>(null);
  const [usingFallback, setUsingFallback] = useState(false);
  // [STEP 11] See isWarmingUp on UseGeolocationResult above.
  const [isWarmingUp, setIsWarmingUp] = useState(true);
  // [STEP 11] The getCurrentPosition/watchPosition success callbacks below
  // are registered once (inside requestPermission, itself called once) and
  // persist for the lifetime of the watch — they close over whatever
  // `isWarmingUp` was at THAT moment and never see later state updates. A
  // ref mirrors the state for the guard check inside noteFixForWarmup so it
  // always reads the current value instead of a stale closure.
  const isWarmingUpRef = useRef(true);
  const setWarmingUp = (value: boolean) => {
    isWarmingUpRef.current = value;
    setIsWarmingUp(value);
  };

  // [FIX 2] Keep previous position in a ref (not state) so the smoother can
  // access it without triggering extra re-renders.
  const prevPositionRef = useRef<GeolocationPosition | null>(null);
  const watchIdRef = useRef<number | null>(null);
  // [STEP 11] When the current warm-up window started (reset each time
  // requestPermission() is called fresh).
  const warmupStartRef = useRef<number | null>(null);

  // [STEP 11] Called with every real GPS fix (not the IP fallback, which is
  // never going to "warm up" — it's a fixed low-precision value). Clears
  // isWarmingUp the moment either condition is met.
  const noteFixForWarmup = (pos: GeolocationPosition) => {
    if (!isWarmingUpRef.current) return;
    const elapsed = Date.now() - (warmupStartRef.current ?? Date.now());
    if (pos.coords.accuracy <= GPS_WARMUP_GOOD_ACCURACY_M || elapsed >= GPS_WARMUP_MAX_WAIT_MS) {
      setWarmingUp(false);
    }
  };

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
      // [STEP 6] No GPS support — only attempt the internet-dependent IP
      // fallback if explicitly opted in (see ALLOW_IP_FALLBACK_BY_DEFAULT).
      // In the field there is never internet access, so this would
      // otherwise just be a guaranteed-to-fail network call on every device
      // without a GPS chip.
      const ipPos = allowIpFallback ? await getIpLocation() : null;
      if (ipPos) {
        setPosition(ipPos);
        setPermission("granted");
        setUsingFallback(true);
        // [STEP 11] IP-based location is a fixed, city-level estimate — it
        // will never "warm up" to something better, so there's nothing to
        // wait for.
        setWarmingUp(false);
      } else {
        setError("Geolocation is not supported by this device");
        setWarmingUp(false);
      }
      return;
    }

    // [STEP 11] Reset the warm-up window for this fresh acquisition attempt.
    setWarmingUp(true);
    warmupStartRef.current = Date.now();

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
            noteFixForWarmup(pos);
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
          noteFixForWarmup(pos);
        },
        (err) => {
          if (err.code === err.PERMISSION_DENIED) setPermission("denied");
          setError(toError(err.code, err));
          setPosition(null);
          // [STEP 11] An error means there's nothing left to warm up toward.
          setWarmingUp(false);
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
      // [STEP 6] GPS failed or was denied — only fall back to the
      // internet-dependent IP lookup if explicitly opted in.
      const ipPos = allowIpFallback ? await getIpLocation() : null;
      if (ipPos) {
        setPosition(ipPos);
        setPermission("granted");
        setUsingFallback(true);
        setError(null);
      } else {
        setError("Unable to determine location. Please check that location services are enabled.");
      }
      setWarmingUp(false);
    }
  };

  return { position, permission, error, usingFallback, isWarmingUp, requestPermission };
}
