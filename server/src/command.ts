import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Hono } from 'hono';
import type { MapBundle } from '../../contracts.ts';
import { fetchExtract, searchStadiums, stadiumFacts } from '../../world/src/osm/fetch.ts';
import { themeFor } from '../../world/src/teams.ts';
import { buildStadiumMap, type OsmExtract, type StadiumOptions } from '../../world/src/osm/stadium.ts';
import type { Db } from './db.ts';

/**
 * Routes for the commander's brief: importing any stadium from OpenStreetMap,
 * the history that "low / medium / high" is measured against, what officers
 * thought of the plans, and fetching a live conditions feed.
 */

const STADIUM_DIR = resolve(process.env.STADIUM_DIR ?? './data/stadiums');
const FEED_TIMEOUT_MS = 8000;
const FEED_MAX_BYTES = 512 * 1024;

/** Byte progress is chatty: one line per 100 ms or 256 KB of growth, whichever comes first. */
const IMPORT_PROGRESS_MS = 100;
const IMPORT_PROGRESS_BYTES = 256 * 1024;

/** Where the commander searched for the stadium, shown on the start screen. */
interface ImportedLocation {
  city?: string;
  state?: string;
  country?: string;
  where?: string;
}

interface Imported {
  options: StadiumOptions;
  extract: OsmExtract;
  location?: ImportedLocation;
}

/** The searched location, else the stadium's own name, else its id. */
const whereOf = (saved: Imported) => saved.location?.where ?? saved.options.name ?? saved.options.id!;

const idFor = (osmType: string, osmId: number) => `osm-${osmType}-${osmId}`;

export function importedIds(): { id: string; name: string; where: string; theme: ReturnType<typeof themeFor> }[] {
  try {
    return readdirSync(STADIUM_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const saved = JSON.parse(readFileSync(resolve(STADIUM_DIR, f), 'utf8')) as Imported;
        const name = saved.options.name ?? saved.options.id!;
        return { id: saved.options.id!, name, where: whereOf(saved), theme: saved.options.theme ?? themeFor(name) };
      });
  } catch {
    return [];
  }
}

/** Build an imported stadium's map from its saved extract, or undefined if there is none. */
export function importedMap(id: string): MapBundle | undefined {
  if (!/^osm-(way|relation)-\d+$/.test(id)) return undefined;
  try {
    const saved = JSON.parse(readFileSync(resolve(STADIUM_DIR, `${id}.json`), 'utf8')) as Imported;
    return buildStadiumMap(saved.extract, saved.options);
  } catch {
    return undefined;
  }
}

/** The import request: a search hit, plus the city/state/country it was found in. */
interface ImportRequest {
  name: string;
  osmType: 'way' | 'relation';
  osmId: number;
  lat: number;
  lon: number;
  capacity?: number;
  wikidata?: string;
  city?: string;
  state?: string;
  country?: string;
  where?: string;
}

/** One line of the streaming import: a stage, a byte count, the saved stadium or a failure. */
type ImportEvent =
  | { stage: 'facts' | 'download' | 'build' | 'save'; label: string; step: number; steps: number }
  | { stage: 'download'; bytes: number }
  | { done: true; id: string; name: string; gates: number; theme: MapBundle['theme'] }
  | { error: string };

const IMPORT_STEPS = 4;
const importError = (error: unknown) => `Import failed: ${error instanceof Error ? error.message : String(error)}`;

