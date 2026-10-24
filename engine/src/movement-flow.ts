import type { Id, MapBundle, SituationId } from '../../contracts.ts';
import { CELL_SIZE_M, DOT_GROUP_SIZE } from '../../contracts.ts';
import { FlowFields, DIR_DX, DIR_DY, UNREACHABLE, WALK_STEP } from './flowfield.ts';
import type { MovementModel, SimContext } from './sim.ts';
import type { GateStat } from './edits.ts';

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
/** How far along the route from a gate a fan may be served by it, in open-ground steps. */
const GATE_REACH_CELLS = 10;

/** How far over an even share a single gate may be assigned. */
const GATE_QUOTA_SLACK = 1.15;

/** Extra throughput per officer on station at a gate, and the most officers can add. */
const OFFICER_GATE_BOOST = 0.1;
const OFFICER_GATE_BOOST_MAX = 0.4;

/** How far along the route from a gate its queue reaches, in open-ground steps: the line a commander sees, and who its staff turn away when it shuts. */
const QUEUE_REACH_STEPS = GATE_REACH_CELLS * 2;

/** Seconds of history behind a gate's in/out rate: a rolling minute. */
const FLOW_WINDOW_S = 60;

/** Seconds of unused throughput a gate may hold over, so a lull is not banked. */
const GATE_BURST_S = 5;

/** How long fans who chose to sit and let the exit thin out stay put, in seconds. */
const WAIT_IN_SEAT_S: [number, number] = [5 * 60, 25 * 60];

