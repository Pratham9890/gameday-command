import type { DensityGrid, Id, Incident, Scorecard, SimSeconds } from '../../contracts.ts';
import { DOT_GROUP_SIZE } from '../../contracts.ts';

export interface ScoreSample {
  t: SimSeconds;
  dt: SimSeconds;
  density: DensityGrid;
  /** Dots (not people) still inside the incident zone. */
  dotsInZone: number;
  /** True once at least one officer stands inside the incident zone. */
  officerInZone: boolean;
  /** Officers currently committed by the plan, for officer minutes. */
  officersCommitted: number;
}

export interface ScorerInit {
  runId: Id;
  planId: Id;
  label: 'A' | 'B' | 'C';
  incident: Incident;
  dangerDensity: number;
  totalDots: number;
}

/**
 * Accumulates the scorecard as the run steps. Deliberately a plain accumulator:
 * same samples in, same scorecard out, so a replay from a DecisionTape scores
 * identically to the live run.
 */
export class Scorer {
  private peakDensity = 0;
  private dangerCellMinutes = 0;
  private officerSeconds = 0;
  private clearedAt: SimSeconds | null = null;
  private everOccupied = false;
  private firstOfficerAt: SimSeconds | null = null;
  private fallbacks = 0;
  private reachedDots = new Set<number>();

  private readonly init: ScorerInit;

  constructor(init: ScorerInit) {
    this.init = init;
  }

  observe(s: ScoreSample): void {
    const { peoplePerM2 } = s.density;
    const threshold = this.init.dangerDensity;
    let overCells = 0;
    for (let i = 0; i < peoplePerM2.length; i++) {
      const v = peoplePerM2[i]!;
      if (v > this.peakDensity) this.peakDensity = v;
      if (v > threshold) overCells++;
    }
    this.dangerCellMinutes += (overCells * s.dt) / 60;
    this.officerSeconds += s.officersCommitted * s.dt;

    if (this.firstOfficerAt === null && s.officerInZone) this.firstOfficerAt = s.t;

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

  finish(): Scorecard {
    const sinceIncident = (t: SimSeconds | null) =>
      t === null ? null : Math.max(0, (t - this.init.incident.at) / 60);
    return {
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
  }
}
