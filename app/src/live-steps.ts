import type { MapBundle, PlanAction } from '../../contracts.ts';
import { DOT_GROUP_SIZE } from '../../contracts.ts';
import type { OfficerStatus, SceneInfo } from '../../engine/src/edits.ts';

const n = (v: number) => v.toLocaleString();

/**
 * What a plan step is doing right now, in a few words, once it has fired:
 * officers walking in and how many have arrived, how many fans an alert
 * reached, a door actually shut. A tick on its own said a step had happened
 * but never showed six officers on their way to a gate.
 */
export function stepStatus(
  action: PlanAction,
  firedAt: number,
  t: number,
  scene: SceneInfo | null,
  alerts: readonly { t: number; dots: Int32Array }[],
  map: MapBundle,
): string | null {
  if (t < firedAt) return null;
  switch (action.type) {
    case 'send_officers': {
      const place = map.places.findIndex((p) => p.id === action.toPlaceId);
      const sent = scene?.officers.filter((o) => o.place === place) ?? [];
      if (sent.length === 0) return null;
      const onScene = sent.filter((o) => o.state === 'on_scene');
      const enRoute = sent.filter((o) => o.state === 'en_route');
      const helped = sent.reduce((sum, o) => sum + o.told, 0);
      if (enRoute.length > 0) {
        const eta = Math.max(...enRoute.map((o) => o.etaS ?? 0));
        return `${onScene.length} of ${sent.length} on scene, ${enRoute.length} on the way, about ${Math.max(1, Math.round(eta / 60))} min`;
      }
      return `all ${sent.length} on scene${helped > 0 ? `, ${n(helped)} fans directed` : ''}`;
    }
    case 'alert': {
      const sent = alerts.find((a) => a.t >= firedAt);
      // "so far": this is what the alert has actually touched, not the share
      // the plan aimed at (see describeAction in PlanEditor.tsx).
      return sent ? `reached ${n(sent.dots.length * DOT_GROUP_SIZE)} fans so far` : 'going out…';
    }
    case 'close':
      return scene?.closed.includes(action.closableId) ? 'shut' : null;
    case 'open':
      return scene && !scene.closed.includes(action.closableId) ? 'open' : null;
    default:
      return null;
  }
}

/** One line on what an officer is doing, for the officer panel. */
export function officerLine(o: OfficerStatus, map: MapBundle): string {
  if (o.state === 'patrolling') return `On ${o.patrol?.name ?? 'outdoor patrol'}, waypoint ${(o.patrol?.index ?? 0)+1}`;
  const where = o.place >= 0 ? map.places[o.place]?.name ?? 'their post' : 'their post';
  if (o.state === 'en_route') return `On the way to ${where}${o.etaS !== null ? `, about ${Math.max(1, Math.round(o.etaS / 60))} min out` : ''}`;
  if (o.state === 'on_scene') return `On scene at ${where}, directing the crowd`;
  return 'Standing by at their police post';
}
