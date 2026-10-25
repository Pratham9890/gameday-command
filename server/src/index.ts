import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import type { BriefingRequest, DecisionAnswer, DecisionAsk, Incident, MapBundle, ResponsePlan, Scorecard } from '../../contracts.ts';
import { DECISION_TIMEOUT_MS } from '../../contracts.ts';
import { DECISION_DEFAULTS } from '../../brain/src/defaults.ts';
import { SITUATIONS } from '../../brain/src/situations.ts';
import { oddsAreValid } from '../../brain/src/sample.ts';
import { makeTestMap } from '../../world/src/test-map.ts';
import { playbookFor } from '../../world/src/playbook.ts';
import { buildStadiumMap, extractExists, loadExtract, STADIUM_MAP_ID } from '../../world/src/osm/stadium.ts';
import { openDb, type Db } from './db.ts';
import { addCommandRoutes, importedMap } from './command.ts';
import { OHIO_THEME } from '../../world/src/teams.ts';
import { askKev } from './kev.ts';
import { briefingIsSupported, templateBriefing } from './briefing.ts';
import { askFm, briefingFrom } from './fm.ts';

const KEV_URL = process.env.KEV_URL ?? 'http://127.0.0.1:8009';
/** What Kev's /v1/systemone accepts as a model name; GET /v1/models lists them. */
const KEV_MODEL = process.env.KEV_MODEL ?? 'kev-latest';
/**
 * Deliberately tighter than the engine's DECISION_TIMEOUT_MS.
 *
 * The engine aborts the whole POST after 2 s and falls back for every key in
 * the batch. If the server waited the same 2 s per key it would lose that race
 * and throw away the answers it did manage to get, so it gives up early enough
 * to always reply in time with Kev's answers for the keys that came back and
 * defaults for the rest.
 */
const KEV_TIMEOUT_MS = Number(process.env.KEV_TIMEOUT_MS ?? Math.round(DECISION_TIMEOUT_MS * 0.75));
/** How many questions to have in flight at once. One GPU answers roughly serially. */
const KEV_CONCURRENCY = Number(process.env.KEV_CONCURRENCY ?? 4);
/** Background warming has no commander waiting on it, so it can be patient. */
const KEV_WARM_TIMEOUT_MS = Number(process.env.KEV_WARM_TIMEOUT_MS ?? 30000);
const WARM_TIMEOUT_MS = KEV_WARM_TIMEOUT_MS;
const PORT = Number(process.env.PORT ?? 8787);
const FM_URL = process.env.FM_URL ?? 'http://127.0.0.1:8080';
const FM_MODEL = process.env.FM_MODEL ?? 'system';
const FM_TIMEOUT_MS = Number(process.env.FM_TIMEOUT_MS ?? 20000);

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
  else map = importedMap(id);
  if (map) built.set(id, map);
  return map;
}

/** The stadium map if it has been fetched, otherwise the test map. */
function defaultMap(): MapBundle {
  return mapById(STADIUM_MAP_ID) ?? mapById(TEST_MAP_ID)!;
}

/**
 * Keys that ran out of time, fetched afterwards without a deadline.
 *
 * Kev answers in about 250 ms, so a lightning delay that raises well over a
 * hundred keys at once can only have a handful answered inside the engine's 2 s
 * pause — the rest fall back, as the contract says they must. Without this they
 * would fall back on every future run too, and the demo would never become
 * model-driven. Here the server keeps fetching them quietly in the background,
 * so a scenario run a second time is answered from cache rather than guessed.
 *
 * Deliberately shallow: two at a time (Kev serialises on one GPU), each key
 * once, and a bounded queue, so warming never competes with the run in front of
 * the commander.
 */
const WARM_CONCURRENCY = 2;
const WARM_QUEUE_MAX = 500;

function makeWarmer(db: Db) {
  const queued = new Set<string>();
  const pending: { ask: DecisionAsk; situation: (typeof SITUATIONS)[keyof typeof SITUATIONS] }[] = [];
  let running = 0;

  const write = db.prepare(
    'insert or replace into decision_cache (key, odds, model, ms, created_at) values (?, ?, ?, ?, ?)',
  );
  const seen = db.prepare<[string], { key: string }>('select key from decision_cache where key = ?');

  const pump = () => {
    while (running < WARM_CONCURRENCY && pending.length > 0) {
      const job = pending.shift()!;
      running++;
      void askKev(job.ask, job.situation, { url: KEV_URL, model: KEV_MODEL, timeoutMs: WARM_TIMEOUT_MS })
        .then((result) => {
          const options = job.situation.options.map((o) => o.key);
          if (result && oddsAreValid(result.odds, options)) {
            write.run(job.ask.key, JSON.stringify(result.odds), result.model, result.ms, Date.now());
          }
        })
        .catch(() => {})
        .finally(() => {
          queued.delete(job.ask.key);
          running--;
          pump();
        });
    }
  };

  return (ask: DecisionAsk, situation: (typeof SITUATIONS)[keyof typeof SITUATIONS]) => {
    if (queued.has(ask.key) || pending.length >= WARM_QUEUE_MAX) return;
    if (seen.get(ask.key)) return;
    queued.add(ask.key);
    pending.push({ ask, situation });
    pump();
  };
}

