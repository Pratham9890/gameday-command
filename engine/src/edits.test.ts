import { describe, expect, it } from 'vitest';
import type { SimConfig } from '../../contracts.ts';
import { DECISION_DEFAULTS } from '../../brain/src/defaults.ts';
import { makePopulation } from '../../brain/src/fan-types.ts';
import { makeTestMap } from '../../world/src/test-map.ts';
import { playbookFor } from '../../world/src/playbook.ts';
import { testGateSurge } from '../../world/src/incidents.ts';
import { makeOfficers } from '../../world/src/officers.ts';
import { FlowMovement } from './movement-flow.ts';
import { STATE_INDEX } from './dots.ts';
import { Simulation } from './sim.ts';

const map = makeTestMap();
const SEED = 4242;

function makeSim(runId: string): Simulation {
  const config: SimConfig = {
    runId,
    label: 'A',
    seed: SEED,
    startAt: -600,
    endAt: 300,
    speed: 1000,
    dangerDensity: 4,
    mapId: map.id,
    incident: testGateSurge(map, 0),
    plan: playbookFor('gate_surge', map)[0]!,
    officers: makeOfficers(map, 12),
  };
  return new Simulation({
    config,
    map,
    population: makePopulation(1200, SEED),
    defaults: DECISION_DEFAULTS,
    serverUrl: '',
    movement: new FlowMovement(),
    replay: { runId, answers: [] },
  });
}

const steps = async (sim: Simulation, n: number) => {
  for (let i = 0; i < n; i++) await sim.step();
};

/** A dot that is on the map and walking, so an edit has something to change. */
function walkingDot(sim: Simulation): number {
  const { dots } = sim.ctx;
  for (let i = 0; i < dots.count; i++) if (dots.x[i]! >= 0 && dots.state[i] === STATE_INDEX.walking) return i;
  throw new Error('no walking dot');
}

const parking = map.places.findIndex((p) => p.kind === 'parking');

describe('commander edits', () => {
  it('changes a fan type at the sim second asked for, not before', async () => {
    const sim = makeSim('edit-type');
    await steps(sim, 120);
    const dot = walkingDot(sim);
    const was = sim.ctx.dots.typeIndex[dot]!;
    const to = (was + 1) % sim.ctx.population.types.length;
    const version = sim.typesVersion;

    sim.queueEdit({ at: sim.ctx.t + 5, dots: [dot], fanType: to });
    await steps(sim, 4);
    expect(sim.ctx.dots.typeIndex[dot]).toBe(was);
    await steps(sim, 1);
    expect(sim.ctx.dots.typeIndex[dot]).toBe(to);
    expect(sim.typesVersion).toBeGreaterThan(version);
  });

  it('sends a group somewhere else', async () => {
    const sim = makeSim('edit-send');
    await steps(sim, 120);
    const dot = walkingDot(sim);
    sim.queueEdit({ at: sim.ctx.t, dots: [dot], sendTo: parking });
    await steps(sim, 1);
    expect(sim.ctx.dots.targetPlace[dot]).toBe(parking);
    expect(sim.inspect(dot)?.edits).toBe(1);
  });

  it('replays an edit when the run is rewound to before it', async () => {
    const sim = makeSim('edit-rewind');
    await steps(sim, 120);
    const point = sim.checkpoint();
    const dot = walkingDot(sim);
    sim.queueEdit({ at: sim.ctx.t + 10, dots: [dot], sendTo: parking });
    await steps(sim, 60);
    const expectedX = Array.from(sim.ctx.dots.x);
    const expectedTargets = Array.from(sim.ctx.dots.targetPlace);

    sim.rewind(point);
    await steps(sim, 60);
    expect(Array.from(sim.ctx.dots.targetPlace)).toEqual(expectedTargets);
    expect(Array.from(sim.ctx.dots.x)).toEqual(expectedX);
  });

  it('forgets an edit when the run is rewound past it', async () => {
    const plain = makeSim('edit-none');
    await steps(plain, 180);

    const sim = makeSim('edit-dropped');
    await steps(sim, 120);
    const point = sim.checkpoint();
    sim.queueEdit({ at: sim.ctx.t + 10, dots: [walkingDot(sim)], sendTo: parking });
    await steps(sim, 30);
    sim.rewind(point);
    sim.dropEditsAfter(sim.ctx.t);
    await steps(sim, 60);

    expect(Array.from(sim.ctx.dots.x)).toEqual(Array.from(plain.ctx.dots.x));
    expect(Array.from(sim.ctx.dots.targetPlace)).toEqual(Array.from(plain.ctx.dots.targetPlace));
  });
});
