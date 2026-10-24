import { describe, expect, it, vi } from 'vitest';
import type { SimConfig, WorkerOut } from '../../contracts.ts';
import { DECISION_DEFAULTS } from '../../brain/src/defaults.ts';
import { makePopulation } from '../../brain/src/fan-types.ts';
import { makeTestMap } from '../../world/src/test-map.ts';
import { playbookFor } from '../../world/src/playbook.ts';
import { testGateSurge } from '../../world/src/incidents.ts';
import { makeOfficers } from '../../world/src/officers.ts';
import type { PoliceOrder } from './edits.ts';
import { FlowMovement } from './movement-flow.ts';
import { Simulation } from './sim.ts';

const SEED = 4242;

function makeSim(runId: string, emit?: (out: WorkerOut) => void, overrides: Partial<SimConfig> = {}): Simulation {
  const map = makeTestMap();
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
    officers: makeOfficers(map, 3),
    ...overrides,
  };
  return new Simulation({
    config,
    map,
    population: makePopulation(300, SEED),
    defaults: DECISION_DEFAULTS,
    serverUrl: '',
    movement: new FlowMovement(),
    replay: { runId, answers: [] },
    emit,
  });
}

const steps = async (sim: Simulation, n: number) => {
  for (let i = 0; i < n; i++) await sim.step();
};

function destination(sim: Simulation) {
  const gate = sim.ctx.map.places.filter((p) => p.kind === 'gate')[1]!;
  const door = sim.ctx.map.closables.find((c) => c.cells.includes(gate.cells[0]!))!;
  return { gate, door, officer: sim.ctx.officers[0]! };
}

