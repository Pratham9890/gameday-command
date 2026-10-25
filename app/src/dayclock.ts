import type { SimSeconds } from '../../contracts.ts';

/** Game-day wall clock. Kickoff is 15:30, the day runs 05:00-21:00. */
export const KICKOFF_MIN = 15 * 60 + 30;
export const DAY_START_MIN = 5 * 60;
export const DAY_END_MIN = 21 * 60;

export type DayPhase = 'parking' | 'tailgate' | 'build-up' | 'kickoff' | 'game' | 'exodus' | 'closed';

/** Wall-clock minutes after midnight for a sim second relative to kickoff. */
export function wallMinutes(t: SimSeconds): number {
  return KICKOFF_MIN + t / 60;
}

export function wallClock(t: SimSeconds): string {
  const total = Math.round(wallMinutes(t));
  const h = Math.floor(total / 60) % 24;
  const m = ((total % 60) + 60) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function dayPhase(t: SimSeconds): DayPhase {
  const m = wallMinutes(t);
  if (m < DAY_START_MIN || m >= DAY_END_MIN) return 'closed';
  if (m < 10 * 60) return 'parking';
  if (m < 12 * 60) return 'tailgate';
  if (m < KICKOFF_MIN) return 'build-up';
  if (m < KICKOFF_MIN + 5) return 'kickoff';
  if (m < 18 * 60 + 30) return 'game';
  return 'exodus';
}

/** Sim second for a wall-clock time (HH:MM), clamped to the day. */
export function tForClock(hhmm: string): SimSeconds {
  const [h, m] = hhmm.split(':').map(Number);
  const minutes = Math.max(DAY_START_MIN, Math.min(DAY_END_MIN, (h ?? 0) * 60 + (m ?? 0)));
  return (minutes - KICKOFF_MIN) * 60;
}

export const DAY_PHASE_LABELS: Record<DayPhase, string> = {
  parking: 'Lots opening',
  tailgate: 'Tailgating',
  'build-up': 'Crowd build-up',
  kickoff: 'Kickoff',
  game: 'In play',
  exodus: 'Exodus',
  closed: 'Closed',
};
