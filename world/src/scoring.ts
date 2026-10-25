import type { DensityGrid, Id, Incident, Scorecard, SimSeconds } from '../../contracts.ts';
import { DOT_GROUP_SIZE } from '../../contracts.ts';

export interface ScoreSample {
  t: SimSeconds;
  dt: SimSeconds;
  density: DensityGrid;
  /**
   * People per m² leaving out fans in their seats, laid out like `density`.
   * Danger minutes and peak density read this when it is given: seated fans
   * fill the stands at the density cap by design, and counting them made every
   * plan score ~175,000 danger minutes and 5.0/m² alike.
   */
  standingPerM2?: Float32Array;
  /**
   * Live cells in ascending order, with `occupiedCount` giving the prefix
   * length. When both are given, peak and danger only visit those cells:
   * empty cells can never exceed the threshold, so the sums are the same.
   */
  occupied?: Int32Array;
  occupiedCount?: number;
  /** Dots (not people) still inside the incident zone. */
  dotsInZone: number;
  /** True once at least one officer stands inside the incident zone. */
  officerInZone: boolean;
  /** Officers currently committed by the plan, for officer minutes. */
  officersCommitted: number;
  /** Present when the run has vehicles. */
  traffic?: { stopped: number; out: number; emergencyDispatched: boolean; emergencyOnScene: boolean };
}

export interface ScorerInit {
  runId: Id;
  planId: Id;
  label: 'A' | 'B' | 'C';
  incident: Incident;
  dangerDensity: number;
  totalDots: number;
}

/** Cells within this many 2 m cells of the incident count as near-incident. */
const NEAR_INCIDENT_CELLS = 15;

/**
 * Accumulates the scorecard as the run steps. Deliberately a plain accumulator:
 * same samples in, same scorecard out, so a replay from a DecisionTape scores
 * identically to the live run.
 */
export interface ScorerState {
  peakDensity: number;
  dangerCellMinutes: number;
  officerSeconds: number;
  clearedAt: SimSeconds | null;
  firstOfficerAt: SimSeconds | null;
  everOccupied: boolean;
  fallbacks: number;
  reachedDots: number[];
  hasTraffic?: boolean;
  vehicleStoppedSeconds?: number;
  peakVehiclesStopped?: number;
  vehiclesOut?: number;
  emergencyDispatched?: boolean;
  emergencyAt?: SimSeconds | null;
}

export class Scorer {
  private peakDensity = 0;
  private dangerCellMinutes = 0;
  private officerSeconds = 0;
  private clearedAt: SimSeconds | null = null;
  private everOccupied = false;
  private firstOfficerAt: SimSeconds | null = null;
  private fallbacks = 0;
  private reachedDots: Set<number> = new Set<number>();
  private hasTraffic = false;
  private vehicleStoppedSeconds = 0;
  private peakVehiclesStopped = 0;
  private vehiclesOut = 0;
  private emergencyDispatched = false;
  private emergencyAt: SimSeconds | null = null;
  private nearMask: Uint8Array | null = null;
  private nearMaskSize = 0;

  private readonly init: ScorerInit;

  constructor(init: ScorerInit) {
    this.init = init;
  }

