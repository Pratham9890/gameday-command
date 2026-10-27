import type { MapBundle, MapGeo } from '../../../contracts.ts';
import type { Classification, GeoExportInput } from '../types.ts';
import { classificationText, SCOPE_LINE } from './html.ts';

/**
 * Closures, posts, zones and markers out to GIS (PLT-32): GeoJSON (RFC 7946,
 * WGS 84 longitude/latitude, exterior rings counter-clockwise) and KML 2.3.
 * The map bundle has no latitude or longitude per cell; `MapBundle.geo` gives
 * the local equirectangular projection the grid was rasterised with (PLAN
 * §5.1), and its inverse puts every cell back on the Earth. Every feature
 * says where it came from: simulated or planned, run, seed, engine, tape.
 */
const METERS_PER_DEGREE = 111_320;

export function worldToLngLat(geo: MapGeo, xM: number, yM: number): [number, number] {
  const lng = geo.center.lon + (xM - geo.radiusM) / (METERS_PER_DEGREE * Math.cos((geo.center.lat * Math.PI) / 180));
  const lat = geo.center.lat - (yM - geo.radiusM) / METERS_PER_DEGREE;
  return [round6(lng), round6(lat)];
}

/** Six decimal places is about 0.1 m, well inside the 2 m grid. */
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

export function cellCentre(map: Pick<MapBundle, 'width'>, cellSizeM: number, cell: number): [number, number] {
  return [((cell % map.width) + 0.5) * cellSizeM, (Math.floor(cell / map.width) + 0.5) * cellSizeM];
}