export function createApp(db: Db): Hono {
  const warmLater = makeWarmer(db);

  const app = new Hono();

  app.get('/api/health', (c) =>
    c.json({
      ok: true,
      kev: KEV_URL,
      fm: FM_URL,
      stadiumMap: extractExists(),
      defaultMapId: defaultMap().id,
      cachedDecisions: (db.prepare('select count(*) as n from decision_cache').get() as { n: number }).n,
    }),
  );

  app.get('/api/maps/:id', (c) => {
    const id = c.req.param('id');
    const map = id === 'default' ? defaultMap() : mapById(id);
    return map ? c.json(map) : c.json({ error: 'no such map' }, 404);
  });

  app.get('/api/decision-defaults', (c) => c.json(DECISION_DEFAULTS));

  addCommandRoutes(
    app,
    db,
    [...(extractExists() ? [{ id: STADIUM_MAP_ID, name: 'Ohio Stadium + 0.5 mi', theme: OHIO_THEME }] : []), { id: TEST_MAP_ID, name: 'Three-gate test map' }],
    (id) => built.delete(id),
  );

  /**
   * Cache first, then Kev, then defaults. Never fails: a dead Kev just means
   * fallbacks.
   *
   * The keys with the most dots behind them are asked first, under one shared
   * deadline. A cold lightning delay raises well over a hundred keys at once
   * and the model answers them one at a time, so there is no way to get them
   * all inside the engine's 2 s pause. Spending the budget on the biggest
   * groups means the fans whose behaviour actually moves the crowd get a real
   * answer, and the long tail of small groups takes the default — rather than
   * asking for everything and timing out into defaults for all of it.
   */
  app.post('/api/decide', async (c) => {
    const body = await c.req.json<{ runId: string; asks: DecisionAsk[] }>();
    const asks = body.asks ?? [];
    const deadline = Date.now() + KEV_TIMEOUT_MS;

    const readCache = db.prepare<[string], { odds: string; model: string | null; ms: number | null }>(
      'select odds, model, ms from decision_cache where key = ?',
    );
    const writeCache = db.prepare(
      'insert or replace into decision_cache (key, odds, model, ms, created_at) values (?, ?, ?, ?, ?)',
    );

    const optionsFor = (ask: DecisionAsk) => SITUATIONS[ask.situation]?.options.map((o) => o.key) ?? [];
    const fallbackFor = (ask: DecisionAsk): DecisionAnswer => ({
      key: ask.key,
      odds: DECISION_DEFAULTS.defaults[ask.situation],
      source: 'default',
    });

    const answers = new Map<string, DecisionAnswer>();
    const misses: DecisionAsk[] = [];

    for (const ask of asks) {
      if (answers.has(ask.key)) continue;
      const cached = readCache.get(ask.key);
      if (cached) {
        const odds = JSON.parse(cached.odds) as Record<string, number>;
        if (oddsAreValid(odds, optionsFor(ask))) {
          answers.set(ask.key, {
            key: ask.key,
            odds,
            source: 'cache',
            model: cached.model ?? undefined,
            ms: cached.ms ?? undefined,
          });
          continue;
        }
      }
      misses.push(ask);
    }

    // Biggest groups first: one call can answer thousands of dots.
    misses.sort((a, b) => b.dotIds.length - a.dotIds.length);

    let next = 0;
    const worker = async () => {
      while (next < misses.length) {
        const ask = misses[next++]!;
        const remaining = deadline - Date.now();
        const situation = SITUATIONS[ask.situation];
        if (!situation || remaining < 100) {
          answers.set(ask.key, fallbackFor(ask));
          // Out of time, but not out of interest: fetch it in the background so
          // the next run of this scenario finds it in the cache.
          if (situation) warmLater(ask, situation);
          continue;
        }
        const result = await askKev(ask, situation, { url: KEV_URL, model: KEV_MODEL, timeoutMs: remaining });
        if (!result || !oddsAreValid(result.odds, optionsFor(ask))) {
          answers.set(ask.key, fallbackFor(ask));
          warmLater(ask, situation);
          continue;
        }
        writeCache.run(ask.key, JSON.stringify(result.odds), result.model, result.ms, Date.now());
        answers.set(ask.key, { key: ask.key, odds: result.odds, source: 'kev', model: result.model, ms: result.ms });
      }
    };

    await Promise.all(Array.from({ length: Math.min(KEV_CONCURRENCY, Math.max(misses.length, 1)) }, worker));

    return c.json({ answers: asks.map((ask) => answers.get(ask.key) ?? fallbackFor(ask)) });
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

  /**
   * Apple's on-device model writes the briefing, but only if every number in it
   * is already on a scorecard. One invented figure and the commander gets the
   * template instead — they cannot check arithmetic mid-incident.
   */
  app.post('/api/briefing', async (c) => {
    const req = await c.req.json<BriefingRequest>();
    const result = await askFm(req, { url: FM_URL, model: FM_MODEL, timeoutMs: FM_TIMEOUT_MS });
    if (result && briefingIsSupported(result.text, req)) return c.json(briefingFrom(result));
    return c.json(templateBriefing(req));
  });

  return app;
}

if (process.argv[1]?.includes('server/src/index.ts')) {
  const db = openDb();
  const app = createApp(db);
  const cached = (db.prepare('select count(*) as n from decision_cache').get() as { n: number }).n;
  serve({ fetch: app.fetch, port: PORT });
  console.log(`gameday server on http://127.0.0.1:${PORT} (kev ${KEV_URL}, fm ${FM_URL})`);
  console.log(`${cached} decisions cached — fan decisions come from the model, not the fallback table`);
}