/** Download, build and save one stadium, narrating each stage through `report`. */
async function importStadium(hit: ImportRequest, report: (event: ImportEvent) => void, forget: (id: string) => void) {
  const id = idFor(hit.osmType, Number(hit.osmId));
  const center = { lat: Number(hit.lat), lon: Number(hit.lon) };

  // Start the facts lookup and the download together: Wikidata is best effort, so
  // a slow or missing item must not hold up the map. Both are underway by the time
  // the first line is sent, so it names both.
  report({
    stage: 'facts',
    label: 'Reading team and capacity from Wikidata and downloading the map from OpenStreetMap',
    step: 1,
    steps: IMPORT_STEPS,
  });
  const factsPromise = hit.wikidata ? stadiumFacts(hit.wikidata) : Promise.resolve({ teams: [] as string[], capacity: undefined });
  report({ stage: 'download', label: 'Downloading the map from OpenStreetMap', step: 2, steps: IMPORT_STEPS });

  // Overpass answers in many small chunks, so throttle the byte lines and always
  // close with the total. A download that sent no chunks still reports 0.
  let totalBytes = 0;
  let sentBytes = -1;
  let sentAt = 0;
  const extract = await fetchExtract(center, undefined, undefined, (bytes) => {
    totalBytes = bytes;
    const now = Date.now();
    if (bytes - sentBytes < IMPORT_PROGRESS_BYTES && now - sentAt < IMPORT_PROGRESS_MS) return;
    sentBytes = bytes;
    sentAt = now;
    report({ stage: 'download', bytes });
  });
  if (totalBytes !== sentBytes) report({ stage: 'download', bytes: totalBytes });
  const facts = await factsPromise;

  const options: StadiumOptions = {
    id,
    name: hit.name,
    stadiumOsmId: Number(hit.osmId),
    capacity: hit.capacity ?? facts.capacity,
    theme: themeFor(hit.name, facts.teams),
  };
  const city = hit.city?.trim() || undefined;
  const state = hit.state?.trim() || undefined;
  const country = hit.country?.trim() || undefined;
  const where = hit.where?.trim() || [city, state, country].filter(Boolean).join(', ') || undefined;
  const location: ImportedLocation | undefined = city || state || country || where ? { city, state, country, where } : undefined;

  // Build once before saving, so a stadium that cannot be mapped is refused now.
  report({ stage: 'build', label: 'Building the walkable map', step: 3, steps: IMPORT_STEPS });
  const map = buildStadiumMap(extract, options);
  report({ stage: 'save', label: 'Saving the stadium', step: 4, steps: IMPORT_STEPS });
  mkdirSync(STADIUM_DIR, { recursive: true });
  writeFileSync(resolve(STADIUM_DIR, `${id}.json`), JSON.stringify({ options, extract, location } satisfies Imported));
  forget(id);
  return { id, name: map.name, gates: map.places.filter((p) => p.kind === 'gate').length, theme: map.theme };
}

export function migrateCommandTables(db: Db): void {
  db.exec(`
    create table if not exists history (
      map_id text not null,
      kind text not null,
      subject text not null,
      minute integer not null,
      value real not null,
      run_id text not null,
      created_at integer not null
    );
    create index if not exists history_lookup on history (map_id, kind, subject, minute);
    create table if not exists feedback (
      id text primary key,
      map_id text not null,
      json text not null,
      created_at integer not null
    );
  `);
}

