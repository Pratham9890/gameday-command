import { describe, expect, it } from 'vitest';
import type { MapBundle, SimConfig } from '../../contracts.ts';
import { CELL_SIZE_M, DOT_GROUP_SIZE } from '../../contracts.ts';
import { DECISION_DEFAULTS } from '../../brain/src/defaults.ts';
import { makePopulation } from '../../brain/src/fan-types.ts';
import { makeTestMap, TEST_GATE_THROUGHPUT_PER_MIN } from '../../world/src/test-map.ts';
import { playbookFor } from '../../world/src/playbook.ts';
import { testGateSurge } from '../../world/src/incidents.ts';
import { makeOfficers } from '../../world/src/officers.ts';
import { FlowFields, UNREACHABLE } from './flowfield.ts';
import { densityFactor, FlowMovement, MAX_DOTS_PER_CELL, RHO_JAM } from './movement-flow.ts';
import { Simulation } from './sim.ts';

const map = makeTestMap();
const gateIndex = map.places.findIndex((p) => p.kind === 'gate');
const lotIndex = map.places.findIndex((p) => p.kind === 'parking');

describe('FlowFields', () => {
  it('puts the destination at distance zero and grows outward', () => {
    const fields = new FlowFields(map);
    fields.setClosed(new Set());
    const field = fields.field(gateIndex);
    const gateCell = map.places[gateIndex]!.cells[0]!;
    expect(field.dist[gateCell]).toBe(0);
    // one row south of the gate is one step away
    expect(field.dist[gateCell + map.width]).toBe(1);
    expect(field.dist[gateCell + map.width * 2]).toBe(2);
  });

  it('reaches every walkable cell on an open map', () => {
    const fields = new FlowFields(map);
    fields.setClosed(new Set());
    const field = fields.field(gateIndex);
    for (let cell = 0; cell < map.cells.length; cell++) {
      if (map.cells[cell] === 'blocked') continue;
      expect(field.dist[cell]).not.toBe(UNREACHABLE);
    }
  });

  it('never points into a wall', () => {
    const fields = new FlowFields(map);
    fields.setClosed(new Set());
    const field = fields.field(gateIndex);
    for (let cell = 0; cell < map.cells.length; cell++) {
      const dir = field.dir[cell]!;
      if (dir === 0) continue;
      const dx = [0, 1, 1, 0, -1, -1, -1, 0, 1][dir]!;
      const dy = [0, 0, 1, 1, 1, 0, -1, -1, -1][dir]!;
      const next = (((cell / map.width) | 0) + dy) * map.width + ((cell % map.width) + dx);
      expect(map.cells[next]).not.toBe('blocked');
      expect(field.dist[next]!).toBeLessThan(field.dist[cell]!);
    }
  });

  it('cuts the route off when a street closes, and restores it when it opens', () => {
    const fields = new FlowFields(map);
    fields.setClosed(new Set());
    const lotCell = map.places[lotIndex]!.cells[0]!;
    expect(fields.field(gateIndex).dist[lotCell]).not.toBe(UNREACHABLE);

    // the plaza lane spans the full width, so closing it seals the lot off
    const changed = fields.setClosed(new Set(['test-plaza-lane']));
    expect(changed).toBe(true);
    expect(fields.field(gateIndex).dist[lotCell]).toBe(UNREACHABLE);

    fields.setClosed(new Set());
    expect(fields.field(gateIndex).dist[lotCell]).not.toBe(UNREACHABLE);
  });

  it('only rebuilds when the closure set actually changes', () => {
    const fields = new FlowFields(map);
    expect(fields.setClosed(new Set(['test-plaza-lane']))).toBe(true);
    expect(fields.setClosed(new Set(['test-plaza-lane']))).toBe(false);
  });
});

describe('density slows walking', () => {
  it('is full speed on an empty cell and a crawl at jam density', () => {
    expect(densityFactor(0)).toBe(1);
    expect(densityFactor(RHO_JAM)).toBeCloseTo(0.05, 6);
    expect(densityFactor(100)).toBeCloseTo(0.05, 6);
  });

  it('is already well under half speed at the danger line', () => {
    // 4 people per square meter is the scorecard's danger threshold
    expect(densityFactor(4)).toBeLessThan(0.5);
    expect(densityFactor(4)).toBeGreaterThan(0.2);
  });

  it('falls as density rises', () => {
    expect(densityFactor(1)).toBeGreaterThan(densityFactor(2));
    expect(densityFactor(2)).toBeGreaterThan(densityFactor(3));
  });
});

function makeSim(opts: {
  fans?: number;
  seed?: number;
  planIndex?: number;
  startAt?: number;
  endAt?: number;
  bundle?: MapBundle;
  incidentAt?: number;
} = {}) {
  const bundle = opts.bundle ?? map;
  const seed = opts.seed ?? 20251023;
  const population = makePopulation(opts.fans ?? 1200, seed);
  const plan = playbookFor('gate_surge', bundle)[opts.planIndex ?? 0]!;
  const config: SimConfig = {
    runId: 'run-A',
    label: 'A',
    seed,
    startAt: opts.startAt ?? -3600,
    endAt: opts.endAt ?? 600,
    speed: 1000,
    dangerDensity: 4,
    mapId: bundle.id,
    incident: { ...testGateSurge(bundle, 0), at: opts.incidentAt ?? 0 },
    plan,
    officers: makeOfficers(bundle, 12),
  };
  return new Simulation({
    config,
    map: bundle,
    population,
    defaults: DECISION_DEFAULTS,
    serverUrl: '',
    movement: new FlowMovement(),
    replay: { runId: config.runId, answers: [] },
  });
}