/** Convex hull (Andrew's monotone chain) of the corners of a set of cells, in metres. */
export function cellsHull(map: Pick<MapBundle, 'width'>, cellSizeM: number, cells: number[]): [number, number][] {
  const points = new Map<string, [number, number]>();
  for (const cell of cells) {
    const x = (cell % map.width) * cellSizeM;
    const y = Math.floor(cell / map.width) * cellSizeM;
    for (const [dx, dy] of [[0, 0], [cellSizeM, 0], [0, cellSizeM], [cellSizeM, cellSizeM]] as const) points.set(`${x + dx},${y + dy}`, [x + dx, y + dy]);
  }
  const sorted = [...points.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (sorted.length < 3) return sorted;
  const cross = (o: number[], a: number[], b: number[]) => (a[0]! - o[0]!) * (b[1]! - o[1]!) - (a[1]! - o[1]!) * (b[0]! - o[0]!);
  const lower: [number, number][] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (const p of [...sorted].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** A closed ring in longitude/latitude, counter-clockwise as RFC 7946 §3.1.6 asks. */
export function ringLngLat(geo: MapGeo, hull: [number, number][]): [number, number][] {
  const ring = hull.map(([x, y]) => worldToLngLat(geo, x, y));
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i]!;
    const [x2, y2] = ring[(i + 1) % ring.length]!;
    area += x1 * y2 - x2 * y1;
  }
  if (area < 0) ring.reverse();
  return [...ring, ring[0]!];
}

export interface GeoFeature {
  type: 'Feature';
  id: string;
  geometry: { type: 'Point'; coordinates: [number, number] } | { type: 'Polygon'; coordinates: [number, number][][] };
  properties: Record<string, string | number | boolean | null>;
}

export interface GeoCollection {
  type: 'FeatureCollection';
  name: string;
  features: GeoFeature[];
  gameday: { schemaVersion: '1.0.0'; mapId: string; generatedAt: string; classification: string; marking: string; banner: string; scope: string };
}

export class GeoError extends Error {}

export interface Feature {
  layer: 'closure' | 'post' | 'zone' | 'marker' | 'gate';
  id: string;
  name: string;
  /** Metres, for the sketch. */
  hull?: [number, number][];
  point?: [number, number];
  props: Record<string, string | number | boolean | null>;
}

/** Resolve an export request against the map into features in world metres. */
export function collectFeatures(input: GeoExportInput, map: MapBundle): Feature[] {
  const cs = map.geo?.cellSizeM ?? 2;
  const places = new Map(map.places.map((p) => [p.id, p]));
  const closables = new Map(map.closables.map((c) => [c.id, c]));
  const out: Feature[] = [];
  const valid = (cells: number[] | undefined) => (cells ?? []).filter((c) => Number.isInteger(c) && c >= 0 && c < map.width * map.height);
  for (const c of input.closures ?? []) {
    const cells = valid(c.cells?.length ? c.cells : c.closableId ? closables.get(c.closableId)?.cells : []);
    if (!cells.length) continue;
    out.push({ layer: 'closure', id: c.id, name: c.name ?? closables.get(c.closableId ?? '')?.name ?? c.id, hull: cellsHull(map, cs, cells), props: { status: c.status ?? 'closed', blocks: c.blocks ?? 'all', closableId: c.closableId ?? null, cells: cells.length } });
  }
  for (const z of input.zones ?? []) {
    const place = z.placeId ? places.get(z.placeId) : undefined;
    const cells = valid(z.cells?.length ? z.cells : place?.cells);
    if (!cells.length) continue;
    out.push({ layer: 'zone', id: z.id, name: z.name ?? place?.name ?? z.id, hull: cellsHull(map, cs, cells), props: { kind: z.kind ?? place?.kind ?? 'zone', placeId: z.placeId ?? null, capacity: place?.capacity ?? null } });
  }
  for (const p of input.posts ?? []) {
    if (!valid([p.cell]).length) continue;
    out.push({ layer: 'post', id: p.id, name: p.unit, point: cellCentre(map, cs, p.cell), props: { unit: p.unit, position: p.position ?? null } });
  }
  for (const m of input.markers ?? []) {
    if (!valid([m.cell]).length) continue;
    out.push({ layer: 'marker', id: m.id, name: m.name, point: cellCentre(map, cs, m.cell), props: { kind: m.kind, radius_m: m.radiusCells === undefined ? null : m.radiusCells * cs, radius_ft: m.radiusCells === undefined ? null : Math.round(m.radiusCells * cs * 3.28084) } });
  }
  if (input.includeMapFeatures) {
    for (const gate of map.places.filter((p) => p.kind === 'gate')) {
      const cells = valid(gate.cells);
      if (!cells.length) continue;
      const pts = cells.map((c) => cellCentre(map, cs, c));
      const centre: [number, number] = [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
      out.push({ layer: 'gate', id: gate.id, name: gate.name, point: centre, props: { throughputPerMin: gate.throughputPerMin ?? null, capacity: gate.capacity } });
    }
  }
  return out;
}

function provenanceProps(input: GeoExportInput, map: MapBundle, generatedAt: string, classification: Classification) {
  const p = input.provenance;
  return {
    provenance: p.kind,
    source: p.source,
    runId: p.runId ?? null,
    seed: p.seed ?? null,
    engineVersion: p.engineVersion ?? null,
    tapeHash: p.tapeHash ?? null,
    planId: p.planId ?? null,
    planVersion: p.planVersion ?? null,
    mapId: map.id,
    generatedAt,
    classification,
  };
}

export function toGeoJson(input: GeoExportInput, map: MapBundle, opts: { generatedAt: string; banner: string }): GeoCollection {
  if (!map.geo) throw new GeoError(`map ${map.id} has no georeference (MapBundle.geo); it cannot be placed on the Earth`);
  const geo = map.geo;
  const classification = input.classification ?? 'internal';
  const base = provenanceProps(input, map, opts.generatedAt, classification);
  const features: GeoFeature[] = collectFeatures(input, map).map((f) => ({
    type: 'Feature',
    id: `${f.layer}:${f.id}`,
    geometry: f.point ? { type: 'Point', coordinates: worldToLngLat(geo, f.point[0], f.point[1]) } : { type: 'Polygon', coordinates: [ringLngLat(geo, f.hull!)] },
    properties: { layer: f.layer, id: f.id, name: f.name, ...f.props, ...base },
  }));
  return {
    type: 'FeatureCollection',
    name: `${map.name}: closures, posts, zones and markers`,
    features,
    gameday: { schemaVersion: '1.0.0', mapId: map.id, generatedAt: opts.generatedAt, classification, marking: classificationText({ classification }), banner: opts.banner, scope: SCOPE_LINE },
  };
}

const xml = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch]!);

