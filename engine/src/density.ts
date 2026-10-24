import type { DensityGrid, MapBundle, SimSeconds } from '../../contracts.ts';
import { CELL_SIZE_M, DOT_GROUP_SIZE } from '../../contracts.ts';
import type { DotStore } from './dots.ts';
import { STATE_INDEX } from './dots.ts';

const CELL_AREA_M2 = CELL_SIZE_M * CELL_SIZE_M;
const GONE = STATE_INDEX.gone;

/**
 * Per-cell people counts and people per square metre.
 *
 * Reused in place every step — allocating two grids 3,600 times per run was the
 * easiest garbage to avoid, and the app gets copies only on frame boundaries.
 */
export class DensityField {
  readonly counts: Int32Array;
  readonly peoplePerM2: Float32Array;

  readonly width: number;
  readonly height: number;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.counts = new Int32Array(width * height);
    this.peoplePerM2 = new Float32Array(width * height);
  }

  static forMap(map: MapBundle): DensityField {
    return new DensityField(map.width, map.height);
  }

  update(dots: DotStore): void {
    this.counts.fill(0);
    const { x, y, state, count } = dots;
    for (let i = 0; i < count; i++) {
      if (state[i] === GONE) continue;
      const cx = (x[i]! / CELL_SIZE_M) | 0;
      const cy = (y[i]! / CELL_SIZE_M) | 0;
      if (cx < 0 || cy < 0 || cx >= this.width || cy >= this.height) continue;
      this.counts[cy * this.width + cx]!++;
    }
    for (let i = 0; i < this.counts.length; i++) {
      this.peoplePerM2[i] = (this.counts[i]! * DOT_GROUP_SIZE) / CELL_AREA_M2;
    }
  }

  dotsInCells(cells: readonly number[]): number {
    let total = 0;
    for (const cell of cells) total += this.counts[cell] ?? 0;
    return total;
  }

  /** A transferable copy for the main thread. */
  toGrid(t: SimSeconds): DensityGrid {
    return { t, width: this.width, height: this.height, peoplePerM2: this.peoplePerM2.slice() };
  }

  /** Borrowed view for WorldView, valid only during the current step. */
  view(t: SimSeconds): DensityGrid {
    return { t, width: this.width, height: this.height, peoplePerM2: this.peoplePerM2 };
  }
}
