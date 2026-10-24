import { describe, expect, it } from 'vitest';
import type { MapBundle, SimConfig, TrafficConfig, VehicleFrame } from '../../contracts.ts';
import { VEHICLE_KINDS, VEHICLE_STATES } from '../../contracts.ts';
import { DECISION_DEFAULTS } from '../../brain/src/defaults.ts';
import { makePopulation } from '../../brain/src/fan-types.ts';
import { GAME_END_S, gateSurge, suspiciousPackage } from '../../world/src/incidents.ts';
import { makeOfficers } from '../../world/src/officers.ts';
import { buildStadiumMap, extractExists, loadExtract } from '../../world/src/osm/stadium.ts';
import { playbookFor } from '../../world/src/playbook.ts';
import { VEHICLE_TYPES } from '../../world/src/vehicles.ts';
import { FlowMovement } from './movement-flow.ts';
import { Simulation } from './sim.ts';
import { roadNetFor } from './traffic.ts';

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
