import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Hono } from 'hono';
import type { MapBundle } from '../../contracts.ts';
import { fetchExtract, searchStadiums } from '../../world/src/osm/fetch.ts';
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

interface Imported {
  options: StadiumOptions;
  extract: OsmExtract;
}

const idFor = (osmType: string, osmId: number) => `osm-${osmType}-${osmId}`;

export function importedIds(): { id: string; name: string }[] {
  try {
    return readdirSync(STADIUM_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const saved = JSON.parse(readFileSync(resolve(STADIUM_DIR, f), 'utf8')) as Imported;
        return { id: saved.options.id!, name: saved.options.name ?? saved.options.id! };
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

export function addCommandRoutes(app: Hono, db: Db, builtIn: { id: string; name: string }[], forget: (id: string) => void): void {
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
    const hit = await c.req.json<{ name: string; osmType: 'way' | 'relation'; osmId: number; lat: number; lon: number; capacity?: number }>();
    if (hit.osmType !== 'way' && hit.osmType !== 'relation') return c.json({ error: 'need a stadium way or relation' }, 400);
    const id = idFor(hit.osmType, Number(hit.osmId));
    try {
      const extract = await fetchExtract({ lat: Number(hit.lat), lon: Number(hit.lon) });
      const options: StadiumOptions = { id, name: hit.name, stadiumOsmId: Number(hit.osmId), capacity: hit.capacity };
      // Build once before saving, so a stadium that cannot be mapped is refused now.
      const map = buildStadiumMap(extract, options);
      mkdirSync(STADIUM_DIR, { recursive: true });
      writeFileSync(resolve(STADIUM_DIR, `${id}.json`), JSON.stringify({ options, extract } satisfies Imported));
      forget(id);
      return c.json({ id, name: map.name, gates: map.places.filter((p) => p.kind === 'gate').length });
    } catch (error) {
      return c.json({ error: `Import failed: ${error instanceof Error ? error.message : String(error)}` }, 502);
    }
  });

  // History: every finished run adds its gate queues and stopped traffic by minute to kickoff.
  app.post('/api/history', async (c) => {
    const body = await c.req.json<{ mapId: string; runId: string; samples: { kind: string; subject: string; minute: number; value: number }[] }>();
    const insert = db.prepare('insert into history (map_id, kind, subject, minute, value, run_id, created_at) values (?, ?, ?, ?, ?, ?, ?)');
    const now = Date.now();
    const valid = (body.samples ?? []).filter(
      (s) => (s.kind === 'gate_waiting' || s.kind === 'street_stopped') && typeof s.subject === 'string' && Number.isFinite(s.minute) && Number.isFinite(s.value),
    );
    db.transaction(() => {
      for (const s of valid) insert.run(body.mapId, s.kind, s.subject, Math.round(s.minute), s.value, body.runId, now);
    })();
    return c.json({ saved: valid.length });
  });

  app.get('/api/history', (c) => {
    const mapId = c.req.query('map') ?? '';
    const rows = db
      .prepare<[string], { kind: string; subject: string; minute: number; mean: number; n: number; runs: number }>(
        `select kind, subject, minute, avg(value) as mean, count(*) as n, count(distinct run_id) as runs
         from history where map_id = ? group by kind, subject, minute`,
      )
      .all(mapId);
    const runs = (db.prepare<[string], { runs: number }>('select count(distinct run_id) as runs from history where map_id = ?').get(mapId)?.runs) ?? 0;
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
      .prepare<[string], { json: string; created_at: number }>('select json, created_at from feedback where map_id = ? order by created_at desc, rowid desc limit 20')
      .all(c.req.query('map') ?? '');
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
