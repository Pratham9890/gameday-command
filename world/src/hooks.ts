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
  game_end: 'exit_route',
  lightning_delay: 'lightning_shelter',
  gate_surge: 'gate_jammed',
  suspicious_package: 'street_closed',
  medical: 'heard_rumor',
  fight: 'heard_rumor',
};

/**
 * How often an officer on station repeats the commander's order to the fans
 * around them, in sim seconds. Officers are not a loudspeaker: they work the
 * crowd in front of them over and over.
 */
const OFFICER_REPEAT_S = 90;

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
export function createWorldHooks(incident: Incident, plan: ResponsePlan, gameEndAt?: SimSeconds): WorldRuntime {
  const exodusAt = incident.kind === 'game_end' ? incident.at : gameEndAt;
  const applied = new Set<number>();
  let incidentRaised = false;
  let exodusRaised = false;
  let committed = 0;
  const assigned = new Set<Id>();
  /** Officer id -> the cell they were sent to, so we know when they are on station. */
  const posts = new Map<Id, number>();
  /** The order officers pass on, set by whichever plan step spoke last. */
  let standingOrder: SituationId | null = null;
  let lastRepeat = -Infinity;

  function sendOfficers(count: number, toPlaceId: Id, world: WorldView, act: WorldActions): void {
    const target = world.map.places.find((p) => p.id === toPlaceId);
    const cell = target?.cells[0];
    if (cell === undefined) return;
    const free = world.officers.filter((o) => !assigned.has(o.id)).slice(0, count);
    for (const officer of free) {
      assigned.add(officer.id);
      posts.set(officer.id, cell);
      act.moveOfficer(officer.id, cell);
    }
    committed += free.length;
  }

  /** Cells within earshot of every officer who has reached the post they were sent to. */
  function officerReach(world: WorldView): number[] {
    const { width, height } = world.map;
    const cells = new Set<number>();
    for (const officer of world.officers) {
      const post = posts.get(officer.id);
      if (post === undefined || officer.cell !== post) continue; // still walking
      const cx = officer.cell % width;
      const cy = Math.floor(officer.cell / width);
      const r = officer.radiusCells;
      for (let y = Math.max(0, cy - r); y <= Math.min(height - 1, cy + r); y++) {
        for (let x = Math.max(0, cx - r); x <= Math.min(width - 1, cx + r); x++) {
          cells.add(y * width + x);
        }
      }
    }
    return [...cells];
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
        // Officers on station start passing the redirect on by hand.
        standingOrder = 'officer_instruction';
        return;
      case 'shelter_order':
        act.raiseSituation('lightning_shelter');
        standingOrder = 'lightning_shelter';
        return;
    }
  }

  return {
    onStep(t: SimSeconds, world: WorldView, act: WorldActions): void {
      // The game ends and the stands empty, whatever else is happening. The
      // suspicious package scenario is about a street closing into that exodus.
      if (exodusAt !== undefined && !exodusRaised && t >= exodusAt) {
        exodusRaised = true;
        act.raiseSituation('exit_route');
      }

      if (t < incident.at) return;

      if (!incidentRaised) {
        incidentRaised = true;
        // The whistle reaches the concourse too; the map-wide exodus already raised it.
        if (incident.kind !== 'game_end') act.raiseSituation(SITUATION_FOR_INCIDENT[incident.kind], incident.cells);
      }

      plan.actions.forEach((action, i) => {
        if (applied.has(i)) return;
        if (t < incident.at + action.at) return;
        applied.add(i);
        apply(action, world, act);
      });

      // An officer standing in the crowd is the commander's voice where the PA
      // does not reach. Until this existed, sending officers cost officer
      // minutes and changed nothing at all, so two plans that differed only in
      // how many officers they sent scored identically.
      //
      // With no plan order to pass on they still direct the crowd in front of
      // them (officer_instruction): at a jammed gate that spreads the queue to
      // the next gate. Before, an officer-only plan spoke once on arrival and
      // then stood there for the rest of the run.
      if (t - lastRepeat >= OFFICER_REPEAT_S) {
        const cells = officerReach(world);
        if (cells.length > 0) {
          lastRepeat = t;
          act.raiseSituation(standingOrder ?? 'officer_instruction', cells);
        }
      }
    },
    committedOfficers: () => committed,
  };
}
