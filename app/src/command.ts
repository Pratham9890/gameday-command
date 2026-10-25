import type { Id, IncidentKind, MapBundle, PlanAction, ResponsePlan, Scorecard, VehicleFrame } from '../../contracts.ts';
import { CELL_SIZE_M, VEHICLE_STATES } from '../../contracts.ts';
import type { GateStat } from '../../engine/src/edits.ts';

/**
 * The commander's brief: how busy each gate and street is right now (low,
 * medium or high, against history when there is some), what could be done
 * about it, and which plan comes out ahead for the priority the commander
 * picks. Pure functions, tested under Node.
 *
 * The tool ranks and suggests; it does not decide. A suggested plan is three
 * editable plans for the commander to run, and "best" is always "best for the
 * priority you chose".
 */

export type Level = 'low' | 'medium' | 'high';

/** How a reading came about, so the brief can say where its number is from. */
export interface Reading {
  id: Id;
  name: string;
  kind: 'gate' | 'street';
  value: number;
  /** The usual value at this minute from past runs, when there is history. */
  usual: number | null;
  level: Level;
  open?: boolean;
}

/** Absolute thresholds, used when there is no history yet. */
export const GATE_LEVELS = { medium: 300, high: 1000 }; // people waiting
export const STREET_LEVELS = { medium: 3, high: 10 }; // vehicles stopped
/** Against history: under 0.75x usual is low, over 1.3x is high. */
export const RATIO_LOW = 0.75;
export const RATIO_HIGH = 1.3;

export function levelOf(value: number, usual: number | null, floor: { medium: number; high: number }): Level {
  // Too small to matter is low, however it compares with a quiet history.
  if (value < floor.medium / 3) return 'low';
  if (usual !== null && usual > 0) {
    const ratio = value / usual;
    if (ratio > RATIO_HIGH && value >= floor.medium) return 'high';
    if (ratio < RATIO_LOW) return 'low';
    return value >= floor.high ? 'high' : 'medium';
  }
  return value >= floor.high ? 'high' : value >= floor.medium ? 'medium' : 'low';
}

/** One past sample: a gate's queue or a street's stopped vehicles at a minute to kickoff. */
export interface HistorySample {
  subject: Id;
  kind: 'gate_waiting' | 'street_stopped';
  minute: number;
  mean: number;
  n: number;
}

/** The usual value for a subject at this minute: the nearest minute within five, if any. */
export function usualAt(history: HistorySample[], kind: HistorySample['kind'], subject: Id, minute: number): number | null {
  let best: HistorySample | null = null;
  for (const h of history) {
    if (h.kind !== kind || h.subject !== subject || Math.abs(h.minute - minute) > 5) continue;
    if (!best || Math.abs(h.minute - minute) < Math.abs(best.minute - minute)) best = h;
  }
  return best ? best.mean : null;
}

const STOPPED = VEHICLE_STATES.indexOf('stopped');

/** Which named street each cell belongs to, for counting stopped vehicles on it. */
export function streetIndex(map: MapBundle): { cells: Int16Array; streets: { id: Id; name: string }[] } {
  const streets = map.closables.filter((c) => !c.id.endsWith('-door')).map((c) => ({ id: c.id, name: c.name }));
  const cells = new Int16Array(map.width * map.height).fill(-1);
  streets.forEach((s, i) => {
    for (const c of map.closables.find((x) => x.id === s.id)!.cells) cells[c] = i;
  });
  return { cells, streets };
}

export function stoppedPerStreet(map: MapBundle, index: ReturnType<typeof streetIndex>, v: VehicleFrame | undefined): number[] {
  const out = index.streets.map(() => 0);
  if (!v) return out;
  for (let i = 0; i < v.x.length; i++) {
    if (v.state[i] !== STOPPED || v.x[i]! < 0) continue;
    const c = Math.floor(v.y[i]! / CELL_SIZE_M) * map.width + Math.floor(v.x[i]! / CELL_SIZE_M);
    const s = index.cells[c] ?? -1;
    if (s >= 0) out[s]!++;
  }
  return out;
}

