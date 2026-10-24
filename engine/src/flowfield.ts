import type { CellKind, Id, MapBundle } from '../../contracts.ts';

/** Direction codes 1..8 clockwise from east; 0 means "nowhere to go". */
export const DIR_DX = [0, 1, 1, 0, -1, -1, -1, 0, 1] as const;
export const DIR_DY = [0, 0, 1, 1, 1, 0, -1, -1, -1] as const;
export const UNREACHABLE = 0xffff;

/**
 * Base cost of one step on this kind, before the sidewalk discount.
 * Must be at least 1 and at most MAX_STEP_COST. Only the ratios matter: a
 * cheaper kind draws routes onto it, at the price of a longer walk.
 */
export function stepCost(kind: CellKind): number {
  // Roads are where the cars are (traffic.ts drives them), so a walker pays
  // well over double to stand on one: crossing a street costs a few steps,
  // walking down the middle of it is never worth it. Before this a street was
  // the cheapest kind and 43% of every on-foot dot-step was spent on asphalt.
  switch (kind) {
    case 'road':
      return 32;
    case 'blocked':
      return MAX_STEP_COST;
    default:
      return 12;
  }
}

/**
 * A walk cell this close to a road (in cells, any direction) is sidewalk.
 * Two cells is 4 m, which covers a stadium-district sidewalk and its verge.
 */
export const SIDEWALK_REACH = 2;

/**
 * One step on sidewalk. Only a twelfth cheaper than open ground, on purpose:
 * a strong discount (2 against 3) funnelled whole crowds into the strip beside
 * each street, and gate admissions by half an hour after kickoff fell from
 * 76,835 to 54,070. At this ratio a route still keeps to the sidewalk along a
 * street, but a crowd spreads across open ground the way it did before.
 */
export const SIDEWALK_STEP = 11;

/** The ceiling on `stepCost`, which sizes the bucket queue below. */
export const MAX_STEP_COST = 32;

/** Distance units of one step on open ground, for thresholds written in steps. */
export const WALK_STEP = stepCost('walk');

export interface FlowField {
  /** Route cost including sidewalk discounts, UNREACHABLE where there is no route. */
  dist: Uint16Array;
  /** Which way to walk from this cell, as a DIR_* index. */
  dir: Uint8Array;
}

/**
 * One distance field per destination, built outward from the destination's
 * own cells, then frozen into a direction byte per cell. Steps are weighted by
 * precomputed cell costs: sidewalks beside roads are cheapest, open ground
 * is normal, and roads cost more so pedestrians cross them without following
 * vehicle lanes. Cell kinds never change, so neighbourhoods are scanned once.
 *
 * Precomputing the direction is what keeps the step loop cheap: moving a dot is
 * one array read, not eight comparisons. Fields are built lazily and thrown away
 * whenever a gate or street closes, because a closure changes every route.
 */
export class FlowFields {
  private readonly map: MapBundle;
  private readonly costs: Uint8Array;
  private readonly cache = new Map<number, FlowField>();
  private closedCells: Set<number> = new Set();

  constructor(map: MapBundle) {
    this.map = map;
    const { width, height, cells } = map;
    this.costs = Uint8Array.from(cells, stepCost);
    // Only open ground becomes sidewalk: lots and the bowl keep their cost.
    const r = SIDEWALK_REACH;
    for (let cell = 0; cell < cells.length; cell++) {
      if (cells[cell] !== 'walk') continue;
      const x = cell % width;
      const y = (cell / width) | 0;
      let nearRoad = false;
      for (let ny = Math.max(0, y - r); ny <= Math.min(height - 1, y + r) && !nearRoad; ny++) {
        for (let nx = Math.max(0, x - r); nx <= Math.min(width - 1, x + r); nx++) {
          if (cells[ny * width + nx] === 'road') {
            nearRoad = true;
            break;
          }
        }
      }
      if (nearRoad) this.costs[cell] = SIDEWALK_STEP;
    }
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

    // Dial's algorithm: Dijkstra with a bucket per distance mod (max cost + 1).
    // Costs are small integers, so this stays a flat queue walk like the BFS
    // it replaced, with no heap.
    const buckets: number[][] = Array.from({ length: MAX_STEP_COST + 1 }, () => []);
    let pending = 0;
    for (const cell of place.cells) {
      if (cell < 0 || cell >= size || cells[cell] === 'blocked') continue;
      if (dist[cell] === 0) continue;
      dist[cell] = 0;
      buckets[0]!.push(cell);
      pending++;
    }

    // A destination is reachable even when its own door is shut, so that queued
    // dots still know which way the gate is; the door itself blocks admission.
    for (let at = 0; pending > 0; at++) {
      const bucket = buckets[at % buckets.length]!;
      while (bucket.length > 0) {
        const cell = bucket.pop()!;
        pending--;
        if (dist[cell] !== at) continue; // a stale entry, already settled cheaper
        const cx = cell % width;
        const cy = (cell / width) | 0;
        for (let d = 1; d <= 7; d += 2) {
          const nx = cx + DIR_DX[d]!;
          const ny = cy + DIR_DY[d]!;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const neighbour = ny * width + nx;
          if (!this.open(neighbour, avoidInterior, seeds)) continue;
          const next = at + this.costs[neighbour]!;
          if (next >= UNREACHABLE || dist[neighbour]! <= next) continue;
          dist[neighbour] = next;
          buckets[next % buckets.length]!.push(neighbour);
          pending++;
        }
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
