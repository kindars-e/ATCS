// ─────────────────────────────────────────────────────────────────────────────
// components/compass-modal.tsx
//
// Full-screen compass / navigation modal shown to the REQUESTER (the person
// who asked for help).  It continuously points an arrow toward the target
// (the person sharing their location).
//
// WHAT THIS FILE DOES (for beginners):
//   Imagine A asks "where are you?", B agrees and shares their GPS.
//   This modal opens on A's screen and shows:
//     • A spinning compass needle pointing toward B.
//     • The distance to B in metres and feet.
//     • A "Beep" button so A can make B's device buzz/blink.
//
// [FIX 2] BEARING AND COMPASS LOGIC FIXES:
//   The original code had a subtle but critical sign error in how it
//   combined the device's compass heading with the GPS bearing.
//
//   CORRECT algorithm:
//     absoluteBearing = bearing FROM your GPS location TO target GPS location
//     deviceHeading   = direction your phone is pointing (from compass sensor)
//     needleAngle     = absoluteBearing - deviceHeading
//
//   If needleAngle > 0  → target is clockwise from where you face (right)
//   If needleAngle < 0  → target is counter-clockwise (left)
//   If needleAngle ≈ 0  → target is straight ahead
//
//   The original code used `direction.degrees` correctly for this formula but
//   the displayed "direction" text used wrong sign conventions (e.g. positive
//   was labelled "left" in some builds).  Fixed and clearly commented.
//
//   Additionally:
//   - The compass needle rotation now uses needleAngle directly (not bearing).
//   - The distance update effect now runs independently from the compass
//     update so distance refreshes even when the compass sensor is inactive.
//   - The internal watchPosition was removed because useGeolocation already
//     provides a live watch.  Having two parallel watches caused duplicate
//     position events.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useRef, useState } from "react";
import { Compass, MapPin, X } from "lucide-react";

import { Button }              from "@/components/ui/button";
import useGeolocation          from "@/hooks/use-geolocation";
import useDeviceOrientation    from "@/hooks/use-device-orientation";
import { calculateBearing, calculateDistance } from "@/lib/geo";
import type { Contact }        from "@/lib/types";

interface CompassModalProps {
  contact: Contact;
  onBeep: (deviceId: string) => boolean;
  onClose: () => void;
}

