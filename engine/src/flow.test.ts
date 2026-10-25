import { describe, expect, it } from 'vitest';
import type { MapBundle, SimConfig } from '../../contracts.ts';
import { CELL_SIZE_M, DOT_GROUP_SIZE } from '../../contracts.ts';
import { DECISION_DEFAULTS } from '../../brain/src/defaults.ts';
import { makePopulation } from '../../brain/src/fan-types.ts';
import { makeTestMap, TEST_GATE_THROUGHPUT_PER_MIN } from '../../world/src/test-map.ts';
import { playbookFor } from '../../world/src/playbook.ts';
import { testGateSurge } from '../../world/src/incidents.ts';
import { makeOfficers } from '../../world/src/officers.ts';
import { DIR_DX, DIR_DY, FlowFields, SIDEWALK_REACH, stepCost, UNREACHABLE, WALK_STEP } from './flowfield.ts';
import { densityFactor, FlowMovement, MAX_DOTS_PER_CELL, RHO_JAM, SEATS_PER_STANDS_CELL } from './movement-flow.ts';
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
    // one row south of the gate is one step away, priced by what that step is onto
    const one = stepCost(map.cells[gateCell + map.width]!);
    expect(field.dist[gateCell + map.width]).toBe(one);
    expect(field.dist[gateCell + map.width * 2]).toBe(one + stepCost(map.cells[gateCell + map.width * 2]!));
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

describe('routes prefer sidewalks', () => {
  // Start and destination sit one row outside the sidewalk band, so keeping to
  // the sidewalk is a detour the discount has to pay for.
  const W = 31;
  const H = 14;
  const ROAD_ROW = 8;
  const START_ROW = ROAD_ROW - SIDEWALK_REACH - 1;
  const cells = Array.from({ length: W * H }, (_, i) => (Math.floor(i / W) === ROAD_ROW ? 'road' : 'walk')) as MapBundle['cells'];
  const streetMap: MapBundle = {
    ...map,
    id: 'street',
    width: W,
    height: H,
    cells,
    places: [{ id: 'dest', name: 'Dest', kind: 'gate', cells: [START_ROW * W + 30], capacity: 1 }],
    closables: [],
  };

  it('walks beside the street rather than on it or straight across open ground', () => {
    const field = new FlowFields(streetMap).field(0);
    let cell = START_ROW * W;
    let onRoad = 0;
    let onSidewalk = 0;
    for (let steps = 0; steps < 100 && field.dist[cell] !== 0; steps++) {
      const dir = field.dir[cell]!;
      expect(dir).not.toBe(0);
      cell += DIR_DY[dir]! * W + DIR_DX[dir]!;
      if (cells[cell] === 'road') onRoad++;
      if (cells[cell] === 'walk' && Math.abs(Math.floor(cell / W) - ROAD_ROW) <= SIDEWALK_REACH) onSidewalk++;
    }
    expect(field.dist[cell]).toBe(0);
    expect(onRoad).toBe(0);
    // Most of the 30-cell walk, not just the cells where the routes happen to touch.
    expect(onSidewalk).toBeGreaterThan(W / 2);
  });

  it('crosses a street when the destination is on the other side', () => {
    const field = new FlowFields(streetMap).field(0);
    let cell = (H - 1) * W;
    let onRoad = 0;
    for (let steps = 0; steps < 100 && field.dist[cell] !== 0; steps++) {
      const dir = field.dir[cell]!;
      expect(dir).not.toBe(0);
      cell += DIR_DY[dir]! * W + DIR_DX[dir]!;
      if (cells[cell] === 'road') onRoad++;
    }
    expect(field.dist[cell]).toBe(0);
    expect(onRoad).toBeGreaterThan(0);
    expect(onRoad).toBeLessThanOrEqual(2);
  });

  it.each(['walk', 'stands', 'concourse', 'parking', 'shelter'] as const)('keeps %s away from roads at the open-ground step cost', (kind) => {
    const bundle = { ...streetMap, width: 3, height: 1, cells: [kind, kind, kind],
      places: [{ ...streetMap.places[0]!, cells: [2] }] };
    expect(new FlowFields(bundle).field(0).dist[0]).toBe(2 * WALK_STEP);
  });

  it.each(['stands', 'concourse', 'parking', 'shelter'] as const)('does not discount %s beside a road', (kind) => {
    const bundle = { ...streetMap, width: 2, height: 2, cells: [kind, kind, 'road', 'road'] as MapBundle['cells'],
      places: [{ ...streetMap.places[0]!, cells: [1] }] };
    expect(new FlowFields(bundle).field(0).dist[0]).toBe(WALK_STEP);
  });
});

