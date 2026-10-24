import { describe, expect, it } from 'vitest';
import { makeTestMap, TEST_GATE_XS, TEST_MAP_HEIGHT, TEST_MAP_WIDTH } from './test-map.ts';
import { playbookFor } from './playbook.ts';
import { testGateSurge } from './incidents.ts';
import { makeOfficers } from './officers.ts';

describe('test map', () => {
  const map = makeTestMap();

  it('is the size it claims to be', () => {
    expect(map.cells).toHaveLength(TEST_MAP_WIDTH * TEST_MAP_HEIGHT);
    expect(map.width).toBe(TEST_MAP_WIDTH);
    expect(map.height).toBe(TEST_MAP_HEIGHT);
  });

  it('has three gates, each a hole in the wall row', () => {
    const gates = map.places.filter((p) => p.kind === 'gate');
    expect(gates).toHaveLength(3);
    for (const x of TEST_GATE_XS) {
      expect(map.cells[3 * TEST_MAP_WIDTH + x]).toBe('walk');
    }
    // the rest of row 3 is wall
    expect(map.cells[3 * TEST_MAP_WIDTH + 0]).toBe('blocked');
  });

  it('gives every gate a closable door', () => {
    const gates = map.places.filter((p) => p.kind === 'gate');
    for (const gate of gates) {
      expect(map.closables.some((c) => c.cells.some((cell) => gate.cells.includes(cell)))).toBe(true);
    }
  });

  it('offers three editable plans for the gate surge', () => {
    const plans = playbookFor('gate_surge', map);
    expect(plans).toHaveLength(3);
    for (const plan of plans) {
      expect(plan.forIncident).toBe('gate_surge');
      expect(plan.actions.length).toBeGreaterThan(0);
    }
  });

  it('places the incident on a real gate and posts officers on the map', () => {
    const incident = testGateSurge(map, 0);
    expect(incident.cells!.length).toBeGreaterThan(1);
    expect(incident.cells!.every((cell) => map.cells[cell] !== 'blocked')).toBe(true);
    const officers = makeOfficers(map, 12);
    expect(officers).toHaveLength(12);
    for (const officer of officers) {
      expect(map.cells[officer.cell]).not.toBe('blocked');
    }
  });
});
