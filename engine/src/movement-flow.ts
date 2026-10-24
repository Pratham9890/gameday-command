import type { Id, MapBundle, SituationId } from '../../contracts.ts';
import { CELL_SIZE_M, DOT_GROUP_SIZE } from '../../contracts.ts';
import { FlowFields, DIR_DX, DIR_DY, UNREACHABLE } from './flowfield.ts';
import type { MovementModel, SimContext } from './sim.ts';

/**
 * Jam density in people per square meter. Above this nobody moves; the curve
 * below is linear down to a 5% crawl, which puts a visible slowdown right at the
 * 4 people/m² danger line the scorecard counts.
 */
export const RHO_JAM = 5.4;
const MIN_SPEED_FACTOR = 0.05;

export function densityFactor(peoplePerM2: number): number {
  return Math.max(MIN_SPEED_FACTOR, 1 - peoplePerM2 / RHO_JAM);
}

/**
 * How many dots physically fit in one cell before it is full.
 *
 * Without a hard cap, slowing dots down is not enough: they creep into the cell
 * in front at 5% speed and still all end up standing on the same 2 m square, so
 * a gate queue reads as 10,000 people per square meter. Refusing to enter a full
 * cell is what makes a queue back up along the approach instead, which is the
 * behaviour every number on the scorecard depends on.
 */
/** Seconds of unused throughput a gate may hold over, so a lull is not banked. */
const GATE_BURST_S = 5;

/** Straight on, then alternating half-steps either side. */
const SIDESTEPS = [0, -1, 1, -2, 2] as const;
/** The same idea in radians, for the open walk to a seat. */
const SEAT_TURNS = [0, -Math.PI / 4, Math.PI / 4, -Math.PI / 2, Math.PI / 2] as const;

export const MAX_DOTS_PER_CELL = Math.max(1, Math.floor((RHO_JAM * CELL_SIZE_M * CELL_SIZE_M) / DOT_GROUP_SIZE));

/** The real engine: flow fields, gate queues, and speed that falls with density. No AI. */
export class FlowMovement implements MovementModel {
  private fields!: FlowFields;
  private placeMasks = new Map<number, Uint8Array>();
  private gateIndexes: number[] = [];
  private gateDoor = new Map<number, Id>();
  private gateBudget!: Float32Array;
  private seatingIndex = -1;
  private shelterIndex = -1;
  private parkingIndex = -1;
  private exitIndexes: number[] = [];

  private spawnT!: Float32Array;
  private seatCell!: Int32Array;
  private lotCell!: Int32Array;
  private homeGate!: Int32Array;
  private admitted!: Uint8Array;
  private occupancy!: Int32Array;
  private closedKey = '';

  private cellOf(ctx: SimContext, i: number): number {
    const { dots, map } = ctx;
    if (dots.x[i]! < 0 || dots.y[i]! < 0) return -1; // parked off-map, not arrived
    const cx = (dots.x[i]! / CELL_SIZE_M) | 0;
    const cy = (dots.y[i]! / CELL_SIZE_M) | 0;
    if (cx < 0 || cy < 0 || cx >= map.width || cy >= map.height) return -1;
    return cy * map.width + cx;
  }

  private indexOfKind(map: MapBundle, kind: MapBundle['places'][number]['kind']): number {
    return map.places.findIndex((p) => p.kind === kind);
  }

  /**
   * Membership mask for one place, built on first use.
   *
   * A single cell-to-place array cannot answer this: places overlap (every lot
   * cell belongs to both its named lot and the combined "all lots" place), and
   * last-writer-wins would make dots heading for the combined place never
   * register that they arrived.
   */
  private maskOf(ctx: SimContext, placeIndex: number): Uint8Array {
    let mask = this.placeMasks.get(placeIndex);
    if (mask) return mask;
    const { map } = ctx;
    mask = new Uint8Array(map.width * map.height);
    for (const cell of map.places[placeIndex]?.cells ?? []) {
      if (cell >= 0 && cell < mask.length) mask[cell] = 1;
    }
    this.placeMasks.set(placeIndex, mask);
    return mask;
  }

