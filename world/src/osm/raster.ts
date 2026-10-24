/** Grid painting primitives: project lat/lon to cells, fill polygons, stroke ways. */

export interface LatLon {
  lat: number;
  lon: number;
}

export interface Projection {
  width: number;
  height: number;
  /** Cell index, or -1 when the point falls outside the grid. */
  cellOf(point: LatLon): number;
  xyOf(point: LatLon): { x: number; y: number };
}

const METERS_PER_DEGREE_LAT = 111_320;

/**
 * Local equirectangular projection about the map centre. Over 1.6 km the error
 * against a proper projection is centimetres, well under one 2 m cell.
 */
export function makeProjection(center: LatLon, radiusM: number, cellSizeM: number): Projection {
  const size = Math.round((radiusM * 2) / cellSizeM);
  const metersPerDegreeLon = METERS_PER_DEGREE_LAT * Math.cos((center.lat * Math.PI) / 180);

  const xyOf = (point: LatLon) => {
    const east = (point.lon - center.lon) * metersPerDegreeLon;
    const south = (center.lat - point.lat) * METERS_PER_DEGREE_LAT;
    return {
      x: Math.floor((east + radiusM) / cellSizeM),
      y: Math.floor((south + radiusM) / cellSizeM),
    };
  };

  return {
    width: size,
    height: size,
    xyOf,
    cellOf(point) {
      const { x, y } = xyOf(point);
      if (x < 0 || y < 0 || x >= size || y >= size) return -1;
      return y * size + x;
    },
  };
}

export type Paint = (cell: number) => void;

/** Even-odd scanline fill of a closed ring given in cell coordinates. */
export function fillPolygon(points: { x: number; y: number }[], width: number, height: number, paint: Paint): void {
  if (points.length < 3) return;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  minY = Math.max(0, Math.floor(minY));
  maxY = Math.min(height - 1, Math.ceil(maxY));

  const crossings: number[] = [];
  for (let y = minY; y <= maxY; y++) {
    crossings.length = 0;
    const scan = y + 0.5;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const a = points[j]!;
      const b = points[i]!;
      if (a.y === b.y) continue;
      if (scan < Math.min(a.y, b.y) || scan >= Math.max(a.y, b.y)) continue;
      crossings.push(a.x + ((scan - a.y) / (b.y - a.y)) * (b.x - a.x));
    }
    if (crossings.length < 2) continue;
    crossings.sort((p, q) => p - q);
    for (let k = 0; k + 1 < crossings.length; k += 2) {
      const from = Math.max(0, Math.ceil(crossings[k]! - 0.5));
      const to = Math.min(width - 1, Math.floor(crossings[k + 1]! - 0.5));
      for (let x = from; x <= to; x++) paint(y * width + x);
    }
  }
}

/** Stamp a square brush of `radius` cells at a point. */
function stamp(x: number, y: number, radius: number, width: number, height: number, paint: Paint): void {
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      paint(ny * width + nx);
    }
  }
}

/** Walk a line in cell space, stamping a brush along it. */
export function strokeLine(
  a: { x: number; y: number },
  b: { x: number; y: number },
  radius: number,
  width: number,
  height: number,
  paint: Paint,
): void {
  let x = a.x;
  let y = a.y;
  const dx = Math.abs(b.x - x);
  const dy = Math.abs(b.y - y);
  const sx = x < b.x ? 1 : -1;
  const sy = y < b.y ? 1 : -1;
  let err = dx - dy;
  // Guard against absurd coordinates producing an endless walk.
  const limit = (dx + dy) * 2 + 8;
  for (let steps = 0; steps < limit; steps++) {
    stamp(x, y, radius, width, height, paint);
    if (x === b.x && y === b.y) return;
    const e2 = err * 2;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
  }
}

export function strokePolyline(
  points: { x: number; y: number }[],
  radius: number,
  width: number,
  height: number,
  paint: Paint,
): void {
  for (let i = 1; i < points.length; i++) {
    strokeLine(points[i - 1]!, points[i]!, radius, width, height, paint);
  }
  if (points.length === 1) stamp(points[0]!.x, points[0]!.y, radius, width, height, paint);
}
