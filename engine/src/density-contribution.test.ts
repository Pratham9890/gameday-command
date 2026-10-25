import { describe, expect, it } from 'vitest';
import type { MapBundle, SimConfig, TrafficConfig } from '../../contracts.ts';
import { DECISION_DEFAULTS } from '../../brain/src/defaults.ts';
import { makePopulation } from '../../brain/src/fan-types.ts';
import { GAME_END_S, gameEnd, gateSurge, lightningDelay } from '../../world/src/incidents.ts';
import { makeOfficers } from '../../world/src/officers.ts';
import { buildStadiumMap, extractExists, loadExtract } from '../../world/src/osm/stadium.ts';
import { playbookFor } from '../../world/src/playbook.ts';
import { makeTestMap } from '../../world/src/test-map.ts';
import { DensityField } from './density.ts';
import { STATE_INDEX } from './dots.ts';
import { FlowMovement } from './movement-flow.ts';
import { Simulation } from './sim.ts';

/**
 * FlowMovement hands DensityField the per-cell counts it rebuilt anyway, so the
 * density pass can skip walking every dot. That shortcut is only sound if the
 * field it produces is identical to a full scan of `dots`, cell for cell, after
 * every step: while fans queue at a gate, sit down, shelter from lightning,
 * leave their seats at the whistle, or are put back by a rewind.
 *
 * Each case therefore runs two fields side by side: the sim's shortcut field
 * and a reference field fed the dots the slow way. Values are compared exactly;
 * floats here are computed from the same integer counts, so equality is not a
 * tolerance question.
 */
const haveMap = extractExists();
const stadium: MapBundle | null = haveMap ? buildStadiumMap(loadExtract()) : null;

const STADIUM_TRAFFIC: TrafficConfig = { vehicles: 250, seed: 77, emergencyResponse: false };

function simFor(opts: {
  runId: string;
  map: MapBundle;
  incident: SimConfig['incident'];
  startAt: number;
  endAt: number;
  fans: number;
  traffic?: TrafficConfig;
}): Simulation {
  const seed = 20251023;
  const config: SimConfig = {
    runId: opts.runId,
    label: 'A',
    seed,
    startAt: opts.startAt,
    endAt: opts.endAt,
    speed: 1000,
    dangerDensity: 4,
    mapId: opts.map.id,
    incident: opts.incident,
    plan: playbookFor(opts.incident.kind, opts.map)[0]!,
    officers: makeOfficers(opts.map, 12),
  };
  if (opts.traffic) config.traffic = opts.traffic;
  return new Simulation({
    config,
    map: opts.map,
    population: makePopulation(opts.fans, seed),
    defaults: DECISION_DEFAULTS,
    serverUrl: '',
    movement: new FlowMovement(),
    replay: { runId: opts.runId, answers: [] },
  });
}

const cellName = (width: number, cell: number): string =>
  `cell ${cell} (x ${cell % width}, y ${(cell / width) | 0})`;

/** The first exactly differing value, or null when the two fields agree everywhere. */
function firstDifference(actual: DensityField, expected: DensityField, t: number): string | null {
  const width = expected.width;
  const cells = width * expected.height;
  for (let cell = 0; cell < cells; cell++) {
    const counts = actual.counts[cell]!;
    if (counts !== expected.counts[cell]!) {
      return `sim second ${t}: counts at ${cellName(width, cell)} are ${counts}, full scan says ${expected.counts[cell]!}`;
    }
    const people = actual.peoplePerM2[cell]!;
    if (people !== expected.peoplePerM2[cell]!) {
      return `sim second ${t}: peoplePerM2 at ${cellName(width, cell)} are ${people}, full scan says ${expected.peoplePerM2[cell]!}`;
    }
    const standing = actual.standingPerM2[cell]!;
    if (standing !== expected.standingPerM2[cell]!) {
      return `sim second ${t}: standingPerM2 at ${cellName(width, cell)} are ${standing}, full scan says ${expected.standingPerM2[cell]!}`;
    }
  }
  if (actual.occupiedCount !== expected.occupiedCount) {
    return `sim second ${t}: occupiedCount is ${actual.occupiedCount}, full scan says ${expected.occupiedCount}`;
  }
  for (let k = 0; k < expected.occupiedCount; k++) {
    const cell = actual.occupied[k]!;
    if (cell !== expected.occupied[k]!) {
      return `sim second ${t}: occupied[${k}] is ${cellName(width, cell)}, full scan says ${cellName(width, expected.occupied[k]!)}`;
    }
  }
  return null;
}

function expectDensityMatches(sim: Simulation, reference: DensityField): void {
  expect(firstDifference(sim.ctx.density, reference, sim.ctx.t)).toBeNull();
}

/** Step, rebuild the reference the slow way, then compare. Nothing steps outside this. */
async function runChecked(
  sim: Simulation,
  reference: DensityField,
  steps: number,
  onStep?: (sim: Simulation) => void,
): Promise<void> {
  for (let i = 0; i < steps; i++) {
    await sim.step();
    reference.update(sim.ctx.dots);
    expectDensityMatches(sim, reference);
    onStep?.(sim);
  }
}

function countState(sim: Simulation, state: number): number {
  const { dots } = sim.ctx;
  let count = 0;
  for (let i = 0; i < dots.count; i++) if (dots.state[i] === state) count++;
  return count;
}