  spawn(ctx: SimContext): void {
    const { map, dots, rng, population } = ctx;
    this.fields = new FlowFields(map);
    this.fields.setClosed(ctx.closed);

    this.placeMasks.clear();

    this.gateIndexes = map.places.map((p, i) => (p.kind === 'gate' ? i : -1)).filter((i) => i >= 0);
    this.gateBudget = new Float32Array(map.places.length);
    for (const gate of this.gateIndexes) {
      const place = map.places[gate]!;
      const door = map.closables.find((c) => c.cells.some((cell) => place.cells.includes(cell)));
      if (door) this.gateDoor.set(gate, door.id);
    }
    this.seatingIndex = this.indexOfKind(map, 'seating');
    this.shelterIndex = this.indexOfKind(map, 'shelter');
    if (this.shelterIndex < 0) this.shelterIndex = this.indexOfKind(map, 'concourse');
    this.parkingIndex = this.indexOfKind(map, 'parking');
    this.exitIndexes = map.places.map((p, i) => (p.kind === 'exit' ? i : -1)).filter((i) => i >= 0);
    if (this.exitIndexes.length === 0) this.exitIndexes = this.gateIndexes;

    // Built with a loop, not push(...spread): a stadium-sized lot is hundreds of
    // thousands of cells and spreading that many arguments overflows the stack.
    const lotCells: number[] = [];
    const lot = this.parkingIndex >= 0 ? map.places[this.parkingIndex] : undefined;
    if (lot) {
      for (const cell of lot.cells) if (this.fields.passable(cell)) lotCells.push(cell);
    }
    if (lotCells.length === 0) {
      for (let i = 0; i < map.cells.length; i++) if (this.fields.passable(i)) lotCells.push(i);
    }

    const cumulative: number[] = [];
    let acc = 0;
    for (const type of population.types) {
      acc += type.share;
      cumulative.push(acc);
    }

    const n = dots.count;
    this.spawnT = new Float32Array(n);
    this.seatCell = new Int32Array(n).fill(-1);
    this.lotCell = new Int32Array(n);
    this.homeGate = new Int32Array(n).fill(-1);
    this.admitted = new Uint8Array(n);
    this.occupancy = new Int32Array(map.width * map.height);

    const seatCells = this.seatingIndex >= 0 ? (map.places[this.seatingIndex]?.cells ?? []) : [];

    for (let i = 0; i < n; i++) {
      const roll = rng.next();
      let typeIndex = cumulative.findIndex((c) => roll < c);
      if (typeIndex < 0) typeIndex = population.types.length - 1;
      dots.typeIndex[i] = typeIndex;

      const type = population.types[typeIndex]!;
      const [from, to] = type.arrivalWindowMin;
      // Minutes before kickoff, so sim time is negative.
      this.spawnT[i] = -(from + (to - from) * rng.next()) * 60;

      const cell = lotCells[rng.int(lotCells.length)]!;
      this.lotCell[i] = cell;

      // Everyone has a seat before they arrive. Without this they all stop at
      // whichever stands cell sits just inside their gate, which stacks
      // thousands of fans on one cell and makes peak density meaningless.
      const seat = seatCells.length > 0 ? seatCells[rng.int(seatCells.length)]! : -1;
      this.seatCell[i] = seat;

      // Your gate is the one by your seat, the way a ticket assigns it — not the
      // one nearest your car. Picking by car funnels the whole crowd through
      // the two or three gates facing the big lots and leaves the rest idle.
      let bestGate = this.gateIndexes[0] ?? -1;
      if (seat >= 0) {
        const sx = seat % map.width;
        const sy = (seat / map.width) | 0;
        let bestSq = Infinity;
        for (const gate of this.gateIndexes) {
          const gc = map.places[gate]!.cells[0]!;
          const dx = (gc % map.width) - sx;
          const dy = ((gc / map.width) | 0) - sy;
          const sq = dx * dx + dy * dy;
          if (sq < bestSq) {
            bestSq = sq;
            bestGate = gate;
          }
        }
      } else {
        let bestDist = UNREACHABLE;
        for (const gate of this.gateIndexes) {
          const d = this.fields.field(gate).dist[cell]!;
          if (d < bestDist) {
            bestDist = d;
            bestGate = gate;
          }
        }
      }
      this.homeGate[i] = bestGate;
      dots.targetPlace[i] = bestGate;

      // Off-map until they arrive: a fan still in their car is not crowd density.
      dots.x[i] = -1;
      dots.y[i] = -1;
      dots.setState(i, 'arriving');
    }
  }

