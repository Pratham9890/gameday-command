import { describe, expect, it } from 'vitest';
import type { CellKind, MapBundle, Place, SimConfig } from '../../contracts.ts';
import { CONTRACT_VERSION } from '../../contracts.ts';
import { DECISION_DEFAULTS } from '../../brain/src/defaults.ts';
import { makePopulation } from '../../brain/src/fan-types.ts';
import { playbookFor } from '../../world/src/playbook.ts';
import { testGateSurge } from '../../world/src/incidents.ts';
import { makeOfficers } from '../../world/src/officers.ts';
import { FlowMovement } from './movement-flow.ts';
import { Simulation } from './sim.ts';

/**
 * A map the size of the real target: Ohio Stadium plus about half a mile is
 * roughly 1.6 km square, which is 800 cells at 2 m. Shaped like the test map so
 * the same playbook works: stands, concourse, a wall pierced by gates, a plaza,
 * then parking.
 */
function makeBigMap(size = 800, gateCount = 12): MapBundle {
  const wallRow = Math.floor(size * 0.25);
  const parkingRow = Math.floor(size * 0.7);
  const gateXs = Array.from({ length: gateCount }, (_, i) => Math.floor(((i + 0.5) * size) / gateCount));
  const gateSet = new Set(gateXs);

  const cells: CellKind[] = new Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let kind: CellKind;
      if (y < wallRow * 0.6) kind = 'stands';
      else if (y < wallRow) kind = 'concourse';
      else if (y === wallRow) kind = gateSet.has(x) ? 'walk' : 'blocked';
      else if (y < parkingRow) kind = 'walk';
      else kind = 'parking';
      cells[y * size + x] = kind;
    }
  }

  const rows = (from: number, to: number) => {
    const out: number[] = [];
    for (let y = from; y <= to; y++) for (let x = 0; x < size; x++) out.push(y * size + x);
    return out;
  };

  const gates: Place[] = gateXs.map((x, i) => ({
    id: `big-gate-${i}`,
    name: `Gate ${i + 1}`,
    kind: 'gate',
    cells: [wallRow * size + x],
    capacity: 10000,
    throughputPerMin: 600,
  }));

  return {
    version: CONTRACT_VERSION,
    id: 'big-perf',
    name: 'Perf map, stadium scale',
    width: size,
    height: size,
    cells,
    places: [
      ...gates,
      { id: 'big-stands', name: 'Stands', kind: 'seating', cells: rows(0, Math.floor(wallRow * 0.6) - 1), capacity: 110000 },
      { id: 'big-concourse', name: 'Concourse', kind: 'concourse', cells: rows(Math.floor(wallRow * 0.6), wallRow - 1), capacity: 40000 },
      { id: 'big-lots', name: 'Lots', kind: 'parking', cells: rows(parkingRow, size - 1), capacity: 110000 },
    ],
    closables: [
      ...gates.map((g, i) => ({ id: `big-gate-${i}-door`, name: `${g.name} door`, cells: g.cells })),
      { id: 'big-street', name: 'Lane Ave', cells: rows(parkingRow - 1, parkingRow - 1) },
    ],
    sources: [{ label: 'synthetic perf fixture', url: 'local' }],
  };
}

/**
 * Hand control back to the event loop now and then.
 *
 * With an empty tape every step resolves on the microtask queue, so a long run
 * never yields and Vitest's reporter RPC times out mid-test ("Timeout calling
 * onTaskUpdate"). The real worker yields between steps anyway, so this also
 * measures something closer to how it actually runs.
 */
const breathe = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const YIELD_EVERY = 250;

