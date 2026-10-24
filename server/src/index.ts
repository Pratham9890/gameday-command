import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import type { DecisionAnswer, DecisionAsk, Incident, MapBundle, ResponsePlan, Scorecard } from '../../contracts.ts';
import { DECISION_TIMEOUT_MS } from '../../contracts.ts';
import { DECISION_DEFAULTS } from '../../brain/src/defaults.ts';
import { SITUATIONS } from '../../brain/src/situations.ts';
import { oddsAreValid } from '../../brain/src/sample.ts';
import { makeTestMap } from '../../world/src/test-map.ts';
import { playbookFor } from '../../world/src/playbook.ts';
import { buildStadiumMap, extractExists, loadExtract, STADIUM_MAP_ID } from '../../world/src/osm/stadium.ts';
import { openDb, type Db } from './db.ts';
import { askKev } from './kev.ts';
import { templateBriefing } from './briefing.ts';

const KEV_URL = process.env.KEV_URL ?? 'http://127.0.0.1:8009';
const KEV_MODEL = process.env.KEV_MODEL ?? 'jaredpalmer/kev-4b';
const PORT = Number(process.env.PORT ?? 8787);

const TEST_MAP_ID = 'test-3gate';

/**
 * Maps are built once on first request and kept. The stadium map is only
 * available when the OSM extract has been fetched (npm run fetch-map); without
 * it the app still runs on the test map rather than failing to start.
 */
const built = new Map<string, MapBundle>();

function mapById(id: string): MapBundle | undefined {
  const cached = built.get(id);
  if (cached) return cached;
  let map: MapBundle | undefined;
  if (id === TEST_MAP_ID) map = makeTestMap();
  else if (id === STADIUM_MAP_ID && extractExists()) map = buildStadiumMap(loadExtract());
  if (map) built.set(id, map);
  return map;
}

/** The stadium map if it has been fetched, otherwise the test map. */
function defaultMap(): MapBundle {
  return mapById(STADIUM_MAP_ID) ?? mapById(TEST_MAP_ID)!;
}

export function createApp(db: Db): Hono {
  const app = new Hono();

  app.get('/api/health', (c) =>
    c.json({ ok: true, kev: KEV_URL, stadiumMap: extractExists(), defaultMapId: defaultMap().id }),
  );

  app.get('/api/maps/:id', (c) => {
    const id = c.req.param('id');
    const map = id === 'default' ? defaultMap() : mapById(id);
    return map ? c.json(map) : c.json({ error: 'no such map' }, 404);
  });

  app.get('/api/decision-defaults', (c) => c.json(DECISION_DEFAULTS));

  /** Cache first, then Kev, then defaults. Never fails: a dead Kev just means fallbacks. */
  app.post('/api/decide', async (c) => {
    const body = await c.req.json<{ runId: string; asks: DecisionAsk[] }>();
    const asks = body.asks ?? [];

    const readCache = db.prepare<[string], { odds: string; model: string | null; ms: number | null }>(
      'select odds, model, ms from decision_cache where key = ?',
    );
    const writeCache = db.prepare(
      'insert or replace into decision_cache (key, odds, model, ms, created_at) values (?, ?, ?, ?, ?)',
    );

    const answers = await Promise.all(
      asks.map(async (ask): Promise<DecisionAnswer> => {
        const options = SITUATIONS[ask.situation]?.options.map((o) => o.key) ?? [];
        const fallback: DecisionAnswer = {
          key: ask.key,
          odds: DECISION_DEFAULTS.defaults[ask.situation],
          source: 'default',
        };

        const cached = readCache.get(ask.key);
        if (cached) {
          const odds = JSON.parse(cached.odds) as Record<string, number>;
          if (oddsAreValid(odds, options)) {
            return { key: ask.key, odds, source: 'cache', model: cached.model ?? undefined, ms: cached.ms ?? undefined };
          }
        }

        const situation = SITUATIONS[ask.situation];
        if (!situation) return fallback;
        const result = await askKev(ask, situation, { url: KEV_URL, model: KEV_MODEL, timeoutMs: DECISION_TIMEOUT_MS });
        if (!result || !oddsAreValid(result.odds, options)) return fallback;

        writeCache.run(ask.key, JSON.stringify(result.odds), result.model, result.ms, Date.now());
        return { key: ask.key, odds: result.odds, source: 'kev', model: result.model, ms: result.ms };
      }),
    );

    return c.json({ answers });
  });

  app.get('/api/plans', (c) => {
    const kind = c.req.query('incident');
    const saved = db
      .prepare<[string], { json: string }>('select json from plans where incident = ?')
      .all(kind ?? '')
      .map((row) => JSON.parse(row.json) as ResponsePlan);
    const builtIn = kind ? playbookFor(kind as ResponsePlan['forIncident'], defaultMap()) : [];
    return c.json([...builtIn, ...saved]);
  });

  app.post('/api/plans', async (c) => {
    const plan = await c.req.json<ResponsePlan>();
    const id = plan.id || crypto.randomUUID();
    db.prepare('insert or replace into plans (id, incident, json) values (?, ?, ?)').run(
      id,
      plan.forIncident,
      JSON.stringify({ ...plan, id }),
    );
    return c.json({ id });
  });

  app.post('/api/comparisons', async (c) => {
    const body = await c.req.json<{ incident: Incident; scorecards: Scorecard[] }>();
    const id = crypto.randomUUID();
    db.prepare('insert into comparisons (id, json, created_at) values (?, ?, ?)').run(
      id,
      JSON.stringify(body),
      Date.now(),
    );
    return c.json({ id });
  });

  app.get('/api/comparisons/:id', (c) => {
    const row = db
      .prepare<[string], { json: string }>('select json from comparisons where id = ?')
      .get(c.req.param('id'));
    return row ? c.json(JSON.parse(row.json)) : c.json({ error: 'no such comparison' }, 404);
  });

  /** Milestone 1 always uses the template; the on-device model lands with the briefing milestone. */
  app.post('/api/briefing', async (c) => c.json(templateBriefing(await c.req.json())));

  return app;
}

if (process.argv[1]?.includes('server/src/index.ts')) {
  const app = createApp(openDb());
  serve({ fetch: app.fetch, port: PORT });
  console.log(`gameday server on http://127.0.0.1:${PORT} (kev ${KEV_URL})`);
}
