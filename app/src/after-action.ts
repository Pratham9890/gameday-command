import type { Scorecard } from '../../contracts.ts';
import type { PoliceOrder, SceneInfo } from '../../engine/src/edits.ts';
import { clockText } from './story.ts';

/**
 * Undo is an inverse order sent forward in time, never a rewind: the run keeps
 * everything that happened, and the log shows both the order and its undo.
 * Orders whose effect cannot be taken back (an alert already heard, the game
 * released, a report filed) have no inverse.
 */
export function inverseOrder(order: PoliceOrder, scene: SceneInfo | null): PoliceOrder | null {
  switch (order.type) {
    case 'dispatch':
    case 'respond':
    case 'patrol':
      return { type: 'recall', officerIds: order.officerIds };
    case 'gate':
      return { type: 'gate', closableId: order.closableId, closed: !order.closed };
    case 'barricade':
      return order.closed ? { ...order, closed: false } : { ...order, closed: true };
    case 'place_marker':
      return { type: 'remove_marker', id: order.marker.id };
    case 'add_officer': {
      // The added unit's id is assigned by the worker; find it by its name.
      const added = scene?.officers.find((officer) => officer.unit === order.unit);
      return added ? { type: 'remove_officer', officerId: added.id } : null;
    }
    case 'redirect':
      return { type: 'redirect', fromPlaceId: order.toPlaceId, toPlaceId: order.fromPlaceId };
    default:
      return null;
  }
}

/** The newest order in the log that can still be undone, with its inverse. */
export function lastUndoable(scene: SceneInfo | null): { t: number; order: PoliceOrder; inverse: PoliceOrder } | null {
  const orders = scene?.orders ?? [];
  for (let i = orders.length - 1; i >= 0; i--) {
    const entry = orders[i]!;
    const inverse = inverseOrder(entry.order, scene);
    if (inverse) return { t: entry.t, order: entry.order, inverse };
  }
  return null;
}

export interface TimelineEntry {
  t: number;
  clock: string;
  kind: 'order' | 'suggestion accepted' | 'suggestion dismissed' | 'officer report' | 'arrival';
  text: string;
}

/** Every order, suggestion decision, officer report and arrival, oldest first. */
export function timeline(
  scene: SceneInfo | null,
  describe: (order: PoliceOrder) => string,
  unitOf: (id: string) => string,
): TimelineEntry[] {
  if (!scene) return [];
  const entries: TimelineEntry[] = [];
  for (const { t, order } of scene.orders ?? []) {
    const kind: TimelineEntry['kind'] =
      order.type === 'respond' && order.suggestionAt !== undefined ? 'suggestion accepted'
        : order.type === 'dismiss_suggestion' ? 'suggestion dismissed'
          : order.type === 'officer_report' ? 'officer report'
            : 'order';
    entries.push({ t, clock: clockText(t), kind, text: describe(order) });
  }
  for (const arrival of scene.responseArrivals ?? []) {
    const from = arrival.suggestionAt ?? arrival.startedAt;
    entries.push({
      t: arrival.arrivedAt,
      clock: clockText(arrival.arrivedAt),
      kind: 'arrival',
      text: `${unitOf(arrival.officerId)} on scene, ${((arrival.arrivedAt - from) / 60).toFixed(1)} min after the ${arrival.suggestionAt !== undefined ? 'suggestion' : 'order'}.`,
    });
  }
  return entries.sort((a, b) => a.t - b.t);
}

const escape = (text: string) =>
  text.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);

/** A printable after-action report. Every number is from the run's scorecard or log. */
export function afterActionHtml(title: string, entries: TimelineEntry[], scorecard: Scorecard | null): string {
  const rows = entries
    .map((e) => `<tr><td>${escape(e.clock)}</td><td>${escape(e.kind)}</td><td>${escape(e.text)}</td></tr>`)
    .join('');
  const score = scorecard
    ? `<ul>
<li>Time to clear the zone: ${scorecard.timeToClearMin === null ? 'did not clear' : `${scorecard.timeToClearMin.toFixed(1)} min`}</li>
<li>Danger minutes: ${Math.round(scorecard.dangerMinutes).toLocaleString()}</li>
<li>Peak density: ${scorecard.peakDensity.toFixed(1)} people/m²</li>
<li>First officer on scene: ${scorecard.firstOfficerMin === null ? 'none' : `${scorecard.firstOfficerMin.toFixed(1)} min`}</li>
<li>Officer minutes used: ${Math.round(scorecard.officerMinutesUsed).toLocaleString()}</li>
</ul>`
    : '<p>The run has not finished, so there is no scorecard yet.</p>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escape(title)}</title>
<style>body{font:14px/1.45 system-ui,sans-serif;margin:32px;color:#111;background:#fff}table{border-collapse:collapse;width:100%}
td,th{border-bottom:1px solid #ccc;padding:6px 8px;text-align:left;vertical-align:top}th{font-weight:600}</style></head>
<body><h1>${escape(title)}</h1><p>Synthetic simulation run. Times are game clock.</p><h2>Scorecard</h2>${score}
<h2>Timeline</h2><table><thead><tr><th>Time</th><th>Kind</th><th>What happened</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
}
