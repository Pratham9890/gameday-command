import { describe, expect, it } from 'vitest';
import { buildStadiumMap, extractExists, loadExtract } from '../../world/src/osm/stadium.ts';
import { candidatePlans } from './candidates.ts';

const suite = extractExists() ? describe : describe.skip;

suite('candidate generation', () => {
  const map = buildStadiumMap(loadExtract());

  it('builds 20-60 unique plans, deterministically', () => {
    const one = candidatePlans({ map, incidentKind: 'gate_surge', target: 40 });
    const two = candidatePlans({ map, incidentKind: 'gate_surge', target: 40 });
    expect(one.length).toBeGreaterThanOrEqual(20);
    expect(one.length).toBeLessThanOrEqual(60);
    expect(one.map((p) => JSON.stringify(p.actions))).toEqual(two.map((p) => JSON.stringify(p.actions)));
    expect(new Set(one.map((p) => JSON.stringify(p.actions))).size).toBe(one.length);
    expect(new Set(one.map((p) => p.id)).size).toBe(one.length);
  });

  it('covers the intervention families the map supports', () => {
    const plans = candidatePlans({ map, incidentKind: 'gate_surge', target: 60 });
    const types = new Set(plans.flatMap((p) => p.actions.map((a) => a.type)));
    expect(types.has('close')).toBe(true);
    expect(types.has('send_officers')).toBe(true);
    expect(types.has('alert')).toBe(true);
    expect(types.has('redirect')).toBe(true);
    expect(types.has('shelter_order')).toBe(true);
  });
});