describe('engine throughput', () => {
  it('runs 20,000 dots at better than 10x real time in one worker', async () => {
    const bundle = makeBigMap();
    const fans = 100_000;
    const population = makePopulation(fans, 20251023);
    expect(population.dots).toBe(20_000);

    const plan = playbookFor('gate_surge', bundle)[0]!;
    const config: SimConfig = {
      runId: 'perf',
      label: 'A',
      seed: 20251023,
      startAt: -3600,
      endAt: 600,
      speed: 1000,
      dangerDensity: 4,
      mapId: bundle.id,
      incident: testGateSurge(bundle, 0),
      plan,
      officers: makeOfficers(bundle, 24),
    };

    const setupStart = performance.now();
    const sim = new Simulation({
      config,
      map: bundle,
      population,
      defaults: DECISION_DEFAULTS,
      serverUrl: '',
      movement: new FlowMovement(),
      // An empty tape stands in for a warm cache: answers resolve with no network.
      replay: { runId: 'perf', answers: [] },
    });
    const setupMs = performance.now() - setupStart;

    const steps = 300;
    const start = performance.now();
    for (let i = 0; i < steps; i++) {
      await sim.step();
      if (i % YIELD_EVERY === YIELD_EVERY - 1) await breathe();
    }
    const wallSeconds = (performance.now() - start) / 1000;
    const ratio = steps / wallSeconds;

    let onMap = 0;
    for (let i = 0; i < sim.ctx.dots.count; i++) if (sim.ctx.dots.x[i]! >= 0) onMap++;

    console.log(
      `perf: ${population.dots} dots (${fans.toLocaleString()} fans), ${onMap} on map, ` +
        `setup ${setupMs.toFixed(0)}ms, ${steps} sim s in ${wallSeconds.toFixed(2)}s = ${ratio.toFixed(1)}x real time`,
    );

    expect(onMap).toBeGreaterThan(1000);
    expect(ratio).toBeGreaterThan(10);
  }, 120_000);

  it('absorbs a lightning delay that asks every dot at once', async () => {
    const bundle = makeBigMap();
    const population = makePopulation(100_000, 20251023);
    // Shelter order plus a PA alert with no zone: both raise for every dot on the map.
    const plan = playbookFor('lightning_delay', bundle)[0]!;
    const incidentAt = -600;
    const config: SimConfig = {
      runId: 'perf-burst',
      label: 'A',
      seed: 20251023,
      startAt: -3600,
      endAt: 600,
      speed: 1000,
      dangerDensity: 4,
      mapId: bundle.id,
      incident: { id: 'inc-lightning', kind: 'lightning_delay', at: incidentAt, safeCount: 0, note: 'Lightning within 8 miles' },
      plan,
      officers: makeOfficers(bundle, 24),
    };

    let records = 0;
    let pauses = 0;
    let keysAsked = 0;
    const sim = new Simulation({
      config,
      map: bundle,
      population,
      defaults: DECISION_DEFAULTS,
      serverUrl: '',
      movement: new FlowMovement(),
      replay: { runId: 'perf-burst', answers: [] },
      emit: (out) => {
        if (out.type === 'decision') records++;
        if (out.type === 'deciding') {
          pauses++;
          keysAsked += out.pendingKeys;
        }
      },
    });

    // Walk the crowd to the stadium first; that part is already measured above.
    let warmed = 0;
    while (sim.ctx.t < incidentAt - 1) {
      await sim.step();
      if (++warmed % YIELD_EVERY === 0) await breathe();
    }

    const steps = 60;
    const start = performance.now();
    for (let i = 0; i < steps; i++) await sim.step();
    const wallSeconds = (performance.now() - start) / 1000;
    await breathe();

    console.log(
      `burst: ${records} decision records from ${keysAsked} distinct keys over ${pauses} pauses, ` +
        `${steps} sim s in ${wallSeconds.toFixed(2)}s = ${(steps / wallSeconds).toFixed(1)}x real time`,
    );

    expect(records).toBeGreaterThan(1000);
    expect(pauses).toBeGreaterThan(0);
    // Grouping is the whole point: thousands of dots must collapse to few keys.
    expect(keysAsked).toBeLessThan(records / 10);
    expect(steps / wallSeconds).toBeGreaterThan(10);
  }, 180_000);
});
