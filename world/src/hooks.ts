import type {
  Id,
  Incident,
  IncidentKind,
  ResponsePlan,
  SimSeconds,
  SituationId,
  WorldActions,
  WorldHooks,
  WorldView,
} from '../../contracts.ts';

/** What an incident makes dots ask themselves the moment it fires. */
const SITUATION_FOR_INCIDENT: Record<IncidentKind, SituationId> = {
  lightning_delay: 'lightning_shelter',
  gate_surge: 'gate_jammed',
  suspicious_package: 'street_closed',
  medical: 'heard_rumor',
  fight: 'heard_rumor',
};

export interface WorldRuntime extends WorldHooks {
  /** Officers the plan has committed so far, for officer minutes on the scorecard. */
  committedOfficers(): number;
}

/**
 * Turns an incident plus a plan into the one object the engine steps.
 *
 * Plan action times are relative to Incident.at, per the contract, so every
 * comparison run sees its plan at the same offset from the same moment.
 */
export function createWorldHooks(incident: Incident, plan: ResponsePlan): WorldRuntime {
  const applied = new Set<number>();
  let incidentRaised = false;
  let committed = 0;
  const assigned = new Set<Id>();

  function sendOfficers(count: number, toPlaceId: Id, world: WorldView, act: WorldActions): void {
    const target = world.map.places.find((p) => p.id === toPlaceId);
    const cell = target?.cells[0];
    if (cell === undefined) return;
    const free = world.officers.filter((o) => !assigned.has(o.id)).slice(0, count);
    for (const officer of free) {
      assigned.add(officer.id);
      act.moveOfficer(officer.id, cell);
    }
    committed += free.length;
  }

  function apply(action: ResponsePlan['actions'][number], world: WorldView, act: WorldActions): void {
    switch (action.type) {
      case 'close':
        act.setClosed(action.closableId, true);
        return;
      case 'open':
        act.setClosed(action.closableId, false);
        return;
      case 'send_officers':
        sendOfficers(action.count, action.toPlaceId, world, act);
        return;
      case 'hold_officers':
        // Holding means leaving them where they are; they still count as committed.
        committed += action.officerIds.length;
        return;
      case 'alert':
        act.raiseSituation('alert_received', action.zoneCells, action.reachShare);
        return;
      case 'redirect':
        act.setTarget(action.fromPlaceId, action.toPlaceId);
        return;
      case 'shelter_order':
        act.raiseSituation('lightning_shelter');
        return;
    }
  }

  return {
    onStep(t: SimSeconds, world: WorldView, act: WorldActions): void {
      if (t < incident.at) return;

      if (!incidentRaised) {
        incidentRaised = true;
        act.raiseSituation(SITUATION_FOR_INCIDENT[incident.kind], incident.cells);
      }

      plan.actions.forEach((action, i) => {
        if (applied.has(i)) return;
        if (t < incident.at + action.at) return;
        applied.add(i);
        apply(action, world, act);
      });
    },
    committedOfficers: () => committed,
  };
}
