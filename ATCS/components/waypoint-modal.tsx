import React, { useState, useEffect } from 'react';
import { MapPin, Navigation, Home, Plus, X, AlertTriangle, Tent, Droplets, Star, ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import useGeolocation from '@/hooks/use-geolocation';
import { calculateDistance } from '@/lib/geo';
import { readTrails, writeTrails } from '@/lib/storage';
import type { Waypoint, Trail } from '@/lib/types';


interface WaypointModalProps {
  onClose: () => void;
  onNavigateToWaypoint: (waypoint: Waypoint) => void;
}

export default function WaypointModal({ onClose, onNavigateToWaypoint }: WaypointModalProps) {
  const { position, error: geoError, requestPermission } = useGeolocation();
  const [trails, setTrails] = useState<Trail[]>([]);
  const [activeTrail, setActiveTrail] = useState<Trail | null>(null);
  const [showAddWaypoint, setShowAddWaypoint] = useState(false);
  const [waypointType, setWaypointType] = useState<Waypoint['type']>('waypoint');
  const [waypointName, setWaypointName] = useState('');
  const [gpsStatus, setGpsStatus] = useState<'idle' | 'acquiring' | 'ready' | 'poor'>('idle');
  const [gpsAccuracy, setGpsAccuracy] = useState<number | null>(null);
  const [hasRequestedPermission, setHasRequestedPermission] = useState(false);

  // Request GPS permission on mount if we don't have it
  useEffect(() => {
    const checkAndRequestPermission = async () => {
      if (!position && !geoError && !hasRequestedPermission) {
        setHasRequestedPermission(true);
        await requestPermission();
      }
    };
    
    checkAndRequestPermission();
  }, [position, geoError, hasRequestedPermission, requestPermission]);

  // Monitor GPS status when adding waypoint
  useEffect(() => {
    let interval: NodeJS.Timeout | null = null;
    
    if (showAddWaypoint) {
      setGpsStatus('acquiring');
      
      // If we have position already, update immediately
      if (position) {
        const accuracy = position.coords.accuracy;
        setGpsAccuracy(Math.round(accuracy));
        
        if (accuracy <= 10) {
          setGpsStatus('ready');
          if ('vibrate' in navigator) {
            navigator.vibrate(200);
          }
        } else if (accuracy <= 30) {
          setGpsStatus('ready');
        } else {
          setGpsStatus('poor');
        }
      }
      
      // Check GPS every second
      interval = setInterval(() => {
        if (position) {
          const accuracy = position.coords.accuracy;
          setGpsAccuracy(Math.round(accuracy));

          if (accuracy <= 10) {
            setGpsStatus('ready');
            if ('vibrate' in navigator && gpsStatus !== 'ready') {
              navigator.vibrate(200);
            }
          } else if (accuracy <= 30) {
            setGpsStatus('ready');
          } else {
            setGpsStatus('poor');
          }
        } else {
          setGpsStatus('acquiring');
        }
      }, 1000);
    } else {
      setGpsStatus('idle');
      setGpsAccuracy(null);
    }

    return () => {
      if (interval) clearInterval(interval);
    };
  }, [showAddWaypoint, position, gpsStatus]);

  // [STEP 6] Load trails via the shared lib/storage.ts helpers instead of a
  // raw, hardcoded 'fling-trails' localStorage key duplicated here — both
  // now revive Dates the same way, in one place.
  useEffect(() => {
    const trails = readTrails();
    setTrails(trails);
    setActiveTrail(trails.find((t) => t.active) || null);
  }, []);

  // Save trails whenever they change.
  useEffect(() => {
    writeTrails(trails);
  }, [trails]);

  // Start a new trail
  const startNewTrail = async () => {
    if (!position) {
      await requestPermission();
      
      // Wait a bit for GPS to initialize
      setTimeout(() => {
        if (position) {
          createTrail();
        } else {
          alert('Unable to get GPS location. Please ensure location services are enabled.');
        }
      }, 2000);
      return;
    }

    createTrail();
  };

  const createTrail = () => {
    if (!position) return;

    const homeWaypoint: Waypoint = {
      id: Date.now().toString(),
      name: 'Start',
      location: {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        accuracy: position.coords.accuracy
      },
      timestamp: new Date(),
      type: 'start',
      notes: 'Trail starting point'
    };

    const newTrail: Trail = {
      id: Date.now().toString(),
      name: `Trail ${new Date().toLocaleDateString()}`,
      waypoints: [homeWaypoint],
      startTime: new Date(),
      totalDistance: 0,
      active: true
    };

    const updatedTrails = trails.map(t => ({ ...t, active: false }));
    setTrails([...updatedTrails, newTrail]);
    setActiveTrail(newTrail);
  };

  // Handle Add Waypoint button click
  const handleAddWaypointClick = async () => {
    if (!position) {
      await requestPermission();
      
      // Wait a moment for GPS to initialize
      setTimeout(() => {
        if (position) {
          setShowAddWaypoint(true);
        } else {
          alert('Unable to get GPS location. Please ensure location services are enabled and try again.');
        }
      }, 1500);
    } else {
      setShowAddWaypoint(true);
    }
  };

  // Add waypoint to active trail
  const addWaypoint = () => {
    if (!position || !activeTrail) return;

    const newWaypoint: Waypoint = {
      id: Date.now().toString(),
      name: waypointName || `Waypoint ${activeTrail.waypoints.length}`,
      location: {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        accuracy: position.coords.accuracy
      },
      timestamp: new Date(),
      type: waypointType,
      notes: ''
    };

    const lastWaypoint = activeTrail.waypoints[activeTrail.waypoints.length - 1];
    const distance = calculateDistance(
      lastWaypoint.location.lat,
      lastWaypoint.location.lng,
      newWaypoint.location.lat,
      newWaypoint.location.lng
    );

    const updatedTrail = {
      ...activeTrail,
      waypoints: [...activeTrail.waypoints, newWaypoint],
      totalDistance: activeTrail.totalDistance + distance
    };

    setTrails(trails.map(t => t.id === activeTrail.id ? updatedTrail : t));
    setActiveTrail(updatedTrail);
    setShowAddWaypoint(false);
    setWaypointName('');
    setWaypointType('waypoint');
  };

  // End current trail
  const endTrail = () => {
    if (!activeTrail) return;

    const updatedTrail = {
      ...activeTrail,
      active: false,
      endTime: new Date()
    };

    setTrails(trails.map(t => t.id === activeTrail.id ? updatedTrail : t));
    setActiveTrail(null);
  };

  // Calculate distance between waypoints
  const getDistanceToWaypoint = (waypoint: Waypoint) => {
    if (!position) return null;
    
    const distance = calculateDistance(
      position.coords.latitude,
      position.coords.longitude,
      waypoint.location.lat,
      waypoint.location.lng
    );
    
    return Math.round(distance * 3.28084);
  };

  const waypointIcons = {
    start: Home,
    waypoint: MapPin,
    camp: Tent,
    danger: AlertTriangle,
    water: Droplets,
    interest: Star
  };

  // Show permission screen if location is denied
  if (geoError) {
    return (
      <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
        <div className="bg-gray-800 rounded-3xl p-6 max-w-md w-full text-center">
          <div className="w-24 h-24 mx-auto mb-6 bg-red-600 rounded-full flex items-center justify-center">
            <X className="w-12 h-12 text-white" />
          </div>
          <h2 className="text-2xl font-bold text-white mb-4">Location Access Required</h2>
          <p className="text-gray-400 mb-8">
            Waypoint tracking requires GPS access. Please enable location services in your device settings.
          </p>
          <Button onClick={onClose} className="bg-gray-700 hover:bg-gray-600">
            Close
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-gray-800 rounded-3xl max-w-lg w-full max-h-[90vh] overflow-hidden shadow-2xl">
        {/* Header */}
        <div className="bg-gray-700 px-6 py-4 border-b border-gray-600">
          <div className="flex items-center justify-between">
            <h2 className="text-2xl font-bold text-white flex items-center gap-2">
              <Navigation className="h-6 w-6" />
              Waypoints
            </h2>
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              className="rounded-full hover:bg-gray-600"
            >
              <X className="h-5 w-5" />
            </Button>
          </div>
          
          {/* GPS Status in header */}
          {position && (
            <div className="mt-2 flex items-center gap-2 text-xs">
              <div className="w-2 h-2 bg-green-500 rounded-full" />
              <span className="text-green-400">GPS Active</span>
            </div>
          )}
        </div>

        <ScrollArea className="flex-1 max-h-[calc(90vh-140px)]">
          <div className="p-6 space-y-4">
            {/* Active Trail Info */}
            {activeTrail ? (
              <div className="bg-gray-700 rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-lg font-semibold text-white">{activeTrail.name}</h3>
                    <p className="text-sm text-gray-400">
                      Started {activeTrail.startTime.toLocaleTimeString()}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm text-gray-400">Total Distance</p>
                    <p className="text-lg font-semibold text-white">
                      {Math.round(activeTrail.totalDistance * 3.28084)} ft
                    </p>
                  </div>
                </div>

                <div className="flex gap-2">
                  <Button
                    onClick={handleAddWaypointClick}
                    className="flex-1 bg-blue-600 hover:bg-blue-700"
                  >
                    <Plus className="h-4 w-4 mr-2" />
                    Add Waypoint
                  </Button>
                  <Button
                    onClick={endTrail}
                    variant="outline"
                    className="flex-1 border-red-600 text-red-400 hover:bg-red-600/20"
                  >
                    End Trail
                  </Button>
                </div>
              </div>
            ) : (
             <Button
  onClick={startNewTrail}
  className="w-full bg-blue-600 hover:bg-blue-700 py-6 text-white"
>
  <MapPin className="h-5 w-5 mr-2" />
  Start New Trail
</Button>
            )}

            {/* Add Waypoint Form */}
            {showAddWaypoint && (
              <div className="bg-gray-700 rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="font-semibold text-white">Add Waypoint</h4>
                  
                  {/* GPS Status Indicator */}
                  <div className="flex items-center gap-2">
                    {gpsStatus === 'acquiring' && (
                      <>
                        <div className="w-2 h-2 bg-yellow-500 rounded-full animate-pulse" />
                        <span className="text-xs text-yellow-500">Acquiring GPS...</span>
                      </>
                    )}
                    {gpsStatus === 'ready' && gpsAccuracy && gpsAccuracy <= 10 && (
                      <>
                        <div className="w-2 h-2 bg-green-500 rounded-full" />
                        <span className="text-xs text-green-500">Excellent GPS (±{gpsAccuracy}m)</span>
                      </>
                    )}
                    {gpsStatus === 'ready' && gpsAccuracy && gpsAccuracy > 10 && gpsAccuracy <= 30 && (
                      <>
                        <div className="w-2 h-2 bg-blue-500 rounded-full" />
                        <span className="text-xs text-blue-500">Good GPS (±{gpsAccuracy}m)</span>
                      </>
                    )}
                    {gpsStatus === 'poor' && gpsAccuracy && (
                      <>
                        <div className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
                        <span className="text-xs text-red-500">Poor GPS (±{gpsAccuracy}m)</span>
                      </>
                    )}
                  </div>
                </div>

                {/* GPS Warning for poor signal */}
                {gpsStatus === 'poor' && (
                  <div className="bg-red-500/20 border border-red-500/50 rounded-lg p-3">
                    <p className="text-xs text-red-400">
                      ⚠️ Poor GPS accuracy detected. Consider moving to an open area for better signal.
                      Current accuracy: ±{gpsAccuracy} meters
                    </p>
                  </div>
                )}

                {/* GPS Acquiring message */}
                {gpsStatus === 'acquiring' && (
                  <div className="bg-yellow-500/20 border border-yellow-500/50 rounded-lg p-3">
                    <p className="text-xs text-yellow-400">
                      📡 Acquiring GPS signal... Please wait. Make sure you have a clear view of the sky.
                    </p>
                  </div>
                )}

                {/* Success message for good GPS */}
                {gpsStatus === 'ready' && gpsAccuracy && gpsAccuracy <= 10 && (
                  <div className="bg-green-500/20 border border-green-500/50 rounded-lg p-3">
                    <p className="text-xs text-green-400">
                      ✅ Excellent GPS lock! Ready to save waypoint.
                    </p>
                  </div>
                )}
                
                <input
                  type="text"
                  placeholder="Waypoint name (optional)"
                  value={waypointName}
                  onChange={(e) => setWaypointName(e.target.value)}
                  className="w-full px-3 py-2 bg-gray-600 text-white rounded-lg placeholder-gray-400"
                />

                <div className="grid grid-cols-3 gap-2">
                  {(['waypoint', 'camp', 'water', 'danger', 'interest'] as const).map((type) => {
                    const Icon = waypointIcons[type];
                    return (
                      <button
                        key={type}
                        onClick={() => setWaypointType(type)}
                        className={`p-3 rounded-lg flex flex-col items-center gap-1 transition-colors ${
                          waypointType === type 
                            ? 'bg-blue-600 text-white' 
                            : 'bg-gray-600 text-gray-300 hover:bg-gray-500'
                        }`}
                      >
                        <Icon className="h-5 w-5" />
                        <span className="text-xs capitalize">{type}</span>
                      </button>
                    );
                  })}
                </div>

                <div className="flex gap-2">
                  <Button
                    onClick={addWaypoint}
                    className={`flex-1 transition-all ${
                      gpsStatus === 'ready' 
                        ? 'bg-blue-600 hover:bg-blue-700' 
                        : 'bg-gray-600 opacity-50 cursor-not-allowed'
                    }`}
                    disabled={!position || gpsStatus !== 'ready'}
                  >
                    {gpsStatus === 'acquiring' ? (
                      <>
                        <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin mr-2" />
                        Acquiring GPS...
                      </>
                    ) : gpsStatus === 'poor' ? (
                      'Poor GPS Signal'
                    ) : (
                      'Save Waypoint'
                    )}
                  </Button>
                  <Button
                    onClick={() => {
                      setShowAddWaypoint(false);
                      setGpsStatus('idle');
                      setGpsAccuracy(null);
                    }}
                    variant="ghost"
                    className="flex-1"
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}

            {/* Waypoints List */}
            {activeTrail && activeTrail.waypoints.length > 0 && (
              <div className="space-y-2">
                <h4 className="font-semibold text-white mb-2">Trail Waypoints</h4>
                {activeTrail.waypoints.slice().reverse().map((waypoint) => {
                  const Icon = waypointIcons[waypoint.type];
                  const distance = getDistanceToWaypoint(waypoint);
                  
                  return (
                    <div
                      key={waypoint.id}
                      className="bg-gray-700 rounded-lg p-3 flex items-center gap-3 hover:bg-gray-600 transition-colors"
                    >
                      <div className={`p-2 rounded-full ${
                        waypoint.type === 'start' ? 'bg-green-600' :
                        waypoint.type === 'danger' ? 'bg-red-600' :
                        waypoint.type === 'water' ? 'bg-blue-600' :
                        waypoint.type === 'camp' ? 'bg-orange-600' :
                        'bg-gray-600'
                      }`}>
                        <Icon className="h-4 w-4 text-white" />
                      </div>
                      
                      <div className="flex-1">
                        <p className="text-white font-medium">{waypoint.name}</p>
                        <p className="text-xs text-gray-400">
                          {waypoint.timestamp.toLocaleTimeString()}
                          {distance !== null && ` • ${distance} ft away`}
                          {waypoint.location.accuracy && ` • ±${Math.round(waypoint.location.accuracy)}m`}
                        </p>
                      </div>

                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => onNavigateToWaypoint(waypoint)}
                        className="rounded-full hover:bg-gray-500"
                      >
                        <Navigation className="h-4 w-4" />
                      </Button>
                    </div>
                  );
                })}

                {/* Backtrack Options */}
                {activeTrail.waypoints.length > 1 && (
                  <div className="mt-4 pt-4 border-t border-gray-600">
                    <p className="text-sm text-gray-400 mb-2">Navigation Options</p>
                    <div className="flex gap-2">
                     <Button
  onClick={() => onNavigateToWaypoint(activeTrail.waypoints[0])}
  className="flex-1 bg-blue-600 hover:bg-blue-700 text-white"
>
  <Home className="h-4 w-4 mr-2" />
  Back to Start
</Button>
                      <Button
                        onClick={() => {
                          const prev = activeTrail.waypoints[activeTrail.waypoints.length - 2];
                          if (prev) onNavigateToWaypoint(prev);
                        }}
                        variant="outline"
                        className="flex-1"
                        disabled={activeTrail.waypoints.length < 2}
                      >
                        <ArrowLeft className="h-4 w-4 mr-2" />
                        Previous
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Previous Trails */}
            {trails.filter(t => !t.active).length > 0 && (
              <div className="space-y-2 pt-4 border-t border-gray-600">
                <h4 className="font-semibold text-white mb-2">Previous Trails</h4>
                {trails.filter(t => !t.active).map(trail => (
                  <div
                    key={trail.id}
                    className="bg-gray-700 rounded-lg p-3 flex items-center justify-between"
                  >
                    <div>
                      <p className="text-white font-medium">{trail.name}</p>
                      <p className="text-xs text-gray-400">
                        {trail.waypoints.length} waypoints • {Math.round(trail.totalDistance * 3.28084)} ft
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setActiveTrail(trail);
                      }}
                    >
                      View
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
