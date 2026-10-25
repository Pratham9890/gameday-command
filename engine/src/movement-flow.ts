import {NearestCells} from './nearest-cells.ts';
import type { Id, MapBundle, SituationId } from '../../contracts.ts';
import { CELL_SIZE_M, DOT_GROUP_SIZE } from '../../contracts.ts';
import type { FlowField } from './flowfield.ts';
import { FlowFields, DIR_DX, DIR_DY, UNREACHABLE, WALK_STEP } from './flowfield.ts';
import type { MovementModel, SimContext } from './sim.ts';
import type { GateStat } from './edits.ts';
import { STATE_INDEX } from './dots.ts';
import type { DensityContribution } from './density.ts';

/**
 * Dot state as the numeric codes the store holds, so the step loop compares
 * bytes instead of building a state name for every dot every second.
 */
const ARRIVING = STATE_INDEX.arriving;
const WALKING = STATE_INDEX.walking;
const QUEUED = STATE_INDEX.queued;
const SEATED = STATE_INDEX.seated;
const SHELTERING = STATE_INDEX.sheltering;
const GONE = STATE_INDEX.gone;

/**
 * Jam density in people per square meter. Above this nobody moves; the curve
 * below is linear down to a 5% crawl, which puts a visible slowdown right at the
 * 4 people/m² danger line the scorecard counts.
 */
export const RHO_JAM = 5.4;
const MIN_SPEED_FACTOR = 0.05;

export function densityFactor(peoplePerM2: number): number {
  // Weidmann (ETH IVT 132): v = v0 * (1 - exp(-1.913 * (1/rho - 1/rho_jam))).
  // Free flow below 0.5 p/m2, and the same 5% floor at the jam density the
  // model already used. The old straight line `1 - rho/5.4` moved crowds too
  // fast at 3-5 p/m2; this is the measured curve, not a tuned one.
  if (peoplePerM2 <= 0.5) return 1;
  const rho = Math.min(RHO_JAM, Math.max(0.5, peoplePerM2));
  const factor = 1 - Math.exp(-1.913 * (1 / rho - 1 / RHO_JAM));
  return Math.max(MIN_SPEED_FACTOR, Math.min(1, factor));
}

/** How far along the route from a gate a fan may be served by it, in open-ground steps. */
const GATE_REACH_CELLS = 10;

/** Extra throughput per officer on station at a gate, and the most officers can add. */
const OFFICER_GATE_BOOST = 0.1;
const OFFICER_GATE_BOOST_MAX = 0.4;

/** How far along the route from a gate its queue reaches, in open-ground steps: the line a commander sees, and who its staff turn away when it shuts. */
const QUEUE_REACH_STEPS = GATE_REACH_CELLS * 2;

/** Seconds of history behind a gate's in/out rate: a rolling minute. */
const FLOW_WINDOW_S = 60;

/** Seconds of unused throughput a gate may hold over, so a lull is not banked. */
const GATE_BURST_S = 5;

/** A fan who parked at least this long before the run starts begins it in their seat. */
const PRESEATED_LEAD_S = 15 * 60;

/** How long fans who chose to sit and let the exit thin out stay put, in seconds. */
const WAIT_IN_SEAT_S: [number, number] = [5 * 60, 25 * 60];

/** Straight on, then alternating half-steps either side. */
const SIDESTEPS = [0, -1, 1, -2, 2] as const;
/** Every direction, for the detour pass taken when the way forward is full. */
const ALL_TURNS = [0, -1, 1, -2, 2, -3, 3, 4] as const;
/** How much further from the gate a detour step may land, in open-ground steps. */
const DETOUR_SLACK = 3;
/**
 * How many dots physically fit in one cell before it is full.
 *
 * Without a hard cap, slowing dots down is not enough: they creep into the cell
 * in front at 5% speed and still all end up standing on the same 2 m square, so
 * a gate queue reads as 10,000 people per square meter. Refusing to enter a full
 * cell is what makes a queue back up along the approach instead, which is the
 * behaviour every number on the scorecard depends on.
 */
export const MAX_DOTS_PER_CELL = Math.max(1, Math.floor((RHO_JAM * CELL_SIZE_M * CELL_SIZE_M) / DOT_GROUP_SIZE));

/**
 * Speed factor for a cell holding n standing dots: the same Weidmann value
 * `densityFactor` gives for the density those n people mean. Density is
 * quantised (n × dots per cell), so every walker can look its factor up
 * instead of paying for an `Math.exp` each step. Counts above the cap are all
 * past the 5% floor, so the last entry serves them too.
 */
const SPEED_BY_COUNT: Float64Array = (() => {
  const table = new Float64Array(MAX_DOTS_PER_CELL + 1);
  for (let n = 0; n <= MAX_DOTS_PER_CELL; n++) {
    table[n] = densityFactor((n * DOT_GROUP_SIZE) / (CELL_SIZE_M * CELL_SIZE_M));
  }
  return table;
})();

/**
 * Seated dots one single-deck stands cell may hold. One place is always left
 * for someone passing: a 2 m square of bleachers has an aisle or a row gap.
 */
export const SEATED_PER_CELL = Math.max(1, MAX_DOTS_PER_CELL - 1);

/** The Horseshoe stacks two seating decks over the same footprint. */
export const DECKS = 2;

/**
 * Seated dots one stands cell may hold across both decks. Single-deck seating
 * still leaves one place for someone passing; stacking a second deck doubles
 * the seats without widening the footprint.
 */
