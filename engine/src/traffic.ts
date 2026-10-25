import type { Id, Incident, MapBundle, Population, SimSeconds, TrafficConfig, VehicleFrame, VehicleKind, WeatherState } from '../../contracts.ts';
import { CELL_SIZE_M, DOT_GROUP_SIZE, VEHICLE_KINDS, VEHICLE_STATES } from '../../contracts.ts';
import { expandCells } from '../../world/src/incidents.ts';
import { isLongVehicle, VEHICLE_TYPES } from '../../world/src/vehicles.ts';
import { driveFactor } from '../../world/src/weather.ts';
import type { DensityField } from './density.ts';
import type { DotStore } from './dots.ts';
import { STATE_INDEX } from './dots.ts';
import { DIR_DX, DIR_DY, UNREACHABLE } from './flowfield.ts';
import { Rng } from './rng.ts';
import { parkingConnectors } from './traffic-access.ts';

/**
 * Vehicle traffic. Plain code, like the crowd: no AI moves a car.
 *
 * Vehicles drive flow fields over the road cells, much as fans walk theirs, and
 * the same three ideas carry over. A vehicle occupies the cells under its real
 * footprint and may not drive into one another vehicle holds, so queues back up
 * bumper to bumper. It sidesteps into the next lane when its own is blocked.
 * And it yields to people: a car does not drive into a crowd, which is how a
 * game letting out stops traffic dead on Lane Avenue.
 *
 * Traffic reads the crowd and never writes to it. It runs on its own RNG
 * stream, so turning traffic on cannot move a single fan — the pedestrian
 * scorecard of a run with traffic is exactly the one without.
 */

const KIND_INDEX = Object.fromEntries(VEHICLE_KINDS.map((k, i) => [k, i])) as Record<VehicleKind, number>;
const VSTATE = Object.fromEntries(VEHICLE_STATES.map((s, i) => [s, i])) as Record<(typeof VEHICLE_STATES)[number], number>;

/** What a vehicle is trying to do. Kept apart from the display state, which also says "stopped". */
const MODE_WAITING = 0;
const MODE_INBOUND = 1;
const MODE_PARKING = 2;
const MODE_PARKED = 3;
const MODE_OUTBOUND = 4;
const MODE_EMS = 5;
const MODE_ON_SCENE = 6;
const MODE_GONE = 7;

/** Cell classes vehicles may use. EMS may also use plazas and the concourse ring. */
const MASK_ROAD = 1;
const MASK_PARKING = 2;
const MASK_DRIVEWAY = 3;
const MASK_EMS_ONLY = 4;

/** Lot layout: 2.7 m stalls, 5.5 m deep, back to back, with a 6 m aisle. */
const STALL_PITCH_M = 2.7;
const STALL_DEPTH_M = 5.5;
const AISLE_M = 6;
const ROW_PERIOD_M = STALL_DEPTH_M * 2 + AISLE_M;

const ACCEL_MPS2 = 2.5;
const LOT_SPEED_MPS = 4.5;
const CRAWL_SPEED_MPS = 2;
const PARK_SPEED_MPS = 2.5;
/** People per m² at which a car slows to a crawl, and at which it stops. */
const CROWD_SLOW = 0.5;
const CROWD_STOP = 2.5;
const CROWD_STOP_EMS = 3.5;
/**
 * After this long boxed in, a vehicle squeezes past other vehicles (never past
 * people). Single-cell lanes at a four-way junction can lock solid otherwise:
 * each car waits on the next, all the way round, and nothing ever moves.
 */
const SQUEEZE_AFTER_S = 25;
const RIDESHARE_DWELL_S = 45;

/**
 * Fields held for the closure set in force. A lot crossing full and empty makes
 * a layout recur — a ride share parked on the last stall leaves the same lot as
 * full as it found it — and a few layouts cover that without keeping a whole
 * map's worth of grids alive.
 */
const FIELD_CACHE_MAX = 6;

/**
 * Queue capacity for a ring buffer holding every cell at once: one power of
 * two, with a slot left free so full and empty stay distinguishable.
 */
function ringCapacity(n: number): number {
  let cap = 2;
  while (cap <= n) cap <<= 1;
  return cap;
}

interface Field {
  dist: Uint16Array;
  dir: Uint8Array;
}

/** Static road network for one map: built once per worker. */
interface RoadNet {
  mask: Uint8Array;
  lotOf: Int16Array;
  lotCount: number;
  stallX: Float32Array;
  stallY: Float32Array;
  stallHeading: Float32Array;
  stallLot: Int16Array;
  /** Next stall along the same row, or -1. Long vehicles take a run of these. */
  stallNext: Int32Array;
  stallsByLot: Int32Array[];
  border: number[];
  entries: { cell: number; weight: number }[];
}

const nets = new WeakMap<MapBundle, RoadNet>();

