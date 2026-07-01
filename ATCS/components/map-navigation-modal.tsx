// ─────────────────────────────────────────────────────────────────────────────
// components/map-navigation-modal.tsx
//
// [STEP 8] Map-based navigation replacing the text-only waypoint list.
//
// Features:
//   • Full Leaflet map with OpenStreetMap tiles (cached in browser when
//     internet was available — tiles still display offline if cached).
//   • Tap anywhere on the map to place or move a destination marker.
//   • Shows the user's live GPS position (blue dot).
//   • Draws a straight-line route from the user to the selected destination.
//   • Displays bearing and distance to the selected point.
//   • Save named waypoints (persisted in localStorage via lib/storage).
//   • Delete waypoints.
//   • Tap a saved waypoint to navigate to it.
//   • Compass bearing shown as text and as animated arrow when destination set.
//
// Map tile note: OpenStreetMap tiles require internet to DOWNLOAD, but once
// the browser has cached them, they show offline. For emergency field use,
// open the app in the target area while connected to download the tiles first.
// ─────────────────────────────────────────────────────────────────────────────

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Compass,
  MapPin,
  Navigation,
  Plus,
  Trash2,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { calculateBearing, calculateDistance } from "@/lib/geo";
import { readTrails, writeTrails } from "@/lib/storage";
import type { Waypoint } from "@/lib/types";

interface MapNavigationModalProps {
  /** User's live GPS position (from the geolocation hook or raw API). */
  userPosition: GeolocationPosition | null;
  /** If set, the map centres on this contact's location (e.g. SOS sender). */
  targetLocation?: { lat: number; lng: number; label?: string } | null;
  onClose: () => void;
}

