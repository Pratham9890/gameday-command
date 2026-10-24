/**
 * Downloads the Ohio Stadium area from OpenStreetMap and saves a trimmed
 * extract to world/data/ohio-stadium.osm.json.
 *
 *   npm run fetch-map
 *
 * Run once. The extract is committed so the demo works with no network. Data is
 * © OpenStreetMap contributors, ODbL.
 *
 * Note: this must run outside a sandboxed shell. Overpass answers 406 to the
 * Claude Code sandbox's egress proxy.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** Ohio Stadium, OSM way 119153498 (leisure=stadium, capacity 104944). */
const CENTER = { lat: 40.0016478, lon: -83.0197398 };
/** "Stadium plus about half a mile" in every direction. */
const RADIUS_M = 800;

const OVERPASS = process.env.OVERPASS_URL ?? 'https://overpass-api.de/api/interpreter';
const OUT = resolve(import.meta.dirname, '../data/ohio-stadium.osm.json');

/** Tags the rasterizer actually reads. Everything else is dropped to keep the extract small. */
const KEEP_TAGS = new Set([
  'leisure', 'building', 'building:part', 'highway', 'amenity', 'landuse', 'barrier',
  'footway', 'service', 'name', 'ref', 'access', 'width', 'lanes', 'tunnel', 'bridge',
  'area', 'surface', 'parking', 'sport', 'capacity', 'man_made', 'wall', 'fence_type',
]);

function bbox() {
  const dLat = RADIUS_M / 111_320;
  const dLon = RADIUS_M / (111_320 * Math.cos((CENTER.lat * Math.PI) / 180));
  return {
    south: CENTER.lat - dLat,
    west: CENTER.lon - dLon,
    north: CENTER.lat + dLat,
    east: CENTER.lon + dLon,
  };
}

function query(): string {
  const b = bbox();
  const box = `${b.south.toFixed(7)},${b.west.toFixed(7)},${b.north.toFixed(7)},${b.east.toFixed(7)}`;
  return `[out:json][timeout:180];
(
  way["leisure"="stadium"](${box});
  way["building"](${box});
  way["highway"](${box});
  way["amenity"="parking"](${box});
  way["landuse"](${box});
  way["leisure"](${box});
  way["barrier"](${box});
  way["man_made"="bridge"](${box});
  relation["building"](${box});
  relation["amenity"="parking"](${box});
  relation["leisure"="stadium"](${box});
);
out geom;`;
}

interface OsmElement {
  type: string;
  id: number;
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
  members?: { type: string; role: string; geometry?: { lat: number; lon: number }[] }[];
}

function trim(element: OsmElement): OsmElement | null {
  const tags: Record<string, string> = {};
  for (const [key, value] of Object.entries(element.tags ?? {})) {
    if (KEEP_TAGS.has(key)) tags[key] = value;
  }
  if (Object.keys(tags).length === 0) return null;

  // Round to 7 decimals (about 1 cm) — far finer than a 2 m grid needs.
  const round = (points: { lat: number; lon: number }[]) =>
    points.map((p) => ({ lat: Number(p.lat.toFixed(7)), lon: Number(p.lon.toFixed(7)) }));

  const out: OsmElement = { type: element.type, id: element.id, tags };
  if (element.geometry) out.geometry = round(element.geometry);
  if (element.members) {
    out.members = element.members
      .filter((m) => m.geometry)
      .map((m) => ({ type: m.type, role: m.role, geometry: round(m.geometry!) }));
  }
  return out.geometry || out.members?.length ? out : null;
}

const b = bbox();
console.log(`fetching OSM around Ohio Stadium, ${RADIUS_M} m radius`);
console.log(`bbox ${b.south.toFixed(5)},${b.west.toFixed(5)} .. ${b.north.toFixed(5)},${b.east.toFixed(5)}`);

const res = await fetch(OVERPASS, {
  method: 'POST',
  headers: {
    'content-type': 'application/x-www-form-urlencoded',
    'user-agent': 'GamedayCommand/0.1 (HackOHIO student project)',
  },
  body: new URLSearchParams({ data: query() }),
});

if (!res.ok) {
  console.error(`Overpass returned ${res.status} ${res.statusText}`);
  console.error(await res.text().catch(() => ''));
  process.exit(1);
}

const raw = (await res.json()) as { elements: OsmElement[] };
const elements = raw.elements.map(trim).filter((e): e is OsmElement => e !== null);

const counts = new Map<string, number>();
for (const element of elements) {
  for (const key of ['leisure', 'building', 'highway', 'amenity', 'landuse', 'barrier']) {
    if (element.tags?.[key]) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
}

const bundle = {
  source: 'OpenStreetMap via Overpass API, © OpenStreetMap contributors, ODbL',
  fetchedAt: new Date().toISOString(),
  center: CENTER,
  radiusM: RADIUS_M,
  bbox: b,
  elements,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(bundle));
const mb = (JSON.stringify(bundle).length / 1_048_576).toFixed(2);

console.log(`kept ${elements.length} of ${raw.elements.length} elements, ${mb} MB`);
for (const [key, n] of [...counts].sort((a, b2) => b2[1] - a[1])) console.log(`  ${key}: ${n}`);
console.log(`wrote ${OUT}`);