function buildRoadNet(map: MapBundle): RoadNet {
  const { width: W, height: H, cells } = map;
  const size = W * H;
  const mask = new Uint8Array(size);
  // A six-metre apron around every lot is the calibrated model on Ohio. A lot
  // the apron leaves unreachable gets one narrow connector, so imported grounds
  // do not need a map-id branch and no whole sidewalk becomes a road.
  const nearLot = new Uint8Array(size);
  for (let c = 0; c < size; c++) {
    if (cells[c] !== 'parking') continue;
    const cx = c % W, cy = Math.floor(c / W);
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x >= 0 && y >= 0 && x < W && y < H) nearLot[y * W + x] = 1;
      }
    }
  }
  for (let i = 0; i < size; i++) {
    const kind = cells[i];
    if (kind === 'road') mask[i] = MASK_ROAD;
    else if (kind === 'parking') mask[i] = MASK_PARKING;
    else if (kind === 'walk' && nearLot[i] === 1) mask[i] = MASK_DRIVEWAY;
    else if (kind === 'walk' || kind === 'concourse') mask[i] = MASK_EMS_ONLY;
  }

  // Where roads leave the map. These are both where traffic comes from and
  // where it goes.
  const border: number[] = [];
  const isBorderRoad = (x: number, y: number) => mask[y * W + x] === MASK_ROAD;
  for (let x = 0; x < W; x++) {
    if (isBorderRoad(x, 0)) border.push(x);
    if (isBorderRoad(x, H - 1)) border.push((H - 1) * W + x);
  }
  for (let y = 1; y < H - 1; y++) {
    if (isBorderRoad(0, y)) border.push(y * W);
    if (isBorderRoad(W - 1, y)) border.push(y * W + W - 1);
  }

  // Reachable from the edge, through general-traffic cells only. The mask can
  // grow after the first flood when a connector is added, so this is a helper.
  const reach = new Uint8Array(size);
  const queue = new Int32Array(size);
  const floodReach = () => {
    reach.fill(0);
    let head = 0;
    let tail = 0;
    for (const c of border) {
      reach[c] = 1;
      queue[tail++] = c;
    }
    while (head < tail) {
      const c = queue[head++]!;
      const cx = c % W;
      const cy = (c / W) | 0;
      for (let d = 1; d <= 7; d += 2) {
        const x = cx + DIR_DX[d]!;
        const y = cy + DIR_DY[d]!;
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const n = y * W + x;
        if (reach[n] || mask[n] === 0 || mask[n] === MASK_EMS_ONLY) continue;
        reach[n] = 1;
        queue[tail++] = n;
      }
    }
  };
  floodReach();
  // Lots the apron leaves cut off get the single shortest connector to a road
  // over walkable ground, then the flood runs again.
  const unreached = new Uint8Array(size);
  let anyUnreached = false;
  for (let c = 0; c < size; c++) {
    if (cells[c] === 'parking' && reach[c] === 0) {
      unreached[c] = 1;
      anyUnreached = true;
    }
  }
  if (anyUnreached) {
    const connectors = parkingConnectors(map, 30, unreached);
    let added = false;
    for (let c = 0; c < size; c++) {
      if (connectors[c] === 1 && mask[c] !== MASK_DRIVEWAY) {
        mask[c] = MASK_DRIVEWAY;
        added = true;
      }
    }
    if (added) floodReach();
  }

  // Named lots only; the combined "All lots" place overlaps every one of them.
  const lotOf = new Int16Array(size).fill(-1);
  const lots = map.places.filter((p) => p.kind === 'parking' && p.id !== 'lots');

  lots.forEach((lot, index) => {
    for (const c of lot.cells) if (cells[c] === 'parking') lotOf[c] = index;
  });

  const sx: number[] = [];
  const sy: number[] = [];
  const sh: number[] = [];
  const sl: number[] = [];
  const sn: number[] = [];
  const byLot: number[][] = lots.map(() => []);
  const inLot = (lot: number, x: number, y: number) => {
    const cx = Math.floor(x / CELL_SIZE_M);
    const cy = Math.floor(y / CELL_SIZE_M);
    if (cx < 0 || cy < 0 || cx >= W || cy >= H) return false;
    const c = cy * W + cx;
    return lotOf[c] === lot && reach[c] === 1;
  };
  lots.forEach((lot, index) => {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const c of lot.cells) {
      const x = c % W;
      const y = (c / W) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (!Number.isFinite(minX)) return;
    const x0 = minX * CELL_SIZE_M;
    const x1 = (maxX + 1) * CELL_SIZE_M;
    const y0 = minY * CELL_SIZE_M;
    const y1 = (maxY + 1) * CELL_SIZE_M;
    // Two rows back to back, noses facing the aisles either side of them.
    for (let base = y0; base < y1; base += ROW_PERIOD_M) {
      for (const [offset, heading] of [
        [STALL_DEPTH_M / 2, -Math.PI / 2],
        [STALL_DEPTH_M * 1.5, Math.PI / 2],
      ] as const) {
        const y = base + offset;
        let previous = -1;
        for (let x = x0 + STALL_PITCH_M / 2; x <= x1 - STALL_PITCH_M / 2; x += STALL_PITCH_M) {
          const ok =
            inLot(index, x, y) && inLot(index, x, y - STALL_DEPTH_M * 0.42) && inLot(index, x, y + STALL_DEPTH_M * 0.42);
          if (!ok) {
            previous = -1;
            continue;
          }
          const id = sx.length;
          sx.push(x);
          sy.push(y);
          sh.push(heading);
          sl.push(index);
          sn.push(-1);
          if (previous >= 0) sn[previous] = id;
          previous = id;
          byLot[index]!.push(id);
        }
      }
    }
  });

  // Traffic only enters where a road actually leads to a lot with stalls in it. Many border cells
  // are the stub ends of service roads that go nowhere; a car spawned on one
  // sat there for the whole run, and the cars queued behind it never got in.
  const toLots = new Uint8Array(size);
  let head = 0;
  let tail = 0;
  for (let c = 0; c < size; c++) {
    if (lotOf[c]! >= 0 && byLot[lotOf[c]!]!.length > 0 && reach[c] === 1) {
      toLots[c] = 1;
      queue[tail++] = c;
    }
  }
  while (head < tail) {
    const c = queue[head++]!;
    const cx = c % W;
    const cy = (c / W) | 0;
    for (let d = 1; d <= 7; d += 2) {
      const x = cx + DIR_DX[d]!;
      const y = cy + DIR_DY[d]!;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const n = y * W + x;
      if (toLots[n] || mask[n] === 0 || mask[n] === MASK_EMS_ONLY) continue;
      toLots[n] = 1;
      queue[tail++] = n;
    }
  }

  // Entry points: runs of border road cells, one per road crossing the edge,
  // weighted by how wide the road is — the freeway brings more cars than an alley.
  const borderSet = new Set(border);
  const seen = new Set<number>();
  const entries: { cell: number; weight: number }[] = [];
  for (const start of border) {
    if (seen.has(start)) continue;
    const run: number[] = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const c = stack.pop()!;
      run.push(c);
      const cx = c % W;
      const cy = (c / W) | 0;
      for (let d = 1; d <= 8; d++) {
        const x = cx + DIR_DX[d]!;
        const y = cy + DIR_DY[d]!;
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const n = y * W + x;
        if (!borderSet.has(n) || seen.has(n)) continue;
        seen.add(n);
        stack.push(n);
      }
    }
    run.sort((a, b) => a - b);
    const cell = run[run.length >> 1]!;
    if (toLots[cell]) entries.push({ cell, weight: run.length });
  }

  return {
    mask,
    lotOf,
    lotCount: lots.length,
    stallX: Float32Array.from(sx),
    stallY: Float32Array.from(sy),
    stallHeading: Float32Array.from(sh),
    stallLot: Int16Array.from(sl),
    stallNext: Int32Array.from(sn),
    stallsByLot: byLot.map((list) => Int32Array.from(list)),
    border,
    entries,
  };
}

export function roadNetFor(map: MapBundle): RoadNet {
  let net = nets.get(map);
  if (!net) {
    net = buildRoadNet(map);
    nets.set(map, net);
  }
  return net;
}

/** How many stalls the mapped, reachable lots hold. */
export function stallCount(map: MapBundle): number {
  return roadNetFor(map).stallX.length;
}

/** Leave headroom for arrivals and long vehicles instead of filling a small map at startup. */
export function trafficCapacity(map: MapBundle) {
  const net = roadNetFor(map);
  return {stalls: net.stallX.length, entries: net.entries.length,
    vehicles: Math.min(4500, Math.floor(net.stallX.length * 0.85))};
}

export interface TrafficInit {
  map: MapBundle;
  config: TrafficConfig;
  population: Population;
  incident: Incident;
  startAt: SimSeconds;
  endAt: SimSeconds;
  /** When the stands empty, if this run reaches the end of the game. */
  gameEndAt?: SimSeconds;
}

export interface TrafficStepInput {
  /** Live officers meter entry to these junctions; routes and closures still apply. */
  controlPoints?: readonly number[];
  t: SimSeconds;
  dt: SimSeconds;
  weather: WeatherState;
  density: DensityField;
  dots: DotStore;
  closed: ReadonlySet<Id>;
}

export interface TrafficMetrics {
  stopped: number;
  out: number;
  emergencyDispatched: boolean;
  emergencyOnScene: boolean;
}

const GONE_DOT = STATE_INDEX.gone;

export class TrafficModel {
  private controlPoints: readonly number[] = [];
  private signalTime = 0;
  readonly count: number;
  /** Index of the ambulance, or -1 when no emergency response was asked for. */
  readonly ambulance: number;
  private readonly police: number;

  private readonly map: MapBundle;
  private readonly net: RoadNet;
  private readonly init: TrafficInit;
  private readonly rng: Rng;

