import { describe, expect, it } from 'vitest';
import { CELL_SIZE_M } from '../../contracts.ts';
import { DECISION_DEFAULTS } from '../../brain/src/defaults.ts';
import { makePopulation } from '../../brain/src/fan-types.ts';
import { makeTestMap } from '../../world/src/test-map.ts';
import { testGateSurge } from '../../world/src/incidents.ts';
import { FlowFields } from './flowfield.ts';
import { FlowMovement, MAX_DOTS_PER_CELL } from './movement-flow.ts';
import { Simulation } from './sim.ts';

function make(startAt: number, fans = 600, late = 0, map = makeTestMap()) {
  const population = makePopulation(fans, 42);
  population.types = population.types.map((type) => ({ ...type, arrivalWindowMin: [60, -late] }));
  const movement = new FlowMovement();
  const sim = new Simulation({ map, population, movement, defaults: DECISION_DEFAULTS, serverUrl: '',
    replay: { runId: 'exit', answers: [] },
    config: { runId: 'exit', label: 'A', seed: 42, startAt, endAt: 16000, speed: 1000, dangerDensity: 4, mapId: map.id,
      incident: testGateSurge(map, 20000), officers: [],
      plan: { id: 'empty', name: 'Empty', forIncident: 'gate_surge', officersAvailable: 0, actions: [] } } });
  return { sim, movement, map };
}

const cellOf = (sim: Simulation, i: number) => Math.floor(sim.ctx.dots.y[i]! / CELL_SIZE_M) * sim.ctx.map.width + Math.floor(sim.ctx.dots.x[i]! / CELL_SIZE_M);

