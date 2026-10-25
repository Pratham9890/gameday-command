import { describe, expect, it } from 'vitest';
import type { MapBundle, SimConfig, TrafficConfig, VehicleFrame } from '../../contracts.ts';
import { CELL_SIZE_M, VEHICLE_KINDS, VEHICLE_STATES } from '../../contracts.ts';
import { DECISION_DEFAULTS } from '../../brain/src/defaults.ts';
import { makePopulation } from '../../brain/src/fan-types.ts';
import { GAME_END_S, gateSurge, suspiciousPackage } from '../../world/src/incidents.ts';
import { makeOfficers } from '../../world/src/officers.ts';
import { buildStadiumMap, extractExists, loadExtract } from '../../world/src/osm/stadium.ts';
import { playbookFor } from '../../world/src/playbook.ts';
import { VEHICLE_TYPES } from '../../world/src/vehicles.ts';
import { CLEAR_SKY } from '../../world/src/weather.ts';
import { makeTestMap } from '../../world/src/test-map.ts';
import { DensityField } from './density.ts';
import { DotStore } from './dots.ts';
import { FlowMovement } from './movement-flow.ts';
import { Simulation } from './sim.ts';
import { roadNetFor, TrafficModel } from './traffic.ts';

/**
 * Traffic needs real streets, so these run on the stadium map. The test map is
 * a gate wall and a lot with no road between them.
 */
const haveMap = extractExists();
const map: MapBundle | null = haveMap ? buildStadiumMap(loadExtract()) : null;

const TRAFFIC: TrafficConfig = { vehicles: 1500, seed: 77, emergencyResponse: true };
const population = makePopulation(20_000, 20251023);

function make(config: Partial<SimConfig> & { incident: SimConfig['incident'] }) {
  const m = map!;
  const full: SimConfig = {
    runId: 'traffic',
    label: 'A',
    seed: 20251023,
    startAt: -3600,
    endAt: -3600 + 240,
    speed: 1000,
    dangerDensity: 4,
    mapId: m.id,
    plan: playbookFor(config.incident.kind, m)[1]!,
    officers: makeOfficers(m, 12),
    ...config,
  };
  return new Simulation({
    config: full,
    map: m,
    population,
    defaults: DECISION_DEFAULTS,
    serverUrl: '',
    movement: new FlowMovement(),
    replay: { runId: full.runId, answers: [] },
  });
}

async function run(sim: Simulation) {
  while (!sim.done) await sim.step();
}

const sameVehicles = (a: VehicleFrame, b: VehicleFrame) =>
  a.x.every((v, i) => v === b.x[i]) && a.y.every((v, i) => v === b.y[i]) && a.state.every((v, i) => v === b.state[i]);

