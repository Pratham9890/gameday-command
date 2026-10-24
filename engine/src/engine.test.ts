import { describe, expect, it } from 'vitest';
import type { SimConfig, WorkerOut } from '../../contracts.ts';
import { CELL_SIZE_M, FRAME_EVERY_S } from '../../contracts.ts';
import { DECISION_DEFAULTS } from '../../brain/src/defaults.ts';
import { makePopulation } from '../../brain/src/fan-types.ts';
import { makeTestMap } from '../../world/src/test-map.ts';
import { playbookFor } from '../../world/src/playbook.ts';
import { testGateSurge } from '../../world/src/incidents.ts';
import { makeOfficers } from '../../world/src/officers.ts';
import { Rng } from './rng.ts';
import { DensityField } from './density.ts';
import { DotStore } from './dots.ts';
import { CircleMovement } from './movement-circle.ts';
import { Simulation } from './sim.ts';

const SEED = 20251023;

function makeSim(seed = SEED, planIndex = 0, collect?: WorkerOut[]) {
  const map = makeTestMap();
  const population = makePopulation(500, seed);
  const plan = playbookFor('gate_surge', map)[planIndex]!;
  const config: SimConfig = {
    runId: `run-${planIndex}`,
    label: 'A',
    seed,
    startAt: -60,
    endAt: 60,
    speed: 100,
    dangerDensity: 4,
    mapId: map.id,
    incident: testGateSurge(map, 0),
    plan,
    officers: makeOfficers(map, 6),
  };
  return new Simulation({
    config,
    map,
    population,
    defaults: DECISION_DEFAULTS,
    serverUrl: '',
    movement: new CircleMovement(),
    // An empty tape keeps the run off the network: every answer comes from defaults.
    replay: { runId: config.runId, answers: [] },
    emit: collect ? (out) => collect.push(out) : undefined,
  });
}

async function runToEnd(sim: Simulation) {
  while (!sim.done) await sim.step();
}

describe('Rng', () => {
  it('gives the same sequence for the same seed', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    expect(Array.from({ length: 8 }, () => a.next())).toEqual(Array.from({ length: 8 }, () => b.next()));
  });

  it('gives different sequences for different seeds', () => {
    expect(new Rng(1).next()).not.toBe(new Rng(2).next());
  });

  it('resumes exactly from a restored state', () => {
    const rng = new Rng(7);
    for (let i = 0; i < 5; i++) rng.next();
    const state = rng.state();
    const expected = Array.from({ length: 5 }, () => rng.next());

    const other = new Rng(0);
    other.restore(state);
    expect(Array.from({ length: 5 }, () => other.next())).toEqual(expected);
  });

  it('stays inside [0, 1)', () => {
    const rng = new Rng(99);
    for (let i = 0; i < 5000; i++) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('DensityField', () => {
  it('turns dots into people per square meter', () => {
    const field = new DensityField(2, 2);
    const dots = new DotStore(3);
    // all three dots inside cell 0, which is CELL_SIZE_M squared
    dots.x[0] = 0.5;
    dots.y[0] = 0.5;
    dots.x[1] = 1.5;
    dots.y[1] = 1.5;
    dots.x[2] = 1.0;
    dots.y[2] = 0.2;
    field.update(dots);
    expect(field.counts[0]).toBe(3);
    // 3 dots x 5 fans / 4 square meters
    expect(field.peoplePerM2[0]).toBeCloseTo(3.75, 6);
    expect(field.dotsInCells([0])).toBe(3);
  });

  it('keeps seated fans in the crowd but out of the standing count', () => {
    const field = new DensityField(2, 2);
    const dots = new DotStore(3);
    for (let i = 0; i < 3; i++) {
      dots.x[i] = 0.5;
      dots.y[i] = 0.5;
      dots.setState(i, 'walking');
    }
    dots.setState(0, 'seated');
    dots.setState(1, 'seated');
    field.update(dots);
    expect(field.peoplePerM2[0]).toBeCloseTo(3.75, 6);
    // only the one walking dot: 5 fans / 4 square meters
    expect(field.standingPerM2[0]).toBeCloseTo(1.25, 6);
  });

  it('ignores dots that are gone', () => {
    const field = new DensityField(2, 2);
    const dots = new DotStore(2);
    dots.setState(1, 'gone');
    field.update(dots);
    expect(field.counts[0]).toBe(1);
  });
});

describe('Simulation on the test map', () => {
  it('emits a replay frame every FRAME_EVERY_S sim seconds', async () => {
    const sim = makeSim();
    let frames = 0;
    while (!sim.done) {
      await sim.step();
      if (sim.isFrameTime()) frames++;
    }
    // -60 to 60 inclusive of the boundaries it crosses
    expect(frames).toBe(120 / FRAME_EVERY_S);
  });

  it('keeps every dot on the map', async () => {
    const sim = makeSim();
    await runToEnd(sim);
    const { x, y } = sim.frame();
    const maxX = sim.ctx.map.width * CELL_SIZE_M;
    const maxY = sim.ctx.map.height * CELL_SIZE_M;
    for (let i = 0; i < x.length; i++) {
      expect(x[i]).toBeGreaterThanOrEqual(0);
      expect(x[i]).toBeLessThan(maxX);
      expect(y[i]).toBeGreaterThanOrEqual(0);
      expect(y[i]).toBeLessThan(maxY);
    }
  });

  it('gives byte-identical runs for the same seed', async () => {
    const a = makeSim(SEED);
    const b = makeSim(SEED);
    await runToEnd(a);
    await runToEnd(b);
    const fa = a.frame();
    const fb = b.frame();
    expect(Array.from(fa.x)).toEqual(Array.from(fb.x));
    expect(Array.from(fa.y)).toEqual(Array.from(fb.y));
    expect(Array.from(fa.state)).toEqual(Array.from(fb.state));
    expect(a.scorecard()).toEqual(b.scorecard());
  });

  it('counts every decision as a fallback when nothing answers', async () => {
    const out: WorkerOut[] = [];
    const sim = makeSim(SEED, 0, out);
    await runToEnd(sim);
    const records = out.filter((m) => m.type === 'decision');
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((m) => m.type === 'decision' && m.record.source === 'default')).toBe(true);
    expect(sim.scorecard().fallbackDecisions).toBeGreaterThan(0);
  });

  it('pauses sim time with a deciding message before answering', async () => {
    const out: WorkerOut[] = [];
    const sim = makeSim(SEED, 0, out);
    await runToEnd(sim);
    const deciding = out.filter((m) => m.type === 'deciding');
    expect(deciding.length).toBeGreaterThan(0);
  });

  it('round trips a snapshot', async () => {
    const sim = makeSim();
    for (let i = 0; i < 20; i++) await sim.step();
    const snapshot = sim.snapshot();
    const xBefore = Array.from(sim.ctx.dots.x);

    for (let i = 0; i < 10; i++) await sim.step();
    expect(Array.from(sim.ctx.dots.x)).not.toEqual(xBefore);

    sim.restore(snapshot);
    expect(sim.ctx.t).toBe(snapshot.t);
    expect(Array.from(sim.ctx.dots.x)).toEqual(xBefore);
    expect(sim.ctx.rng.state()).toEqual(snapshot.rngState);
  });

  it('records a tape of every answer the run used', async () => {
    const sim = makeSim();
    await runToEnd(sim);
    const tape = sim.tape();
    expect(tape.answers.length).toBeGreaterThan(0);
    for (const entry of tape.answers) expect(entry.answer.key).toBeTruthy();
  });
});
