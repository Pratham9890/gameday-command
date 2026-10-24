import { Graphics } from 'pixi.js';
import type { MapBundle } from '../../contracts.ts';
import { CELL_SIZE_M } from '../../contracts.ts';
import { isoProject } from './people.ts';
import { diagonalZ } from './depth.ts';

/**
 * The Horseshoe and the streets, for the 3D close-up.
 *
 * OSM gives the stadium as one flat polygon. Here it becomes a bowl: seats rise
 * in tiers from the field to an outer wall, the field sits at the bottom with
 * its yard lines and end zones, and the crowd is drawn on the tiers at the
 * height it is sitting. Heights are an impression of the real stadium, not a
 * survey: about 16 m to the rim, stepping up in 1.5 m tiers.
 */

const RIM_H = 16;
const TIER_STEP = 1.5;
const C = CELL_SIZE_M;

export interface Bowl {
  /** Static tiers and outer walls, sorted with the people by ground diagonal. */
  shell: { d: number; g: Graphics }[];
  /** Field turf and markings, at ground level inside the bowl. */
  turf: Graphics;
  /** Height of each cell's top, in meters; 0 outside the bowl and on the field. */
  height: Float32Array;
  /** Seat cells in painter's order (furthest from the viewer first). */
  seats: Int32Array;
}

const quad = (pts: [number, number, number][]) =>
  pts.flatMap(([mx, my, h]) => {
    const p = isoProject(mx, my, h);
    return [p.sx, p.sy];
  });