async function runToEnd(sim: Simulation) {
  while (!sim.done) await sim.step();
}

describe('FlowMovement on the test map', () => {
  it('starts everyone off the map, then walks them in and seats them', async () => {
    const sim = makeSim();
    const startStates = new Set(Array.from({ length: sim.ctx.dots.count }, (_, i) => sim.ctx.dots.stateOf(i)));
    expect(startStates).toEqual(new Set(['arriving']));

    await runToEnd(sim);

    let seated = 0;
    let arriving = 0;
    for (let i = 0; i < sim.ctx.dots.count; i++) {
      const state = sim.ctx.dots.stateOf(i);
      if (state === 'seated') seated++;
      if (state === 'arriving') arriving++;
    }
    expect(seated).toBeGreaterThan(0);
    expect(arriving).toBeLessThan(sim.ctx.dots.count);
  });

  it('keeps every dot on a walkable cell', async () => {
    const sim = makeSim();
    await runToEnd(sim);
    const { x, y } = sim.ctx.dots;
    for (let i = 0; i < x.length; i++) {
      if (x[i]! < 0) continue; // not arrived yet
      const cell = ((y[i]! / CELL_SIZE_M) | 0) * map.width + ((x[i]! / CELL_SIZE_M) | 0);
      expect(map.cells[cell]).not.toBe('blocked');
    }
  });

  it('never admits more fans than the gates can physically pass', async () => {
    const minutes = 20;
    const sim = makeSim({ fans: 4000, startAt: -600, endAt: -600 + minutes * 60 });
    await runToEnd(sim);

    let through = 0;
    for (let i = 0; i < sim.ctx.dots.count; i++) {
      const state = sim.ctx.dots.stateOf(i);
      if (state === 'seated' || state === 'sheltering') through++;
    }

    // 3 gates x 60 people/min / 5 fans per dot = 36 dots per minute, plus the
    // one dot of budget each gate starts with.
    const gates = map.places.filter((p) => p.kind === 'gate').length;
    const ceiling = (gates * TEST_GATE_THROUGHPUT_PER_MIN / DOT_GROUP_SIZE) * minutes + gates;
    expect(through).toBeLessThanOrEqual(ceiling);
    expect(through).toBeGreaterThan(0);
  });

  it('makes dots queue and build real density at the gates', async () => {
    const sim = makeSim({ fans: 6000, startAt: -600, endAt: 300 });
    await runToEnd(sim);
    let queued = 0;
    for (let i = 0; i < sim.ctx.dots.count; i++) if (sim.ctx.dots.stateOf(i) === 'queued') queued++;
    expect(queued).toBeGreaterThan(0);
    expect(sim.scorecard().peakDensity).toBeGreaterThan(0);
  });

  it('gives identical runs and identical scorecards for the same seed', async () => {
    const a = makeSim();
    const b = makeSim();
    await runToEnd(a);
    await runToEnd(b);
    expect(Array.from(a.ctx.dots.x)).toEqual(Array.from(b.ctx.dots.x));
    expect(Array.from(a.ctx.dots.state)).toEqual(Array.from(b.ctx.dots.state));
    expect(a.scorecard()).toEqual(b.scorecard());
  });

  it('diverges when the plan changes but the seed does not', async () => {
    const a = makeSim({ planIndex: 0 });
    const c = makeSim({ planIndex: 2 });
    await runToEnd(a);
    await runToEnd(c);
    // plan C closes the hot gate, so the crowd cannot end up in the same place
    expect(Array.from(a.ctx.dots.state)).not.toEqual(Array.from(c.ctx.dots.state));
  });

  it('never lets more dots into a cell than physically fit', async () => {
    // The guard on a whole class of bug: positions live in a Float32Array, so a
    // move computed in float64 can be stored a hair back across a cell
    // boundary. The dot then releases a cell it is still standing in, the cell
    // accepts another dot, and a 2 m square quietly reports 13 people per
    // square meter. Math.fround at the point of decision is what prevents it.
    const sim = makeSim({ fans: 6000, startAt: -600, endAt: 240 });
    const width = map.width;

    while (!sim.done) {
      await sim.step();
      const counts = new Int32Array(map.cells.length);
      const { x, y, state, count } = sim.ctx.dots;
      for (let i = 0; i < count; i++) {
        if (sim.ctx.dots.stateOf(i) === 'gone') continue;
        if (x[i]! < 0 || y[i]! < 0) continue;
        counts[((y[i]! / CELL_SIZE_M) | 0) * width + ((x[i]! / CELL_SIZE_M) | 0)]!++;
      }
      void state;
      let worst = 0;
      for (let c = 0; c < counts.length; c++) if (counts[c]! > worst) worst = counts[c]!;
      expect(worst, `t=${sim.ctx.t} packed ${worst} dots into one cell`).toBeLessThanOrEqual(MAX_DOTS_PER_CELL);
    }
  });

  it('keeps peak density at a physically possible number', async () => {
    const sim = makeSim({ fans: 6000, startAt: -600, endAt: 240 });
    await runToEnd(sim);
    // MAX_DOTS_PER_CELL dots x 5 fans / 4 square meters
    const ceiling = (MAX_DOTS_PER_CELL * DOT_GROUP_SIZE) / (CELL_SIZE_M * CELL_SIZE_M);
    expect(sim.scorecard().peakDensity).toBeLessThanOrEqual(ceiling);
    expect(sim.scorecard().peakDensity).toBeGreaterThan(0);
  });
});