  step(ctx: SimContext, dt: number): void {
    const { map, dots, density, population, rng } = ctx;

    const key = [...ctx.closed].sort().join(',');
    if (key !== this.closedKey) {
      this.closedKey = key;
      this.fields.setClosed(ctx.closed);
    }

    for (const gate of this.gateIndexes) {
      const perMin = map.places[gate]!.throughputPerMin ?? 0;
      const perSecond = perMin / 60 / DOT_GROUP_SIZE;
      // Capped: throughput is a rate, not a bank. Letting it accumulate meant a
      // gate that stood idle for an hour would wave 2,600 fans through in one
      // second the moment the queue reached it.
      this.gateBudget[gate]! = Math.min(this.gateBudget[gate]! + perSecond * dt, Math.max(perSecond * GATE_BURST_S, 1));
    }

    // Occupancy is rebuilt from where the dots actually are, every pass, rather
    // than carried forward. Hand-maintained counts drift — one stale decrement
    // and a cell quietly accepts a fifth dot, which is how a 2 m square ended
    // up reading 13 people per square meter. Rebuilding is O(dots) and makes
    // any slip self-correcting within one step.
    const occupancy = this.occupancy;
    occupancy.fill(0);
    for (let i = 0; i < dots.count; i++) {
      if (dots.stateOf(i) === 'gone') continue;
      const cell = this.cellOf(ctx, i);
      if (cell >= 0) occupancy[cell]!++;
    }

    for (let i = 0; i < dots.count; i++) {
      const state = dots.stateOf(i);
      if (state === 'gone' || state === 'seated' || state === 'sheltering') continue;

      if (state === 'arriving') {
        if (ctx.t < this.spawnT[i]!) continue;
        const cell = this.lotCell[i]!;
        if (occupancy[cell]! >= MAX_DOTS_PER_CELL) continue; // lot cell full, arrive next step
        dots.x[i] = Math.fround(((cell % map.width) + 0.15 + rng.next() * 0.7) * CELL_SIZE_M);
        dots.y[i] = Math.fround((((cell / map.width) | 0) + 0.15 + rng.next() * 0.7) * CELL_SIZE_M);
        occupancy[cell]!++;
        dots.setState(i, 'walking');
      }

      const cell = this.cellOf(ctx, i);
      if (cell < 0) continue;
      const target = dots.targetPlace[i]!;
      if (target < 0) continue;

      // Inside the bowl, head for your own seat rather than the nearest row.
      // The deck is open, so a straight line needs no flow field.
      if (target === this.seatingIndex && this.seatCell[i]! >= 0 && this.maskOf(ctx, target)[cell] === 1) {
        if (this.walkToSeat(ctx, i, dt, occupancy)) dots.setState(i, 'seated');
        continue;
      }

      if (this.maskOf(ctx, target)[cell] === 1) {
        this.arrive(ctx, i, target);
        continue;
      }

      const field = this.fields.field(target);
      const best = field.dir[cell]!;
      if (best === 0) {
        // No route: a closed gate or a sealed street. They wait where they are.
        dots.setState(i, 'queued');
        continue;
      }

      const free = population.types[dots.typeIndex[i]!]?.walkSpeedMps ?? 1.2;
      const stride = free * densityFactor(density.peoplePerM2[cell]!) * dt;
      const here = field.dist[cell]!;

      // Try straight on, then fan out either side. A crowd on one flow field
      // otherwise walks single file and the first dot to stop blocks everyone
      // behind it; sidestepping is what lets a queue spread out and flow round
      // a jam, which is what real crowds do.
      let moved = false;
      for (const turn of SIDESTEPS) {
        const dir = ((best - 1 + turn + 8) % 8) + 1;
        const dx = DIR_DX[dir]!;
        const dy = DIR_DY[dir]!;
        const norm = dx !== 0 && dy !== 0 ? Math.SQRT1_2 : 1;
        // fround: dots.x is a Float32Array, so the stored value is rounded. A
        // position a hair over a cell boundary rounds back across it, and then
        // the dot releases the cell it is still standing in — which quietly
        // leaves room for a fifth dot in a four-dot cell.
        const nx = Math.fround(dots.x[i]! + dx * norm * stride);
        const ny = Math.fround(dots.y[i]! + dy * norm * stride);
        if (nx < 0 || ny < 0 || nx >= map.width * CELL_SIZE_M || ny >= map.height * CELL_SIZE_M) continue;
        const nCell = ((ny / CELL_SIZE_M) | 0) * map.width + ((nx / CELL_SIZE_M) | 0);
        if (nCell === cell) {
          dots.x[i] = nx;
          dots.y[i] = ny;
          dots.setState(i, 'walking');
          moved = true;
          break;
        }
        if (!this.fields.passable(nCell)) continue;
        if (field.dist[nCell]! > here) continue; // never walk away from the target
        if (occupancy[nCell]! >= MAX_DOTS_PER_CELL) continue;
        occupancy[cell]!--;
        occupancy[nCell]!++;
        dots.x[i] = nx;
        dots.y[i] = ny;
        dots.setState(i, 'walking');
        moved = true;
        break;
      }
      // Nowhere to go: every way forward is full. This is the queue.
      if (!moved) dots.setState(i, 'queued');
    }
  }

