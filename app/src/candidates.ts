import type { MapBundle, ResponsePlan } from '../../contracts.ts';
import { playbookFor } from '../../world/src/playbook.ts';
import { interventionSteps } from './interventions.ts';

export interface CandidateContext {
  map: MapBundle;
  incidentKind: ResponsePlan['forIncident'];
  /** How many candidate plans to aim for (clamped to what the map supports). */
  target?: number;
}

/**
 * Build a deterministic, unique candidate set from the map's real places.
 * Every plan is a concrete `ResponsePlan`; no plan is generated from a random
 * score or an unbacked number.
 */
export function candidatePlans(ctx: CandidateContext): ResponsePlan[] {
  const { map, incidentKind } = ctx;
  const target = Math.max(20, Math.min(60, ctx.target ?? 32));
  const streets = map.closables.filter((c) => c.id.startsWith('street-'));
  const gates = map.places.filter((p) => p.kind === 'gate');
  const lots = map.places.filter((p) => p.kind === 'parking' && p.id !== 'lots');
  const shelters = map.places.filter((p) => p.kind === 'shelter' || p.kind === 'concourse');
  const base = playbookFor(incidentKind, map);
  const out: ResponsePlan[] = [];
  const seen = new Set<string>();

  const add = (id: string, name: string, actions: ResponsePlan['actions']) => {
    if (actions.length === 0) return;
    const key = JSON.stringify(actions);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ id, name, forIncident: incidentKind, officersAvailable: 12, actions });
  };

  // Baseline playbook plans are always candidates: the commander needs the
  // starting options, not only machine-built combinations.
  for (const plan of base) add(plan.id, plan.name, plan.actions);
  if (streets.length > 0 && gates.length > 0) {
    const street = streets.find((s) => /Woody Hayes/i.test(s.name)) ?? streets[0]!;
    const gate = gates[0]!;
    add('cand-close-road', `Close ${street.name}`, interventionSteps('close-road', { streetId: street.id }));
    add(
      'cand-close-road-officers',
      `Close ${street.name} and post officers at ${gate.name}`,
      [
        ...interventionSteps('close-road', { streetId: street.id }),
        ...interventionSteps('post-officers', { gateId: gate.id, count: 4 }),
      ],
    );
  }
  for (let i = 0; i < gates.length && out.length < target; i++) {
    const gate = gates[i]!;
    add(`cand-gate-${i}`, `Open ${gate.name} and alert`, [
      ...interventionSteps('open-gate', { gateId: gate.id }),
      ...interventionSteps('alert-pa', { message: `Use ${gate.name}.`, reachShare: 0.7 }),
    ]);
    add(`cand-lane-${i}`, `Officers on ${gate.name}`, interventionSteps('lane-control', { gateId: gate.id, count: 4 }));
  }
  if (shelters.length > 0) {
    add('cand-shelter', 'Order shelter', interventionSteps('shelter', { shelterIds: shelters.map((s) => s.id) }));
  }
  for (let i = 0; i < lots.length && out.length < target; i++) {
    const from = lots[i]!;
    const to = lots[(i + 1) % lots.length]!;
    if (from.id === to.id) continue;
    add(`cand-lot-${i}`, `Divert ${from.name} to ${to.name}`, interventionSteps('divert-lot', { fromLotId: from.id, toLotId: to.id }));
  }

  // Fill to the target with the remaining single-gate presets, in map order.
  for (let i = 0; i < gates.length && out.length < target; i++) {
    const gate = gates[i]!;
    add(`cand-close-${i}`, `Close ${gate.name}`, interventionSteps('close-gate', { gateId: gate.id, at: 60 }));
  }
  return out.slice(0, target);
}
