import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BriefingRequest, Scorecard } from '../../contracts.ts';
import { makeTestMap } from '../../world/src/test-map.ts';
import { playbookFor } from '../../world/src/playbook.ts';
import { testGateSurge } from '../../world/src/incidents.ts';
import { askFm, buildBriefingPrompt, PROMPT_CHAR_BUDGET, PROMPT_TOKEN_BUDGET } from './fm.ts';
import { briefingIsSupported, templateBriefing } from './briefing.ts';

const map = makeTestMap();
const plans = playbookFor('gate_surge', map);

const card = (label: 'A' | 'B' | 'C', planId: string, over: Partial<Scorecard> = {}): Scorecard => ({
  runId: `run-${label}`,
  planId,
  label,
  timeToClearMin: 4,
  peakDensity: 5,
  dangerMinutes: 254170,
  firstOfficerMin: 0,
  officerMinutesUsed: 540,
  fansNotReached: 100000,
  fallbackDecisions: 19,
  ...over,
});

const request: BriefingRequest = {
  incident: testGateSurge(map, 0),
  plans,
  scorecards: [
    card('A', plans[0]!.id),
    card('B', plans[1]!.id, { timeToClearMin: 5, officerMinutesUsed: 180, fansNotReached: 97300 }),
    card('C', plans[2]!.id, { timeToClearMin: null, officerMinutesUsed: 360, fansNotReached: 50025 }),
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('briefing prompt', () => {
  const prompt = buildBriefingPrompt(request);

  it('stays far under the context limit', () => {
    // Measured at 399 tokens with `fm count-tokens`, against a 4,000 budget.
    expect(prompt.length).toBeLessThan(PROMPT_CHAR_BUDGET);
    expect(prompt.length).toBeLessThan(PROMPT_TOKEN_BUDGET); // even at 1 char per token
  });

  it('gives the model every plan and its numbers', () => {
    for (const label of ['A', 'B', 'C']) expect(prompt).toContain(`Plan ${label}`);
    for (const plan of plans) expect(prompt).toContain(plan.name);
    expect(prompt).toContain('254170');
    expect(prompt).toContain('never cleared in this window');
  });

  it('forbids inventing numbers and recommending a plan', () => {
    expect(prompt).toMatch(/ONLY numbers that appear above/);
    expect(prompt).toMatch(/Do not recommend a plan/);
    expect(prompt).toMatch(/assumption, not a forecast/);
  });
});

describe('askFm', () => {
  it('asks for a non-streaming completion', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json({ choices: [{ message: { content: 'Plan A clears in 4 minutes.' } }], model: 'system' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await askFm(request, { url: 'http://fm.test', model: 'system', timeoutMs: 1000 });
    expect(result?.text).toBe('Plan A clears in 4 minutes.');
    expect(result?.model).toBe('system');

    const [calledUrl, calledInit] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(String(calledInit!.body));
    // stream:false matters: the whole briefing is checked before anyone sees it
    expect(body.stream).toBe(false);
    expect(body.model).toBe('system');
    expect(String(calledUrl)).toContain('/v1/chat/completions');
  });

  it('returns null when fm serve is not running', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));
    expect(await askFm(request, { url: 'http://fm.test', model: 'system', timeoutMs: 1000 })).toBeNull();
  });

  it('returns null on an empty or malformed reply', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ choices: [] })));
    expect(await askFm(request, { url: 'http://fm.test', model: 'system', timeoutMs: 1000 })).toBeNull();
  });

  it('returns null when fm serve answers with an error status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    expect(await askFm(request, { url: 'http://fm.test', model: 'system', timeoutMs: 1000 })).toBeNull();
  });
});

describe('the number guard decides which briefing ships', () => {
  it('accepts a model briefing that only repeats scorecard numbers', () => {
    const text =
      'Plan A clears in 4 minutes using 540 officer minutes. Plan B takes 5 minutes but spends 180. ' +
      'Fan behavior is an assumption, not a forecast.';
    expect(briefingIsSupported(text, request)).toBe(true);
  });

  it('rejects a model briefing that invents a number', () => {
    const text = 'Plan A clears in 4 minutes and cuts peak density by 37 percent.';
    expect(briefingIsSupported(text, request)).toBe(false);
  });

  it('falls back to a template that always passes its own guard', () => {
    const briefing = templateBriefing(request);
    expect(briefing.canned).toBe(true);
    expect(briefing.model).toBe('template');
    expect(briefingIsSupported(briefing.text, request)).toBe(true);
  });
});