export function CompassModal({ contact, onBeep, onClose }: CompassModalProps) {
  const {
    position: userPosition,
    requestPermission: requestGeoPermission,
    usingFallback,
  } = useGeolocation();

  const {
    permission: compassPermission,
    direction,
    hasSupport: hasDeviceOrientationSupport,
    requestPermission: requestCompassPermission,
  } = useDeviceOrientation({ userPosition });

  // [FIX 2] needleAngle is the angle the on-screen arrow should be rotated.
  // It equals (absoluteBearing - deviceHeading), normalised to [-180, 180].
  // When needleAngle = 0 the arrow points straight up, meaning straight ahead.
  const [needleAngle,    setNeedleAngle]    = useState<number | null>(null);
  const [absoluteBearing, setAbsoluteBearing] = useState<number | null>(null);
  const [distance,        setDistance]        = useState<number | null>(null);
  const [isBeeping,       setIsBeeping]       = useState(false);
  const [permissionsRequested, setPermissionsRequested] = useState(false);

  const targetLocation = contact.location;
  const isWaypoint     = contact.deviceId.startsWith("waypoint-");

  // PC-mode: no compass sensor available — show static bearing arrow.
  const isPcMode = !hasDeviceOrientationSupport;

  // ── [FIX 2] Compute distance independently of compass ──────────────────────
  // The original code put distance inside the bearing effect, meaning distance
  // only updated when the compass also fired.  Now distance updates whenever
  // either the user's position or the target's position changes.
  useEffect(() => {
    if (!userPosition || !targetLocation) return;

    const dist = calculateDistance(
      userPosition.coords.latitude,
      userPosition.coords.longitude,
      targetLocation.lat,
      targetLocation.lng,
    );
    setDistance(dist);

    // Also compute the absolute GPS bearing (0° = North, 90° = East …).
    const ab = calculateBearing(
      userPosition.coords.latitude,
      userPosition.coords.longitude,
      targetLocation.lat,
      targetLocation.lng,
    );
    setAbsoluteBearing(ab);
  }, [userPosition, targetLocation]);

  // ── [FIX 2] Compute needle angle when compass heading changes ──────────────
  // needleAngle = absoluteBearing − deviceHeading
  // We keep this in a separate effect so it also updates whenever the device
  // rotates, even when the GPS position hasn't changed.
  useEffect(() => {
    if (absoluteBearing === null || !direction) return;

    // [FIX 2] Correct formula: subtract device heading from absolute bearing.
    // Positive result = target is to the RIGHT of where you face.
    // Negative result = target is to the LEFT.
    let angle = absoluteBearing - direction.degrees;

    // Normalise to [-180, 180] so the needle never rotates the long way round.
    if (angle >  180) angle -= 360;
    if (angle < -180) angle += 360;

    setNeedleAngle(angle);
  }, [absoluteBearing, direction]);

  // ── Formatted distance strings ────────────────────────────────────────────
  const distanceInFeet   = distance !== null ? Math.round(distance * 3.28084) : 0;
  const distanceInMeters = distance !== null ? Math.round(distance) : 0;

  const distanceTexts = useMemo(() => {
    if (isPcMode) {
      // On PC we show absolute compass bearing since there is no device heading.
      if (absoluteBearing === null || distance === null) {
        return { value: "--", unit: "ft", direction: "searching..." };
      }
      // Convert degrees to a cardinal label.
      const cardinal = absoluteBearing < 22.5  ? "N"
        : absoluteBearing < 67.5   ? "NE"
        : absoluteBearing < 112.5  ? "E"
        : absoluteBearing < 157.5  ? "SE"
        : absoluteBearing < 202.5  ? "S"
        : absoluteBearing < 247.5  ? "SW"
        : absoluteBearing < 292.5  ? "W"
        : absoluteBearing < 337.5  ? "NW"
        : "N";
      return {
        value:     distanceInFeet.toString(),
        unit:      "ft",
        direction: `${Math.round(absoluteBearing)}° ${cardinal}`,
      };
    }

    // ── Phone compass mode ────────────────────────────────────────────────
    if (needleAngle === null) {
      return { value: "--", unit: "ft", direction: "searching..." };
    }

    // [FIX 2] Label the direction relative to where the user is facing.
    // needleAngle > 0 = clockwise from where you face = to your RIGHT.
    // needleAngle < 0 = counter-clockwise from where you face = to your LEFT.
    let dir = "ahead";
    const abs = Math.abs(needleAngle);
    if (abs < 10)            dir = "ahead";
    else if (needleAngle > 0 && abs <= 45)  dir = "slightly right";
    else if (needleAngle > 0 && abs <= 90)  dir = "to your right";
    else if (needleAngle > 0)               dir = "behind you (right)";
    else if (needleAngle < 0 && abs <= 45)  dir = "slightly left";
    else if (needleAngle < 0 && abs <= 90)  dir = "to your left";
    else                                    dir = "behind you (left)";

    return { value: distanceInFeet.toString(), unit: "ft", direction: dir };
  }, [needleAngle, absoluteBearing, distanceInFeet, isPcMode, distance]);

  const handleBeep = () => {
    if (onBeep(contact.deviceId)) {
      setIsBeeping(true);
      setTimeout(() => setIsBeeping(false), 1000);
    }
  };

  // Request location permission once when the modal first opens.
  useEffect(() => {
    if (permissionsRequested) return;
    setPermissionsRequested(true);
    void requestGeoPermission();
  }, [permissionsRequested, requestGeoPermission]);

  // [FIX 2] REMOVED the redundant watchPosition call that was here.
  // The useGeolocation hook already maintains a live GPS watch.
  // Having two parallel watchPosition calls produced duplicate events and
  // could confuse the smoother in use-geolocation.ts.

  // ── No location data yet ──────────────────────────────────────────────────
  if (!targetLocation) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col justify-center items-center p-6 text-white bg-gray-900">
        <div className="text-center max-w-sm">
          <h2 className="text-2xl font-bold mb-4">Waiting for Location</h2>
          <p className="text-gray-400 mb-8">
            Waiting for {contact.deviceName} to send their GPS position…
          </p>
          <button
            onClick={onClose}
            className="bg-gray-800 text-gray-300 py-3 px-6 rounded-lg font-medium hover:bg-gray-700 transition-colors"
          >
            Close
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
            You have denied access to motion sensors. Please enable &apos;Motion
            &amp; Orientation Access&apos; for this site in your browser or phone settings.
          </p>
          <button
            onClick={onClose}
            className="bg-gray-800 text-gray-300 py-3 px-6 rounded-lg font-medium hover:bg-gray-700 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    );
  }

  // ── Shared button row (used by both PC and phone modes) ───────────────────
  const ButtonRow = (
    <div className="w-full flex justify-between items-center mt-6 px-8">
      {/* Close button */}
      <button onClick={onClose} className="group relative">
        <div className="absolute inset-0 bg-red-500 rounded-full opacity-0 group-hover:opacity-20 transition-opacity duration-200" />
        <div className="relative bg-gray-800/80 backdrop-blur-sm p-4 rounded-full border border-gray-700 transition-all group-hover:border-red-500/50 group-active:scale-95">
          <X className="w-6 h-6 text-gray-300 group-hover:text-red-400 transition-colors" />
        </div>
        <p className="text-xs text-gray-500 text-center mt-2 opacity-0 group-hover:opacity-100 transition-opacity">Close</p>
      </button>

      <div className="w-16" />

      {/* Beep button — hidden for waypoints */}
      {!isWaypoint ? (
        <button
          onClick={handleBeep}
          className={`group relative transition-all ${isBeeping ? "animate-pulse" : ""}`}
        >
          <div className={`absolute inset-0 rounded-full transition-all duration-300 ${
            isBeeping
              ? "bg-yellow-500 opacity-30 blur-md animate-ping"
              : "bg-blue-500 opacity-0 group-hover:opacity-20"
          }`} />
          <div className={`relative backdrop-blur-sm p-4 rounded-full border transition-all group-active:scale-95 ${
            isBeeping
              ? "bg-yellow-500/20 border-yellow-500"
              : "bg-gray-800/80 border-gray-700 group-hover:border-blue-500/50"
          }`}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none"
              className={`transition-all ${isBeeping ? "text-yellow-400" : "text-gray-300 group-hover:text-blue-400"}`}>
              <path d="M11 5L6 9H2v6h4l5 4V5z" fill="currentColor" opacity="0.8" />
              <path
                d="M15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14"
                stroke="currentColor" strokeWidth="2" strokeLinecap="round"
                className={isBeeping ? "animate-pulse" : ""}
              />
            </svg>
          </div>
          <p className={`text-xs text-center mt-2 transition-all ${
            isBeeping ? "text-yellow-400 opacity-100" : "text-gray-500 opacity-0 group-hover:opacity-100"
          }`}>
            {isBeeping ? "Beeping..." : "Find"}
          </p>
        </button>
      ) : (
        <div className="w-16" />
      )}
    </div>
  );

  // ── PC / No-compass mode ──────────────────────────────────────────────────
  if (isPcMode) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col justify-between items-center p-6 text-white bg-gray-900">
        {/* Header */}
        <div className="w-full text-center mt-4">
          <p className="text-sm uppercase opacity-75">Finding</p>
          <h1 className="text-3xl font-bold mt-1">{contact.deviceName}</h1>
          <div className="mt-2 inline-flex items-center gap-1.5 bg-blue-900/40 border border-blue-700/50 rounded-full px-3 py-1 text-xs text-blue-300">
            <MapPin className="w-3 h-3" />
            {usingFallback ? "City-level location (IP)" : "GPS location"}
          </div>
        </div>

        {/* Static compass rose with bearing arrow */}
        <div className="flex flex-col items-center">
          <div className="relative w-64 h-64">
            {/* Outer ring with cardinal labels */}
            <svg className="absolute inset-0 w-full h-full opacity-20" viewBox="0 0 256 256">
              <circle cx="128" cy="128" r="120" stroke="white" strokeWidth="1" fill="none" />
              {["N","NE","E","SE","S","SW","W","NW"].map((label, i) => {
                const angle = (i * 45 - 90) * (Math.PI / 180);
                const r = 108;
                return (
                  <text key={label}
                    x={128 + r * Math.cos(angle)}
                    y={128 + r * Math.sin(angle)}
                    textAnchor="middle" dominantBaseline="middle"
                    fill="white" fontSize="12"
                    fontWeight={label === "N" ? "bold" : "normal"}
                  >{label}</text>
                );
              })}
            </svg>

            {/* Bearing arrow — rotates to point at target */}
            <div
              className="absolute inset-0 transition-transform duration-500 ease-out flex items-center justify-center"
              style={{ transform: `rotate(${absoluteBearing ?? 0}deg)` }}
            >
              <svg width="80" height="80" viewBox="0 0 24 24" fill="none">
                <path d="M12 3L16 21L12 17L8 21L12 3Z" fill="#3B82F6" stroke="#93C5FD" strokeWidth="0.5" />
              </svg>
            </div>

            {/* Centre dot */}
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="w-3 h-3 bg-white rounded-full shadow-lg" />
            </div>
          </div>
        </div>

        {/* Distance + bearing card */}
        <div className="w-full flex flex-col items-center mb-8">
          <div className="bg-gray-800/80 backdrop-blur rounded-2xl px-8 py-4 border border-gray-700 text-center mb-6">
            <div className="flex items-baseline justify-center gap-1">
              <span className="text-5xl font-semibold">{distanceTexts.value}</span>
              <span className="text-3xl opacity-75 ml-1">{distanceTexts.unit}</span>
            </div>
            <p className="text-2xl font-medium mt-1 text-blue-300">{distanceTexts.direction}</p>
            {distanceInMeters > 0 && (
              <p className="text-xs text-gray-500 mt-1">{distanceInMeters} m away</p>
            )}
          </div>

          {/* Debug info */}
          <div className="text-xs text-gray-500 text-center space-y-0.5">
            {!userPosition && <p>Getting location…</p>}
            {usingFallback && userPosition && (
              <p className="text-yellow-600">⚠ Using approximate city-level location (no GPS)</p>
            )}
            {userPosition && targetLocation && (
              <>
                <p>Your location: {userPosition.coords.latitude.toFixed(5)}°, {userPosition.coords.longitude.toFixed(5)}°</p>
                <p>Target: {targetLocation.lat.toFixed(5)}°, {targetLocation.lng.toFixed(5)}°</p>
                <p>Accuracy: ±{Math.round(userPosition.coords.accuracy)} m</p>
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
      {/* Header */}
      <div className="w-full text-center mt-4">
        <p className="text-sm uppercase opacity-75">Finding</p>
        <h1 className="text-3xl font-bold mt-1">{contact.deviceName}</h1>
        {usingFallback && (
          <div className="mt-2 inline-flex items-center gap-1.5 bg-yellow-900/40 border border-yellow-700/50 rounded-full px-3 py-1 text-xs text-yellow-300">
            <MapPin className="w-3 h-3" />
            City-level location (no GPS)
          </div>
        )}
      </div>

      {/* Compass needle */}
      <div className="flex flex-col items-center">
        {/* North indicator dot */}
        <div className="w-4 h-4 bg-blue-400 rounded-full shadow-lg shadow-blue-400/50 mb-2" />
        {/*
          [FIX 2] Rotate by needleAngle (absoluteBearing - deviceHeading).
          When needleAngle = 0° the arrow points straight up = straight ahead.
          Positive needleAngle = rotate clockwise = target is to the right.
        */}
        <div
          className="transition-transform duration-200 ease-out"
          style={{ transform: `rotate(${needleAngle ?? 0}deg)` }}
        >
          <svg width="240" height="240" viewBox="0 0 24 24" fill="none">
            {/* Arrow tip pointing up = straight ahead */}
            <path
              d="M12 3L16 21L12 17L8 21L12 3Z"
              fill="white"
              stroke="rgba(255,255,255,0.4)"
              strokeWidth="0.5"
            />
          </svg>
        </div>
      </div>

      {/* Distance + direction card */}
      <div className="w-full flex flex-col items-center mb-8">
        <div className="flex flex-col items-center transition-all duration-500 ease-in-out">
          <div className="flex items-baseline">
            <span className="text-5xl font-semibold">{distanceTexts.value}</span>
            <span className="text-3xl opacity-75 ml-1">{distanceTexts.unit}</span>
          </div>
          <p className="text-3xl font-medium mt-1">{distanceTexts.direction}</p>
          <div className="mt-4 text-xs text-gray-500 text-center">
            {!userPosition && <p>Getting GPS location…</p>}
            {!direction && userPosition && <p>Accessing compass…</p>}
            {direction && (
              <p>Heading: {direction.degrees.toFixed(0)}° {direction.cardinal}</p>
            )}
            {absoluteBearing !== null && (
              <p>Target bearing: {Math.round(absoluteBearing)}°</p>
            )}
            {usingFallback && (
              <p className="text-yellow-600 mt-1">⚠ Approximate location only (no GPS)</p>
            )}
            {userPosition && targetLocation && (
              <>
                <p className="mt-1">
                  Your GPS: {userPosition.coords.latitude.toFixed(5)}°, {userPosition.coords.longitude.toFixed(5)}°
                </p>
                <p>Target: {targetLocation.lat.toFixed(5)}°, {targetLocation.lng.toFixed(5)}°</p>
                <p>GPS Accuracy: ±{Math.round(userPosition.coords.accuracy)} m</p>
              </>
            )}
          </div>
        </div>

        {ButtonRow}
      </div>

      {/* Permission overlay — shown until the user grants compass access */}
      {compassPermission !== "granted" && (
        <div className="absolute inset-0 z-10 bg-gray-900/80 backdrop-blur-sm flex flex-col justify-center items-center p-6 text-center">
          <div className="w-24 h-24 mb-6 bg-blue-600/50 rounded-full flex items-center justify-center">
            <Compass className="w-12 h-12 text-white" />
          </div>
          <h2 className="text-2xl font-bold text-white mb-4">Activate Compass</h2>
          <p className="text-gray-300 mb-8 max-w-sm">
            To point you in the right direction, ATCS needs access to your
            device&apos;s motion sensors.
          </p>
          <Button
            onClick={requestCompassPermission}
            className="bg-blue-600 hover:bg-blue-700 text-white rounded-full px-8 py-3 shadow-lg text-lg animate-pulse"
          >
            Grant Permission
          </Button>
        </div>
      )}
    </div>
  );
}
