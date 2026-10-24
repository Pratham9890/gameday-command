import { describe, expect, it } from 'vitest';
import type { CellKind, MapBundle, VehicleFrame } from '../../contracts.ts';
import { CONTRACT_VERSION, VEHICLE_KINDS, VEHICLE_STATES } from '../../contracts.ts';
import { FLOW_FREE, FLOW_JAM, FLOW_SLOW, flowLevel, policeHotspots, trafficFlow } from './congestion.ts';

const W = 60;
const H = 60;
const map: MapBundle = {
  version: CONTRACT_VERSION,
  id: 't',
  name: 't',
  width: W,
  height: H,
  cells: Array.from({ length: W * H }, (_, i): CellKind => (i % W < 10 ? 'stands' : 'road')),
  places: [],
  closables: [],
  sources: [],
};
const places = { describe: (cell: number) => `cell ${cell}` };
const S = (name: (typeof VEHICLE_STATES)[number]) => VEHICLE_STATES.indexOf(name);

function vehicles(list: { x: number; y: number; speed: number; state: (typeof VEHICLE_STATES)[number] }[]): VehicleFrame {
  return {
    x: Float32Array.from(list.map((v) => v.x)),
    y: Float32Array.from(list.map((v) => v.y)),
    heading: new Float32Array(list.length),
    speed: Float32Array.from(list.map((v) => v.speed)),
    kind: Uint8Array.from(list.map(() => VEHICLE_KINDS.indexOf('sedan'))),
    state: Uint8Array.from(list.map((v) => S(v.state))),
    waitedS: new Float32Array(list.length),
  };
}

describe('congestion', () => {
  it('grades traffic by speed', () => {
    expect(flowLevel(S('driving'), 12)).toBe(FLOW_FREE);
    expect(flowLevel(S('driving'), 3)).toBe(FLOW_SLOW);
    expect(flowLevel(S('driving'), 0.5)).toBe(FLOW_JAM);
    expect(flowLevel(S('stopped'), 9)).toBe(FLOW_JAM);
  });

  it('paints moving vehicles onto the road and ignores parked ones', () => {
    const flow = trafficFlow(map, vehicles([
      { x: 60, y: 60, speed: 12, state: 'driving' },
      { x: 90, y: 90, speed: 0, state: 'stopped' },
      { x: 100, y: 30, speed: 0, state: 'parked' },
    ]));
    expect(flow[30 * W + 30]).toBe(FLOW_FREE);
    expect(flow[45 * W + 45]).toBe(FLOW_JAM);
    expect(flow[15 * W + 50]).toBe(0);
  });

  it('ranks a packed standing crowd and a jam, and leaves seated stands out', () => {
    const density = new Float32Array(W * H);
    // A full section of stands: dense but seated, so not a hotspot.
    for (let y = 0; y < 20; y++) for (let x = 0; x < 10; x++) density[y * W + x] = 5;
    // A packed standing crowd on the street.
    for (let y = 40; y < 46; y++) for (let x = 40; x < 50; x++) density[y * W + x] = 4.5;
    const jam = vehicles(Array.from({ length: 6 }, (_, i) => ({ x: 30 + i * 6, y: 20, speed: 0, state: 'stopped' as const })));
    const spots = policeHotspots(map, density, jam, places, 4);
    expect(spots.length).toBe(2);
    expect(spots[0]!.kind).toBe('crowd');
    // At danger density but about a thousand people: high, not critical.
    expect(spots[0]!.level).toBe('high');
    expect(spots[1]!.kind).toBe('traffic');
    expect(spots[1]!.stoppedVehicles).toBe(6);
    expect(spots.every((s) => s.cx > 20)).toBe(true);
  });

  it('calls a big packed crowd critical', () => {
    const density = new Float32Array(W * H);
    for (let y = 10; y < 50; y++) for (let x = 20; x < 40; x++) density[y * W + x] = 5;
    const spots = policeHotspots(map, density, undefined, places, 4);
    expect(spots[0]!.level).toBe('critical');
    expect(spots[0]!.crowdedPeople).toBeGreaterThan(3000);
  });
});
