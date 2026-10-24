import { describe, expect, it } from 'vitest';
import { CELL_SIZE_M } from '../../../contracts.ts';
import { FlowFields, UNREACHABLE } from '../../../engine/src/flowfield.ts';
import { buildStadiumMap, extractExists, loadExtract, STADIUM_MAP_ID } from './stadium.ts';

const available = extractExists();
const suite = available ? describe : describe.skip;

suite('Ohio Stadium map from OpenStreetMap', () => {
  const map = buildStadiumMap(loadExtract());

  it('covers the stadium plus about half a mile on a 2 m grid', () => {
    // 800 m radius each way at 2 m per cell
    expect(map.width).toBe(800);
    expect(map.height).toBe(800);
    expect(map.cells).toHaveLength(map.width * map.height);
    expect(map.id).toBe(STADIUM_MAP_ID);
    expect(map.width * CELL_SIZE_M).toBe(1600);
  });

  it('finds the bowl, not the arena next door', () => {
    const stands = map.cells.filter((c) => c === 'stands').length;
    const concourse = map.cells.filter((c) => c === 'concourse').length;
    // Ohio Stadium is roughly 214 m x 284 m, so the deck is thousands of cells.
    // Picking the wrong leisure=stadium element gave about 1,100.
    expect(stands).toBeGreaterThan(5000);
    expect(concourse).toBeGreaterThan(1000);
  });

  it('has gates, including one on the north side', () => {
    const gates = map.places.filter((p) => p.kind === 'gate');
    expect(gates.length).toBeGreaterThanOrEqual(10);
    expect(gates.some((g) => /\(N\)/.test(g.name))).toBe(true);
    for (const gate of gates) {
      expect(gate.throughputPerMin).toBeGreaterThan(0);
      for (const cell of gate.cells) expect(map.cells[cell]).not.toBe('blocked');
    }
  });

  it('has parking, seating and a concourse to shelter in', () => {
    for (const kind of ['parking', 'seating', 'concourse'] as const) {
      expect(map.places.some((p) => p.kind === kind)).toBe(true);
    }
  });

  it('can close real named streets', () => {
    const streets = map.closables.filter((c) => c.id.startsWith('street-'));
    expect(streets.length).toBeGreaterThan(0);
    expect(streets.some((s) => /Woody Hayes|Lane Avenue|Cannon/i.test(s.name))).toBe(true);
  });

  it('credits OpenStreetMap and flags the gate assumption', () => {
    const labels = map.sources.map((s) => s.label).join(' ');
    expect(labels).toMatch(/OpenStreetMap/);
    expect(labels).toMatch(/[Aa]ssumption/);
  });

  it('lets fans in the lots walk to every gate', () => {
    const fields = new FlowFields(map);
    fields.setClosed(new Set());
    const lots = map.places.filter((p) => p.kind === 'parking');
    const sample = lots.flatMap((l) => l.cells.filter((_, i) => i % 97 === 0)).slice(0, 200);
    expect(sample.length).toBeGreaterThan(50);

    map.places.forEach((place, index) => {
      if (place.kind !== 'gate') return;
      const field = fields.field(index);
      const reachable = sample.filter((cell) => field.dist[cell] !== UNREACHABLE).length;
      expect(reachable, `${place.name} unreachable from the lots`).toBe(sample.length);
    });
  });

  it('lets fans in the stands reach the concourse to shelter', () => {
    const fields = new FlowFields(map);
    fields.setClosed(new Set());
    const concourseIndex = map.places.findIndex((p) => p.kind === 'concourse');
    const field = fields.field(concourseIndex);
    const seats = map.places.find((p) => p.kind === 'seating')!.cells.filter((_, i) => i % 211 === 0);
    const reachable = seats.filter((cell) => field.dist[cell] !== UNREACHABLE).length;
    expect(reachable).toBe(seats.length);
  });
});