describe('the density shortcut matches a full scan', () => {
  it.skipIf(!haveMap)('through a gate surge with traffic on the stadium map', async () => {
    const map = stadium!;
    const sim = simFor({
      runId: 'density-surge-traffic',
      map,
      incident: gateSurge(map, 0),
      startAt: -120,
      endAt: 240,
      fans: 6_000,
      traffic: STADIUM_TRAFFIC,
    });
    const reference = DensityField.forMap(map);
    reference.update(sim.ctx.dots);
    expectDensityMatches(sim, reference);

    // Proves the run actually built a crowd at the surge gate, so the equality
    // below is not comparing two empty grids.
    let peak = 0;
    await runChecked(sim, reference, 360, (s) => {
      const { occupied, occupiedCount, peoplePerM2 } = s.ctx.density;
      for (let k = 0; k < occupiedCount; k++) {
        const cell = occupied[k]!;
        const value = peoplePerM2[cell]!;
        if (value > peak) peak = value;
      }
    });

    expect(sim.traffic).not.toBeNull();
    expect(peak).toBeGreaterThan(1.5);
  }, 120_000);

  it('through a lightning shelter order and the all-clear re-seating', async () => {
    const map = makeTestMap();
    const sim = simFor({
      runId: 'density-lightning',
      map,
      incident: lightningDelay(map, 0),
      startAt: -600,
      endAt: 1900,
      fans: 1200,
    });
    const reference = DensityField.forMap(map);
    reference.update(sim.ctx.dots);
    expectDensityMatches(sim, reference);

    // Stop one second before the strike: everyone who could be seated is.
    await runChecked(sim, reference, 599);
    expect(countState(sim, STATE_INDEX.seated)).toBeGreaterThan(0);

    // The plan shelters the bowl; thirty minutes later the all-clear puts the
    // sheltered fans back in seats. Both transitions are checked every step.
    const wasSheltering = new Uint8Array(sim.ctx.dots.count);
    let sheltered = false;
    let reseated = false;
    await runChecked(sim, reference, 1901, (s) => {
      const { dots } = s.ctx;
      for (let i = 0; i < dots.count; i++) {
        const state = dots.state[i]!;
        if (state === STATE_INDEX.sheltering) {
          wasSheltering[i] = 1;
          sheltered = true;
        } else if (state === STATE_INDEX.seated && wasSheltering[i] === 1) {
          reseated = true;
        }
      }
    });

    expect(sheltered).toBe(true);
    expect(reseated).toBe(true);
  }, 120_000);

  it('through the final whistle leaving the seats', async () => {
    const map = makeTestMap();
    const sim = simFor({
      runId: 'density-game-end',
      map,
      incident: gameEnd(map),
      startAt: GAME_END_S - 480,
      endAt: GAME_END_S + 600,
      fans: 1200,
    });
    const reference = DensityField.forMap(map);
    reference.update(sim.ctx.dots);
    expectDensityMatches(sim, reference);

    // One second before the whistle, with the bowl settled.
    await runChecked(sim, reference, 479);
    expect(countState(sim, STATE_INDEX.seated)).toBeGreaterThan(0);
    const wasSeated = new Uint8Array(sim.ctx.dots.count);
    for (let i = 0; i < sim.ctx.dots.count; i++) {
      if (sim.ctx.dots.state[i] === STATE_INDEX.seated) wasSeated[i] = 1;
    }

    let leftSeat = false;
    await runChecked(sim, reference, 601, (s) => {
      const { dots } = s.ctx;
      for (let i = 0; i < dots.count; i++) {
        if (wasSeated[i] === 1 && dots.state[i] !== STATE_INDEX.seated) leftSeat = true;
      }
    });

    expect(leftSeat).toBe(true);
  }, 120_000);

  it('through a rewind and a dropped fan edit', async () => {
    const map = makeTestMap();
    const sim = simFor({
      runId: 'density-rewind-edit',
      map,
      incident: gameEnd(map),
      startAt: GAME_END_S - 480,
      endAt: GAME_END_S + 240,
      fans: 1200,
    });
    const reference = DensityField.forMap(map);
    reference.update(sim.ctx.dots);
    expectDensityMatches(sim, reference);

    // Ten seconds after the whistle: the leavers are walking and the waiters
    // are still in their seats, so both a rewind and an edit have a crowd to
    // work with.
    await runChecked(sim, reference, 490);
    const point = sim.checkpoint();
    const parking = map.places.findIndex((place) => place.kind === 'parking');
    expect(parking).toBeGreaterThanOrEqual(0);

    let dot = -1;
    for (let i = 0; i < sim.ctx.dots.count; i++) {
      if (sim.ctx.dots.state[i] === STATE_INDEX.seated) {
        dot = i;
        break;
      }
    }
    expect(dot).toBeGreaterThanOrEqual(0);
    const wasTarget = sim.ctx.dots.targetPlace[dot]!;
    expect(wasTarget).not.toBe(parking);

    sim.queueEdit({ at: sim.ctx.t + 5, dots: [dot], sendTo: parking });
    await runChecked(sim, reference, 40);
    expect(sim.ctx.dots.targetPlace[dot]).toBe(parking);
    expect(sim.ctx.dots.state[dot]).not.toBe(STATE_INDEX.seated);

    // The same forty seconds with the edit forgotten must be identical to the
    // checkpoint's density, and the shortcut must still match the slow scan.
    sim.rewind(point);
    reference.update(sim.ctx.dots);
    expectDensityMatches(sim, reference);
    expect(sim.ctx.dots.targetPlace[dot]).toBe(wasTarget);
    sim.dropEditsAfter(sim.ctx.t);

    await runChecked(sim, reference, 40);
    expect(sim.ctx.dots.targetPlace[dot]).toBe(wasTarget);
    expect(sim.inspect(dot)?.edits).toBe(0);
  }, 120_000);
});
