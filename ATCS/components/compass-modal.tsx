// ─────────────────────────────────────────────────────────────────────────────
// components/compass-modal.tsx
//
// [STEP 9 FINAL] Complete bearing pipeline redesign to fix flickering,
// distance instability, and offline-contact navigation.
//
// ROOT CAUSES FIXED:
//
// 1. CSS transition was causing the flicker, not preventing it.
//    compass events fire every ~100ms; the 200ms transition never completed
//    before the next event started a new one → perpetual "chasing" animation.
//    FIX: removed ALL CSS transitions from the needle. The EMA filter in
//    use-device-orientation.ts handles smoothing at the sensor level.
//
// 2. Two-effect pipeline created race conditions.
//    GPS changes set absoluteBearing (React state) → triggered a SECOND effect
//    that read the now-stale direction → transient wrong needle position.
//    FIX: single combined effect with refs for intermediate values. Only
//    React state is updated when the change exceeds a visible threshold.
//
// 3. ±180° CSS interpolation jump.
//    Without CSS transition this is a non-issue (values are visually the same),
//    but the EMA via angularDiff also naturally prevents the jump.
//
// 4. GPS distance instability.
//    GPS horizontal accuracy is typically 5–50m indoors. Two phones touching
//    can still show 30m "distance" because both GPS positions carry error.
//    FIX: EMA smoothing on distance + accuracy-aware display that shows the
//    margin of error when it exceeds the measured distance.
//
// 5. Offline contact — navigation continues regardless.
//    FIX: explicit offline check; shows a clear warning state.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useRef, useState } from "react";
import { Compass, MapPin, WifiOff, X } from "lucide-react";

import { Button }           from "@/components/ui/button";
import useGeolocation       from "@/hooks/use-geolocation";
import useDeviceOrientation from "@/hooks/use-device-orientation";
import { calculateBearing, calculateDistance } from "@/lib/geo";
import { LOCATION_STALE_MS, LOCATION_LOST_MS } from "@/lib/constants";
import type { Contact } from "@/lib/types";

interface CompassModalProps {
  contact: Contact;
  onBeep: (deviceId: string) => boolean;
  /** Fully end navigation and reset session state. */
  onClose: () => void;
  /**
   * [Step 9] Minimise the compass WITHOUT ending the session.
   * When provided, the X button calls this instead of onClose,
   * leaving the navigation session active in the background.
   */
  onMinimize?: () => void;
}

function formatAge(ms: number): string {
  if (ms < 1000) return "just now";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  return `${Math.round(ms / 60_000)}m ago`;
}

