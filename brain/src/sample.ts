import type { Odds } from '../../contracts.ts';

/**
 * Pick an option from odds using one seeded random number in [0,1).
 *
 * Keys are sorted first: the engine must land on the same option for the same
 * seed no matter what order the server, the cache, or a replayed tape happened
 * to serialise them in.
 */
export function sampleOdds(odds: Odds, r: number): string {
  const keys = Object.keys(odds).sort();
  if (keys.length === 0) throw new Error('cannot sample from empty odds');
  let acc = 0;
  for (const key of keys) {
    acc += odds[key] ?? 0;
    if (r < acc) return key;
  }
  return keys[keys.length - 1]!;
}

/** True when odds are usable: known option keys only, finite, and summing to 1. */
export function oddsAreValid(odds: Odds, optionKeys: readonly string[], tolerance = 0.001): boolean {
  const allowed = new Set(optionKeys);
  let sum = 0;
  for (const [key, value] of Object.entries(odds)) {
    if (!allowed.has(key)) return false;
    if (!Number.isFinite(value) || value < 0) return false;
    sum += value;
  }
  return Math.abs(sum - 1) <= tolerance;
}
