import { describe, expect, it } from 'vitest';
import { DAY_PHASE_LABELS, dayPhase, tForClock, wallClock, wallMinutes } from './dayclock.ts';

describe('game-day clock', () => {
  it('puts kickoff at 15:30 and sim t = 0', () => {
    expect(wallClock(0)).toBe('15:30');
    expect(wallMinutes(0)).toBe(930);
    expect(tForClock('15:30')).toBe(0);
    expect(dayPhase(0)).toBe('kickoff');
  });

  it('maps the day 05:00-21:00', () => {
    expect(tForClock('05:00')).toBe((300 - 930) * 60);
    expect(wallClock(-6 * 3600)).toBe('09:30');
    expect(dayPhase(-6 * 3600)).toBe('parking');
    expect(dayPhase(-5 * 3600)).toBe('tailgate');
    expect(dayPhase(-2 * 3600)).toBe('build-up');
    expect(dayPhase(3.5 * 3600)).toBe('exodus');
    expect(dayPhase(6 * 3600)).toBe('closed');
  });

  it('formats every phase', () => {
    for (const label of Object.values(DAY_PHASE_LABELS)) expect(label.length).toBeGreaterThan(0);
  });
});
