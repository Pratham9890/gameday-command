import { describe, expect, it } from 'vitest';
import type { BriefingRequest, DecisionAsk, Scorecard } from '../../contracts.ts';
import { decisionKey } from '../../contracts.ts';
import { SITUATIONS } from '../../brain/src/situations.ts';
import { oddsAreValid } from '../../brain/src/sample.ts';
import { makeTestMap } from '../../world/src/test-map.ts';
import { playbookFor } from '../../world/src/playbook.ts';
import { testGateSurge } from '../../world/src/incidents.ts';
import { askKev } from './kev.ts';
import { askFm } from './fm.ts';
import { briefingIsSupported } from './briefing.ts';

const KEV_URL = process.env.KEV_URL ?? 'http://127.0.0.1:8009';
const FM_URL = process.env.FM_URL ?? 'http://127.0.0.1:8080';

/** Only run against a service that is actually listening. */
async function up(url: string, path: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}${path}`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

const kevUp = await up(KEV_URL, '/v1/models');
const fmUp = await up(FM_URL, '/health');

const map = makeTestMap();
const plans = playbookFor('gate_surge', map);

const context = {
  crowdAtTarget: 'high' as const,
  waitMinBucket: 10,
  minToKickoffBucket: 0,
  weather: 'clear' as const,
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

/**
 * These talk to the real local models. They are skipped when the models are not
 * running, so `npm test` passes on a bare checkout — but when Kev and `fm serve`
 * are up, they are the proof that the two integrations work against the real
 * thing rather than against doubles written from the same assumptions.
 */
describe.skipIf(!kevUp)('Kev-4B, live on :8009', () => {
  it('answers a choice question with probabilities over our own option keys', async () => {
    const result = await askKev(ask, SITUATIONS.gate_jammed, { url: KEV_URL, model: 'kev-latest', timeoutMs: 30_000 });
    expect(result, 'Kev returned nothing usable').not.toBeNull();
    const options = SITUATIONS.gate_jammed.options.map((o) => o.key);
    expect(Object.keys(result!.odds).sort()).toEqual([...options].sort());
    // valid Odds per the contract: known keys, finite, summing to 1
    expect(oddsAreValid(result!.odds, options)).toBe(true);
  }, 60_000);

  it('gives a different distribution for a different situation', async () => {
    const shelterContext = { ...context, weather: 'lightning' as const, alertHeard: true };
    const shelterAsk: DecisionAsk = {
      key: decisionKey('mobility-limited', 'lightning_shelter', shelterContext),
      fanTypeId: 'mobility-limited',
      situation: 'lightning_shelter',
      context: shelterContext,
      dotIds: [9],
    };
    const result = await askKev(shelterAsk, SITUATIONS.lightning_shelter, {
      url: KEV_URL,
      model: 'kev-latest',
      timeoutMs: 30_000,
    });
    expect(result).not.toBeNull();
    expect(oddsAreValid(result!.odds, SITUATIONS.lightning_shelter.options.map((o) => o.key))).toBe(true);
    // a fan who cannot move fast, in lightning, having heard the alert: indoors
    expect(result!.odds.go_concourse).toBeGreaterThan(result!.odds.stay_put!);
  }, 60_000);
});

describe.skipIf(!fmUp)('Apple on-device model through fm serve', () => {
  const card = (label: 'A' | 'B' | 'C', planId: string, over: Partial<Scorecard> = {}): Scorecard => ({
    runId: `run-${label}`,
    planId,
    label,
    timeToClearMin: 6,
    peakDensity: 5,
    dangerMinutes: 174982,
    firstOfficerMin: 0,
    officerMinutesUsed: 180,
    fansNotReached: 100000,
    fallbackDecisions: 0,
    ...over,
  });

  const request: BriefingRequest = {
    incident: testGateSurge(map, 0),
    plans,
    scorecards: [
      card('A', plans[0]!.id),
      card('B', plans[1]!.id, { timeToClearMin: 9, officerMinutesUsed: 60, fansNotReached: 99205 }),
      card('C', plans[2]!.id, { timeToClearMin: null, officerMinutesUsed: 120, fansNotReached: 49935 }),
    ],
  };

  it('writes a briefing whose every number is already on a scorecard', async () => {
    const result = await askFm(request, { url: FM_URL, model: 'system', timeoutMs: 60_000 });
    expect(result, 'fm serve returned nothing').not.toBeNull();
    expect(result!.text.length).toBeGreaterThan(40);
    // the guard that decides whether the commander sees this or the template
    expect(briefingIsSupported(result!.text, request), `invented a number: ${result!.text}`).toBe(true);
  }, 90_000);
});
