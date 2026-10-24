import { describe, expect, it } from 'vitest';
import { CELL_SIZE_M, CONTRACT_VERSION, type MapBundle } from '../../contracts.ts';
import { barricadeAt } from './barricade.ts';

function roadMap(): MapBundle {
  const cells: MapBundle['cells'] = Array(600).fill('walk');
  for (let x = 0; x < 60; x++) cells[300 + x] = 'road';
  return {
    version: CONTRACT_VERSION,
    id: 'roads', name: 'Road test', width: 60, height: 10, cells,
    places: [{ id: 'gate', name: 'Gate 1', kind: 'gate', cells: [125, 126], capacity: 100 }],
    closables: [
      { id: 'main', name: 'Main Street', cells: [303, 304, 305] },
      { id: 'door', name: 'Gate 1 door', cells: [125] },
    ],
    streets: [{ name: 'Main Street', kind: 'residential', points: [0, 11, 120, 11] }],
    sources: [],
  };
}

describe('barricadeAt', () => {
  it('returns a named street closure without changing its cells', () => {
    expect(barricadeAt(roadMap(), 304)).toEqual({
      closableId: 'main', name: 'Main Street', cells: [303, 304, 305], existing: true,
    });
  });

  it('covers a contiguous road stretch up to 40 metres either side of the click', () => {
    const map = roadMap();
    const before = structuredClone(map);
    const result = barricadeAt(map, 330)!;
    expect(result.closableId).toBe('barricade-330');
    expect(result.existing).toBe(false);
    expect(result.name).toBe('Barricade on Main Street');
    expect(result.cells).toContain(330);
    expect([...result.cells].sort((a, b) => a - b)).toEqual(Array.from({ length: 41 }, (_, i) => 310 + i));
    for (const cell of result.cells) {
      expect(map.cells[cell]).toBe('road');
      expect(Math.abs(cell - 330) * CELL_SIZE_M).toBeLessThanOrEqual(40);
    }
    expect(barricadeAt(map, 330)).toEqual(result);
    expect(map).toEqual(before);
  });

  it('does not barricade walking areas or gate doors', () => {
    const map = roadMap();
    expect(barricadeAt(map, 100)).toBeNull();
    expect(barricadeAt(map, 125)).toBeNull();
  });

  it('snaps a click a step or two off the road onto it', () => {
    const map = roadMap();
    // The road is row 5 of a 60-wide map. Two rows north: still that street.
    expect(barricadeAt(map, 3 * 60 + 30)?.closableId).toBe('barricade-330');
    // Four rows away is not.
    expect(barricadeAt(map, 1 * 60 + 30)).toBeNull();
  });

  it('skips a gate door even when it is the first overlapping closable', () => {
    const map = roadMap();
    map.closables.unshift({ id: 'overlap', name: 'Gate approach', cells: [125, 304] });
    expect(barricadeAt(map, 304)?.closableId).toBe('main');
  });

  it('stops at gaps and measures reach along turns instead of straight-line distance', () => {
    const map = roadMap();
    map.cells.fill('walk');
    map.closables = [];
    for (const cell of [300, 301, 302, 242, 182, 181, 180, 299]) map.cells[cell] = 'road';
    expect(barricadeAt(map, 300, 8)?.cells.sort((a, b) => a - b)).toEqual([182, 242, 300, 301, 302]);
    expect(barricadeAt(map, 300, 0)?.cells).toEqual([300]);
  });

  it('uses metre coordinates when there is no nearby named street', () => {
    const map = roadMap();
    map.streets = [{ name: 'Far Road', kind: 'residential', points: [0, 100, 120, 100] }];
    expect(barricadeAt(map, 330)?.name).toBe('Barricade at 61, 11 m');
    map.streets = undefined;
    expect(barricadeAt(map, 330)?.name).toBe('Barricade at 61, 11 m');
  });
});
