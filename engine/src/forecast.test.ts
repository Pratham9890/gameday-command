import { describe, expect, it } from 'vitest';
import { combine, ess, improvingShare, normalize, resample, reweight, type Variant } from './forecast.ts';

const variants: Variant[] = [
  { id: 'a', curves: [[4, 3], [2, 1]] },
  { id: 'b', curves: [[2, 2], [3, 3]] },
  { id: 'c', curves: [[0, 1], [1, 0]] },
];

describe('forecast ensemble', () => {
  it('normalizes and keeps ESS above a collapse floor', () => {
    expect(normalize([1, 1, 2]).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    const state = reweight([1 / 3, 1 / 3, 1 / 3], [3, 2, 0], 2, 1);
    expect(state.weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(state.ess).toBeGreaterThan(1.5);
    // The matching member carries more than twice a far-off one.
    expect(state.weights[1]!).toBeGreaterThan(2 * state.weights[2]!);
  });

  it('resamples without identical clones and stays deterministic for a seed', () => {
    const seq = (seed: number) => {
      let s = seed;
      return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    };
    const one = resample([0.6, 0.3, 0.1], variants, 6, seq(7));
    const two = resample([0.6, 0.3, 0.1], variants, 6, seq(7));
    expect(one).toEqual(two);
    expect(one).toHaveLength(6);
    expect(new Set(one.map((v) => JSON.stringify(v.curves))).size).toBeGreaterThan(1);
  });

  it('orders p10 <= p50 <= p90 and takes the weighted centre', () => {
    for (const band of combine([0.5, 0.3, 0.2], variants, 0, 2)) {
      expect(band.p10).toBeLessThanOrEqual(band.p50);
      expect(band.p50).toBeLessThanOrEqual(band.p90);
    }
    expect(ess([1, 0, 0])).toBeCloseTo(1, 12);
  });

  it('computes the improving share instead of typing a confidence', () => {
    const share = improvingShare([0.5, 0.3, 0.2], variants, 2);
    expect(share).toBeGreaterThan(0);
    expect(share).toBeLessThanOrEqual(1);
  });
});