/** Every gate and street, levelled, worst first. */
export function readings(
  map: MapBundle,
  gates: GateStat[],
  stopped: number[],
  index: ReturnType<typeof streetIndex>,
  history: HistorySample[],
  minute: number,
): Reading[] {
  const out: Reading[] = [];
  for (const g of gates) {
    const place = map.places[g.place];
    if (!place) continue;
    const usual = usualAt(history, 'gate_waiting', place.id, minute);
    out.push({ id: place.id, name: place.name, kind: 'gate', value: g.waiting, usual, level: levelOf(g.waiting, usual, GATE_LEVELS), open: g.open });
  }
  index.streets.forEach((s, i) => {
    const value = stopped[i] ?? 0;
    const usual = usualAt(history, 'street_stopped', s.id, minute);
    out.push({ id: s.id, name: s.name, kind: 'street', value, usual, level: levelOf(value, usual, STREET_LEVELS) });
  });
  const rank: Record<Level, number> = { high: 2, medium: 1, low: 0 };
  return out.sort((a, b) => rank[b.level] - rank[a.level] || b.value - a.value);
}

const n = (v: number) => Math.round(v).toLocaleString();

/** One line per busy place, in words that can be read over the radio. */
export function briefLine(r: Reading): string {
  const vs = r.usual !== null && r.usual > 0 ? `, ${(r.value / r.usual).toFixed(1)}× usual for this time` : '';
  if (r.kind === 'gate') {
    if (r.open === false) return `${r.name} CLOSED, ${n(r.value)} still waiting${vs}.`;
    return `${r.name} ${r.level.toUpperCase()}: ${n(r.value)} waiting${vs}.`;
  }
  return `${r.name} ${r.level.toUpperCase()}: ${n(r.value)} vehicles stopped${vs}.`;
}

// ─── suggested plans ───

const OFFICERS = 12;

function gateCentre(map: MapBundle, id: Id): { x: number; y: number } | null {
  const place = map.places.find((p) => p.id === id);
  if (!place || place.cells.length === 0) return null;
  let x = 0;
  let y = 0;
  for (const c of place.cells) {
    x += c % map.width;
    y += (c / map.width) | 0;
  }
  return { x: x / place.cells.length, y: y / place.cells.length };
}