describe.skipIf(!haveMap)('vehicle traffic on the stadium map', () => {
  it('lays out stalls and entry points from the real streets', () => {
    const net = roadNetFor(map!);
    expect(net.stallX.length).toBeGreaterThan(2500);
    expect(net.entries.length).toBeGreaterThan(10);
  });

  it('clears a closed street, keeps vehicles out, and still lets traffic leave', () => {
    const m = map!;
    const traffic = new TrafficModel({ map: m, config: { ...TRAFFIC, vehicles: 300, emergencyResponse: false },
      population, incident: gateSurge(m, 0), startAt: GAME_END_S, endAt: GAME_END_S + 1200, gameEndAt: GAME_END_S });
    const input = { dt: 1, weather: CLEAR_SKY, density: DensityField.forMap(m), dots: new DotStore(0) };
    for (let t = GAME_END_S; t < GAME_END_S + 600; t++) traffic.step({ ...input, t, closed: new Set() });
    const before = traffic.frame();
    const occupied = new Set<number>();
    for (let i = 0; i < before.x.length; i++) {
      if (VEHICLE_STATES[before.state[i]!] !== 'driving') continue;
      occupied.add(Math.floor(before.y[i]! / CELL_SIZE_M) * m.width + Math.floor(before.x[i]! / CELL_SIZE_M));
    }
    const street = m.closables.find((c) => c.id.startsWith('street-') && c.cells.some((cell) => occupied.has(cell)))!;
    expect(street).toBeDefined();
    const closed = new Set([street.id]);
    const cells = new Set(street.cells);
    const outBefore = traffic.metrics().out;
    let violations = 0;
    for (let t = GAME_END_S + 600; t < GAME_END_S + 900; t++) {
      traffic.step({ ...input, t, closed });
      if (t < GAME_END_S + 660) continue;
      const frame = traffic.frame();
      for (let i = 0; i < frame.x.length; i++) {
        if (frame.x[i]! < 0 || frame.y[i]! < 0) continue;
        const cell = Math.floor(frame.y[i]! / CELL_SIZE_M) * m.width + Math.floor(frame.x[i]! / CELL_SIZE_M);
        if (cells.has(cell)) violations++;
      }
    }
    expect(violations).toBe(0);
    expect(traffic.metrics().out).toBeGreaterThan(outBefore);
  });

  it('never moves a single fan: the crowd is identical with traffic on', async () => {
    const incident = gateSurge(map!, 0);
    const plain = make({ incident });
    const busy = make({ incident, traffic: TRAFFIC });
    await run(plain);
    await run(busy);
    const a = plain.frame();
    const b = busy.frame();
    expect(b.vehicles).toBeDefined();
    expect(a.x.every((v, i) => v === b.x[i])).toBe(true);
    expect(a.y.every((v, i) => v === b.y[i])).toBe(true);
    const { vehicleDelayMin, peakVehiclesStopped, vehiclesOut, emergencyResponseMin, ...crowd } = busy.scorecard();
    void vehicleDelayMin, peakVehiclesStopped, vehiclesOut, emergencyResponseMin;
    expect(crowd).toEqual(plain.scorecard());
  }, 120_000);

  it('is deterministic, and parks and drives real-sized vehicles', async () => {
    const incident = gateSurge(map!, 0);
    const one = make({ incident, traffic: TRAFFIC });
    const two = make({ incident, traffic: TRAFFIC });
    await run(one);
    await run(two);
    const a = one.frame().vehicles!;
    const b = two.frame().vehicles!;
    expect(sameVehicles(a, b)).toBe(true);

    const states = new Set([...a.state].map((s) => VEHICLE_STATES[s]));
    expect(states.has('parked')).toBe(true);
    expect([...states].some((s) => s === 'driving' || s === 'parking' || s === 'stopped')).toBe(true);
    const kinds = new Set([...a.kind].map((k) => VEHICLE_KINDS[k]));
    expect(kinds.has('bus') || kinds.has('rv')).toBe(true);
    expect(VEHICLE_TYPES.bus.lengthM).toBeGreaterThan(VEHICLE_TYPES.sedan.lengthM * 2);
  }, 120_000);

  it('rewinds vehicles exactly with the rest of the run', async () => {
    const incident = gateSurge(map!, 0);
    const sim = make({ incident, traffic: TRAFFIC });
    for (let i = 0; i < 100; i++) await sim.step();
    const point = sim.checkpoint();
    await run(sim);
    const first = sim.frame().vehicles!;
    const firstCard = sim.scorecard();
    sim.rewind(point);
    await run(sim);
    expect(sameVehicles(first, sim.frame().vehicles!)).toBe(true);
    expect(sim.scorecard()).toEqual(firstCard);
  }, 120_000);

  it('empties the lots after the final whistle and sends an ambulance', async () => {
    const incident = suspiciousPackage(map!);
    const sim = make({ incident, traffic: TRAFFIC, startAt: GAME_END_S - 60, endAt: GAME_END_S + 900 });
    await run(sim);
    const card = sim.scorecard();
    expect(card.vehiclesOut).toBeGreaterThan(50);
    expect(card.emergencyResponseMin).not.toBeUndefined();
    expect(card.emergencyResponseMin === null || card.emergencyResponseMin! > 0.2).toBe(true);
    expect(card.peakVehiclesStopped).toBeGreaterThan(0);
  }, 120_000);
});

