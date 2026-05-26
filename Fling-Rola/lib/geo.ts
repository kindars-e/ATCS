export function calculateBearing(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;

  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);

  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export function getCardinalDirection(degrees: number): string {
  const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return directions[Math.round(degrees / 45) % 8];
}

export interface BoundingBox {
  north: number;
  south: number;
  east: number;
  west: number;
}

export function getBoundingBox(
  lat: number,
  lng: number,
  radiusKm: number,
): BoundingBox {
  const earthRadiusKm = 6371;
  const latRad = (lat * Math.PI) / 180;
  const deltaLat = radiusKm / earthRadiusKm;
  const deltaLng = radiusKm / (earthRadiusKm * Math.cos(latRad));

  return {
    north: lat + (deltaLat * 180) / Math.PI,
    south: lat - (deltaLat * 180) / Math.PI,
    east: lng + (deltaLng * 180) / Math.PI,
    west: lng - (deltaLng * 180) / Math.PI,
  };
}

// Haversine distance between two coordinates, in meters.
export function calculateDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6_371_000;
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(Δφ / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;

  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