/** Build diagonal tier batches and ground-level turf from the stadium cells. */
export function buildBowl(map: MapBundle): Bowl | null {
  const { width: W, height: H, cells } = map;
  const field = new Uint8Array(W * H);
  for (const c of map.field ?? []) field[c] = 1;
  const inBowl = (u: number, v: number) => u >= 0 && v >= 0 && u < W && v < H && cells[v * W + u] === 'stands';

  // Distance from the outer edge, in cells, over the whole bowl polygon.
  const dist = new Int32Array(W * H).fill(-1);
  const queue: number[] = [];
  for (let c = 0; c < cells.length; c++) {
    if (cells[c] !== 'stands') continue;
    const u = c % W;
    const v = (c / W) | 0;
    if (!inBowl(u + 1, v) || !inBowl(u - 1, v) || !inBowl(u, v + 1) || !inBowl(u, v - 1)) {
      dist[c] = 1;
      queue.push(c);
    }
  }
  if (queue.length === 0) return null;
  for (let head = 0; head < queue.length; head++) {
    const c = queue[head]!;
    const u = c % W;
    const v = (c / W) | 0;
    for (const [du, dv] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      if (!inBowl(u + du, v + dv)) continue;
      const n = (v + dv) * W + u + du;
      if (dist[n]! >= 0) continue;
      dist[n] = dist[c]! + 1;
      queue.push(n);
    }
  }
  // How deep the seating runs: the deepest seat, short of the field.
  let deepest = 1;
  for (let c = 0; c < cells.length; c++) if (dist[c]! > 0 && !field[c]) deepest = Math.max(deepest, dist[c]!);

  const height = new Float32Array(W * H);
  const seats: number[] = [];
  for (let c = 0; c < cells.length; c++) {
    if (dist[c]! <= 0 || field[c]) continue;
    // Highest at the rim, falling to the front row; stepped, like real tiers.
    const t = 1 - (dist[c]! - 1) / deepest;
    height[c] = Math.max(TIER_STEP, Math.round((1 + t * (RIM_H - 1)) / TIER_STEP) * TIER_STEP);
    seats.push(c);
  }
  seats.sort((a, b) => (a % W) + ((a / W) | 0) - ((b % W) + ((b / W) | 0)));

  // Bowl centre, for colouring sections by angle.
  let cx = 0;
  let cy = 0;
  for (const c of seats) {
    cx += c % W;
    cy += (c / W) | 0;
  }
  cx /= seats.length;
  cy /= seats.length;

  const shell: Bowl['shell'] = [];
  const hOf = (u: number, v: number) => (u >= 0 && v >= 0 && u < W && v < H ? height[v * W + u]! : 0);
  for (let start = 0; start < seats.length;) {
    const first = seats[start]!;
    const d = first % W + Math.floor(first / W);
    let end = start + 1;
    while (end < seats.length && seats[end]! % W + Math.floor(seats[end]! / W) === d) end++;
    const g = new Graphics();
    g.zIndex = diagonalZ(d);
    shell.push({ d, g });
    // Every face precedes every top on this diagonal, so a face cannot cover its neighbour's seat.
    for (let k = start; k < end; k++) {
      const c = seats[k]!;
      const u = c % W;
      const v = (c / W) | 0;
      const h = height[c]!;
      const x0 = u * C;
      const x1 = (u + 1) * C;
      const y0 = v * C;
      const y1 = (v + 1) * C;
      // The two faces this viewpoint sees: south and east, where the neighbour is lower.
      const south = hOf(u, v + 1);
      if (south < h) {
        const outer = !inBowl(u, v + 1);
        g.poly(quad([[x0, y1, south], [x1, y1, south], [x1, y1, h], [x0, y1, h]]), true).fill(outer ? (Math.floor(h / 3) % 2 ? 0x8a8780 : 0x9b978e) : 0x5b5e66);
      }
      const east = hOf(u + 1, v);
      if (east < h) {
        const outer = !inBowl(u + 1, v);
        g.poly(quad([[x1, y0, east], [x1, y1, east], [x1, y1, h], [x1, y0, h]]), true).fill(outer ? (Math.floor(h / 3) % 2 ? 0xa29e95 : 0xb2ada3) : 0x6b6e76);
      }
    }
    for (let k = start; k < end; k++) {
      const c = seats[k]!;
      const u = c % W;
      const v = (c / W) | 0;
      const h = height[c]!;
      const x0 = u * C;
      const x1 = (u + 1) * C;
      const y0 = v * C;
      const y1 = (v + 1) * C;
      // Seats: scarlet and grey sections around the bowl, a lighter aisle every few.
      const angle = Math.atan2(v - cy, u - cx);
      const section = Math.floor(((angle + Math.PI) / (Math.PI * 2)) * 28);
      const aisle = Math.abs(((angle + Math.PI) / (Math.PI * 2)) * 28 - section - 0.5) > 0.46;
      const row = Math.round(h / TIER_STEP) % 2;
      const seat = aisle ? 0xb9b4aa : section % 2 ? (row ? 0x9c1c24 : 0x8a1820) : row ? 0x6d7179 : 0x62666e;
      g.poly(quad([[x0, y0, h], [x1, y0, h], [x1, y1, h], [x0, y1, h]]), true).fill(seat);
    }
    start = end;
  }

  // The field: turf in ten-yard stripes, white lines every five yards, scarlet end zones.
  const turf = new Graphics();
  const fieldCells = map.field ?? [];
  if (fieldCells.length > 0) {
    let fx0 = Infinity, fx1 = -Infinity, fy0 = Infinity, fy1 = -Infinity;
    for (const c of fieldCells) {
      fx0 = Math.min(fx0, (c % W) * C);
      fx1 = Math.max(fx1, ((c % W) + 1) * C);
      fy0 = Math.min(fy0, ((c / W) | 0) * C);
      fy1 = Math.max(fy1, (((c / W) | 0) + 1) * C);
    }
    const midX = (fx0 + fx1) / 2;
    const midY = (fy0 + fy1) / 2;
    const yd = 0.9144;
    const halfW = (53.3 * yd) / 2;
    const halfL = (120 * yd) / 2;
    turf.poly(quad([[fx0, fy0, 0], [fx1, fy0, 0], [fx1, fy1, 0], [fx0, fy1, 0]]), true).fill(0x2f6b34);
    for (let k = 0; k < 12; k++) {
      const a = midY - halfL + k * 10 * yd;
      const b = a + 10 * yd;
      const endZone = k === 0 || k === 11;
      turf.poly(quad([[midX - halfW, a, 0], [midX + halfW, a, 0], [midX + halfW, b, 0], [midX - halfW, b, 0]]), true).fill(endZone ? 0xa3161e : k % 2 ? 0x3a8a40 : 0x347c3a);
    }
    const line = (y: number, w = 0.25) => turf.poly(quad([[midX - halfW, y - w, 0], [midX + halfW, y - w, 0], [midX + halfW, y + w, 0], [midX - halfW, y + w, 0]]), true).fill(0xf2f2ee);
    for (let k = 0; k <= 20; k++) line(midY - 50 * yd + k * 5 * yd, k % 2 ? 0.12 : 0.22);
    line(midY - halfL, 0.22);
    line(midY + halfL, 0.22);
    for (const side of [-1, 1]) {
      const x = midX + side * halfW;
      turf.poly(quad([[x - 0.22, midY - halfL, 0], [x + 0.22, midY - halfL, 0], [x + 0.22, midY + halfL, 0], [x - 0.22, midY + halfL, 0]]), true).fill(0xf2f2ee);
    }
    // The block O at midfield.
    const o = isoProject(midX, midY, 0);
    turf.ellipse(o.sx, o.sy, 9, 4.5).fill(0xbb0000);
    turf.ellipse(o.sx, o.sy, 6.2, 3.1).fill(0xf2f2ee);
    turf.ellipse(o.sx, o.sy, 3.6, 1.8).fill(0xbb0000);
    turf.ellipse(o.sx, o.sy, 2, 1).fill(0x347c3a);
  }

  return { shell, turf, height, seats: Int32Array.from(seats) };
}

