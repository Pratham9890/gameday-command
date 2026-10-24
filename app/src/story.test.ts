import { describe, expect, it } from 'vitest';
import type { Incident, Scorecard } from '../../contracts.ts';
import { clockText, incidentStatus, liveStats, rankPlans, verdictText } from './story.ts';

const card = (label: 'A' | 'B' | 'C', timeToClearMin: number | null, dangerMinutes: number): Scorecard => ({
  runId: label,
  planId: label,
  label,
  timeToClearMin,
  peakDensity: 4,
  dangerMinutes,
  firstOfficerMin: null,
  officerMinutesUsed: 0,
  fansNotReached: 0,
  fallbackDecisions: 0,
});

describe('commander screen words', () => {
  it('tells the time relative to kickoff', () => {
    expect(clockText(-2520)).toBe('42 min to kickoff');
    expect(clockText(10)).toBe('Kickoff');
    expect(clockText(600)).toBe('10 min after kickoff');
  });

  it('says where the run is relative to the incident', () => {
    const incident = { id: 'i', kind: 'gate_surge', at: 0 } as Incident;
    expect(incidentStatus(incident, -600)).toEqual({ text: 'Gate surge starts in 10 min', phase: 'before' });
    expect(incidentStatus(incident, 180).phase).toBe('during');
  });

  it('ranks the plan that clears first, and never-cleared last', () => {
    const cards = [card('A', null, 10), card('B', 8.6, 50), card('C', 6.2, 90)];
    expect(rankPlans(cards)).toEqual([2, 1, 0]);
  });

  it('breaks a tie on time spent dangerously packed', () => {
    expect(rankPlans([card('A', null, 30), card('B', null, 5), card('C', null, 60)])).toEqual([1, 0, 2]);
  });

  it('writes a verdict a judge can read out', () => {
    const text = verdictText(['A', 'B', 'C'], ['Officers', 'Open Gate 2', 'Close Gate 1'], [card('A', 6.2, 1), card('B', 8.6, 1), card('C', null, 1)], 'Gate 1');
    expect(text).toBe('Plan A (Officers) cleared the crowd at Gate 1 fastest, in 6.2 min. Others: B 8.6 min, C never cleared.');
  });

  it('counts people from density', () => {
    const rho = new Float32Array([0, 1, 5, 0.5]);
    const stats = liveStats(rho, [1, 2], 4);
    expect(stats.zonePeople).toBe(24); // (1 + 5) people/m² over two 4 m² cells
    expect(stats.dangerPeople).toBe(20);
    expect(stats.peak).toBe(5);
  });

  it('leaves seated fans out of the danger count', () => {
    const rho = new Float32Array([5, 5, 1]);
    const stats = liveStats(rho, [], 4, new Uint8Array([1, 0, 0]));
    expect(stats.dangerPeople).toBe(20);
  });
});
