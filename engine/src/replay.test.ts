import { describe, expect, it, vi } from 'vitest';
import type { DecisionAnswer, DecisionAsk, DecisionTape, Odds, SimConfig } from '../../contracts.ts';
import { DOT_GROUP_SIZE } from '../../contracts.ts';
import { DECISION_DEFAULTS } from '../../brain/src/defaults.ts';
import { DecisionClient } from '../../brain/src/client.ts';
import { makePopulation } from '../../brain/src/fan-types.ts';
import { makeTestMap } from '../../world/src/test-map.ts';
import { playbookFor } from '../../world/src/playbook.ts';
import { testGateSurge } from '../../world/src/incidents.ts';
import { makeOfficers } from '../../world/src/officers.ts';
import { FlowMovement } from './movement-flow.ts';
import { Simulation } from './sim.ts';

const map = makeTestMap();
const SEED = 4242;

function configFor(runId: string): SimConfig {
  return {
    runId,
    label: 'A',
    seed: SEED,
    startAt: -600,
    endAt: 300,
    speed: 1000,
    dangerDensity: 4,
    mapId: map.id,
    incident: testGateSurge(map, 0),
    plan: playbookFor('gate_surge', map)[2]!, // the plan with an alert, so more keys are raised
    officers: makeOfficers(map, 12),
  };
}

/** Deterministic, lopsided odds derived from the key, so answers are not the defaults. */
function stubKev(): { fetchImpl: typeof fetch; calls: () => number } {
  let calls = 0;
  const impl = async (_url: string | URL | Request, init?: RequestInit) => {
    calls++;
    const body = JSON.parse(String(init?.body)) as { asks: DecisionAsk[] };
    const answers: DecisionAnswer[] = body.asks.map((ask) => {
      const options = DECISION_DEFAULTS.situations.find((s) => s.id === ask.situation)!.options;
      let hash = 2166136261;
      for (let i = 0; i < ask.key.length; i++) {
        hash = (Math.imul(hash ^ ask.key.charCodeAt(i), 16777619) >>> 0);
      }
      const weights = options.map((_, i) => ((hash >>> (i * 4)) & 7) + 1);
      const total = weights.reduce((a, b) => a + b, 0);
      const odds: Odds = {};
      options.forEach((option, i) => {
        odds[option.key] = weights[i]! / total;
      });
      return { key: ask.key, odds, source: 'kev', model: 'stub-kev', ms: 7 };
    });
    return Response.json({ answers });
  };
  return { fetchImpl: impl as unknown as typeof fetch, calls: () => calls };
}

async function runToEnd(sim: Simulation) {
  while (!sim.done) await sim.step();
}