  /**
   * Walk to an assigned seat inside the bowl. Returns true once seated.
   *
   * The deck is open, so this steers straight at the seat and fans out when the
   * way is blocked rather than using a flow field. It only settles for a
   * different spot once the fan is actually at their seat and finds it taken —
   * settling early meant fans sat down in the gate mouth and corked the gate
   * behind them, which throttled the whole stadium to a trickle.
   */
  private walkToSeat(ctx: SimContext, i: number, dt: number, occupancy: Int32Array): boolean {
    const { dots, map, density, population } = ctx;
    const seat = this.seatCell[i]!;
    const sx = ((seat % map.width) + 0.5) * CELL_SIZE_M;
    const sy = (((seat / map.width) | 0) + 0.5) * CELL_SIZE_M;
    const dx = sx - dots.x[i]!;
    const dy = sy - dots.y[i]!;
    const dist = Math.hypot(dx, dy);
    const cell = this.cellOf(ctx, i);

    if (dist < CELL_SIZE_M * 0.5) return true;

    // At the seat but it is taken: sit down right here.
    if (dist < CELL_SIZE_M * 1.5 && occupancy[seat]! >= MAX_DOTS_PER_CELL) return true;

    const free = population.types[dots.typeIndex[i]!]?.walkSpeedMps ?? 1.2;
    const factor = densityFactor(cell >= 0 ? density.peoplePerM2[cell]! : 0);
    const step = Math.min(free * factor * dt, dist);
    const base = Math.atan2(dy, dx);

    for (const turn of SEAT_TURNS) {
      const angle = base + turn;
      const nx = Math.fround(dots.x[i]! + Math.cos(angle) * step);
      const ny = Math.fround(dots.y[i]! + Math.sin(angle) * step);
      if (nx < 0 || ny < 0 || nx >= map.width * CELL_SIZE_M || ny >= map.height * CELL_SIZE_M) continue;
      const nCell = ((ny / CELL_SIZE_M) | 0) * map.width + ((nx / CELL_SIZE_M) | 0);
      if (nCell !== cell) {
        if (!this.fields.passable(nCell)) continue;
        if (occupancy[nCell]! >= MAX_DOTS_PER_CELL) continue;
        if (cell >= 0) occupancy[cell]!--;
        occupancy[nCell]!++;
      }
      dots.x[i] = nx;
      dots.y[i] = ny;
      if (turn === 0 && step >= dist) return true;
      dots.setState(i, 'walking');
      return false;
    }

    // Hemmed in on every side: wait a step rather than block the aisle for good.
    dots.setState(i, 'queued');
    return false;
  }

