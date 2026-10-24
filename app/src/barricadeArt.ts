import { Graphics } from 'pixi.js';
import { CELL_SIZE_M as C, type CellKind, type MapBundle } from '../../contracts.ts';
import type { Barricade, SceneInfo } from '../../engine/src/edits.ts';
import { diagonalZ, vehicleDiagonal } from './depth.ts';
import { isoProject } from './people.ts';

export interface BarricadePlacement {
  x: number;
  y: number;
  /** Direction of the long edge, in ground-plane radians. */
  angle: number;
  kind: 'jersey' | 'sawhorse';
}

export interface ClosedArea extends Barricade {
  x: number;
  y: number;
  angle: number;
  isGate: boolean;
}

export interface BarricadeGroup {
  d: number;
  body: Graphics;
  lights: Graphics;
}

const MAX_PIECES = 96;

function stretch(cells: number[], width: number) {
  const points = cells.map((c) => ({ x: ((c % width) + 0.5) * C, y: (Math.floor(c / width) + 0.5) * C }));
  const x = points.reduce((sum, p) => sum + p.x, 0) / points.length;
  const y = points.reduce((sum, p) => sum + p.y, 0) / points.length;
  let xx = 0, xy = 0, yy = 0;
  for (const p of points) {
    xx += (p.x - x) ** 2;
    xy += (p.x - x) * (p.y - y);
    yy += (p.y - y) ** 2;
  }
  const angle = Math.atan2(2 * xy, xx - yy) / 2;
  const fx = Math.cos(angle), fy = Math.sin(angle);
  return {
    x, y, angle,
    points: points.map((p) => ({ ...p, t: (p.x - x) * fx + (p.y - y) * fy, n: -(p.x - x) * fy + (p.y - y) * fx })),
  };
}

