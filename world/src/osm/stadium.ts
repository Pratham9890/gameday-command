import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CellKind, Id, MapBundle, Place } from '../../../contracts.ts';
import { CELL_SIZE_M, CONTRACT_VERSION } from '../../../contracts.ts';
import { fillPolygon, makeProjection, strokeLine, strokePolyline, type LatLon } from './raster.ts';

export interface OsmGeometryPoint extends LatLon {}

export interface OsmElement {
  type: string;
  id: number;
  tags?: Record<string, string>;
  geometry?: OsmGeometryPoint[];
  members?: { type: string; role: string; geometry?: OsmGeometryPoint[] }[];
}

export interface OsmExtract {
  source: string;
  fetchedAt: string;
  center: LatLon;
  radiusM: number;
  elements: OsmElement[];
}

export const STADIUM_MAP_ID = 'ohio-stadium';
const EXTRACT_PATH = resolve(import.meta.dirname, '../../data/ohio-stadium.osm.json');

/** Brush radius in cells per highway class; 0 means a single 2 m cell. */
const ROAD_RADIUS: Record<string, number> = {
  motorway: 2, motorway_link: 1, trunk: 2, trunk_link: 1,
  primary: 2, primary_link: 1, secondary: 1, secondary_link: 1,
  tertiary: 1, tertiary_link: 1, residential: 1, unclassified: 1,
  service: 1, living_street: 1,
};
const FOOT_WAYS = new Set(['footway', 'path', 'pedestrian', 'steps', 'cycleway', 'corridor', 'track']);
const BLOCKING_BARRIERS = new Set(['wall', 'fence', 'hedge', 'retaining_wall', 'guard_rail']);

/** A gate's assumed throughput. Ohio Stadium holds 104,944 and fills in roughly an hour. */
export const GATE_THROUGHPUT_PER_MIN = 200;
const GATE_COUNT = 12;
const CONCOURSE_RADIUS_CELLS = 2;
/** Half-width of a gate mouth in cells, so a gate is this*2+1 cells across. */
const GATE_HALF_WIDTH_CELLS = 3;
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

export function loadExtract(path = EXTRACT_PATH): OsmExtract {
  return JSON.parse(readFileSync(path, 'utf8')) as OsmExtract;
}

export function extractExists(path = EXTRACT_PATH): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Rough bounding-box area in square meters, for picking the biggest ring. */
function ringExtent(ring: OsmGeometryPoint[]): number {
  if (ring.length === 0) return 0;
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const p of ring) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }
  return (maxLat - minLat) * (maxLon - minLon);
}

const isClosed = (geometry: OsmGeometryPoint[]) =>
  geometry.length > 3 &&
  geometry[0]!.lat === geometry[geometry.length - 1]!.lat &&
  geometry[0]!.lon === geometry[geometry.length - 1]!.lon;

function ringsOf(element: OsmElement): OsmGeometryPoint[][] {
  if (element.geometry) return [element.geometry];
  return (element.members ?? []).filter((m) => m.role !== 'inner' && m.geometry).map((m) => m.geometry!);
}

/**
 * Paints the OSM extract onto a 2 m grid.
 *
 * Open ground is the default rather than the exception: a game-day crowd walks
 * across lawns and plazas that OSM never tagged, so starting from 'walk' and
 * subtracting buildings and walls models the real space far better than
 * starting from 'blocked' and only adding mapped paths.
 */
