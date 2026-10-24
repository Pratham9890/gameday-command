import { describe, expect, it } from 'vitest';
import type { BriefingRequest, Scorecard } from '../../contracts.ts';
import { makeTestMap } from '../../world/src/test-map.ts';
import { playbookFor } from '../../world/src/playbook.ts';
import { testGateSurge } from '../../world/src/incidents.ts';
import { briefingIsSupported, numbersIn, templateBriefing } from './briefing.ts';
import { buildSystemOneRequest, parseSystemOne, QUESTION_ID } from './kev.ts';
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

describe('kev client speaks /v1/systemone', () => {
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

  it('asks one choice question whose options are the engine\u2019s own option keys', () => {
    const req = buildSystemOneRequest(ask, SITUATIONS.gate_jammed, 'kev-latest');
    const question = req.questions[QUESTION_ID]!;
    expect(question.type).toBe('choice');
    // Probabilities come back keyed by these names, which is exactly Odds.
    expect(Object.keys(question.criteria)).toEqual(['hold_place', 'try_other_gate', 'back_off']);
    expect(question.criteria.hold_place).toBe('Hold my place in line');
  });

  it('sends the rounded context as the state, so one call answers the whole group', () => {
    const state = buildSystemOneRequest(ask, SITUATIONS.gate_jammed, 'kev-latest').state as Record<string, unknown>;
    expect(state.minutes_to_kickoff).toBe(15);
    expect(state.weather).toBe('clear');
    expect(state.crowd_where_they_are_headed).toBe('high');
    expect(state.an_officer_nearby_gave_an_instruction).toBe(false);
    expect(String(state.who)).toContain('student section');
  });

  it('reads the probabilities straight out of a choice answer', () => {
    const odds = parseSystemOne({
      model: 'kev-4b',
      answers: {
        [QUESTION_ID]: {
          type: 'choice',
          choice: 'hold_place',
          confidence: 0.3,
          probabilities: { hold_place: 0.5, try_other_gate: 0.3, back_off: 0.2 },
        },
      },
    });
    expect(odds).toEqual({ hold_place: 0.5, try_other_gate: 0.3, back_off: 0.2 });
  });

  it('refuses an answer of the wrong type or with no probabilities', () => {
    expect(parseSystemOne({ answers: { [QUESTION_ID]: { type: 'noul' } } })).toBeNull();
    expect(parseSystemOne({ answers: { [QUESTION_ID]: { type: 'choice', probabilities: {} } } })).toBeNull();
    expect(parseSystemOne({ answers: {} })).toBeNull();
    expect(parseSystemOne({})).toBeNull();
  });
});
