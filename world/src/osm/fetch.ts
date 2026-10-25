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
/** Public mirrors, tried in turn when the main server is busy (504/429 are common at peak). */
const OVERPASS_MIRRORS = ['https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
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

/**
 * Download and trim the area around a stadium, trying mirrors when a server is busy.
 * `onBytes` gets the running total of body bytes as the Overpass answer streams in
 * (Overpass sends no length, so this is progress by size, not a percentage).
 */
export async function fetchExtract(
  center: LatLon,
  radiusM = STADIUM_RADIUS_M,
  url = OVERPASS_URL,
  onBytes?: (totalBytes: number) => void,
): Promise<OsmExtract & { bbox: ReturnType<typeof bboxAround> }> {
  let raw: { elements: OsmElement[] } | null = null;
  const errors: string[] = [];
  for (const server of [url, ...OVERPASS_MIRRORS.filter((m) => m !== url)]) {
    try {
      const res = await fetch(server, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': USER_AGENT },
        body: new URLSearchParams({ data: extractQuery(center, radiusM) }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) {
        errors.push(`${new URL(server).host} ${res.status}`);
        continue;
      }
      // Read the body by hand so the import screen can show bytes arriving.
      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let text = '';
      let total = 0;
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          total += value.byteLength;
          text += decoder.decode(value, { stream: true });
          try {
            onBytes?.(total);
          } catch {
            // Progress is best effort: a broken UI stream must not fail the download.
          }
        }
        text += decoder.decode();
      } else {
        text = await res.text();
        total = text.length;
        try {
          onBytes?.(total);
        } catch {
          // As above.
        }
      }
      raw = JSON.parse(text) as { elements: OsmElement[] };
      break;
    } catch (error) {
      errors.push(`${new URL(server).host} ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!raw) throw new Error(`every Overpass server failed (${errors.join('; ')}). Try again in a minute.`);
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
  /** Address parts from Nominatim, when it answered with `addressdetails`. */
  city?: string;
  state?: string;
  country?: string;
  osmType: 'way' | 'relation' | 'node';
  osmId: number;
  lat: number;
  lon: number;
  capacity?: number;
  /** Wikidata item, when OSM links one: where the home team and real capacity come from. */
  wikidata?: string;
}

/** Picks the first non-empty string: Nominatim files places under different keys by size. */
function firstOf(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (value?.trim()) return value.trim();
  }
  return undefined;
}

/** Find stadiums by name through Nominatim. Only leisure=stadium results come back. */
export async function searchStadiums(q: string, url = NOMINATIM_URL): Promise<StadiumHit[]> {
  const params = new URLSearchParams({ q, format: 'jsonv2', limit: '15', extratags: '1', addressdetails: '1' });
  const res = await fetch(`${url}/search?${params}`, { headers: { 'user-agent': USER_AGENT, 'accept-language': 'en' } });
  if (!res.ok) throw new Error(`Nominatim returned ${res.status} ${res.statusText}`);
  const rows = (await res.json()) as {
    category?: string; type?: string; osm_type: string; osm_id: number; lat: string; lon: string;
    name?: string; display_name: string; address?: Record<string, string>;
    extratags?: Record<string, string>; importance?: number;
  }[];
  // Most important first: "Beaver Stadium" should find Penn State's before a
  // high-school ground of the same name.
  rows.sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0));
  return rows
    .filter((r) => r.category === 'leisure' && r.type === 'stadium' && (r.osm_type === 'way' || r.osm_type === 'relation'))
    .map((r) => {
      // City, state, country reads better than the street and neighbourhood that
      // display_name starts with. Only fall back to display_name when address is empty.
      const city = firstOf(r.address?.city, r.address?.town, r.address?.village, r.address?.municipality, r.address?.county);
      const state = firstOf(r.address?.state, r.address?.region, r.address?.province);
      const country = firstOf(r.address?.country);
      const where = [city, state, country].filter((part): part is string => !!part).join(', ')
        || r.display_name.split(',').slice(1, 4).join(',').trim();
      return {
        name: r.name || r.display_name.split(',')[0]!,
        where,
        city,
        state,
        country,
        osmType: r.osm_type as StadiumHit['osmType'],
        osmId: r.osm_id,
        lat: Number(r.lat),
        lon: Number(r.lon),
        capacity: Number(r.extratags?.capacity) || undefined,
        wikidata: /^Q\d+$/.test(r.extratags?.wikidata ?? '') ? r.extratags!.wikidata : undefined,
      };
    });
}

/** Home teams (in Wikidata's order) and maximum capacity for a stadium's Wikidata item. Best effort: empty on any failure. */
export async function stadiumFacts(qid: string): Promise<{ teams: string[]; capacity?: number }> {
  if (!/^Q\d+$/.test(qid)) return { teams: [] };
  const query = `SELECT ?teamLabel ?cap WHERE { OPTIONAL { wd:${qid} wdt:P1083 ?cap } OPTIONAL { wd:${qid} wdt:P466 ?team } SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } }`;
  try {
    const res = await fetch(`https://query.wikidata.org/sparql?query=${encodeURIComponent(query)}`, {
      headers: { accept: 'application/sparql-results+json', 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { teams: [] };
    const rows = ((await res.json()) as { results: { bindings: { teamLabel?: { value: string }; cap?: { value: string } }[] } }).results.bindings;
    const teams = [...new Set(rows.map((r) => r.teamLabel?.value).filter((t): t is string => !!t && !/^Q\d+$/.test(t)))];
    const caps = rows.map((r) => Number(r.cap?.value)).filter((n) => n > 1000);
    return { teams, capacity: caps.length ? Math.max(...caps) : undefined };
  } catch {
    return { teams: [] };
  }
}