function formatDist(m: number): string {
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(2)} km`;
}

function cardinalLabel(deg: number): string {
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return dirs[Math.round(deg / 45) % 8];
}

export default function MapNavigationModal({
  userPosition,
  targetLocation,
  onClose,
}: MapNavigationModalProps) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapRef          = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userMarkerRef   = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const destMarkerRef   = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const routeLineRef    = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const waypointLayersRef = useRef<any[]>([]);

  const [destination, setDestination]   = useState<{ lat: number; lng: number } | null>(null);
  const [bearing, setBearing]           = useState<number | null>(null);
  const [distance, setDistance]         = useState<number | null>(null);
  const [waypoints, setWaypoints]       = useState<Waypoint[]>([]);
  const [showSaveForm, setShowSaveForm] = useState(false);
  const [waypointName, setWaypointName] = useState("");
  const [waypointType, setWaypointType] = useState<Waypoint["type"]>("waypoint");
  const [mapReady, setMapReady]         = useState(false);

  // ── Load saved waypoints on mount ────────────────────────────────────────
  useEffect(() => {
    const trails = readTrails();
    // Flatten all waypoints from all trails into a single list for display.
    const all = trails.flatMap((t) => t.waypoints);
    setWaypoints(all);
  }, []);

  // ── Initialise Leaflet map (browser-only, dynamic import) ─────────────────
  useEffect(() => {
    let L: typeof import("leaflet");
    let cancelled = false;

    (async () => {
      try {
        L = (await import("leaflet")) as typeof import("leaflet");
        // Patch default marker icons (Leaflet's asset path breaks in bundlers).
        // @ts-expect-error _getIconUrl is internal
        delete L.Icon.Default.prototype._getIconUrl;
        L.Icon.Default.mergeOptions({
          iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
          iconUrl:       "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
          shadowUrl:     "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
        });
      } catch {
        return; // Leaflet not available
      }
      if (cancelled || !mapContainerRef.current || mapRef.current) return;

      // Start position: user, or targetLocation, or a default.
      const initLat = userPosition?.coords.latitude  ?? targetLocation?.lat ?? 0;
      const initLng = userPosition?.coords.longitude ?? targetLocation?.lng ?? 0;
      const initZoom = (userPosition || targetLocation) ? 16 : 2;

      const map = L.map(mapContainerRef.current, {
        center: [initLat, initLng],
        zoom:   initZoom,
        zoomControl: true,
      });

      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "© OpenStreetMap",
        maxZoom: 19,
      }).addTo(map);

      mapRef.current = map;
      setMapReady(true);

      // Click on map → place/move destination marker.
      map.on("click", (e: { latlng: { lat: number; lng: number } }) => {
        const { lat, lng } = e.latlng;
        setDestination({ lat, lng });
      });
    })();

    return () => {
      cancelled = true;
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Update user-position marker ───────────────────────────────────────────
  useEffect(() => {
    if (!mapReady || !mapRef.current || !userPosition) return;
    // Dynamic import inside effect — map is already initialised by now.
    import("leaflet").then((L) => {
      const lat = userPosition.coords.latitude;
      const lng = userPosition.coords.longitude;

      if (!userMarkerRef.current) {
        const userIcon = L.divIcon({
          className: "",
          html: `<div style="width:16px;height:16px;background:#3b82f6;border:3px solid white;border-radius:50%;box-shadow:0 0 8px #3b82f666;"></div>`,
          iconSize:   [16, 16],
          iconAnchor: [8, 8],
        });
        userMarkerRef.current = L.marker([lat, lng], { icon: userIcon, zIndexOffset: 1000 })
          .addTo(mapRef.current)
          .bindPopup("You are here");
      } else {
        userMarkerRef.current.setLatLng([lat, lng]);
      }
    });
  }, [mapReady, userPosition]);

  // ── Pre-load targetLocation as destination (SOS navigation) ───────────────
  useEffect(() => {
    if (targetLocation && !destination) {
      setDestination({ lat: targetLocation.lat, lng: targetLocation.lng });
    }
  }, [targetLocation]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Update destination marker + route line ────────────────────────────────
  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    import("leaflet").then((L) => {
      if (!mapRef.current) return;

      if (destMarkerRef.current) {
        mapRef.current.removeLayer(destMarkerRef.current);
        destMarkerRef.current = null;
      }
      if (routeLineRef.current) {
        mapRef.current.removeLayer(routeLineRef.current);
        routeLineRef.current = null;
      }

      if (!destination) {
        setBearing(null);
        setDistance(null);
        return;
      }

      const destIcon = L.divIcon({
        className: "",
        html: `<div style="width:20px;height:20px;background:#ef4444;border:3px solid white;border-radius:50%;box-shadow:0 0 10px #ef444466;"></div>`,
        iconSize: [20, 20], iconAnchor: [10, 10],
      });
      destMarkerRef.current = L.marker([destination.lat, destination.lng], { icon: destIcon })
        .addTo(mapRef.current)
        .bindPopup(targetLocation?.label ?? "Destination");

      if (userPosition) {
        const uLat = userPosition.coords.latitude;
        const uLng = userPosition.coords.longitude;
        routeLineRef.current = L.polyline(
          [[uLat, uLng], [destination.lat, destination.lng]],
          { color: "#3b82f6", weight: 3, dashArray: "8 6" },
        ).addTo(mapRef.current);

        setBearing(calculateBearing(uLat, uLng, destination.lat, destination.lng));
        setDistance(calculateDistance(uLat, uLng, destination.lat, destination.lng));
      }
    });
  }, [mapReady, destination, userPosition, targetLocation]);

  // ── Draw saved waypoints on map ───────────────────────────────────────────
  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    import("leaflet").then((L) => {
      if (!mapRef.current) return;
      waypointLayersRef.current.forEach((l) => mapRef.current!.removeLayer(l));
      waypointLayersRef.current = [];

      waypoints.forEach((wp) => {
        const colour = wp.type === "danger" ? "#f97316"
                     : wp.type === "water"  ? "#06b6d4"
                     : wp.type === "camp"   ? "#a78bfa"
                     : "#6b7280";
        const icon = L.divIcon({
          className: "",
          html: `<div style="width:14px;height:14px;background:${colour};border:2px solid white;border-radius:50%;"></div>`,
          iconSize: [14, 14], iconAnchor: [7, 7],
        });
        const marker = L.marker([wp.location.lat, wp.location.lng], { icon })
          .addTo(mapRef.current!)
          .bindPopup(wp.name);
        marker.on("click", () =>
          setDestination({ lat: wp.location.lat, lng: wp.location.lng }),
        );
        waypointLayersRef.current.push(marker);
      });
    });
  }, [mapReady, waypoints]);

  // ── Save waypoint at current destination ─────────────────────────────────
  const saveWaypoint = useCallback(() => {
    if (!destination) return;
    const newWp: Waypoint = {
      id:       Date.now().toString(),
      name:     waypointName.trim() || "Waypoint",
      location: { lat: destination.lat, lng: destination.lng, accuracy: 0 },
      timestamp: new Date(),
      type:     waypointType,
    };
    const trails = readTrails();
    const active = trails.find((t) => t.active);
    if (active) {
      active.waypoints.push(newWp);
      writeTrails(trails);
      setWaypoints((prev) => [...prev, newWp]);
    } else {
      // Create a standalone trail to store the waypoint.
      const trail = {
        id: Date.now().toString(),
        name: "Field Waypoints",
        waypoints: [newWp],
        startTime: new Date(),
        totalDistance: 0,
        active: true,
      };
      writeTrails([...trails, trail]);
      setWaypoints((prev) => [...prev, newWp]);
    }
    setShowSaveForm(false);
    setWaypointName("");
  }, [destination, waypointName, waypointType]);

  const deleteWaypoint = useCallback((id: string) => {
    const trails = readTrails().map((t) => ({
      ...t,
      waypoints: t.waypoints.filter((w) => w.id !== id),
    }));
    writeTrails(trails);
    setWaypoints((prev) => prev.filter((w) => w.id !== id));
  }, []);

  const centreOnUser = useCallback(() => {
    if (!mapRef.current || !userPosition) return;
    mapRef.current.setView(
      [userPosition.coords.latitude, userPosition.coords.longitude],
      17,
    );
  }, [userPosition]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-gray-900">
      {/* Header */}
      <div className="flex items-center justify-between bg-gray-900/95 border-b border-gray-800 px-4 py-3 safe-top">
        <div className="flex items-center gap-2">
          <MapPin className="h-5 w-5 text-blue-400" />
          <h2 className="text-lg font-bold text-white">Navigation</h2>
        </div>
        <div className="flex items-center gap-2">
          {userPosition && (
            <button
              onClick={centreOnUser}
              className="p-2 rounded-xl bg-gray-800 hover:bg-gray-700 text-blue-400 transition-colors"
              title="Centre on my location"
            >
              <Navigation className="h-4 w-4" />
            </button>
          )}
          <button
            onClick={onClose}
            className="p-2 rounded-xl bg-gray-800 hover:bg-gray-700 text-gray-300 transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Map */}
      <div ref={mapContainerRef} className="flex-1 relative">
        {!userPosition && (
          <div className="absolute inset-0 flex items-center justify-center z-[999] bg-gray-900/50 pointer-events-none">
            <div className="bg-gray-800 rounded-xl px-4 py-3 text-sm text-gray-400 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-400" />
              Waiting for GPS…
            </div>
          </div>
        )}
        {/* Leaflet CSS injected at runtime */}
        {mapReady && (
          <style>{`
            .leaflet-container { background: #1f2937; }
            .leaflet-tile-pane { opacity: 0.9; }
          `}</style>
        )}
      </div>

      {/* Bearing/distance card */}
      {destination && (
        <div className="bg-gray-900/95 border-t border-gray-800 px-4 py-3">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-3">
              {bearing !== null && (
                <div
                  className="transition-transform duration-500"
                  style={{ transform: `rotate(${bearing}deg)` }}
                >
                  <Compass className="h-7 w-7 text-blue-400" />
                </div>
              )}
              <div>
                {distance !== null && (
                  <p className="text-xl font-bold text-white">{formatDist(distance)}</p>
                )}
                {bearing !== null && (
                  <p className="text-sm text-gray-400">
                    {Math.round(bearing)}° {cardinalLabel(bearing)}
                  </p>
                )}
                {!userPosition && (
                  <p className="text-sm text-amber-400">Enable GPS for direction</p>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowSaveForm((v) => !v)}
                className="flex items-center gap-1.5 px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-xl transition-colors"
              >
                <Plus className="h-3.5 w-3.5" />
                Save waypoint
              </button>
              <button
                onClick={() => setDestination(null)}
                className="p-2 text-gray-500 hover:text-gray-300 transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Save form */}
          {showSaveForm && (
            <div className="bg-gray-800 rounded-xl p-3 mt-2 space-y-2">
              <input
                type="text"
                placeholder="Waypoint name"
                value={waypointName}
                onChange={(e) => setWaypointName(e.target.value)}
                className="w-full px-3 py-2 bg-gray-700 text-white text-sm rounded-lg placeholder-gray-500 outline-none"
                autoFocus
              />
              <div className="flex gap-1.5 flex-wrap">
                {(["waypoint", "camp", "water", "danger", "interest"] as Waypoint["type"][]).map((t) => (
                  <button
                    key={t}
                    onClick={() => setWaypointType(t)}
                    className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                      waypointType === t
                        ? "bg-blue-600 text-white"
                        : "bg-gray-700 text-gray-300 hover:bg-gray-600"
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>
              <div className="flex gap-2">
                <Button onClick={saveWaypoint} className="flex-1 bg-blue-600 hover:bg-blue-700 text-white text-sm">
                  Save
                </Button>
                <Button onClick={() => setShowSaveForm(false)} variant="ghost" className="flex-1 text-sm">
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Saved waypoints list */}
      {waypoints.length > 0 && !destination && (
        <div className="bg-gray-900/95 border-t border-gray-800 max-h-48 overflow-y-auto">
          <p className="text-xs text-gray-500 font-medium px-4 pt-3 pb-1">Saved waypoints — tap to navigate</p>
          {waypoints.map((wp) => (
            <div
              key={wp.id}
              className="flex items-center justify-between px-4 py-2.5 hover:bg-gray-800 transition-colors"
            >
              <button
                className="flex items-center gap-2 text-left flex-1"
                onClick={() => {
                  setDestination({ lat: wp.location.lat, lng: wp.location.lng });
                  mapRef.current?.setView([wp.location.lat, wp.location.lng], 16);
                }}
              >
                <MapPin className="h-4 w-4 text-gray-400 flex-shrink-0" />
                <span className="text-sm text-white">{wp.name}</span>
                <span className="text-xs text-gray-500 capitalize ml-1">({wp.type})</span>
              </button>
              <button
                onClick={() => deleteWaypoint(wp.id)}
                className="p-1.5 text-gray-600 hover:text-red-400 transition-colors"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {waypoints.length === 0 && !destination && (
        <div className="bg-gray-900/95 border-t border-gray-800 px-4 py-3 text-center text-xs text-gray-600">
          Tap anywhere on the map to set a destination
        </div>
      )}
    </div>
  );
}
