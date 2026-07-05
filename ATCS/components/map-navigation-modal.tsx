// ─────────────────────────────────────────────────────────────────────────────
// components/map-navigation-modal.tsx
//
// [STEP 8] Original map-based navigation. [STEP 9] Its OSM tile layer was
// removed (real map tiles require internet, which conflicts with 100%
// offline operation) and the component was left unwired — the app moved to
// the compass-only WaypointManagerModal instead, leaving this file orphaned.
//
// [STEP 11] Revived as a genuine offline map, per plan: an offline BASEMAP
// bundled directly inside the app itself, not downloaded in the field.
//
//   HOW THE OFFLINE BASEMAP WORKS
//   ──────────────────────────────
//   This app already ships its entire web build as static assets inside the
//   installed APK (see capacitor.config.ts webDir + `npx cap sync android`).
//   A folder of pre-generated map tile IMAGES bundled the same way — under
//   `public/tiles/{z}/{x}/{y}.png` — rides along in the app bundle exactly
//   like every other static asset: present on the phone from first install,
//   zero download, zero internet ever required.
//
//   This component looks for `public/tiles/manifest.json` at runtime via a
//   same-origin fetch (NOT a network call — it's reading a bundled asset
//   from the app's own local origin, identical to loading any other app
//   image). If that manifest exists, its bounds/zoom range are used to add a
//   local tile layer and fit the map to the covered area. If it doesn't
//   exist (no tile package has been generated/added yet), the map falls back
//   to exactly today's behaviour — a plain dark canvas with markers, no
//   basemap — so this is a strict addition with no regression.
//
//   GENERATING A REAL TILE PACKAGE (a one-time, manual, INTERNET-REQUIRING
//   step done by the team ahead of a deployment — never done by the field
//   user, never done automatically): see public/tiles/README.md for the
//   exact folder/manifest convention this component expects. This component
//   cannot generate real map imagery itself — that requires knowing the
//   specific operating area, which is a deployment decision, not something
//   to guess.
//
// Features:
//   • Optional offline basemap (see above) — gracefully absent if not installed.
//   • Tap anywhere on the map to place or move a destination marker.
//   • Shows the user's live GPS position (blue dot).
//   • Draws a straight-line route from the user to the selected destination.
//   • Displays bearing and distance to the selected point.
//   • Shows saved NamedWaypoints (the same data model as WaypointManagerModal
//     and SOS auto-waypoints — [STEP 11] switched from the legacy Trail-based
//     Waypoint model so the map and the waypoint list always agree).
//   • [STEP 11] Draws the active breadcrumb trail (if recording — see
//     use-breadcrumb-trail.ts) as a connected line of the points captured so far.
//   • Tap a saved waypoint to navigate to it, or hand off to the Compass.
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
import { readWaypoints, writeWaypoints, type NamedWaypoint } from "@/lib/storage";
import type { Contact, Trail } from "@/lib/types";

interface MapNavigationModalProps {
  /** User's live GPS position (from the geolocation hook or raw API). */
  userPosition: GeolocationPosition | null;
  /** If set, the map centres on this location (e.g. an SOS sender). */
  targetLocation?: { lat: number; lng: number; label?: string } | null;
  /** [STEP 11] The in-progress breadcrumb trail, if recording is active. */
  activeTrail?: Trail | null;
  /** [STEP 12] Every known contact — those with a last-known location are
      drawn as map markers too, not just saved waypoints, so the map is the
      primary visualization for any shared location, not only Waypoints. */
  contacts?: Contact[];
  /** [STEP 11] Hand off a tapped waypoint to the Compass for bearing/distance nav. */
  onNavigateWaypoint?: (wp: NamedWaypoint) => void;
  /** [STEP 12] Hand off a tapped contact marker to the Compass. */
  onNavigateContact?: (contact: Contact) => void;
  onClose: () => void;
}

