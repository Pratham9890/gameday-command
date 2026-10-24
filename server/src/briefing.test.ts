import { describe, expect, it } from 'vitest';
import type { BriefingRequest, Scorecard } from '../../contracts.ts';
import { makeTestMap } from '../../world/src/test-map.ts';
import { playbookFor } from '../../world/src/playbook.ts';
import { testGateSurge } from '../../world/src/incidents.ts';
import { briefingIsSupported, numbersIn, templateBriefing } from './briefing.ts';
import { buildPrompt, parseOdds } from './kev.ts';
import { SITUATIONS } from '../../brain/src/situations.ts';

const map = makeTestMap();
const plans = playbookFor('gate_surge', map);

const card = (label: 'A' | 'B' | 'C', over: Partial<Scorecard> = {}): Scorecard => ({
  runId: `run-${label}`,
  planId: plans[0]!.id,
  label,
  timeToClearMin: 12,
  peakDensity: 4.3,
  dangerMinutes: 7,
  firstOfficerMin: 3,
  officerMinutesUsed: 48,
  fansNotReached: 1500,
  fallbackDecisions: 0,
  ...over,
});

const request: BriefingRequest = {
  incident: testGateSurge(map, 0),
  plans,
  scorecards: [card('A'), card('B', { planId: plans[1]!.id, timeToClearMin: 18, peakDensity: 5.1 })],
};

describe('briefing', () => {
  it('writes a template that only cites scorecard numbers', () => {
    const briefing = templateBriefing(request);
    expect(briefing.canned).toBe(true);
    expect(briefingIsSupported(briefing.text, request)).toBe(true);
  });

  it('labels fan behavior as an assumption', () => {
    expect(templateBriefing(request).text).toContain('assumption, not a forecast');
  });

  it('rejects a briefing that invents a number', () => {
    expect(briefingIsSupported('Plan A clears in 12 minutes and costs 999 officer minutes.', request)).toBe(false);
  });

  it('accepts numbers that match a scorecard value when rounded', () => {
    expect(briefingIsSupported('Peak density was 4.3 and clearance took 12 minutes.', request)).toBe(true);
  });

  it('finds the numbers in a sentence', () => {
    expect(numbersIn('clears in 12 minutes, peak 4.3')).toEqual([12, 4.3]);
  });
});

describe('kev client', () => {
  const ask = {
    key: 'k',
    fanTypeId: 'student-section',
    situation: 'gate_jammed' as const,
    context: {
      crowdAtTarget: 'high' as const,
      waitMinBucket: 10,
      minToKickoffBucket: 15,
      weather: 'clear' as const,
      officerOrder: false,
      alertHeard: false,
    },
    dotIds: [1],
  };

  it('builds a prompt far under the context limit', () => {
    const prompt = buildPrompt(ask, SITUATIONS.gate_jammed);
    expect(prompt).toContain('hold_place');
    // 4k tokens is roughly 16k characters; this must stay nowhere near it
    expect(prompt.length).toBeLessThan(1200);
  });

  it('pulls odds out of a reply that has chatter around the JSON', () => {
    const odds = parseOdds('Sure! {"hold_place": 0.5, "try_other_gate": 0.3, "back_off": 0.2} hope that helps');
    expect(odds).toEqual({ hold_place: 0.5, try_other_gate: 0.3, back_off: 0.2 });
  });

  it('returns null when there is no JSON at all', () => {
    expect(parseOdds('I cannot help with that.')).toBeNull();
  });
});
