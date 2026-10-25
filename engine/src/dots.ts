import type { DotState, Snapshot } from '../../contracts.ts';
import { DOT_STATES } from '../../contracts.ts';

export const STATE_INDEX: Record<DotState, number> = DOT_STATES.reduce(
  (acc, name, i) => {
    acc[name] = i;
    return acc;
  },
  {} as Record<DotState, number>,
);

/**
 * Numeric state codes, sourced from STATE_INDEX so they can never drift from the
 * array DOT_STATES orders. Hot loops compare STATE.walking instead of strings.
 */
export const STATE = {
  arriving: STATE_INDEX.arriving,
  tailgating: STATE_INDEX.tailgating,
  queued: STATE_INDEX.queued,
  walking: STATE_INDEX.walking,
  seated: STATE_INDEX.seated,
  sheltering: STATE_INDEX.sheltering,
  leaving: STATE_INDEX.leaving,
  gone: STATE_INDEX.gone,
} as const;

/**
 * All dot state in parallel typed arrays, laid out exactly like Snapshot.dots so
 * snapshot and restore are copies rather than conversions. 20,000 dots is
 * 20,000 * 18 bytes, small enough to clone per replay frame.
 */
export class DotStore {
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly state: Uint8Array;
  readonly typeIndex: Uint16Array;
  readonly targetPlace: Int32Array;

  readonly count: number;

  constructor(count: number) {
    this.count = count;
    this.x = new Float32Array(count);
    this.y = new Float32Array(count);
    this.state = new Uint8Array(count);
    this.typeIndex = new Uint16Array(count);
    this.targetPlace = new Int32Array(count).fill(-1);
  }

  setState(i: number, name: DotState): void {
    this.state[i] = STATE_INDEX[name];
  }

  stateOf(i: number): DotState {
    return DOT_STATES[this.state[i]!] ?? 'arriving';
  }

  toSnapshotDots(): Snapshot['dots'] {
    return {
      x: this.x.slice(),
      y: this.y.slice(),
      state: this.state.slice(),
      typeIndex: this.typeIndex.slice(),
      targetPlace: this.targetPlace.slice(),
    };
  }

  loadSnapshotDots(dots: Snapshot['dots']): void {
    this.x.set(dots.x);
    this.y.set(dots.y);
    this.state.set(dots.state);
    this.typeIndex.set(dots.typeIndex);
    this.targetPlace.set(dots.targetPlace);
  }
}