// [STEP 11] Local-tile-package manifest convention — see public/tiles/README.md.
interface TileManifest {
  minZoom: number;
  maxZoom: number;
  tileSize?: number;
  // [south, west, north, east]
  bounds: [number, number, number, number];
  attribution?: string;
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
  activeTrail,
  contacts,
  onNavigateWaypoint,
  onNavigateContact,
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
  // [STEP 12] Separate layer group for contact-location markers, so they can
  // be redrawn independently of saved waypoints.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const contactLayersRef = useRef<any[]>([]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const trailLineRef    = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tileLayerRef    = useRef<any>(null);

  const [destination, setDestination]   = useState<{ lat: number; lng: number } | null>(null);
  const [bearing, setBearing]           = useState<number | null>(null);
  const [distance, setDistance]         = useState<number | null>(null);
  const [waypoints, setWaypoints]       = useState<NamedWaypoint[]>([]);
  const [showSaveForm, setShowSaveForm] = useState(false);
  const [waypointName, setWaypointName] = useState("");
  const [waypointType, setWaypointType] = useState<NamedWaypoint["type"]>("waypoint");
  const [mapReady, setMapReady]         = useState(false);
  // [STEP 11] Whether a local offline tile package was found — purely
  // informational (shown in the header) so the user knows why the map is
  // either a real basemap or a plain dark canvas.
  const [hasOfflineBasemap, setHasOfflineBasemap] = useState(false);

  // ── Load saved waypoints on mount ────────────────────────────────────────
  useEffect(() => {
    setWaypoints(readWaypoints());
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
        maxZoom: 22,
      });

      mapRef.current = map;
      setMapReady(true);

      // Click on map → place/move destination marker.
      map.on("click", (e: { latlng: { lat: number; lng: number } }) => {
        const { lat, lng } = e.latlng;
        setDestination({ lat, lng });
      });