export function addCommandRoutes(app: Hono, db: Db, builtIn: { id: string; name: string; theme?: unknown }[], forget: (id: string) => void): void {
  migrateCommandTables(db);

  app.get('/api/maps', (c) => c.json([...builtIn, ...importedIds().map((m) => ({ ...m, imported: true }))]));

  app.get('/api/stadiums/search', async (c) => {
    const q = (c.req.query('q') ?? '').trim();
    if (q.length < 3) return c.json({ error: 'type at least three letters' }, 400);
    try {
      return c.json(await searchStadiums(q));
    } catch (error) {
      return c.json({ error: `Stadium search failed: ${error instanceof Error ? error.message : String(error)}` }, 502);
    }
  });

  app.post('/api/stadiums/import', async (c) => {
    const hit = await c.req.json<ImportRequest>();
    if (hit.osmType !== 'way' && hit.osmType !== 'relation') return c.json({ error: 'need a stadium way or relation' }, 400);

    // Old callers ask for JSON and get the single response they always have.
    if ((c.req.header('accept') ?? '').toLowerCase().includes('application/json')) {
      try {
        return c.json(await importStadium(hit, () => {}, forget));
      } catch (error) {
        return c.json({ error: importError(error) }, 502);
      }
    }

    // Everyone else gets one JSON object per line, flushed as each stage happens,
    // so the start screen can show progress through the slow Overpass download.
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: ImportEvent) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        try {
          send({ done: true, ...(await importStadium(hit, send, forget)) });
        } catch (error) {
          send({ error: importError(error) });
        } finally {
          controller.close();
        }
      },
    });
    return c.body(body, 200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    });
  });

  // History: every finished run adds its gate queues and stopped traffic by minute to kickoff.
  app.post('/api/history', async (c) => {
    const body = await c.req.json<{ mapId: string; runId: string; samples: { kind: string; subject: string; minute: number; value: number }[] }>();
    const insert = db.prepare('insert into history (map_id, kind, subject, minute, value, run_id, created_at) values (?, ?, ?, ?, ?, ?, ?)');
    const now = Date.now();
    const valid = (body.samples ?? []).filter(
      (s) => (s.kind === 'gate_waiting' || s.kind === 'street_stopped') && typeof s.subject === 'string' && Number.isFinite(s.minute) && Number.isFinite(s.value),
    );
    // `node:sqlite` has no `.transaction()` helper: one BEGIN/COMMIT around the batch.
    db.exec('BEGIN');
    try {
      for (const s of valid) insert.run(body.mapId, s.kind, s.subject, Math.round(s.minute), s.value, body.runId, now);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return c.json({ saved: valid.length });
  });

  app.get('/api/history', (c) => {
    const mapId = c.req.query('map') ?? '';
    const rows = db
      .prepare(
        `select kind, subject, minute, avg(value) as mean, count(*) as n, count(distinct run_id) as runs
         from history where map_id = ? group by kind, subject, minute`,
      )
      .all(mapId) as unknown as { kind: string; subject: string; minute: number; mean: number; n: number }[];
    const runs = Number((db.prepare('select count(distinct run_id) as runs from history where map_id = ?').get(mapId) as { runs: number } | undefined)?.runs ?? 0);
    return c.json({ runs, samples: rows.map(({ kind, subject, minute, mean, n }) => ({ kind, subject, minute, mean, n })) });
  });

  // What the officer thought: the plan they would pick, whether they agree with the ranking, a note.
  app.post('/api/feedback', async (c) => {
    const body = await c.req.json<Record<string, unknown> & { mapId: string }>();
    const id = crypto.randomUUID();
    db.prepare('insert into feedback (id, map_id, json, created_at) values (?, ?, ?, ?)').run(id, String(body.mapId ?? ''), JSON.stringify(body), Date.now());
    return c.json({ id });
  });

  app.get('/api/feedback', (c) => {
    const rows = db
      .prepare('select json, created_at from feedback where map_id = ? order by created_at desc, rowid desc limit 20')
      .all(c.req.query('map') ?? '') as unknown as { json: string; created_at: number }[];
    return c.json(rows.map((r) => ({ ...JSON.parse(r.json), at: r.created_at })));
  });

  // A live conditions feed, fetched here so the browser is not stopped by CORS. Text only, size-capped.
  app.post('/api/conditions/fetch', async (c) => {
    const { url } = await c.req.json<{ url: string }>();
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return c.json({ error: 'not a URL' }, 400);
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return c.json({ error: 'only http and https feeds' }, 400);
    try {
      const res = await fetch(parsed, { signal: AbortSignal.timeout(FEED_TIMEOUT_MS), headers: { accept: 'application/json, text/csv, text/plain' } });
      if (!res.ok) return c.json({ error: `feed returned ${res.status}` }, 502);
      const text = await res.text();
      if (text.length > FEED_MAX_BYTES) return c.json({ error: 'feed is larger than 512 KB' }, 413);
      return c.json({ text, fetchedAt: new Date().toISOString() });
    } catch (error) {
      return c.json({ error: `feed fetch failed: ${error instanceof Error ? error.message : String(error)}` }, 502);
    }
  });
}
