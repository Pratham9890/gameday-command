import type { MapBundle, PlanAction } from '../../contracts.ts';

/**
 * Building plan steps from dropdowns: what a commander can choose for each kind
 * of step, and the step it turns into. No React here, so it is tested under Node.
 */

export type StepKind = 'close' | 'open' | 'send_officers' | 'redirect' | 'alert' | 'shelter_order';

export const STEP_KINDS: { kind: StepKind; label: string }[] = [
  { kind: 'close', label: 'Close a gate or street' },
  { kind: 'open', label: 'Open a gate or street' },
  { kind: 'send_officers', label: 'Send officers to…' },
  { kind: 'redirect', label: 'Redirect fans from one gate to another' },
  { kind: 'alert', label: 'PA or phone alert' },
  { kind: 'shelter_order', label: 'Order everyone to shelter' },
];

export interface Choice {
  id: string;
  label: string;
}

export interface StepChoices {
  closables: Choice[];
  gates: Choice[];
  places: Choice[];
  shelters: Choice[];
}

/** What every dropdown offers on this map: gates first, then streets, then the named places. */
export function stepChoices(map: MapBundle): StepChoices {
  const gates = map.places.filter((p) => p.kind === 'gate').map((p) => ({ id: p.id, label: p.name }));
  const doors = map.closables.filter((c) => c.id.endsWith('-door')).map((c) => ({ id: c.id, label: c.name.replace(/ door$/, '') }));
  const streets = map.closables
    .filter((c) => !c.id.endsWith('-door'))
    .map((c) => ({ id: c.id, label: c.name }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const named = map.places
    .filter((p) => p.kind !== 'gate' && !(p.kind === 'parking' && /^Lot \d+$/.test(p.name)) && p.id !== 'lots')
    .map((p) => ({ id: p.id, label: p.name }));
  const shelters = map.places.filter((p) => p.kind === 'shelter' || p.kind === 'concourse').map((p) => ({ id: p.id, label: p.name }));
  return { closables: [...doors, ...streets], gates, places: [...gates, ...named], shelters };
}

export interface StepDraft {
  kind: StepKind;
  /** Minutes after the incident. */
  atMin: number;
  target?: string;
  from?: string;
  to?: string;
  count?: number;
  channel?: 'pa' | 'phone';
  reachPct?: number;
  message?: string;
}

/** The step a draft describes, or null while a required choice is still empty. */
export function buildStep(draft: StepDraft, choices: StepChoices): PlanAction | null {
  const at = Math.max(0, Math.round(draft.atMin * 60));
  switch (draft.kind) {
    case 'close':
    case 'open':
      if (!draft.target || !choices.closables.some((c) => c.id === draft.target)) return null;
      return { at, type: draft.kind, closableId: draft.target };
    case 'send_officers': {
      const count = Math.round(draft.count ?? 0);
      if (!draft.target || count <= 0 || !choices.places.some((p) => p.id === draft.target)) return null;
      return { at, type: 'send_officers', count, toPlaceId: draft.target };
    }
    case 'redirect':
      if (!draft.from || !draft.to || draft.from === draft.to) return null;
      if (!choices.gates.some((g) => g.id === draft.from) || !choices.places.some((p) => p.id === draft.to)) return null;
      return { at, type: 'redirect', fromPlaceId: draft.from, toPlaceId: draft.to };
    case 'alert': {
      const reachShare = Math.min(1, Math.max(0, (draft.reachPct ?? 60) / 100));
      if (reachShare === 0) return null;
      return { at, type: 'alert', channel: draft.channel ?? 'pa', message: draft.message?.trim() || 'Follow the directions of officers.', reachShare };
    }
    case 'shelter_order':
      return { at, type: 'shelter_order', shelterPlaceIds: choices.shelters.map((s) => s.id) };
  }
}