const MAJOR = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link']);

/** Painted lane markings: a yellow centre line on main roads, dashed white on the rest. */
export function buildStreetLines(map: MapBundle): Graphics {
  const g = new Graphics();
  for (const street of map.streets ?? []) {
    const major = MAJOR.has(street.kind);
    if (!major && !street.name) continue;
    const pts = street.points;
    const dash = major ? 0 : 3;
    const gap = major ? 0 : 4;
    const width = major ? 0.3 : 0.18;
    const colour = major ? 0xf5c518 : 0xe8e8e2;
    // Dashes run on along the whole street, not restarting at every vertex.
    let along = 0;
    for (let i = 2; i < pts.length; i += 2) {
      const ax = pts[i - 2]!;
      const ay = pts[i - 1]!;
      const bx = pts[i]!;
      const by = pts[i + 1]!;
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 0.01) continue;
      const ux = (bx - ax) / len;
      const uy = (by - ay) / len;
      const nx = -uy * width;
      const ny = ux * width;
      const seg = (s0: number, s1: number) => {
        const p0x = ax + ux * s0;
        const p0y = ay + uy * s0;
        const p1x = ax + ux * s1;
        const p1y = ay + uy * s1;
        g.poly(quad([[p0x - nx, p0y - ny, 0.02], [p1x - nx, p1y - ny, 0.02], [p1x + nx, p1y + ny, 0.02], [p0x + nx, p0y + ny, 0.02]]), true).fill(colour);
      };
      if (dash === 0) seg(0, len);
      else {
        const period = dash + gap;
        for (let s = -(along % period); s < len; s += period) {
          const s0 = Math.max(0, s);
          const s1 = Math.min(len, s + dash);
          if (s1 > s0) seg(s0, s1);
        }
      }
      along += len;
    }
  }
  return g;
}

/** One label per named street, at the middle of its longest stretch. */
export function streetLabels(map: MapBundle): { name: string; x: number; y: number; major: boolean }[] {
  const best = new Map<string, { len: number; x: number; y: number; major: boolean }>();
  for (const street of map.streets ?? []) {
    if (!street.name) continue;
    const pts = street.points;
    let len = 0;
    for (let i = 2; i < pts.length; i += 2) len += Math.hypot(pts[i]! - pts[i - 2]!, pts[i + 1]! - pts[i - 1]!);
    const prev = best.get(street.name);
    if (prev && prev.len >= len) continue;
    // Walk to the halfway point.
    let half = len / 2;
    let x = pts[0]!;
    let y = pts[1]!;
    for (let i = 2; i < pts.length; i += 2) {
      const d = Math.hypot(pts[i]! - pts[i - 2]!, pts[i + 1]! - pts[i - 1]!);
      if (d >= half) {
        const t = d > 0 ? half / d : 0;
        x = pts[i - 2]! + (pts[i]! - pts[i - 2]!) * t;
        y = pts[i - 1]! + (pts[i + 1]! - pts[i - 1]!) * t;
        break;
      }
      half -= d;
    }
    best.set(street.name, { len, x, y, major: MAJOR.has(street.kind) });
  }
  return [...best.entries()].filter(([, v]) => v.len > 60).map(([name, v]) => ({ name, x: v.x, y: v.y, major: v.major }));
}