/** Straight on, then alternating half-steps either side. */
const SIDESTEPS = [0, -1, 1, -2, 2] as const;
/** Every direction, for the detour pass taken when the way forward is full. */
const ALL_TURNS = [0, -1, 1, -2, 2, -3, 3, 4] as const;
/** How much further from the gate a detour step may land, in open-ground steps. */
const DETOUR_SLACK = 3;
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
  private gateAssigned!: Int32Array;
  private gateCentre = new Map<number, { x: number; y: number }>();
  private seatingIndex = -1;
  private shelterIndex = -1;
  private parkingIndex = -1;
  private exitIndexes: number[] = [];

  private spawnT!: Float32Array;
  private seatCell!: Int32Array;
  /** Where a fan goes once through the turnstile: their seat, or shelter if that is what they came in for. */
  private afterGate!: Int32Array;
  /** Fans through each gate per second, in and out, over the last FLOW_WINDOW_S steps. */
  private flowIn!: Int32Array;
  private flowOut!: Int32Array;
  private flowSlot = 0;
  private lotCell!: Int32Array;
  private homeGate!: Int32Array;
  private admitted!: Uint8Array;
  /** Sim time a seated fan who chose to wait gets up and leaves; 0 for nobody. */
  private leaveAt!: Float32Array;
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
    this.gateAssigned = new Int32Array(map.places.length);
    for (const gate of this.gateIndexes) {
      const place = map.places[gate]!;
      const door = map.closables.find((c) => c.cells.some((cell) => place.cells.includes(cell)));
      if (door) this.gateDoor.set(gate, door.id);
    }
    this.gateCentre.clear();
    for (const gate of this.gateIndexes) {
      const cells = map.places[gate]!.cells;
      let sx = 0;
      let sy = 0;
      for (const cell of cells) {
        sx += cell % map.width;
        sy += (cell / map.width) | 0;
      }
      this.gateCentre.set(gate, { x: sx / cells.length, y: sy / cells.length });
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
    // Only park where a gate can be walked to. OSM has lots boxed in by
    // buildings and fences, and a fan dropped in one stood there all game —
    // 140 of them on the stadium map, stuck in the middle of a block.
    const reachable = lotCells.filter((cell) =>
      this.gateIndexes.some((gate) => this.fields.field(gate, true).dist[cell] !== UNREACHABLE),
    );
    if (reachable.length > 0) {
      lotCells.length = 0;
      for (const cell of reachable) lotCells.push(cell);
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
    this.afterGate = new Int32Array(n).fill(this.seatingIndex);
    this.flowIn = new Int32Array(map.places.length * FLOW_WINDOW_S);
    this.flowOut = new Int32Array(map.places.length * FLOW_WINDOW_S);
    this.flowSlot = 0;
    this.lotCell = new Int32Array(n);
    this.homeGate = new Int32Array(n).fill(-1);
    this.admitted = new Uint8Array(n);
    this.leaveAt = new Float32Array(n);
    this.occupancy = new Int32Array(map.width * map.height);

    const seatCells = this.seatingIndex >= 0 ? (map.places[this.seatingIndex]?.cells ?? []) : [];
    // A little slack over an even split, so proximity still wins most of the time.
    const gateQuota =
      this.gateIndexes.length > 0 ? Math.ceil((n / this.gateIndexes.length) * GATE_QUOTA_SLACK) : n;

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

      // Your gate is the one you can actually walk to from where you parked,
      // measured along the flow field rather than as the crow flies, and each
      // gate carries a quota so no single gate takes a third of the stadium.
      //
      // Assigning by seat instead looked more like real ticketing, but it sent
      // half the crowd on a hike around the bowl — and with routes through the
      // interior rightly forbidden, they jammed in the narrow gaps between the
      // stadium and the buildings around it. Measured: the far gates never saw
      // a single fan all game while their queues stood 50 to 200 cells out.
      let bestGate = -1;
      let bestDist = UNREACHABLE;
      let fallbackGate = this.gateIndexes[0] ?? -1;
      let fallbackDist = UNREACHABLE;
      for (const gate of this.gateIndexes) {
        const d = this.fields.field(gate, true).dist[cell]!;
        if (d < fallbackDist) {
          fallbackDist = d;
          fallbackGate = gate;
        }
        if (this.gateAssigned[gate]! >= gateQuota) continue;
        if (d < bestDist) {
          bestDist = d;
          bestGate = gate;
        }
      }
      if (bestGate < 0) bestGate = fallbackGate;
      this.gateAssigned[bestGate]!++;
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

    // A new second of flow history: clear the slot this step will fill.
    this.flowSlot = (this.flowSlot + 1) % FLOW_WINDOW_S;
    for (const gate of this.gateIndexes) {
      this.flowIn[gate * FLOW_WINDOW_S + this.flowSlot] = 0;
      this.flowOut[gate * FLOW_WINDOW_S + this.flowSlot] = 0;
    }

    for (const gate of this.gateIndexes) {
      const perMin = map.places[gate]!.throughputPerMin ?? 0;
      // Officers on station at a gate help screen and wave people through.
      const boost = Math.min(OFFICER_GATE_BOOST_MAX, OFFICER_GATE_BOOST * this.officersAt(ctx, gate));
      const perSecond = (perMin * (1 + boost)) / 60 / DOT_GROUP_SIZE;
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

    this.admitAtGates(ctx);

    for (let i = 0; i < dots.count; i++) {
      const state = dots.stateOf(i);
      if (state === 'seated' && this.leaveAt[i]! > 0 && ctx.t >= this.leaveAt[i]!) {
        this.leaveAt[i] = 0;
        this.retarget(ctx, i, this.nearestExit(ctx, i));
        continue;
      }
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

      // Caught on a gate as it shut: walk off it. Closing a door stops people
      // stepping onto it, not the ones already standing there — they were left
      // with nowhere to step and no route, and stood on the shut door all run.
      if (this.fields.isClosed(cell)) {
        this.clearDoor(ctx, i, cell, dt, occupancy);
        continue;
      }

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

      // In the queue for a shut gate: its staff send the whole queue on to the
      // next open gate, not just whoever reaches the door. Turning away only
      // the front left ~1,300 people waiting minutes after Gate 1 closed.
      if (this.admitted[i] !== 1 && map.places[target]?.kind === 'gate' && !this.isOpen(ctx, target)) {
        const reach = this.fields.field(target, true).dist[cell]!;
        if (reach <= QUEUE_REACH_STEPS * WALK_STEP) {
          const other = this.nearestOpenGate(ctx, i, target);
          if (other >= 0) {
            this.retarget(ctx, i, other);
            continue;
          }
        }
      }

      // Leaving, and already out through some gate: that gate did its job. A
      // fan whose chosen gate was on the far side otherwise walked out the
      // nearest opening and round the outside of the stadium to reach it first —
      // 1,406 fans more than 120 m from their gate, half an hour after the game.
      if (this.admitted[i] === 1 && map.places[target]?.kind === 'gate' && !this.insideBowl(ctx, cell) && this.parkingIndex >= 0) {
        this.flowOut[target * FLOW_WINDOW_S + this.flowSlot]!++;
        this.retarget(ctx, i, this.parkingIndex);
        continue;
      }

      // Places outside the bowl are approached from outside, so routes to them
      // do not cut through it — unless the fan is already inside and leaving,
      // in which case the way out is through the bowl by definition. Lots count
      // too: a fan leaving through a gate must not walk back in to cross to a
      // lot on the far side.
      const field = this.fields.field(target, this.outsideBowl(map, target) && !this.insideBowl(ctx, cell));
      const best = field.dir[cell]!;
      if (best === 0) {
        // No route at all. For a gate that usually means it is shut or walled
        // off from where they stand, so send them to one they can actually
        // reach rather than leaving them stranded for the rest of the game —
        // measured at 2,036 fans on the stadium map.
        if (map.places[target]?.kind === 'gate' && field.dist[cell] === UNREACHABLE) {
          const other = this.nearest(ctx, i, this.gateIndexes, target);
          if (other >= 0 && other !== target) {
            this.retarget(ctx, i, other);
            continue;
          }
        }
        // A closed gate or a sealed street: they wait where they are.
        dots.setState(i, 'queued');
        continue;
      }

      const free = (population.types[dots.typeIndex[i]!]?.walkSpeedMps ?? 1.2) * (ctx.walkFactor ?? 1);
      const stride = free * densityFactor(density.peoplePerM2[cell]!) * dt;
      const here = field.dist[cell]!;

      // Two passes. The first only moves closer to the gate, fanning out either
      // side of the best direction — that is what a queue does. The second runs
      // only when every way forward is full and allows a short detour sideways
      // or back.
      //
      // Without the second pass the crowd deadlocks. A dot may only enter a
      // cell at least as close to its gate as its own, so once a corridor
      // fills, everyone behind waits forever and the jam never drains.
      // Measured on the stadium map: the approach froze for forty simulated
      // minutes with fans stuck 50 to 200 cells out while gates stood idle.
      let moved = false;
      for (let pass = 0; pass < 2 && !moved; pass++) {
        const slack = pass === 0 ? 0 : DETOUR_SLACK * WALK_STEP;
        for (const turn of pass === 0 ? SIDESTEPS : ALL_TURNS) {
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
            if (pass === 1) continue; // shuffling inside one cell is not a detour
            dots.x[i] = nx;
            dots.y[i] = ny;
            dots.setState(i, 'walking');
            moved = true;
            break;
          }
          if (!this.fields.passable(nCell)) continue;
          if (this.unscreenedEntry(ctx, i, cell, nCell)) continue;
          const there = field.dist[nCell]!;
          if (there === UNREACHABLE || there > here + slack) continue;
          if (occupancy[nCell]! >= MAX_DOTS_PER_CELL) continue;
          occupancy[cell]!--;
          occupancy[nCell]!++;
          dots.x[i] = nx;
          dots.y[i] = ny;
          dots.setState(i, 'walking');
          moved = true;
          break;
        }
      }
      // Hemmed in on every side, detour included. This is the queue.
      if (!moved) dots.setState(i, 'queued');
    }
  }

  /**
   * Admit fans at each gate, up to that gate's throughput.
   *
   * A turnstile serves the queue in front of it; which exact 2 m square each
   * fan stands on should not decide whether the gate works. Requiring a waiting
   * fan to occupy a specific cell deadlocked every gate: those cells filled
   * with fans walking past to the next gate and fans already admitted walking
   * inward, so nobody waiting could reach the turnstile and gates sat idle with
   * thousands queued and their whole throughput unspent.
   *
   * Dots are considered in index order, so admission stays deterministic.
   */
  private admitAtGates(ctx: SimContext): void {
    const { dots } = ctx;
    for (const gate of this.gateIndexes) {
      let budget = Math.floor(this.gateBudget[gate]!);
      if (budget < 1) continue;
      const door = this.gateDoor.get(gate);
      if (door !== undefined && ctx.closed.has(door)) continue;
      // Reach is measured along the flow field, not as a box around the gate's
      // centre. A gate is a block of cells, so a fan ten steps from its edge
      // can be thirteen cells from its middle: the box quietly refused to serve
      // the very front of the queue, and gates sat idle with people waiting.
      const field = this.fields.field(gate, true);

      for (let i = 0; i < dots.count && budget > 0; i++) {
        if (this.admitted[i] === 1) continue;
        if (dots.targetPlace[i] !== gate) continue;
        const state = dots.stateOf(i);
        if (state !== 'walking' && state !== 'queued') continue;
        const cell = this.cellOf(ctx, i);
        if (cell < 0) continue;
        if (field.dist[cell]! > GATE_REACH_CELLS * WALK_STEP) continue;

        this.admitted[i] = 1;
        dots.targetPlace[i] = this.afterGate[i]! >= 0 ? this.afterGate[i]! : this.seatingIndex;
        this.afterGate[i] = this.seatingIndex;
        this.flowIn[gate * FLOW_WINDOW_S + this.flowSlot]!++;
        dots.setState(i, 'walking');
        budget--;
        this.gateBudget[gate]!--;
      }
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

    const free = (population.types[dots.typeIndex[i]!]?.walkSpeedMps ?? 1.2) * (ctx.walkFactor ?? 1);
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

    // Reaching your gate means you are in the queue; admitAtGates lets people
    // through at the gate's own rate. On the way out it is only a door: keep
    // walking to the lots. Queueing here too meant nobody ever left — every fan
    // who chose "nearest exit" stood at the gate for the rest of the run.
    if (kind === 'gate') {
      if (this.admitted[i] === 1 && this.parkingIndex >= 0) {
        this.flowOut[target * FLOW_WINDOW_S + this.flowSlot]!++;
        this.retarget(ctx, i, this.parkingIndex);
        return;
      }
      // A shut gate turns people away, as its staff would. Before, fans who
      // reached a closed gate stood on it for the rest of the run — 28,816
      // dot-steps on Gate 1's closed door in one gate-surge run.
      if (!this.isOpen(ctx, target)) {
        const other = this.nearestOpenGate(ctx, i, target);
        if (other >= 0) {
          this.retarget(ctx, i, other);
          return;
        }
      }
      dots.setState(i, 'queued');
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

  /** The per-dot and per-gate state the contract's Snapshot has no room for. */
  capture(): unknown {
    return {
      spawnT: this.spawnT.slice(),
      seatCell: this.seatCell.slice(),
      lotCell: this.lotCell.slice(),
      homeGate: this.homeGate.slice(),
      admitted: this.admitted.slice(),
      leaveAt: this.leaveAt.slice(),
      afterGate: this.afterGate.slice(),
      flowIn: this.flowIn.slice(),
      flowOut: this.flowOut.slice(),
      flowSlot: this.flowSlot,
      gateBudget: this.gateBudget.slice(),
      gateAssigned: this.gateAssigned.slice(),
      closedKey: this.closedKey,
    };
  }

  restore(state: unknown): void {
    if (!state || typeof state !== 'object') return;
    const s = state as ReturnType<FlowMovement['capture']> & Record<string, never>;
    const take = <T extends { set(a: T): void }>(into: T, from: unknown) => {
      if (from) into.set(from as T);
    };
    take(this.spawnT, (s as Record<string, unknown>).spawnT);
    take(this.seatCell, (s as Record<string, unknown>).seatCell);
    take(this.lotCell, (s as Record<string, unknown>).lotCell);
    take(this.homeGate, (s as Record<string, unknown>).homeGate);
    take(this.admitted, (s as Record<string, unknown>).admitted);
    take(this.leaveAt, (s as Record<string, unknown>).leaveAt);
    take(this.afterGate, (s as Record<string, unknown>).afterGate);
    take(this.flowIn, (s as Record<string, unknown>).flowIn);
    take(this.flowOut, (s as Record<string, unknown>).flowOut);
    this.flowSlot = Number((s as Record<string, unknown>).flowSlot ?? 0);
    take(this.gateBudget, (s as Record<string, unknown>).gateBudget);
    take(this.gateAssigned, (s as Record<string, unknown>).gateAssigned);
    this.closedKey = String((s as Record<string, unknown>).closedKey ?? '');
  }

  /** The post of the closest officer within earshot of this dot, or -1. */
  private nearestOfficerPost(ctx: SimContext, dot: number): number {
    const cell = this.cellOf(ctx, dot);
    if (cell < 0) return -1;
    const width = ctx.map.width;
    const cx = cell % width;
    const cy = (cell / width) | 0;
    let best = -1;
    let bestSq = Infinity;
    for (const officer of ctx.officers) {
      const post = ctx.officerPost.get(officer.id);
      if (post === undefined) continue;
      const ox = officer.cell % width;
      const oy = (officer.cell / width) | 0;
      const dx = ox - cx;
      const dy = oy - cy;
      if (Math.abs(dx) > officer.radiusCells || Math.abs(dy) > officer.radiusCells) continue;
      const sq = dx * dx + dy * dy;
      if (sq < bestSq) {
        bestSq = sq;
        best = post;
      }
    }
    return best;
  }

  /** True when this cell is inside the stadium bowl. */
  private insideBowl(ctx: SimContext, cell: number): boolean {
    const kind = ctx.map.cells[cell];
    return kind === 'stands' || kind === 'concourse';
  }

  /**
   * One step off a closed door: through the turnstile means inward to their
   * seat, otherwise outward to where they parked. Closed cells may be crossed
   * on the way off; walls and full cells may not.
   */
  private clearDoor(ctx: SimContext, i: number, cell: number, dt: number, occupancy: Int32Array): void {
    const { dots, map, population } = ctx;
    const goal = this.admitted[i] === 1 ? this.seatCell[i]! : this.lotCell[i]!;
    if (goal < 0) return;
    const gx = ((goal % map.width) + 0.5) * CELL_SIZE_M;
    const gy = (((goal / map.width) | 0) + 0.5) * CELL_SIZE_M;
    const step = (population.types[dots.typeIndex[i]!]?.walkSpeedMps ?? 1.2) * (ctx.walkFactor ?? 1) * dt;
    let best = -1;
    let bestD = Math.hypot(gx - dots.x[i]!, gy - dots.y[i]!);
    let bx = 0;
    let by = 0;
    for (let d = 1; d <= 8; d++) {
      const norm = DIR_DX[d] !== 0 && DIR_DY[d] !== 0 ? Math.SQRT1_2 : 1;
      const nx = Math.fround(dots.x[i]! + DIR_DX[d]! * norm * step);
      const ny = Math.fround(dots.y[i]! + DIR_DY[d]! * norm * step);
      if (nx < 0 || ny < 0 || nx >= map.width * CELL_SIZE_M || ny >= map.height * CELL_SIZE_M) continue;
      const nCell = ((ny / CELL_SIZE_M) | 0) * map.width + ((nx / CELL_SIZE_M) | 0);
      if (map.cells[nCell] === 'blocked') continue;
      if (nCell !== cell && occupancy[nCell]! >= MAX_DOTS_PER_CELL) continue;
      const dist = Math.hypot(gx - nx, gy - ny);
      if (dist < bestD) {
        bestD = dist;
        best = nCell;
        bx = nx;
        by = ny;
      }
    }
    if (best < 0) {
      dots.setState(i, 'queued');
      return;
    }
    if (best !== cell) {
      occupancy[cell]!--;
      occupancy[best]!++;
    }
    dots.x[i] = bx;
    dots.y[i] = by;
    dots.setState(i, 'walking');
  }

  /** True when this gate's door is open (a place with no door is always open). */
  private isOpen(ctx: SimContext, place: number): boolean {
    const door = this.gateDoor.get(place);
    return door === undefined || !ctx.closed.has(door);
  }

  /** The nearest open gate to leave by; any gate if every one is shut. */
  private nearestExit(ctx: SimContext, dot: number): number {
    const open = this.exitIndexes.filter((g) => this.isOpen(ctx, g));
    return this.nearest(ctx, dot, open.length > 0 ? open : this.exitIndexes);
  }

  /**
   * The gate rule: nobody steps into the bowl from outside without going
   * through a turnstile. Routes already lead through the gates; this is what
   * holds when some other choice sends an unscreened fan toward the inside.
   */
  private unscreenedEntry(ctx: SimContext, dot: number, from: number, to: number): boolean {
    return this.admitted[dot] !== 1 && !this.insideBowl(ctx, from) && this.insideBowl(ctx, to);
  }

  /** In and out per minute, who is waiting, and the door, for every gate. */
  gateStats(ctx: SimContext): GateStat[] {
    const { map, dots } = ctx;
    // The queue is who is standing in line near the gate. Counting everyone
    // headed there put 1,280 people "waiting" at a shut gate who were still
    // hundreds of metres away and had not reached it to be turned away.
    const waiting = new Int32Array(map.places.length);
    for (let i = 0; i < dots.count; i++) {
      if (this.admitted[i] === 1 || dots.stateOf(i) !== 'queued') continue;
      const target = dots.targetPlace[i]!;
      if (target < 0 || map.places[target]?.kind !== 'gate') continue;
      const cell = this.cellOf(ctx, i);
      if (cell < 0 || this.fields.field(target, true).dist[cell]! > QUEUE_REACH_STEPS * WALK_STEP) continue;
      waiting[target]!++;
    }
    const sum = (ring: Int32Array, gate: number) => {
      let n = 0;
      for (let k = 0; k < FLOW_WINDOW_S; k++) n += ring[gate * FLOW_WINDOW_S + k]!;
      return n;
    };
    return this.gateIndexes.map((gate) => {
      const open = this.isOpen(ctx, gate);
      const officers = this.officersAt(ctx, gate);
      const boost = Math.min(OFFICER_GATE_BOOST_MAX, OFFICER_GATE_BOOST * officers);
      return {
        place: gate,
        open,
        // The window is FLOW_WINDOW_S seconds, so the sum is already per minute.
        inPerMin: sum(this.flowIn, gate) * DOT_GROUP_SIZE,
        outPerMin: sum(this.flowOut, gate) * DOT_GROUP_SIZE,
        waiting: waiting[gate]! * DOT_GROUP_SIZE,
        capacityPerMin: open ? Math.round((map.places[gate]!.throughputPerMin ?? 0) * (1 + boost)) : 0,
        officers,
      };
    });
  }

  /** Officers who were sent to this place and are standing on it. */
  private officersAt(ctx: SimContext, place: number): number {
    const mask = this.maskOf(ctx, place);
    let n = 0;
    for (const officer of ctx.officers) {
      if (ctx.officerPost.get(officer.id) === place && mask[officer.cell] === 1) n++;
    }
    return n;
  }

  /** Nearest gate other than `exclude` whose door is open, or -1. */
  private nearestOpenGate(ctx: SimContext, dot: number, exclude: number): number {
    const open = this.gateIndexes.filter((g) => {
      const door = this.gateDoor.get(g);
      return g !== exclude && (door === undefined || !ctx.closed.has(door));
    });
    return this.nearest(ctx, dot, open);
  }

  /** True for destinations outside the bowl, which routes from outside must not cut through. */
  private outsideBowl(map: MapBundle, place: number): boolean {
    const kind = map.places[place]?.kind;
    return kind !== 'seating' && kind !== 'concourse' && kind !== 'shelter';
  }

  /** Nearest place from a list, by walking distance from where the dot stands. */
  private nearest(ctx: SimContext, i: number, candidates: number[], exclude = -1): number {
    const cell = this.cellOf(ctx, i);
    if (cell < 0) return -1;
    const inside = this.insideBowl(ctx, cell);
    let best = -1;
    let bestDist = UNREACHABLE;
    for (const index of candidates) {
      if (index === exclude) continue;
      const d = this.fields.field(index, this.outsideBowl(ctx.map, index) && !inside).dist[cell]!;
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

  /**
   * The commander sent this group somewhere by hand. A fan not yet through a
   * turnstile cannot be sent straight to a seat or the concourse, which are
   * inside the bowl: they go to their gate first and on from there as usual.
   */
  sendTo(ctx: SimContext, dot: number, place: number): void {
    const kind = ctx.map.places[place]?.kind;
    const inside = kind === 'seating' || kind === 'concourse';
    if (kind === 'gate') {
      // A new gate means a new queue; they are not through it yet.
      this.admitted[dot] = 0;
      this.retarget(ctx, dot, place);
      return;
    }
    if (inside && this.admitted[dot] !== 1) {
      this.retarget(ctx, dot, this.homeGate[dot]!);
      return;
    }
    // Leaving through a gate is a door, not a turnstile.
    if (kind === 'parking' || kind === 'exit') this.admitted[dot] = 1;
    this.retarget(ctx, dot, place);
  }

  describe(dot: number) {
    return {
      homeGate: this.homeGate[dot] ?? -1,
      seatCell: this.seatCell[dot] ?? -1,
      admitted: this.admitted[dot] === 1,
      arriveAt: this.spawnT[dot] ?? 0,
    };
  }

  onChoice(ctx: SimContext, dot: number, situation: SituationId, option: string): void {
    const { dots } = ctx;

    switch (situation) {
      case 'lightning_shelter':
        if (option === 'go_concourse') {
          // Shelter is inside the bowl, and the way in is through a turnstile.
          // Before, fans caught outside walked straight in unscreened.
          if (this.admitted[dot] !== 1 && this.shelterIndex >= 0 && !this.outsideBowl(ctx.map, this.shelterIndex)) {
            this.afterGate[dot] = this.shelterIndex;
            const gate = this.isOpen(ctx, this.homeGate[dot]!) ? this.homeGate[dot]! : this.nearestOpenGate(ctx, dot, -1);
            if (gate >= 0) this.retarget(ctx, dot, gate);
          } else {
            this.retarget(ctx, dot, this.shelterIndex);
          }
        }
        else if (option === 'go_car') this.retarget(ctx, dot, this.parkingIndex);
        return;

      case 'gate_jammed':
        // The surge zone is the crowd on the approach, which includes fans let
        // through ten steps short of the turnstile. They are already in: sending
        // them to another gate stranded them in a queue that never admits them.
        if (this.admitted[dot] === 1) return;
        if (option === 'try_other_gate') {
          this.retarget(ctx, dot, this.nearest(ctx, dot, this.gateIndexes, dots.targetPlace[dot]!));
        } else if (option === 'back_off') {
          this.retarget(ctx, dot, this.parkingIndex);
        } else {
          dots.setState(dot, 'queued');
        }
        return;

      case 'alert_received':
        // Only fans an alert actually reached, who choose to follow it, get redirected.
        if (option === 'follow') {
          const moved = ctx.redirects.get(dots.targetPlace[dot]!);
          if (moved !== undefined) this.retarget(ctx, dot, moved);
        }
        return;

      case 'officer_instruction':
        // An officer standing in front of you is more specific than a PA: they
        // send you where they were posted. Falling back to the plan's redirect
        // covers an officer sent somewhere that is not a destination itself.
        if (option === 'follow') {
          const post = this.nearestOfficerPost(ctx, dot);
          // An officer at a gate is managing the queue outside it. A fan already
          // through the turnstile is not part of that queue, and sending them
          // back out to the gate would walk them out of the stadium.
          if (post >= 0 && this.admitted[dot] === 1 && this.outsideBowl(ctx.map, post)) return;
          // Posted at the very gate this fan is queueing for, the help an
          // officer gives a jammed gate is spreading its queue to the next one.
          // Posted at a shut gate, they send everyone on: "go where I stand"
          // was calling the crowd back to a door that admits nobody.
          const atGate = post >= 0 && ctx.map.places[post]?.kind === 'gate';
          if (atGate && (!this.isOpen(ctx, post) || (post === dots.targetPlace[dot] && !ctx.redirects.has(post)))) {
            const other = this.nearestOpenGate(ctx, dot, post);
            if (other >= 0) this.retarget(ctx, dot, other);
            return;
          }
          if (post >= 0 && post !== dots.targetPlace[dot]) {
            this.retarget(ctx, dot, post);
            return;
          }
          const moved = ctx.redirects.get(dots.targetPlace[dot]!);
          if (moved !== undefined) this.retarget(ctx, dot, moved);
        }
        return;

      case 'street_closed':
        if (option === 'wait') dots.setState(dot, 'queued');
        return;

      case 'exit_route':
        // On the way out a gate is a door, not a turnstile: mark them admitted
        // so reaching it does not put them back in the entry queue.
        this.admitted[dot] = 1;
        if (option === 'nearest_exit') this.retarget(ctx, dot, this.nearestExit(ctx, dot));
        else if (option === 'my_gate') this.retarget(ctx, dot, this.isOpen(ctx, this.homeGate[dot]!) ? this.homeGate[dot]! : this.nearestExit(ctx, dot));
        else if (option === 'wait_in_seat' && dots.stateOf(dot) === 'seated') {
          // Letting it thin out is not staying for good.
          const [lo, hi] = WAIT_IN_SEAT_S;
          this.leaveAt[dot] = ctx.t + lo + (hi - lo) * ctx.rng.next();
        }
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
