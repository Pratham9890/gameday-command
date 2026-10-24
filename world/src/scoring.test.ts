import { describe, expect, it } from 'vitest';
import type { DensityGrid, Incident } from '../../contracts.ts';
import { Scorer } from './scoring.ts';

/** 2x2 grid so every number below can be counted by hand. */
function grid(values: number[], t = 0): DensityGrid {
  return { t, width: 2, height: 2, peoplePerM2: Float32Array.from(values) };
}

const incident: Incident = { id: 'i', kind: 'gate_surge', at: 0, cells: [0], safeCount: 0 };

describe('Scorer against a hand count', () => {
  it('counts danger minutes as cell-minutes over the threshold', () => {
    const scorer = new Scorer({
      runId: 'r',
      planId: 'p',
      label: 'A',
      incident,
      dangerDensity: 4,
      totalDots: 100,
    });

    // Two 30 second samples. Cells at 5.0 and 4.5 are over 4; 1.0 and 0 are not.
    scorer.observe({ t: 30, dt: 30, density: grid([5, 1, 4.5, 0], 30), dotsInZone: 10, officerInZone: false, officersCommitted: 3 });
    scorer.observe({ t: 60, dt: 30, density: grid([5, 1, 4.5, 0], 60), dotsInZone: 0, officerInZone: true, officersCommitted: 3 });

    scorer.noteDecision('kev');
    scorer.noteDecision('default');
    scorer.noteDecision('default');
    scorer.noteReached([1, 2]);

    const card = scorer.finish();

    // 2 cells over threshold x 0.5 min x 2 samples
    expect(card.dangerMinutes).toBeCloseTo(2, 6);
    expect(card.peakDensity).toBeCloseTo(5, 6);
    // 3 officers x 60 seconds total
    expect(card.officerMinutesUsed).toBeCloseTo(3, 6);
    // zone emptied at t=60, incident at t=0
    expect(card.timeToClearMin).toBeCloseTo(1, 6);
    expect(card.firstOfficerMin).toBeCloseTo(1, 6);
    // 100 dots, 2 reached, 5 fans per dot
    expect(card.fansNotReached).toBe(490);
    expect(card.fallbackDecisions).toBe(2);
  });

  it('leaves seated fans out of danger minutes and peak density', () => {
    const scorer = new Scorer({ runId: 'r', planId: 'p', label: 'A', incident, dangerDensity: 4, totalDots: 100 });
    // A full stand (5/m² everywhere) where only one cell's people are standing, at 4.5.
    scorer.observe({
      t: 60,
      dt: 60,
      density: grid([5, 5, 5, 5], 60),
      standingPerM2: Float32Array.from([0, 4.5, 0, 1.25]),
      dotsInZone: 0,
      officerInZone: false,
      officersCommitted: 0,
    });
    const card = scorer.finish();
    expect(card.dangerMinutes).toBeCloseTo(1, 6); // one standing cell over 4, for one minute
    expect(card.peakDensity).toBeCloseTo(4.5, 6);
  });

  it('counts danger only from the incident onward, when the plans start to differ', () => {
    const late: Incident = { ...incident, at: 120 };
    const scorer = new Scorer({ runId: 'r', planId: 'p', label: 'A', incident: late, dangerDensity: 4, totalDots: 100 });
    const packed = { density: grid([5, 5, 0, 0]), dotsInZone: 0, officerInZone: false, officersCommitted: 0 };
    scorer.observe({ ...packed, t: 60, dt: 60 }); // before the incident: ignored
    scorer.observe({ ...packed, t: 120, dt: 60, density: grid([4.5, 0, 0, 0]) });
    const card = scorer.finish();
    expect(card.dangerMinutes).toBeCloseTo(1, 6);
    expect(card.peakDensity).toBeCloseTo(4.5, 6);
  });

  it('reports null when the zone never clears', () => {
    const scorer = new Scorer({ runId: 'r', planId: 'p', label: 'B', incident, dangerDensity: 4, totalDots: 1 });
    scorer.observe({ t: 30, dt: 30, density: grid([1, 1, 1, 1], 30), dotsInZone: 4, officerInZone: false, officersCommitted: 0 });
    const card = scorer.finish();
    expect(card.timeToClearMin).toBeNull();
    expect(card.firstOfficerMin).toBeNull();
  });
});
