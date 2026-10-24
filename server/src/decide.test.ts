import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DecisionAnswer, DecisionAsk, DecisionContext } from '../../contracts.ts';
import { DECISION_TIMEOUT_MS, decisionKey } from '../../contracts.ts';
import { createApp } from './index.ts';
import { openDb, type Db } from './db.ts';

/** The stub answers this late; the server must give up long before it. */
const SLOW_ANSWER_MS = DECISION_TIMEOUT_MS * 3;

const context: DecisionContext = {
  crowdAtTarget: 'high',
  waitMinBucket: 10,
  minToKickoffBucket: 0,
  weather: 'clear',
  officerOrder: false,
  alertHeard: false,
};

const ask: DecisionAsk = {
  key: decisionKey('student-section', 'gate_jammed', context),
  fanTypeId: 'student-section',
  situation: 'gate_jammed',
  context,
  dotIds: [1, 2, 3],
};

/** A reply shaped like the one `kev.serve` returns from POST /v1/systemone. */
function kevReply(probabilities: Record<string, number>) {
  const best = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
  return Response.json({
    model: 'kev-4b',
    answers: { decision: { type: 'choice', choice: best, confidence: 0.4, probabilities } },
    usage: { input_tokens: 128, output_tokens: 24 },
    latency_ms: 12.3,
  });
}

/** Anything that is not a usable choice answer. */
function kevJunk(body: unknown) {
  return Response.json(body);
}

let db: Db;
let app: ReturnType<typeof createApp>;

async function decide(asks: DecisionAsk[] = [ask]): Promise<DecisionAnswer[]> {
  const res = await app.request('/api/decide', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runId: 'run-A', asks }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { answers: DecisionAnswer[] };
  return body.answers;
}

beforeEach(() => {
  db = openDb(':memory:');
  app = createApp(db);
});

afterEach(() => {
  vi.unstubAllGlobals();
  db.close();
});

describe('POST /decide', () => {
  it('asks Kev, returns its odds, and says so', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      kevReply({ hold_place: 0.5, try_other_gate: 0.3, back_off: 0.2 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const [answer] = await decide();
    expect(answer!.source).toBe('kev');
    expect(answer!.odds).toEqual({ hold_place: 0.5, try_other_gate: 0.3, back_off: 0.2 });
    expect(answer!.key).toBe(ask.key);
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/v1/systemone');
  });

  it('serves the same key from the cache next time, without asking again', async () => {
    const fetchMock = vi.fn(async () => kevReply({ hold_place: 0.5, try_other_gate: 0.3, back_off: 0.2 }));
    vi.stubGlobal('fetch', fetchMock);

    await decide();
    const [second] = await decide();
    expect(second!.source).toBe('cache');
    expect(second!.odds).toEqual({ hold_place: 0.5, try_other_gate: 0.3, back_off: 0.2 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('answers one call per distinct key, however many dots are waiting', async () => {
    const fetchMock = vi.fn(async () => kevReply({ hold_place: 0.5, try_other_gate: 0.3, back_off: 0.2 }));
    vi.stubGlobal('fetch', fetchMock);

    // Same key twice plus a different one: two calls, not three, and not one per dot.
    const other: DecisionAsk = {
      ...ask,
      key: decisionKey('alumni-family', 'gate_jammed', context),
      fanTypeId: 'alumni-family',
      dotIds: Array.from({ length: 5000 }, (_, i) => i),
    };
    const answers = await decide([ask, other]);
    expect(answers).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('falls back to defaults when Kev is off', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));
    const [answer] = await decide();
    expect(answer!.source).toBe('default');
    // even odds across the three options
    expect(Object.values(answer!.odds).every((v) => Math.abs(v - 1 / 3) < 1e-9)).toBe(true);
  });

  it('falls back when the odds do not add up to 1', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => kevReply({ hold_place: 0.9, try_other_gate: 0.9, back_off: 0.9 })));
    const [answer] = await decide();
    expect(answer!.source).toBe('default');
  });

  it('falls back when Kev names an option that does not exist', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => kevReply({ sprint_the_fence: 1.0 })));
    const [answer] = await decide();
    expect(answer!.source).toBe('default');
  });

  it('falls back when Kev answers a different question type', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => kevJunk({ answers: { decision: { type: 'noul', noul: 0.7 } } })));
    const [answer] = await decide();
    expect(answer!.source).toBe('default');
  });

  it('falls back when the answer carries no probabilities at all', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => kevJunk({ answers: {} })));
    const [answer] = await decide();
    expect(answer!.source).toBe('default');
  });

  it('falls back when Kev takes longer than the contract allows', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          // Far slower than the contract allows, so "it gave up" and "it waited
          // for the answer" are a long way apart. They used to be 100 ms apart,
          // which a loaded machine's timer jitter could close, making this test
          // fail for reasons that had nothing to do with the code.
          const timer = setTimeout(
            () => resolve(kevReply({ hold_place: 0.5, try_other_gate: 0.3, back_off: 0.2 })),
            SLOW_ANSWER_MS,
          );
          init?.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          });
        }),
      ),
    );
    const started = Date.now();
    const [answer] = await decide();
    expect(answer!.source).toBe('default');
    // It gave up near the contract's timeout rather than waiting for the
    // answer, with room for scheduling jitter in between.
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(SLOW_ANSWER_MS - 1000);
    expect(elapsed).toBeGreaterThanOrEqual(DECISION_TIMEOUT_MS * 0.5);
  }, 20_000);

  it('never caches a bad answer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => kevReply({ hold_place: 2 })));
    await decide();
    const row = db.prepare<[string], { odds: string }>('select odds from decision_cache where key = ?').get(ask.key);
    expect(row).toBeUndefined();
  });
});

describe('the rest of the API', () => {
  it('serves decision defaults for every situation', async () => {
    const res = await app.request('/api/decision-defaults');
    const body = (await res.json()) as { situations: unknown[]; defaults: Record<string, unknown> };
    expect(body.situations.length).toBeGreaterThanOrEqual(10);
    expect(Object.keys(body.defaults).length).toBeGreaterThanOrEqual(10);
  });

  it('serves three plans per incident kind', async () => {
    for (const kind of ['gate_surge', 'lightning_delay', 'suspicious_package']) {
      const res = await app.request(`/api/plans?incident=${kind}`);
      const plans = (await res.json()) as unknown[];
      expect(plans.length, kind).toBeGreaterThanOrEqual(3);
    }
  });

  it('saves a comparison and reads it back', async () => {
    const incident = { id: 'i', kind: 'gate_surge' as const, at: 0 };
    const scorecards = [
      {
        runId: 'run-A',
        planId: 'p',
        label: 'A' as const,
        timeToClearMin: 4,
        peakDensity: 5,
        dangerMinutes: 10,
        firstOfficerMin: 1,
        officerMinutesUsed: 60,
        fansNotReached: 100,
        fallbackDecisions: 0,
      },
    ];
    const created = await app.request('/api/comparisons', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ incident, scorecards }),
    });
    const { id } = (await created.json()) as { id: string };
    const read = await app.request(`/api/comparisons/${id}`);
    expect(((await read.json()) as { scorecards: unknown[] }).scorecards).toEqual(scorecards);
  });

  it('404s an unknown map', async () => {
    expect((await app.request('/api/maps/not-a-map')).status).toBe(404);
  });
});
