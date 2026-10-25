import type { Id, IncidentKind, MapBundle, PlanAction, Place, ResponsePlan } from '../../contracts.ts';
import { expandCells, placesOfKind } from './incidents.ts';

const OFFICERS_AVAILABLE = 12;

/** The closable that covers a place's cells, e.g. a gate's door. */
function doorFor(map: MapBundle, place: Place): Id | undefined {
  return map.closables.find((c) => c.cells.some((cell) => place.cells.includes(cell)))?.id;
}

/** A closable that is not a door of any place, i.e. a street segment. Woody Hayes when mapped. */
function streetFor(map: MapBundle): Id | undefined {
  const doors = new Set(map.places.flatMap((p) => map.closables.filter((c) => c.cells.some((cell) => p.cells.includes(cell))).map((c) => c.id)));
  const streets = map.closables.filter((c) => !doors.has(c.id));
  return streets.find((c) => /Woody Hayes/i.test(c.name))?.id ?? streets[0]?.id;
}

/** Shelters if the map has them, otherwise concourses. Lightning needs somewhere indoors. */
function shelterIds(map: MapBundle): Id[] {
  const shelters = placesOfKind(map, 'shelter');
  const indoors = shelters.length > 0 ? shelters : placesOfKind(map, 'concourse');
  return indoors.map((p) => p.id);
}

const compact = (actions: (PlanAction | null)[]): PlanAction[] => actions.filter((a): a is PlanAction => a !== null);

function gateSurgePlans(map: MapBundle): ResponsePlan[] {
  const gates = placesOfKind(map, 'gate');
  const hot = gates[0];
  const relief = gates[1] ?? gates[0];
  if (!hot || !relief) return [];
  const hotDoor = doorFor(map, hot);
  const reliefDoor = doorFor(map, relief);
  return [
    {
      id: 'plan-surge-officers',
      name: `Six officers to ${hot.name}`,
      forIncident: 'gate_surge',
      officersAvailable: OFFICERS_AVAILABLE,
      actions: [{ at: 0, type: 'send_officers', count: 6, toPlaceId: hot.id }],
    },
    {
      id: 'plan-surge-open-relief',
      name: `Open ${relief.name}, PA redirect`,
      forIncident: 'gate_surge',
      officersAvailable: OFFICERS_AVAILABLE,
      actions: compact([
        // The zone is the crowd on the approach: a PA aimed at the three cells
        // of the doorway itself reaches almost nobody.
        { at: 0, type: 'alert', channel: 'pa', message: `${hot.name} is backed up. Use ${relief.name}.`, reachShare: 0.7, zoneCells: expandCells(map, hot.cells, 8) },
        reliefDoor ? { at: 30, type: 'open', closableId: reliefDoor } : null,
        { at: 60, type: 'redirect', fromPlaceId: hot.id, toPlaceId: relief.id },
        { at: 0, type: 'send_officers', count: 2, toPlaceId: relief.id },
      ]),
    },
    {
      id: 'plan-surge-close-hot',
      name: `Close ${hot.name}, phone alert, four officers`,
      forIncident: 'gate_surge',
      officersAvailable: OFFICERS_AVAILABLE,
      actions: compact([
        hotDoor ? { at: 0, type: 'close', closableId: hotDoor } : null,
        { at: 0, type: 'alert', channel: 'phone', message: `${hot.name} closed. Walk to ${relief.name}.`, reachShare: 0.5 },
        { at: 30, type: 'redirect', fromPlaceId: hot.id, toPlaceId: relief.id },
        { at: 0, type: 'send_officers', count: 4, toPlaceId: hot.id },
      ]),
    },
  ];
}

