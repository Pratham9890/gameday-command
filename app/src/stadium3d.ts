import { Graphics } from 'pixi.js';
import type { MapBundle } from '../../contracts.ts';
import { CELL_SIZE_M } from '../../contracts.ts';
import { isoProject } from './people.ts';

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
  /** Static tiers and outer walls. */
  shell: Graphics;
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

const hexNum = (hex: string) => parseInt(hex.replace('#', ''), 16);
const scale = (c: number, k: number) => {
  const ch = (shift: number) => Math.max(0, Math.min(255, Math.round(((c >> shift) & 255) * k)));
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
};

/**
 * Seat, end-zone and logo colours. Ohio Stadium keeps the exact scarlet and
 * grey it always had; every other stadium is painted in its home team's two
 * colours, shaded so alternate rows read as tiers.
 */
export function bowlPalette(map: MapBundle) {
  const theme = map.theme;
  if (!theme || theme.team === 'Ohio State Buckeyes') {
    return { a1: 0x9c1c24, a2: 0x8a1820, b1: 0x6d7179, b2: 0x62666e, aisle: 0xb9b4aa, endZone: 0xa3161e, logo: 0xbb0000, logoRing: 0xf2f2ee, logoCore: 0x347c3a };
  }
  const p = hexNum(theme.primary);
  const q = hexNum(theme.secondary);
  // White or near-white secondaries would glare as whole sections; tone them to a light grey.
  const lum = (c: number) => (0.299 * ((c >> 16) & 255) + 0.587 * ((c >> 8) & 255) + 0.114 * (c & 255)) / 255;
  const q2 = lum(q) > 0.85 ? 0xd9dce1 : q;
  return {
    a1: scale(p, 0.95), a2: scale(p, 0.82),
    b1: scale(q2, 0.9), b2: scale(q2, 0.78),
    aisle: 0xb9b4aa,
    endZone: scale(p, 0.92),
    logo: p,
    logoRing: q2,
    logoCore: 0x347c3a,
  };
}

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

  const palette = bowlPalette(map);
  const shell = new Graphics();
  const hOf = (u: number, v: number) => (u >= 0 && v >= 0 && u < W && v < H ? height[v * W + u]! : 0);
  for (const c of seats) {
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
      shell.poly(quad([[x0, y1, south], [x1, y1, south], [x1, y1, h], [x0, y1, h]]), true).fill(outer ? (Math.floor(h / 3) % 2 ? 0x8a8780 : 0x9b978e) : 0x5b5e66);
    }
    const east = hOf(u + 1, v);
    if (east < h) {
      const outer = !inBowl(u + 1, v);
      shell.poly(quad([[x1, y0, east], [x1, y1, east], [x1, y1, h], [x1, y0, h]]), true).fill(outer ? (Math.floor(h / 3) % 2 ? 0xa29e95 : 0xb2ada3) : 0x6b6e76);
    }
    // Seats in sections of the home team's two colours, a lighter aisle every few.
    const angle = Math.atan2(v - cy, u - cx);
    const section = Math.floor(((angle + Math.PI) / (Math.PI * 2)) * 28);
    const aisle = Math.abs(((angle + Math.PI) / (Math.PI * 2)) * 28 - section - 0.5) > 0.46;
    const row = Math.round(h / TIER_STEP) % 2;
    const seat = aisle ? palette.aisle : section % 2 ? (row ? palette.a1 : palette.a2) : row ? palette.b1 : palette.b2;
    shell.poly(quad([[x0, y0, h], [x1, y0, h], [x1, y1, h], [x0, y1, h]]), true).fill(seat);
  }

  // The field: turf in ten-yard stripes, white lines every five yards, end
  // zones in the home team's colour, laid along the bowl's own axis.
  const turf = new Graphics();
  const fieldCells = map.field ?? [];
  if (fieldCells.length > 0) {
    let mx = 0;
    let my = 0;
    for (const c of fieldCells) {
      mx += ((c % W) + 0.5) * C;
      my += (((c / W) | 0) + 0.5) * C;
    }
    mx /= fieldCells.length;
    my /= fieldCells.length;
    const axis = map.fieldAxis ?? 0;
    const cos = Math.cos(axis);
    const sin = Math.sin(axis);
    // The field's own frame: u across it, v along it (same rotation the map builder used).
    let uMax = 0;
    let vMax = 0;
    for (const c of fieldCells) {
      const dx = ((c % W) + 0.5) * C - mx;
      const dy = (((c / W) | 0) + 0.5) * C - my;
      uMax = Math.max(uMax, Math.abs(dx * cos - dy * sin));
      vMax = Math.max(vMax, Math.abs(dx * sin + dy * cos));
    }
    const at = (uu: number, vv: number): [number, number, number] => [mx + uu * cos + vv * sin, my - uu * sin + vv * cos, 0];
    const rect = (u0: number, v0: number, u1: number, v1: number, colour: number) =>
      turf.poly(quad([at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)]), true).fill(colour);
    const sport = map.sport ?? 'football';
    const white = 0xf2f2ee;
    const ring = (ru: number, rv: number, w: number, colour: number, segments = 48) => {
      // An ellipse outline in the field's frame, as a strip of thin quads.
      for (let i = 0; i < segments; i++) {
        const a0 = (i / segments) * Math.PI * 2;
        const a1 = ((i + 1) / segments) * Math.PI * 2;
        const p = (a: number, r: number): [number, number, number] => at(Math.cos(a) * (ru + r), Math.sin(a) * (rv + r));
        turf.poly(quad([p(a0, -w), p(a1, -w), p(a1, w), p(a0, w)]), true).fill(colour);
      }
    };
    const disc = (ru: number, rv: number, colour: number, segments = 48) => {
      const pts: [number, number, number][] = [];
      for (let i = 0; i < segments; i++) {
        const a = (i / segments) * Math.PI * 2;
        pts.push(at(Math.cos(a) * ru, Math.sin(a) * rv));
      }
      turf.poly(quad(pts), true).fill(colour);
    };

    if (sport === 'cricket' || sport === 'baseball') {
      // An oval of grass, mown in rings, drawn cell by cell so it fills the ground's own shape.
      for (const c of fieldCells) {
        const x0 = (c % W) * C;
        const y0 = ((c / W) | 0) * C;
        const dx = x0 + C / 2 - mx;
        const dy = y0 + C / 2 - my;
        const band = Math.floor(Math.hypot(dx, dy) / 6) % 2;
        turf.poly(quad([[x0, y0, 0], [x0 + C, y0, 0], [x0 + C, y0 + C, 0], [x0, y0 + C, 0]]), true).fill(band ? 0x3a8a40 : 0x347c3a);
      }
      if (sport === 'cricket') {
        // The 30-yard circle, the square, and the pitch: 20 m of rolled clay between the creases.
        ring(27.4, 27.4, 0.2, white);
        rect(-6, -12, 6, 12, 0x3f7d42);
        rect(-1.5, -11, 1.5, 11, 0xc8b27a);
        for (const end of [-1, 1]) {
          rect(-1.9, end * 10.06 - 0.06, 1.9, end * 10.06 + 0.06, white);
          rect(-0.12, end * 10.06 - 0.25, 0.12, end * 10.06 + 0.25, 0x6b4a2b);
        }
      } else {
        // The infield: a dirt diamond with bases 27.4 m apart, and the mound.
        const d = 27.4 / Math.SQRT2;
        const home = vMax * 0.45;
        turf.poly(quad([at(0, home), at(d * 1.25, home - d * 1.25), at(0, home - d * 2.5), at(-d * 1.25, home - d * 1.25)]), true).fill(0xb7834f);
        turf.poly(quad([at(0, home - 2), at(d * 0.8, home - d), at(0, home - d * 2 + 2), at(-d * 0.8, home - d)]), true).fill(0x3a8a40);
        for (const [bu, bv] of [[0, home], [d, home - d], [0, home - 2 * d], [-d, home - d]] as const) rect(bu - 0.4, bv - 0.4, bu + 0.4, bv + 0.4, white);
        disc(2.7, 2.7, 0xb7834f);
      }
    } else if (sport === 'soccer') {
      const k = Math.min(1, (vMax + C / 2) / 54, (uMax + C / 2) / 35);
      const hw = 34 * k;
      const hl = 52.5 * k;
      rect(-uMax - C / 2, -vMax - C / 2, uMax + C / 2, vMax + C / 2, 0x2f6b34);
      for (let i = 0; i < 12; i++) rect(-hw, -hl + (i * 2 * hl) / 12, hw, -hl + ((i + 1) * 2 * hl) / 12, i % 2 ? 0x3a8a40 : 0x347c3a);
      const line = (u0: number, v0: number, u1: number, v1: number) => rect(Math.min(u0, u1) - 0.12, Math.min(v0, v1) - 0.12, Math.max(u0, u1) + 0.12, Math.max(v0, v1) + 0.12, white);
      line(-hw, -hl, hw, -hl);
      line(-hw, hl, hw, hl);
      line(-hw, -hl, -hw, hl);
      line(hw, -hl, hw, hl);
      line(-hw, 0, hw, 0);
      ring(9.15 * k, 9.15 * k, 0.12, white);
      for (const end of [-1, 1]) {
        const v0 = end * hl;
        const box = (half: number, depth: number) => {
          line(-half, v0, -half, v0 - end * depth);
          line(half, v0, half, v0 - end * depth);
          line(-half, v0 - end * depth, half, v0 - end * depth);
        };
        box(20.15 * k, 16.5 * k);
        box(9.16 * k, 5.5 * k);
        rect(-3.66 * k, v0 - 0.3, 3.66 * k, v0 + 0.3 + end * 1.5, palette.endZone);
      }
      disc(1.2, 1.2, palette.logo);
    } else {
      const yd = 0.9144;
      // A regulation field, shrunk to fit a smaller bowl.
      const k = Math.min(1, (vMax + C / 2) / (60 * yd), (uMax + C / 2) / (26.65 * yd));
      const halfW = 26.65 * yd * k;
      const halfL = 60 * yd * k;
      const step = 10 * yd * k;
      rect(-uMax - C / 2, -vMax - C / 2, uMax + C / 2, vMax + C / 2, 0x2f6b34);
      for (let i = 0; i < 12; i++) {
        const a = -halfL + i * step;
        const endZone = i === 0 || i === 11;
        rect(-halfW, a, halfW, a + step, endZone ? palette.endZone : i % 2 ? 0x3a8a40 : 0x347c3a);
      }
      const line = (vv: number, w: number) => rect(-halfW, vv - w, halfW, vv + w, white);
      for (let i = 0; i <= 20; i++) line(-50 * yd * k + i * 5 * yd * k, i % 2 ? 0.12 : 0.22);
      line(-halfL, 0.22);
      line(halfL, 0.22);
      for (const side of [-1, 1]) rect(side * halfW - 0.22, -halfL, side * halfW + 0.22, halfL, white);
      // The midfield logo: Ohio's block O, or a ring in the home team's colours.
      const o = isoProject(mx, my, 0);
      turf.ellipse(o.sx, o.sy, 9 * k, 4.5 * k).fill(palette.logo);
      turf.ellipse(o.sx, o.sy, 6.2 * k, 3.1 * k).fill(palette.logoRing);
      turf.ellipse(o.sx, o.sy, 3.6 * k, 1.8 * k).fill(palette.logo);
      turf.ellipse(o.sx, o.sy, 2 * k, 1 * k).fill(palette.logoCore);
    }
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
