// ─────────────────────────────────────────────────────────────────────────────
// components/waypoint-manager-modal.tsx
//
// [STEP 9] Redesigned waypoint system — GPS-capture and manual-coordinate
// entry, NOT a map tap interface (the dark Leaflet map without tiles gave no
// useful spatial context).
//
// What this does:
//   • Lists all saved named waypoints with distance-to-user when GPS is active.
//   • "Capture current GPS" — saves your exact position right now.
//   • "Enter coordinates" — paste/type lat,lng for a known location.
//   • Tap "Navigate" on any waypoint → opens the Compass pointed at it.
//   • Swipe/tap to delete waypoints.
//   • SOS waypoints (auto-created when an SOS location arrives) are highlighted.
//
// Fully offline: no network required for any of this.
// ─────────────────────────────────────────────────────────────────────────────

"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle, Check, Compass, Droplets, Edit3,
  MapPin, Plus, Star, Tent, Trash2, X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { calculateDistance } from "@/lib/geo";
import { readWaypoints, writeWaypoints, type NamedWaypoint } from "@/lib/storage";

interface WaypointManagerModalProps {
  userPosition: GeolocationPosition | null;
  /** Called when the user taps Navigate on a waypoint. */
  onNavigate: (wp: NamedWaypoint) => void;
  onClose: () => void;
}

const TYPE_ICONS: Record<NamedWaypoint["type"], React.ReactNode> = {
  waypoint:  <MapPin className="h-4 w-4" />,
  camp:      <Tent className="h-4 w-4" />,
  water:     <Droplets className="h-4 w-4" />,
  danger:    <AlertTriangle className="h-4 w-4" />,
  sos:       <AlertTriangle className="h-4 w-4 text-red-400" />,
  interest:  <Star className="h-4 w-4" />,
};

const TYPE_COLOURS: Record<NamedWaypoint["type"], string> = {
  waypoint: "bg-gray-600",
  camp:     "bg-orange-700",
  water:    "bg-cyan-700",
  danger:   "bg-red-700",
  sos:      "bg-red-900 border border-red-500",
  interest: "bg-purple-700",
};