describe('DecisionTape replay', () => {
  it('records every answer a run used', async () => {
    const stub = stubKev();
    const config = configFor('run-live');
    const client = new DecisionClient(config.runId, {
      serverUrl: '',
      defaults: DECISION_DEFAULTS,
      fetchImpl: stub.fetchImpl,
    });
    const sim = new Simulation({
      config,
      map,
      population: makePopulation(1200, SEED),
      defaults: DECISION_DEFAULTS,
      serverUrl: '',
      movement: new FlowMovement(),
      client,
    });
    await runToEnd(sim);

    const tape = sim.tape();
    expect(tape.runId).toBe('run-live');
    expect(tape.answers.length).toBeGreaterThan(0);
    expect(stub.calls()).toBeGreaterThan(0);
    // Proof the run really used model answers, not the fallback table.
    expect(tape.answers.some((a) => a.answer.source === 'kev')).toBe(true);
    expect(tape.answers.every((a) => a.answer.key.length > 0)).toBe(true);
  });

  it('gives the identical scorecard from the same seed and tape, with no model at all', async () => {
    const stub = stubKev();
    const liveConfig = configFor('run-live');
    const liveClient = new DecisionClient(liveConfig.runId, {
      serverUrl: '',
      defaults: DECISION_DEFAULTS,
      fetchImpl: stub.fetchImpl,
    });
    const live = new Simulation({
      config: liveConfig,
      map,
      population: makePopulation(1200, SEED),
      defaults: DECISION_DEFAULTS,
      serverUrl: '',
      movement: new FlowMovement(),
      client: liveClient,
    });
    await runToEnd(live);
    const liveCard = live.scorecard();
    const tape: DecisionTape = live.tape();

    // Replay: same seed, same tape, and a fetch that throws if anything reaches for it.
    const forbidden = vi.fn(() => {
      throw new Error('replay must not call out');
    }) as unknown as typeof fetch;
    const replayConfig = configFor('run-live');
    const replayClient = new DecisionClient(replayConfig.runId, {
      serverUrl: '',
      defaults: DECISION_DEFAULTS,
      replay: tape,
      fetchImpl: forbidden,
    });
    const replayed = new Simulation({
      config: replayConfig,
      map,
      population: makePopulation(1200, SEED),
      defaults: DECISION_DEFAULTS,
      serverUrl: '',
      movement: new FlowMovement(),
      client: replayClient,
    });
    await runToEnd(replayed);

    expect(replayed.scorecard()).toEqual(liveCard);
    expect(forbidden).not.toHaveBeenCalled();
    // and the crowd itself ended up in exactly the same place
    expect(Array.from(replayed.ctx.dots.x)).toEqual(Array.from(live.ctx.dots.x));
    expect(Array.from(replayed.ctx.dots.state)).toEqual(Array.from(live.ctx.dots.state));
  });

  it('scores differently once the tape says something different', async () => {
    const stub = stubKev();
    const config = configFor('run-live');
    const client = new DecisionClient(config.runId, {
      serverUrl: '',
      defaults: DECISION_DEFAULTS,
      fetchImpl: stub.fetchImpl,
    });
    const withKev = new Simulation({
      config,
      map,
      population: makePopulation(1200, SEED),
      defaults: DECISION_DEFAULTS,
      serverUrl: '',
      movement: new FlowMovement(),
      client,
    });
    await runToEnd(withKev);

    // Same seed, but every decision falls back to the even-odds defaults.
    const defaultsOnly = new Simulation({
      config: configFor('run-live'),
      map,
      population: makePopulation(1200, SEED),
      defaults: DECISION_DEFAULTS,
      serverUrl: '',
      movement: new FlowMovement(),
      replay: { runId: 'run-live', answers: [] },
    });
    await runToEnd(defaultsOnly);

    expect(defaultsOnly.scorecard().fallbackDecisions).toBeGreaterThan(0);
    expect(withKev.scorecard().fallbackDecisions).toBe(0);
  });
});

describe('scorecard against a hand count on the 3 gate test map', () => {
  /**
   * One dot, 5 fans, ten minutes, a plan that sends six officers at the
   * incident and sends no alert. Every number below is arithmetic a person can
   * do on paper, which is the point: it pins the scorecard to something other
   * than its own output.
   */
  it('matches numbers worked out by hand', async () => {
    const minutes = 10;
    const officersSent = 6;
    const dots = 1;
    const config: SimConfig = {
      runId: 'hand-count',
      label: 'A',
      seed: 7,
      startAt: 0,
      endAt: minutes * 60,
      speed: 1000,
      dangerDensity: 4,
      mapId: map.id,
      incident: testGateSurge(map, 0),
      // "Six officers to Gate 1": one send_officers action, no alert at all.
      plan: playbookFor('gate_surge', map)[0]!,
      officers: makeOfficers(map, 12),
    };
    expect(config.plan.actions).toHaveLength(1);
    expect(config.plan.actions[0]).toMatchObject({ type: 'send_officers', count: officersSent, at: 0 });

    const sim = new Simulation({
      config,
      map,
      population: makePopulation(dots * DOT_GROUP_SIZE, 7),
      defaults: DECISION_DEFAULTS,
      serverUrl: '',
      movement: new FlowMovement(),
      replay: { runId: 'hand-count', answers: [] },
    });
    await runToEnd(sim);
    const card = sim.scorecard();

    // 6 officers committed from the first step through to the end:
    // 6 x 600 seconds = 3,600 officer-seconds = 60 officer-minutes.
    expect(card.officerMinutesUsed).toBeCloseTo(officersSent * minutes, 6);

    // The plan carries no alert, so not one of the 5 fans is reached.
    expect(card.fansNotReached).toBe(dots * DOT_GROUP_SIZE);

    // One dot alone in a 2 m cell is 5 fans over 4 square meters.
    expect(card.peakDensity).toBeCloseTo((dots * DOT_GROUP_SIZE) / 4, 6);

    // 1.25 is nowhere near the 4 per square meter danger line, so no danger minutes.
    expect(card.dangerMinutes).toBe(0);

    // Officers are posted at the gates before kickoff, so one is already inside
    // the zone. The scorecard reads the first observation, which is one sim
    // second after the incident: 1/60 of a minute, not zero.
    expect(card.firstOfficerMin).toBeCloseTo(1 / 60, 9);

    expect(card.label).toBe('A');
    expect(card.planId).toBe(config.plan.id);
    expect(card.runId).toBe('hand-count');
  });
});