describe('exit orders', () => {
  it('starts late runs in assigned seats without overfilling cells, and restores them', async () => {
    const { sim, movement } = make(12300, 800);
    const counts = new Map<number, number>();
    for (let i = 0; i < sim.ctx.dots.count; i++) {
      expect(sim.ctx.dots.stateOf(i)).toBe('seated');
      const info = movement.describe(i);
      expect(info.admitted).toBe(true);
      expect(info.arriveAt).toBeLessThan(sim.ctx.t);
      expect(cellOf(sim, i)).toBe(info.seatCell);
      counts.set(info.seatCell, (counts.get(info.seatCell) ?? 0) + 1);
    }
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(MAX_DOTS_PER_CELL);
    const checkpoint = sim.checkpoint();
    movement.onChoice(sim.ctx, 0, 'exit_route', 'wait_in_seat');
    await sim.step();
    sim.rewind(checkpoint);
    expect(movement.capture()).toEqual(checkpoint.movement);
  });

  it('rebuilds open routes after rewinding a closed gate', async () => {
    const { sim, movement, map } = make(12300, 5);
    const gate = map.places[0]!.cells[0]!;
    const checkpoint = sim.checkpoint();
    const fields = (movement as unknown as { fields: FlowFields }).fields;
    sim.ctx.closed.add(map.closables[0]!.id);
    await sim.step();
    expect(fields.isClosed(gate)).toBe(true);

    sim.rewind(checkpoint);
    expect(sim.ctx.closed.size).toBe(0);
    await sim.step();
    expect(fields.isClosed(gate)).toBe(false);
  });

  it('keeps a blocked fan on their chosen gate for 30 seconds and restores the wait', async () => {
    const { sim, movement, map } = make(12300, 200);
    const { dots } = sim.ctx;
    const fan = Array.from({ length: dots.count }, (_, i) => i).find((i) => movement.describe(i).homeGate !== 1)!;
    const neighbours = [-map.width - 1, -map.width, -map.width + 1, -1, 1, map.width - 1, map.width, map.width + 1];
    const centre = map.width + 10;
    const blockers = Array.from({ length: dots.count }, (_, i) => i).filter((i) => i !== fan);
    dots.x[fan] = 21;
    dots.y[fan] = 3;
    blockers.forEach((dot, i) => {
      if (i >= neighbours.length * MAX_DOTS_PER_CELL) {
        dots.setState(dot, 'gone');
        return;
      }
      const cell = centre + neighbours[Math.floor(i / MAX_DOTS_PER_CELL)]!;
      // Standing, not seated: seated fans leave the aisle free, so only a
      // standing crowd hems someone in. Sheltering fans stand still.
      dots.setState(dot, 'sheltering');
      dots.x[dot] = ((cell % map.width) + 0.5) * CELL_SIZE_M;
      dots.y[dot] = (Math.floor(cell / map.width) + 0.5) * CELL_SIZE_M;
    });
    sim.ctx.density.update(dots);
    movement.onChoice(sim.ctx, fan, 'exit_route', 'my_gate');
    const chosen = dots.targetPlace[fan]!;
    expect(chosen).not.toBe(1);
    for (let t = 0; t < 15; t++) await sim.step();
    expect(dots.targetPlace[fan]).toBe(chosen);

    const checkpoint = sim.checkpoint();
    for (let t = 0; t < 16; t++) await sim.step();
    expect(dots.targetPlace[fan]).toBe(1);
    sim.rewind(checkpoint);
    for (let t = 0; t < 14; t++) await sim.step();
    expect(dots.targetPlace[fan]).toBe(chosen);
    for (let t = 0; t < 2; t++) await sim.step();
    expect(dots.targetPlace[fan]).toBe(1);
  });

  it('finds the smallest containing parking place without scanning it per release', async () => {
    const map = makeTestMap();
    const named = { ...map.places[5]!, id: 'named-lot', cells: [...map.places[5]!.cells] };
    map.places[5] = { ...map.places[5]!, id: 'all-lots', cells: [...named.cells, ...Array.from({ length: map.width }, (_, x) => 4 * map.width + x)] };
    map.places.push(named);
    const { sim, movement } = make(-600, 800, 30, map);
    const namedCells = new Set(named.cells);
    const lotCells = (movement.capture() as { lotCell: Int32Array }).lotCell;
    let fan = -1;
    while (sim.ctx.t < 0 && fan < 0) {
      await sim.step();
      fan = Array.from({ length: sim.ctx.dots.count }, (_, i) => i).find((i) =>
        sim.ctx.dots.stateOf(i) !== 'arriving' && !movement.describe(i).admitted && namedCells.has(lotCells[i]!)) ?? -1;
    }
    expect(fan).toBeGreaterThanOrEqual(0);
    const parking = map.places.filter((place) => place.kind === 'parking');
    const includes = parking.map((place) => place.cells.includes);
    parking.forEach((place) => { place.cells.includes = () => { throw new Error('release scanned parking cells'); }; });
    try {
      movement.onChoice(sim.ctx, fan, 'exit_route', 'wait_in_seat');
    } finally {
      parking.forEach((place, i) => { place.cells.includes = includes[i]!; });
    }
    expect(sim.ctx.dots.targetPlace[fan]).toBe(map.places.indexOf(named));
  });

  it('can begin a slow detour inside its current cell when the forward cells are full', () => {
    const { sim, movement, map } = make(12300, 65);
    const { dots, density } = sim.ctx;
    dots.x[0] = 7;
    dots.y[0] = 1.99;
    movement.onChoice(sim.ctx, 0, 'exit_route', 'nearest_exit');
    for (let i = 1; i < dots.count; i++) {
      const x = 2 + Math.floor((i - 1) / MAX_DOTS_PER_CELL);
      dots.x[i] = (x + 0.5) * CELL_SIZE_M;
      dots.y[i] = 3;
    }
    density.peoplePerM2.fill(5);
    for (let t = 0; t < 200; t++) { movement.step(sim.ctx, 1); sim.ctx.t++; }
    expect(cellOf(sim, 0), 'must escape the cell above the full row').not.toBe(3);
    expect(map.cells[cellOf(sim, 0)]).not.toBe('blocked');
  });

  it('walks out of interior walk cells instead of treating them as an exterior dead end', async () => {
    const map = makeTestMap();
    const cell = 5;
    map.cells[cell] = 'walk';
    const { sim, movement } = make(12300, 5, 0, map);
    sim.ctx.dots.x[0] = (cell + 0.5) * CELL_SIZE_M;
    sim.ctx.dots.y[0] = 0.5 * CELL_SIZE_M;
    movement.onChoice(sim.ctx, 0, 'exit_route', 'nearest_exit');
    for (let t = 0; t < 300; t++) await sim.step();
    expect(sim.ctx.dots.stateOf(0)).toBe('gone');
  });

  it('avoids an open gate whose outside approach has no route to parking', async () => {
    const map = makeTestMap();
    map.cells[4 * map.width + 17] = 'blocked';
    const { sim, movement } = make(12300, 5, 0, map);
    sim.ctx.dots.x[0] = 35;
    sim.ctx.dots.y[0] = 3;
    movement.onChoice(sim.ctx, 0, 'exit_route', 'nearest_exit');
    expect(sim.ctx.dots.targetPlace[0]).not.toBe(2);
    for (let t = 0; t < 300; t++) await sim.step();
    expect(sim.ctx.dots.stateOf(0)).toBe('gone');
  });

  it('reroutes admitted fans when their chosen exit shuts', async () => {
    const { sim, movement, map } = make(12300, 5);
    movement.onChoice(sim.ctx, 0, 'exit_route', 'my_gate');
    const target = sim.ctx.dots.targetPlace[0]!;
    const gate = map.places[target]!;
    sim.ctx.closed.add(map.closables.find((c) => c.cells.some((cell) => gate.cells.includes(cell)))!.id);
    await sim.step();
    expect(sim.ctx.dots.targetPlace[0]).not.toBe(target);
    for (let t = 0; t < 300; t++) await sim.step();
    expect(sim.ctx.dots.stateOf(0)).toBe('gone');
  });

  it.each(['nearest_exit', 'my_gate', 'wait_in_seat'])('lets sheltering fans leave with %s', async (option) => {
    const { sim, movement } = make(12300, 5);
    movement.onChoice(sim.ctx, 0, 'lightning_shelter', 'go_concourse');
    while (sim.ctx.t < 12400) await sim.step();
    expect(sim.ctx.dots.stateOf(0)).toBe('sheltering');
    movement.onChoice(sim.ctx, 0, 'exit_route', option);
    if (option === 'wait_in_seat') {
      while (sim.ctx.t < 12500) await sim.step();
      expect(sim.ctx.dots.stateOf(0)).toBe('sheltering');
    }
    while (sim.ctx.t < 14200) await sim.step();
    expect(sim.ctx.dots.stateOf(0)).toBe('gone');
  });

  it('uses the latest arrival endpoint plus an hour, including arrivals after kickoff', () => {
    const early = make(5399, 600, 30);
    const late = make(5400, 600, 30);
    expect(early.sim.snapshot().rngState).toEqual(late.sim.snapshot().rngState);
    expect(early.sim.ctx.dots.typeIndex).toEqual(late.sim.ctx.dots.typeIndex);
    for (let i = 0; i < early.sim.ctx.dots.count; i++) {
      expect(early.movement.describe(i).homeGate).toBe(late.movement.describe(i).homeGate);
      expect(early.movement.describe(i).arriveAt).toBe(late.movement.describe(i).arriveAt);
    }
    expect(early.sim.ctx.dots.stateOf(0)).toBe('arriving');
    expect(late.sim.ctx.dots.stateOf(0)).toBe('seated');
  });

  it('returns walking and queued outsiders to their cars while admitted fans leave through gates', async () => {
    const { sim, movement, map } = make(-600, 800, 30);
    while (sim.ctx.t < -450) await sim.step();
    const { dots } = sim.ctx;
    const shelter = Array.from({ length: dots.count }, (_, i) => i).find((i) => dots.stateOf(i) === 'seated')!;
    expect(shelter).toBeDefined();
    movement.onChoice(sim.ctx, shelter, 'lightning_shelter', 'go_concourse');
    while (dots.stateOf(shelter) !== 'sheltering' && sim.ctx.t < -400) await sim.step();
    expect(dots.stateOf(shelter)).toBe('sheltering');

    const seated: number[] = [];
    const admittedWalking: number[] = [];
    const walkingOutside: number[] = [];
    const queuedOutside: number[] = [];
    const sheltering: number[] = [];
    const arriving: number[] = [];
    for (let i = 0; i < dots.count; i++) {
      if (dots.stateOf(i) === 'arriving') { arriving.push(i); continue; }
      if (dots.stateOf(i) === 'seated') seated.push(i);
      else if (dots.stateOf(i) === 'sheltering') sheltering.push(i);
      else if (movement.describe(i).admitted) admittedWalking.push(i);
      else if (dots.stateOf(i) === 'walking') walkingOutside.push(i);
      else if (dots.stateOf(i) === 'queued') queuedOutside.push(i);
    }
    for (const [state, group] of Object.entries({ seated, admittedWalking, walkingOutside, queuedOutside, sheltering, arriving })) {
      expect(group.length, `${state} at release`).toBeGreaterThan(0);
    }
    for (const i of seated) movement.onChoice(sim.ctx, i, 'exit_route', 'nearest_exit');
    for (const i of admittedWalking) movement.onChoice(sim.ctx, i, 'exit_route', 'my_gate');
    for (const i of walkingOutside) movement.onChoice(sim.ctx, i, 'exit_route', 'wait_in_seat');
    for (const i of queuedOutside) movement.onChoice(sim.ctx, i, 'exit_route', 'nearest_exit');
    for (const i of sheltering) movement.onChoice(sim.ctx, i, 'exit_route', 'nearest_exit');
    const outside = [...walkingOutside, ...queuedOutside];
    expect(outside.every((i) => !movement.describe(i).admitted)).toBe(true);
    const checkpoint = sim.checkpoint();
    movement.sendTo(sim.ctx, outside[0]!, 0);
    sim.rewind(checkpoint);
    const officer = { id: 'exit-officer', unit: 'Test officer', cell: map.places[0]!.cells[0]!, radiusCells: 100, speedMps: 2 };
    sim.ctx.officers.push(officer);
    sim.ctx.officerPost.set(officer.id, 0);
    for (const dot of outside) movement.onChoice(sim.ctx, dot, 'officer_instruction', 'follow');
    let outFlow = 0;
    let enteredBowl = 0;
    const gateCells = new Set(map.places.filter((p) => p.kind === 'gate').flatMap((p) => p.cells));
    const seatedThroughGate = new Set<number>();
    while (sim.ctx.t < 3600) {
      await sim.step();
      outFlow += sim.gateStats().reduce((n, g) => n + g.outPerMin, 0);
      for (const i of seated) if (gateCells.has(cellOf(sim, i))) seatedThroughGate.add(i);
      for (const i of outside) {
        const kind = map.cells[cellOf(sim, i)];
        if (kind === 'stands' || kind === 'concourse') enteredBowl++;
      }
    }
    expect(enteredBowl).toBe(0);
    expect(outside.every((i) => dots.stateOf(i) === 'gone')).toBe(true);
    expect(seatedThroughGate.size).toBe(seated.length);
    for (const [state, group] of Object.entries({ seated, admittedWalking, walkingOutside, queuedOutside, sheltering })) {
      expect(group.every((i) => dots.stateOf(i) === 'gone'), `${state} got home`).toBe(true);
    }
    expect(outFlow).toBeGreaterThan(0);
    expect(arriving.some((i) => movement.describe(i).admitted)).toBe(true);
  });
});
