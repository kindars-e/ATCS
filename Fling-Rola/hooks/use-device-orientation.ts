// ─────────────────────────────────────────────────────────────────────────────
// hooks/use-device-orientation.ts
//
// Reads the phone's compass (gyroscope/magnetometer) to determine which
// direction the user is physically facing.
//
// WHAT THIS HOOK DOES (for beginners):
//   Mobile phones have a built-in compass chip.  This hook listens to that
//   chip and returns a "direction" object with degrees (0–360) and a
//   cardinal label like "N", "NE", "SW" etc.
//   On iOS we need to ask for permission before reading the compass.
//   On desktop PCs there is no compass, so hasSupport returns false.
//
// [FIX 2] CHANGES FROM ORIGINAL:
//   - Added an Exponential Moving Average (EMA) filter on the raw alpha/
//     compass heading values.  This smooths out jitter without adding lag.
//   - The original code called setDirection on every single sensor event.
//     With EMA, tiny fluctuations are dampened so the needle on screen
//     moves smoothly rather than jumping around.
//   - Added wrap-around handling for the 359° → 0° boundary so the EMA
//     filter does not average through the wrong half of the circle.
//   - Calibration detection unchanged (still works as before).
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

// [FIX 2] EMA smoothing factor for compass heading.
// 0.2 means: 20% new reading, 80% of the previous smoothed value.
// Lower values = smoother but slightly more lag.
// 0.2 is a good balance for a hand-held compass needle.
const HEADING_EMA_ALPHA = 0.2;

// Helper: shortest angular distance between two headings (degrees).
// Needed because 359° → 1° is only 2° apart, not 358°.
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

  // [FIX 2] Smooth heading using EMA — stored in a ref so updates are cheap.
  const smoothedHeadingRef  = useRef<number | null>(null);
  const lastAlphaValues     = useRef<number[]>([]);

  const checkCalibrationNeeded = useCallback((alpha: number) => {
    const buf = lastAlphaValues.current;
    buf.push(alpha);
    if (buf.length > 10) buf.shift();

    if (buf.length === 10) {
      const allSame = buf.every((val) => Math.abs(val - buf[0]) < 0.1);
      // Ignore differences near the 360/0 boundary.
      const tooJumpy = buf.some((val, i) => {
        if (i === 0) return false;
        const diff = Math.abs(val - buf[i - 1]);
        return diff > 40 && diff < 320;
      });
      setNeedsCalibration(allSame || tooJumpy);
    }
  }, []);

  const handleOrientation = useCallback(
    (event: ExtendedDeviceOrientationEvent) => {
      let rawHeading = 0;

      if (event?.webkitCompassHeading != null) {
        // iOS provides a calibrated compass heading directly.
        rawHeading = event.webkitCompassHeading;
        setNeedsCalibration(false);
      } else if (event.alpha !== null) {
        checkCalibrationNeeded(event.alpha);
        const screenOrientation = window.screen.orientation?.angle || 0;
        rawHeading = (360 - event.alpha + screenOrientation) % 360;
      } else {
        setHasSupport(false);
        setDirection({ degrees: 0, cardinal: "N" });
        return;
      }

      // [FIX 2] Apply EMA filter to smooth out jitter.
      // On the very first reading we initialise the smoothed value directly.
      let smoothed: number;
      if (smoothedHeadingRef.current === null) {
        smoothed = rawHeading;
      } else {
        // Use the angular difference to handle the 359°/0° wrap-around.
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
      // iOS 13+ requires explicit user permission for motion sensors.
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
      // Android / non-iOS: no permission prompt needed.
      window.addEventListener("deviceorientation", handleOrientation as EventListener);
      setPermission("granted");
    }
  };

  useEffect(() => {
    return () => {
      window.removeEventListener("deviceorientation", handleOrientation as EventListener);
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
  };
}