  // Per vehicle. The position is the FRONT bumper, which is what queues on.
  private readonly hx: Float32Array;
  private readonly hy: Float32Array;
  private readonly heading: Float32Array;
  private readonly speed: Float32Array;
  private readonly kind: Uint8Array;
  private readonly mode: Uint8Array;
  private readonly blocked: Uint8Array;
  private readonly waited: Float32Array;
  private readonly stuck: Float32Array;
  private readonly arriveT: Float32Array;
  private readonly departT: Float32Array;
  private readonly entry: Int32Array;
  private readonly stall: Int32Array;
  private readonly stallRun: Uint8Array;
  private readonly targetX: Float32Array;
  private readonly targetY: Float32Array;
  private readonly targetHeading: Float32Array;

  private readonly stallTaken: Uint8Array;
  private readonly lotFree: Int32Array;
  private readonly lotDemand: Int32Array;
  private readonly dotCounted: Uint8Array;

  private readonly occOwner: Int32Array;
  private readonly occCount: Uint8Array;
  /**
   * Cells that hold a count since the last rebuild. The clear visits these
   * instead of the whole grid; every cell is listed at most once, because a
   * cell is recorded only on the step from 0 to 1.
   */
  private readonly occTouched: Int32Array;
  private occTouchedCount = 0;
  private readonly closedCells: Uint8Array;
  private closedKey = '\u0000';

  private lotsField: Field | null = null;
  private exitField: Field | null = null;
  private emsField: Field | null = null;
  private lotsDirty = true;
  /**
   * Fields already built for the closure set in force, by what they were built
   * from. A build walks the whole map, and traffic reran it whenever any lot
   * crossed full or empty, even where that left the free lots — and so the
   * seeds — exactly as they were. A field follows from the closed cells and its
   * seeds alone, so the same key reuses the same field; a closure change
   * empties the cache, as `FlowFields.setClosed` does.
   */
  private readonly fieldCache = new Map<string, Field>();
  private readonly bfsQueue: Int32Array;
  /** Cells the field being built reached, in discovery order. */
  private readonly fieldTouched: Int32Array;

  private out = 0;
  private emergencyDispatched = false;
  private emergencyOnScene = false;

  constructor(init: TrafficInit) {
    this.init = init;
    this.map = init.map;
    this.net = roadNetFor(init.map);
    this.rng = new Rng(init.config.seed);
    const general = Math.max(0, Math.floor(init.config.vehicles));
    const ems = init.config.emergencyResponse ? 2 : 0;
    const n = general + ems;
    this.count = n;
    this.ambulance = ems ? general : -1;
    this.police = ems ? general + 1 : -1;

    this.hx = new Float32Array(n).fill(-1);
    this.hy = new Float32Array(n).fill(-1);
    this.heading = new Float32Array(n);
    this.speed = new Float32Array(n);
    this.kind = new Uint8Array(n);
    this.mode = new Uint8Array(n);
    this.blocked = new Uint8Array(n);
    this.waited = new Float32Array(n);
    this.stuck = new Float32Array(n);
    this.arriveT = new Float32Array(n).fill(Infinity);
    this.departT = new Float32Array(n).fill(Infinity);
    this.entry = new Int32Array(n).fill(-1);
    this.stall = new Int32Array(n).fill(-1);
    this.stallRun = new Uint8Array(n);
    this.targetX = new Float32Array(n);
    this.targetY = new Float32Array(n);
    this.targetHeading = new Float32Array(n);

    const size = init.map.width * init.map.height;
    this.stallTaken = new Uint8Array(this.net.stallX.length);
    this.lotFree = Int32Array.from(this.net.stallsByLot.map((s) => s.length));
    this.lotDemand = new Int32Array(this.net.lotCount);
    this.dotCounted = new Uint8Array(init.population.dots);
    this.occOwner = new Int32Array(size);
    this.occCount = new Uint8Array(size);
    this.occTouched = new Int32Array(size);
    this.closedCells = new Uint8Array(size);
    this.fieldTouched = new Int32Array(size);
    this.bfsQueue = new Int32Array(ringCapacity(size));

    this.spawn(general);
    if (ems) {
      this.kind[this.ambulance] = KIND_INDEX.ambulance;
      this.kind[this.police] = KIND_INDEX.police;
    }
  }

  private type(i: number) {
    return VEHICLE_TYPES[VEHICLE_KINDS[this.kind[i]!]!];
  }

  /** Who is already parked at kickoff minus 60, and when everyone else turns up. */
  private spawn(general: number): void {
    const { rng, init, net } = this;
    const kinds = VEHICLE_KINDS.filter((k) => VEHICLE_TYPES[k].share > 0);
    const cumulative: number[] = [];
    let acc = 0;
    for (const k of kinds) cumulative.push((acc += VEHICLE_TYPES[k].share));
    const types = init.population.types;
    const typeCumulative: number[] = [];
    acc = 0;
    for (const t of types) typeCumulative.push((acc += t.share));

    const entryTotal = net.entries.reduce((s, e) => s + e.weight, 0);
    const pickEntry = () => {
      let roll = rng.next() * entryTotal;
      for (const e of net.entries) {
        roll -= e.weight;
        if (roll < 0) return e.cell;
      }
      return net.entries[net.entries.length - 1]?.cell ?? -1;
    };

    // Free stalls in a bag, for placing whoever arrived before the run starts.
    const bag = Int32Array.from({ length: net.stallX.length }, (_, i) => i);
    let bagSize = bag.length;

    for (let i = 0; i < general; i++) {
      const roll = rng.next();
      let k = cumulative.findIndex((c) => roll < c);
      if (k < 0) k = kinds.length - 1;
      const kind = kinds[k]!;
      this.kind[i] = KIND_INDEX[kind];
      this.entry[i] = pickEntry();

      // A car arrives when its fans do: borrow a fan type's arrival window.
      const typeRoll = rng.next();
      let ti = typeCumulative.findIndex((c) => typeRoll < c);
      if (ti < 0) ti = types.length - 1;
      const [from, to] = types[ti]!.arrivalWindowMin;
      let arrive = -(from + (to - from) * rng.next()) * 60;

      if (kind === 'rideshare') {
        // Drop-offs run all through the window, and pickups at the final whistle.
        const end = init.gameEndAt ?? Math.min(init.endAt, 900);
        const begin = init.gameEndAt !== undefined ? init.gameEndAt - 600 : init.startAt;
        arrive = begin + rng.next() * Math.max(60, end + (init.gameEndAt !== undefined ? 2400 : 0) - begin);
        this.arriveT[i] = arrive;
        this.mode[i] = MODE_WAITING;
        continue;
      }

      if (arrive <= init.startAt && bagSize > 0) {
        // Already parked. Long vehicles need a run of stalls along one row.
        let placed = false;
        for (let attempt = 0; attempt < 24 && !placed && bagSize > 0; attempt++) {
          const pick = rng.int(bagSize);
          const s = bag[pick]!;
          if (this.stallTaken[s]) {
            bag[pick] = bag[--bagSize]!;
            continue;
          }
          const run = this.runFrom(s, i);
          if (run === 0) continue;
          this.occupyStalls(i, s, run);
          this.placeAtStall(i);
          this.mode[i] = MODE_PARKED;
          placed = true;
        }
        // Late windows cannot replay an hours-old arrival just because the
        // random probes missed a long vehicle's contiguous stalls.
        const lastArrival = Math.max(...types.map((type) => -Math.min(...type.arrivalWindowMin) * 60));
        if (!placed && init.startAt >= lastArrival + 3600) {
          for (let s = 0; s < net.stallX.length; s++) {
            const run = this.runFrom(s, i);
            if (run === 0) continue;
            this.occupyStalls(i, s, run);
            this.placeAtStall(i);
            this.mode[i] = MODE_PARKED;
            placed = true;
            break;
          }
        }
        if (placed) {
          this.scheduleExodus(i);
          continue;
        }
      }
      this.arriveT[i] = Math.max(arrive, init.startAt);
      this.mode[i] = MODE_WAITING;
      this.scheduleExodus(i);
    }
  }

