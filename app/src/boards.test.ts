import { describe, expect, it } from 'vitest';
import { makeTestMap } from '../../world/src/test-map.ts';
import { lotRows, rosterRows, zoneRows } from './boards.ts';

const map = makeTestMap();
const flat = (value: number) => new Float32Array(map.width * map.height).fill(value);

describe('boards come from the density grid and scene', () => {
  it('ranks zones and only changes when the density changes', () => {
    const first = zoneRows(map, { peoplePerM2: flat(0) }, undefined);
    expect(first.length).toBeGreaterThan(0);
    expect(first[0]!.people).toBe(0);
    expect(first[0]!.etaMin).toBeNull();

    const park = map.places.find((p) => p.kind === 'parking')!;
    const hot = flat(0);
    for (const cell of park.cells) hot[cell] = 3;
    const previous = Object.fromEntries(first.map((r) => [r.id, { people: r.people, peak: r.peak }]));
    const second = zoneRows(map, { peoplePerM2: hot }, previous);
    const row = second.find((r) => r.id === park.id)!;
    expect(row.people).toBe(park.cells.length * 4 * 3);
    expect(row.peak).toBe(3);
    expect(row.trendPerMin).toBeGreaterThan(0);
    expect(row.etaMin).not.toBeNull();
    expect(second[0]!.people).toBeGreaterThanOrEqual(second[second.length - 1]!.people);
  });

  it('uses standing density, so a seated block is not a queue', () => {
    const rows = zoneRows(map, { peoplePerM2: flat(5), standingPerM2: flat(0) }, undefined);
    expect(rows.every((r) => r.people === 0)).toBe(true);
    const queued = zoneRows(map, { peoplePerM2: flat(0), standingPerM2: flat(5) }, undefined);
    expect(queued.some((r) => r.people > 0)).toBe(true);
  });

  it('computed lot occupancy rises with people and never divides by zero', () => {
    const empty = lotRows(map, { peoplePerM2: flat(0) });
    expect(empty.length).toBeGreaterThan(0);
    const lot = map.places.find((p) => p.kind === 'parking')!;
    const hot = flat(0);
    for (const cell of lot.cells) hot[cell] = 2;
    const rows = lotRows(map, { peoplePerM2: hot });
    const row = rows.find((r) => r.id === lot.id)!;
    expect(row.occupancy).toBeGreaterThan(0);
    expect(row.capacity).toBeGreaterThan(0);
  });

  it('roster has one row per officer and updates values between frames', () => {
    const officers = [
      { id: 'off-1', unit: 'OSU PD 1', cell: 0, x: 0, y: 0, state: 'en_route' as const, targetCell: 1, place: 0, homeCell: 0, told: 10, followed: 4, etaS: 90 },
      { id: 'off-2', unit: 'OSU PD 2', cell: 0, x: 0, y: 0, state: 'standby' as const, targetCell: 0, place: -1, homeCell: 0, told: 0, followed: 0, etaS: null },
    ];
    const rows = rosterRows(map, officers);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.etaMin).toBeCloseTo(1.5, 6);
    expect(rows[0]!.followRate).toBeCloseTo(0.4, 6);
    expect(rows[1]!.followRate).toBeNull();
    expect(rows[1]!.order).toBe('Standby');
  });
});
