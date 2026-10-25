import type { GateStat } from '../../engine/src/edits.ts';

/**
 * Classify gates from the samples the gates panel has actually seen.
 *
 * `GateStat` only carries a rolling-minute rate (`inPerMin`), not a lifetime
 * total, so this helper works over an observed history: the panel keeps the
 * last few hundred `{ t, gates }` samples and passes them in. Two consequences
 * the caller must live with:
 *
 * - "never admitted anyone" means "no non-zero `inPerMin` in any observed
 *   sample", not a true cumulative total for the run. History starts when the
 *   panel mounts and is reset on a rewind.
 * - The 120 s hold is measured between the first and last observed stalled
 *   sample. With frames every 15 sim seconds that is at most 15 s coarse.
 */

export type GateHealthClass = 'ok' | 'slow' | 'seized' | 'unused';

/** One observation of every gate at one sim second. */
export interface GateSample {
  t: number;
  gates: readonly GateStat[];
}

export interface GateHealth {
  /** Place index of the gate, as in `GateStat.place`. */
  place: number;
  health: GateHealthClass;
  /** Why, in words, for the panel: "0 in/min for 2.0 min with 990 waiting". */
  reason: string;
  /** Sim seconds the gate has been observed open, backed up and taking nobody. */
  stalledForS: number;
  /** Did any observed sample show a non-zero `inPerMin`? */
  admittedEver: boolean;
}

/** A queue at least this long counts as "people waiting". */
export const SEIZED_WAITING = 50;
/** How long a gate must hold at 0 in/min with a queue before it is seized. */
export const SEIZED_HOLD_S = 120;
/** Below this share of capacity, a gate with a queue is "slow" (not stopped). */
export const SLOW_CAPACITY_FRACTION = 0.25;
/** A gate needs at least this much observed time before "unused" is claimed. */
export const UNUSED_MIN_OBSERVED_S = 60;

const round = (v: number) => Math.round(v).toLocaleString('en-US');
const minutes = (s: number) => (s / 60).toFixed(1);

interface Tracked {
  /** First sim second this gate appeared in an observed sample. */
  firstT: number;
  admittedEver: boolean;
  /** Start of the current unbroken stalled run, or null if not stalled now. */
  stallStart: number | null;
}

/**
 * Classify every gate in `current`, using `history` (earlier samples) for the
 * hold and for "has admitted anyone". Pure: neither `history` nor `current` is
 * mutated.
 *
 * Rules, in order of precedence:
 * - closed: always `ok`, never seized or unused.
 * - seized: open, at least 50 waiting, and exactly 0 in/min for >= 120 sim s
 *   without a break. The queue says people want it; the rate says it is stuck.
 * - unused: open, no observed sample with in/min > 0, while at least one other
 *   gate has admitted someone, after >= 60 s of observation. This is the dead
 *   gate (Gate 8), including when nobody is queued at it at all.
 * - slow: open, at least 50 waiting, and in/min below 25 % of
 *   `capacityPerMin`, measured at the current sample only.
 * - ok: everything else.
 */
export function classifyGates(
  history: readonly GateSample[],
  current: GateSample | null | undefined,
): GateHealth[] {
  if (!current || current.gates.length === 0) return [];

  // Chronological and never later than the sample being judged. The panel
  // resets its buffer when a rewind takes t backwards; this filter also keeps a
  // stale future sample out during the render before that reset runs.
  const samples = [...history].filter((s) => s.t < current.t).sort((a, b) => a.t - b.t);
  samples.push(current);

  const tracked = new Map<number, Tracked>();
  for (const sample of samples) {
    for (const g of sample.gates) {
      let rec = tracked.get(g.place);
      if (!rec) {
        rec = { firstT: sample.t, admittedEver: false, stallStart: null };
        tracked.set(g.place, rec);
      }
      if (g.inPerMin > 0) rec.admittedEver = true;
      // Only an open gate can be stalled. Any sample that is not stalled —
      // closed, queue gone, someone through — ends the run, so a gate that
      // recovers has to serve its full hold again before it is flagged.
      const stalled = g.open && g.waiting >= SEIZED_WAITING && g.inPerMin === 0;
      if (stalled) {
        if (rec.stallStart === null) rec.stallStart = sample.t;
      } else {
        rec.stallStart = null;
      }
    }
  }

  return current.gates.map((g): GateHealth => {
    const rec = tracked.get(g.place) ?? { firstT: current.t, admittedEver: false, stallStart: null };
    const stalledForS = rec.stallStart === null ? 0 : Math.max(0, current.t - rec.stallStart);
    const observedForS = Math.max(0, current.t - rec.firstT);
    const othersAdmitted = current.gates.some(
      (o) => o.place !== g.place && tracked.get(o.place)?.admittedEver === true,
    );

    if (!g.open) {
      return { place: g.place, health: 'ok', reason: 'door closed', stalledForS, admittedEver: rec.admittedEver };
    }

    if (g.waiting >= SEIZED_WAITING && g.inPerMin === 0 && stalledForS >= SEIZED_HOLD_S) {
      return {
        place: g.place,
        health: 'seized',
        reason: `0 in/min for ${minutes(stalledForS)} min with ${round(g.waiting)} waiting`,
        stalledForS,
        admittedEver: rec.admittedEver,
      };
    }

    if (!rec.admittedEver && othersAdmitted && observedForS >= UNUSED_MIN_OBSERVED_S) {
      return {
        place: g.place,
        health: 'unused',
        reason: `no one through in ${minutes(observedForS)} min of observation while other gates were passing fans`,
        stalledForS,
        admittedEver: rec.admittedEver,
      };
    }

    if (
      g.waiting >= SEIZED_WAITING &&
      g.inPerMin > 0 &&
      g.capacityPerMin > 0 &&
      g.inPerMin < g.capacityPerMin * SLOW_CAPACITY_FRACTION
    ) {
      const share = Math.round((g.inPerMin / g.capacityPerMin) * 100);
      return {
        place: g.place,
        health: 'slow',
        reason: `${round(g.inPerMin)} in/min is ${share}% of ${round(g.capacityPerMin)}/min with ${round(g.waiting)} waiting`,
        stalledForS,
        admittedEver: rec.admittedEver,
      };
    }

    return {
      place: g.place,
      health: 'ok',
      reason: rec.admittedEver
        ? `${round(g.inPerMin)} of ${round(g.capacityPerMin)}/min`
        : 'no one through yet',
      stalledForS,
      admittedEver: rec.admittedEver,
    };
  });
}