  /** At the final whistle, people walk back to their cars and drive off over the next hour. */
  private scheduleExodus(i: number): void {
    const end = this.init.gameEndAt;
    if (end === undefined) return;
    const u = this.rng.next();
    this.departT[i] = end + (6 + 50 * Math.pow(u, 1.3)) * 60;
  }

  /** How many stalls vehicle i needs in a row starting at s, or 0 if they are not free. */
  private runFrom(s: number, i: number): number {
    const kind = VEHICLE_KINDS[this.kind[i]!]!;
    const need = isLongVehicle(kind) ? Math.ceil((VEHICLE_TYPES[kind].lengthM + 0.6) / STALL_PITCH_M) : 1;
    let at = s;
    for (let k = 0; k < need; k++) {
      if (at < 0 || this.stallTaken[at]) return 0;
      if (k < need - 1) at = this.net.stallNext[at]!;
    }
    return need;
  }

  private occupyStalls(i: number, s: number, run: number): void {
    const lot = this.net.stallLot[s]!;
    let at = s;
    let sx = 0;
    for (let k = 0; k < run; k++) {
      this.stallTaken[at] = 1;
      sx += this.net.stallX[at]!;
      at = this.net.stallNext[at]!;
    }
    this.lotFree[lot]! -= run;
    if (this.lotFree[lot]! <= 0) this.lotsDirty = true;
    this.stall[i] = s;
    this.stallRun[i] = run;

    const type = this.type(i);
    if (run > 1) {
      // Parked along the row, across the stalls it took.
      const cx = sx / run;
      const heading = 0;
      this.targetHeading[i] = heading;
      this.targetX[i] = cx + (Math.cos(heading) * type.lengthM) / 2;
      this.targetY[i] = this.net.stallY[s]!;
    } else {
      const heading = this.net.stallHeading[s]!;
      this.targetHeading[i] = heading;
      this.targetX[i] = this.net.stallX[s]!;
      this.targetY[i] = this.net.stallY[s]! + (Math.sin(heading) * type.lengthM) / 2;
    }
  }

  private releaseStalls(i: number): void {
    let at = this.stall[i]!;
    if (at < 0) return;
    const lot = this.net.stallLot[at]!;
    const wasFull = this.lotFree[lot]! <= 0;
    for (let k = 0; k < this.stallRun[i]! && at >= 0; k++) {
      this.stallTaken[at] = 0;
      at = this.net.stallNext[at]!;
    }
    this.lotFree[lot]! += this.stallRun[i]!;
    if (wasFull) this.lotsDirty = true;
    this.stall[i] = -1;
    this.stallRun[i] = 0;
  }

  private placeAtStall(i: number): void {
    this.hx[i] = this.targetX[i]!;
    this.hy[i] = this.targetY[i]!;
    this.heading[i] = this.targetHeading[i]!;
    this.speed[i] = 0;
  }

  // ─── fields ───

  private allowed(cell: number, ems: boolean): boolean {
    const m = this.net.mask[cell]!;
    return m !== 0 && (ems || m !== MASK_EMS_ONLY);
  }

  /** Closed cells are escape-only; diagonals must not cut a barricade corner. */
  private canStep(from: number, to: number, ems: boolean): boolean {
    const open = (cell: number) => this.allowed(cell, ems) &&
      (this.closedCells[cell] !== 1 || this.closedCells[from] === 1);
    if (!open(to)) return false;
    const W = this.map.width;
    if (from % W !== to % W && Math.floor(from / W) !== Math.floor(to / W)) {
      if (!open(Math.floor(from / W) * W + to % W) || !open(Math.floor(to / W) * W + from % W)) return false;
    }
    return true;
  }

  /**
   * BFS from the seeds over open cells, then a second pass out into closed
   * cells. A vehicle on a street the moment it closes still needs a way off it;
   * the second pass gives closed cells a distance without letting a single
   * route from open road run through them.
   */
  private buildField(seeds: Iterable<number>, ems: boolean): Field {
    const { width: W, height: H } = this.map;
    const size = W * H;
    const dist = new Uint16Array(size).fill(UNREACHABLE);
    const dir = new Uint8Array(size);
    const q = this.bfsQueue;
    // Typed ring buffer: head and tail only ever grow, the mask wraps them. The
    // walk is uniform-cost, so cells leave in nondecreasing distance order and
    // none is ever queued twice; one power-of-two slot stays free.
    const slot = q.length - 1;
    const closed = this.closedCells;
    // Every cell this field reaches, in the order it was reached. The queue walk
    // is uniform-cost, so a cell's distance does not depend on the order its
    // neighbours are dequeued in; the list is the same set either way.
    const touched = this.fieldTouched;
    let touchedCount = 0;
    let head = 0;
    let tail = 0;
    for (const c of seeds) {
      if (c < 0 || c >= size || !this.allowed(c, ems) || closed[c] === 1 || dist[c] === 0) continue;
      dist[c] = 0;
      touched[touchedCount++] = c;
      q[tail & slot] = c;
      tail++;
    }
    for (let phase = 0; phase < 2; phase++) {
      if (phase === 1) {
        // Restart from every reached cell, expanding into closed cells only.
        head = 0;
        tail = 0;
        const reached = touchedCount;
        for (let k = 0; k < reached; k++) {
          q[tail & slot] = touched[k]!;
          tail++;
        }
      }
      while (head < tail) {
        const c = q[head & slot]!;
        head++;
        const cx = c % W;
        const cy = (c / W) | 0;
        const next = dist[c]! + 1;
        for (let d = 1; d <= 7; d += 2) {
          const x = cx + DIR_DX[d]!;
          const y = cy + DIR_DY[d]!;
          if (x < 0 || y < 0 || x >= W || y >= H) continue;
          const n = y * W + x;
          if (!this.allowed(n, ems)) continue;
          if ((closed[n] === 1) !== (phase === 1)) continue;
          const before = dist[n]!;
          if (before <= next) continue;
          dist[n] = next;
          // One entry per cell: recorded the first time the walk reaches it.
          if (before === UNREACHABLE) touched[touchedCount++] = n;
          q[tail & slot] = n;
          tail++;
        }
      }
    }
    // Only cells the walk reached have a direction, and each one's is a pure
    // function of `dist`, so visiting the reach list gives the same grid as
    // visiting the map in cell order.
    for (let k = 0; k < touchedCount; k++) {
      const c = touched[k]!;
      if (dist[c] === UNREACHABLE || dist[c] === 0) continue;
      const cx = c % W;
      const cy = (c / W) | 0;
      let best = dist[c]!;
      let bestDir = 0;
      for (let d = 1; d <= 8; d++) {
        const x = cx + DIR_DX[d]!;
        const y = cy + DIR_DY[d]!;
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const n = y * W + x;
        if (dist[n]! >= best || !this.canStep(c, n, ems)) continue;
        best = dist[n]!;
        bestDir = d;
      }
      dir[c] = bestDir;
    }
    return { dist, dir };
  }

