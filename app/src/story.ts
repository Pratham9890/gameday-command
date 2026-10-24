import type { Incident, Scorecard } from '../../contracts.ts';
import { CELL_SIZE_M } from '../../contracts.ts';
import { INCIDENT_LABELS } from '../../world/src/incidents.ts';

/**
 * The words the commander screen uses. Kept apart from React so the phrasing
 * and the ranking can be tested: a judge reads these, not the scorecard fields.
 */

const mins = (seconds: number) => Math.abs(Math.round(seconds / 60));

export function clockText(t: number): string {
  const m = mins(t);
  if (m === 0) return 'Kickoff';
  return t < 0 ? `${m} min to kickoff` : `${m} min after kickoff`;
}

/** Where the run is relative to the incident, in one short line. */
export function incidentStatus(incident: Incident, t: number): { text: string; phase: 'before' | 'during' } {
  const name = INCIDENT_LABELS[incident.kind];
  const until = incident.at - t;
  if (until > 30) return { text: `${name} starts in ${Math.max(1, mins(until))} min`, phase: 'before' };
  if (until > 0) return { text: `${name} starts now`, phase: 'before' };
  return { text: `${name}, ${mins(t - incident.at)} min in`, phase: 'during' };
}

/** What the screen can say about a run while it is still going. */
export interface LiveStats {
  /** People inside the incident zone right now. */
  zonePeople: number;
  /** People standing anywhere packed tighter than the danger line. */
  dangerPeople: number;
  /** The most packed 2 m square right now, people per m². */
  peak: number;
}

/**
 * `skip` marks cells left out of "dangerously packed": fans sitting shoulder to
 * shoulder in the stands are at the density cap by design, and counting them
 * made every plan read the same 44,000 people in danger.
 */
export function liveStats(
  peoplePerM2: Float32Array | undefined,
  zone: number[] | undefined,
  danger: number,
  skip?: Uint8Array,
): LiveStats {
  if (!peoplePerM2) return { zonePeople: 0, dangerPeople: 0, peak: 0 };
  const area = CELL_SIZE_M * CELL_SIZE_M;
  let zonePeople = 0;
  for (const cell of zone ?? []) zonePeople += (peoplePerM2[cell] ?? 0) * area;
  let dangerPeople = 0;
  let peak = 0;
  for (let i = 0; i < peoplePerM2.length; i++) {
    const rho = peoplePerM2[i]!;
    if (skip?.[i]) continue;
    if (rho > peak) peak = rho;
    if (rho >= danger) dangerPeople += rho * area;
  }
  return { zonePeople: Math.round(zonePeople), dangerPeople: Math.round(dangerPeople), peak };
}

/**
 * Best plan first. Clearing the danger zone sooner wins; a plan that never
 * clears loses to one that does. Ties go to less time spent dangerously packed.
 */
export function rankPlans(cards: (Scorecard | null)[]): number[] {
  const clear = (c: Scorecard | null) => c?.timeToClearMin ?? Number.POSITIVE_INFINITY;
  return cards
    .map((_, i) => i)
    .sort((a, b) => {
      const byClear = clear(cards[a]!) - clear(cards[b]!);
      if (byClear !== 0 && Number.isFinite(byClear)) return byClear;
      if (clear(cards[a]!) !== clear(cards[b]!)) return clear(cards[a]!) === Number.POSITIVE_INFINITY ? 1 : -1;
      return (cards[a]?.dangerMinutes ?? 0) - (cards[b]?.dangerMinutes ?? 0);
    });
}

export const clearText = (card: Scorecard) =>
  card.timeToClearMin === null ? 'never cleared' : `${card.timeToClearMin.toFixed(1)} min`;

/** One sentence a judge can read out loud. */
export function verdictText(labels: readonly string[], names: string[], cards: Scorecard[], zoneName: string): string {
  const order = rankPlans(cards);
  const best = order[0]!;
  const card = cards[best]!;
  if (card.timeToClearMin === null) {
    return `No plan cleared the crowd at ${zoneName} in time. Plan ${labels[best]} (${names[best]}) kept it least dangerous.`;
  }
  const others = order
    .slice(1)
    .map((i) => `${labels[i]} ${clearText(cards[i]!)}`)
    .join(', ');
  return `Plan ${labels[best]} (${names[best]}) cleared the crowd at ${zoneName} fastest, in ${clearText(card)}. Others: ${others}.`;
}
