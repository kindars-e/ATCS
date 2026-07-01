// ─────────────────────────────────────────────────────────────────────────────
// hooks/use-device-orientation.ts
//
// [STEP 9] COMPASS ACCURACY FIX — the core issue with the old code:
//   The original implementation used the `deviceorientation` event on Android.
//   On Android, `deviceorientation.alpha` is a RELATIVE heading — it is
//   measured from an arbitrary reference point set when the sensor first
//   fired, NOT from magnetic north. This is why the compass pointed in the
//   wrong direction: it had no idea where north was.
//
//   The correct event for Android is `deviceorientationabsolute`. This event
//   only fires when the device has fused magnetometer + gyroscope + accelerometer
//   data into a TRUE magnetic north heading. On iOS, `webkitCompassHeading`
//   already provides a calibrated heading — that path is unchanged.
//
//   The EMA alpha is also raised from 0.2 → 0.35 (35% new reading) so the
//   needle responds more quickly as the user turns, while still smoothing jitter.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from "react";
import { getCardinalDirection } from "@/lib/geo";

interface ExtendedDeviceOrientationEvent extends DeviceOrientationEvent {
  webkitCompassHeading?: number;
}

interface Direction {
  degrees: number;
  cardinal: string;
}

interface UseDeviceOrientationOptions {
  userPosition: GeolocationPosition | null;
}

// [STEP 9] Raised from 0.2 → 0.35 for faster needle response while still
// dampening sensor jitter. 35% new reading per event (Android fires ~10 Hz).
const HEADING_EMA_ALPHA = 0.35;

function angularDiff(a: number, b: number): number {
  let d = b - a;
  while (d >  180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

export default function useDeviceOrientation(_opts: UseDeviceOrientationOptions) {
  const [permission, setPermission] = useState("unknown");
  const [direction, setDirection] = useState<Direction | null>(null);
  const [hasSupport, setHasSupport] = useState(true);
  const [needsCalibration, setNeedsCalibration] = useState(false);
  // [STEP 9] Track whether we're receiving ABSOLUTE (calibrated) or relative
  // orientation data so callers can surface a calibration warning if needed.
  const [isAbsolute, setIsAbsolute] = useState(false);

  const smoothedHeadingRef = useRef<number | null>(null);
  const lastAlphaValues    = useRef<number[]>([]);
  // [STEP 9] Whether we successfully registered the absolute-orientation
  // event (true on Android 7+ with WebView 63+, false on older devices).
  const hasAbsoluteRef     = useRef(false);

  const checkCalibrationNeeded = useCallback((alpha: number) => {
    const buf = lastAlphaValues.current;
    buf.push(alpha);
    if (buf.length > 10) buf.shift();
    if (buf.length === 10) {
      const allSame  = buf.every((v) => Math.abs(v - buf[0]) < 0.1);
      const tooJumpy = buf.some((v, i) => {
        if (i === 0) return false;
        const diff = Math.abs(v - buf[i - 1]);
        return diff > 40 && diff < 320;
      });
      setNeedsCalibration(allSame || tooJumpy);
    }
  }, []);

  const handleOrientation = useCallback(
    (event: ExtendedDeviceOrientationEvent) => {
      let rawHeading = 0;

      if (event?.webkitCompassHeading != null) {
        // ── iOS path ─────────────────────────────────────────────────────
        // webkitCompassHeading is already calibrated true magnetic north.
        rawHeading = event.webkitCompassHeading;
        setNeedsCalibration(false);
        setIsAbsolute(true);
      } else if (event.alpha !== null) {
        // ── Android path ─────────────────────────────────────────────────
        // [STEP 9] KEY FIX: `event.absolute === true` means this event
        // comes from `deviceorientationabsolute` and alpha IS measured from
        // magnetic north (clockwise = positive). Without `.absolute`, alpha
        // is relative to an arbitrary reference — useless for navigation.
        if (event.absolute) {
          // Absolute: alpha counts clockwise FROM north → heading = 360 - alpha
          rawHeading = (360 - event.alpha) % 360;
          setIsAbsolute(true);
          setNeedsCalibration(false);
        } else {
          // Relative (fallback when absolute event not available): apply
          // screen-orientation correction and show calibration warning since
          // we can't guarantee accuracy.
          checkCalibrationNeeded(event.alpha);
          const screenAngle = window.screen.orientation?.angle ?? 0;
          rawHeading = (360 - event.alpha + screenAngle) % 360;
          setIsAbsolute(false);
        }
      } else {
        setHasSupport(false);
        setDirection({ degrees: 0, cardinal: "N" });
        return;
      }

      // EMA smoothing — handles the 359°/0° wrap-around correctly.
      let smoothed: number;
      if (smoothedHeadingRef.current === null) {
        smoothed = rawHeading;
      } else {
        const diff = angularDiff(smoothedHeadingRef.current, rawHeading);
        smoothed = (smoothedHeadingRef.current + HEADING_EMA_ALPHA * diff + 360) % 360;
      }
      smoothedHeadingRef.current = smoothed;

      setDirection({
        degrees:  Math.round(smoothed),
        cardinal: getCardinalDirection(smoothed),
      });
    },
    [checkCalibrationNeeded],
  );

  const requestPermission = async () => {
    if (typeof window === "undefined") return;
    if (!window.DeviceOrientationEvent) {
      setHasSupport(false);
      setDirection({ degrees: 0, cardinal: "N" });
      return;
    }

    const DOE = DeviceOrientationEvent as typeof DeviceOrientationEvent & {
      requestPermission?: () => Promise<PermissionState>;
    };

    if (typeof DOE.requestPermission === "function") {
      // ── iOS 13+ path ─────────────────────────────────────────────────
      try {
        const response = await DOE.requestPermission();
        setPermission(response);
        if (response === "granted") {
          window.addEventListener("deviceorientation", handleOrientation as EventListener);
        }
      } catch {
        setPermission("error");
      }
    } else {
      // ── Android / non-iOS path ────────────────────────────────────────
      // [STEP 9] Register `deviceorientationabsolute` first — this is the
      // event that provides a genuine magnetic-north heading on Android.
      // If the device or WebView doesn't support it, fall back to the
      // regular (relative) `deviceorientation` event.
      setPermission("granted");

      // Try absolute orientation (Android 7+ / Chrome 75+ WebView).
      window.addEventListener(
        "deviceorientationabsolute",
        handleOrientation as EventListener,
        true,
      );
      hasAbsoluteRef.current = true;

      // Also register the fallback so older devices still get SOME data.
      // The handler checks `event.absolute` to distinguish which fired.
      window.addEventListener("deviceorientation", handleOrientation as EventListener);
    }
  };

  useEffect(() => {
    return () => {
      window.removeEventListener(
        "deviceorientationabsolute",
        handleOrientation as EventListener,
      );
      window.removeEventListener(
        "deviceorientation",
        handleOrientation as EventListener,
      );
    };
  }, [handleOrientation]);

  return {
    permission,
    direction,
    setDirection,
    requestPermission,
    hasSupport,
    needsCalibration,
    setNeedsCalibration,
    isAbsolute,
  };
}