  private refreshFields(closed: ReadonlySet<Id>): void {
    const key = [...closed].sort().join(',');
    if (key !== this.closedKey) {
      this.closedKey = key;
      this.closedCells.fill(0);
      for (const c of this.map.closables) {
        if (!closed.has(c.id)) continue;
        for (const cell of c.cells) this.closedCells[cell] = 1;
      }
      // Every field follows from the closed cells, so a new closure set retires
      // them all, and the cached copies built for the old one.
      this.fieldCache.clear();
      this.exitField = null;
      this.lotsField = null;
      this.emsField = null;
    }
    if (!this.exitField) {
      this.exitField = this.cachedField('edge', () => this.buildField(this.net.border, false));
    }
    if (this.lotsDirty || !this.lotsField) {
      this.lotsDirty = false;
      this.lotsField = this.cachedField(`lots:${this.freeLotsKey()}`, () => {
        const seeds: number[] = [];
        for (let c = 0; c < this.net.lotOf.length; c++) {
          const lot = this.net.lotOf[c]!;
          if (lot >= 0 && this.lotFree[lot]! > 0) seeds.push(c);
        }
        return this.buildField(seeds, false);
      });
    }
    if (this.ambulance >= 0 && this.emergencyDispatched && !this.emsField) {
      this.emsField = this.cachedField('ems', () => this.buildField(this.emsTarget(), true));
    }
  }

  /** A field from the cache, built on first use. Only `dist` and `dir` are ever read from one. */
  private cachedField(key: string, build: () => Field): Field {
    const cached = this.fieldCache.get(key);
    if (cached) return cached;
    const field = build();
    if (this.fieldCache.size >= FIELD_CACHE_MAX) {
      // Oldest first: the layouts that recur are the ones still being asked for.
      const oldest = this.fieldCache.keys().next().value;
      if (oldest !== undefined) this.fieldCache.delete(oldest);
    }
    this.fieldCache.set(key, field);
    return field;
  }

  /**
   * Which lots still have a stall free, as a key. The lot field's seeds are
   * every cell of every such lot, in map order, so this says exactly when its
   * seed set changes — and when it does not: a lot with one free stall and a
   * lot with fifty seed the identical field.
   */
  private freeLotsKey(): string {
    let key = '';
    for (let lot = 0; lot < this.net.lotCount; lot++) {
      if (this.lotFree[lot]! > 0) key += `${lot},`;
    }
    return key;
  }

  /** Where the ambulance is going: the drivable edge of the incident zone. */
  private emsTarget(): number[] {
    const { incident } = this.init;
    let cells = incident.cells ?? [];
    if (cells.length === 0 && incident.placeId) {
      cells = this.map.places.find((p) => p.id === incident.placeId)?.cells ?? [];
    }
    // A street closure runs for blocks, often right off the map edge, so the
    // ambulance would "arrive" the moment it spawned. It is going to one spot:
    // the part of the zone nearest the stadium, where the crowd is.
    const W = this.map.width;
    const bowl = this.map.places.find((p) => p.kind === 'seating')?.cells ?? [];
    if (cells.length > 0 && bowl.length > 0) {
      let bx = 0;
      let by = 0;
      for (const c of bowl) {
        bx += c % W;
        by += (c / W) | 0;
      }
      bx /= bowl.length;
      by /= bowl.length;
      let anchor = cells[0]!;
      let best = Infinity;
      for (const c of cells) {
        const d = ((c % W) - bx) ** 2 + (((c / W) | 0) - by) ** 2;
        if (d < best) {
          best = d;
          anchor = c;
        }
      }
      const zone = new Set(expandCells(this.map, cells, 3));
      const spot = expandCells(this.map, [anchor], 12).filter((c) => zone.has(c) && this.allowed(c, true));
      if (spot.length > 0) return spot;
    }
    const edge = expandCells(this.map, cells, 3).filter((c) => this.allowed(c, true));
    if (edge.length > 0) return edge;
    return this.map.places.filter((p) => p.kind === 'gate').flatMap((p) => p.cells);
  }

  // ─── stepping ───

  private cellAt(x: number, y: number): number {
    const cx = Math.floor(x / CELL_SIZE_M);
    const cy = Math.floor(y / CELL_SIZE_M);
    if (cx < 0 || cy < 0 || cx >= this.map.width || cy >= this.map.height) return -1;
    return cy * this.map.width + cx;
  }

  private onMap(i: number): boolean {
    const m = this.mode[i]!;
    return m !== MODE_WAITING && m !== MODE_GONE;
  }

  /** Mark the cells under every moving vehicle's footprint, front bumper to back. */
  private rebuildOccupancy(): void {
    // Clear only what the last step set. A full-grid wipe touched every cell on
    // every one of the 3,600 steps, and traffic holds a few hundred at most.
    const touched = this.occTouched;
    for (let k = 0; k < this.occTouchedCount; k++) this.occCount[touched[k]!] = 0;
    this.occTouchedCount = 0;
    for (let i = 0; i < this.count; i++) {
      const m = this.mode[i]!;
      if (m !== MODE_INBOUND && m !== MODE_OUTBOUND && m !== MODE_EMS && m !== MODE_ON_SCENE) continue;
      this.markFootprint(i);
    }
  }

  /**
   * Add vehicle i to a cell's occupancy, recording the cell once so the next
   * rebuild can clear it without sweeping the grid.
   */
  private claimCell(cell: number, i: number): void {
    if (this.occCount[cell] === 0) this.occTouched[this.occTouchedCount++] = cell;
    this.occOwner[cell] = i + 1;
    this.occCount[cell] = Math.min(255, this.occCount[cell]! + 1);
  }

  private markFootprint(i: number): void {
    const len = this.type(i).lengthM;
    const cos = Math.cos(this.heading[i]!);
    const sin = Math.sin(this.heading[i]!);
    let last = -1;
    for (let s = 0; s <= len + 0.01; s += CELL_SIZE_M * 0.9) {
      const c = this.cellAt(this.hx[i]! - cos * Math.min(s, len), this.hy[i]! - sin * Math.min(s, len));
      if (c < 0 || c === last) continue;
      last = c;
      if (this.occOwner[c] === i + 1 && this.occCount[c]! > 0) continue;
      this.claimCell(c, i);
    }
  }

  private heldByOther(cell: number, i: number): boolean {
    const n = this.occCount[cell]!;
    if (n === 0) return false;
    return n > 1 || this.occOwner[cell] !== i + 1;
  }