describe('density slows walking', () => {
  it('is full speed on an empty cell and a crawl at jam density', () => {
    expect(densityFactor(0)).toBe(1);
    expect(densityFactor(RHO_JAM)).toBeCloseTo(0.05, 6);
    expect(densityFactor(100)).toBeCloseTo(0.05, 6);
  });

  it('is already well under half speed at the danger line', () => {
    // 4 people per square meter is the scorecard's danger threshold.
    // Weidmann gives 0.116 here; the old linear curve gave 0.259.
    expect(densityFactor(4)).toBeLessThan(0.2);
    expect(densityFactor(4)).toBeGreaterThan(0.1);
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
  movement?: FlowMovement;
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
    movement: opts.movement ?? new FlowMovement(),
    replay: { runId: config.runId, answers: [] },
  });
}

async function runToEnd(sim: Simulation) {
  while (!sim.done) await sim.step();
}

describe('FlowMovement on the test map', () => {
  it('starts everyone off the map, then walks them in and seats them', async () => {
    // A run that starts at kickoff has no observed build-up to pre-seat, so it
    // begins with everyone off-map even though their arrival time has passed.
    const sim = makeSim({ startAt: 0 });
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
    // one dot of budget each gate starts with. Officers on station speed a
    // gate up by at most 40%, and this plan posts six of them on one.
    const gates = map.places.filter((p) => p.kind === 'gate').length;
    const ceiling = ((gates * TEST_GATE_THROUGHPUT_PER_MIN * 1.4) / DOT_GROUP_SIZE) * minutes + gates;
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
    // The incident comes while fans are still arriving: on this small map
    // everyone is through the gates before kickoff, so a gate shut later
    // changes nothing.
    const a = makeSim({ planIndex: 0, incidentAt: -1800, endAt: -1200 });
    const c = makeSim({ planIndex: 2, incidentAt: -1800, endAt: -1200 });
    // Final dot states can converge now that seating is instant, so compare the
    // gates' admitted flow over the run: plan C shuts the hot gate, plan A never
    // does. Summing each step's rolling in/min leaves a different per-gate total.
    const seenA = new Int32Array(map.places.length);
    const seenC = new Int32Array(map.places.length);
    while (!a.done || !c.done) {
      if (!a.done) await a.step();
      if (!c.done) await c.step();
      for (const gate of a.gateStats()) seenA[gate.place] += gate.inPerMin;
      for (const gate of c.gateStats()) seenC[gate.place] += gate.inPerMin;
    }
    expect(Array.from(seenA)).not.toEqual(Array.from(seenC));
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
      const seatedCounts = new Int32Array(map.cells.length);
      const { x, y, count } = sim.ctx.dots;
      for (let i = 0; i < count; i++) {
        const state = sim.ctx.dots.stateOf(i);
        if (state === 'gone') continue;
        if (x[i]! < 0 || y[i]! < 0) continue;
        const cell = ((y[i]! / CELL_SIZE_M) | 0) * width + ((x[i]! / CELL_SIZE_M) | 0);
        counts[cell]!++;
        if (state === 'seated') seatedCounts[cell]!++;
      }
      let worstStanding = 0;
      let worstSeated = 0;
      for (let c = 0; c < counts.length; c++) {
        worstStanding = Math.max(worstStanding, counts[c]! - seatedCounts[c]!);
        worstSeated = Math.max(worstSeated, seatedCounts[c]!);
      }
      expect(worstStanding, `t=${sim.ctx.t} packed ${worstStanding} standing dots into one cell`).toBeLessThanOrEqual(
        MAX_DOTS_PER_CELL,
      );
      expect(worstSeated, `t=${sim.ctx.t} packed ${worstSeated} seated dots into one cell`).toBeLessThanOrEqual(
        SEATS_PER_STANDS_CELL,
      );
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

  it('empties the stands after the game, including fans who waited in their seats', async () => {
    const movement = new FlowMovement();
    const sim = makeSim({ fans: 400, endAt: 5400, movement });
    // The whistle goes once the entry queues have emptied, as at a real game end.
    while (sim.ctx.t < 1800) await sim.step();
    const { dots } = sim.ctx;
    const seated: number[] = [];
    for (let i = 0; i < dots.count; i++) if (dots.stateOf(i) === 'seated') seated.push(i);
    expect(seated.length).toBeGreaterThan(40);

    // The final whistle: half head straight out, half sit and let it thin out.
    seated.forEach((dot, k) => movement.onChoice(sim.ctx, dot, 'exit_route', k % 2 ? 'wait_in_seat' : 'nearest_exit'));
    await runToEnd(sim);

    const left = (dot: number) => dots.stateOf(dot) === 'gone';
    const goers = seated.filter((_, k) => k % 2 === 0);
    const waiters = seated.filter((_, k) => k % 2 === 1);
    // Reaching a gate on the way out is a door, not the entry queue.
    expect(goers.filter(left).length / goers.length).toBeGreaterThan(0.9);
    // Waiting is not staying: they get up once it thins out.
    expect(waiters.filter(left).length / waiters.length).toBeGreaterThan(0.9);
  });

  it('leaves fans already through the turnstile out of a gate jam', async () => {
    const movement = new FlowMovement();
    const sim = makeSim({ fans: 400, endAt: 600, movement });
    while (sim.ctx.t < 0) await sim.step();
    const { dots } = sim.ctx;
    const inside: number[] = [];
    for (let i = 0; i < dots.count; i++) if (movement.describe(i).admitted) inside.push(i);
    expect(inside.length).toBeGreaterThan(0);
    const before = inside.map((dot) => dots.targetPlace[dot]);
    for (const dot of inside) movement.onChoice(sim.ctx, dot, 'gate_jammed', 'try_other_gate');
    expect(inside.map((dot) => dots.targetPlace[dot])).toEqual(before);
  });

  it('walks officers to their post, then counts the people they help', async () => {
    const sim = makeSim({ fans: 400, endAt: 900 });
    const before = sim.officerStatus();
    expect(new Set(before.map((o) => o.state))).toEqual(new Set(['standby']));

    let sawEnRoute = false;
    while (!sim.done) {
      await sim.step();
      for (const o of sim.officerStatus()) {
        if (o.state === 'en_route') sawEnRoute = true;
        expect(map.cells[o.cell]).not.toBe('blocked');
      }
    }
    const after = sim.officerStatus();
    // Plan A sends six officers to the surging gate at the incident.
    expect(sawEnRoute).toBe(true);
    const posted = after.filter((o) => o.state === 'on_scene');
    expect(posted.length).toBe(6);
    expect(posted.every((o) => map.places[o.place]?.kind === 'gate')).toBe(true);
    expect(posted.reduce((n, o) => n + o.told, 0)).toBeGreaterThan(0);
  });

  it('redirects the whole queue when a gate shuts, not only the last 40 m', async () => {
    const sim = makeSim({ fans: 4000, startAt: -600, endAt: 0, planIndex: 2, incidentAt: -300 });
    let shut = -1;
    let farTargets = 0;
    while (!sim.done) {
      await sim.step();
      const stat = sim.gateStats().find((g) => !g.open);
      if (!stat) continue;
      shut = stat.place;
      if (sim.ctx.t < -300 + 60) continue;
      farTargets = 0;
      for (let i = 0; i < sim.ctx.dots.count; i++) {
        if (sim.ctx.dots.targetPlace[i] === shut && !sim['opts'].movement.describe!(i).admitted) farTargets++;
      }
      expect(farTargets).toBe(0);
    }
    expect(shut).toBeGreaterThanOrEqual(0);
  });

  it('enforces the gates: a shut gate passes nobody, and nobody gets in unscreened', async () => {
    // Plan C closes the surging gate at the incident, here while fans are still arriving.
    const sim = makeSim({ fans: 1200, endAt: 0, planIndex: 2, incidentAt: -1800 });
    const inBowl = (c: number) => map.cells[c] === 'stands' || map.cells[c] === 'concourse';
    const { dots } = sim.ctx;
    let openFlow = 0;
    while (!sim.done) {
      await sim.step();
      if (sim.ctx.t > -1800) openFlow = Math.max(openFlow, sim.gateStats().filter((g) => g.open).reduce((n, g) => n + g.inPerMin, 0));
      for (let i = 0; i < dots.count; i++) {
        if (dots.x[i]! < 0 || dots.stateOf(i) === 'gone') continue;
        const cell = Math.floor(dots.y[i]! / CELL_SIZE_M) * map.width + Math.floor(dots.x[i]! / CELL_SIZE_M);
        if (inBowl(cell)) expect(sim['opts'].movement.describe!(i).admitted).toBe(true);
      }
    }
    const stats = sim.gateStats();
    const shut = stats.filter((g) => !g.open);
    expect(shut.length).toBe(1);
    expect(shut[0]!.inPerMin).toBe(0);
    expect(shut[0]!.capacityPerMin).toBe(0);
    // The open gates kept passing people after it shut.
    expect(openFlow).toBeGreaterThan(0);
  });

  it('puts a fan through the turnstile on the far side of it', async () => {
    const movement = new FlowMovement();
    const sim = makeSim({ fans: 1200, startAt: -1800, endAt: -1500, movement });
    const { dots } = sim.ctx;
    const before = new Uint8Array(dots.count);
    let landed = 0;
    while (!sim.done) {
      for (let i = 0; i < dots.count; i++) before[i] = movement.describe(i).admitted ? 1 : 0;
      await sim.step();
      for (let i = 0; i < dots.count; i++) {
        if (before[i] === 1 || !movement.describe(i).admitted) continue;
        // Admitted this step: standing inside, not left behind the queue.
        const cell = Math.floor(dots.y[i]! / CELL_SIZE_M) * map.width + Math.floor(dots.x[i]! / CELL_SIZE_M);
        expect(['concourse', 'stands']).toContain(map.cells[cell]);
        landed++;
      }
    }
    expect(landed).toBeGreaterThan(0);
  });

  it('turns the fans parked nearest a gate into a late rush on it', () => {
    const movement = new FlowMovement();
    const sim = makeSim({ fans: 1200, movement });
    const gate = map.places.findIndex((p) => p.kind === 'gate');
    movement.lateRush(sim.ctx, gate, 50, -120, 60);
    const rushing = Array.from({ length: sim.ctx.dots.count }, (_, i) => i).filter(
      (i) => movement.describe(i).homeGate === gate && movement.describe(i).arriveAt >= -120 && movement.describe(i).arriveAt <= 60,
    );
    expect(rushing.length).toBeGreaterThanOrEqual(50);
    expect(rushing.every((i) => sim.ctx.dots.targetPlace[i] === gate)).toBe(true);
  });
});
