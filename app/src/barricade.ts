import { CELL_SIZE_M, type MapBundle } from '../../contracts.ts';

/** Gate doors belong in the gate controls, not the street barricade list. */
export function isGateDoor(map: MapBundle, closable: MapBundle['closables'][number]): boolean {
  return map.places.some((p) => p.kind === 'gate' && p.cells.some((cell) => closable.cells.includes(cell)));
}

/** Find a named closure or a connected road stretch within walking reach of a click. */
/** How far a click may land from a road, in cells, and still mean it. */
const SNAP_CELLS = 3;

/** The road cell nearest to this one within SNAP_CELLS, or -1. */
function nearestRoad(map: MapBundle, cell: number): number {
  if (!Number.isInteger(cell) || cell < 0 || cell >= map.width * map.height) return -1;
  if (map.cells[cell] === 'road') return cell;
  const cx = cell % map.width;
  const cy = Math.floor(cell / map.width);
  let best = -1;
  let bestSq = Infinity;
  for (let dy = -SNAP_CELLS; dy <= SNAP_CELLS; dy++) {
    for (let dx = -SNAP_CELLS; dx <= SNAP_CELLS; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= map.width || y >= map.height) continue;
      const sq = dx * dx + dy * dy;
      if (map.cells[y * map.width + x] === 'road' && sq < bestSq) {
        bestSq = sq;
        best = y * map.width + x;
      }
    }
  }
  return best;
}

export function barricadeAt(
  map: MapBundle,
  cell: number,
  reachM = 40,
): { closableId: string; name: string; cells: number[]; existing: boolean } | null {
  // A road is a few 2 m cells wide and the view is tilted, so a click a step
  // or two off the asphalt still means that street: snap to the nearest road
  // cell within SNAP_CELLS. Exact hits were rare enough that clicks just failed.
  // A click on a gate's own doorway is about the gate, not a street beside it.
  if (map.places.some((p) => p.kind === 'gate' && p.cells.includes(cell))) return null;
  cell = nearestRoad(map, cell);
  if (cell < 0) return null;
  const existing = map.closables.find((c) => c.cells.includes(cell) && !isGateDoor(map, c));
  if (existing) return { closableId: existing.id, name: existing.name, cells: [...existing.cells], existing: true };

  // Four-way steps cannot jump diagonally across a pavement corner, and each
  // BFS level costs exactly CELL_SIZE_M metres along the road.
  const cells = [cell];
  const distance = new Map([[cell, 0]]);
  for (let head = 0; head < cells.length; head++) {
    const at = cells[head]!;
    const nextDistance = distance.get(at)! + CELL_SIZE_M;
    if (nextDistance > reachM) continue;
    const x = at % map.width;
    const y = Math.floor(at / map.width);
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= map.width || ny < 0 || ny >= map.height) continue;
      const next = ny * map.width + nx;
      if (map.cells[next] !== 'road' || distance.has(next)) continue;
      distance.set(next, nextDistance);
      cells.push(next);
    }
  }

  const x = (cell % map.width + 0.5) * CELL_SIZE_M;
  const y = (Math.floor(cell / map.width) + 0.5) * CELL_SIZE_M;
  let nearest = 10;
  let streetName = '';
  for (const street of map.streets ?? []) {
    if (!street.name) continue;
    for (let i = 0; i + 1 < street.points.length; i += 2) {
      const ax = street.points[i]!;
      const ay = street.points[i + 1]!;
      const dx = (street.points[i + 2] ?? ax) - ax;
      const dy = (street.points[i + 3] ?? ay) - ay;
      const length2 = dx * dx + dy * dy;
      // OSM vertices can be far apart; the nearest point may lie between them.
      const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / length2));
      const distanceM = Math.hypot(x - ax - t * dx, y - ay - t * dy);
      if (distanceM <= nearest) {
        nearest = distanceM;
        streetName = street.name;
      }
    }
  }
  return {
    closableId: `barricade-${cell}`,
    name: streetName ? `Barricade on ${streetName}` : `Barricade at ${x}, ${y} m`,
    cells,
    existing: false,
  };
}