export function buildStadiumMap(extract: OsmExtract): MapBundle {
  const projection = makeProjection(extract.center, extract.radiusM, CELL_SIZE_M);
  const { width, height } = projection;
  const cells: CellKind[] = new Array(width * height).fill('walk');
  const set = (kind: CellKind) => (cell: number) => {
    if (cell >= 0 && cell < cells.length) cells[cell] = kind;
  };
  const project = (points: OsmGeometryPoint[]) => points.map((p) => projection.xyOf(p));

  const parkingRings: { name: string; points: { x: number; y: number }[] }[] = [];
  const streetWays = new Map<string, OsmElement[]>();
  const stadiumCandidates: OsmElement[] = [];

  for (const element of extract.elements) {
    const tags = element.tags ?? {};
    if (tags.leisure === 'stadium' && (element.geometry || element.members)) stadiumCandidates.push(element);
    if (tags.amenity === 'parking') {
      for (const ring of ringsOf(element)) {
        if (isClosed(ring)) parkingRings.push({ name: tags.name ?? '', points: project(ring) });
      }
    }
    if (tags.highway && tags.name) {
      const list = streetWays.get(tags.name) ?? [];
      list.push(element);
      streetWays.set(tags.name, list);
    }
  }

  // 1. Parking lots.
  for (const lot of parkingRings) fillPolygon(lot.points, width, height, set('parking'));

  // 2. Ways: roads and footpaths.
  for (const element of extract.elements) {
    const highway = element.tags?.highway;
    if (!highway || !element.geometry) continue;
    const points = project(element.geometry);
    if (FOOT_WAYS.has(highway)) strokePolyline(points, 0, width, height, set('walk'));
    else if (highway in ROAD_RADIUS) strokePolyline(points, ROAD_RADIUS[highway]!, width, height, set('road'));
  }

  // The extract holds more than one leisure=stadium (St John Arena is next
  // door). Take the one actually named Ohio Stadium, else the biggest — picking
  // the last match silently gave us the arena and a bowl a third of the size.
  const stadium =
    stadiumCandidates.find((e) => /Ohio Stadium/i.test(e.tags?.name ?? '')) ??
    stadiumCandidates.sort((a, b) => ringExtent(ringsOf(b)[0] ?? []) - ringExtent(ringsOf(a)[0] ?? []))[0];

  // 3. Buildings win over the ways that pass beside them. Any other stadium or
  // arena in the extract is just a building as far as the crowd is concerned.
  for (const element of extract.elements) {
    const isBuilding = !!element.tags?.building || (element.tags?.leisure === 'stadium' && element !== stadium);
    if (!isBuilding) continue;
    if (element === stadium) continue;
    for (const ring of ringsOf(element)) {
      if (isClosed(ring)) fillPolygon(project(ring), width, height, set('blocked'));
    }
  }

  // 4. Walls and fences, one cell thick.
  for (const element of extract.elements) {
    const barrier = element.tags?.barrier;
    if (!barrier || !BLOCKING_BARRIERS.has(barrier) || !element.geometry) continue;
    strokePolyline(project(element.geometry), 0, width, height, set('blocked'));
  }

  if (!stadium) throw new Error('extract has no leisure=stadium element');
  const stadiumRing = project(ringsOf(stadium)[0] ?? []);
  if (stadiumRing.length < 3) throw new Error('stadium element has no usable ring');

  // 5. The bowl: seating inside, a concourse ring around the rim.
  fillPolygon(stadiumRing, width, height, set('stands'));
  strokePolyline(stadiumRing, CONCOURSE_RADIUS_CELLS, width, height, set('concourse'));

  // 6. Gates: corridors punched through the concourse at even bearings.
  const centroid = stadiumRing.reduce(
    (acc, p) => ({ x: acc.x + p.x / stadiumRing.length, y: acc.y + p.y / stadiumRing.length }),
    { x: 0, y: 0 },
  );

  const gates: Place[] = [];
  const closables: { id: Id; name: string; cells: number[] }[] = [];

  for (let g = 0; g < GATE_COUNT; g++) {
    // Screen bearing: y grows south, so negative y is north.
    const bearing = (g / GATE_COUNT) * Math.PI * 2;
    const want = { x: Math.sin(bearing), y: -Math.cos(bearing) };

    let best = stadiumRing[0]!;
    let bestDot = -Infinity;
    for (const point of stadiumRing) {
      const dx = point.x - centroid.x;
      const dy = point.y - centroid.y;
      const len = Math.hypot(dx, dy) || 1;
      const dot = (dx / len) * want.x + (dy / len) * want.y;
      if (dot > bestDot) {
        bestDot = dot;
        best = point;
      }
    }

    const dx = best.x - centroid.x;
    const dy = best.y - centroid.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = dx / len;
    const ny = dy / len;
    const reach = CONCOURSE_RADIUS_CELLS + 8;
    const outside = { x: Math.round(best.x + nx * reach), y: Math.round(best.y + ny * reach) };
    const inside = { x: Math.round(best.x - nx * reach), y: Math.round(best.y - ny * reach) };

    // A wide mouth: a three-cell gate gets permanently plugged by fans walking
    // past to the next gate and by fans already admitted walking inward, so
    // nobody who actually wants this gate can reach the turnstile.
    strokeLine(outside, inside, GATE_HALF_WIDTH_CELLS, width, height, set('walk'));

    // The gate itself is the arc across the OUTSIDE of the mouth, where the
    // queue forms. Admitted fans walk inward and leave it, instead of standing
    // on the admission point.
    const px = -ny;
    const py = nx;
    const mouth = { x: best.x + nx * (CONCOURSE_RADIUS_CELLS + 2), y: best.y + ny * (CONCOURSE_RADIUS_CELLS + 2) };
    const gateCells: number[] = [];
    for (let k = -GATE_HALF_WIDTH_CELLS; k <= GATE_HALF_WIDTH_CELLS; k++) {
      const x = Math.round(mouth.x + px * k);
      const y = Math.round(mouth.y + py * k);
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const cell = y * width + x;
      cells[cell] = 'walk';
      if (!gateCells.includes(cell)) gateCells.push(cell);
    }
    if (gateCells.length === 0) continue;

    const compass = COMPASS[Math.round((bearing / (Math.PI * 2)) * 16) % 16]!;
    const id = `gate-${g + 1}`;
    gates.push({
      id,
      name: `Gate ${g + 1} (${compass})`,
      kind: 'gate',
      cells: gateCells,
      capacity: 12_000,
      throughputPerMin: GATE_THROUGHPUT_PER_MIN,
    });
    closables.push({ id: `${id}-door`, name: `Gate ${g + 1} door`, cells: [...gateCells] });
  }

  // Places built from what actually landed on the grid.
  const standsCells: number[] = [];
  const concourseCells: number[] = [];
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] === 'stands') standsCells.push(i);
    else if (cells[i] === 'concourse') concourseCells.push(i);
  }

  const lots: Place[] = [];
  parkingRings.forEach((lot, index) => {
    const lotCells: number[] = [];
    fillPolygon(lot.points, width, height, (cell) => {
      if (cells[cell] === 'parking') lotCells.push(cell);
    });
    if (lotCells.length < 25) return;
    lots.push({
      id: `lot-${index + 1}`,
      name: lot.name || `Lot ${lots.length + 1}`,
      kind: 'parking',
      cells: lotCells,
      capacity: lotCells.length * 4,
    });
  });

  // The biggest named streets become closable, for the suspicious package.
  const streetCells = [...streetWays.entries()]
    .map(([name, ways]) => {
      const list: number[] = [];
      for (const way of ways) {
        if (!way.geometry) continue;
        const radius = ROAD_RADIUS[way.tags?.highway ?? ''] ?? 0;
        strokePolyline(project(way.geometry), radius, width, height, (cell) => {
          if (cells[cell] === 'road' || cells[cell] === 'walk') list.push(cell);
        });
      }
      return { name, cells: [...new Set(list)] };
    })
    .filter((s) => s.cells.length >= 60)
    .sort((a, b) => b.cells.length - a.cells.length)
    .slice(0, 10);

  for (const street of streetCells) {
    closables.push({
      id: `street-${street.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      name: street.name,
      cells: street.cells,
    });
  }

  const places: Place[] = [...gates];
  if (standsCells.length > 0) {
    places.push({ id: 'stands', name: 'Stands', kind: 'seating', cells: standsCells, capacity: 104_944 });
  }
  if (concourseCells.length > 0) {
    places.push({ id: 'concourse', name: 'Concourse', kind: 'concourse', cells: concourseCells, capacity: 40_000 });
  }
  // A combined lots place goes first, so the engine needs one flow field for
  // "walk back to your car" instead of one per lot. The named lots stay for the
  // map, the plan editor and the scorecard.
  const allParkingCells: number[] = [];
  for (let i = 0; i < cells.length; i++) if (cells[i] === 'parking') allParkingCells.push(i);
  if (allParkingCells.length > 0) {
    places.push({
      id: 'lots',
      name: 'All lots',
      kind: 'parking',
      cells: allParkingCells,
      capacity: allParkingCells.length * 4,
    });
  }
  places.push(...lots);

  return {
    version: CONTRACT_VERSION,
    id: STADIUM_MAP_ID,
    name: 'Ohio Stadium + 0.5 mi',
    width,
    height,
    cells,
    places,
    closables,
    sources: [
      { label: 'Map geometry: OpenStreetMap contributors (ODbL)', url: 'https://www.openstreetmap.org/way/119153498' },
      { label: `Fetched ${extract.fetchedAt.slice(0, 10)} via Overpass API`, url: 'https://overpass-api.de/' },
      { label: `Assumption, not mapped data: ${GATE_COUNT} gates placed at even bearings, ${GATE_THROUGHPUT_PER_MIN} people/min each`, url: 'local' },
    ],
  };
}
