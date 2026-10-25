import { describe, expect, it } from 'vitest';
import type { CellKind, MapBundle, Place, VehicleFrame } from '../../contracts.ts';
import { CONTRACT_VERSION, VEHICLE_KINDS, VEHICLE_STATES } from '../../contracts.ts';
import { FLOW_FREE, FLOW_JAM, FLOW_SLOW, flowLevel, policeHotspots, trafficFlow } from './congestion.ts';
import { makePlaceIndex } from './heat.ts';

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

/**
 * The shipped map's attribution bugs (B7): "On Olentangy Freeway — 5,000 packed"
 * and "Concourse by Gate 10 — 66 stopped". This fixture reproduces both shapes:
 * a motorway strip, its verge, a concourse with a street beside it, and gates to
 * name the walkable features. Street classes ride in `map.streets`, as they do
 * on the real map.
 */
const FW = 60;
const fwCells: CellKind[] = new Array(FW * FW).fill('walk');
// Olentangy Freeway: a six-cell-wide road strip north to south, like SR-315.
for (let y = 0; y < FW; y++) for (let x = 20; x <= 25; x++) fwCells[y * FW + x] = 'road';
// The concourse and the road that runs past it.
for (let y = 40; y <= 47; y++) for (let x = 40; x <= 47; x++) fwCells[y * FW + x] = 'concourse';
for (let y = 35; y <= 50; y++) for (let x = 50; x <= 55; x++) fwCells[y * FW + x] = 'road';

const gates: Place[] = [
  { id: 'gate-9', name: 'Gate 9 (WSW)', kind: 'gate', cells: [30 * FW + 30], capacity: 1000, throughputPerMin: 200 },
  { id: 'gate-10', name: 'Gate 10 (W)', kind: 'gate', cells: [44 * FW + 36], capacity: 1000, throughputPerMin: 200 },
];

const freewayCells: number[] = [];
for (let y = 0; y < FW; y++) for (let x = 20; x <= 25; x++) freewayCells.push(y * FW + x);

const fwMap: MapBundle = {
  version: CONTRACT_VERSION,
  id: 'fw',
  name: 'fw',
  width: FW,
  height: FW,
  cells: fwCells,
  places: gates,
  closables: [{ id: 'street-olentangy-freeway', name: 'Olentangy Freeway', cells: freewayCells }],
  sources: [],
  streets: [{ name: 'Olentangy Freeway', kind: 'motorway', points: [] }],
};

const fill = (density: Float32Array, x0: number, x1: number, y0: number, y1: number, value: number) => {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) density[y * FW + x] = value;
};

describe('congestion attribution on a freeway and a concourse', () => {
  it('counts a crowd that really is on the freeway, but names a walkable feature', () => {
    const density = new Float32Array(FW * FW);
    // Pedestrians standing on the motorway's own road cells.
    fill(density, 20, 25, 28, 33, 4.5);
    // The old naming: describe() calls the freeway cell what it is.
    expect(makePlaceIndex(fwMap).describe(30 * FW + 22)).toBe('On Olentangy Freeway');

    const spots = policeHotspots(fwMap, density, undefined, makePlaceIndex(fwMap), 4);
    expect(spots.length).toBe(1);
    expect(spots[0]!.kind).toBe('crowd');
    expect(spots[0]!.stoppedVehicles).toBe(0);
    expect(spots[0]!.crowdedPeople).toBeGreaterThan(30);
    expect(spots[0]!.where).not.toMatch(/Freeway/);
    expect(spots[0]!.where).toBe('Outside Gate 9 (WSW)');
  });

  it('does not name a crowd on the verge after the freeway beside it', () => {
    const density = new Float32Array(FW * FW);
    // Walkable cells within three cells of the freeway: describe() used to call
    // these "On Olentangy Freeway" too.
    fill(density, 26, 29, 28, 33, 4.5);
    expect(makePlaceIndex(fwMap).describe(30 * FW + 27)).toBe('On Olentangy Freeway');

    const spots = policeHotspots(fwMap, density, undefined, makePlaceIndex(fwMap), 4);
    expect(spots[0]!.where).not.toMatch(/Freeway/);
    expect(spots[0]!.where).toBe('Outside Gate 9 (WSW)');
  });

  it('leaves a vehicle on a concourse cell out of the count', () => {
    const jam = vehicles([
      { x: 105, y: 81, speed: 0, state: 'stopped' }, // road cell, x 52 y 40
      { x: 105, y: 83, speed: 0, state: 'stopped' }, // road cell, x 52 y 41
      { x: 89, y: 89, speed: 0, state: 'stopped' }, // concourse cell, x 44 y 44
    ]);
    expect(fwMap.cells[44 * FW + 44]).toBe('concourse');

    const spots = policeHotspots(fwMap, undefined, jam, makePlaceIndex(fwMap), 4);
    expect(spots.length).toBe(1);
    expect(spots[0]!.kind).toBe('traffic');
    expect(spots[0]!.stoppedVehicles).toBe(2);
  });

  it('still counts and names a crowd on the concourse', () => {
    const density = new Float32Array(FW * FW);
    fill(density, 40, 47, 40, 47, 4.5);
    const spots = policeHotspots(fwMap, density, undefined, makePlaceIndex(fwMap), 4);
    expect(spots[0]!.kind).toBe('crowd');
    expect(spots[0]!.where).toBe('Concourse by Gate 10 (W)');
  });

  it('names a jam on the freeway after the freeway, because the cars are there', () => {
    const jam = vehicles([
      { x: 45, y: 61, speed: 0, state: 'stopped' },
      { x: 47, y: 61, speed: 0, state: 'stopped' },
      { x: 49, y: 61, speed: 0, state: 'stopped' },
    ]);
    const spots = policeHotspots(fwMap, undefined, jam, makePlaceIndex(fwMap), 4);
    expect(spots[0]!.kind).toBe('traffic');
    expect(spots[0]!.stoppedVehicles).toBe(3);
    expect(spots[0]!.where).toBe('On Olentangy Freeway');
  });
});