/** Shortest signed angular difference from a → b (always in [-180, 180]). */
function angularDiff(a: number, b: number): number {
  let d = b - a;
  while (d >  180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

// EMA alphas. Higher = more responsive, more jitter. Lower = smoother, more lag.
// GPS bearing changes slowly and noisily → lower alpha.
// Needle angle follows compass sensor (already EMA'd in use-device-orientation)
// → medium alpha.
// Distance: medium alpha, but we skip updates < 1m for UI stability.
const GPS_BEARING_ALPHA = 0.30;  // smoothes GPS-derived bearing to target
const NEEDLE_ALPHA      = 0.40;  // smoothes the final needle angle
const DISTANCE_ALPHA    = 0.30;  // smoothes raw distance calculation

export function CompassModal({
  contact,
  onBeep,
  onClose,
  onMinimize,
}: CompassModalProps) {
  const {
    position: userPosition,
    requestPermission: requestGeoPermission,
    usingFallback,
  } = useGeolocation();

  // Tick clock for "X ago" staleness display — fires every second, not
  // every sensor reading, so it doesn't contribute to rendering cost.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const {
    permission: compassPermission,
    direction,
    hasSupport: hasDeviceOrientationSupport,
    requestPermission: requestCompassPermission,
    isAbsolute: compassIsAbsolute,
  } = useDeviceOrientation({ userPosition });

  // ── [Step 9] All intermediate values live in REFS (no extra re-renders).
  // React state is updated only when the rendered value needs to change.
  const smoothedAbsBearingRef = useRef<number | null>(null); // GPS bearing EMA
  const smoothedNeedleRef     = useRef<number | null>(null); // needle angle EMA
  const smoothedDistanceRef   = useRef<number | null>(null); // distance EMA
  const lastRenderedNeedle    = useRef<number>(0);           // skip threshold guard

  // These are the values that drive the render.
  const [displayNeedle,   setDisplayNeedle]   = useState<number>(0);
  const [displayBearing,  setDisplayBearing]  = useState<number | null>(null);
  const [displayDistance, setDisplayDistance] = useState<number | null>(null);
  const [isBeeping,       setIsBeeping]       = useState(false);
  const [permissionsRequested, setPermissionsRequested] = useState(false);

  const targetLocation = contact.location;
  const isWaypoint     = contact.deviceId.startsWith("waypoint-");
  const isPcMode       = !hasDeviceOrientationSupport;

  // ── [Step 9 — Issue 5] Offline check ──────────────────────────────────────
  const isContactOffline =
    !isWaypoint &&
    contact.reachability === "offline";

  // ── [Step 9] SINGLE unified effect for all bearing/distance computations ──
  // Previously two effects: one for GPS (→ absoluteBearing state), one for
  // compass (→ needleAngle state). The state hop between them caused transient
  // wrong angles when a compass event fired between the two updates.
  // Now: everything is computed synchronously inside one effect.
  useEffect(() => {
    if (!userPosition || !targetLocation) return;

    const myLat = userPosition.coords.latitude;
    const myLng = userPosition.coords.longitude;

    // ── 1. GPS bearing to target (smoothed with EMA) ──────────────────────
    const rawAbsBearing = calculateBearing(myLat, myLng, targetLocation.lat, targetLocation.lng);
    const prevAbsBearing = smoothedAbsBearingRef.current;
    const smoothedAbsBearing = prevAbsBearing === null
      ? rawAbsBearing
      : ((prevAbsBearing + GPS_BEARING_ALPHA * angularDiff(prevAbsBearing, rawAbsBearing)) + 360) % 360;
    smoothedAbsBearingRef.current = smoothedAbsBearing;
    setDisplayBearing(Math.round(smoothedAbsBearing));

    // ── 2. Distance (smoothed with EMA) ──────────────────────────────────
    const rawDist = calculateDistance(myLat, myLng, targetLocation.lat, targetLocation.lng);
    const prevDist = smoothedDistanceRef.current;
    const smoothedDist = prevDist === null
      ? rawDist
      : prevDist * (1 - DISTANCE_ALPHA) + rawDist * DISTANCE_ALPHA;
    smoothedDistanceRef.current = smoothedDist;
    // Only update UI if distance changed by ≥ 1 m to prevent micro-jitter
    if (displayDistance === null || Math.abs(smoothedDist - displayDistance) >= 1) {
      setDisplayDistance(smoothedDist);
    }

    // ── 3. Needle angle (GPS bearing − device heading, then EMA) ─────────
    // Only compute if we have a compass heading.
    if (!direction) return;

    const rawNeedle = smoothedAbsBearing - direction.degrees;
    // Normalise raw needle to [-180, 180].
    const normalised = ((rawNeedle + 180 + 360) % 360) - 180;

    // EMA on the needle angle, using angularDiff to handle the ±180° boundary.
    const prevNeedle = smoothedNeedleRef.current;
    const smoothedNeedle = prevNeedle === null
      ? normalised
      : prevNeedle + NEEDLE_ALPHA * angularDiff(prevNeedle, normalised);
    smoothedNeedleRef.current = smoothedNeedle;

    // Skip re-render if the change is less than half a degree — human eye
    // can't perceive it and it prevents pointless React reconciliations.
    if (Math.abs(angularDiff(lastRenderedNeedle.current, smoothedNeedle)) >= 0.5) {
      const rounded = Math.round(smoothedNeedle * 10) / 10;
      lastRenderedNeedle.current = rounded;
      setDisplayNeedle(rounded);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userPosition, targetLocation, direction]); // displayDistance intentionally excluded

  // ── Staleness & accuracy ──────────────────────────────────────────────────
  const locationAgeMs  = targetLocation ? now - new Date(targetLocation.timestamp).getTime() : null;
  const isStale = !isWaypoint && locationAgeMs !== null && locationAgeMs > LOCATION_STALE_MS;
  const isLost  = !isWaypoint && locationAgeMs !== null && locationAgeMs > LOCATION_LOST_MS;

  // [Step 9 — Issue 4] Accuracy-aware distance display.
  // If the combined GPS uncertainty (my error + their error) exceeds the
  // measured distance, the number is noise — show "< Xm" instead.
  const myAccuracy     = userPosition?.coords.accuracy ?? null;
  const targetAccuracy = targetLocation?.accuracy ?? null;
  const totalAccuracy  = myAccuracy !== null && targetAccuracy !== null
    ? myAccuracy + targetAccuracy
    : myAccuracy ?? null;

  const distanceIsWithinAccuracy =
    displayDistance !== null && totalAccuracy !== null && displayDistance < totalAccuracy;

  const distanceInFeet   = displayDistance !== null ? Math.round(displayDistance * 3.28084) : 0;
  const distanceInMeters = displayDistance !== null ? Math.round(displayDistance) : 0;

  const distanceTexts = useMemo(() => {
    if (isPcMode) {
      if (displayBearing === null || displayDistance === null) {
        return { value: "--", unit: "ft", direction: "searching..." };
      }
      const dirs = ["N","NE","E","SE","S","SW","W","NW"];
      const cardinal = dirs[Math.round(displayBearing / 45) % 8];
      const distDisplay = distanceIsWithinAccuracy
        ? `< ${Math.round(totalAccuracy!)} m`
        : `${distanceInFeet} ft`;
      return { value: distDisplay, unit: "", direction: `${displayBearing}° ${cardinal}` };
    }

    if (displayBearing === null) {
      return { value: "--", unit: "ft", direction: "searching..." };
    }

    let dir = "ahead";
    const abs = Math.abs(displayNeedle);
    if      (abs < 10)                        dir = "ahead";
    else if (displayNeedle > 0 && abs <= 45)  dir = "slightly right";
    else if (displayNeedle > 0 && abs <= 90)  dir = "to your right";
    else if (displayNeedle > 0)               dir = "behind (right)";
    else if (displayNeedle < 0 && abs <= 45)  dir = "slightly left";
    else if (displayNeedle < 0 && abs <= 90)  dir = "to your left";
    else                                      dir = "behind (left)";

    return {
      value:     distanceIsWithinAccuracy ? `~${Math.round(totalAccuracy!)}` : distanceInFeet.toString(),
      unit:      "ft",
      direction: dir,
    };
  }, [isPcMode, displayBearing, displayDistance, displayNeedle, distanceInFeet, distanceIsWithinAccuracy, totalAccuracy]);

  const handleBeep = () => {
    if (onBeep(contact.deviceId)) {
      setIsBeeping(true);
      setTimeout(() => setIsBeeping(false), 1000);
    }
  };

  useEffect(() => {
    if (permissionsRequested) return;
    setPermissionsRequested(true);
    void requestGeoPermission();
  }, [permissionsRequested, requestGeoPermission]);

  // Shared close/minimize: X button minimizes if possible, otherwise closes.
  const handleDismiss = onMinimize ?? onClose;

  // Shared button row
  const ButtonRow = (
    <div className="w-full flex justify-between items-center mt-6 px-8">
      <button onClick={handleDismiss} className="group relative">
        <div className="absolute inset-0 bg-red-500 rounded-full opacity-0 group-hover:opacity-20 transition-opacity duration-200" />
        <div className="relative bg-gray-800/80 backdrop-blur-sm p-4 rounded-full border border-gray-700 transition-all group-hover:border-red-500/50 group-active:scale-95">
          <X className="w-6 h-6 text-gray-300 group-hover:text-red-400 transition-colors" />
        </div>
        <p className="text-xs text-gray-500 text-center mt-2 opacity-0 group-hover:opacity-100 transition-opacity">
          {onMinimize ? "Minimise" : "Close"}
        </p>
      </button>

      <div className="w-16" />

      {!isWaypoint ? (
        <button onClick={handleBeep} className={`group relative transition-all ${isBeeping ? "animate-pulse" : ""}`}>
          <div className={`absolute inset-0 rounded-full transition-all duration-300 ${
            isBeeping ? "bg-yellow-500 opacity-30 blur-md animate-ping" : "bg-blue-500 opacity-0 group-hover:opacity-20"
          }`} />
          <div className={`relative backdrop-blur-sm p-4 rounded-full border transition-all group-active:scale-95 ${
            isBeeping ? "bg-yellow-500/20 border-yellow-500" : "bg-gray-800/80 border-gray-700 group-hover:border-blue-500/50"
          }`}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none"
              className={`transition-all ${isBeeping ? "text-yellow-400" : "text-gray-300 group-hover:text-blue-400"}`}>
              <path d="M11 5L6 9H2v6h4l5 4V5z" fill="currentColor" opacity="0.8" />
              <path d="M15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14"
                stroke="currentColor" strokeWidth="2" strokeLinecap="round"
                className={isBeeping ? "animate-pulse" : ""} />
            </svg>
          </div>
          <p className={`text-xs text-center mt-2 transition-all ${
            isBeeping ? "text-yellow-400 opacity-100" : "text-gray-500 opacity-0 group-hover:opacity-100"
          }`}>
            {isBeeping ? "Beeping..." : "Find"}
          </p>
        </button>
      ) : <div className="w-16" />}
    </div>
  );

  // ── [Step 9 — Issue 5] Offline warning overlay ────────────────────────────
  if (isContactOffline) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col justify-center items-center p-6 text-white bg-gray-900">
        <div className="text-center max-w-sm">
          <div className="w-24 h-24 mx-auto mb-6 bg-red-900/50 rounded-full flex items-center justify-center">
            <WifiOff className="w-12 h-12 text-red-400" />
          </div>
          <h2 className="text-2xl font-bold mb-3">Contact Offline</h2>
          <p className="text-gray-400 mb-2">
            {contact.deviceName} is no longer reachable over the mesh.
          </p>
          <p className="text-gray-500 text-sm mb-8">
            Navigation paused. Last known location is preserved — you can resume
            once the contact comes back online.
          </p>
          <Button onClick={handleDismiss} className="bg-gray-700 hover:bg-gray-600 px-8">
            Dismiss
          </Button>
        </div>
      </div>
    );
  }

  // ── No location data yet ──────────────────────────────────────────────────
  if (!targetLocation) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col justify-center items-center p-6 text-white bg-gray-900">
        <div className="text-center max-w-sm">
          <h2 className="text-2xl font-bold mb-4">Waiting for Location</h2>
          <p className="text-gray-400 mb-8">
            Waiting for {contact.deviceName} to send their GPS position…
          </p>
          <button onClick={handleDismiss}
            className="bg-gray-800 text-gray-300 py-3 px-6 rounded-lg font-medium hover:bg-gray-700 transition-colors">
            {onMinimize ? "Minimise" : "Close"}
          </button>
        </div>
      </div>
    );
  }

  // ── Compass permission denied ─────────────────────────────────────────────
  if (compassPermission === "denied") {
    return (
      <div className="fixed inset-0 z-50 flex flex-col justify-center items-center p-6 text-white bg-gray-900">
        <div className="text-center max-w-sm">
          <div className="w-24 h-24 mx-auto mb-6 bg-red-600 rounded-full flex items-center justify-center">
            <X className="w-12 h-12 text-white" />
          </div>
          <h2 className="text-2xl font-bold mb-4">Permission Denied</h2>
          <p className="text-gray-400 mb-8">
            Enable Motion & Orientation Access for this app in Settings.
          </p>
          <button onClick={handleDismiss}
            className="bg-gray-800 text-gray-300 py-3 px-6 rounded-lg font-medium hover:bg-gray-700 transition-colors">
            {onMinimize ? "Minimise" : "Close"}
          </button>
        </div>
      </div>
    );
  }

  // ── PC / no-compass mode ──────────────────────────────────────────────────
  if (isPcMode) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col justify-between items-center p-6 text-white bg-gray-900">
        <div className="w-full text-center mt-4">
          <p className="text-sm uppercase opacity-75">Finding</p>
          <h1 className="text-3xl font-bold mt-1">{contact.deviceName}</h1>
          <div className="mt-2 inline-flex items-center gap-1.5 bg-blue-900/40 border border-blue-700/50 rounded-full px-3 py-1 text-xs text-blue-300">
            <MapPin className="w-3 h-3" />
            {usingFallback ? "City-level location (IP)" : "GPS location"}
          </div>
        </div>

        <div className="flex flex-col items-center">
          <div className="relative w-64 h-64">
            <svg className="absolute inset-0 w-full h-full opacity-20" viewBox="0 0 256 256">
              <circle cx="128" cy="128" r="120" stroke="white" strokeWidth="1" fill="none" />
              {["N","NE","E","SE","S","SW","W","NW"].map((label, i) => {
                const angle = (i * 45 - 90) * (Math.PI / 180);
                const r = 108;
                return (
                  <text key={label} x={128 + r * Math.cos(angle)} y={128 + r * Math.sin(angle)}
                    textAnchor="middle" dominantBaseline="middle" fill="white"
                    fontSize="12" fontWeight={label === "N" ? "bold" : "normal"}>
                    {label}
                  </text>
                );
              })}
            </svg>
            {/* No CSS transition — bearing updates are direct */}
            <div className="absolute inset-0 flex items-center justify-center"
              style={{ transform: `rotate(${displayBearing ?? 0}deg)` }}>
              <svg width="80" height="80" viewBox="0 0 24 24" fill="none">
                <path d="M12 3L16 21L12 17L8 21L12 3Z" fill="#3B82F6" stroke="#93C5FD" strokeWidth="0.5" />
              </svg>
            </div>
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="w-3 h-3 bg-white rounded-full shadow-lg" />
            </div>
          </div>
        </div>

        <div className="w-full flex flex-col items-center mb-8">
          <div className="bg-gray-800/80 backdrop-blur rounded-2xl px-8 py-4 border border-gray-700 text-center mb-6">
            <div className="flex items-baseline justify-center gap-1">
              <span className="text-5xl font-semibold">{distanceTexts.value}</span>
              {distanceTexts.unit && <span className="text-3xl opacity-75 ml-1">{distanceTexts.unit}</span>}
            </div>
            <p className="text-2xl font-medium mt-1 text-blue-300">{distanceTexts.direction}</p>
            {distanceInMeters > 0 && (
              <p className="text-xs text-gray-500 mt-1">
                {distanceIsWithinAccuracy
                  ? `Within GPS error margin (±${Math.round(totalAccuracy!)} m)`
                  : `${distanceInMeters} m away`}
              </p>
            )}
            {locationAgeMs !== null && !isWaypoint && (
              <p className={`text-xs mt-1 ${isLost ? "text-red-400" : isStale ? "text-yellow-500" : "text-gray-500"}`}>
                {isLost ? `⚠ Last seen ${formatAge(locationAgeMs)}`
                  : isStale ? `Last updated ${formatAge(locationAgeMs)}`
                  : `Updated ${formatAge(locationAgeMs)}`}
              </p>
            )}
          </div>
          <div className="text-xs text-gray-500 text-center space-y-0.5">
            {!userPosition && <p>Getting location…</p>}
            {usingFallback && userPosition && <p className="text-yellow-600">⚠ Approximate location only (no GPS)</p>}
            {userPosition && targetLocation && (
              <>
                <p>Your GPS: {userPosition.coords.latitude.toFixed(5)}°, {userPosition.coords.longitude.toFixed(5)}°</p>
                <p>Target:   {targetLocation.lat.toFixed(5)}°, {targetLocation.lng.toFixed(5)}°</p>
                <p>My accuracy: ±{Math.round(userPosition.coords.accuracy)} m
                  {targetAccuracy !== null && ` · Target: ±${Math.round(targetAccuracy)} m`}
                </p>
              </>
            )}
          </div>
          {ButtonRow}
        </div>
      </div>
    );
  }

  // ── Phone compass mode ────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-between items-center p-6 text-white bg-gray-900">
      <div className="w-full text-center mt-4">
        <p className="text-sm uppercase opacity-75">Finding</p>
        <h1 className="text-3xl font-bold mt-1">{contact.deviceName}</h1>
        {usingFallback && (
          <div className="mt-2 inline-flex items-center gap-1.5 bg-yellow-900/40 border border-yellow-700/50 rounded-full px-3 py-1 text-xs text-yellow-300">
            <MapPin className="w-3 h-3" />City-level location (no GPS)
          </div>
        )}
      </div>

      {/* Compass needle — NO CSS transition (EMA provides the smoothing) */}
      <div className="flex flex-col items-center">
        <div className="w-4 h-4 bg-blue-400 rounded-full shadow-lg shadow-blue-400/50 mb-2" />
        <div
          style={{
            transform: `rotate(${displayNeedle}deg)`,
            // [Step 9] Removed transition-transform entirely.
            // The EMA filter in use-device-orientation + NEEDLE_ALPHA above
            // provide all the visual smoothing needed. The old CSS transition
            // was re-triggering every 100ms → perpetual "chasing" animation.
          }}
        >
          <svg width="240" height="240" viewBox="0 0 24 24" fill="none">
            <path d="M12 3L16 21L12 17L8 21L12 3Z" fill="white"
              stroke="rgba(255,255,255,0.4)" strokeWidth="0.5" />
          </svg>
        </div>
      </div>

      {/* Distance + direction card — no animation on the card itself */}
      <div className="w-full flex flex-col items-center mb-8">
        <div className="flex flex-col items-center">
          <div className="flex items-baseline">
            <span className="text-5xl font-semibold">{distanceTexts.value}</span>
            {distanceTexts.unit && <span className="text-3xl opacity-75 ml-1">{distanceTexts.unit}</span>}
          </div>
          <p className="text-3xl font-medium mt-1">{distanceTexts.direction}</p>

          {/* [Step 9] Accuracy caveat when GPS error exceeds measured distance */}
          {distanceIsWithinAccuracy && totalAccuracy !== null && (
            <p className="text-xs text-amber-400 mt-1 text-center px-4">
              Within GPS error margin — actual distance unknown (±{Math.round(totalAccuracy)} m)
            </p>
          )}

          {/* [Step 6] Staleness */}
          {locationAgeMs !== null && !isWaypoint && (
            <p className={`text-xs mt-1 ${isLost ? "text-red-400" : isStale ? "text-yellow-500" : "text-gray-500"}`}>
              {isLost ? `⚠ Last seen ${formatAge(locationAgeMs)} — may no longer be accurate`
                : isStale ? `Last updated ${formatAge(locationAgeMs)}`
                : `Updated ${formatAge(locationAgeMs)}`}
            </p>
          )}

          <div className="mt-4 text-xs text-gray-500 text-center">
            {!userPosition && <p>Getting GPS location…</p>}
            {!direction && userPosition && <p>Accessing compass…</p>}
            {direction && (
              <p>
                Heading: {direction.degrees.toFixed(0)}° {direction.cardinal}
                <span className={`ml-2 ${compassIsAbsolute ? "text-emerald-400" : "text-amber-400"}`}>
                  {compassIsAbsolute ? "● calibrated" : "● move in a figure-8"}
                </span>
              </p>
            )}
            {displayBearing !== null && <p>Target: {displayBearing}°</p>}
            {userPosition && targetLocation && (
              <>
                <p>Your GPS: {userPosition.coords.latitude.toFixed(5)}°, {userPosition.coords.longitude.toFixed(5)}°</p>
                <p>Target: {targetLocation.lat.toFixed(5)}°, {targetLocation.lng.toFixed(5)}°</p>
                <p>My accuracy: ±{Math.round(userPosition.coords.accuracy)} m
                  {targetAccuracy !== null && ` · Target: ±${Math.round(targetAccuracy)} m`}
                </p>
              </>
            )}
            {usingFallback && <p className="text-yellow-600 mt-1">⚠ Approximate location only (no GPS)</p>}
          </div>
        </div>

        {ButtonRow}
      </div>

      {/* Compass permission overlay */}
      {compassPermission !== "granted" && (
        <div className="absolute inset-0 z-10 bg-gray-900/80 backdrop-blur-sm flex flex-col justify-center items-center p-6 text-center">
          <div className="w-24 h-24 mb-6 bg-blue-600/50 rounded-full flex items-center justify-center">
            <Compass className="w-12 h-12 text-white" />
          </div>
          <h2 className="text-2xl font-bold text-white mb-4">Activate Compass</h2>
          <p className="text-gray-300 mb-8 max-w-sm">
            ATCS needs access to motion sensors to point you in the right direction.
          </p>
          <Button onClick={requestCompassPermission}
            className="bg-blue-600 hover:bg-blue-700 text-white rounded-full px-8 py-3 shadow-lg text-lg animate-pulse">
            Grant Permission
          </Button>
        </div>
      )}
    </div>
  );
}