export const SEATS_PER_STANDS_CELL = DECKS * SEATED_PER_CELL;

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
  private shelterSearch: NearestCells|null = null;
  private parkingIndex = -1;
  /** For every cell, the smallest parking place containing it, or -1. */
  private parkingByCell!: Int32Array;
  private exitIndexes: number[] = [];

  private spawnT!: Float32Array;
  private seatCell!: Int32Array;
  /** Fans through each gate per second, in and out, over the last FLOW_WINDOW_S steps. */
  private flowIn!: Int32Array;
  private flowOut!: Int32Array;
  private flowSlot = 0;
  private lotCell!: Int32Array;
  private homeGate!: Int32Array;
  private admitted!: Uint8Array;
  /** Unscreened fans sent back to their own lot by a release; officers no longer redirect them. */
  private returningToCar!: Uint8Array;
  /** Fans assigned to each seat cell, so placement cannot overfill one. */
  private seatLoad!: Int32Array;
  /** Sim time a seated fan who chose to wait gets up and leaves; 0 for nobody. */
  private leaveAt!: Float32Array;
  private occupancy!: Int32Array;
  /** Seated dots per cell, rebuilt with `occupancy` every pass. */
  private seatedHere!: Int32Array;
  /** Dots that chose the concourse as lightning shelter, for overflow to cars. */
  private shelterReserved = 0;
  /** Previous sky's lightning flag, so the all-clear is detected once. */
  private wasLightning = false;
  private closedKey = '';
  /** For every stands cell, which gate's section of the bowl it is in (an index into gateIndexes); -1 elsewhere. */
  private sectorOfCell!: Int16Array;
  /** The stands cells of each gate''s section, in the same order as gateIndexes. */
  private sectorCells: number[][] = [];
  /** 1 for a cell inside the bowl (stands or concourse), 0 elsewhere; built once at spawn. */
  private bowlMask = new Uint8Array(0);

  /**
   * Cells whose occupancy or seat count was written since the last rebuild.
   * Clearing only these gives the same two grids as filling them: a cell left
   * out was already zero and is neither counted nor written this step.
   */
  private touchedCells = new Int32Array(0);
  private touchedCount = 0;
  private touchedMark = new Uint8Array(0);

  /** Each dot's cell, worked out once per step and updated whenever the dot moves. */
  private cellNow = new Int32Array(0);
  /** Dots that became gone after the occupancy rebuild, so the contribution can remove them. */
  private goneThisStep = new Int32Array(0);
  private goneCount = 0;
  /** False after `restore`, which loads positions behind the cache's back. */
  private cellCacheValid = false;

  /** `gateSlot[place]` is that gate's position in `gateIndexes`, or -1. */
  private gateSlot = new Int32Array(0);
  /** Waiting fans of this step, bucketed by gate: reused, never rebuilt per fan. */
  private admitOrder = new Int32Array(0);
  private admitGate = new Int32Array(0);
  private admitDist = new Uint16Array(0);
  private admitSpawn = new Float32Array(0);
  /** Per gate, where its bucket starts in `admitOrder`; the last entry is the end. */
  private admitStart = new Int32Array(0);
  /** The route field per gate this step, or undefined where it admits nobody. */
  private admitFields: (FlowField | undefined)[] = [];

  private cellOf(ctx: SimContext, i: number): number {
    const { dots, map } = ctx;
    if (dots.x[i]! < 0 || dots.y[i]! < 0) return -1; // parked off-map, not arrived
    const cx = (dots.x[i]! / CELL_SIZE_M) | 0;
    const cy = (dots.y[i]! / CELL_SIZE_M) | 0;
    if (cx < 0 || cy < 0 || cx >= map.width || cy >= map.height) return -1;
    return cy * map.width + cx;
  }

  /** Recompute every cached cell; only needed when positions moved behind the cache's back. */
  private refreshCells(ctx: SimContext): void {
    const cells = this.cellNow;
    for (let i = 0; i < ctx.dots.count; i++) cells[i] = this.cellOf(ctx, i);
    this.cellCacheValid = true;
  }

  /** The cache is current unless `restore` replaced the positions; then rebuild it once. */
  private ensureCells(ctx: SimContext): void {
    if (!this.cellCacheValid) this.refreshCells(ctx);
  }

  /**
   * Add one dot to a cell, remembering the cell so the next rebuild clears it.
   * One entry per cell: a cell joins the list only as its count rises from zero,
   * and it is not cleared until that list is walked, so it cannot join twice.
   */
  private bumpOccupancy(cell: number): void {
    if (this.occupancy[cell]! === 0 && this.touchedMark[cell] === 0) {
      this.touchedMark[cell] = 1;
      this.touchedCells[this.touchedCount++] = cell;
    }
    this.occupancy[cell]!++;
  }

  private indexOfKind(map: MapBundle, kind: MapBundle['places'][number]['kind']): number {
    return map.places.findIndex((p) => p.kind === kind);
  }

  /**
   * Split the stands into one section per gate: each stands cell belongs to the
   * gate whose bearing from the centre of the bowl is closest to its own. Gates
   * sit at even bearings around the bowl, so the sections come out as wedges.
   * A gate marked unusable gets no section; its seats go to its neighbours.
   */
  private buildSectors(map: MapBundle, seatCells: readonly number[], usable: readonly boolean[]): void {
    this.sectorOfCell = new Int16Array(map.width * map.height).fill(-1);
    this.sectorCells = this.gateIndexes.map(() => []);
    if (seatCells.length === 0 || !usable.some(Boolean)) return;
    let sx = 0;
    let sy = 0;
    for (const cell of seatCells) {
      sx += cell % map.width;
      sy += (cell / map.width) | 0;
    }
    const cx = sx / seatCells.length;
    const cy = sy / seatCells.length;
    const bearings = this.gateIndexes.map((gate) => {
      const c = this.gateCentre.get(gate)!;
      return Math.atan2(c.y - cy, c.x - cx);
    });
    for (const cell of seatCells) {
      const a = Math.atan2(((cell / map.width) | 0) - cy, (cell % map.width) - cx);
      let best = 0;
      let bestGap = Infinity;
      for (let s = 0; s < bearings.length; s++) {
        if (!usable[s]) continue;
        const gap = Math.abs(Math.atan2(Math.sin(a - bearings[s]!), Math.cos(a - bearings[s]!)));
        if (gap < bestGap) {
          bestGap = gap;
          best = s;
        }
      }
      this.sectorOfCell[cell] = best;
      this.sectorCells[best]!.push(cell);
    }
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
    this.shelterSearch=new NearestCells(map.places[this.shelterIndex]?.cells??[],map.width);
    this.parkingIndex = this.indexOfKind(map, 'parking');
    // Once at spawn: scanning every parking place per released fan was too slow.
    this.parkingByCell = new Int32Array(map.cells.length).fill(-1);
    for (let p = 0; p < map.places.length; p++) {
      const place = map.places[p]!;
      if (place.kind !== 'parking') continue;
      for (const cell of place.cells) {
        const current = this.parkingByCell[cell]!;
        if (current < 0 || place.cells.length < map.places[current]!.cells.length) this.parkingByCell[cell] = p;
      }
    }
    this.exitIndexes = map.places.map((p, i) => (p.kind === 'exit' ? i : -1)).filter((i) => i >= 0);
    // One byte per cell: `insideBowl` is asked for several dots every step, and
    // a mask read costs less than two string comparisons. Built once; the map
    // does not change under a run.
    this.bowlMask = new Uint8Array(map.cells.length);
    for (let c = 0; c < map.cells.length; c++) {
      const kind = map.cells[c];
      if (kind === 'stands' || kind === 'concourse') this.bowlMask[c] = 1;
    }
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
    this.flowIn = new Int32Array(map.places.length * FLOW_WINDOW_S);
    this.flowOut = new Int32Array(map.places.length * FLOW_WINDOW_S);
    this.flowSlot = 0;
    this.lotCell = new Int32Array(n);
    this.homeGate = new Int32Array(n).fill(-1);
    this.admitted = new Uint8Array(n);
    this.returningToCar = new Uint8Array(n);
    this.leaveAt = new Float32Array(n);
    this.seatLoad = new Int32Array(map.width * map.height);
    this.occupancy = new Int32Array(map.width * map.height);
    this.seatedHere = new Int32Array(map.width * map.height);
    this.touchedCells = new Int32Array(map.width * map.height);
    this.touchedMark = new Uint8Array(map.width * map.height);
    this.touchedCount = 0;
    this.cellNow = new Int32Array(n);
    this.goneThisStep = new Int32Array(n);
    this.goneCount = 0;
    this.cellCacheValid = false;
    this.admitOrder = new Int32Array(n);
    this.admitGate = new Int32Array(n);
    this.admitDist = new Uint16Array(n);
    this.admitSpawn = new Float32Array(n);
    this.admitStart = new Int32Array(this.gateIndexes.length + 1);
    this.gateSlot = new Int32Array(map.places.length).fill(-1);
    for (let s = 0; s < this.gateIndexes.length; s++) this.gateSlot[this.gateIndexes[s]!] = s;
    this.shelterReserved = 0;
    this.wasLightning = false;

    const seatCells = this.seatingIndex >= 0 ? (map.places[this.seatingIndex]?.cells ?? []) : [];
    // Only gates someone can walk to from a lot get a section. On the stadium
    // map Gate 8 (SSW) is reachable from none of the 41,030 lot cells, so a
    // section for it would be a wedge of seats nobody could ever sit in.
    const usable = this.gateIndexes.map((gate) => {
      const dist = this.fields.field(gate, true).dist;
      return lotCells.some((cell) => dist[cell] !== UNREACHABLE);
    });
    this.buildSectors(map, seatCells, usable);
    // An even split, no slack. With 1.15 the ten large catchments filled first
    // and Gate 5 (ESE), which is nobody's nearest gate, got 52 dots all game.
    const gateQuota =
      this.gateIndexes.length > 0 ? Math.ceil(n / this.gateIndexes.length) : n;

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

    this.assignSeats(map);
    this.seatEarlyArrivals(ctx);
    this.refreshCells(ctx);
  }

  /**
   * Fans who arrived well before the run starts are already in their seats.
   *
   * Arrival windows reach back four hours, but a run starts an hour before
   * kickoff, and everyone whose arrival time had passed used to appear on the
   * first step and set off for the gates together: 57% of the crowd (11,344 of
   * 20,000 dots) in one second at kickoff minus 60 minutes, which jammed every
   * approach. Ohio Stadium opens its gates 2 h 20 min before kickoff, so a fan
   * who parked more than PRESEATED_LEAD_S before the run began has had time to
   * walk in and sit down. Fans closer to the start still walk in as before.
   *
   * This is initial state, not motion: the run begins with them already seated,
   * exactly as it begins with everyone else off-map. No dot is moved during a
   * step except by walking. A run that starts at kickoff has no observed
   * build-up to place, so it starts everyone off-map.
   */
  private seatEarlyArrivals(ctx: SimContext): void {
    const { dots, map, rng, population } = ctx;
    if (this.seatingIndex < 0) return;
    // A run that starts an hour past the last arrival (the game-end window)
    // begins with the whole crowd in. A negative window endpoint is after kickoff.
    const lastArrival = Math.max(...population.types.map((type) => -Math.min(...type.arrivalWindowMin) * 60));
    const allIn = ctx.t >= lastArrival + 3600;
    if (ctx.t >= 0 && !allIn) return;
    const occupied = new Int32Array(map.width * map.height);
    for (let i = 0; i < dots.count; i++) {
      const seat = this.seatCell[i]!;
      if (seat < 0 || this.spawnT[i]! > ctx.t - PRESEATED_LEAD_S) continue;
      if (occupied[seat]! >= SEATS_PER_STANDS_CELL) continue;
      occupied[seat]!++;
      // A whole-crowd start takes no RNG draws, so where the run starts does
      // not shift every random number after it.
      const jx = allIn ? 0.5 : 0.15 + rng.next() * 0.7;
      const jy = allIn ? 0.5 : 0.15 + rng.next() * 0.7;
      dots.x[i] = Math.fround(((seat % map.width) + jx) * CELL_SIZE_M);
      dots.y[i] = Math.fround((((seat / map.width) | 0) + jy) * CELL_SIZE_M);
      this.admitted[i] = 1;
      dots.targetPlace[i] = this.seatingIndex;
      dots.setState(i, 'seated');
    }
    if (!allIn) return;
    // Everyone is in: fans whose section was full take the first free seat in
    // map order, so no extra RNG draws change the rest of the run.
    const seats = map.places[this.seatingIndex]?.cells ?? [];
    let next = 0;
    for (let i = 0; i < dots.count; i++) {
      if (dots.state[i] === SEATED) continue;
      while (next < seats.length && occupied[seats[next]!]! >= SEATS_PER_STANDS_CELL) next++;
      if (next >= seats.length) break;
      const seat = seats[next]!;
      occupied[seat]!++;
      if (this.seatCell[i]! >= 0) this.seatLoad[this.seatCell[i]!]!--;
      this.seatCell[i] = seat;
      this.seatLoad[seat]!++;
      dots.x[i] = Math.fround(((seat % map.width) + 0.5) * CELL_SIZE_M);
      dots.y[i] = Math.fround((((seat / map.width) | 0) + 0.5) * CELL_SIZE_M);
      this.admitted[i] = 1;
      dots.targetPlace[i] = this.seatingIndex;
      dots.setState(i, 'seated');
    }
  }

  /**
   * Everyone has a seat before they arrive, in the section their gate serves,
   * and each section fills from the back: the earliest arrivals through a gate
   * get the seats furthest from it, each seat cell taking no more fans than it
   * holds.
   *
   * Without a seat, fans stopped at whichever stands cell sat just inside their
   * gate. With a seat drawn from the whole bowl, a fan through the north gate
   * was as likely to sit on the far south side, and a seated cell is full, so
   * rows filled in front of people still walking to the rows behind them. They
   * backed up into the gate mouths: on the stadium map 9,211 admitted dots were
   * still unseated half an hour after kickoff, against 6,162 seated, and Gate 10
   * stopped admitting anyone. Filling from the back keeps the way to every
   * empty seat clear.
   */
  private assignSeats(map: MapBundle): void {
    const width = map.width;
    this.seatLoad.fill(0);
    for (let s = 0; s < this.gateIndexes.length; s++) {
      const gate = this.gateIndexes[s]!;
      const fans: number[] = [];
      for (let i = 0; i < this.homeGate.length; i++) if (this.homeGate[i] === gate) fans.push(i);
      if (fans.length === 0) continue;
      const section = this.sectorCells[s]!;
      if (section.length === 0) continue;
      const g = this.gateCentre.get(gate)!;
      const far = [...section].sort((a, b) => {
        const da = ((a % width) - g.x) ** 2 + (((a / width) | 0) - g.y) ** 2;
        const db = ((b % width) - g.x) ** 2 + (((b / width) | 0) - g.y) ** 2;
        return db - da || a - b;
      });
      fans.sort((a, b) => this.spawnT[a]! - this.spawnT[b]! || a - b);
      const perCell = Math.min(SEATS_PER_STANDS_CELL, Math.max(1, Math.ceil(fans.length / far.length)));
      fans.forEach((dot, k) => {
        const index = Math.floor(k / perCell);
        // More fans than the section physically seats: no seat, so they take
        // the nearest place once they are in the stands rather than overfilling
        // a cell.
        if (index >= far.length) return;
        const cell = far[index]!;
        this.seatCell[dot] = cell;
        this.seatLoad[cell]!++;
      });
    }
  }

  step(ctx: SimContext, dt: number): void {
    const { map, dots, density, population, rng } = ctx;
    // A rewind loads positions behind the cache's back; everything below reads
    // the cache, so it is brought up to date once here.
    this.ensureCells(ctx);
    this.goneCount = 0;
    const lightning = ctx.weather?.lightning === true;
    if (this.wasLightning && !lightning) this.shelterReserved = 0;
    this.wasLightning = lightning;

    const key = [...ctx.closed].sort().join(',');
    if (key !== this.closedKey) {
      this.closedKey = key;
      this.fields.setClosed(ctx.closed);
      // A shut gate turns its whole queue, not just the last 40 m. Fans still
      // walking toward it are retargeted the moment the door closes.
      this.redirectClosedGates(ctx);
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
    //
    // Only the cells written since the last rebuild are cleared; the rest were
    // already zero and stay zero, so the grids after this pass are the same as
    // after filling them whole.
    const occupancy = this.occupancy;
    const seatedHere = this.seatedHere;
    for (let k = 0; k < this.touchedCount; k++) {
      const cell = this.touchedCells[k]!;
      occupancy[cell] = 0;
      seatedHere[cell] = 0;
      this.touchedMark[cell] = 0;
    }
    this.touchedCount = 0;
    const cells = this.cellNow;
    for (let i = 0; i < dots.count; i++) {
      const cell = this.cellOf(ctx, i);
      cells[i] = cell;
      if (dots.state[i] === GONE || cell < 0) continue;
      this.bumpOccupancy(cell);
      if (dots.state[i] === SEATED) seatedHere[cell]!++;
    }
    this.cellCacheValid = true;

    this.admitAtGates(ctx);

    for (let i = 0; i < dots.count; i++) {
      const state = dots.state[i]!;
      if ((state === SEATED || state === SHELTERING) && this.leaveAt[i]! > 0 && ctx.t >= this.leaveAt[i]!) {
        this.leaveAt[i] = 0;
        this.leaveToLots(ctx, i);
        continue;
      }
      if (state === GONE || state === SEATED) continue;
      if (state === SHELTERING) {
        // The all-clear: the sky is no longer lightning. Someone in the bowl is
        // put straight back in a seat; inside the bowl is not simulated.
        if (ctx.weather?.lightning === true || this.seatingIndex < 0) continue;
        this.placeSeated(ctx, i);
        continue;
      }

      if (state === ARRIVING) {
        if (ctx.t < this.spawnT[i]!) continue;
        const cell = this.lotCell[i]!;
        if (occupancy[cell]! >= MAX_DOTS_PER_CELL) continue; // lot cell full, arrive next step
        dots.x[i] = Math.fround(((cell % map.width) + 0.15 + rng.next() * 0.7) * CELL_SIZE_M);
        dots.y[i] = Math.fround((((cell / map.width) | 0) + 0.15 + rng.next() * 0.7) * CELL_SIZE_M);
        this.bumpOccupancy(cell);
        cells[i] = cell;
        dots.setState(i, 'walking');
      }

      const cell = cells[i]!;
      if (cell < 0) continue;
      const target = dots.targetPlace[i]!;
      if (target < 0) continue;
      const targetKind = map.places[target]?.kind;
      const inside = this.insideBowl(cell);
      if (this.admitted[i] === 1 && !inside && (targetKind === 'seating' || targetKind === 'concourse' || targetKind === 'shelter')) {
        // A fan outside was sent back into the bowl: queue at a gate instead.
        this.returnToGate(ctx, i);
        continue;
      }
      if (this.admitted[i] === 1 && inside && targetKind === 'seating') {
        this.placeSeated(ctx, i);
        continue;
      }
      if (this.admitted[i] === 1 && inside && (targetKind === 'concourse' || targetKind === 'shelter')) {
        if (!this.placeSheltering(ctx, i)) this.leaveToLots(ctx, i);
        continue;
      }
      // An admitted fan still inside with a parking/exit/gate target is leaving;
      // retry the instant exit if the gate mouth was full last step.
      if (this.admitted[i] === 1 && inside && (targetKind === 'parking' || targetKind === 'exit' || targetKind === 'gate')) {
        this.leaveToLots(ctx, i);
        continue;
      }

      // Caught on a gate as it shut: walk off it. Closing a door stops people
      // stepping onto it, not the ones already standing there — they were left
      // with nowhere to step and no route, and stood on the shut door all run.
      if (this.fields.isClosed(cell)) {
        this.clearDoor(ctx, i, cell, dt);
        continue;
      }

      if (this.maskOf(ctx, target)[cell] === 1) {
        this.arrive(ctx, i, target);
        continue;
      }

      // In the queue for a shut gate: its staff send the whole queue on to the
      // next open gate. Turning away only the last 40 m left fans walking to a
      // door that would never open.
      if (this.admitted[i] !== 1 && map.places[target]?.kind === 'gate' && !this.isOpen(ctx, target)) {
        const nearest = this.nearestOpenGate(ctx, i, target);
        const other = nearest >= 0 ? nearest : (this.gateIndexes.find((g) => this.isOpen(ctx, g)) ?? -1);
        if (other >= 0) {
          this.retarget(ctx, i, other);
          continue;
        }
      }

      // Leaving, and already out through some gate: that gate did its job. A
      // fan whose chosen gate was on the far side otherwise walked out the
      // nearest opening and round the outside of the stadium to reach it first —
      // 1,406 fans more than 120 m from their gate, half an hour after the game.
      if (this.admitted[i] === 1 && map.places[target]?.kind === 'gate' && !this.insideBowl(cell) && this.parkingIndex >= 0 &&
          this.fields.field(this.parkingIndex, true).dist[cell] !== UNREACHABLE) {
        this.flowOut[target * FLOW_WINDOW_S + this.flowSlot]!++;
        this.retarget(ctx, i, this.parkingIndex);
        continue;
      }

      // Places outside the bowl are approached from outside, so routes to them
      // do not cut through it — unless the fan is already inside and leaving,
      // in which case the way out is through the bowl by definition. Lots count
      // too: a fan leaving through a gate must not walk back in to cross to a
      // lot on the far side.
      let field = this.fields.field(target, this.outsideBowl(map, target) && !inside);
      // Walk cells also occur inside gate corridors. They are not outside until
      // an exterior route exists; otherwise the bowl exclusion strands them.
      const leaving = this.admitted[i] === 1 && (targetKind === 'gate' || targetKind === 'parking');
      if (leaving && field.dist[cell] === UNREACHABLE) field = this.fields.field(target);
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
      // Outside the bowl, standing density is total density; inside is never
      // walked. Seated fans do not slow the queue outside the turnstiles.
      //
      // The grid stores density quantised (standing dots × DOT_GROUP_SIZE over
      // the cell area), so the standing count is exactly recoverable and the
      // table gives the same factor densityFactor() would, without Math.exp.
      // The count must come from the grid as it stands after last step's
      // update, not from `occupancy`, which this step has already changed.
      const standing = Math.round(
        (density.standingPerM2[cell]! * (CELL_SIZE_M * CELL_SIZE_M)) / DOT_GROUP_SIZE,
      );
      const stride = free * SPEED_BY_COUNT[standing < MAX_DOTS_PER_CELL ? standing : MAX_DOTS_PER_CELL]! * dt;
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
            if (leaving) {
              // At crowd speed a detour needs several steps within this cell.
              // Only shuffle toward an available neighbour, or opposing flows
              // bounce at a boundary forever without starting the detour.
              const ax = (cell % map.width) + dx;
              const ay = ((cell / map.width) | 0) + dy;
              if (ax < 0 || ay < 0 || ax >= map.width || ay >= map.height) continue;
              const ahead = ay * map.width + ax;
              if (!this.fields.passable(ahead) || this.standingAt(ahead) >= MAX_DOTS_PER_CELL ||
                  field.dist[ahead] === UNREACHABLE || field.dist[ahead]! > here + slack) continue;
            } else if (pass === 1) continue; // shuffling inside one cell is not a detour
            dots.x[i] = nx;
            dots.y[i] = ny;
            dots.setState(i, 'walking');
            moved = true;
            break;
          }
          if (!this.fields.passable(nCell)) continue;
          if (this.unscreenedEntry(i, cell, nCell)) continue;
          const there = field.dist[nCell]!;
          if (there === UNREACHABLE || there > here + slack) continue;
          if (this.standingAt(nCell) >= MAX_DOTS_PER_CELL) continue;
          occupancy[cell]!--;
          this.bumpOccupancy(nCell);
          dots.x[i] = nx;
          dots.y[i] = ny;
          cells[i] = nCell;
          dots.setState(i, 'walking');
          moved = true;
          break;
        }
      }
      // Pinned in a corner: every short step lands in a full cell, yet a free
      // neighbour no further from the goal is there across this cell. The
      // passes above try fixed headings and skip moves that stay in the cell,
      // so a fan wedged in its corner never walked back across it to the empty
      // cell beside it. Head for that neighbour's centre, even if it takes a
      // few steps to cross.
      if (!moved) {
        const cx = cell % map.width;
        const cy = (cell / map.width) | 0;
        let goal = -1;
        let goalDist = here + DETOUR_SLACK * WALK_STEP + 1;
        for (let k = 1; k <= 8; k++) {
          const ax = cx + DIR_DX[k]!;
          const ay = cy + DIR_DY[k]!;
          if (ax < 0 || ay < 0 || ax >= map.width || ay >= map.height) continue;
          const next = ay * map.width + ax;
          if (!this.fields.passable(next) || this.standingAt(next) >= MAX_DOTS_PER_CELL) continue;
          if (this.unscreenedEntry(i, cell, next)) continue;
          // No squeezing diagonally between two walls.
          if (k % 2 === 0 && (!this.fields.passable(cy * map.width + ax) || !this.fields.passable(ay * map.width + cx))) continue;
          const there = field.dist[next]!;
          if (there === UNREACHABLE || there >= goalDist) continue;
          goalDist = there;
          goal = next;
        }
        if (goal >= 0) {
          const gx = ((goal % map.width) + 0.5) * CELL_SIZE_M - dots.x[i]!;
          const gy = (((goal / map.width) | 0) + 0.5) * CELL_SIZE_M - dots.y[i]!;
          const len = Math.hypot(gx, gy) || 1;
          const nx = Math.fround(dots.x[i]! + (gx / len) * Math.min(stride, len));
          const ny = Math.fround(dots.y[i]! + (gy / len) * Math.min(stride, len));
          const nCell = ((ny / CELL_SIZE_M) | 0) * map.width + ((nx / CELL_SIZE_M) | 0);
          // The straight line to a neighbour's centre crosses only this cell
          // and that one; anything else (a corner clip) is refused.
          if (nCell === cell || nCell === goal) {
            if (nCell !== cell) {
              occupancy[cell]!--;
              this.bumpOccupancy(nCell);
              cells[i] = nCell;
            }
            dots.x[i] = nx;
            dots.y[i] = ny;
            dots.setState(i, 'walking');
            moved = true;
          }
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
   * One pass over the dots fills a bucket per gate; one sort by (gate, distance,
   * arrival, index) puts every bucket in exactly the order the per-gate sort
   * used to. No object is built per fan.
   */
  private admitAtGates(ctx: SimContext): void {
    const { dots } = ctx;
    const gates = this.gateIndexes;
    const gateCount = gates.length;
    if (gateCount === 0) return;
    const start = this.admitStart;
    start.fill(0, 0, gateCount + 1);

    // A gate with no budget left or a shut door admits nobody, so its fans are
    // not gathered and its field is never built — the same gates the per-gate
    // scan skipped outright.
    const fields = this.admitFields;
    for (let s = 0; s < gateCount; s++) {
      const gate = gates[s]!;
      const budget = Math.floor(this.gateBudget[gate]!);
      fields[s] = budget >= 1 && this.isOpen(ctx, gate) ? this.fields.field(gate, true) : undefined;
    }

    // Reach is measured along the flow field, not as a box around the gate's
    // centre. A gate is a block of cells, so a fan ten steps from its edge can
    // be thirteen cells from its middle: the box quietly refused to serve the
    // very front of the queue, and gates sat idle with people waiting.
    const reach = GATE_REACH_CELLS * WALK_STEP;
    const order = this.admitOrder;
    const slotOf = this.admitGate;
    const distOf = this.admitDist;
    const spawnOf = this.admitSpawn;
    const gateSlot = this.gateSlot;
    const cells = this.cellNow;
    let n = 0;
    for (let i = 0; i < dots.count; i++) {
      if (this.admitted[i] === 1) continue;
      const target = dots.targetPlace[i]!;
      // Targets index the places array, which also bounds the slot map.
      if (target < 0 || target >= gateSlot.length) continue;
      const slot = gateSlot[target]!;
      if (slot < 0) continue;
      const state = dots.state[i]!;
      if (state !== WALKING && state !== QUEUED) continue;
      const cell = cells[i]!;
      if (cell < 0) continue;
      const field = fields[slot];
      if (field === undefined) continue;
      const dist = field.dist[cell]!;
      if (dist > reach) continue;
      slotOf[i] = slot;
      distOf[i] = dist;
      spawnOf[i] = this.spawnT[i]!;
      order[n++] = i;
      start[slot + 1]!++;
    }
    // Bucket offsets, then one sort of the whole list. Buckets come out in gate
    // order and, within a gate, nearest first as before; the index tiebreak
    // makes the order total, so stability cannot come into it.
    for (let s = 1; s <= gateCount; s++) start[s] = start[s]! + start[s - 1]!;
    if (n > 1) {
      const waiting = order.subarray(0, n);
      waiting.sort(
        (a, b) => slotOf[a]! - slotOf[b]! || distOf[a]! - distOf[b]! || spawnOf[a]! - spawnOf[b]! || a - b,
      );
    }

    // First-come-first-served by position in the queue, not by dot index: the
    // fan nearest the turnstile goes first, then the next, so a high-index dot
    // cannot jump a low-index one that is still walking up.
    for (let s = 0; s < gateCount; s++) {
      const from = start[s]!;
      const to = start[s + 1]!;
      if (from === to) continue;
      const gate = gates[s]!;
      let budget = Math.floor(this.gateBudget[gate]!);
      if (budget < 1) continue;
      for (let k = from; k < to && budget >= 1; k++) {
        const i = order[k]!;
        this.admitted[i] = 1;
        this.flowIn[gate * FLOW_WINDOW_S + this.flowSlot]!++;
        // Through the turnstile: the bowl interior is not simulated, so the fan
        // is placed in their seat immediately.
        if (!this.placeSeated(ctx, i)) dots.setState(i, 'queued');
        budget--;
        this.gateBudget[gate]!--;
      }
    }
  }

  /** Non-seated dots in a cell: seated fans do not take walking space. */
  private standingAt(cell: number): number {
    return this.occupancy[cell]! - this.seatedHere[cell]!;
  }

  /** No more seat tracking once the fan is sitting down; their cell has one seat fewer. */
  private markSeated(i: number): void {
    const cell = this.cellNow[i]!;
    if (cell >= 0) this.seatedHere[cell]!++;
  }

  /**
   * The reverse of `markSeated`: a seated fan is on their feet again, so the
   * cell they are still standing in holds one seat fewer. `occupancy` is left
   * alone — they have not moved, they just no longer count as sitting.
   *
   * The floor at zero is a guard, not a correction: a fan marked standing
   * twice would otherwise hand the cell a negative seat count, and a cell
   * reading -1 sitters looks empty enough for another fan to sit in.
   */
  private markStanding(i: number): void {
    const cell = this.cellNow[i]!;
    if (cell >= 0 && this.seatedHere[cell]! > 0) this.seatedHere[cell]!--;
  }

  /** Move a dot straight to a cell: the bowl interior has no walking model. */
  private moveToCell(ctx: SimContext, i: number, cell: number, jitter = true): void {
    const { dots, map, rng } = ctx;
    // A rewind can move dots between steps, so the cache is checked, not assumed.
    this.ensureCells(ctx);
    const old = this.cellNow[i]!;
    // A seat does not travel with the fan. Leaving it — for a lot, the
    // concourse, or another seat — frees the old cell's seat count, or
    // `standingAt` and the density pass keep subtracting a sitter who is no
    // longer there, which reads as spare standing room and lets the cell take
    // an extra walker. `placeSeated` adds the new seat back via `markSeated`.
    if (old >= 0 && dots.state[i] === SEATED) this.markStanding(i);
    if (old >= 0) this.occupancy[old]!--;
    this.bumpOccupancy(cell);
    const x = (cell % map.width) + (jitter ? 0.15 + rng.next() * 0.7 : 0.5);
    const y = ((cell / map.width) | 0) + (jitter ? 0.15 + rng.next() * 0.7 : 0.5);
    dots.x[i] = Math.fround(x * CELL_SIZE_M);
    dots.y[i] = Math.fround(y * CELL_SIZE_M);
    this.cellNow[i] = cell;
  }

  /** Assigned seat if it has room, else the nearest free seat in that section, else any. */
  private chooseSeat(ctx: SimContext, i: number): number {
    const { dots, map } = ctx;
    const assigned = this.seatCell[i]!;
    if (assigned >= 0 && this.seatedHere[assigned]! < SEATS_PER_STANDS_CELL) return assigned;
    const section = assigned >= 0 ? this.sectorOfCell[assigned]! : -1;
    const cx = dots.x[i]! / CELL_SIZE_M;
    const cy = dots.y[i]! / CELL_SIZE_M;
    let best = -1;
    let bestD = Infinity;
    const scan = (cells: readonly number[]) => {
      for (const c of cells) {
        if (c === assigned) continue;
        if (this.seatLoad[c]! >= SEATS_PER_STANDS_CELL) continue;
        if (this.seatedHere[c]! >= SEATS_PER_STANDS_CELL) continue;
        const dx = (c % map.width) + 0.5 - cx;
        const dy = ((c / map.width) | 0) + 0.5 - cy;
        const d = dx * dx + dy * dy;
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
    };
    if (section >= 0) scan(this.sectorCells[section]!);
    if (best < 0 && this.seatingIndex >= 0) scan(map.places[this.seatingIndex]?.cells ?? []);
    return best;
  }

  /**
   * Put a fan in a seat immediately. Everything inside the bowl is instant: the
   * user decision is that walking inside the stadium is out of scope.
   */
  private placeSeated(ctx: SimContext, i: number): boolean {
    const seat = this.chooseSeat(ctx, i);
    if (seat < 0) return false;
    this.ensureCells(ctx);
    if (ctx.dots.state[i] === SEATED && this.cellNow[i] === seat) return true;
    const oldSeat = this.seatCell[i]!;
    this.moveToCell(ctx, i, seat);
    if (oldSeat !== seat) {
      if (oldSeat >= 0) this.seatLoad[oldSeat]!--;
      this.seatCell[i] = seat;
      this.seatLoad[seat]!++;
    }
    ctx.dots.targetPlace[i] = this.seatingIndex;
    this.markSeated(i);
    ctx.dots.setState(i, 'seated');
    return true;
  }

  /** Nearest concourse/shelter cell with standing room. */
  private shelterCell(ctx: SimContext, i: number): number {
    if (this.shelterIndex < 0) return -1;
    const { dots } = ctx;
    return this.shelterSearch?.nearest(dots.x[i]!/CELL_SIZE_M,dots.y[i]!/CELL_SIZE_M,
      cell=>this.fields.passable(cell)&&this.standingAt(cell)<MAX_DOTS_PER_CELL)??-1;
  }

  /** Put an admitted fan in shelter immediately, respecting the reserved capacity. */
  private placeSheltering(ctx: SimContext, i: number): boolean {
    if (ctx.dots.state[i] === SHELTERING && ctx.dots.targetPlace[i] === this.shelterIndex) return true;
    const place = this.shelterIndex >= 0 ? ctx.map.places[this.shelterIndex] : undefined;
    if (!place) return false;
    const capacity = Math.max(0, Math.floor((place.capacity ?? 40_000) / DOT_GROUP_SIZE));
    if (this.shelterReserved >= capacity) return false;
    const cell = this.shelterCell(ctx, i);
    if (cell < 0) return false;
    this.moveToCell(ctx, i, cell);
    this.shelterReserved++;
    ctx.dots.targetPlace[i] = this.shelterIndex;
    ctx.dots.setState(i, 'sheltering');
    return true;
  }

  /** First passable cell outside the shell at a gate, for an instant exit. */
  private outsideGateCell(ctx: SimContext, gate: number): number {
    const place = ctx.map.places[gate];
    if (!place) return -1;
    const roomy = (cell: number) =>
      cell >= 0 &&
      !this.insideBowl(cell) &&
      this.fields.passable(cell) &&
      this.standingAt(cell) < MAX_DOTS_PER_CELL;
    for (const cell of place.cells) if (roomy(cell)) return cell;
    for (const cell of place.cells) {
      const cx = cell % ctx.map.width;
      const cy = (cell / ctx.map.width) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const next = (cy + dy) * ctx.map.width + (cx + dx);
          if (roomy(next)) return next;
        }
      }
    }
    return -1;
  }

  /** Place an admitted fan just outside a gate; they walk to the lots from there. */
  private placeOutsideGate(ctx: SimContext, i: number, gate: number): boolean {
    const cell = this.outsideGateCell(ctx, gate);
    if (cell < 0) return false;
    this.moveToCell(ctx, i, cell);
    // Out through this gate: count it, as walking out through the door would.
    this.flowOut[gate * FLOW_WINDOW_S + this.flowSlot]!++;
    const dest = this.parkingIndex >= 0 ? this.parkingIndex : (this.exitIndexes[0] ?? -1);
    ctx.dots.targetPlace[i] = dest;
    ctx.dots.setState(i, 'walking');
    return true;
  }

  /** Leave by `via` if it is usable, else the nearest usable gate, then walk to the lots. */
  private leaveToLots(ctx: SimContext, i: number, via = -1): void {
    const nearest = this.usableExit(ctx, via) ? via : this.nearestExit(ctx, i);
    const gate = nearest >= 0 ? nearest : (this.gateIndexes[0] ?? -1);
    if (gate >= 0 && this.placeOutsideGate(ctx, i, gate)) return;
    // No room at the mouth: stay inside and retry next step; do not stack a
    // fifth dot on a full gate cell.
    const dest = this.parkingIndex >= 0 ? this.parkingIndex : (this.exitIndexes[0] ?? -1);
    if (dest >= 0) {
      // On their feet without having moved, because the exit failed: no
      // `moveToCell` runs to free the seat, so it is freed here. `occupancy`
      // still counts them, and now counts them as standing, which is right.
      if (ctx.dots.state[i] === SEATED) this.markStanding(i);
      ctx.dots.targetPlace[i] = dest;
      ctx.dots.setState(i, 'walking');
    }
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
        if (!this.placeOutsideGate(ctx, i, target)) {
          dots.targetPlace[i] = this.parkingIndex;
          dots.setState(i, 'walking');
        }
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
      // Reaching a bowl place is instant now: no walking inside the bowl.
      if (!this.placeSeated(ctx, i)) dots.setState(i, 'queued');
      return;
    }
    if (kind === 'shelter' || kind === 'concourse') {
      if (!this.placeSheltering(ctx, i)) dots.setState(i, 'queued');
      return;
    }
    if (kind === 'parking' || kind === 'exit') {
      dots.setState(i, 'gone');
      this.goneThisStep[this.goneCount++] = i;
      return;
    }
    dots.setState(i, 'walking');
  }

  /**
   * The per-cell counts this step rebuilt anyway, so DensityField does not have
   * to walk all the dots again. Live for the current step only: `touched` holds
   * exactly the cells whose count was cleared and rewritten since the rebuild,
   * and every other cell is still zero.
   */
  densityContribution(): DensityContribution {
    // Dots that reached a lot during this step changed to `gone` after the
    // rebuild, so their cells still hold a count no one has. Remove only those,
    // not dots that were already gone before the rebuild (they were never
    // counted and their cached cell may belong to someone else).
    for (let k = 0; k < this.goneCount; k++) {
      const i = this.goneThisStep[k]!;
      const cell = this.cellNow[i]!;
      if (cell >= 0 && this.occupancy[cell]! > 0) this.occupancy[cell]!--;
    }
    this.goneCount = 0;
    return {
      counts: this.occupancy,
      seated: this.seatedHere,
      touched: this.touchedCells,
      touchedCount: this.touchedCount,
    };
  }

  /** The per-dot and per-gate state the contract's Snapshot has no room for. */
  capture(): unknown {
    return {
      spawnT: this.spawnT.slice(),
      seatCell: this.seatCell.slice(),
      lotCell: this.lotCell.slice(),
      homeGate: this.homeGate.slice(),
      admitted: this.admitted.slice(),
      returningToCar: this.returningToCar.slice(),
      seatLoad: this.seatLoad.slice(),
      shelterReserved: this.shelterReserved,
      wasLightning: this.wasLightning,
      leaveAt: this.leaveAt.slice(),
      flowIn: this.flowIn.slice(),
      flowOut: this.flowOut.slice(),
      flowSlot: this.flowSlot,
      gateBudget: this.gateBudget.slice(),
      gateAssigned: this.gateAssigned.slice(),
    };
  }

  restore(state: unknown): void {
    // The dots' positions live in the snapshot, not here; the cell cache is
    // rebuilt on first use so it never outlives the positions it describes.
    this.cellCacheValid = false;
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
    take(this.returningToCar, (s as Record<string, unknown>).returningToCar);
    take(this.seatLoad, (s as Record<string, unknown>).seatLoad);
    this.shelterReserved = Number((s as Record<string, unknown>).shelterReserved ?? 0);
    this.wasLightning = Boolean((s as Record<string, unknown>).wasLightning ?? false);
    take(this.leaveAt, (s as Record<string, unknown>).leaveAt);
    take(this.flowIn, (s as Record<string, unknown>).flowIn);
    take(this.flowOut, (s as Record<string, unknown>).flowOut);
    this.flowSlot = Number((s as Record<string, unknown>).flowSlot ?? 0);
    take(this.gateBudget, (s as Record<string, unknown>).gateBudget);
    take(this.gateAssigned, (s as Record<string, unknown>).gateAssigned);
    // A checkpoint restores the closure IDs, but fields may still hold routes
    // built afterward. Force their cache to follow ctx.closed on the next step.
    this.closedKey = '\u0000';
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
  private insideBowl(cell: number): boolean {
    return this.bowlMask[cell] === 1;
  }

  /**
   * One step off a closed door: through the turnstile means inward to their
   * seat, otherwise outward to where they parked. Closed cells may be crossed
   * on the way off; walls and full cells may not.
   */
  private clearDoor(ctx: SimContext, i: number, cell: number, dt: number): void {
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
      if (nCell !== cell && this.standingAt(nCell) >= MAX_DOTS_PER_CELL) continue;
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
      this.occupancy[cell]!--;
      this.bumpOccupancy(best);
    }
    dots.x[i] = bx;
    dots.y[i] = by;
    this.cellNow[i] = best;
    dots.setState(i, 'walking');
  }

  /** True when this gate's door is open (a place with no door is always open). */
  private isOpen(ctx: SimContext, place: number): boolean {
    const door = this.gateDoor.get(place);
    return door === undefined || !ctx.closed.has(door);
  }

  /** An exit needs an open door and an exterior route onward to parking. */
  private usableExit(ctx: SimContext, place: number): boolean {
    if (place < 0 || !this.isOpen(ctx, place)) return false;
    if (this.parkingIndex < 0 || ctx.map.places[place]?.kind !== 'gate') return true;
    // Gate 8 on the stadium map opens into a pocket surrounded by the bowl.
    const outside = this.fields.field(this.parkingIndex, true);
    return ctx.map.places[place]!.cells.some((cell) => outside.dist[cell] !== UNREACHABLE);
  }

  /** The nearest usable gate to leave by; any gate if none is usable. */
  private nearestExit(ctx: SimContext, dot: number): number {
    const open = this.exitIndexes.filter((g) => this.usableExit(ctx, g));
    return this.nearest(ctx, dot, open.length > 0 ? open : this.exitIndexes);
  }

  /**
   * The gate rule: nobody steps into the bowl from outside without going
   * through a turnstile. Routes already lead through the gates; this is what
   * holds when some other choice sends an unscreened fan toward the inside.
   */
  private unscreenedEntry(dot: number, from: number, to: number): boolean {
    return this.admitted[dot] !== 1 && !this.insideBowl(from) && this.insideBowl(to);
  }

  /** In and out per minute, who is waiting, and the door, for every gate. */
  gateStats(ctx: SimContext): GateStat[] {
    const { map, dots } = ctx;
    // The queue is who is standing in line near the gate. Counting everyone
    // headed there put 1,280 people "waiting" at a shut gate who were still
    // hundreds of metres away and had not reached it to be turned away.
    const waiting = new Int32Array(map.places.length);
    for (let i = 0; i < dots.count; i++) {
      if (this.admitted[i] === 1 || dots.state[i] !== QUEUED) continue;
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

  /** Move every fan still targeting a shut gate to the nearest open one. */
  private redirectClosedGates(ctx: SimContext): void {
    const { dots } = ctx;
    for (const gate of this.gateIndexes) {
      if (this.isOpen(ctx, gate)) continue;
      for (let i = 0; i < dots.count; i++) {
        if (this.admitted[i] === 1 || dots.targetPlace[i] !== gate) continue;
        const nearest = this.nearestOpenGate(ctx, i, gate);
        const other = nearest >= 0 ? nearest : (this.gateIndexes.find((g) => this.isOpen(ctx, g)) ?? -1);
        if (other >= 0) this.retarget(ctx, i, other);
      }
    }
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
    // A corridor walk cell with no exterior route counts as inside.
    const inside = this.insideBowl(cell) || (this.admitted[i] === 1 && this.parkingIndex >= 0 &&
      this.fields.field(this.parkingIndex, true).dist[cell] === UNREACHABLE);
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
    const kind = ctx.map.places[target]?.kind;
    if (this.admitted[i] === 1) {
      const cell = this.cellOf(ctx, i);
      const inside = cell >= 0 && this.insideBowl(cell);
      if (!inside && (kind === 'seating' || kind === 'concourse' || kind === 'shelter')) {
        // Already outside the bowl: they are a walk-in fan again and must queue
        // at a gate, not be teleported back through the shell.
        this.returnToGate(ctx, i);
        return;
      }
      if (kind === 'seating') {
        if (this.placeSeated(ctx, i)) return;
      } else if (kind === 'concourse' || kind === 'shelter') {
        if (this.placeSheltering(ctx, i)) return;
        this.leaveToLots(ctx, i);
        return;
      } else if (inside && (kind === 'parking' || kind === 'exit' || kind === 'gate')) {
        this.leaveToLots(ctx, i);
        return;
      }
    }
    ctx.dots.targetPlace[i] = target;
    ctx.dots.setState(i, 'walking');
  }

  /** Put a fan back in the entry queue at the nearest open gate. */
  private returnToGate(ctx: SimContext, i: number): void {
    const nearest = this.nearestOpenGate(ctx, i, -1);
    const gate = nearest >= 0 ? nearest : (this.gateIndexes[0] ?? -1);
    this.admitted[i] = 0;
    if (gate >= 0) {
      ctx.dots.targetPlace[i] = gate;
      ctx.dots.setState(i, 'walking');
    }
  }

  /**
   * The commander sent this group somewhere by hand. A fan not yet through a
   * turnstile cannot be sent straight to a seat or the concourse, which are
   * inside the bowl: they go to their gate first and on from there as usual.
   */
  sendTo(ctx: SimContext, dot: number, place: number): void {
    this.returningToCar[dot] = 0;
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

  /**
   * A late rush on one gate: the `count` fans parked nearest it (by walking
   * distance) arrive in a burst between `fromS` and `toS` and all make for it.
   * Taken from the crowd already spawned, so the crowd is the same size and
   * the same fans rush in every plan.
   */
  lateRush(ctx: SimContext, gate: number, count: number, fromS: number, toS: number): void {
    const { dots, rng } = ctx;
    const field = this.fields.field(gate, true);
    const candidates: number[] = [];
    for (let i = 0; i < dots.count; i++) {
      if (dots.state[i] !== ARRIVING || field.dist[this.lotCell[i]!] === UNREACHABLE) continue;
      candidates.push(i);
    }
    candidates.sort((a, b) => field.dist[this.lotCell[a]!]! - field.dist[this.lotCell[b]!]! || a - b);
    for (const i of candidates.slice(0, count)) {
      const home = this.homeGate[i]!;
      if (home >= 0) this.gateAssigned[home]!--;
      this.homeGate[i] = gate;
      this.gateAssigned[gate]!++;
      dots.targetPlace[i] = gate;
      this.spawnT[i] = fromS + (toS - fromS) * rng.next();
    }
  }

  /** The game ended early: anyone still on their way turns round and never arrives. */
  release(ctx: SimContext): void {
    const { dots } = ctx;
    for (let i = 0; i < dots.count; i++) if (dots.state[i] === ARRIVING) dots.setState(i, 'gone');
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
    // A release supersedes entry-queue instructions still repeated by officers.
    if (this.returningToCar[dot]) return;

    switch (situation) {
      case 'lightning_shelter':
        if (option === 'go_concourse') {
          // Outside the bowl (or not admitted) there is no concourse to reach
          // without a turnstile: shelter at the cars and buildings instead.
          if (this.admitted[dot] !== 1 || !this.insideBowl(this.cellOf(ctx, dot))) {
            if (this.parkingIndex >= 0) this.retarget(ctx, dot, this.parkingIndex);
            return;
          }
          if (!this.placeSheltering(ctx, dot)) this.leaveToLots(ctx, dot);
          return;
        }
        if (option === 'go_car') {
          if (this.admitted[dot] === 1 && this.insideBowl(this.cellOf(ctx, dot))) this.leaveToLots(ctx, dot);
          else this.retarget(ctx, dot, this.parkingIndex);
        }
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
        if (option === 'follow' && ctx.officerRelief?.size) {
          const cell = this.cellOf(ctx, dot);
          let directive = -1, closest = Infinity;
          for (const officer of ctx.officers) {
            const gate = ctx.officerRelief.get(officer.id);
            if (gate === undefined || !this.isOpen(ctx, gate)) continue;
            const dx = officer.cell % ctx.map.width - cell % ctx.map.width;
            const dy = Math.floor(officer.cell / ctx.map.width) - Math.floor(cell / ctx.map.width);
            if (Math.abs(dx) > officer.radiusCells || Math.abs(dy) > officer.radiusCells) continue;
            if (dx * dx + dy * dy < closest) {closest = dx * dx + dy * dy; directive = gate;}
          }
          if (directive >= 0 && this.admitted[dot] !== 1 && !this.returningToCar[dot] &&
              this.fields.field(directive, true).dist[cell] !== UNREACHABLE) {
            if (directive !== dots.targetPlace[dot]) this.retarget(ctx, dot, directive);
            return;
          }
        }
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
        if (dots.state[dot] === ARRIVING || dots.state[dot] === GONE) return;
        if (this.admitted[dot] !== 1) {
          // Unscreened fans have no seat to wait in. Keep them outside and send
          // them to their own lot, preferring a named lot to the combined place.
          const ownLot = this.parkingByCell[this.lotCell[dot]!]!;
          this.returningToCar[dot] = 1;
          this.retarget(ctx, dot, ownLot >= 0 ? ownLot : this.parkingIndex);
          return;
        }
        if (option === 'nearest_exit' || option === 'my_gate') {
          // Inside the bowl they are placed outside the gate at once; someone
          // already outside just walks to the lots, with no teleport.
          const cell = this.cellOf(ctx, dot);
          const inside = cell >= 0 && this.insideBowl(cell);
          if (inside) this.leaveToLots(ctx, dot, option === 'my_gate' ? this.homeGate[dot]! : -1);
          else if (this.parkingIndex >= 0) this.retarget(ctx, dot, this.parkingIndex);
        } else if (option === 'wait_in_seat') {
          if (dots.state[dot] !== SEATED && dots.state[dot] !== SHELTERING) {
            // On their feet already: they leave now. retarget places a fan
            // still inside outside a gate, and walks one outside to the lots.
            this.retarget(ctx, dot, this.parkingIndex);
            return;
          }
          // Letting it thin out is not staying for good.
          const [lo, hi] = WAIT_IN_SEAT_S;
          this.leaveAt[dot] = ctx.t + lo + (hi - lo) * ctx.rng.next();
        }
        return;

      case 'leave_early':
        if (option === 'leave_now') this.retarget(ctx, dot, this.parkingIndex);
        return;

      case 'leave_tailgate':
        if (option === 'go_now' && dots.state[dot] === ARRIVING) this.spawnT[dot] = ctx.t;
        return;

      default:
        return;
    }
  }
}