describe('rewinding a run', () => {
  /**
   * The contract's Snapshot is frozen and carries only what crosses the lane
   * boundary, so a checkpoint has to carry the movement model's own state and
   * the scorer's as well. If it did not, a rewound run would drift: fans would
   * forget which gate they were assigned, which seat they were walking to and
   * whether they had already been let in.
   */
  it('puts the crowd and the scorecard back exactly', async () => {
    const config = configFor('rewind');
    const sim = new Simulation({
      config,
      map,
      population: makePopulation(1200, SEED),
      defaults: DECISION_DEFAULTS,
      serverUrl: '',
      movement: new FlowMovement(),
      replay: { runId: config.runId, answers: [] },
    });

    // run a while, take a restart point, then keep going and remember where it got to
    for (let i = 0; i < 120; i++) await sim.step();
    const point = sim.checkpoint();
    const tAtCheckpoint = sim.ctx.t;

    for (let i = 0; i < 90; i++) await sim.step();
    const expectedT = sim.ctx.t;
    const expectedX = Array.from(sim.ctx.dots.x);
    const expectedState = Array.from(sim.ctx.dots.state);
    const expectedTargets = Array.from(sim.ctx.dots.targetPlace);
    const expectedCard = sim.scorecard();

    // rewind and walk the same ninety seconds again
    sim.rewind(point);
    expect(sim.ctx.t).toBe(tAtCheckpoint);
    for (let i = 0; i < 90; i++) await sim.step();

    expect(sim.ctx.t).toBe(expectedT);
    expect(Array.from(sim.ctx.dots.x)).toEqual(expectedX);
    expect(Array.from(sim.ctx.dots.state)).toEqual(expectedState);
    expect(Array.from(sim.ctx.dots.targetPlace)).toEqual(expectedTargets);
    expect(sim.scorecard()).toEqual(expectedCard);
  });

  it('does not double count the scorecard when it rewinds', async () => {
    const config = configFor('rewind-score');
    const sim = new Simulation({
      config,
      map,
      population: makePopulation(1200, SEED),
      defaults: DECISION_DEFAULTS,
      serverUrl: '',
      movement: new FlowMovement(),
      replay: { runId: config.runId, answers: [] },
    });
    for (let i = 0; i < 100; i++) await sim.step();
    const point = sim.checkpoint();
    const atPoint = sim.scorecard();

    for (let i = 0; i < 50; i++) await sim.step();
    sim.rewind(point);

    // Officer minutes and danger minutes only ever accumulate, so a rewind that
    // forgot to put the scorer back would show more here than it did before.
    expect(sim.scorecard().officerMinutesUsed).toBeCloseTo(atPoint.officerMinutesUsed, 9);
    expect(sim.scorecard().dangerMinutes).toBeCloseTo(atPoint.dangerMinutes, 9);
    expect(sim.scorecard().fallbackDecisions).toBe(atPoint.fallbackDecisions);
  });
});
