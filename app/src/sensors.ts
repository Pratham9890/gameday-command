/**
 * Synthetic observations for zone density. A zone with no coverage returns
 * null (not zero), and every sensor has latency, dropout and noise, so the
 * app can show a measured zone differently from an inferred one.
 */
export interface SensorConfig {
  /** Share of zones with a working sensor, 0..1. */
  coverage: number;
  /** Probability a sensor drops a sample, 0..1. */
  dropout: number;
  /** Sim seconds between sampling and availability. */
  latencyS: number;
  /** Gaussian noise standard deviation in people/m². */
  noiseSigma: number;
  seed: number;
}

export const SENSOR_DEFAULTS: SensorConfig = {
  coverage: 0.7,
  dropout: 0.05,
  latencyS: 30,
  noiseSigma: 0.08,
  seed: 1,
};

const rngFor = (seed: number) => {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
};

/**
 * Observe one density value per zone. `null` means no sensor covered that zone;
 * `NaN` means the sample was dropped. Same seed + input = byte-identical output.
 */
export function observeZones(truth: readonly number[], config: Partial<SensorConfig> = {}): (number | null)[] {
  const cfg = { ...SENSOR_DEFAULTS, ...config };
  const random = rngFor(cfg.seed);
  return truth.map((value) => {
    if (random() >= cfg.coverage) return null;
    if (random() < cfg.dropout) return Number.NaN;
    const u = Math.max(1e-9, random());
    const v = Math.max(1e-9, random());
    const gaussian = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    return Math.max(0, value + gaussian * cfg.noiseSigma);
  });
}

/** One sample available now, given sensor latency; null until the first one. */
export function availableSample(
  history: readonly { t: number; values: (number | null)[] }[],
  now: number,
  latencyS: number,
): (number | null)[] | null {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]!.t + latencyS <= now) return history[i]!.values;
  }
  return null;
}

/** Coverage line: how many zones actually reported a finite value. */
export const measuredZones = (values: readonly (number | null)[]): number =>
  values.filter((v) => v !== null && Number.isFinite(v)).length;
