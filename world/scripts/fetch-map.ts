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
import { fetchExtract } from '../src/osm/fetch.ts';

/** Ohio Stadium, OSM way 119153498 (leisure=stadium, capacity 104944). */
const CENTER = { lat: 40.0016478, lon: -83.0197398 };
/** "Stadium plus about half a mile" in every direction. */
const RADIUS_M = 800;
const OUT = resolve(import.meta.dirname, '../data/ohio-stadium.osm.json');

console.log(`fetching OSM around Ohio Stadium, ${RADIUS_M} m radius`);
let bundle;
try {
  bundle = await fetchExtract(CENTER, RADIUS_M);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const counts = new Map<string, number>();
for (const element of bundle.elements) {
  for (const key of ['leisure', 'building', 'highway', 'amenity', 'landuse', 'barrier']) {
    if (element.tags?.[key]) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(bundle));
const mb = (JSON.stringify(bundle).length / 1_048_576).toFixed(2);

console.log(`kept ${bundle.elements.length} elements, ${mb} MB`);
for (const [key, n] of [...counts].sort((a, b2) => b2[1] - a[1])) console.log(`  ${key}: ${n}`);
console.log(`wrote ${OUT}`);
