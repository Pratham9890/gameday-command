import { CELL_SIZE_M, type MapBundle } from '../../contracts.ts';

/** Gate doors belong in the gate controls, not the street barricade list. */
export function isGateDoor(map: MapBundle, closable: MapBundle['closables'][number]): boolean {
  return map.places.some((p) => p.kind === 'gate' && p.cells.some((cell) => closable.cells.includes(cell)));
}

/** Find a named closure or a connected road stretch within walking reach of a click. */
export function barricadeAt(
  map: MapBundle,
  cell: number,
  reachM = 40,
): { closableId: string; name: string; cells: number[]; existing: boolean } | null {
  const existing = map.closables.find((c) => c.cells.includes(cell) && !isGateDoor(map, c));
  if (existing) return { closableId: existing.id, name: existing.name, cells: [...existing.cells], existing: true };
  if (map.cells[cell] !== 'road') return null;

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
