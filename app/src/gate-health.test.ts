import { describe, expect, it } from 'vitest';
import type { GateStat } from '../../engine/src/edits.ts';
import {
  SEIZED_HOLD_S,
  SEIZED_WAITING,
  SLOW_CAPACITY_FRACTION,
  UNUSED_MIN_OBSERVED_S,
  classifyGates,
  type GateHealth,
  type GateSample,
} from './gate-health.ts';

function gate(place: number, over: Partial<GateStat> = {}): GateStat {
  return {
    place,
    open: true,
    inPerMin: 0,
    outPerMin: 0,
    waiting: 0,
    capacityPerMin: 200,
    officers: 0,
    ...over,
  };
}

const sample = (t: number, gates: GateStat[]): GateSample => ({ t, gates });

function healthOf(health: GateHealth[], place: number): GateHealth {
  const found = health.find((h) => h.place === place);
  if (!found) throw new Error(`no health for place ${place}`);
  return found;
}

/** A gate that has already served fans, then a stalled run from t = 60. */
function stalledHistory(): GateSample[] {
  return [
    sample(0, [gate(1, { inPerMin: 150, waiting: 5 }), gate(2, { inPerMin: 150, waiting: 5 })]),
    sample(60, [gate(1, { inPerMin: 160, waiting: 5 }), gate(2, { waiting: 990 })]),
    sample(120, [gate(1, { inPerMin: 160, waiting: 5 }), gate(2, { waiting: 990 })]),
  ];
}

describe('gate health', () => {
  it('leaves a working gate ok, and a closed gate is never seized or unused', () => {
    const current = sample(120, [
      gate(1, { waiting: 600, inPerMin: 180 }),
      gate(2, { open: false, waiting: 990, inPerMin: 0 }),
    ]);
    const history = [sample(0, [gate(1, { waiting: 600, inPerMin: 180 }), gate(2, { open: false, waiting: 990 })])];

    const health = classifyGates(history, current);
    expect(healthOf(health, 1)).toMatchObject({ health: 'ok', reason: '180 of 200/min' });
    expect(healthOf(health, 2)).toMatchObject({ health: 'ok', reason: 'door closed' });
  });

  it('flags slow: open with a queue and in/min under a quarter of capacity', () => {
    const current = sample(120, [gate(1, { waiting: 600, inPerMin: 20 })]);
    const health = classifyGates([sample(0, [gate(1, { waiting: 500, inPerMin: 20 })])], current);

    expect(SLOW_CAPACITY_FRACTION).toBe(0.25);
    expect(healthOf(health, 1)).toMatchObject({
      health: 'slow',
      reason: '20 in/min is 10% of 200/min with 600 waiting',
    });
  });

  it('does not call a low rate slow when the queue is short', () => {
    const current = sample(120, [gate(1, { waiting: SEIZED_WAITING - 1, inPerMin: 20 })]);
    expect(healthOf(classifyGates([], current), 1).health).toBe('ok');
  });

  it('flags seized after 120 sim s of a queue with 0 in/min', () => {
    const current = sample(180, [
      gate(1, { inPerMin: 160, waiting: 5 }),
      gate(2, { waiting: 990 }),
    ]);
    const seized = healthOf(classifyGates(stalledHistory(), current), 2);

    expect(SEIZED_HOLD_S).toBe(120);
    expect(SEIZED_WAITING).toBe(50);
    expect(seized).toMatchObject({
      health: 'seized',
      stalledForS: 120,
      reason: '0 in/min for 2.0 min with 990 waiting',
    });
  });

  it('holds the line at 119 s stalled and trips at 120 s', () => {
    const before = sample(179, [gate(1, { inPerMin: 160, waiting: 5 }), gate(2, { waiting: 990 })]);
    const at = sample(180, [gate(1, { inPerMin: 160, waiting: 5 }), gate(2, { waiting: 990 })]);

    const notYet = healthOf(classifyGates(stalledHistory(), before), 2);
    expect(notYet.health).not.toBe('seized');
    expect(notYet.stalledForS).toBe(119);

    const seized = healthOf(classifyGates(stalledHistory(), at), 2);
    expect(seized.health).toBe('seized');
    expect(seized.stalledForS).toBe(120);
  });

  it('clears a seized gate as soon as in/min is non-zero again, and restarts the hold', () => {
    const recovered = sample(300, [
      gate(1, { inPerMin: 160, waiting: 5 }),
      gate(2, { inPerMin: 160, waiting: 600 }),
    ]);
    const healed = healthOf(classifyGates(stalledHistory(), recovered), 2);
    expect(healed).toMatchObject({ health: 'ok', stalledForS: 0 });
    expect(healed.reason).not.toContain('seized');

    // It stalls again at t=360: the clock restarts from there, so at t=420
    // only 60 s are on the new hold and it is not seized yet.
    const reStalled = sample(420, [gate(2, { waiting: 600 })]);
    const history = [...stalledHistory(), recovered, sample(360, [gate(2, { waiting: 600 })])];
    const again = healthOf(classifyGates(history, reStalled), 2);
    expect(again.health).not.toBe('seized');
    expect(again.stalledForS).toBe(60);
  });

  it('flags unused: open, never admitted anyone, while other gates have', () => {
    const history = [sample(0, [gate(1, { inPerMin: 200, waiting: 10 }), gate(2, { waiting: 10 })])];
    const current = sample(90, [gate(1, { inPerMin: 200, waiting: 10 }), gate(2, { waiting: 10 })]);
    const dead = healthOf(classifyGates(history, current), 2);

    expect(UNUSED_MIN_OBSERVED_S).toBe(60);
    expect(dead).toMatchObject({ health: 'unused', admittedEver: false });
    expect(dead.reason).toContain('no one through in 1.5 min');
  });

  it('flags an open gate that never had a single fan waiting (Gate 8), and not as seized', () => {
    const history = [sample(0, [gate(1, { inPerMin: 200 }), gate(2, { waiting: 0 })])];
    const current = sample(180, [gate(1, { inPerMin: 200 }), gate(2, { waiting: 0 })]);
    const dead = healthOf(classifyGates(history, current), 2);

    expect(dead.health).toBe('unused');
    expect(dead.health).not.toBe('seized');
    expect(dead.stalledForS).toBe(0);
  });

  it('does not call a gate unused before any gate has admitted anyone', () => {
    const history = [sample(0, [gate(1), gate(2)])];
    const current = sample(180, [gate(1), gate(2)]);
    const health = classifyGates(history, current);
    expect(health.map((h) => h.health)).toEqual(['ok', 'ok']);
    expect(healthOf(health, 1).reason).toBe('no one through yet');
  });

  it('ignores samples from after the current sim second', () => {
    const future = sample(500, [gate(1, { waiting: 990 })]);
    const current = sample(0, [gate(1, { waiting: 990 })]);
    expect(healthOf(classifyGates([future], current), 1).health).not.toBe('seized');
  });
});
