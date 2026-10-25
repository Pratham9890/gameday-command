import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CellKind, Id, MapBundle, Place, StadiumTheme } from '../../../contracts.ts';
import { OHIO_THEME, themeFor } from '../teams.ts';
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
/** How deep the queue block outside a gate runs, in cells. */
const GATE_DEPTH_CELLS = 4;
/** Field plus sidelines and end zones, 160 ft by 360 ft with a margin. */
const FIELD_WIDTH_M = 61;
const FIELD_LENGTH_M = 122;
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

/**
 * A multipolygon's outer boundary is often split across several ways that only
 * make a ring when joined end to end. Taking the first way on its own gave
 * Lumen Field a 20-point sliver for a stadium. Pieces that never close are kept
 * as they are, which is what OSM data that is mid-edit looks like.
 */
export function assembleRings(pieces: OsmGeometryPoint[][]): OsmGeometryPoint[][] {
  const same = (a: OsmGeometryPoint, b: OsmGeometryPoint) => a.lat === b.lat && a.lon === b.lon;
  const open = pieces.filter((p) => p.length > 1).map((p) => [...p]);
  const rings: OsmGeometryPoint[][] = [];
  while (open.length > 0) {
    let ring = open.shift()!;
    let grew = true;
    while (!same(ring[0]!, ring[ring.length - 1]!) && grew) {
      grew = false;
      for (let i = 0; i < open.length; i++) {
        const next = open[i]!;
        const tail = ring[ring.length - 1]!;
        if (same(tail, next[0]!)) ring = [...ring, ...next.slice(1)];
        else if (same(tail, next[next.length - 1]!)) ring = [...ring, ...next.slice(0, -1).reverse()];
        else continue;
        open.splice(i, 1);
        grew = true;
        break;
      }
    }
    rings.push(ring);
  }
  return rings;
}

function ringsOf(element: OsmElement): OsmGeometryPoint[][] {
  if (element.geometry) return [element.geometry];
  return assembleRings((element.members ?? []).filter((m) => m.role !== 'inner' && m.geometry).map((m) => m.geometry!));
}

/** The biggest ring of an element: a stadium's outline, not a stray piece of it. */
const outerRing = (element: OsmElement) => ringsOf(element).sort((a, b) => ringExtent(b) - ringExtent(a))[0] ?? [];

/**
 * Paints the OSM extract onto a 2 m grid.
 *
 * Open ground is the default rather than the exception: a game-day crowd walks
 * across lawns and plazas that OSM never tagged, so starting from 'walk' and
 * subtracting buildings and walls models the real space far better than
 * starting from 'blocked' and only adding mapped paths.
 */
/** Which stadium to build, for maps imported from anywhere. Ohio Stadium when left out. */
export interface StadiumOptions {
  id?: string;
  name?: string;
  /** The OSM id of the leisure=stadium way or relation to build around. */
  stadiumOsmId?: number;
  capacity?: number;
  /** Home-team colours; worked out from the name when left out. */
  theme?: StadiumTheme;
}

const OHIO_CAPACITY = 104_944;
/** Ohio Stadium has 12 gates for about 105,000; other stadiums scale from that. */
const SEATS_PER_GATE = OHIO_CAPACITY / GATE_COUNT;

