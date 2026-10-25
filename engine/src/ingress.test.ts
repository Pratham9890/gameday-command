import { describe, expect, it } from 'vitest';
import type { Place, SimConfig } from '../../contracts.ts';
import { DOT_STATES } from '../../contracts.ts';
import { DECISION_DEFAULTS } from '../../brain/src/defaults.ts';
import { makePopulation } from '../../brain/src/fan-types.ts';
import { gateSurge } from '../../world/src/incidents.ts';
import { makeOfficers } from '../../world/src/officers.ts';
import { buildStadiumMap, extractExists, loadExtract } from '../../world/src/osm/stadium.ts';
import { FlowMovement } from './movement-flow.ts';
import { Simulation } from './sim.ts';

/** See perf.test.ts: a long run must yield now and then or Vitest's reporter times out. */
const breathe = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * The stadium has to fill before kickoff, or every incident and every scorecard
 * is measured on a crowd that is not there. Seats used to be drawn from the
 * whole bowl and walked to in a straight line: half an hour after kickoff 9,211
 * admitted dots were still trying to reach a seat against 6,162 seated, and
 * Gate 10 stopped admitting anyone with 990 people at it.
 */
describe.skipIf(!extractExists())('ingress on the Ohio Stadium map', () => {
  it('seats the crowd that got in, and every reachable gate admits fans', async () => {
    const map = buildStadiumMap(loadExtract());
    const movement = new FlowMovement();
    const config: SimConfig = {
      runId: 'ingress',
      label: 'A',
      seed: 20251023,
      startAt: -3600,
      endAt: 1800,
      speed: 1000,
      dangerDensity: 4,
      mapId: map.id,
      // No incident inside the window: this is the ordinary build-up.
      incident: { ...gateSurge(map, 0), at: 1_000_000 },
      plan: { id: 'none', name: 'No plan', forIncident: 'gate_surge', officersAvailable: 0, actions: [] },
      officers: makeOfficers(map, 24),
    };
    const sim = new Simulation({
      config,
      map,
      population: makePopulation(100_000, 20251023),
      defaults: DECISION_DEFAULTS,
      serverUrl: '',
      movement,
      replay: { runId: 'ingress', answers: [] },
    });
    const gates = map.places.flatMap((p: Place, i: number) => (p.kind === 'gate' ? [i] : []));
    const count = () => {
      const frame = sim.frame();
      let arrived = 0;
      let seated = 0;
      let admittedUnseated = 0;
      const admittedAt = new Map<number, number>();
      for (let i = 0; i < frame.state.length; i++) {
        const state = DOT_STATES[frame.state[i]!];
        const info = movement.describe(i);
        if (state !== 'arriving') arrived++;
        if (state === 'seated') seated++;
        if (info.admitted) {
          admittedAt.set(info.homeGate, (admittedAt.get(info.homeGate) ?? 0) + 1);
          if (state !== 'seated') admittedUnseated++;
        }
      }
      console.log(
        `ingress at t=${sim.ctx.t}: ${arrived} arrived, ${seated} seated (${((100 * seated) / arrived).toFixed(1)}%), ` +
          `${admittedUnseated} admitted but unseated; admitted per gate ` +
          gates.map((g) => `${map.places[g]!.name.split(' ')[1]}:${admittedAt.get(g) ?? 0}`).join(' '),
      );
      return { total: frame.state.length, arrived, seated, admittedUnseated, admittedAt };
    };

    let atKickoff: ReturnType<typeof count> | null = null;
    for (let step = 0; !sim.done; step++) {
      await sim.step();
      if (sim.ctx.t === 0) atKickoff = count();
      if (step % 250 === 249) await breathe();
    }
    const after = count();

    // The bowl interior is instant, so nobody who got through a turnstile can
    // still be walking/unseated. // supervisor sets the admitted-fraction bar
    // after measuring
    expect(atKickoff!.admittedUnseated).toBe(0);
    expect(after.admittedUnseated).toBe(0);
    // Every gate anyone was assigned to lets people in. Gate 8 (SSW) is walled
    // off from every lot by the map builder, so nobody is assigned to it.
    const assigned = new Set<number>();
    for (let i = 0; i < after.total; i++) assigned.add(movement.describe(i).homeGate);
    for (const gate of gates) {
      if (assigned.has(gate)) expect(after.admittedAt.get(gate) ?? 0, map.places[gate]!.name).toBeGreaterThan(0);
    }
  }, 300_000);

  it('rewinds the stadium run exactly, including seat progress', async () => {
    const map = buildStadiumMap(loadExtract());
    const movement = new FlowMovement();
    const config: SimConfig = {
      runId: 'rewind',
      label: 'A',
      seed: 20251023,
      startAt: -2400,
      endAt: -1200,
      speed: 1000,
      dangerDensity: 4,
      mapId: map.id,
      incident: { ...gateSurge(map, 0), at: 1_000_000 },
      plan: { id: 'none', name: 'No plan', forIncident: 'gate_surge', officersAvailable: 0, actions: [] },
      officers: makeOfficers(map, 12),
    };
    const sim = new Simulation({
      config,
      map,
      population: makePopulation(20_000, 20251023),
      defaults: DECISION_DEFAULTS,
      serverUrl: '',
      movement,
      replay: { runId: 'rewind', answers: [] },
    });
    const runTo = async (until: number) => {
      while (!sim.done && sim.ctx.t < until) await sim.step();
    };
    await runTo(-1800);
    const point = sim.checkpoint();
    expect(sim.ctx.t).toBe(-1800);
    await runTo(-1500);
    const first = sim.frame();
    const state = {
      x: Array.from(first.x),
      y: Array.from(first.y),
      state: Array.from(first.state),
      target: Array.from(sim.ctx.dots.targetPlace),
    };
    sim.rewind(point);
    expect(sim.ctx.t).toBe(-1800);
    await runTo(-1500);
    const second = sim.frame();
    expect(Array.from(second.x)).toEqual(state.x);
    expect(Array.from(second.y)).toEqual(state.y);
    expect(Array.from(second.state)).toEqual(state.state);
    expect(Array.from(sim.ctx.dots.targetPlace)).toEqual(state.target);
  }, 300_000);
});
