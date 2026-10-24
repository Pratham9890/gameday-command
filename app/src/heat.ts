import type { MapBundle } from '../../contracts.ts';
import { CELL_SIZE_M } from '../../contracts.ts';

/**
 * The heatmap is drawn in five bands rather than a smooth ramp, so that "each
 * colour" means something a commander can click: every band is a range of
 * people per square meter, and clicking one isolates it on all three maps and
 * lists where those areas are.
 */
export interface HeatBand {
  id: number;
  label: string;
  range: string;
  min: number;
  max: number;
  rgb: [number, number, number];
  /** Opacity on the map when nothing is selected. */
  alpha: number;
  note: string;
}

export const HEAT_FLOOR = 0.08;

export function heatBands(danger: number): HeatBand[] {
  return [
    { id: 0, label: 'Free flow', range: `under 1 /m²`, min: HEAT_FLOOR, max: 1, rgb: [0x2e, 0xc4, 0x8a], alpha: 0.42, note: 'People walk at their own pace.' },
    { id: 1, label: 'Busy', range: '1–2 /m²', min: 1, max: 2, rgb: [0xb6, 0xd8, 0x3c], alpha: 0.6, note: 'Walking slows; groups merge.' },
    { id: 2, label: 'Dense', range: '2–3 /m²', min: 2, max: 3, rgb: [0xf5, 0xc5, 0x2a], alpha: 0.72, note: 'Shuffling pace, no passing.' },
    { id: 3, label: 'Crowded', range: `3–${danger} /m²`, min: 3, max: danger, rgb: [0xff, 0x8a, 0x2b], alpha: 0.82, note: 'Contact with neighbours; hard to leave.' },
    { id: 4, label: 'Danger', range: `${danger}+ /m²`, min: danger, max: Infinity, rgb: [0xff, 0x2d, 0x6f], alpha: 0.92, note: 'Counted as danger minutes on the scorecard.' },
  ];
}

export function bandOf(value: number, bands: HeatBand[]): number {
  if (value < HEAT_FLOOR) return -1;
  for (let b = bands.length - 1; b >= 0; b--) if (value >= bands[b]!.min) return b;
  return 0;
}

export interface BandTotals {
  cells: number;
  people: number;
}

/** Cells and people in each band, for the legend and the area panel. */
export function bandTotals(peoplePerM2: Float32Array, bands: HeatBand[]): BandTotals[] {
  const out = bands.map(() => ({ cells: 0, people: 0 }));
  const area = CELL_SIZE_M * CELL_SIZE_M;
  for (let i = 0; i < peoplePerM2.length; i++) {
    const v = peoplePerM2[i]!;
    if (v < HEAT_FLOOR) continue;
    const b = bandOf(v, bands);
    out[b]!.cells++;
    out[b]!.people += v * area;
  }
  return out;
}

export interface Hotspot {
  /** Cell bounds, inclusive. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  cells: number;
  people: number;
  peak: number;
  centre: number;
  where: string;
}

/**
 * Connected areas in one band, biggest crowd first. Eight-way connected and a
 * little forgiving: two patches one cell apart are the same queue, so cells of
 * this band OR denser are joined (a danger core sits inside a crowded ring).
 */
export function hotspots(peoplePerM2: Float32Array, map: MapBundle, band: HeatBand, places: PlaceIndex, limit = 5): Hotspot[] {
  const { width: W, height: H } = map;
  const seen = new Uint8Array(W * H);
  const inBand = (v: number) => v >= band.min;
  const stack: number[] = [];
  const found: Hotspot[] = [];
  const area = CELL_SIZE_M * CELL_SIZE_M;
  for (let start = 0; start < peoplePerM2.length; start++) {
    if (seen[start] || !inBand(peoplePerM2[start]!)) continue;
    let x0 = W, y0 = H, x1 = 0, y1 = 0, cells = 0, people = 0, peak = 0, sx = 0, sy = 0, count = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const c = stack.pop()!;
      const v = peoplePerM2[c]!;
      const cx = c % W;
      const cy = (c / W) | 0;
      if (v < band.max) {
        cells++;
        people += v * area;
      }
      if (v > peak) peak = v;
      sx += cx * v;
      sy += cy * v;
      count += v;
      if (cx < x0) x0 = cx;
      if (cy < y0) y0 = cy;
      if (cx > x1) x1 = cx;
      if (cy > y1) y1 = cy;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || y < 0 || x >= W || y >= H) continue;
          const n = y * W + x;
          if (seen[n] || !inBand(peoplePerM2[n]!)) continue;
          seen[n] = 1;
          stack.push(n);
        }
      }
    }
    if (cells < 3) continue;
    // Described from the cell nearest the patch's centre of mass that is
    // actually in it, so a curved queue is named by where its people are.
    const mx = sx / count;
    const my = sy / count;
    found.push({ x0, y0, x1, y1, cells, people, peak, centre: Math.round(my) * W + Math.round(mx), where: '' });
  }
  found.sort((a, b) => b.people - a.people);
  // Naming is the slow part, so only the ones shown get a name.
  return found.slice(0, limit).map((h) => ({ ...h, where: places.describe(h.centre) }));
}

/** Names for places on the map, so a hotspot reads "Gate 3 (NE)" and not a cell number. */
export interface PlaceIndex {
  describe(cell: number): string;
}

export function makePlaceIndex(map: MapBundle): PlaceIndex {
  const W = map.width;
  const centroid = (cells: number[]) => {
    let x = 0;
    let y = 0;
    for (const c of cells) {
      x += c % W;
      y += (c / W) | 0;
    }
    return { x: x / Math.max(1, cells.length), y: y / Math.max(1, cells.length) };
  };
  const gates = map.places.filter((p) => p.kind === 'gate').map((p) => ({ name: p.name, ...centroid(p.cells) }));
  const lots = map.places
    .filter((p) => p.kind === 'parking' && p.id !== 'lots' && !/^Lot \d+$/.test(p.name))
    .map((p) => ({ name: p.name, ...centroid(p.cells) }));
  const street = new Int16Array(map.width * map.height).fill(-1);
  const streets = map.closables.filter((c) => c.id.startsWith('street-'));
  streets.forEach((s, i) => {
    for (const c of s.cells) street[c] = i;
  });
  const nearest = (list: { name: string; x: number; y: number }[], x: number, y: number) => {
    let best: { name: string; d: number } | null = null;
    for (const p of list) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (!best || d < best.d) best = { name: p.name, d };
    }
    return best;
  };
  return {
    describe(cell) {
      const x = cell % W;
      const y = (cell / W) | 0;
      const kind = map.cells[cell];
      if (kind === 'stands') return 'In the stands';
      if (kind === 'concourse') {
        const g = nearest(gates, x, y);
        return g ? `Concourse by ${g.name}` : 'Concourse';
      }
      for (let r = 0; r <= 3; r++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= W || yy >= map.height) continue;
            const s = street[yy * W + xx]!;
            if (s >= 0) return `On ${streets[s]!.name}`;
          }
        }
      }
      const g = nearest(gates, x, y);
      if (g && g.d * CELL_SIZE_M < 140) return `Outside ${g.name}`;
      const lot = nearest(lots, x, y);
      if (lot && lot.d * CELL_SIZE_M < 160) return `By ${lot.name}`;
      if (g) return `${Math.round((g.d * CELL_SIZE_M) / 10) * 10} m from ${g.name}`;
      return 'Open ground';
    },
  };
}