export function buildStadiumMap(extract: OsmExtract, options: StadiumOptions = {}): MapBundle {
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

  // 2. Ways: roads and footpaths. Road centrelines are kept as well, so the
  // app can paint lane markings and street names over the 2 m cells.
  const streets: { name: string; kind: string; points: number[] }[] = [];
  for (const element of extract.elements) {
    const highway = element.tags?.highway;
    if (!highway || !element.geometry) continue;
    const points = project(element.geometry);
    if (FOOT_WAYS.has(highway)) strokePolyline(points, 0, width, height, set('walk'));
    else if (highway in ROAD_RADIUS) {
      strokePolyline(points, ROAD_RADIUS[highway]!, width, height, set('road'));
      streets.push({
        name: element.tags?.name ?? '',
        kind: highway,
        points: points.flatMap((p) => [(p.x + 0.5) * CELL_SIZE_M, (p.y + 0.5) * CELL_SIZE_M]),
      });
    }
  }

  // The extract holds more than one leisure=stadium (St John Arena is next
  // door). Take the one actually named Ohio Stadium, else the biggest — picking
  // the last match silently gave us the arena and a bowl a third of the size.
  // An imported stadium names its own OSM id.
  const stadium =
    (options.stadiumOsmId !== undefined ? stadiumCandidates.find((e) => e.id === options.stadiumOsmId) : undefined) ??
    stadiumCandidates.find((e) => (e.tags?.name ?? '').toLowerCase().includes((options.name ?? 'Ohio Stadium').toLowerCase())) ??
    stadiumCandidates.sort((a, b) => ringExtent(outerRing(b)) - ringExtent(outerRing(a)))[0];
  // Capacity: what the import was told, else OSM's tag, else (for an imported
  // stadium) an estimate from the outline at Ohio Stadium's ~2.7 people/m².
  const outline = stadium ? project(outerRing(stadium)) : [];
  let outlineCells = 0;
  fillPolygon(outline, width, height, () => outlineCells++);
  const estimated = options.id === undefined ? OHIO_CAPACITY : Math.round(outlineCells * CELL_SIZE_M * CELL_SIZE_M * 2.7);
  const capacity = options.capacity ?? (Number(stadium?.tags?.capacity) || estimated);
  const gateCount = Math.max(2, Math.min(16, Math.round(capacity / SEATS_PER_GATE)));
  // A small ground gets narrow gate openings, or the openings are the stadium.
  const gateHalfWidth = outlineCells > 4000 ? GATE_HALF_WIDTH_CELLS : 1;

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
  const stadiumRing = project(outerRing(stadium));
  if (stadiumRing.length < 3) throw new Error('stadium element has no usable ring');

  // 5. The bowl: seating inside, a concourse ring around the rim.
  let bowlArea = 0;
  fillPolygon(stadiumRing, width, height, (cell) => {
    bowlArea++;
    set('stands')(cell);
  });
  // A small stadium (a high-school ground is a few hundred cells) would lose
  // every seat to a two-cell concourse ring, so the ring thins with the bowl.
  const concourseRadius = bowlArea > 4000 ? CONCOURSE_RADIUS_CELLS : bowlArea > 600 ? 1 : 0;
  strokePolyline(stadiumRing, concourseRadius, width, height, set('concourse'));

  // The shell: every outside cell touching the concourse becomes wall, and the
  // gates below punch the only openings through it. Without it the rim was
  // open all the way round, so a fan admitted ten steps short of their gate
  // walked to their seat by whatever bit of rim was nearest — measured at
  // 318,299 steps into the bowl more than 30 m from any gate in one game.
  // Touching includes diagonals, so no diagonal step can slip through either.
  const shell: number[] = [];
  for (let cell = 0; cell < cells.length; cell++) {
    if (cells[cell] !== 'concourse') continue;
    const cx = cell % width;
    const cy = (cell / width) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const kind = cells[y * width + x];
        if (kind !== 'stands' && kind !== 'concourse') shell.push(y * width + x);
      }
    }
  }
  for (const cell of shell) cells[cell] = 'blocked';

  // 6. Gates: corridors punched through the concourse at even bearings.
  const centroid = stadiumRing.reduce(
    (acc, p) => ({ x: acc.x + p.x / stadiumRing.length, y: acc.y + p.y / stadiumRing.length }),
    { x: 0, y: 0 },
  );

  const gates: Place[] = [];
  const closables: { id: Id; name: string; cells: number[] }[] = [];

  for (let g = 0; g < gateCount; g++) {
    // Screen bearing: y grows south, so negative y is north.
    const bearing = (g / gateCount) * Math.PI * 2;
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
    strokeLine(outside, inside, gateHalfWidth, width, height, set('walk'));

    // The gate is a block of cells outside the mouth, not a single arc: the
    // queue standing on it is what gets admitted. A one-cell-deep arc fills with
    // fans who have ALREADY been admitted and are walking inward, so no waiting
    // fan can ever stand on the turnstile and admission ends up limited by the
    // geometry instead of by the gate's throughput.
    const px = -ny;
    const py = nx;
    const gateCells: number[] = [];
    for (let depth = 0; depth < GATE_DEPTH_CELLS; depth++) {
      const cx = best.x + nx * (CONCOURSE_RADIUS_CELLS + 2 + depth);
      const cy = best.y + ny * (CONCOURSE_RADIUS_CELLS + 2 + depth);
      for (let k = -gateHalfWidth; k <= gateHalfWidth; k++) {
        const x = Math.round(cx + px * k);
        const y = Math.round(cy + py * k);
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const cell = y * width + x;
        cells[cell] = 'walk';
        if (!gateCells.includes(cell)) gateCells.push(cell);
      }
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
  const bowlCells: number[] = [];
  const concourseCells: number[] = [];
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] === 'stands') bowlCells.push(i);
    else if (cells[i] === 'concourse') concourseCells.push(i);
  }

  // The playing field: a regulation field plus sidelines at the middle of the
  // bowl, along the bowl's own long axis. OSM draws the stadium as one polygon,
  // so without this every cell of it was a seat and a seventh of the crowd sat
  // on the turf. Not every stadium runs north-south, so the axis comes from the
  // shape (snapped to north-south when within 8°, which keeps Ohio Stadium
  // exactly as it was), and a small bowl gets a field it can hold.
  let bx = 0;
  let by = 0;
  for (const c of bowlCells) {
    bx += c % width;
    by += (c / width) | 0;
  }
  bx /= Math.max(1, bowlCells.length);
  by /= Math.max(1, bowlCells.length);
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const c of bowlCells) {
    const dx = (c % width) + 0.5 - bx;
    const dy = ((c / width) | 0) + 0.5 - by;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  // Angle of the long axis from screen-north (the y axis), clockwise.
  let axis = 0.5 * Math.atan2(2 * sxy, syy - sxx);
  if (Math.abs(axis) < (8 * Math.PI) / 180) axis = 0;
  // What the field is marked for. A cricket or baseball ground is a big oval of
  // grass, not a gridiron; a football pitch is a little wider and shorter.
  const sportTag = (stadium?.tags?.sport ?? '').toLowerCase();
  const sport: NonNullable<MapBundle['sport']> = /american_football/.test(sportTag)
    ? 'football'
    : /cricket/.test(sportTag)
      ? 'cricket'
      : /baseball|softball/.test(sportTag)
        ? 'baseball'
        : /soccer/.test(sportTag)
          ? 'soccer'
          : 'football';
  const [fieldW, fieldL] = sport === 'soccer' ? [76, 113] : [FIELD_WIDTH_M, FIELD_LENGTH_M];
  const fit = Math.min(1, Math.sqrt((bowlCells.length * 0.24 * CELL_SIZE_M * CELL_SIZE_M) / (fieldW * fieldL)));
  const halfW = (fieldW * fit) / 2 / CELL_SIZE_M;
  const halfL = (fieldL * fit) / 2 / CELL_SIZE_M;
  const cos = Math.cos(axis);
  const sin = Math.sin(axis);
  // An oval ground's outfield fills most of the bowl: an ellipse with the
  // bowl's own proportions, holding about half its cells.
  const spreadU = Math.sqrt(Math.max(1, (sxx + syy - Math.hypot(sxx - syy, 2 * sxy)) / 2 / Math.max(1, bowlCells.length)));
  const spreadV = Math.sqrt(Math.max(1, (sxx + syy + Math.hypot(sxx - syy, 2 * sxy)) / 2 / Math.max(1, bowlCells.length)));
  const oval = sport === 'cricket' || sport === 'baseball';
  const field: number[] = [];
  const standsCells: number[] = [];
  for (const c of bowlCells) {
    const dx = (c % width) + 0.5 - bx;
    const dy = ((c / width) | 0) + 0.5 - by;
    // Into the field's own frame: u across it, v along it.
    const u = dx * cos - dy * sin;
    const v = dx * sin + dy * cos;
    const inside = oval ? (u / (spreadU * 1.35)) ** 2 + (v / (spreadV * 1.35)) ** 2 <= 1 : Math.abs(u) <= halfW && Math.abs(v) <= halfL;
    if (inside) field.push(c);
    else standsCells.push(c);
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
    places.push({ id: 'stands', name: 'Stands', kind: 'seating', cells: standsCells, capacity });
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
    id: options.id ?? STADIUM_MAP_ID,
    name: `${options.name ?? stadium?.tags?.name ?? 'Ohio Stadium'} + 0.5 mi`,
    width,
    height,
    cells,
    places,
    closables,
    streets,
    field,
    fieldAxis: axis,
    sport,
    theme: options.theme ?? (options.id === undefined ? OHIO_THEME : themeFor(options.name ?? stadium?.tags?.name ?? '')),
    sources: [
      { label: 'Map geometry: OpenStreetMap contributors (ODbL)', url: `https://www.openstreetmap.org/${stadium.type}/${stadium.id}` },
      { label: `Fetched ${extract.fetchedAt.slice(0, 10)} via Overpass API`, url: 'https://overpass-api.de/' },
      { label: `Assumption, not mapped data: ${gateCount} gates placed at even bearings, ${GATE_THROUGHPUT_PER_MIN} people/min each`, url: 'local' },
    ],
  };
}
