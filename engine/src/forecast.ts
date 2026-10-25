/**
 * Ensemble forecast primitives. The simulation still produces the truth; this
 * module only weighs a set of forward variants and combines their zone curves.
 * It is deliberately pure so a forecast is reproducible from a seed + weights.
 */

export interface Variant {
  id: string;
  /** One value per zone per step, variants x zones x steps. */
  curves: number[][];
}

export interface ZoneBand {
  zone: number;
  p10: number;
  p50: number;
  p90: number;
}

export interface EnsembleState {
  weights: number[];
  ess: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function normalize(weights: readonly number[]): number[] {
  const sum = weights.reduce((a, b) => a + Math.max(0, b), 0);
  if (sum <= 0) return weights.map(() => 1 / Math.max(1, weights.length));
  return weights.map((w) => Math.max(0, w) / sum);
}

export function ess(weights: readonly number[]): number {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return 0;
  const sq = weights.reduce((a, b) => a + b * b, 0);
  return (sum * sum) / sq;
}

/**
 * Reweight by how close each variant's first-step value is to an observation.
 * A Gaussian likelihood keeps the matching variant ahead without ever zeroing
 * a far one, so the ensemble cannot collapse on one member.
 */
export function reweight(
  weights: readonly number[],
  predicted: readonly number[],
  observed: number,
  sigma = 1.0,
): EnsembleState {
  const s = Math.max(1e-6, sigma);
  const next = weights.map((w, i) => {
    const d = (predicted[i] ?? 0) - observed;
    return Math.max(0, w) * Math.exp(-(d * d) / (2 * s * s));
  });
  const normalized = normalize(next);
  return { weights: normalized, ess: ess(normalized) };
}

/** Systematic resampling with jitter, so survivors are not identical clones. */
export function resample(
  weights: readonly number[],
  variants: readonly Variant[],
  count: number,
  rng: () => number,
): Variant[] {
  const w = normalize(weights);
  const step = 1 / Math.max(1, count);
  let at = rng() * step;
  const out: Variant[] = [];
  let cumulative = 0;
  let index = 0;
  for (let k = 0; k < count; k++) {
    while (at > cumulative && index < w.length - 1) {
      index++;
      cumulative += w[index]!;
    }
    const source = variants[index]!;
    const jitter = (rng() - 0.5) * 0.02;
    out.push({
      id: `${source.id}#${k}`,
      curves: source.curves.map((zone) => zone.map((v) => v * (1 + jitter))),
    });
    at += step;
  }
  return out;
}

/** Weighted p10/p50/p90 per zone at one step. */
export function combine(
  weights: readonly number[],
  variants: readonly Variant[],
  step: number,
  zones: number,
): ZoneBand[] {
  const w = normalize(weights);
  const bands: ZoneBand[] = [];
  for (let zone = 0; zone < zones; zone++) {
    const pairs = variants
      .map((v, i) => ({ v: v.curves[zone]?.[step] ?? 0, w: w[i] ?? 0 }))
      .sort((a, b) => a.v - b.v);
    const total = pairs.reduce((a, b) => a + b.w, 0) || 1;
    const quantile = (q: number) => {
      let acc = 0;
      for (const pair of pairs) {
        acc += pair.w;
        if (acc / total >= q) return pair.v;
      }
      return pairs[pairs.length - 1]?.v ?? 0;
    };
    const p10 = quantile(0.1);
    const p50 = quantile(0.5);
    const p90 = quantile(0.9);
    bands.push({ zone, p10: clamp(p10, 0, Infinity), p50: clamp(p50, 0, Infinity), p90: clamp(p90, 0, Infinity) });
  }
  return bands;
}

/** The ensemble's improving share, for a confidence line that is not typed. */
export function improvingShare(weights: readonly number[], variants: readonly Variant[], zones: number): number {
  const w = normalize(weights);
  let improving = 0;
  for (let i = 0; i < variants.length; i++) {
    const curve = variants[i]!.curves;
    let falls = 0;
    for (let z = 0; z < zones; z++) {
      const first = curve[z]?.[0] ?? 0;
      const last = curve[z]?.[curve[z]!.length - 1] ?? first;
      if (last <= first) falls++;
    }
    if (falls === zones) improving += w[i]!;
  }
  return improving;
}
