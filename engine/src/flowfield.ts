import type { Id, MapBundle } from '../../contracts.ts';

/** Direction codes 1..8 clockwise from east; 0 means "nowhere to go". */
export const DIR_DX = [0, 1, 1, 0, -1, -1, -1, 0, 1] as const;
export const DIR_DY = [0, 0, 1, 1, 1, 0, -1, -1, -1] as const;
export const UNREACHABLE = 0xffff;

export interface FlowField {
  /** Steps to the destination, UNREACHABLE where there is no route. */
  dist: Uint16Array;
  /** Which way to walk from this cell, as a DIR_* index. */
  dir: Uint8Array;
}

/**
 * One distance field per destination, built by multi-source BFS from the
 * destination's own cells outward, then frozen into a direction byte per cell.
 *
 * Precomputing the direction is what keeps the step loop cheap: moving a dot is
 * one array read, not eight comparisons. Fields are built lazily and thrown away
 * whenever a gate or street closes, because a closure changes every route.
 */
export class FlowFields {
  private readonly map: MapBundle;
  private readonly cache = new Map<number, FlowField>();
  private readonly queue: Int32Array;
  private closedCells: Set<number> = new Set();

  constructor(map: MapBundle) {
    this.map = map;
    this.queue = new Int32Array(map.width * map.height);
  }

  /** Recompute which cells are shut, and drop every cached field if it changed. */
  setClosed(closedIds: ReadonlySet<Id>): boolean {
    const next = new Set<number>();
    for (const closable of this.map.closables) {
      if (!closedIds.has(closable.id)) continue;
      for (const cell of closable.cells) next.add(cell);
    }
    if (next.size === this.closedCells.size && [...next].every((c) => this.closedCells.has(c))) {
      return false;
    }
    this.closedCells = next;
    this.cache.clear();
    return true;
  }

  isClosed(cell: number): boolean {
    return this.closedCells.has(cell);
  }

  passable(cell: number): boolean {
    return this.map.cells[cell] !== 'blocked' && !this.closedCells.has(cell);
  }

  /** Passability for one field, which may refuse to route through the bowl. */
  private open(cell: number, avoidInterior: boolean, seeds: Set<number>): boolean {
    if (!this.passable(cell)) return false;
    if (!avoidInterior || seeds.has(cell)) return true;
    const kind = this.map.cells[cell];
    return kind !== 'stands' && kind !== 'concourse';
  }

  /**
   * `avoidInterior` keeps a route from cutting through the stadium bowl.
   *
   * The deck and concourse are walkable, so a plain field happily routes a fan
   * in the north lot to an east gate straight through the Horseshoe and out the
   * other side — which is not a thing you can do, and which jammed every gate
   * mouth with people who did not want that gate. Gates are approached from
   * outside; routes that start inside (leaving for the lots) use the plain field.
   */
  field(placeIndex: number, avoidInterior = false): FlowField {
    const key = placeIndex * 2 + (avoidInterior ? 1 : 0);
    const cached = this.cache.get(key);
    if (cached) return cached;
    const field = this.build(placeIndex, avoidInterior);
    this.cache.set(key, field);
    return field;
  }

  private build(placeIndex: number, avoidInterior: boolean): FlowField {
    const { width, height, cells } = this.map;
    const size = width * height;
    const dist = new Uint16Array(size).fill(UNREACHABLE);
    const dir = new Uint8Array(size);
    const place = this.map.places[placeIndex];
    if (!place) return { dist, dir };
    const seeds = new Set(place.cells);

    // Multi-source BFS: every cell of the destination starts at distance 0.
    let head = 0;
    let tail = 0;
    for (const cell of place.cells) {
      if (cell < 0 || cell >= size || cells[cell] === 'blocked') continue;
      if (dist[cell] === 0) continue;
      dist[cell] = 0;
      this.queue[tail++] = cell;
    }

    // A destination is reachable even when its own door is shut, so that queued
    // dots still know which way the gate is; the door itself blocks admission.
    while (head < tail) {
      const cell = this.queue[head++]!;
      const cx = cell % width;
      const cy = (cell / width) | 0;
      const next = dist[cell]! + 1;
      for (let d = 1; d <= 7; d += 2) {
        const nx = cx + DIR_DX[d]!;
        const ny = cy + DIR_DY[d]!;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const neighbour = ny * width + nx;
        if (!this.open(neighbour, avoidInterior, seeds)) continue;
        if (dist[neighbour]! <= next) continue;
        dist[neighbour] = next;
        this.queue[tail++] = neighbour;
      }
    }

    for (let cell = 0; cell < size; cell++) {
      if (dist[cell] === UNREACHABLE || dist[cell] === 0) continue;
      const cx = cell % width;
      const cy = (cell / width) | 0;
      let best = dist[cell]!;
      let bestDir = 0;
      for (let d = 1; d <= 8; d++) {
        const nx = cx + DIR_DX[d]!;
        const ny = cy + DIR_DY[d]!;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const neighbour = ny * width + nx;
        if (!this.open(neighbour, avoidInterior, seeds)) continue;
        // No cutting a wall corner on the diagonal.
        if (DIR_DX[d] !== 0 && DIR_DY[d] !== 0) {
          if (!this.open(cy * width + nx, avoidInterior, seeds)) continue;
          if (!this.open(ny * width + cx, avoidInterior, seeds)) continue;
        }
        if (dist[neighbour]! < best) {
          best = dist[neighbour]!;
          bestDir = d;
        }
      }
      dir[cell] = bestDir;
    }

    return { dist, dir };
  }
}