/** The closest open gate that is not busy, to send a crowd to. */
function reliefGate(map: MapBundle, from: Id, all: Reading[]): Reading | null {
  const here = gateCentre(map, from);
  if (!here) return null;
  let best: Reading | null = null;
  let bestScore = Infinity;
  for (const r of all) {
    if (r.kind !== 'gate' || r.id === from || r.open === false) continue;
    const c = gateCentre(map, r.id);
    if (!c) continue;
    // Distance, plus a heavy penalty for already being busy.
    const score = Math.hypot(c.x - here.x, c.y - here.y) + (r.level === 'high' ? 400 : r.level === 'medium' ? 120 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return best;
}

/**
 * Three plans built from the conditions right now, for the three slots. They
 * cover the moves a commander reaches for: redirect the crowd to a quieter
 * gate, shut the worst gate and move its queue, or put officers on it and
 * close a street the crowd has spilled into. Every one is editable.
 */
export function suggestPlans(map: MapBundle, kind: IncidentKind, now: Reading[], fallbackGate?: Id): ResponsePlan[] {
  const gates = now.filter((r) => r.kind === 'gate');
  const hot = gates.find((r) => r.level === 'high') ?? gates.find((r) => r.level === 'medium') ?? gates.find((r) => r.id === fallbackGate) ?? gates[0];
  const jammed = now.find((r) => r.kind === 'street' && r.level !== 'low');
  const door = (id: Id) => map.closables.find((c) => c.id === `${id}-door`)?.id;
  if (!hot) return [];
  const relief = reliefGate(map, hot.id, now);
  const shelter = map.places.filter((p) => p.kind === 'shelter' || p.kind === 'concourse').map((p) => p.id);
  const tag = (s: string) => `suggested-${s}`;
  const plans: ResponsePlan[] = [];
  const with_ = (actions: (PlanAction | null)[]) => actions.filter((a): a is PlanAction => a !== null);

  plans.push({
    id: tag('redirect'),
    name: relief ? `Redirect ${hot.name} to ${relief.name}, PA` : `PA at ${hot.name}`,
    forIncident: kind,
    officersAvailable: OFFICERS,
    actions: with_([
      { at: 0, type: 'alert', channel: 'pa', message: relief ? `${hot.name} is full. Use ${relief.name}.` : 'Follow officers’ directions.', reachShare: 0.7 },
      relief ? { at: 30, type: 'redirect', fromPlaceId: hot.id, toPlaceId: relief.id } : null,
      relief ? { at: 0, type: 'send_officers', count: 2, toPlaceId: relief.id } : null,
      kind === 'lightning_delay' ? { at: 0, type: 'shelter_order', shelterPlaceIds: shelter } : null,
    ]),
  });

  const hotDoor = door(hot.id);
  plans.push({
    id: tag('close'),
    name: relief ? `Close ${hot.name}, send its queue to ${relief.name}` : `Close ${hot.name}`,
    forIncident: kind,
    officersAvailable: OFFICERS,
    actions: with_([
      hotDoor ? { at: 0, type: 'close', closableId: hotDoor } : null,
      relief ? { at: 0, type: 'redirect', fromPlaceId: hot.id, toPlaceId: relief.id } : null,
      { at: 0, type: 'alert', channel: 'phone', message: relief ? `${hot.name} is closed. Use ${relief.name}.` : `${hot.name} is closed.`, reachShare: 0.5 },
      { at: 0, type: 'send_officers', count: 4, toPlaceId: hot.id },
    ]),
  });

  plans.push({
    id: tag('officers'),
    name: jammed ? `Six officers to ${hot.name}, close ${jammed.name}` : `Six officers to ${hot.name}`,
    forIncident: kind,
    officersAvailable: OFFICERS,
    actions: with_([
      { at: 0, type: 'send_officers', count: 6, toPlaceId: hot.id },
      jammed ? { at: 60, type: 'close', closableId: jammed.id } : null,
      kind === 'lightning_delay' ? { at: 0, type: 'shelter_order', shelterPlaceIds: shelter } : null,
    ]),
  });
  return plans;
}

// ─── the commander's priority ───

export type Priority = 'clear' | 'danger' | 'officers' | 'ambulance';

export const PRIORITIES: { id: Priority; label: string; why: (c: Scorecard) => string }[] = [
  { id: 'clear', label: 'Clear the zone fastest', why: (c) => (c.timeToClearMin === null ? 'never cleared' : `cleared in ${c.timeToClearMin.toFixed(1)} min`) },
  { id: 'danger', label: 'Least crush risk', why: (c) => `${Math.round(c.dangerMinutes).toLocaleString()} danger minutes` },
  { id: 'officers', label: 'Fewest officers', why: (c) => `${Math.round(c.officerMinutesUsed).toLocaleString()} officer minutes` },
  { id: 'ambulance', label: 'Keep the ambulance route open', why: (c) => (c.emergencyResponseMin == null ? 'ambulance never got there' : `ambulance on scene in ${c.emergencyResponseMin.toFixed(1)} min`) },
];

const metric: Record<Priority, (c: Scorecard) => number> = {
  clear: (c) => c.timeToClearMin ?? Number.POSITIVE_INFINITY,
  danger: (c) => c.dangerMinutes,
  officers: (c) => c.officerMinutesUsed,
  ambulance: (c) => c.emergencyResponseMin ?? Number.POSITIVE_INFINITY,
};

/** True when no finished plan achieves the priority at all (none cleared, no ambulance got there). */
export function noneAchieve(cards: (Scorecard | null)[], priority: Priority): boolean {
  return cards.every((c) => !c || !Number.isFinite(metric[priority](c)));
}

/** Plan indexes, best first for this priority; ties broken by crush risk, then speed. */
export function rankByPriority(cards: (Scorecard | null)[], priority: Priority): number[] {
  const m = metric[priority];
  const key = (c: Scorecard | null) => (c ? m(c) : Number.POSITIVE_INFINITY);
  return cards
    .map((_, i) => i)
    .sort((a, b) => {
      const ka = key(cards[a]!);
      const kb = key(cards[b]!);
      if (ka !== kb) return ka < kb ? -1 : 1;
      const da = cards[a]?.dangerMinutes ?? Infinity;
      const db = cards[b]?.dangerMinutes ?? Infinity;
      if (da !== db) return da - db;
      return (cards[a]?.timeToClearMin ?? Infinity) - (cards[b]?.timeToClearMin ?? Infinity);
    });
}