  /** A closure can strand an open road pocket with a car straddling its edge.
   * Clear the rear into open space, then wait there for a usable route. This
   * never enters a closure or jumps over traffic, pedestrians or a building.
   */
  private clearClosureTail(i: number, density: Float32Array, ems: boolean, dt: number): boolean {
    const cell=this.cellAt(this.hx[i]!,this.hy[i]!);
    if(cell<0 || this.closedCells[cell]===1)return false;
    const dx=Math.cos(this.heading[i]!),dy=Math.sin(this.heading[i]!),length=this.type(i).lengthM;
    let rearClosed=false;
    for(let s=0;s<=length;s+=0.5) {
      const c=this.cellAt(this.hx[i]!-dx*s,this.hy[i]!-dy*s);
      if(c>=0 && this.closedCells[c]===1){rearClosed=true;break;}
    }
    if(!rearClosed)return false;
    let remaining=CRAWL_SPEED_MPS*dt,moved=0;
    while(remaining>0) {
      const step=Math.min(0.5,remaining),x=Math.fround(this.hx[i]!+dx*step),y=Math.fround(this.hy[i]!+dy*step);
      const from=this.cellAt(this.hx[i]!,this.hy[i]!),next=this.cellAt(x,y);
      if(next<0 || !this.canStep(from,next,ems) || this.heldByOther(next,i) || density[next]!>(ems?CROWD_STOP_EMS:CROWD_STOP))break;
      this.hx[i]=x;this.hy[i]=y;remaining-=step;moved+=step;
      if(this.occCount[next]===0 || this.occOwner[next]!==i+1)this.claimCell(next,i);
    }
    if(moved===0)return false;
    this.speed[i]=moved/dt;this.stuck[i]=0;return true;
  }

  /**
   * Drive vehicle i up to `budget` meters along a field, one cell at a time,
   * steering for the centre of the next cell so traffic settles into lanes.
   */
  private advance(i: number, field: Field, budget: number, density: Float32Array, ems: boolean): 'moved' | 'arrived' | 'blocked' {
    const W = this.map.width;
    const crowdStop = ems ? CROWD_STOP_EMS : CROWD_STOP;
    const squeeze = ems || this.stuck[i]! >= SQUEEZE_AFTER_S;
    let remaining = budget;
    let moved = false;
    for (let guard = 0; guard < 12 && remaining > 0.01; guard++) {
      const cell = this.cellAt(this.hx[i]!, this.hy[i]!);
      if (cell < 0) return 'arrived';
      const here = field.dist[cell]!;
      if (here === 0) return 'arrived';
      const best = field.dir[cell]!;
      if (best === 0) return moved ? 'moved' : 'blocked';
      // Enter on alternating axes; vehicles already inside the junction clear it.
      // Six seconds each way with a one-second clearance interval between phases.
      if (this.controlPoints.length && !ems) {
        const phase = ((this.signalTime % 14) + 14) % 14;
        const horizontal = Math.abs(DIR_DX[best]!) >= Math.abs(DIR_DY[best]!);
        for (const point of this.controlPoints) {
          const distance = Math.max(Math.abs(cell % W - point % W), Math.abs(Math.floor(cell / W) - Math.floor(point / W)));
          if (distance > 2 && distance <= 6 && (phase === 6 || phase === 13 || horizontal !== (phase < 6))) return moved ? 'moved' : 'blocked';
        }
      }
      const cx = cell % W;
      const cy = (cell / W) | 0;
      let next = -1;
      for (const turn of [0, -1, 1] as const) {
        const d = ((best - 1 + turn + 8) % 8) + 1;
        const x = cx + DIR_DX[d]!;
        const y = cy + DIR_DY[d]!;
        if (x < 0 || y < 0 || x >= W || y >= this.map.height) continue;
        const n = y * W + x;
        if (!this.canStep(cell, n, ems)) continue;
        const there = field.dist[n]!;
        if (there === UNREACHABLE || there > here || (turn !== 0 && there === here)) continue;
        if (density[n]! > crowdStop) continue;
        // Emergency vehicles pass traffic, but not each other once one is on
        // scene: the cruiser used to park on top of the ambulance.
        if (this.heldByOther(n, i) && (!squeeze || this.mode[this.occOwner[n]! - 1] === MODE_ON_SCENE)) continue;
        next = n;
        break;
      }
      if (next < 0) return moved ? 'moved' : 'blocked';

      // Claim the cell now, so a vehicle stepping after us this second sees it.
      if (this.occCount[next] === 0 || this.occOwner[next] !== i + 1) this.claimCell(next, i);
      const tx = ((next % W) + 0.5) * CELL_SIZE_M;
      const ty = (((next / W) | 0) + 0.5) * CELL_SIZE_M;
      const dx = tx - this.hx[i]!;
      const dy = ty - this.hy[i]!;
      const dist = Math.hypot(dx, dy);
      if (dist < 1e-3) continue;
      const step = Math.min(remaining, dist);
      this.hx[i] = this.hx[i]! + (dx / dist) * step;
      this.hy[i] = this.hy[i]! + (dy / dist) * step;
      this.turnToward(i, Math.atan2(dy, dx), 0.55);
      remaining -= step;
      moved = true;
      if (step < dist) break;
    }
    return 'moved';
  }

  private turnToward(i: number, angle: number, rate: number): void {
    let diff = angle - this.heading[i]!;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    this.heading[i] = this.heading[i]! + diff * rate;
  }

  /** The speed a vehicle wants right now, before anything is in its way. */
  private wantedSpeed(i: number, density: Float32Array, weather: WeatherState, ems: boolean): number {
    const cell = this.cellAt(this.hx[i]!, this.hy[i]!);
    let v = this.type(i).maxSpeedMps * driveFactor(weather);
    if (cell >= 0) {
      const mask = this.net.mask[cell]!;
      if (mask === MASK_PARKING || mask === MASK_DRIVEWAY) v = Math.min(v, LOT_SPEED_MPS);
      if (mask === MASK_EMS_ONLY) v = Math.min(v, 3);
      if (density[cell]! > CROWD_SLOW) v = Math.min(v, ems ? 3 : CRAWL_SPEED_MPS);
    }
    return v;
  }

  /** Claim the nearest free stall in this lot (a run of them for a bus or RV). */
  private claimStall(i: number, lot: number): boolean {
    const stalls = this.net.stallsByLot[lot];
    if (!stalls || this.lotFree[lot]! <= 0) return false;
    const long = isLongVehicle(VEHICLE_KINDS[this.kind[i]!]!);
    let best = -1;
    let bestRun = 0;
    let bestSq = Infinity;
    let fallback = -1;
    let fallbackSq = Infinity;
    for (let k = 0; k < stalls.length; k++) {
      const s = stalls[k]!;
      if (this.stallTaken[s]) continue;
      const dx = this.net.stallX[s]! - this.hx[i]!;
      const dy = this.net.stallY[s]! - this.hy[i]!;
      const sq = dx * dx + dy * dy;
      if (sq < fallbackSq) {
        fallbackSq = sq;
        fallback = s;
      }
      if (sq >= bestSq) continue;
      const run = this.runFrom(s, i);
      if (run === 0) continue;
      best = s;
      bestRun = run;
      bestSq = sq;
    }
    if (best < 0 && long && fallback >= 0) {
      // No run of empty stalls long enough: take one and hang over the line.
      best = fallback;
      bestRun = 1;
    }
    if (best < 0) return false;
    this.occupyStalls(i, best, bestRun);
    return true;
  }