  /**
   * Mark cells within NEAR_INCIDENT_CELLS of the incident. Danger there counts
   * twice: a plan that shoves the crush just outside the zone has not solved it,
   * while spillover far away still counts once so it cannot hide.
   */
  private ensureNearMask(width: number, height: number): void {
    const size = width * height;
    if (this.nearMask && this.nearMaskSize === size) return;
    const mask = new Uint8Array(size);
    const cells = this.init.incident.cells ?? [];
    for (let k = 0; k < cells.length; k++) {
      const cell = cells[k]!;
      const cx = cell % width;
      const cy = (cell / width) | 0;
      for (let dy = -NEAR_INCIDENT_CELLS; dy <= NEAR_INCIDENT_CELLS; dy++) {
        for (let dx = -NEAR_INCIDENT_CELLS; dx <= NEAR_INCIDENT_CELLS; dx++) {
          if (Math.hypot(dx, dy) > NEAR_INCIDENT_CELLS) continue;
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || y < 0 || x >= width || y >= height) continue;
          mask[y * width + x] = 1;
        }
      }
    }
    this.nearMask = mask;
    this.nearMaskSize = size;
  }

  observe(s: ScoreSample): void {
    // Danger and peak are counted from the incident onward, like time to clear.
    // Before it, no plan has done anything yet, so every plan has the identical
    // crowd: about a thousand cells of gate queues at the cap through the hour
    // before kickoff. Counting that buried the difference the plans made under
    // ~128,000 danger minutes they all shared.
    if (s.t >= this.init.incident.at) {
      const peoplePerM2 = s.standingPerM2 ?? s.density.peoplePerM2;
      const threshold = this.init.dangerDensity;
      this.ensureNearMask(s.density.width, s.density.height);
      let dangerCellMinutes = 0;
      const occupied = s.occupied;
      const occupiedCount = s.occupiedCount;
      if (occupied !== undefined && occupiedCount !== undefined) {
        for (let k = 0; k < occupiedCount; k++) {
          const i = occupied[k]!;
          const v = peoplePerM2[i]!;
          if (v > this.peakDensity) this.peakDensity = v;
          if (v > threshold) dangerCellMinutes += this.nearMask?.[i] ? 2 : 1;
        }
      } else {
        for (let i = 0; i < peoplePerM2.length; i++) {
          const v = peoplePerM2[i]!;
          if (v > this.peakDensity) this.peakDensity = v;
          if (v > threshold) dangerCellMinutes += this.nearMask?.[i] ? 2 : 1;
        }
      }
      this.dangerCellMinutes += (dangerCellMinutes * s.dt) / 60;
    }
    this.officerSeconds += s.officersCommitted * s.dt;

    if (this.firstOfficerAt === null && s.officerInZone) this.firstOfficerAt = s.t;

    if (s.traffic) {
      this.hasTraffic = true;
      this.vehicleStoppedSeconds += s.traffic.stopped * s.dt;
      if (s.traffic.stopped > this.peakVehiclesStopped) this.peakVehiclesStopped = s.traffic.stopped;
      this.vehiclesOut = s.traffic.out;
      if (s.traffic.emergencyDispatched) this.emergencyDispatched = true;
      if (this.emergencyAt === null && s.traffic.emergencyOnScene) this.emergencyAt = s.t;
    }

    // Time to clear only means something once there was a crowd to clear, and
    // only from the incident onwards. The zone is busy long before kickoff as
    // fans arrive, and counting that ebb and flow meant the zone "cleared"
    // during the build-up; the negative time then clamped to zero and every
    // plan scored 0.0 minutes alike.
    if (s.t >= this.init.incident.at) {
      const safeCount = this.init.incident.safeCount ?? 0;
      const people = s.dotsInZone * DOT_GROUP_SIZE;
      if (people > safeCount) this.everOccupied = true;
      else if (this.everOccupied && this.clearedAt === null) this.clearedAt = s.t;
    }
  }

  /** Called once per decision answer the run consumed. */
  noteDecision(source: 'kev' | 'cache' | 'default'): void {
    if (source === 'default') this.fallbacks++;
  }

  /** Dots an alert actually reached. Anyone never in this set counts as not reached. */
  noteReached(dotIds: Iterable<number>): void {
    for (const id of dotIds) this.reachedDots.add(id);
  }

  /** Everything the accumulator has gathered, for rewinding a run. */
  capture(): ScorerState {
    return {
      peakDensity: this.peakDensity,
      dangerCellMinutes: this.dangerCellMinutes,
      officerSeconds: this.officerSeconds,
      clearedAt: this.clearedAt,
      firstOfficerAt: this.firstOfficerAt,
      everOccupied: this.everOccupied,
      fallbacks: this.fallbacks,
      reachedDots: [...this.reachedDots],
      hasTraffic: this.hasTraffic,
      vehicleStoppedSeconds: this.vehicleStoppedSeconds,
      peakVehiclesStopped: this.peakVehiclesStopped,
      vehiclesOut: this.vehiclesOut,
      emergencyDispatched: this.emergencyDispatched,
      emergencyAt: this.emergencyAt,
    };
  }

  restore(state: ScorerState): void {
    this.peakDensity = state.peakDensity;
    this.dangerCellMinutes = state.dangerCellMinutes;
    this.officerSeconds = state.officerSeconds;
    this.clearedAt = state.clearedAt;
    this.firstOfficerAt = state.firstOfficerAt;
    this.everOccupied = state.everOccupied;
    this.fallbacks = state.fallbacks;
    this.reachedDots = new Set(state.reachedDots);
    this.hasTraffic = state.hasTraffic ?? false;
    this.vehicleStoppedSeconds = state.vehicleStoppedSeconds ?? 0;
    this.peakVehiclesStopped = state.peakVehiclesStopped ?? 0;
    this.vehiclesOut = state.vehiclesOut ?? 0;
    this.emergencyDispatched = state.emergencyDispatched ?? false;
    this.emergencyAt = state.emergencyAt ?? null;
  }

  finish(): Scorecard {
    const sinceIncident = (t: SimSeconds | null) =>
      t === null ? null : Math.max(0, (t - this.init.incident.at) / 60);
    const card: Scorecard = {
      runId: this.init.runId,
      planId: this.init.planId,
      label: this.init.label,
      timeToClearMin: sinceIncident(this.clearedAt),
      peakDensity: this.peakDensity,
      dangerMinutes: this.dangerCellMinutes,
      firstOfficerMin: sinceIncident(this.firstOfficerAt),
      officerMinutesUsed: this.officerSeconds / 60,
      fansNotReached: (this.init.totalDots - this.reachedDots.size) * DOT_GROUP_SIZE,
      fallbackDecisions: this.fallbacks,
    };
    if (this.hasTraffic) {
      card.vehicleDelayMin = this.vehicleStoppedSeconds / 60;
      card.peakVehiclesStopped = this.peakVehiclesStopped;
      card.vehiclesOut = this.vehiclesOut;
      if (this.emergencyDispatched) card.emergencyResponseMin = sinceIncident(this.emergencyAt);
    }
    return card;
  }
}
