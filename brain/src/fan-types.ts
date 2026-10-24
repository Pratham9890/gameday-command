import type { FanType, Population } from '../../contracts.ts';
import { DOT_GROUP_SIZE } from '../../contracts.ts';

/**
 * Fan mix around Ohio Stadium. Shares are an assumption, not a forecast, and the
 * app labels them that way on screen. Traits drive how a type leans when Kev is
 * answering, and how patiently it holds a jammed line.
 */
export const FAN_TYPES: FanType[] = [
  { id: 'student-section', label: 'Student section', share: 0.22, walkSpeedMps: 1.45, groupSize: 6, arrivalWindowMin: [75, 5], traits: { patience: 0.35, compliance: 0.5, mobility: 0.95 } },
  { id: 'alumni-family', label: 'Alumni family', share: 0.18, walkSpeedMps: 1.1, groupSize: 4, arrivalWindowMin: [120, 30], traits: { patience: 0.7, compliance: 0.8, mobility: 0.7 } },
  { id: 'season-regular', label: 'Season ticket regular', share: 0.17, walkSpeedMps: 1.25, groupSize: 2, arrivalWindowMin: [110, 25], traits: { patience: 0.75, compliance: 0.85, mobility: 0.85 } },
  { id: 'tailgater', label: 'Tailgater', share: 0.14, walkSpeedMps: 1.2, groupSize: 8, arrivalWindowMin: [240, 0], traits: { patience: 0.45, compliance: 0.55, mobility: 0.8 } },
  { id: 'away-fan', label: 'Away fan', share: 0.09, walkSpeedMps: 1.3, groupSize: 3, arrivalWindowMin: [90, 20], traits: { patience: 0.5, compliance: 0.65, mobility: 0.85 } },
  { id: 'family-kids', label: 'Family with young kids', share: 0.08, walkSpeedMps: 0.85, groupSize: 5, arrivalWindowMin: [100, 35], traits: { patience: 0.6, compliance: 0.9, mobility: 0.45 } },
  { id: 'mobility-limited', label: 'Mobility limited', share: 0.05, walkSpeedMps: 0.6, groupSize: 2, arrivalWindowMin: [120, 40], traits: { patience: 0.8, compliance: 0.9, mobility: 0.25 } },
  { id: 'staff-vendor', label: 'Staff and vendors', share: 0.07, walkSpeedMps: 1.35, groupSize: 1, arrivalWindowMin: [240, 60], traits: { patience: 0.9, compliance: 0.95, mobility: 0.9 } },
];

export function makePopulation(totalFans: number, seed: number): Population {
  return {
    seed,
    totalFans,
    dots: Math.floor(totalFans / DOT_GROUP_SIZE),
    types: FAN_TYPES,
  };
}
