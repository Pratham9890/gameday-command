import type { CellKind, MapBundle, VehicleFrame } from '../../contracts.ts';
import { CELL_SIZE_M, DOT_GROUP_SIZE, DOT_STATES, VEHICLE_KINDS, VEHICLE_STATES } from '../../contracts.ts';
import { VEHICLE_TYPES } from '../../world/src/vehicles.ts';
import { makePlaceIndex } from './heat.ts';
import type { PlaceIndex } from './heat.ts';

/**
 * Congestion, for the two kinds of traffic on game day: cars on the streets and
 * people on foot. Pure functions over a frame, so both maps draw the same thing
 * and it can be tested under Node.
 */

/** Traffic flow per road cell: 0 no vehicle, 1 moving freely, 2 slow, 3 jammed. */
export const FLOW_NONE = 0;
export const FLOW_FREE = 1;
export const FLOW_SLOW = 2;
export const FLOW_JAM = 3;

/** m/s. 6 m/s is about 13 mph: below it a car is crawling, under 1.5 it is effectively stopped. */
export const FREE_MPS = 6;
export const JAM_MPS = 1.5;

export const FLOW_RGB: Record<number, [number, number, number]> = {
  [FLOW_FREE]: [0x2e, 0xd5, 0x73],
  [FLOW_SLOW]: [0xff, 0xb0, 0x20],
  [FLOW_JAM]: [0xff, 0x30, 0x40],
};

const VS = Object.fromEntries(VEHICLE_STATES.map((s, i) => [s, i])) as Record<(typeof VEHICLE_STATES)[number], number>;

export function flowLevel(state: number, speed: number): number {
  if (state === VS.stopped || speed < JAM_MPS) return FLOW_JAM;
  if (speed < FREE_MPS) return FLOW_SLOW;
  return FLOW_FREE;
}

const isDriving = (state: number) =>
  state === VS.driving || state === VS.stopped || state === VS.departing || state === VS.responding || state === VS.parking;

/**
 * Paint each moving vehicle's footprint onto the cells, worst level wins, and
 * widen it by a cell either side so a line of traffic reads as a coloured road
 * rather than a dotted one.
 */
export function trafficFlow(map: MapBundle, v: VehicleFrame | undefined, into?: Uint8Array): Uint8Array {
  const { width: W, height: H } = map;
  const out = into && into.length === W * H ? into : new Uint8Array(W * H);
  out.fill(0);
  if (!v) return out;
  for (let i = 0; i < v.x.length; i++) {
    const st = v.state[i]!;
    if (!isDriving(st) || v.x[i]! < 0) continue;
    const level = flowLevel(st, v.speed[i]!);
    const L = VEHICLE_TYPES[VEHICLE_KINDS[v.kind[i]!]!].lengthM;
    const fx = Math.cos(v.heading[i]!);
    const fy = Math.sin(v.heading[i]!);
    // Along the vehicle, plus a car length of gap behind it: a queue is the
    // cars and the road between them.
    for (let s = -L / 2 - 3; s <= L / 2; s += CELL_SIZE_M * 0.8) {
      for (const side of [-CELL_SIZE_M, 0, CELL_SIZE_M]) {
        const x = v.x[i]! + fx * s - fy * side;
        const y = v.y[i]! + fy * s + fx * side;
        const cx = Math.floor(x / CELL_SIZE_M);
        const cy = Math.floor(y / CELL_SIZE_M);
        if (cx < 0 || cy < 0 || cx >= W || cy >= H) continue;
        const c = cy * W + cx;
        if (out[c]! < level) out[c] = level;
      }
    }
  }
  return out;
}

export type HotspotKind = 'crowd' | 'traffic' | 'both';
export type HotspotLevel = 'critical' | 'high' | 'watch';

