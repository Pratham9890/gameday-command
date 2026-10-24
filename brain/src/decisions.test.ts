import { describe, expect, it, vi } from 'vitest';
import type { DecisionAsk, DecisionContext } from '../../contracts.ts';
import { decisionKey } from '../../contracts.ts';
import { DECISION_DEFAULTS } from './defaults.ts';
import { SITUATIONS } from './situations.ts';
import { oddsAreValid, sampleOdds } from './sample.ts';
import { DecisionClient } from './client.ts';
import { FAN_TYPES } from './fan-types.ts';

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

describe('decision defaults', () => {
  it('covers every situation with odds that add up to 1', () => {
    for (const situation of DECISION_DEFAULTS.situations) {
      const odds = DECISION_DEFAULTS.defaults[situation.id];
      expect(odds).toBeDefined();
      expect(oddsAreValid(odds, situation.options.map((o) => o.key))).toBe(true);
    }
  });

  it('gives every fan type a share, summing to 1', () => {
    const total = FAN_TYPES.reduce((sum, t) => sum + t.share, 0);
    expect(total).toBeCloseTo(1, 6);
  });
});

describe('odds validation', () => {
  const keys = SITUATIONS.gate_jammed.options.map((o) => o.key);

  it('rejects odds that do not add up', () => {
    expect(oddsAreValid({ hold_place: 0.5, try_other_gate: 0.2, back_off: 0.1 }, keys)).toBe(false);
  });

  it('rejects option keys it has never heard of', () => {
    expect(oddsAreValid({ hold_place: 0.5, sprint_the_fence: 0.5 }, keys)).toBe(false);
  });

  it('accepts odds within the contract tolerance', () => {
    expect(oddsAreValid({ hold_place: 0.5, try_other_gate: 0.3, back_off: 0.2005 }, keys)).toBe(true);
  });
});

describe('sampleOdds', () => {
  it('does not care what order the keys arrived in', () => {
    const a = { hold_place: 0.2, try_other_gate: 0.3, back_off: 0.5 };
    const b = { back_off: 0.5, hold_place: 0.2, try_other_gate: 0.3 };
    for (const r of [0, 0.1, 0.19, 0.5, 0.7, 0.99]) {
      expect(sampleOdds(a, r)).toBe(sampleOdds(b, r));
    }
  });

  it('lands in each bucket in sorted key order', () => {
    const odds = { back_off: 0.25, hold_place: 0.25, try_other_gate: 0.5 };
    expect(sampleOdds(odds, 0.1)).toBe('back_off');
    expect(sampleOdds(odds, 0.3)).toBe('hold_place');
    expect(sampleOdds(odds, 0.9)).toBe('try_other_gate');
  });
});

describe('DecisionClient with Kev off', () => {
  it('falls back to defaults and marks the source instead of throwing', async () => {
    const client = new DecisionClient('run-A', {
      serverUrl: '',
      defaults: DECISION_DEFAULTS,
      fetchImpl: vi.fn().mockRejectedValue(new Error('connection refused')) as unknown as typeof fetch,
    });

    const [answer] = await client.answer(0, [ask]);
    expect(answer!.source).toBe('default');
    expect(answer!.odds).toEqual(DECISION_DEFAULTS.defaults.gate_jammed);
    expect(client.getTape().answers).toHaveLength(1);
  });

  it('falls back when the answer is past the timeout', async () => {
    const slowFetch = vi.fn(
      () => new Promise<Response>((resolve) => setTimeout(() => resolve(new Response('{}')), 500)),
    ) as unknown as typeof fetch;
    const client = new DecisionClient('run-A', {
      serverUrl: '',
      defaults: DECISION_DEFAULTS,
      timeoutMs: 20,
      fetchImpl: slowFetch,
    });

    const [answer] = await client.answer(0, [ask]);
    expect(answer!.source).toBe('default');
  });

  it('rejects odds that do not add up and counts them as fallbacks', async () => {
    const badFetch = vi.fn(async () =>
      Response.json({ answers: [{ key: ask.key, odds: { hold_place: 0.9, try_other_gate: 0.9, back_off: 0.9 }, source: 'kev' }] }),
    ) as unknown as typeof fetch;
    const client = new DecisionClient('run-A', { serverUrl: '', defaults: DECISION_DEFAULTS, fetchImpl: badFetch });

    const [answer] = await client.answer(0, [ask]);
    expect(answer!.source).toBe('default');
  });

  it('serves a repeat key from cache without calling out twice', async () => {
    const goodFetch = vi.fn(async () =>
      Response.json({ answers: [{ key: ask.key, odds: { hold_place: 0.5, try_other_gate: 0.3, back_off: 0.2 }, source: 'kev', model: 'kev-4b' }] }),
    ) as unknown as typeof fetch;
    const client = new DecisionClient('run-A', { serverUrl: '', defaults: DECISION_DEFAULTS, fetchImpl: goodFetch });

    const [first] = await client.answer(0, [ask]);
    const [second] = await client.answer(5, [ask]);
    expect(first!.source).toBe('kev');
    expect(second!.source).toBe('cache');
    expect(goodFetch).toHaveBeenCalledTimes(1);
    expect(client.getTape().answers).toHaveLength(2);
  });
});