  /**
   * Fans who chose to go back to their cars free up cars to drive away.
   *
   * The walk over the dots stays whole. `DensityField.occupied` cannot stand in
   * for it: `DensityField.update` skips `gone` dots, so the very fans this loop
   * is looking for are absent from the occupancy list, and driving demand off
   * it would drop every event and change every result.
   */
  private noticeFansAtCars(dots: DotStore, t: SimSeconds): void {
    for (let d = 0; d < dots.count; d++) {
      if (this.dotCounted[d] || dots.state[d] !== GONE_DOT) continue;
      this.dotCounted[d] = 1;
      const c = this.cellAt(dots.x[d]!, dots.y[d]!);
      if (c < 0) continue;
      const lot = this.net.lotOf[c]!;
      if (lot < 0) continue;
      this.lotDemand[lot]! += DOT_GROUP_SIZE;
    }
    for (let lot = 0; lot < this.net.lotCount; lot++) {
      if (this.lotDemand[lot]! <= 0) continue;
      for (let i = 0; i < this.count && this.lotDemand[lot]! > 0; i++) {
        if (this.mode[i] !== MODE_PARKED || this.departT[i]! <= t + 600) continue;
        const s = this.stall[i]!;
        if (s < 0 || this.net.stallLot[s] !== lot) continue;
        this.lotDemand[lot]! -= this.type(i).passengers;
        this.departT[i] = t + 60 + this.rng.next() * 120;
      }
      // Nobody parked here to take them: their ride was not one we sampled.
      if (this.lotDemand[lot]! > 0) this.lotDemand[lot] = 0;
    }
  }

  step(input: TrafficStepInput): void {
    const { t, dt, weather, density, dots, closed } = input;
    this.controlPoints = input.controlPoints ?? [];
    this.signalTime = t;
    const rho = density.peoplePerM2;
    const { incident } = this.init;

    if (this.ambulance >= 0 && !this.emergencyDispatched && t >= incident.at) this.emergencyDispatched = true;
    this.refreshFields(closed);
    this.noticeFansAtCars(dots, t);
    this.rebuildOccupancy();

    const lots = this.lotsField!;
    const exits = this.exitField!;
    const anyLotOpen = this.lotFree.some((f) => f > 0);

    for (let i = 0; i < this.count; i++) {
      const m = this.mode[i]!;
      this.blocked[i] = 0;

      if (m === MODE_GONE || m === MODE_ON_SCENE) continue;

      if (m === MODE_WAITING) {
        if (i === this.ambulance || i === this.police) {
          if (!this.emergencyDispatched) continue;
          if (i === this.police && t < incident.at + 30) continue;
          this.dispatchEmergency(i);
          continue;
        }
        if (t < this.arriveT[i]!) continue;
        let cell = this.entry[i]!;
        // A car still off-map may use another approach when its road component
        // is full or closed. Choosing the nearest reachable entry keeps the
        // choice deterministic; no RNG draw moves an existing car.
        if (anyLotOpen && (cell < 0 || this.closedCells[cell] === 1 || lots.dist[cell] === UNREACHABLE)) {
          const alternatives = this.net.entries.filter((entry) =>
            this.closedCells[entry.cell] !== 1 && this.occCount[entry.cell] === 0 &&
            rho[entry.cell]! <= CROWD_STOP && lots.dist[entry.cell] !== UNREACHABLE);
          if (alternatives.length > 0) {
            cell = alternatives[i % alternatives.length]!.cell;
            this.entry[i] = cell;
          }
        }
        if (cell < 0 || this.closedCells[cell] === 1 || this.occCount[cell]! > 0 || rho[cell]! > CROWD_STOP) continue;
        const field = anyLotOpen ? lots : exits;
        const dir = field.dir[cell]!;
        this.hx[i] = ((cell % this.map.width) + 0.5) * CELL_SIZE_M;
        this.hy[i] = (((cell / this.map.width) | 0) + 0.5) * CELL_SIZE_M;
        this.heading[i] = Math.atan2(DIR_DY[dir]!, DIR_DX[dir]!);
        this.speed[i] = this.type(i).maxSpeedMps * 0.6;
        this.mode[i] = anyLotOpen ? MODE_INBOUND : MODE_OUTBOUND;
        this.claimCell(cell, i);
        continue;
      }

      if (m === MODE_PARKED) {
        if (t < this.departT[i]!) continue;
        this.releaseStalls(i);
        this.mode[i] = MODE_OUTBOUND;
        this.speed[i] = 0;
        continue;
      }

      if (m === MODE_PARKING) {
        // Creep down the aisle to the stall, turning in over the last few meters.
        const dx = this.targetX[i]! - this.hx[i]!;
        const dy = this.targetY[i]! - this.hy[i]!;
        const dist = Math.hypot(dx, dy);
        const step = PARK_SPEED_MPS * dt;
        const travel = Math.min(step, dist);
        let cell = this.cellAt(this.hx[i]!, this.hy[i]!);
        let clear = cell >= 0;
        // Parking bypasses the field; sample its segment so even a large dt
        // cannot jump a barricade. Only closures turn a car away here: the
        // straight line into a stall can clip a lot corner outside the drive
        // mask, and that must not send a car that found its stall back out.
        const samples = Math.max(1, Math.ceil(travel / (CELL_SIZE_M / 2)));
        for (let sample = 1; clear && sample <= samples; sample++) {
          const fraction = dist === 0 ? 0 : (travel / dist) * (sample / samples);
          const next = this.cellAt(Math.fround(this.hx[i]! + dx * fraction), Math.fround(this.hy[i]! + dy * fraction));
          clear = next >= 0 && (this.closedCells[next] !== 1 || this.closedCells[cell] === 1);
          cell = next;
        }
        if (!clear) {
          this.releaseStalls(i);
          this.mode[i] = MODE_OUTBOUND;
          this.speed[i] = 0;
          continue;
        }
        if (dist <= step) {
          this.placeAtStall(i);
          this.mode[i] = MODE_PARKED;
          if (VEHICLE_KINDS[this.kind[i]!] === 'rideshare') this.departT[i] = t + RIDESHARE_DWELL_S;
          continue;
        }
        this.hx[i] = this.hx[i]! + (dx / dist) * step;
        this.hy[i] = this.hy[i]! + (dy / dist) * step;
        this.speed[i] = PARK_SPEED_MPS;
        this.turnToward(i, dist < 7 ? this.targetHeading[i]! : Math.atan2(dy, dx), 0.45);
        continue;
      }

      // Driving: inbound to a lot, outbound to the edge, or an emergency run.
      const ems = m === MODE_EMS;
      let field = ems ? this.emsField : m === MODE_INBOUND ? lots : exits;
      if (m === MODE_INBOUND && !anyLotOpen) {
        // Every lot is full: give up and drive back out, as people do.
        this.mode[i] = MODE_OUTBOUND;
        field = exits;
      }
      if (!field) continue;
      const at = this.cellAt(this.hx[i]!, this.hy[i]!);
      if (at >= 0 && field.dist[at] === UNREACHABLE) {
        if (this.clearClosureTail(i,rho,ems,dt)) continue;
        // Cut off from where it was going (a closure, or every lot it could
        // reach filled up). Head for the edge instead; if even that is cut
        // off, it waits where it is, and is counted stopped.
        if (this.mode[i] === MODE_INBOUND && exits.dist[at] !== UNREACHABLE) {
          this.mode[i] = MODE_OUTBOUND;
          field = exits;
        } else {
          this.speed[i] = 0;
          this.blocked[i] = 1;
          this.waited[i] = this.waited[i]! + dt;
          continue;
        }
      }

      const want = this.wantedSpeed(i, rho, weather, ems);
      const v = Math.min(want, this.speed[i]! + ACCEL_MPS2 * dt);
      const result = this.advance(i, field, Math.max(v, 0.6) * dt, rho, ems);

      if (result === 'arrived') {
        this.speed[i] = 0;
        if (this.mode[i] === MODE_INBOUND) {
          const cell = this.cellAt(this.hx[i]!, this.hy[i]!);
          const lot = cell >= 0 ? this.net.lotOf[cell]! : -1;
          if (lot >= 0 && this.claimStall(i, lot)) this.mode[i] = MODE_PARKING;
          else this.blocked[i] = 1;
        } else if (this.mode[i] === MODE_OUTBOUND) {
          this.mode[i] = MODE_GONE;
          this.hx[i] = -1;
          this.hy[i] = -1;
          this.out++;
        } else if (ems) {
          this.mode[i] = MODE_ON_SCENE;
          if (i === this.ambulance) this.emergencyOnScene = true;
        }
        continue;
      }

      if (result === 'blocked' && ems) {
        // Pulled up behind a unit already there: close enough, it is on scene too.
        const here = this.cellAt(this.hx[i]!, this.hy[i]!);
        if (here >= 0 && field.dist[here]! <= 8) {
          this.speed[i] = 0;
          this.mode[i] = MODE_ON_SCENE;
          if (i === this.ambulance) this.emergencyOnScene = true;
          continue;
        }
      }

      if (result === 'blocked') {
        this.speed[i] = 0;
        this.blocked[i] = 1;
        this.waited[i] = this.waited[i]! + dt;
        this.stuck[i] = this.stuck[i]! + dt;
      } else {
        this.speed[i] = v;
        this.stuck[i] = 0;
        if (v < 0.5) {
          this.blocked[i] = 1;
          this.waited[i] = this.waited[i]! + dt;
        }
      }
    }
  }