/** Greyscale styles (aabbggrr). No icon URLs: the file must open on an air-gapped machine without calling anyone. */
const STYLES: Record<Feature['layer'], { line: string; poly: string; point?: boolean }> = {
  closure: { line: 'ff1a1a1a', poly: '7f3c3c3c' },
  zone: { line: 'ff505050', poly: '00ffffff' },
  post: { line: 'ff1a1a1a', poly: 'ff1a1a1a', point: true },
  marker: { line: 'ff1a1a1a', poly: 'ffffffff', point: true },
  gate: { line: 'ff1a1a1a', poly: 'ffffffff', point: true },
};

const LAYER_NAMES: Record<Feature['layer'], string> = { closure: 'Closures', zone: 'Zones', post: 'Posts', marker: 'Markers', gate: 'Gates' };

/** KML 2.3 (OGC 12-007r2), elements in schema order: name, description, styleUrl, ExtendedData, then the geometry. */
export function toKml(input: GeoExportInput, map: MapBundle, opts: { generatedAt: string; banner: string }): string {
  const collection = toGeoJson(input, map, opts);
  const layers = [...new Set(collection.features.map((f) => f.properties.layer as Feature['layer']))];
  const styles = (Object.keys(STYLES) as Feature['layer'][])
    .map((layer) => {
      const s = STYLES[layer];
      return `<Style id="${layer}">${s.point ? `<IconStyle><color>${s.line}</color><scale>0.8</scale></IconStyle>` : ''}<LineStyle><color>${s.line}</color><width>2</width></LineStyle><PolyStyle><color>${s.poly}</color></PolyStyle></Style>`;
    })
    .join('\n    ');
  const placemark = (f: GeoFeature) => {
    const data = Object.entries(f.properties)
      .map(([k, v]) => `<Data name="${xml(k)}"><value>${xml(v ?? '')}</value></Data>`)
      .join('');
    const geometry =
      f.geometry.type === 'Point'
        ? `<Point><coordinates>${f.geometry.coordinates.join(',')}</coordinates></Point>`
        : `<Polygon><outerBoundaryIs><LinearRing><coordinates>${f.geometry.coordinates[0]!.map((c) => c.join(',')).join(' ')}</coordinates></LinearRing></outerBoundaryIs></Polygon>`;
    return `<Placemark id="${xml(String(f.id).replace(/[^A-Za-z0-9_.-]/g, '_'))}"><name>${xml(f.properties.name)}</name><description>${xml(`${f.properties.layer}; ${f.properties.provenance} (${f.properties.source})`)}</description><styleUrl>#${f.properties.layer}</styleUrl><ExtendedData>${data}</ExtendedData>${geometry}</Placemark>`;
  };
  const folders = layers
    .map((layer) => `<Folder><name>${LAYER_NAMES[layer]}</name>${collection.features.filter((f) => f.properties.layer === layer).map(placemark).join('')}</Folder>`)
    .join('\n    ');
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.3">
  <Document>
    <name>${xml(collection.name)}</name>
    <description>${xml(`${collection.gameday.marking}. ${opts.banner}. ${SCOPE_LINE}`)}</description>
    ${styles}
    <ExtendedData><Data name="mapId"><value>${xml(map.id)}</value></Data><Data name="generatedAt"><value>${xml(opts.generatedAt)}</value></Data><Data name="classification"><value>${xml(collection.gameday.classification)}</value></Data></ExtendedData>
    ${folders}
  </Document>
</kml>
`;
}

/** A plain SVG sketch of the same features, for the ICS 201 box and the plan's map page. */
export function sketchSvg(input: GeoExportInput, map: MapBundle, widthPx: number, heightPx: number): string {
  const features = collectFeatures({ ...input, includeMapFeatures: input.includeMapFeatures ?? true }, map);
  const pts = features.flatMap((f) => (f.point ? [f.point] : (f.hull ?? [])));
  if (!pts.length) return `<svg class="sketch" role="img" aria-label="No features to sketch" viewBox="0 0 ${widthPx} ${heightPx}" width="${widthPx}" height="${heightPx}"><text x="12" y="20">No closures, posts, zones or markers to sketch.</text></svg>`;
  const pad = 60;
  const minX = Math.min(...pts.map((p) => p[0])) - pad;
  const maxX = Math.max(...pts.map((p) => p[0])) + pad;
  const minY = Math.min(...pts.map((p) => p[1])) - pad;
  const maxY = Math.max(...pts.map((p) => p[1])) + pad;
  const scale = Math.min(widthPx / (maxX - minX), heightPx / (maxY - minY));
  const ox = (widthPx - (maxX - minX) * scale) / 2;
  const oy = (heightPx - (maxY - minY) * scale) / 2;
  const X = (x: number) => (ox + (x - minX) * scale).toFixed(1);
  const Y = (y: number) => (oy + (y - minY) * scale).toFixed(1);
  const parts: string[] = [];
  for (const street of map.streets ?? []) {
    const p = street.points;
    let d = '';
    for (let i = 0; i + 1 < p.length; i += 2) d += `${i ? 'L' : 'M'}${X(p[i]!)} ${Y(p[i + 1]!)}`;
    if (d) parts.push(`<path class="road" d="${d}" fill="none" stroke-width="1"/>`);
  }
  const label = (x: number, y: number, text: string) => `<text x="${(Number(X(x)) + 6).toFixed(1)}" y="${(Number(Y(y)) + 3).toFixed(1)}">${xml(text)}</text>`;
  for (const f of features.filter((f) => f.hull)) {
    const d = f.hull!.map(([x, y], i) => `${i ? 'L' : 'M'}${X(x)} ${Y(y)}`).join('') + 'Z';
    parts.push(`<path class="${f.layer === 'closure' ? 'closure' : 'zone'}" d="${d}" stroke-width="1.2"/>`);
    const c = f.hull!.reduce((s, p) => [s[0] + p[0] / f.hull!.length, s[1] + p[1] / f.hull!.length], [0, 0]);
    parts.push(label(c[0], c[1], f.name));
  }
  for (const f of features.filter((f) => f.point)) {
    const [x, y] = f.point!;
    if (f.layer === 'gate') parts.push(`<rect class="gate" x="${(Number(X(x)) - 3.5).toFixed(1)}" y="${(Number(Y(y)) - 3.5).toFixed(1)}" width="7" height="7" stroke-width="1"/>`, label(x, y, f.name));
    else if (f.layer === 'post') parts.push(`<circle class="post" cx="${X(x)}" cy="${Y(y)}" r="3.5"/>`, label(x, y, f.name));
    else {
      const r = typeof f.props.radius_m === 'number' ? Math.max(5, f.props.radius_m * scale) : 6;
      parts.push(`<circle class="marker" cx="${X(x)}" cy="${Y(y)}" r="${r.toFixed(1)}" stroke-width="1" fill-opacity="0.6"/>`, label(x, y, `${f.name} (${f.props.kind})`));
    }
  }
  // Scale bar in feet (US units, PLAN D18) and a north arrow: y runs south in the grid, so north is up.
  const feet = [100, 250, 500, 1000, 2000].find((ft) => ft * 0.3048 * scale >= widthPx * 0.12) ?? 2000;
  const bar = feet * 0.3048 * scale;
  parts.push(
    `<g><rect x="12" y="${heightPx - 22}" width="${bar.toFixed(1)}" height="5" class="post"/><text x="12" y="${heightPx - 26}">${feet.toLocaleString('en-US')} ft</text></g>`,
    `<g><path d="M${widthPx - 20} ${18}l-6 14h12z" class="post"/><text x="${widthPx - 24}" y="44">N</text></g>`,
  );
  return `<svg class="sketch" role="img" aria-label="Sketch of closures, posts, zones and markers on ${xml(map.name)}" viewBox="0 0 ${widthPx} ${heightPx}" width="${widthPx}" height="${heightPx}">${parts.join('')}</svg>`;
}