describe('vehicle closure boundaries', () => {
  const W = 31;
  const H = 15;
  const cells: MapBundle['cells'] = Array.from({ length: W * H }, (_, c) =>
    c % W >= 23 && Math.floor(c / W) >= 4 && Math.floor(c / W) <= 10 ? 'parking' : 'road');
  const bundle: MapBundle = { ...makeTestMap(), width: W, height: H, cells,
    places: [{ id: 'lot', name: 'Lot', kind: 'parking', capacity: 100,
      cells: cells.flatMap((kind, c) => kind === 'parking' ? [c] : []) }],
    closables: [{ id: 'barrier', name: 'Barrier', cells: Array.from({ length: H }, (_, y) => y * W + 15) },
      { id: 'border', name: 'Border', cells: cells.flatMap((_, c) =>
        c % W === 0 || c % W === W - 1 || c < W || c >= W * (H - 1) ? [c] : []) },
      { id: 'scene', name: 'Scene', cells: cells.flatMap((_, c) =>
        c % W >= 12 && c % W <= 18 && Math.floor(c / W) >= 4 && Math.floor(c / W) <= 10 ? [c] : []) }] };

  function setup(emergencyResponse = false, m = bundle) {
    const traffic = new TrafficModel({ map: m, config: { vehicles: 1, seed: 77, emergencyResponse },
      population, incident: { ...gateSurge(makeTestMap(), 0), cells: [7 * W + 15], placeId: undefined },
      startAt: -10000, endAt: 1000 });
    const input = { t: 0, dt: 1, weather: CLEAR_SKY, density: DensityField.forMap(m), dots: new DotStore(0) };
    return { traffic, input };
  }

  it.each([false, true])('waits outside closed entry roads and spawns after reopening (EMS=%s)', (ems) => {
    const { traffic, input } = setup(ems);
    const saved = traffic.capture() as { arriveT: Float32Array };
    saved.arriveT[0] = -1;
    traffic.restore(saved);
    traffic.step({ ...input, closed: new Set(['border']) });
    expect([...traffic.frame().state].every((s) => VEHICLE_STATES[s] === 'waiting')).toBe(true);
    traffic.step({ ...input, t: 1, closed: new Set() });
    expect(VEHICLE_STATES[traffic.frame().state[0]!]).toBe('driving');
    if (ems) expect(VEHICLE_STATES[traffic.frame().state[traffic.ambulance]!]).toBe('responding');
  });

  it.each([['inbound', 1], ['outbound', 4], ['EMS', 5]] as const)('keeps %s traffic out of a closure and resumes after reopening', (_, mode) => {
    const { traffic, input } = setup(mode === 5);
    const saved = traffic.capture() as { hx: Float32Array; hy: Float32Array; mode: Uint8Array; speed: Float32Array; heading: Float32Array };
    saved.hx[0] = 21;
    saved.hy[0] = 15;
    saved.heading[0] = 0;
    saved.mode[0] = mode;
    saved.speed[0] = 10;
    traffic.restore(saved);
    traffic.step({ ...input, dt: 0, closed: new Set() });
    // The barrier isolates the lot; closed borders must not provide an escape
    // through a closed destination when the inbound field becomes unreachable.
    const closed = new Set(mode === 5 ? ['scene'] : ['border', 'barrier']);
    const closedCells = new Set(bundle.closables.filter((c) => closed.has(c.id)).flatMap((c) => c.cells));
    for (let t = 0; t < 10; t++) {
      traffic.step({ ...input, t, closed });
      const state = traffic.capture() as { hx: Float32Array; hy: Float32Array };
      const cell = Math.floor(state.hy[0]! / CELL_SIZE_M) * W + Math.floor(state.hx[0]! / CELL_SIZE_M);
      expect(closedCells.has(cell)).toBe(false);
      expect(VEHICLE_STATES[traffic.frame().state[0]!]).not.toBe('gone');
    }
    const before = traffic.frame();
    for (let t = 10; t < 30; t++) traffic.step({ ...input, t, closed: new Set() });
    const after = traffic.frame();
    expect([after.x[0], after.y[0], after.state[0]]).not.toEqual([before.x[0], before.y[0], before.state[0]]);
  });

  it('reroutes inbound traffic around a new barricade and still reaches its lot', () => {
    const barrier = { ...bundle.closables[0]!, cells: bundle.closables[0]!.cells.filter((c) => c >= W * 3) };
    const m = { ...bundle, closables: [barrier] };
    const { traffic, input } = setup(false, m);
    const saved = traffic.capture() as { hx: Float32Array; hy: Float32Array; mode: Uint8Array };
    saved.hx[0] = 21;
    saved.hy[0] = 15;
    saved.mode[0] = 1;
    traffic.restore(saved);
    traffic.step({ ...input, dt: 0, closed: new Set() });
    const closed = new Set([barrier.id]);
    const blocked = new Set(barrier.cells);
    const mask = roadNetFor(m).mask;
    for (let t = 1; t < 60; t++) {
      traffic.step({ ...input, t, closed });
      const state = traffic.capture() as { hx: Float32Array; hy: Float32Array };
      const cell = Math.floor(state.hy[0]! / CELL_SIZE_M) * W + Math.floor(state.hx[0]! / CELL_SIZE_M);
      expect(blocked.has(cell)).toBe(false);
      expect([1, 2, 3]).toContain(mask[cell]);
    }
    expect(VEHICLE_STATES[traffic.frame().state[0]!]).toBe('parked');
  });

  it.each([1, 4])('does not drive a parking maneuver across a newly closed cell with dt=%s', (dt) => {
    const { traffic, input } = setup();
    const saved = traffic.capture() as { hx: Float32Array; hy: Float32Array; mode: Uint8Array; targetX: Float32Array; targetY: Float32Array };
    saved.hx[0] = 29;
    saved.hy[0] = 15;
    saved.mode[0] = 2;
    saved.targetX[0] = 33;
    saved.targetY[0] = 15;
    traffic.restore(saved);
    traffic.step({ ...input, dt, closed: new Set(['barrier']) });
    const state = traffic.capture() as { hx: Float32Array };
    expect(state.hx[0]).toBeLessThan(30);
  });
});
