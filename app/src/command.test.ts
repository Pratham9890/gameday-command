import { describe, expect, it } from 'vitest';
import type { Scorecard } from '../../contracts.ts';
import type { GateStat } from '../../engine/src/edits.ts';
import { makeTestMap } from '../../world/src/test-map.ts';
import { briefLine, levelOf, GATE_LEVELS, noneAchieve, rankByPriority, readings, streetIndex, suggestPlans, usualAt, type HistorySample } from './command.ts';

const map = makeTestMap();
const gatePlaces = map.places.map((p, i) => ({ p, i })).filter(({ p }) => p.kind === 'gate');
const stat = (place: number, waiting: number, open = true): GateStat => ({ place, open, inPerMin: 0, outPerMin: 0, waiting, capacityPerMin: 100, officers: 0 });

const card = (over: Partial<Scorecard>): Scorecard => ({
  runId: 'r', planId: 'p', label: 'A', timeToClearMin: 10, peakDensity: 4, dangerMinutes: 100, firstOfficerMin: 1,
  officerMinutesUsed: 60, fansNotReached: 0, fallbackDecisions: 0, ...over,
});

describe('commander brief', () => {
  it('levels by absolute thresholds without history', () => {
    expect(levelOf(50, null, GATE_LEVELS)).toBe('low');
    expect(levelOf(500, null, GATE_LEVELS)).toBe('medium');
    expect(levelOf(1500, null, GATE_LEVELS)).toBe('high');
  });

  it('levels against history when there is some', () => {
    // 600 waiting is only medium in absolute terms, but double the usual 300.
    expect(levelOf(600, 300, GATE_LEVELS)).toBe('high');
    // 1,200 waiting where 2,000 is usual is a quiet day for that gate.
    expect(levelOf(1200, 2000, GATE_LEVELS)).toBe('low');
    // Tiny numbers stay low whatever the ratio.
    expect(levelOf(40, 5, GATE_LEVELS)).toBe('low');
  });

  it('finds the usual value at the nearest minute within five', () => {
    const h: HistorySample[] = [
      { subject: 'g', kind: 'gate_waiting', minute: -30, mean: 400, n: 3 },
      { subject: 'g', kind: 'gate_waiting', minute: -20, mean: 900, n: 3 },
    ];
    expect(usualAt(h, 'gate_waiting', 'g', -28)).toBe(400);
    expect(usualAt(h, 'gate_waiting', 'g', -21)).toBe(900);
    expect(usualAt(h, 'gate_waiting', 'g', 0)).toBeNull();
  });

  it('briefs the worst first, in radio words', () => {
    const [a, b] = gatePlaces;
    const list = readings(map, [stat(a!.i, 100), stat(b!.i, 1400)], [], streetIndex(map), [], 0);
    expect(list[0]!.name).toBe(b!.p.name);
    expect(list[0]!.level).toBe('high');
    expect(briefLine(list[0]!)).toBe(`${b!.p.name} HIGH: 1,400 waiting.`);
  });

  it('suggests three editable plans around the busiest gate', () => {
    const [a, b, c] = gatePlaces;
    const now = readings(map, [stat(a!.i, 1500), stat(b!.i, 100), stat(c!.i, 900)], [], streetIndex(map), [], 0);
    const plans = suggestPlans(map, 'gate_surge', now);
    expect(plans).toHaveLength(3);
    // The relief gate is the quiet one, not the other busy gate.
    const redirect = plans[0]!.actions.find((x) => x.type === 'redirect');
    expect(redirect).toMatchObject({ fromPlaceId: a!.p.id, toPlaceId: b!.p.id });
    expect(plans[1]!.actions.some((x) => x.type === 'close')).toBe(true);
    expect(plans[2]!.actions.some((x) => x.type === 'send_officers')).toBe(true);
  });

  it('ranks plans by the priority the commander picks', () => {
    const cards = [
      card({ timeToClearMin: 6, officerMinutesUsed: 180, dangerMinutes: 300 }),
      card({ timeToClearMin: 9, officerMinutesUsed: 60, dangerMinutes: 120 }),
      card({ timeToClearMin: null, officerMinutesUsed: 120, dangerMinutes: 500, emergencyResponseMin: 2 }),
    ];
    expect(rankByPriority(cards, 'clear')).toEqual([0, 1, 2]);
    expect(rankByPriority(cards, 'officers')).toEqual([1, 2, 0]);
    expect(rankByPriority(cards, 'danger')).toEqual([1, 0, 2]);
    expect(rankByPriority(cards, 'ambulance')[0]).toBe(2);
    expect(noneAchieve(cards, 'clear')).toBe(false);
    expect(noneAchieve(cards.map((c) => ({ ...c, timeToClearMin: null })), 'clear')).toBe(true);
  });
});