export interface PoliceHotspot {
  rank: number;
  kind: HotspotKind;
  level: HotspotLevel;
  where: string;
  /** People standing at 3 or more per m² in the area. */
  crowdedPeople: number;
  peakDensity: number;
  stoppedVehicles: number;
  slowVehicles: number;
  score: number;
  /** Cell bounds, inclusive, and the centre in meters. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  cx: number;
  cy: number;
}

/** Blocks of 6 x 6 cells (12 m), the unit areas are built from. */
const BLOCK = 6;
const CROWDED = 3;
const CROWD_MIN = 30;
const STOPPED_MIN = 2;

/**
 * Cells a pedestrian can be on. The engine's flow field treats every cell that
 * is not `blocked` as walkable (`engine/src/flowfield.ts`, `passable()`), so a
 * dot may stand on `road`, `parking`, `concourse`, `stands` and `shelter` cells.
 * Density on a `blocked` cell is not people — nothing can stand inside a wall —
 * so it is an artefact and is not counted.
 */
const pedestrianCell = (kind: CellKind) => kind !== 'blocked';

/**
 * Cells a vehicle can be on: the road network and the parking lots.
 *
 * The engine's road network (`engine/src/traffic.ts`) also accepts walk cells
 * within 3 cells of a lot as a *driveway*, because OSM rarely maps the stub into
 * a lot, and it lets an emergency vehicle drive the plazas and the concourse
 * ring. Both are left out here on purpose: a car creeping down a driveway is
 * not a traffic queue, and an on-scene ambulance is not congestion. Counting
 * either would put a vehicle on a cell that general traffic never uses, which is
 * exactly the "cars in the concourse" reading this guards against.
 */
const vehicleCell = (kind: CellKind) => kind === 'road' || kind === 'parking';

/**
 * OSM highway classes that make a street a freeway. The tags ride along in
 * `MapBundle.streets` (`contracts.ts:122`), so no engine code is consulted.
 */
const FREEWAY_CLASSES = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link']);

/** Names of the freeway-class streets on this map. */
function freewayStreetNames(map: MapBundle): Set<string> {
  const names = new Set<string>();
  for (const s of map.streets ?? []) if (s.name && FREEWAY_CLASSES.has(s.kind)) names.add(s.name);
  return names;
}

/**
 * A `PlaceIndex` that knows every walkable feature but no freeway, for naming a
 * pedestrian area. `makePlaceIndex` is frozen for this order, and it names any
 * cell within three cells of a closable street; handing it a copy of the map
 * with the freeway streets taken out of `closables` keeps every gate, lot and
 * surface street and drops only the freeway names. Built once per map.
 */
const walkIndexes = new WeakMap<MapBundle, PlaceIndex>();
function walkablePlaceIndex(map: MapBundle, freewayNames: Set<string>): PlaceIndex {
  let index = walkIndexes.get(map);
  if (!index) {
    index = makePlaceIndex({ ...map, closables: map.closables.filter((c) => !freewayNames.has(c.name)) });
    walkIndexes.set(map, index);
  }
  return index;
}

const isFreewayLabel = (where: string, freewayNames: Set<string>) =>
  where.startsWith('On ') && freewayNames.has(where.slice(3));

/**
 * The worst places right now, for the commander to look at first.
 *
 * Seated fans are left out: a full section of stands is 5 people per m² and
 * perfectly safe, and counting it put the whole bowl at the top of the list.
 * What is counted is people on their feet packed at 3 per m² or more, and
 * vehicles stopped or crawling. Neighbouring hot blocks merge into one area,
 * so a queue down a street is one entry, not twenty.
 *
 * Each agent is only counted on a cell it can actually be on (the predicates
 * above), and the name comes from the dominant agent's own cells: the block
 * where most of that agent sits, not the merged area's centre of mass, which
 * can land on a street nothing in the area is touching. A crowd is never named
 * after a freeway — if its people really are standing on a freeway cell, the
 * area is named for the nearest walkable feature instead — while cars on a
 * freeway are named for it, because that is where they are.
 *
 * This ranks; it does not prescribe. Where to send officers stays the
 * commander's call.
 */
export function policeHotspots(
  map: MapBundle,
  density: Float32Array | undefined,
  vehicles: VehicleFrame | undefined,
  places: PlaceIndex,
  danger: number,
  limit = 6,
): PoliceHotspot[] {
  const { width: W, height: H } = map;
  const BW = Math.ceil(W / BLOCK);
  const BH = Math.ceil(H / BLOCK);
  const crowd = new Float32Array(BW * BH);
  const peak = new Float32Array(BW * BH);
  const stopped = new Uint16Array(BW * BH);
  const slow = new Uint16Array(BW * BH);
  const area = CELL_SIZE_M * CELL_SIZE_M;

  if (density) {
    for (let c = 0; c < density.length; c++) {
      const v = density[c]!;
      const kind = map.cells[c]!;
      // A stand is walkable but is left out even so: a full seated section is
      // 5/m² by design, and `standingDensity()` has already removed the seated
      // fans, so what is left there is a seated crowd, not a crush.
      if (v < CROWDED || !pedestrianCell(kind) || kind === 'stands') continue;
      const b = (((c / W) | 0) / BLOCK | 0) * BW + (((c % W) / BLOCK) | 0);
      crowd[b] = crowd[b]! + v * area;
      if (v > peak[b]!) peak[b] = v;
    }
  }
  if (vehicles) {
    for (let i = 0; i < vehicles.x.length; i++) {
      const st = vehicles.state[i]!;
      if (!isDriving(st) || vehicles.x[i]! < 0) continue;
      const level = flowLevel(st, vehicles.speed[i]!);
      if (level === FLOW_FREE) continue;
      const cx = Math.floor(vehicles.x[i]! / CELL_SIZE_M);
      const cy = Math.floor(vehicles.y[i]! / CELL_SIZE_M);
      if (cx < 0 || cy < 0 || cx >= W || cy >= H) continue;
      const cell = cy * W + cx;
      // The centre cell decides, as it does for the map's own vehicle layers.
      if (!vehicleCell(map.cells[cell]!)) continue;
      const b = ((cy / BLOCK) | 0) * BW + ((cx / BLOCK) | 0);
      if (level === FLOW_JAM) stopped[b]!++;
      else slow[b]!++;
    }
  }

  // A block joins an area with one stopped car in it: a queue strung down a
  // street is one car per block. The area as a whole still has to clear the bar.
  const hot = (b: number) => crowd[b]! >= CROWD_MIN || stopped[b]! >= 1 || slow[b]! >= 2;
  const seen = new Uint8Array(BW * BH);
  type Area = Omit<PoliceHotspot, 'rank' | 'where'> & {
    /** The block where most of the crowd sits, and the one where most of the jam does. */
    crowdBlock: number;
    vehBlock: number;
  };
  const found: Area[] = [];
  const stack: number[] = [];
  for (let start = 0; start < BW * BH; start++) {
    if (seen[start] || !hot(start)) continue;
    let people = 0, pk = 0, st = 0, sl = 0, bx0 = BW, by0 = BH, bx1 = 0, by1 = 0, sx = 0, sy = 0, wsum = 0;
    let crowdBlock = -1, crowdBlockPeople = 0, vehBlock = -1, vehBlockWeight = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const b = stack.pop()!;
      const bx = b % BW;
      const by = (b / BW) | 0;
      people += crowd[b]!;
      if (peak[b]! > pk) pk = peak[b]!;
      st += stopped[b]!;
      sl += slow[b]!;
      if (crowd[b]! > crowdBlockPeople) {
        crowdBlockPeople = crowd[b]!;
        crowdBlock = b;
      }
      const vehWeight = stopped[b]! * 20 + slow[b]! * 5;
      if (vehWeight > vehBlockWeight) {
        vehBlockWeight = vehWeight;
        vehBlock = b;
      }
      const w = crowd[b]! + stopped[b]! * 20 + slow[b]! * 5 + 1;
      sx += (bx + 0.5) * w;
      sy += (by + 0.5) * w;
      wsum += w;
      if (bx < bx0) bx0 = bx;
      if (by < by0) by0 = by;
      if (bx > bx1) bx1 = bx;
      if (by > by1) by1 = by;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = bx + dx;
          const ny = by + dy;
          if (nx < 0 || ny < 0 || nx >= BW || ny >= BH) continue;
          const n = ny * BW + nx;
          if (seen[n] || !hot(n)) continue;
          seen[n] = 1;
          stack.push(n);
        }
      }
    }
    const crowdy = people >= CROWD_MIN;
    const jammed = st >= STOPPED_MIN || st + sl >= 3;
    if (!crowdy && !jammed) continue;
    const score = people / 40 + st * 1.5 + sl * 0.4 + (pk >= danger ? 10 : 0);
    // Every gate queue reaches the physical cap at some point, so danger-level
    // density alone would mark them all critical. Critical is a big packed
    // crowd at that density, or a long jam.
    const level: HotspotLevel =
      (pk >= danger && people >= 3000) || st >= 25 ? 'critical' : pk >= danger || score >= 12 ? 'high' : 'watch';
    found.push({
      kind: crowdy && jammed ? 'both' : crowdy ? 'crowd' : 'traffic',
      level,
      crowdedPeople: people,
      peakDensity: pk,
      stoppedVehicles: st,
      slowVehicles: sl,
      score,
      x0: bx0 * BLOCK,
      y0: by0 * BLOCK,
      x1: Math.min(W - 1, (bx1 + 1) * BLOCK - 1),
      y1: Math.min(H - 1, (by1 + 1) * BLOCK - 1),
      cx: (sx / wsum) * BLOCK * CELL_SIZE_M,
      cy: (sy / wsum) * BLOCK * CELL_SIZE_M,
      crowdBlock,
      vehBlock,
    });
  }
  found.sort((a, b) => b.score - a.score);

  const freewayNames = freewayStreetNames(map);
  /** Built on demand: a map with no freeway street never needs the second index. */
  let walkPlaces: PlaceIndex | undefined;

  /**
   * The cell that best stands for a block: the densest crowd cell in it, or the
   * drivable cell nearest its middle. Searching the block, rather than using
   * the area's centroid, is what stops a 12 m block that merely touches a road
   * from naming a crowd that is somewhere else.
   */
  const cellInBlock = (b: number, agent: 'crowd' | 'traffic'): number => {
    const x0 = (b % BW) * BLOCK;
    const y0 = ((b / BW) | 0) * BLOCK;
    const midX = x0 + BLOCK / 2;
    const midY = y0 + BLOCK / 2;
    let best = -1;
    let bestValue = -1;
    let bestDistance = Infinity;
    for (let dy = 0; dy < BLOCK; dy++) {
      for (let dx = 0; dx < BLOCK; dx++) {
        const x = x0 + dx;
        const y = y0 + dy;
        if (x >= W || y >= H) continue;
        const c = y * W + x;
        const kind = map.cells[c]!;
        if (agent === 'crowd') {
          if (!pedestrianCell(kind) || kind === 'stands') continue;
          const v = density ? density[c]! : 0;
          if (v > bestValue) {
            bestValue = v;
            best = c;
          }
        } else {
          if (!vehicleCell(kind)) continue;
          const d = (x + 0.5 - midX) ** 2 + (y + 0.5 - midY) ** 2;
          if (d < bestDistance) {
            bestDistance = d;
            best = c;
          }
        }
      }
    }
    if (best >= 0) return best;
    // Nothing eligible in the block itself, which should not happen: fall back to
    // its middle cell so the name is still in the area.
    const fx = Math.min(W - 1, Math.max(0, Math.floor(midX)));
    const fy = Math.min(H - 1, Math.max(0, Math.floor(midY)));
    return fy * W + fx;
  };

  // Naming is the slow part, so only the ones shown get a name.
  return found.slice(0, limit).map((h, i) => {
    // Name the area by whichever agent dominates it. A jam is weighted the way
    // the area's weight is above, so "mostly cars" means what the ranking means.
    const byCrowd = h.kind === 'crowd' || (h.kind === 'both' && h.crowdedPeople >= h.stoppedVehicles * 20 + h.slowVehicles * 5);
    const block = byCrowd ? h.crowdBlock : h.vehBlock;
    const cell =
      block >= 0
        ? cellInBlock(block, byCrowd ? 'crowd' : 'traffic')
        : Math.min(H - 1, Math.floor(h.cy / CELL_SIZE_M)) * W + Math.min(W - 1, Math.floor(h.cx / CELL_SIZE_M));
    let where = places.describe(cell);
    // Pedestrians are never located "on a freeway": the nearest walkable
    // feature names the area instead. (Traffic on a freeway is named for it.)
    if (byCrowd && isFreewayLabel(where, freewayNames)) {
      where = (walkPlaces ??= walkablePlaceIndex(map, freewayNames)).describe(cell);
    }
    return {
      rank: i + 1,
      kind: h.kind,
      level: h.level,
      where,
      crowdedPeople: h.crowdedPeople,
      peakDensity: h.peakDensity,
      stoppedVehicles: h.stoppedVehicles,
      slowVehicles: h.slowVehicles,
      score: h.score,
      x0: h.x0,
      y0: h.y0,
      x1: h.x1,
      y1: h.y1,
      cx: h.cx,
      cy: h.cy,
    };
  });
}