/** Stable across closed-id ordering; includes live cells so same-size moves redraw. */
export function closureKey(info: SceneInfo | null): string {
  if (!info) return '';
  const closed = new Set(info.closed);
  return JSON.stringify([
    [...closed].sort(),
    (info.barricades ?? []).filter((b) => closed.has(b.id)).map((b) => [b.id, b.name, b.cells]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  ]);
}

/** Resolve each closed id once, keeping map geometry when a live id overlaps it. */
export function closedAreas(map: MapBundle, info: SceneInfo | null): ClosedArea[] {
  if (!info) return [];
  const closed = new Set(info.closed);
  const seen = new Set<string>();
  const gates = new Set(map.places.filter((p) => p.kind === 'gate').flatMap((p) => p.cells));
  const areas: ClosedArea[] = [];
  for (const area of [...map.closables, ...(info.barricades ?? [])]) {
    if (!closed.has(area.id) || seen.has(area.id)) continue;
    seen.add(area.id);
    if (!area.cells.length) continue;
    const { x, y, angle } = stretch(area.cells, map.width);
    const isGate = area.cells.some((c) => gates.has(c));
    areas.push({ ...area, x, y, angle: angle + (isGate ? 0 : Math.PI / 2), isGate });
  }
  return areas;
}

/** Roads and their four-adjacent pedestrian approaches accept street commands. */
export function streetCellAt(map: Pick<MapBundle, 'width' | 'height' | 'cells'>, cell: number): boolean {
  if (!Number.isInteger(cell) || cell < 0 || cell >= map.width * map.height) return false;
  if (map.cells[cell] === 'road') return true;
  if (map.cells[cell] !== 'walk') return false;
  const u = cell % map.width;
  const v = Math.floor(cell / map.width);
  return (u > 0 && map.cells[cell - 1] === 'road') || (u + 1 < map.width && map.cells[cell + 1] === 'road') ||
    (v > 0 && map.cells[cell - map.width] === 'road') || (v + 1 < map.height && map.cells[cell + map.width] === 'road');
}

/** Place capped doorway rows or road-end rows plus pieces every roughly eight metres. */
export function barricadePlacements(cells: number[], width: number, cellKind: (cell: number) => CellKind | undefined, isGate: boolean): BarricadePlacement[] {
  if (!cells.length) return [];
  const { angle, points } = stretch(cells, width);
  points.sort((a, b) => a.t - b.t || Math.abs(a.n) - Math.abs(b.n));
  const pieces: BarricadePlacement[] = [];
  const add = (x: number, y: number, kind: BarricadePlacement['kind']) => {
    pieces.push({ x, y, angle: angle + (isGate ? 0 : Math.PI / 2), kind });
  };
  const sample = <T>(items: T[], limit: number): T[] => items.length <= limit ? items :
    Array.from({ length: limit }, (_, i) => items[Math.round(i * (items.length - 1) / (limit - 1))]!);

  if (isGate) {
    // A thick raster doorway still needs only one row, along its principal axis.
    const row = new Map<number, typeof points[number]>();
    const start = points[0]!.t;
    for (const p of points) {
      const slot = Math.round((p.t - start) / C);
      const prev = row.get(slot);
      if (!prev || Math.abs(p.n) < Math.abs(prev.n)) row.set(slot, p);
    }
    for (const p of sample([...row.values()], MAX_PIECES)) add(p.x, p.y, 'sawhorse');
    return pieces;
  }

  const min = points[0]!.t, max = points[points.length - 1]!.t;
  const ends = [points[0]!, points[points.length - 1]!];
  // Ties on an end cross-section favour the road centre, not a pavement corner.
  for (const p of points) {
    if (Math.abs(p.t - min) < 0.01 && Math.abs(p.n) < Math.abs(ends[0]!.n)) ends[0] = p;
    if (Math.abs(p.t - max) < 0.01 && Math.abs(p.n) < Math.abs(ends[1]!.n)) ends[1] = p;
  }
  const seen = new Set<number>();
  const nx = -Math.sin(angle), ny = Math.cos(angle);
  for (const end of ends) {
    const row = [{ x: end.x, y: end.y }];
    for (const sign of [-1, 1]) {
      // Bounded scans keep a closure at a large intersection cheap to rebuild.
      for (let i = 1; i <= MAX_PIECES / 2; i++) {
        const x = end.x + nx * i * C * sign, y = end.y + ny * i * C * sign;
        const u = Math.floor(x / C), v = Math.floor(y / C);
        if (u < 0 || u >= width || v < 0 || cellKind(v * width + u) !== 'road') break;
        row.push({ x, y });
      }
    }
    row.sort((a, b) => (a.x * nx + a.y * ny) - (b.x * nx + b.y * ny));
    for (const p of sample(row, MAX_PIECES / 4)) {
      const cell = Math.floor(p.y / C) * width + Math.floor(p.x / C);
      if (seen.has(cell)) continue;
      seen.add(cell);
      add(p.x, p.y, 'jersey');
    }
  }
  const intervals = new Map<number, typeof points[number]>();
  for (const p of points) {
    if (p.t < min + 4 * C || p.t > max - 2 * C) continue;
    const slot = Math.floor((p.t - min) / (4 * C));
    const prev = intervals.get(slot);
    if (!prev || Math.abs(p.n) < Math.abs(prev.n)) intervals.set(slot, p);
  }
  for (const p of sample([...intervals.values()], MAX_PIECES / 2)) {
    const cell = Math.floor(p.y / C) * width + Math.floor(p.x / C);
    if (!seen.has(cell)) add(p.x, p.y, 'sawhorse');
  }
  return pieces;
}

/** Build static faces and separately flashable lights in the shared depth order. */
export function buildBarricades(pieces: BarricadePlacement[]): BarricadeGroup[] {
  const groups = new Map<number, BarricadeGroup>();
  for (const p of pieces) {
    const d = vehicleDiagonal(p.x, p.y, p.angle, 2, 0.6);
    let group = groups.get(d);
    if (!group) {
      group = { d, body: new Graphics(), lights: new Graphics() };
      group.body.zIndex = diagonalZ(d) + 0.0006;
      group.lights.zIndex = diagonalZ(d) + 0.0007;
      groups.set(d, group);
    }
    const g = group.body;
    const fx = Math.cos(p.angle), fy = Math.sin(p.angle);
    type Point = [number, number, number];
    const project = ([x, y, z]: Point) => isoProject(p.x + x * fx - y * fy, p.y + x * fy + y * fx, z);
    const face = (points: Point[], color: number) => g.poly(points.flatMap((pt) => {
      const q = project(pt);
      return [q.sx, q.sy];
    }), true).fill(color);
    const prism = (x0: number, x1: number, w0: number, w1: number, z0: number, z1: number, striped: boolean) => {
      const base: Point[] = [[x0, -w0, z0], [x1, -w0, z0], [x1, w0, z0], [x0, w0, z0]];
      const top: Point[] = [[x0, -w1, z1], [x1, -w1, z1], [x1, w1, z1], [x0, w1, z1]];
      const lerp = (a: Point, b: Point, t: number): Point => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
      for (let i = 0; i < 4; i++) {
        const j = (i + 1) % 4;
        const a = base[i]!, b = base[j]!, c = top[j]!, e = top[i]!;
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const normalX = dy * fx + dx * fy, normalY = dy * fy - dx * fx;
        // Back faces would paint through the body from the south-east viewpoint.
        if (normalX + normalY <= 1e-8) continue;
        face([a, b, c, e], normalX > normalY ? 0xef7c23 : 0xc95a16);
        if (striped) face([lerp(a, e, 0.38), lerp(b, c, 0.38), lerp(b, c, 0.66), lerp(a, e, 0.66)], 0xfff2dc);
      }
      face(top, 0xffb45c);
    };
    if (p.kind === 'jersey') prism(-1, 1, 0.3, 0.13, 0, 0.8, true);
    else {
      prism(-0.78, -0.58, 0.3, 0.08, 0, 1.1, false);
      prism(0.58, 0.78, 0.3, 0.08, 0, 1.1, false);
      prism(-1, 1, 0.11, 0.11, 0.85, 1.3, true);
    }
    const light = project([0, 0, p.kind === 'jersey' ? 1 : 1.5]);
    g.rect(light.sx - 0.12, light.sy, 0.24, 0.2).fill(0x51535b);
    group.lights.circle(light.sx, light.sy, 0.15).fill(0xffc247);
  }
  return [...groups.values()].sort((a, b) => a.d - b.d);
}