  /** What reaching the target means depends on what the target is. */
  private arrive(ctx: SimContext, i: number, target: number): void {
    const { dots, map } = ctx;
    const kind = map.places[target]?.kind;

    if (kind === 'gate') {
      if (this.admitted[i] === 1) return;
      const door = this.gateDoor.get(target);
      const shut = door !== undefined && ctx.closed.has(door);
      if (!shut && this.gateBudget[target]! >= 1) {
        this.gateBudget[target]! -= 1;
        this.admitted[i] = 1;
        dots.targetPlace[i] = this.seatingIndex >= 0 ? this.seatingIndex : -1;
        dots.setState(i, 'walking');
      } else {
        dots.setState(i, 'queued');
      }
      return;
    }
    if (kind === 'seating') {
      dots.setState(i, 'seated');
      return;
    }
    if (kind === 'shelter' || kind === 'concourse') {
      dots.setState(i, 'sheltering');
      return;
    }
    if (kind === 'parking' || kind === 'exit') {
      dots.setState(i, 'gone');
      return;
    }
    dots.setState(i, 'walking');
  }

  /** Nearest place from a list, by walking distance from where the dot stands. */
  private nearest(ctx: SimContext, i: number, candidates: number[], exclude = -1): number {
    const cell = this.cellOf(ctx, i);
    if (cell < 0) return -1;
    let best = -1;
    let bestDist = UNREACHABLE;
    for (const index of candidates) {
      if (index === exclude) continue;
      const d = this.fields.field(index).dist[cell]!;
      if (d < bestDist) {
        bestDist = d;
        best = index;
      }
    }
    return best;
  }

  private retarget(ctx: SimContext, i: number, target: number): void {
    if (target < 0) return;
    ctx.dots.targetPlace[i] = target;
    ctx.dots.setState(i, 'walking');
  }

  onChoice(ctx: SimContext, dot: number, situation: SituationId, option: string): void {
    const { dots } = ctx;

    switch (situation) {
      case 'lightning_shelter':
        if (option === 'go_concourse') this.retarget(ctx, dot, this.shelterIndex);
        else if (option === 'go_car') this.retarget(ctx, dot, this.parkingIndex);
        return;

      case 'gate_jammed':
        if (option === 'try_other_gate') {
          this.retarget(ctx, dot, this.nearest(ctx, dot, this.gateIndexes, dots.targetPlace[dot]!));
        } else if (option === 'back_off') {
          this.retarget(ctx, dot, this.parkingIndex);
        } else {
          dots.setState(dot, 'queued');
        }
        return;

      case 'alert_received':
      case 'officer_instruction':
        // Only fans an alert actually reached, who choose to follow it, get redirected.
        if (option === 'follow') {
          const moved = ctx.redirects.get(dots.targetPlace[dot]!);
          if (moved !== undefined) this.retarget(ctx, dot, moved);
        }
        return;

      case 'street_closed':
        if (option === 'wait') dots.setState(dot, 'queued');
        return;

      case 'exit_route':
        if (option === 'nearest_exit') this.retarget(ctx, dot, this.nearest(ctx, dot, this.exitIndexes));
        else if (option === 'my_gate') this.retarget(ctx, dot, this.homeGate[dot]!);
        return;

      case 'leave_early':
        if (option === 'leave_now') this.retarget(ctx, dot, this.parkingIndex);
        return;

      case 'leave_tailgate':
        if (option === 'go_now' && dots.stateOf(dot) === 'arriving') this.spawnT[dot] = ctx.t;
        return;

      default:
        return;
    }
  }
}