describe('live police orders', () => {
  it('dispatches known officers on the next step and reaches the requested place', async () => {
    const sim = makeSim('dispatch');
    const { officer, gate } = destination(sim);
    const order: PoliceOrder = { type: 'dispatch', officerIds: [officer.id, 'unknown'], toCell: gate.cells[0]! };
    sim.queueOrder(order);
    expect(sim.officerStatus()[0]!.state).toBe('standby');
    expect(sim.ordersLog()).toEqual([]);
    await sim.step();
    expect(sim.officerStatus()[0]!.state).toBe('en_route');
    expect(sim.ordersLog()).toEqual([{ t: -599, order }]);
    await steps(sim, 30);
    expect(sim.officerStatus()[0]).toMatchObject({ state: 'on_scene', cell: gate.cells[0] });
  });

  it('recalls an officer home without instructing fans on arrival', async () => {
    const emit = vi.fn<(out: WorkerOut) => void>();
    const sim = makeSim('recall', emit);
    await steps(sim, 120);
    const { officer, gate } = destination(sim);
    const homeCell = officer.cell;
    sim.queueOrder({ type: 'dispatch', officerIds: [officer.id], toCell: gate.cells[0]! });
    await steps(sim, 30);
    expect(sim.officerStatus()[0]!.state).toBe('on_scene');
    emit.mockClear();
    sim.queueOrder({ type: 'recall', officerIds: [officer.id, 'unknown'] });
    await sim.step();
    expect(sim.officerStatus()[0]).toMatchObject({ state: 'en_route', targetCell: homeCell });
    await steps(sim, 30);
    expect(sim.officerStatus()[0]).toMatchObject({ state: 'standby', cell: homeCell, place: -1 });
    expect(emit.mock.calls.some(([out]) => out.type === 'decision' && out.record.situation === 'officer_instruction')).toBe(false);
  });

  it('clears a stale post when dispatching to the street and cancels a recall on redispatch', async () => {
    const sim = makeSim('redispatch');
    const { officer, gate } = destination(sim);
    sim.queueOrder({ type: 'dispatch', officerIds: [officer.id], toCell: gate.cells[0]! });
    await steps(sim, 30);
    const streetCell = 8 * sim.ctx.map.width + 10;
    sim.queueOrder({ type: 'dispatch', officerIds: [officer.id], toCell: streetCell });
    await sim.step();
    expect(sim.ctx.officerPost.has(officer.id)).toBe(false);
    await steps(sim, 30);
    expect(sim.officerStatus()[0]!.cell).toBe(streetCell);
    sim.queueOrder({ type: 'recall', officerIds: [officer.id] });
    await sim.step();
    sim.queueOrder({ type: 'dispatch', officerIds: [officer.id], toCell: gate.cells[0]! });
    await steps(sim, 30);
    expect(sim.officerStatus()[0]).toMatchObject({ state: 'on_scene', cell: gate.cells[0] });
  });

  it('recalls to a home outside any place without keeping the previous route', async () => {
    const officers = makeOfficers(makeTestMap(), 1);
    officers[0]!.cell = 8 * 20 + 10;
    const sim = makeSim('street-home', undefined, { officers });
    const { officer, gate } = destination(sim);
    sim.queueOrder({ type: 'dispatch', officerIds: [officer.id], toCell: gate.cells[0]! });
    await steps(sim, 30);
    sim.queueOrder({ type: 'recall', officerIds: [officer.id] });
    await sim.step();
    expect(sim.ctx.officerPost.has(officer.id)).toBe(false);
    await steps(sim, 30);
    expect(sim.officerStatus()[0]).toMatchObject({ state: 'standby', cell: officers[0]!.cell });
  });

  it('closes and reopens a gate on the next step', async () => {
    const sim = makeSim('gate');
    const { door } = destination(sim);
    sim.queueOrder({ type: 'gate', closableId: door.id, closed: true });
    expect(sim.ctx.closed.has(door.id)).toBe(false);
    await sim.step();
    expect(sim.ctx.closed.has(door.id)).toBe(true);
    sim.queueOrder({ type: 'gate', closableId: door.id, closed: false });
    expect(sim.ctx.closed.has(door.id)).toBe(true);
    await sim.step();
    expect(sim.ctx.closed.has(door.id)).toBe(false);
    expect(sim.ordersLog().map((entry) => entry.t)).toEqual([-599, -598]);
  });

  it('lets a live order override a plan step at the same second', async () => {
    const sim = makeSim('override', undefined, { startAt: -1, plan: playbookFor('gate_surge', makeTestMap())[2]! });
    const gate = sim.ctx.map.places.find((p) => p.kind === 'gate')!;
    const door = sim.ctx.map.closables.find((c) => c.cells.includes(gate.cells[0]!))!;
    sim.queueOrder({ type: 'gate', closableId: door.id, closed: false });
    await sim.step();
    expect(sim.ctx.closed.has(door.id)).toBe(false);
  });

  it('registers a new barricade only once, including on replay, and reports it only while closed', async () => {
    const sim = makeSim('barricade');
    const point = sim.checkpoint();
    const order: PoliceOrder = { type: 'barricade', closableId: 'live-road', cells: [160, 161], closed: true };
    sim.queueOrder(order);
    await sim.step();
    sim.queueOrder(order);
    await sim.step();
    const barricade = { id: 'live-road', name: 'live-road', cells: [160, 161] };
    expect(sim.ctx.map.closables.filter((c) => c.id === 'live-road')).toEqual([barricade]);
    expect(sim.ctx.closed.has('live-road')).toBe(true);
    expect(sim.liveBarricades()).toEqual([barricade]);
    sim.rewind(point);
    expect(sim.liveBarricades()).toEqual([]);
    await steps(sim, 2);
    expect(sim.ctx.map.closables.filter((c) => c.id === 'live-road')).toEqual([barricade]);
    expect(sim.liveBarricades()).toEqual([barricade]);
    sim.queueOrder({ type: 'barricade', closableId: 'live-road', closed: false });
    await sim.step();
    expect(sim.liveBarricades()).toEqual([]);
  });

  it('redirects a place and has officers on station instruct nearby fans once', async () => {
    const emit = vi.fn<(out: WorkerOut) => void>();
    const sim = makeSim('redirect', emit);
    await steps(sim, 120);
    const { gate } = destination(sim);
    sim.queueOrder({ type: 'dispatch', officerIds: sim.ctx.officers.map((o) => o.id), toCell: gate.cells[0]! });
    await steps(sim, 30);
    emit.mockClear();
    const from = sim.ctx.map.places.indexOf(gate);
    const to = sim.ctx.map.places.findIndex((p) => p.kind === 'parking');
    sim.queueOrder({ type: 'redirect', fromPlaceId: gate.id, toPlaceId: sim.ctx.map.places[to]!.id });
    await sim.step();
    expect(sim.ctx.redirects.get(from)).toBe(to);
    const dots = emit.mock.calls.flatMap(([out]) => out.type === 'decision' && out.record.situation === 'officer_instruction' ? [out.record.dot] : []);
    expect(dots.length).toBeGreaterThan(0);
    expect(new Set(dots).size).toBe(dots.length);
  });

  it.each([1, 2, -1])('reports an alert with clamped reach %s', async (reachShare) => {
    const sim = makeSim('alert');
    await steps(sim, 120);
    sim.queueOrder({ type: 'alert', channel: 'pa', message: 'Use another gate', reachShare });
    await sim.step();
    const alerts = sim.takeAlerts();
    if (reachShare < 0) expect(alerts).toEqual([]);
    else {
      expect(alerts).toHaveLength(1);
      expect(alerts[0]!.t).toBe(sim.ctx.t);
      expect(alerts[0]!.dots.length).toBeGreaterThan(0);
    }
    expect(sim.takeAlerts()).toEqual([]);
  });

  it('raises exit_route decisions for fans when released', async () => {
    const emit = vi.fn<(out: WorkerOut) => void>();
    const sim = makeSim('release', emit);
    await steps(sim, 120);
    sim.queueOrder({ type: 'release' });
    await sim.step();
    const decisions = emit.mock.calls.flatMap(([out]) => out.type === 'decision' && out.record.situation === 'exit_route' ? [out.record] : []);
    expect(decisions.length).toBeGreaterThan(0);
    expect(decisions.every((record) => record.t === sim.ctx.t)).toBe(true);
  });

  it('replays orders after a checkpoint with identical officers, closures and crowd positions', async () => {
    const sim = makeSim('rewind');
    await steps(sim, 120);
    const point = structuredClone(sim.checkpoint());
    await steps(sim, 5);
    const { officer, gate, door } = destination(sim);
    sim.queueOrder({ type: 'dispatch', officerIds: [officer.id], toCell: gate.cells[0]! });
    sim.queueOrder({ type: 'gate', closableId: door.id, closed: true });
    await steps(sim, 30);
    const status = sim.officerStatus();
    const closed = [...sim.ctx.closed];
    const { x, y } = sim.frame();
    sim.rewind(point);
    expect(sim.ordersLog()).toEqual([]);
    await steps(sim, 35);
    expect(sim.officerStatus()).toEqual(status);
    expect([...sim.ctx.closed]).toEqual(closed);
    expect(sim.ctx.dots.x).toEqual(x);
    expect(sim.ctx.dots.y).toEqual(y);
  });

  it('restores exact positions and recall state from a checkpoint taken while walking home', async () => {
    const sim = makeSim('rewind-recall');
    await steps(sim, 120);
    const { officer, gate } = destination(sim);
    sim.queueOrder({ type: 'dispatch', officerIds: [officer.id], toCell: gate.cells[0]! });
    await steps(sim, 30);
    sim.queueOrder({ type: 'recall', officerIds: [officer.id] });
    await sim.step();
    const walking = sim.officerStatus();
    const point = structuredClone(sim.checkpoint());
    await steps(sim, 30);
    const arrived = sim.officerStatus();
    sim.rewind(point);
    expect(sim.officerStatus()).toEqual(walking);
    await steps(sim, 30);
    expect(sim.officerStatus()).toEqual(arrived);
    expect(sim.officerStatus()[0]!.state).toBe('standby');
  });

  it('drops future orders so they do not replay after a rewind', async () => {
    const sim = makeSim('drop-orders');
    const { officer, gate, door } = destination(sim);
    const point = sim.checkpoint();
    const original = sim.officerStatus();
    sim.queueOrder({ type: 'dispatch', officerIds: [officer.id], toCell: gate.cells[0]! });
    sim.queueOrder({ type: 'gate', closableId: door.id, closed: true });
    await steps(sim, 5);
    sim.rewind(point);
    sim.dropOrdersAfter(sim.ctx.t);
    await steps(sim, 30);
    expect(sim.officerStatus()).toEqual(original);
    expect(sim.ctx.closed.size).toBe(0);
    expect(sim.ordersLog()).toEqual([]);
  });

  it('restores a pending arrival instruction and copies checkpoint positions independently', async () => {
    const emit = vi.fn<(out: WorkerOut) => void>();
    const sim = makeSim('pending-instruction', emit);
    await steps(sim, 120);
    const { officer, gate } = destination(sim);
    sim.queueOrder({ type: 'dispatch', officerIds: [officer.id], toCell: gate.cells[0]! });
    await sim.step();
    for (let i = 0; i < 30 && sim.officerStatus()[0]!.state === 'en_route'; i++) await sim.step();
    expect(sim.officerStatus()[0]!.state).toBe('on_scene');
    const point = sim.checkpoint();
    emit.mockClear();
    await sim.step();
    const expected = emit.mock.calls.map(([out]) => out);
    expect(expected.some((out) => out.type === 'decision' && out.record.situation === 'officer_instruction')).toBe(true);
    sim.queueOrder({ type: 'recall', officerIds: [officer.id] });
    await steps(sim, 30);
    sim.rewind(point);
    emit.mockClear();
    await sim.step();
    expect(emit.mock.calls.map(([out]) => out)).toEqual(expected);
  });

  it('forgets future redirects, alert deliveries and alert-heard decision context on rewind', async () => {
    const emit = vi.fn<(out: WorkerOut) => void>();
    const sim = makeSim('rewind-alert', emit);
    await steps(sim, 120);
    const point = sim.checkpoint();
    sim.queueOrder({ type: 'release' });
    await sim.step();
    const expected = emit.mock.calls.map(([out]) => out);
    expect(expected.some((out) => out.type === 'decision')).toBe(true);
    sim.rewind(point);
    sim.dropOrdersAfter(sim.ctx.t);
    const { gate } = destination(sim);
    const to = sim.ctx.map.places.find((p) => p.kind === 'parking')!;
    sim.queueOrder({ type: 'redirect', fromPlaceId: gate.id, toPlaceId: to.id });
    sim.queueOrder({ type: 'alert', channel: 'phone', message: 'Leave now', reachShare: 1 });
    await sim.step();
    expect(sim.ctx.redirects.size).toBe(1);
    sim.rewind(point);
    sim.dropOrdersAfter(sim.ctx.t);
    expect(sim.ctx.redirects.size).toBe(0);
    expect(sim.takeAlerts()).toEqual([]);
    emit.mockClear();
    sim.queueOrder({ type: 'release' });
    await sim.step();
    expect(emit.mock.calls.map(([out]) => out)).toEqual(expected);
  });
});