export const HOTSPOT_COLOUR: Record<HotspotLevel, string> = {
  critical: '#ff3b5c',
  high: '#ff9b2b',
  watch: '#f5d547',
};

const SEATED = DOT_STATES.indexOf('seated');

/**
 * People per m² who are on their feet. A full section of seats is 5 per m² and
 * entirely safe, so every map colour, count and hotspot is built from this
 * rather than the raw density, the way the scorecard's danger minutes are.
 * `seatedOut`, when given, receives the seated density per cell.
 */
export function standingDensity(
  map: MapBundle,
  frame: { x: Float32Array; y: Float32Array; state: Uint8Array },
  density: Float32Array,
  into?: Float32Array,
  seatedOut?: Float32Array,
): Float32Array {
  const out = into && into.length === density.length ? into : new Float32Array(density.length);
  out.set(density);
  seatedOut?.fill(0);
  const per = DOT_GROUP_SIZE / (CELL_SIZE_M * CELL_SIZE_M);
  const { width: W, height: H } = map;
  for (let i = 0; i < frame.x.length; i++) {
    if (frame.state[i] !== SEATED || frame.x[i]! < 0) continue;
    const cx = Math.floor(frame.x[i]! / CELL_SIZE_M);
    const cy = Math.floor(frame.y[i]! / CELL_SIZE_M);
    if (cx < 0 || cy < 0 || cx >= W || cy >= H) continue;
    const c = cy * W + cx;
    out[c] = Math.max(0, out[c]! - per);
    if (seatedOut) seatedOut[c] = seatedOut[c]! + per;
  }
  return out;
}
