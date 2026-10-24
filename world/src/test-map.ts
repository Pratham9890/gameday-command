import type { CellKind, MapBundle, Place } from '../../contracts.ts';
import { CONTRACT_VERSION } from '../../contracts.ts';

/**
 * Tiny hand-countable map: 20x16 cells at CELL_SIZE_M (40 m x 32 m).
 *
 * Layout by row, north at the top:
 *   0-1   stands        (place "test-stands")
 *   2     concourse     (place "test-concourse")
 *   3     wall, pierced by three one-cell gates at x = 3, 10, 17
 *   4-10  open plaza    (walk)
 *   11-15 parking       (place "test-lot")
 *
 * Numbers are round on purpose: 3 gates x 60 people/min = 180 people/min, so
 * 900 fans (180 dots) clear in exactly 5 minutes with no interference. The
 * scorecard test in /world leans on that.
 */
export const TEST_MAP_WIDTH = 20;
export const TEST_MAP_HEIGHT = 16;
export const TEST_GATE_XS = [3, 10, 17] as const;
export const TEST_GATE_THROUGHPUT_PER_MIN = 60;

const cell = (x: number, y: number) => y * TEST_MAP_WIDTH + x;
const rowCells = (y: number) => Array.from({ length: TEST_MAP_WIDTH }, (_, x) => cell(x, y));

function buildCells(): CellKind[] {
  const cells: CellKind[] = [];
  for (let y = 0; y < TEST_MAP_HEIGHT; y++) {
    for (let x = 0; x < TEST_MAP_WIDTH; x++) {
      let kind: CellKind;
      if (y <= 1) kind = 'stands';
      else if (y === 2) kind = 'concourse';
      else if (y === 3) kind = TEST_GATE_XS.includes(x as 3 | 10 | 17) ? 'walk' : 'blocked';
      else if (y <= 10) kind = 'walk';
      else kind = 'parking';
      cells.push(kind);
    }
  }
  return cells;
}

function buildPlaces(): Place[] {
  const gates: Place[] = TEST_GATE_XS.map((x, i) => ({
    id: `test-gate-${'abc'[i]}`,
    name: `Gate ${i + 1}`,
    kind: 'gate',
    cells: [cell(x, 3)],
    capacity: 300,
    throughputPerMin: TEST_GATE_THROUGHPUT_PER_MIN,
  }));
  return [
    ...gates,
    { id: 'test-stands', name: 'Stands', kind: 'seating', cells: [...rowCells(0), ...rowCells(1)], capacity: 1200 },
    { id: 'test-concourse', name: 'North concourse', kind: 'concourse', cells: rowCells(2), capacity: 400 },
    { id: 'test-lot', name: 'Lot 1', kind: 'parking', cells: [11, 12, 13, 14, 15].flatMap(rowCells), capacity: 1200 },
  ];
}

export function makeTestMap(): MapBundle {
  return {
    version: CONTRACT_VERSION,
    id: 'test-3gate',
    name: 'Test map, 3 gates',
    width: TEST_MAP_WIDTH,
    height: TEST_MAP_HEIGHT,
    cells: buildCells(),
    places: buildPlaces(),
    closables: [
      ...TEST_GATE_XS.map((x, i) => ({
        id: `test-gate-${'abc'[i]}-door`,
        name: `Gate ${i + 1} door`,
        cells: [cell(x, 3)],
      })),
      { id: 'test-plaza-lane', name: 'Plaza lane', cells: rowCells(7) },
    ],
    sources: [{ label: 'Hand-built test fixture', url: 'local' }],
  };
}