      // [STEP 11] Look for a bundled offline tile package. This is a
      // same-origin fetch of a static asset shipped inside the app bundle —
      // not a network request — so it works identically with zero
      // connectivity. Absent manifest = no tile layer, exactly today's
      // blank-canvas behaviour (a strict addition, never a regression).
      try {
        const res = await fetch("/tiles/manifest.json");
        if (!cancelled && res.ok) {
          const manifest = (await res.json()) as TileManifest;
          const [south, west, north, east] = manifest.bounds;
          const bounds = L.latLngBounds([south, west], [north, east]);
          tileLayerRef.current = L.tileLayer("/tiles/{z}/{x}/{y}.png", {
            minZoom: manifest.minZoom,
            maxZoom: manifest.maxZoom,
            tileSize: manifest.tileSize ?? 256,
            bounds,
            attribution: manifest.attribution ?? "",
            // A missing individual tile (e.g. edge of coverage) should render
            // as transparent, not a broken-image icon.
            errorTileUrl: "",
          }).addTo(map);
          setHasOfflineBasemap(true);
          if (!userPosition && !targetLocation) map.fitBounds(bounds);
        }
      } catch {
        // No manifest, or it's malformed — fall back to the tile-less map.
      }
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
                     : wp.type === "sos"    ? "#ef4444"
                     : "#6b7280";
        const icon = L.divIcon({
          className: "",
          html: `<div style="width:14px;height:14px;background:${colour};border:2px solid white;border-radius:50%;"></div>`,
          iconSize: [14, 14], iconAnchor: [7, 7],
        });
        const marker = L.marker([wp.lat, wp.lng], { icon })
          .addTo(mapRef.current!)
          .bindPopup(wp.name);
        marker.on("click", () => {
          if (onNavigateWaypoint) onNavigateWaypoint(wp);
          else setDestination({ lat: wp.lat, lng: wp.lng });
        });
        waypointLayersRef.current.push(marker);
      });
    });
  }, [mapReady, waypoints, onNavigateWaypoint]);

  // ── [STEP 12] Draw every contact's last-known location on the map ────────
  // The map is the primary visualization for any shared location, not just
  // saved waypoints — a contact with a `location` (from a location request/
  // response, live share, or an SOS ping) gets a marker here too, distinct
  // in colour/shape from waypoint pins so the two aren't confused.
  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    import("leaflet").then((L) => {
      if (!mapRef.current) return;
      contactLayersRef.current.forEach((l) => mapRef.current!.removeLayer(l));
      contactLayersRef.current = [];

      (contacts ?? []).forEach((c) => {
        if (!c.location) return;
        const online = c.reachability === "online";
        const icon = L.divIcon({
          className: "",
          html: `<div style="width:16px;height:16px;background:#3b82f6;border:2px solid ${online ? "#34d399" : "#9ca3af"};border-radius:4px;box-shadow:0 0 6px #3b82f666;"></div>`,
          iconSize: [16, 16], iconAnchor: [8, 8],
        });
        // [STEP 12] Hop-count shown right in the popup — item 8's "indicate
        // the communication path" requirement, at the level of detail the
        // firmware actually tracks (hop count, not the literal relay chain).
        const hopLabel = c.signalHopDistance === undefined
          ? ""
          : c.signalHopDistance === 0
          ? " · direct"
          : ` · ${c.signalHopDistance} hop${c.signalHopDistance > 1 ? "s" : ""} via relay`;
        const marker = L.marker([c.location.lat, c.location.lng], { icon })
          .addTo(mapRef.current!)
          .bindPopup(`${c.deviceName}${hopLabel}`);
        marker.on("click", () => {
          if (onNavigateContact) onNavigateContact(c);
          else setDestination({ lat: c.location!.lat, lng: c.location!.lng });
        });
        contactLayersRef.current.push(marker);
      });
    });
  }, [mapReady, contacts, onNavigateContact]);

  // ── [STEP 11] Draw the active breadcrumb trail, if recording ─────────────
  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    import("leaflet").then((L) => {
      if (!mapRef.current) return;
      if (trailLineRef.current) {
        mapRef.current.removeLayer(trailLineRef.current);
        trailLineRef.current = null;
      }
      if (!activeTrail || activeTrail.waypoints.length < 2) return;

      const points = activeTrail.waypoints.map((wp): [number, number] => [wp.location.lat, wp.location.lng]);
      trailLineRef.current = L.polyline(points, {
        color: "#22c55e",
        weight: 3,
        opacity: 0.8,
      }).addTo(mapRef.current);
    });
  }, [mapReady, activeTrail]);

  // ── Save waypoint at current destination ─────────────────────────────────
  const saveWaypoint = useCallback(() => {
    if (!destination) return;
    const newWp: NamedWaypoint = {
      id:        Date.now().toString(),
      name:      waypointName.trim() || "Waypoint",
      lat:       destination.lat,
      lng:       destination.lng,
      type:      waypointType,
      createdAt: new Date(),
    };
    const all = [...readWaypoints(), newWp];
    writeWaypoints(all);
    setWaypoints(all);
    setShowSaveForm(false);
    setWaypointName("");
  }, [destination, waypointName, waypointType]);

  const deleteWaypoint = useCallback((id: string) => {
    const remaining = readWaypoints().filter((w) => w.id !== id);
    writeWaypoints(remaining);
    setWaypoints(remaining);
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
          {!hasOfflineBasemap && (
            <span className="text-[10px] text-gray-500 border border-gray-700 rounded-full px-2 py-0.5">
              no offline map installed
            </span>
          )}
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
        {/* Dark background so the map space is clearly visible even with no
            offline basemap installed. */}
        {mapReady && (
          <style>{`
            .leaflet-container { background: #111827; }
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
                {(["waypoint", "camp", "water", "danger", "interest"] as NamedWaypoint["type"][]).map((t) => (
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
                  setDestination({ lat: wp.lat, lng: wp.lng });
                  mapRef.current?.setView([wp.lat, wp.lng], 16);
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