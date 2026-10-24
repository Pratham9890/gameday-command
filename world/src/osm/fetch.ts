import type { LatLon } from './raster.ts';
import type { OsmElement, OsmExtract } from './stadium.ts';

/**
 * Getting any stadium from OpenStreetMap: find it by name, then download the
 * area around it in the same trimmed form the committed Ohio Stadium extract
 * uses. Shared by `npm run fetch-map` and the server's import route.
 *
 * Network note: Overpass answers 406 to the Claude Code sandbox's egress
 * proxy, so this has to run from a normal process (the server, a terminal).
 */

export const OVERPASS_URL = process.env.OVERPASS_URL ?? 'https://overpass-api.de/api/interpreter';
export const NOMINATIM_URL = process.env.NOMINATIM_URL ?? 'https://nominatim.openstreetmap.org';
const USER_AGENT = 'GamedayCommand/0.1 (HackOHIO student project)';

/** "Stadium plus about half a mile" in every direction. */
export const STADIUM_RADIUS_M = 800;

/** Tags the rasterizer actually reads. Everything else is dropped to keep the extract small. */
const KEEP_TAGS = new Set([
  'leisure', 'building', 'building:part', 'highway', 'amenity', 'landuse', 'barrier',
  'footway', 'service', 'name', 'ref', 'access', 'width', 'lanes', 'tunnel', 'bridge',
  'area', 'surface', 'parking', 'sport', 'capacity', 'man_made', 'wall', 'fence_type',
]);

export function bboxAround(center: LatLon, radiusM: number) {
  const dLat = radiusM / 111_320;
  const dLon = radiusM / (111_320 * Math.cos((center.lat * Math.PI) / 180));
  return { south: center.lat - dLat, west: center.lon - dLon, north: center.lat + dLat, east: center.lon + dLon };
}

export function extractQuery(center: LatLon, radiusM: number): string {
  const b = bboxAround(center, radiusM);
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

export function trimElement(element: OsmElement): OsmElement | null {
  const tags: Record<string, string> = {};
  for (const [key, value] of Object.entries(element.tags ?? {})) {
    if (KEEP_TAGS.has(key)) tags[key] = value;
  }
  if (Object.keys(tags).length === 0) return null;
  // Round to 7 decimals (about 1 cm), far finer than a 2 m grid needs.
  const round = (points: { lat: number; lon: number }[]) =>
    points.map((p) => ({ lat: Number(p.lat.toFixed(7)), lon: Number(p.lon.toFixed(7)) }));
  const out: OsmElement = { type: element.type, id: element.id, tags };
  if (element.geometry) out.geometry = round(element.geometry);
  if (element.members) {
    out.members = element.members.filter((m) => m.geometry).map((m) => ({ type: m.type, role: m.role, geometry: round(m.geometry!) }));
  }
  return out.geometry || out.members?.length ? out : null;
}

/** Download and trim the area around a stadium. Throws with Overpass's own message on failure. */
export async function fetchExtract(center: LatLon, radiusM = STADIUM_RADIUS_M, url = OVERPASS_URL): Promise<OsmExtract & { bbox: ReturnType<typeof bboxAround> }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': USER_AGENT },
    body: new URLSearchParams({ data: extractQuery(center, radiusM) }),
  });
  if (!res.ok) throw new Error(`Overpass returned ${res.status} ${res.statusText}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const raw = (await res.json()) as { elements: OsmElement[] };
  return {
    source: 'OpenStreetMap via Overpass API, © OpenStreetMap contributors, ODbL',
    fetchedAt: new Date().toISOString(),
    center,
    radiusM,
    bbox: bboxAround(center, radiusM),
    elements: raw.elements.map(trimElement).filter((e): e is OsmElement => e !== null),
  };
}

export interface StadiumHit {
  name: string;
  where: string;
  osmType: 'way' | 'relation' | 'node';
  osmId: number;
  lat: number;
  lon: number;
  capacity?: number;
}

/** Find stadiums by name through Nominatim. Only leisure=stadium results come back. */
export async function searchStadiums(q: string, url = NOMINATIM_URL): Promise<StadiumHit[]> {
  const params = new URLSearchParams({ q, format: 'jsonv2', limit: '15', extratags: '1' });
  const res = await fetch(`${url}/search?${params}`, { headers: { 'user-agent': USER_AGENT, 'accept-language': 'en' } });
  if (!res.ok) throw new Error(`Nominatim returned ${res.status} ${res.statusText}`);
  const rows = (await res.json()) as {
    category?: string; type?: string; osm_type: string; osm_id: number; lat: string; lon: string;
    name?: string; display_name: string; extratags?: Record<string, string>;
  }[];
  return rows
    .filter((r) => r.category === 'leisure' && r.type === 'stadium' && (r.osm_type === 'way' || r.osm_type === 'relation'))
    .map((r) => ({
      name: r.name || r.display_name.split(',')[0]!,
      where: r.display_name.split(',').slice(1, 4).join(',').trim(),
      osmType: r.osm_type as StadiumHit['osmType'],
      osmId: r.osm_id,
      lat: Number(r.lat),
      lon: Number(r.lon),
      capacity: Number(r.extratags?.capacity) || undefined,
    }));
}