  private dispatchEmergency(i: number): void {
    const field = this.emsField;
    if (!field) return;
    let best = -1;
    let bestDist = UNREACHABLE;
    for (const e of this.net.entries) {
      if (this.closedCells[e.cell] === 1) continue;
      const d = field.dist[e.cell]!;
      if (d < bestDist) {
        bestDist = d;
        best = e.cell;
      }
    }
    if (best < 0) return;
    const dir = field.dir[best]!;
    this.hx[i] = ((best % this.map.width) + 0.5) * CELL_SIZE_M;
    this.hy[i] = (((best / this.map.width) | 0) + 0.5) * CELL_SIZE_M;
    this.heading[i] = Math.atan2(DIR_DY[dir]!, DIR_DX[dir]!);
    this.speed[i] = this.type(i).maxSpeedMps;
    this.mode[i] = MODE_EMS;
  }

  metrics(): TrafficMetrics {
    let stopped = 0;
    for (let i = 0; i < this.count; i++) if (this.blocked[i] && this.onMap(i)) stopped++;
    return {
      stopped,
      out: this.out,
      emergencyDispatched: this.emergencyDispatched,
      emergencyOnScene: this.emergencyOnScene,
    };
  }

  /** What crosses to the app: vehicle centres, not the front bumpers the model steers by. */
  frame(): VehicleFrame {
    const n = this.count;
    const x = new Float32Array(n);
    const y = new Float32Array(n);
    const state = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const m = this.mode[i]!;
      if (m === MODE_WAITING || m === MODE_GONE) {
        x[i] = -1;
        y[i] = -1;
        state[i] = m === MODE_GONE ? VSTATE.gone : VSTATE.waiting;
        continue;
      }
      const half = this.type(i).lengthM / 2;
      x[i] = this.hx[i]! - Math.cos(this.heading[i]!) * half;
      y[i] = this.hy[i]! - Math.sin(this.heading[i]!) * half;
      state[i] = this.displayState(i);
    }
    return {
      x,
      y,
      heading: this.heading.slice(),
      speed: this.speed.slice(),
      kind: this.kind.slice(),
      state,
      waitedS: this.waited.slice(),
    };
  }

  private displayState(i: number): number {
    switch (this.mode[i]) {
      case MODE_PARKING:
        return VSTATE.parking;
      case MODE_PARKED:
        return VSTATE.parked;
      case MODE_ON_SCENE:
        return VSTATE.on_scene;
      case MODE_EMS:
        return this.blocked[i] ? VSTATE.stopped : VSTATE.responding;
      case MODE_OUTBOUND: {
        if (this.blocked[i]) return VSTATE.stopped;
        const c = this.cellAt(this.hx[i]!, this.hy[i]!);
        const mask = c >= 0 ? this.net.mask[c] : 0;
        return mask === MASK_PARKING || mask === MASK_DRIVEWAY ? VSTATE.departing : VSTATE.driving;
      }
      default:
        return this.blocked[i] ? VSTATE.stopped : VSTATE.driving;
    }
  }

  capture(): unknown {
    return {
      hx: this.hx.slice(),
      hy: this.hy.slice(),
      heading: this.heading.slice(),
      speed: this.speed.slice(),
      mode: this.mode.slice(),
      blocked: this.blocked.slice(),
      waited: this.waited.slice(),
      stuck: this.stuck.slice(),
      arriveT: this.arriveT.slice(),
      entry: this.entry.slice(),
      departT: this.departT.slice(),
      stall: this.stall.slice(),
      stallRun: this.stallRun.slice(),
      targetX: this.targetX.slice(),
      targetY: this.targetY.slice(),
      targetHeading: this.targetHeading.slice(),
      stallTaken: this.stallTaken.slice(),
      lotFree: this.lotFree.slice(),
      lotDemand: this.lotDemand.slice(),
      dotCounted: this.dotCounted.slice(),
      rng: this.rng.state(),
      out: this.out,
      emergencyDispatched: this.emergencyDispatched,
      emergencyOnScene: this.emergencyOnScene,
    };
  }

  restore(state: unknown): void {
    if (!state || typeof state !== 'object') return;
    const s = state as Record<string, unknown>;
    const arrays: [{ set(a: ArrayLike<number>): void }, string][] = [
      [this.hx, 'hx'], [this.hy, 'hy'], [this.heading, 'heading'], [this.speed, 'speed'], [this.mode, 'mode'],
      [this.blocked, 'blocked'], [this.waited, 'waited'], [this.stuck, 'stuck'], [this.arriveT, 'arriveT'],
      [this.entry, 'entry'],
      [this.departT, 'departT'], [this.stall, 'stall'], [this.stallRun, 'stallRun'], [this.targetX, 'targetX'],
      [this.targetY, 'targetY'], [this.targetHeading, 'targetHeading'], [this.stallTaken, 'stallTaken'],
      [this.lotFree, 'lotFree'], [this.lotDemand, 'lotDemand'], [this.dotCounted, 'dotCounted'],
    ];
    for (const [into, key] of arrays) if (s[key]) into.set(s[key] as ArrayLike<number>);
    this.rng.restore((s.rng as number[]) ?? []);
    this.out = Number(s.out ?? 0);
    this.emergencyDispatched = Boolean(s.emergencyDispatched);
    this.emergencyOnScene = Boolean(s.emergencyOnScene);
    // Fields follow from the state just restored; rebuild them on the next step.
    this.closedKey = '\u0000';
    this.fieldCache.clear();
    this.lotsDirty = true;
    this.emsField = null;
    // Occupancy is not carried in the snapshot; start it clean so the sparse
    // clear cannot leave a count behind from the state we replaced.
    this.occCount.fill(0);
    this.occTouchedCount = 0;
  }
}
