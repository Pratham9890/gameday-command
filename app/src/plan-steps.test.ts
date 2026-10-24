import { describe, expect, it } from 'vitest';
import { makeTestMap } from '../../world/src/test-map.ts';
import { buildStep, stepChoices } from './plan-steps.ts';

const map = makeTestMap();
const choices = stepChoices(map);

describe('plan step dropdowns', () => {
  it('offers the map’s gates, doors and places', () => {
    expect(choices.gates.length).toBeGreaterThan(0);
    expect(choices.closables.some((c) => c.id.endsWith('-door'))).toBe(true);
    expect(choices.places.length).toBeGreaterThanOrEqual(choices.gates.length);
  });

  it('builds each kind of step, in seconds after the incident', () => {
    const gate = choices.gates[0]!.id;
    const other = choices.gates[1]!.id;
    const door = choices.closables[0]!.id;
    expect(buildStep({ kind: 'close', atMin: 1.5, target: door }, choices)).toEqual({ at: 90, type: 'close', closableId: door });
    expect(buildStep({ kind: 'send_officers', atMin: 0, target: gate, count: 4 }, choices)).toEqual({ at: 0, type: 'send_officers', count: 4, toPlaceId: gate });
    expect(buildStep({ kind: 'redirect', atMin: 2, from: gate, to: other }, choices)).toMatchObject({ type: 'redirect', fromPlaceId: gate, toPlaceId: other, at: 120 });
    expect(buildStep({ kind: 'alert', atMin: 0, channel: 'phone', reachPct: 40 }, choices)).toMatchObject({ type: 'alert', channel: 'phone', reachShare: 0.4 });
    expect(buildStep({ kind: 'shelter_order', atMin: 0 }, choices)?.type).toBe('shelter_order');
  });

  it('refuses a step until its choices are made, or when they make no sense', () => {
    const gate = choices.gates[0]!.id;
    expect(buildStep({ kind: 'close', atMin: 0 }, choices)).toBeNull();
    expect(buildStep({ kind: 'send_officers', atMin: 0, target: gate, count: 0 }, choices)).toBeNull();
    expect(buildStep({ kind: 'redirect', atMin: 0, from: gate, to: gate }, choices)).toBeNull();
    expect(buildStep({ kind: 'close', atMin: 0, target: 'not-a-door' }, choices)).toBeNull();
  });
});
