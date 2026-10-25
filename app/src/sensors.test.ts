import { describe, expect, it } from 'vitest';
import { availableSample, measuredZones, observeZones } from './sensors.ts';

describe('synthetic sensor model', () => {
  it('returns no observation when nothing is covered', () => {
    const out = observeZones([1, 2, 3], { coverage: 0, dropout: 0, noiseSigma: 0, seed: 4 });
    expect(out).toEqual([null, null, null]);
    expect(measuredZones(out)).toBe(0);
  });

  it('is byte-identical for the same seed and input', () => {
    const a = observeZones([1, 2, 3], { coverage: 1, dropout: 0, noiseSigma: 0.1, seed: 9 });
    const b = observeZones([1, 2, 3], { coverage: 1, dropout: 0, noiseSigma: 0.1, seed: 9 });
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('drops samples and reports coverage only for finite values', () => {
    const out = observeZones([1, 1, 1, 1], { coverage: 1, dropout: 1, noiseSigma: 0, seed: 2 });
    expect(out.every((v) => Number.isNaN(v))).toBe(true);
    expect(measuredZones(out)).toBe(0);
  });

  it('holds a sample until its latency has passed', () => {
    const history = [{ t: 0, values: [1] }];
    expect(availableSample(history, 10, 30)).toBeNull();
    expect(availableSample(history, 30, 30)).toEqual([1]);
  });
});