function formatDist(m: number) {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`;
}

function formatCoord(lat: number, lng: number) {
  const latStr = `${Math.abs(lat).toFixed(5)}° ${lat >= 0 ? "N" : "S"}`;
  const lngStr = `${Math.abs(lng).toFixed(5)}° ${lng >= 0 ? "E" : "W"}`;
  return `${latStr}, ${lngStr}`;
}

type View = "list" | "add-gps" | "add-manual" | "edit";

export function WaypointManagerModal({
  userPosition,
  onNavigate,
  onClose,
}: WaypointManagerModalProps) {
  const [waypoints, setWaypoints]       = useState<NamedWaypoint[]>([]);
  const [view, setView]                 = useState<View>("list");
  const [editTarget, setEditTarget]     = useState<NamedWaypoint | null>(null);

  // Form fields
  const [name, setName]                 = useState("");
  const [type, setType]                 = useState<NamedWaypoint["type"]>("waypoint");
  const [notes, setNotes]               = useState("");
  const [manualLat, setManualLat]       = useState("");
  const [manualLng, setManualLng]       = useState("");
  const [manualError, setManualError]   = useState("");
  const [savedFlash, setSavedFlash]     = useState(false);

  useEffect(() => {
    setWaypoints(readWaypoints());
  }, []);

  const save = useCallback((wps: NamedWaypoint[]) => {
    setWaypoints(wps);
    writeWaypoints(wps);
  }, []);

  // ── Save from GPS ─────────────────────────────────────────────────────────
  const saveGps = useCallback(() => {
    if (!userPosition) return;
    const wp: NamedWaypoint = {
      id:        Date.now().toString(),
      name:      name.trim() || `Waypoint ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
      lat:       userPosition.coords.latitude,
      lng:       userPosition.coords.longitude,
      type,
      notes:     notes.trim() || undefined,
      createdAt: new Date(),
    };
    save([...waypoints, wp]);
    setName(""); setNotes(""); setType("waypoint");
    setSavedFlash(true);
    setTimeout(() => { setSavedFlash(false); setView("list"); }, 900);
  }, [userPosition, name, type, notes, waypoints, save]);

  // ── Save from manual coordinates ─────────────────────────────────────────
  const saveManual = useCallback(() => {
    const lat = parseFloat(manualLat.replace(",", "."));
    const lng = parseFloat(manualLng.replace(",", "."));
    if (isNaN(lat) || lat < -90 || lat > 90)  { setManualError("Invalid latitude (−90 to 90)");  return; }
    if (isNaN(lng) || lng < -180 || lng > 180) { setManualError("Invalid longitude (−180 to 180)"); return; }
    const wp: NamedWaypoint = {
      id:        Date.now().toString(),
      name:      name.trim() || `${lat.toFixed(4)}, ${lng.toFixed(4)}`,
      lat, lng, type,
      notes:     notes.trim() || undefined,
      createdAt: new Date(),
    };
    save([...waypoints, wp]);
    setName(""); setManualLat(""); setManualLng(""); setNotes(""); setType("waypoint"); setManualError("");
    setSavedFlash(true);
    setTimeout(() => { setSavedFlash(false); setView("list"); }, 900);
  }, [manualLat, manualLng, name, type, notes, waypoints, save]);

  // ── Edit existing waypoint ────────────────────────────────────────────────
  const startEdit = (wp: NamedWaypoint) => {
    setEditTarget(wp); setName(wp.name); setType(wp.type); setNotes(wp.notes ?? "");
    setManualLat(wp.lat.toString()); setManualLng(wp.lng.toString()); setView("edit");
  };

  const saveEdit = useCallback(() => {
    if (!editTarget) return;
    const lat = parseFloat(manualLat.replace(",", "."));
    const lng = parseFloat(manualLng.replace(",", "."));
    if (isNaN(lat) || isNaN(lng)) { setManualError("Invalid coordinates"); return; }
    const updated = waypoints.map((w) =>
      w.id === editTarget.id
        ? { ...w, name: name.trim() || w.name, type, notes: notes.trim() || undefined, lat, lng }
        : w,
    );
    save(updated); setEditTarget(null); setView("list");
  }, [editTarget, manualLat, manualLng, name, type, notes, waypoints, save]);

  const deleteWp = (id: string) => save(waypoints.filter((w) => w.id !== id));

  // ── Shared form fields ────────────────────────────────────────────────────
  const FormFields = (
    <div className="space-y-3">
      <input
        type="text"
        placeholder="Name (optional)"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="w-full px-3 py-2 bg-gray-700 text-white text-sm rounded-xl placeholder-gray-500 outline-none"
      />
      <div className="grid grid-cols-3 gap-1.5">
        {(Object.keys(TYPE_ICONS) as NamedWaypoint["type"][])
          .filter((t) => t !== "sos")
          .map((t) => (
          <button
            key={t}
            onClick={() => setType(t)}
            className={`py-2 rounded-xl text-xs font-medium flex items-center justify-center gap-1.5 transition-colors ${
              type === t ? "bg-blue-600 text-white" : "bg-gray-700 text-gray-300 hover:bg-gray-600"
            }`}
          >
            {TYPE_ICONS[t]}
            <span className="capitalize">{t}</span>
          </button>
        ))}
      </div>
      <input
        type="text"
        placeholder="Notes (optional)"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        className="w-full px-3 py-2 bg-gray-700 text-white text-sm rounded-xl placeholder-gray-500 outline-none"
      />
    </div>
  );

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 z-50 bg-gray-900 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-12 pb-4 border-b border-gray-800">
        <div className="flex items-center gap-2">
          {view !== "list" && (
            <button onClick={() => { setView("list"); setManualError(""); }}
              className="p-1.5 text-gray-400 hover:text-white transition-colors mr-1">
              <X className="h-4 w-4" />
            </button>
          )}
          <MapPin className="h-5 w-5 text-blue-400" />
          <h2 className="text-lg font-bold text-white">
            {view === "list" ? "Waypoints" : view === "add-gps" ? "Save Current GPS" : view === "add-manual" ? "Enter Coordinates" : "Edit Waypoint"}
          </h2>
        </div>
        {view === "list" && (
          <button onClick={onClose} className="p-2 text-gray-400 hover:text-white">
            <X className="h-5 w-5" />
          </button>
        )}
      </div>

      {/* ── LIST VIEW ─────────────────────────────────────────────────────── */}
      {view === "list" && (
        <>
          {waypoints.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-4 px-8 text-center">
              <MapPin className="h-12 w-12 text-gray-600" />
              <div>
                <p className="text-white font-semibold">No saved waypoints yet</p>
                <p className="text-gray-500 text-sm mt-1">Save your GPS position or enter known coordinates to navigate.</p>
              </div>
            </div>
          ) : (
            <ScrollArea className="flex-1">
              <div className="px-4 py-3 space-y-2">
                {waypoints.map((wp) => {
                  const dist = userPosition
                    ? calculateDistance(userPosition.coords.latitude, userPosition.coords.longitude, wp.lat, wp.lng)
                    : null;
                  return (
                    <div key={wp.id}
                      className={`rounded-2xl p-3 border ${wp.type === "sos" ? "bg-red-950 border-red-800" : "bg-gray-800 border-gray-700"}`}>
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-start gap-2.5 min-w-0">
                          <div className={`p-2 rounded-xl ${TYPE_COLOURS[wp.type]} flex-shrink-0 mt-0.5`}>
                            {TYPE_ICONS[wp.type]}
                          </div>
                          <div className="min-w-0">
                            <p className="text-white font-semibold text-sm truncate">{wp.name}</p>
                            <p className="text-gray-500 text-xs mt-0.5">{formatCoord(wp.lat, wp.lng)}</p>
                            {dist !== null && (
                              <p className="text-blue-400 text-xs mt-0.5">{formatDist(dist)} away</p>
                            )}
                            {wp.notes && <p className="text-gray-400 text-xs mt-0.5 truncate">{wp.notes}</p>}
                          </div>
                        </div>
                        <div className="flex items-center gap-1 flex-shrink-0">
                          <button onClick={() => startEdit(wp)}
                            className="p-2 text-gray-500 hover:text-blue-400 transition-colors">
                            <Edit3 className="h-3.5 w-3.5" />
                          </button>
                          <button onClick={() => deleteWp(wp.id)}
                            className="p-2 text-gray-500 hover:text-red-400 transition-colors">
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                          <button
                            onClick={() => onNavigate(wp)}
                            className={`p-2 rounded-xl text-white transition-colors flex items-center gap-1 text-xs font-medium px-3 ${
                              wp.type === "sos" ? "bg-red-600 hover:bg-red-700" : "bg-blue-600 hover:bg-blue-700"
                            }`}
                          >
                            <Compass className="h-3.5 w-3.5" />
                            Navigate
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </ScrollArea>
          )}

          {/* Add buttons */}
          <div
            className="px-4 pt-3 border-t border-gray-800 space-y-2"
            style={{ paddingBottom: "max(2rem, calc(env(safe-area-inset-bottom) + 1.5rem))" }}
          >
            <Button
              onClick={() => { setView("add-gps"); setName(""); setNotes(""); setType("waypoint"); }}
              disabled={!userPosition}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white rounded-xl py-3 flex items-center gap-2"
            >
              <Plus className="h-4 w-4" />
              {userPosition ? "Save Current GPS Location" : "Waiting for GPS…"}
            </Button>
            <Button
              onClick={() => { setView("add-manual"); setName(""); setManualLat(""); setManualLng(""); setNotes(""); setType("waypoint"); setManualError(""); }}
              variant="outline"
              className="w-full border-gray-600 text-gray-300 hover:bg-gray-800 rounded-xl py-3 flex items-center gap-2"
            >
              <Edit3 className="h-4 w-4" />
              Enter Coordinates Manually
            </Button>
          </div>
        </>
      )}

      {/* ── ADD GPS VIEW ──────────────────────────────────────────────────── */}
      {view === "add-gps" && userPosition && (
        <div className="flex-1 flex flex-col px-4 pt-4 gap-4">
          <div className="bg-gray-800 rounded-2xl p-4 space-y-1">
            <p className="text-xs text-gray-500 font-medium">Current GPS position</p>
            <p className="text-white font-mono text-sm">{formatCoord(userPosition.coords.latitude, userPosition.coords.longitude)}</p>
            <p className="text-gray-500 text-xs">Accuracy: ±{Math.round(userPosition.coords.accuracy)} m</p>
          </div>
          {FormFields}
          <Button
            onClick={saveGps}
            className="w-full bg-blue-600 hover:bg-blue-700 text-white rounded-xl py-3"
          >
            {savedFlash ? <Check className="h-5 w-5" /> : "Save Waypoint"}
          </Button>
        </div>
      )}

      {/* ── ADD MANUAL VIEW ───────────────────────────────────────────────── */}
      {(view === "add-manual" || view === "edit") && (
        <div className="flex-1 flex flex-col px-4 pt-4 gap-4 overflow-y-auto">
          <div className="bg-gray-800 rounded-2xl p-4 space-y-2">
            <p className="text-xs text-gray-500 font-medium">GPS Coordinates</p>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs text-gray-400 mb-1 block">Latitude</label>
                <input type="text" placeholder="-6.792431" value={manualLat}
                  onChange={(e) => { setManualLat(e.target.value); setManualError(""); }}
                  className="w-full px-3 py-2 bg-gray-700 text-white text-sm rounded-xl placeholder-gray-500 outline-none font-mono" />
              </div>
              <div>
                <label className="text-xs text-gray-400 mb-1 block">Longitude</label>
                <input type="text" placeholder="39.208315" value={manualLng}
                  onChange={(e) => { setManualLng(e.target.value); setManualError(""); }}
                  className="w-full px-3 py-2 bg-gray-700 text-white text-sm rounded-xl placeholder-gray-500 outline-none font-mono" />
              </div>
            </div>
            {manualError && <p className="text-red-400 text-xs">{manualError}</p>}
          </div>
          {FormFields}
          <Button
            onClick={view === "edit" ? saveEdit : saveManual}
            className="w-full bg-blue-600 hover:bg-blue-700 text-white rounded-xl py-3"
          >
            {savedFlash ? <Check className="h-5 w-5" /> : view === "edit" ? "Save Changes" : "Add Waypoint"}
          </Button>
        </div>
      )}
    </div>
  );
}
