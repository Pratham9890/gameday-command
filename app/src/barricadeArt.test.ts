import { describe, expect, it } from 'vitest';
import { CONTRACT_VERSION, type MapBundle } from '../../contracts.ts';
import type { SceneInfo } from '../../engine/src/edits.ts';
import { barricadePlacements, buildBarricades, closedAreas, closureKey, streetCellAt } from './barricadeArt.ts';
import { diagonalZ, personZ, vehicleDiagonal } from './depth.ts';

function roadMap(): MapBundle {
  return {
    version: CONTRACT_VERSION, id: 'road', name: 'Road', width: 30, height: 12,
    cells: Array.from({ length: 360 }, (_, c) => Math.floor(c / 30) >= 4 && Math.floor(c / 30) <= 6 ? 'road' : 'walk'),
    places: [], closables: [], sources: [],
  };
}
const scene = (closed: string[], barricades: SceneInfo['barricades'] = []): SceneInfo =>
  ({ t: 0, officers: [], gates: [], alerts: [], closed, barricades });

describe('barricade placement and depth', () => {
  it('spans the road at both ends and places intermediate barriers', () => {
    const map = roadMap();
    const cells = Array.from({ length: 21 }, (_, x) => 5 * map.width + x + 3);
    const pieces = barricadePlacements(cells, map.width, (c) => map.cells[c], false);
    for (const x of [7, 47]) {
      const row = pieces.filter((p) => Math.abs(p.x - x) < 0.01);
      expect(row.map((p) => p.y).sort((a, b) => a - b)).toEqual([9, 11, 13]);
      for (const p of row) expect(p.angle).toBeCloseTo(Math.PI / 2);
    }
    expect(pieces.some((p) => p.x > 7 && p.x < 47)).toBe(true);
  });

  it('places a row along gate doorway cells', () => {
    const map = roadMap();
    const cells = [123, 124, 125, 126];
    const pieces = barricadePlacements(cells, map.width, (c) => map.cells[c], true);
    expect(pieces.map((p) => [p.x, p.y])).toEqual([[7, 9], [9, 9], [11, 9], [13, 9]]);
    for (const p of pieces) {
      expect(p.angle).toBeCloseTo(0);
      expect(p.kind).toBe('sawhorse');
    }
  });

  it('caps pieces on long streets and doors, and accepts empty closures', () => {
    const cells = Array.from({ length: 10000 }, (_, c) => c);
    for (const gate of [false, true]) {
      const pieces = barricadePlacements(cells, 10000, (c) => c >= 0 && c < 10000 ? 'road' : undefined, gate);
      expect(pieces.length).toBeGreaterThan(0);
      expect(pieces.length).toBeLessThanOrEqual(96);
    }
    expect(barricadePlacements([], 30, () => 'road', false)).toEqual([]);
  });

  it('groups geometry and independent lights by front-most diagonal between fans', () => {
    const pieces = [10, 2, 6].map((x) => ({ x, y: x, angle: 0, kind: 'jersey' as const }));
    const groups = buildBarricades(pieces);
    expect(groups.map((g) => g.d)).toEqual([2, 6, 10]);
    for (const group of groups) {
      expect(group.body.zIndex).toBeGreaterThan(diagonalZ(group.d));
      expect(group.body.zIndex).toBeLessThan(personZ(group.d * 2, 0));
      expect(group.body.zIndex).toBeGreaterThan(personZ((group.d - 1) * 2, 0));
      expect(group.lights.zIndex).toBeGreaterThan(group.body.zIndex);
      group.body.destroy();
      group.lights.destroy();
    }
    for (const p of pieces) expect(groups.some((g) => g.d === vehicleDiagonal(p.x, p.y, p.angle, 2, 0.6))).toBe(true);
  });
});

it('merges closed map and live areas without duplicates and invalidates moved/renamed barricades', () => {
  const map = roadMap();
  map.closables = [{ id: 'street', name: 'Street', cells: [153, 154] }];
  const live = { id: 'live', name: 'Custom', cells: [157, 158] };
  const info = scene(['street', 'live'], [map.closables[0]!, live, { id: 'open', name: 'Open', cells: [159] }]);
  expect(closedAreas(map, info).map((a) => a.id)).toEqual(['street', 'live']);
  expect(closedAreas(map, null)).toEqual([]);
  expect(closureKey(info)).toBe(closureKey({ ...info, closed: ['live', 'street'] }));
  expect(closureKey(info)).not.toBe(closureKey({ ...info, barricades: info.barricades!.map((b) => b.id === live.id ? { ...b, cells: [158, 159] } : b) }));
  expect(closureKey(info)).not.toBe(closureKey({ ...info, barricades: info.barricades!.map((b) => b.id === live.id ? { ...b, name: 'Moved' } : b) }));
});

it('recognises gates by overlapping cells, with the marker along the doorway', () => {
  const map = roadMap();
  map.closables = [{ id: 'door', name: 'Door', cells: [123, 124, 125] }];
  map.places = [{ id: 'gate', name: 'Gate', kind: 'gate', cells: [124], capacity: 100 }];
  const [area] = closedAreas(map, scene(['door']));
  expect(area?.isGate).toBe(true);
  expect(area?.angle).toBeCloseTo(0);
  expect(area?.x).toBe(9);
  expect(area?.y).toBe(9);
});

it('accepts roads and adjacent walks, rejects other cells and row wrapping', () => {
  const map = roadMap();
  map.cells[30] = 'road';
  map.cells[90] = 'blocked';
  for (const cell of [150, 91, 210]) expect(streetCellAt(map, cell)).toBe(true);
  for (const cell of [61, 90, 29, -1, 360, 1.5, NaN]) expect(streetCellAt(map, cell)).toBe(false);
});