function lightningPlans(map: MapBundle): ResponsePlan[] {
  const shelters = shelterIds(map);
  const gates = placesOfKind(map, 'gate');
  const gateDoors = gates.map((g) => doorFor(map, g)).filter((d): d is Id => !!d);
  const firstIndoor = shelters[0];
  void firstIndoor;
  return [
    {
      id: 'plan-lightning-shelter-now',
      name: 'Shelter order now, PA everywhere',
      forIncident: 'lightning_delay',
      officersAvailable: OFFICERS_AVAILABLE,
      actions: compact([
        { at: 0, type: 'alert', channel: 'pa', message: 'Lightning in the area. Move to shelter now.', reachShare: 0.9 },
        shelters.length ? { at: 0, type: 'shelter_order', shelterPlaceIds: shelters } : null,
      ]),
    },
    {
      // The crowd still outside is the one in the open. Posting officers on the
      // gates sends them in; posting officers on the concourse only talks to
      // people who are already under cover, which made this plan score the
      // same as simply calling the shelter order.
      id: 'plan-lightning-open-gates',
      name: 'Open every gate, officers on the gates, wave them inside',
      forIncident: 'lightning_delay',
      officersAvailable: OFFICERS_AVAILABLE,
      actions: compact([
        { at: 0, type: 'alert', channel: 'pa', message: 'Lightning delay. Every gate is open, get inside now.', reachShare: 0.9 },
        ...gateDoors.map((id): PlanAction => ({ at: 0, type: 'open', closableId: id })),
        shelters.length ? { at: 0, type: 'shelter_order', shelterPlaceIds: shelters } : null,
        ...gates.slice(0, 4).map((g): PlanAction => ({ at: 0, type: 'send_officers', count: 2, toPlaceId: g.id })),
      ]),
    },
    {
      id: 'plan-lightning-staged',
      name: 'Phone alert first, shelter order at two minutes',
      forIncident: 'lightning_delay',
      officersAvailable: OFFICERS_AVAILABLE,
      actions: compact([
        { at: 0, type: 'alert', channel: 'phone', message: 'Lightning possible. Stand by for instructions.', reachShare: 0.6 },
        shelters.length ? { at: 120, type: 'shelter_order', shelterPlaceIds: shelters } : null,
        firstIndoor ? { at: 120, type: 'send_officers', count: 4, toPlaceId: firstIndoor } : null,
      ]),
    },
  ];
}

function packagePlans(map: MapBundle): ResponsePlan[] {
  const street = streetFor(map);
  const exits = placesOfKind(map, 'exit');
  const fallbackExits = exits.length > 0 ? exits : placesOfKind(map, 'gate');
  const from = fallbackExits[0];
  const to = fallbackExits[1] ?? fallbackExits[0];
  return [
    {
      id: 'plan-package-close-hard',
      name: 'Close the street, eight officers, redirect the exit',
      forIncident: 'suspicious_package',
      officersAvailable: OFFICERS_AVAILABLE,
      actions: compact([
        street ? { at: 0, type: 'close', closableId: street } : null,
        from ? { at: 0, type: 'send_officers', count: 8, toPlaceId: from.id } : null,
        from && to ? { at: 0, type: 'redirect', fromPlaceId: from.id, toPlaceId: to.id } : null,
      ]),
    },
    {
      id: 'plan-package-close-pa',
      name: 'Close the street, PA alert only',
      forIncident: 'suspicious_package',
      officersAvailable: OFFICERS_AVAILABLE,
      actions: compact([
        street ? { at: 0, type: 'close', closableId: street } : null,
        { at: 30, type: 'alert', channel: 'pa', message: 'Police activity ahead. Follow the marked route out.', reachShare: 0.8 },
      ]),
    },
    {
      id: 'plan-package-staged',
      name: 'Close the street, phone alert, redirect, four officers',
      forIncident: 'suspicious_package',
      officersAvailable: OFFICERS_AVAILABLE,
      actions: compact([
        street ? { at: 0, type: 'close', closableId: street } : null,
        { at: 0, type: 'alert', channel: 'phone', message: 'Avoid the closed street. Use the far exit.', reachShare: 0.55 },
        from && to ? { at: 60, type: 'redirect', fromPlaceId: from.id, toPlaceId: to.id } : null,
        from ? { at: 0, type: 'send_officers', count: 4, toPlaceId: from.id } : null,
      ]),
    },
  ];
}

/** Three editable starting plans per incident, built from whatever places the map actually has. */
export function playbookFor(kind: IncidentKind, map: MapBundle): ResponsePlan[] {
  switch (kind) {
    case 'gate_surge':
      return gateSurgePlans(map);
    case 'lightning_delay':
      return lightningPlans(map);
    case 'suspicious_package':
      return packagePlans(map);
    default:
      return [];
  }
}
