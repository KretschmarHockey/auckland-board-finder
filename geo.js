const EARTH_RADIUS_M = 6371008.8;

export function haversineMeters(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLat = lat2 - lat1;
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

function pointOnSegment(point, a, b, tolerance = 1e-10) {
  const [x, y] = point;
  const [x1, y1] = a;
  const [x2, y2] = b;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const cross = (x - x1) * dy - (y - y1) * dx;
  const scale = Math.max(1, Math.abs(dx) + Math.abs(dy));
  if (Math.abs(cross) > tolerance * scale) return false;
  const lenSq = dx * dx + dy * dy;
  if (lenSq <= tolerance * tolerance) {
    return Math.hypot(x - x1, y - y1) <= tolerance;
  }
  const dot = (x - x1) * dx + (y - y1) * dy;
  if (dot < -tolerance) return false;
  return dot <= lenSq + tolerance;
}

export function pointInRing(point, ring) {
  let inside = false;
  const [x, y] = point;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j];
    const b = ring[i];
    if (pointOnSegment(point, a, b)) return true;
    const xi = b[0];
    const yi = b[1];
    const xj = a[0];
    const yj = a[1];
    const intersects =
      yi > y !== yj > y &&
      x < ((xj - xi) * (y - yi)) / (yj - yi || Number.EPSILON) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

export function pointInPolygonCoordinates(point, polygonCoordinates) {
  if (!polygonCoordinates?.length) return false;
  if (!pointInRing(point, polygonCoordinates[0])) return false;
  for (let i = 1; i < polygonCoordinates.length; i += 1) {
    if (pointInRing(point, polygonCoordinates[i])) return false;
  }
  return true;
}

export function pointInFeature(point, feature) {
  const geometry = feature?.geometry;
  if (!geometry) return false;
  if (geometry.type === 'Polygon') {
    return pointInPolygonCoordinates(point, geometry.coordinates);
  }
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.some((polygon) =>
      pointInPolygonCoordinates(point, polygon),
    );
  }
  return false;
}

function localMeters(point, origin) {
  const latRad = (origin[1] * Math.PI) / 180;
  return [
    (point[0] - origin[0]) * 111320 * Math.cos(latRad),
    (point[1] - origin[1]) * 110574,
  ];
}

function distancePointToSegmentMeters(point, a, b) {
  const p = [0, 0];
  const av = localMeters(a, point);
  const bv = localMeters(b, point);
  const dx = bv[0] - av[0];
  const dy = bv[1] - av[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(av[0] - p[0], av[1] - p[1]);
  let t = -((av[0] * dx + av[1] * dy) / lenSq);
  t = Math.max(0, Math.min(1, t));
  const cx = av[0] + t * dx;
  const cy = av[1] + t * dy;
  return Math.hypot(cx, cy);
}

function ringsForGeometry(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return geometry.coordinates;
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.flat();
  return [];
}

export function distanceToFeatureBoundaryMeters(point, feature) {
  let best = Infinity;
  for (const ring of ringsForGeometry(feature?.geometry)) {
    for (let i = 1; i < ring.length; i += 1) {
      best = Math.min(best, distancePointToSegmentMeters(point, ring[i - 1], ring[i]));
    }
    if (ring.length > 2) {
      best = Math.min(
        best,
        distancePointToSegmentMeters(point, ring[ring.length - 1], ring[0]),
      );
    }
  }
  return best;
}

export function featureName(feature) {
  const p = feature?.properties || {};
  return (
    p.TALB2026_V1_00_NAME ||
    p.CB2026_V1_00_NAME ||
    p.name ||
    'Unknown Local Board'
  );
}

export function featureCode(feature) {
  const p = feature?.properties || {};
  return p.TALB2026_V1_00 || p.CB2026_V1_00 || p.code || '';
}

export function classifyPoint(point, features, nearestFallbackMeters = 500) {
  const coordinate = [point.lon, point.lat];
  const containing = features.find((feature) => pointInFeature(coordinate, feature));
  if (containing) {
    return {
      feature: containing,
      name: featureName(containing),
      code: featureCode(containing),
      mode: 'inside',
      boundaryDistance: distanceToFeatureBoundaryMeters(coordinate, containing),
    };
  }

  let nearest = null;
  let nearestDistance = Infinity;
  for (const feature of features) {
    const distance = distanceToFeatureBoundaryMeters(coordinate, feature);
    if (distance < nearestDistance) {
      nearest = feature;
      nearestDistance = distance;
    }
  }

  if (nearest && nearestDistance <= nearestFallbackMeters) {
    return {
      feature: nearest,
      name: featureName(nearest),
      code: featureCode(nearest),
      mode: 'nearest',
      boundaryDistance: nearestDistance,
    };
  }

  return null;
}

export function nearestStation(point, stations) {
  let nearest = null;
  let distance = Infinity;
  for (const station of stations) {
    const d = haversineMeters(point, station);
    if (d < distance) {
      distance = d;
      nearest = station;
    }
  }
  return nearest ? { station: nearest, distance } : null;
}

export function geometryBounds(featureOrFeatures) {
  const features = Array.isArray(featureOrFeatures)
    ? featureOrFeatures
    : [featureOrFeatures];
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;

  const visit = (coords) => {
    if (!Array.isArray(coords)) return;
    if (typeof coords[0] === 'number' && typeof coords[1] === 'number') {
      minLon = Math.min(minLon, coords[0]);
      maxLon = Math.max(maxLon, coords[0]);
      minLat = Math.min(minLat, coords[1]);
      maxLat = Math.max(maxLat, coords[1]);
      return;
    }
    coords.forEach(visit);
  };

  features.forEach((feature) => visit(feature?.geometry?.coordinates));
  if (!Number.isFinite(minLon)) return null;
  return { minLon, minLat, maxLon, maxLat };
}
