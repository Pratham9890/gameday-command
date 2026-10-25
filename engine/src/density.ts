import type { DensityGrid, MapBundle, SimSeconds } from '../../contracts.ts';
import { CELL_SIZE_M, DOT_GROUP_SIZE } from '../../contracts.ts';
import type { DotStore } from './dots.ts';
import { STATE_INDEX } from './dots.ts';

const CELL_AREA_M2 = CELL_SIZE_M * CELL_SIZE_M;
const GONE = STATE_INDEX.gone;
const SEATED = STATE_INDEX.seated;

/**
 * What FlowMovement already knows about this step's cell occupancy, so the
 * density pass can skip walking every dot. `counts` and `seated` are per cell;
 * `touched` names every cell the rebuild cleared and wrote, so after the rebuild
 * it holds every occupied cell, and the density pass can take it wholesale.
 */
export interface DensityContribution {
  counts: Int32Array;
  seated: Int32Array;
  touched: Int32Array;
  touchedCount: number;
}

/**
 * Per-cell people counts and people per square metre.
 *
 * Reused in place every step — allocating two grids 3,600 times per run was the
 * easiest garbage to avoid, and the app gets copies only on frame boundaries.
 */
export class DensityField {
  readonly counts: Int32Array;
  readonly peoplePerM2: Float32Array;
  /**
   * The same, leaving out fans sitting in their seats. Scoring reads this one:
   * a full stand sits at the density cap by design, and counting it as crush
   * danger made every plan score alike. Fans walking or queueing through the
   * stands still count, because a crush in the aisles is the real thing.
   */
  readonly standingPerM2: Float32Array;
  private readonly standingCounts: Int32Array;

  /**
   * Cells that held at least one live dot after the last update, ascending,
   * with `occupiedCount` giving the live prefix. Reused and sized to the whole
   * map, so consumers can visit the crowd without walking the empty grid.
   */
  readonly occupied: Int32Array;
  occupiedCount = 0;

  readonly width: number;
  readonly height: number;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.counts = new Int32Array(width * height);
    this.peoplePerM2 = new Float32Array(width * height);
    this.standingCounts = new Int32Array(width * height);
    this.standingPerM2 = new Float32Array(width * height);
    this.occupied = new Int32Array(width * height);
  }

  static forMap(map: MapBundle): DensityField {
    return new DensityField(map.width, map.height);
  }

  update(dots: DotStore, contribution?: DensityContribution): void {
    if (contribution !== undefined) {
      this.applyContribution(contribution);
      return;
    }
    // A cell can only be non-zero if a dot landed in it last step, and every
    // such cell is in `occupied`. Zeroing that list therefore leaves the whole
    // grid clean, with no sweep over the thousands of empty cells.
    for (let k = 0; k < this.occupiedCount; k++) {
      const cell = this.occupied[k]!;
      this.counts[cell] = 0;
      this.standingCounts[cell] = 0;
      this.peoplePerM2[cell] = 0;
      this.standingPerM2[cell] = 0;
    }
    this.occupiedCount = 0;
    const { x, y, state, count } = dots;
    for (let i = 0; i < count; i++) {
      if (state[i] === GONE) continue;
      // Off-map dots are parked at (-1, -1). Truncation rounds toward zero, so
      // (-1 / 2) | 0 is 0, not -1 — testing the cell index instead of the
      // coordinate put every unarrived fan in cell 0.
      if (x[i]! < 0 || y[i]! < 0) continue;
      const cx = (x[i]! / CELL_SIZE_M) | 0;
      const cy = (y[i]! / CELL_SIZE_M) | 0;
      if (cx < 0 || cy < 0 || cx >= this.width || cy >= this.height) continue;
      const cell = cy * this.width + cx;
      // Counts are zero here, so the first dot in a cell is also the moment it
      // joins the touched list. Later dots in the same cell just count.
      if (this.counts[cell] === 0) this.occupied[this.occupiedCount++] = cell;
      this.counts[cell]!++;
      if (state[i] !== SEATED) this.standingCounts[cell]!++;
    }
    // Ascending so consumers iterate deterministically. Order does not affect
    // the values: each cell is converted from its own count, exactly as before.
    this.occupied.subarray(0, this.occupiedCount).sort();
    for (let k = 0; k < this.occupiedCount; k++) {
      const cell = this.occupied[k]!;
      this.peoplePerM2[cell] = (this.counts[cell]! * DOT_GROUP_SIZE) / CELL_AREA_M2;
      this.standingPerM2[cell] = (this.standingCounts[cell]! * DOT_GROUP_SIZE) / CELL_AREA_M2;
    }
  }

  /**
   * The cheaper path: FlowMovement already rebuilt every cell's count this step,
   * and its `touched` list names every cell that rebuild wrote — which is every
   * cell that holds anyone now. Density can therefore take that occupancy
   * wholesale instead of walking every dot again.
   */
  private applyContribution(contribution: DensityContribution): void {
    const { counts, seated, touched, touchedCount } = contribution;

    // The previous list can name cells that emptied this step, and those cells
    // are not in `touched` because the rebuild never wrote them. Their counts
    // are zero in the contribution, but the derived values here would linger, so
    // the old prefix is zeroed before it is rebuilt. Every cell that still holds
    // someone comes back below from `touched`, so nothing live is lost.
    for (let k = 0; k < this.occupiedCount; k++) {
      const cell = this.occupied[k]!;
      this.counts[cell] = 0;
      this.standingCounts[cell] = 0;
      this.peoplePerM2[cell] = 0;
      this.standingPerM2[cell] = 0;
    }
    this.occupiedCount = 0;

    // Adopt only the cells that still hold someone, appending them in the order
    // the movement pass touched them. A touched cell that emptied is zeroed
    // here and left out of the list.
    for (let k = 0; k < touchedCount; k++) {
      const cell = touched[k]!;
      const total = counts[cell]!;
      if (total > 0) {
        const sitting = seated[cell]!;
        this.counts[cell] = total;
        this.standingCounts[cell] = total > sitting ? total - sitting : 0;
        this.occupied[this.occupiedCount++] = cell;
      } else {
        this.counts[cell] = 0;
        this.standingCounts[cell] = 0;
        this.peoplePerM2[cell] = 0;
        this.standingPerM2[cell] = 0;
      }
    }

    // Ascending so consumers iterate deterministically. Order does not affect
    // the values: each cell is converted from its own count, exactly as before.
    this.occupied.subarray(0, this.occupiedCount).sort();
    for (let k = 0; k < this.occupiedCount; k++) {
      const cell = this.occupied[k]!;
      this.peoplePerM2[cell] = (this.counts[cell]! * DOT_GROUP_SIZE) / CELL_AREA_M2;
      this.standingPerM2[cell] = (this.standingCounts[cell]! * DOT_GROUP_SIZE) / CELL_AREA_M2;
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
