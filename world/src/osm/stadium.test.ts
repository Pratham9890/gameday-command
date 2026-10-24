import { describe, expect, it } from 'vitest';
import { makeOfficers, policeStations } from '../officers.ts';
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

  it('lets the crowd into the bowl only through a gate', () => {
    const inBowl = (cell: number) => map.cells[cell] === 'stands' || map.cells[cell] === 'concourse';
    const gates = map.places.filter((p) => p.kind === 'gate').map((p) => {
      const xs = p.cells.map((c) => c % map.width);
      const ys = p.cells.map((c) => Math.floor(c / map.width));
      return { x: xs.reduce((a, b) => a + b) / xs.length, y: ys.reduce((a, b) => a + b) / ys.length };
    });
    // Any open cell outside the bowl that touches it, diagonals included, is a doorway.
    const doorways: number[] = [];
    for (let cell = 0; cell < map.cells.length; cell++) {
      if (map.cells[cell] === 'blocked' || inBowl(cell)) continue;
      const cx = cell % map.width;
      const cy = Math.floor(cell / map.width);
      let touches = false;
      for (let dy = -1; dy <= 1 && !touches; dy++) {
        for (let dx = -1; dx <= 1 && !touches; dx++) touches = inBowl((cy + dy) * map.width + cx + dx);
      }
      if (touches) doorways.push(cell);
    }
    expect(doorways.length).toBeGreaterThan(0);
    // A gate corridor runs about 20 cells from its queue block into the bowl,
    // so its own inner end is that far from the gate's centre.
    const away = doorways.filter((cell) =>
      gates.every((g) => Math.hypot((cell % map.width) - g.x, Math.floor(cell / map.width) - g.y) > 22),
    );
    expect(away).toEqual([]);
  });

  it('puts police posts out on the streets around the stadium', () => {
    const stations = policeStations(map);
    expect(stations.map((s) => s.id)).toEqual(['station-north', 'station-southeast', 'station-southwest']);
    for (const station of stations) expect(map.cells[station.cell]).toBe('road');
    // Officers start there, not at the gates.
    const starts = new Set(makeOfficers(map, 12).map((o) => o.cell));
    expect(starts).toEqual(new Set(stations.map((s) => s.cell)));
  });

  it('turns the lots around the bowl into reserved tailgates', () => {
    const tailgates = map.places.filter((p) => p.kind === 'tailgate');
    // Four named lots sit within 200 m of the stands. The cut also excludes the
    // two far lots that no fan can walk to a gate from.
    expect(tailgates.length).toBeGreaterThanOrEqual(4);
  });

  it('gives every tailgate a unique lot id and walkable cells', () => {
    const tailgates = map.places.filter((p) => p.kind === 'tailgate');
    expect(new Set(tailgates.map((t) => t.id)).size).toBe(tailgates.length);
    for (const tailgate of tailgates) {
      expect(tailgate.id).toMatch(/^tailgate-lot-\d+$/);
      expect(tailgate.cells.length).toBeGreaterThan(0);
      // Every cell, not a sample: a tailgate reuses its lot's parking cells.
      for (const cell of tailgate.cells) {
        expect(map.cells[cell], `${tailgate.id} cell ${cell}`).not.toBe('blocked');
      }
      expect(tailgate.capacity).toBe(tailgate.cells.length * 4);
    }
  });

  it('keeps every tailgate inside a kilometre of the bowl', () => {
    // Measure: straight-line distance between the mean cell of the tailgate and
    // the mean cell of the seating place, in metres (CELL_SIZE_M per cell).
    const centroidOf = (cells: number[]) => {
      let x = 0;
      let y = 0;
      for (const cell of cells) {
        x += cell % map.width;
        y += Math.floor(cell / map.width);
      }
      return { x: x / cells.length, y: y / cells.length };
    };
    const seating = map.places.find((p) => p.kind === 'seating')!;
    const bowl = centroidOf(seating.cells);
    const tailgates = map.places.filter((p) => p.kind === 'tailgate');
    expect(tailgates.length).toBeGreaterThanOrEqual(4);
    for (const tailgate of tailgates) {
      const centre = centroidOf(tailgate.cells);
      const distanceM = Math.hypot(centre.x - bowl.x, centre.y - bowl.y) * CELL_SIZE_M;
      expect(distanceM, `${tailgate.name} is ${Math.round(distanceM)} m from the bowl`).toBeLessThanOrEqual(1000);
    }
  });

  it('lets every tailgate reach a gate', () => {
    const fields = new FlowFields(map);
    fields.setClosed(new Set());
    const gates = map.places.flatMap((place, index) => (place.kind === 'gate' ? [fields.field(index)] : []));
    expect(gates.length).toBeGreaterThan(0);
    for (const tailgate of map.places.filter((p) => p.kind === 'tailgate')) {
      const open = gates.some((field) =>
        tailgate.cells.every((cell) => field.dist[cell] !== UNREACHABLE),
      );
      expect(open, `${tailgate.name} cannot reach a gate`).toBe(true);
    }
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
