import type { Id, SimSeconds } from '../../contracts.ts';

/**
 * Commander edits to individual fans, and the extra worker messages that carry
 * them. Deliberately NOT in contracts.ts: that file is frozen, and these never
 * cross a lane boundary — only the app and the engine's own worker speak them.
 */
export interface DotEdit {
  /** Sim second the edit takes effect. All three plans get the same one. */
  at: SimSeconds;
  dots: number[];
  /** New index into Population.types. */
  fanType?: number;
  /** Place index to head for instead. */
  sendTo?: number;
}

/** What the inspector shows about one dot, beyond what a TickFrame carries. */
export interface DotInfo {
  dot: number;
  t: SimSeconds;
  x: number;
  y: number;
  state: number;
  typeIndex: number;
  targetPlace: number;
  homeGate: number;
  seatCell: number;
  admitted: boolean;
  arriveAt: SimSeconds;
  edits: number;
}

/** One officer, as the app draws and explains them. */
export interface OfficerStatus {
  id: Id;
  unit: string;
  cell: number;
  /** Meters, like dot positions. */
  x: number;
  y: number;
  /** Waiting at their post, walking to where a plan sent them, or there. */
  state: 'standby' | 'en_route' | 'on_scene';
  targetCell: number;
  /** Place index they were sent to, or -1. */
  place: number;
  homeCell: number;
  /** People spoken to, and how many of those did as told. */
  told: number;
  followed: number;
  /** Seconds to their post along the route, while en route. */
  etaS: number | null;
}

/** One gate's door and flow, for the gates panel and the map labels. */
export interface GateStat {
  place: number;
  open: boolean;
  /** People through the turnstile, and out through the gate, over the last minute. */
  inPerMin: number;
  outPerMin: number;
  /** People standing in its queue, not yet through. */
  waiting: number;
  /** What it can pass per minute right now: 0 when shut, more with officers on it. */
  capacityPerMin: number;
  officers: number;
}

/** What the close-up needs to make a plan visible, beyond a TickFrame. */
export interface SceneInfo {
  t: SimSeconds;
  officers: OfficerStatus[];
  gates: GateStat[];
  /** Closable ids shut right now: gate doors and streets. */
  closed: Id[];
  /** Alerts that went out since the last scene, with the dots each reached. */
  alerts: { t: SimSeconds; dots: Int32Array }[];
  /** Road barricades the commander put up live, beyond the map's own closables. Their ids appear in `closed` while up. */
  barricades?: Barricade[];
  /** Live police orders this run has carried out, oldest first. */
  orders?: { t: SimSeconds; order: PoliceOrder }[];
}

/** A road barricade placed live: a stretch of road cells that closes like any closable. */
export interface Barricade {
  id: Id;
  name: string;
  cells: number[];
}

/**
 * A live order from the commander to one plan's run (the plan on the map), on
 * top of that plan's own steps. Not in contracts.ts: only the app and the
 * engine's own worker speak these.
 */
export type PoliceOrder =
  /** Send officers to a cell (a gate, a street, or any spot). */
  | { type: 'dispatch'; officerIds: Id[]; toCell: number }
  /** Send officers back to their police post. */
  | { type: 'recall'; officerIds: Id[] }
  /** Shut or reopen a gate door, by its closable id. */
  | { type: 'gate'; closableId: Id; closed: boolean }
  /** Put up or take down a road barricade: a map closable by id, or a new stretch of road (cells given). */
  | { type: 'barricade'; closableId: Id; closed: boolean; name?: string; cells?: number[] }
  /** Officers and the crowd heading for one place are sent to another. */
  | { type: 'redirect'; fromPlaceId: Id; toPlaceId: Id }
  /** A PA or phone alert with the commander's own words. */
  | { type: 'alert'; channel: 'pa' | 'phone'; message: string; reachShare: number; zoneCells?: number[] }
  /** End the game now: everyone heads for the exits. */
  | { type: 'release' };

export type EditIn = { type: 'edit'; edit: DotEdit } | { type: 'inspect'; dot: number } | { type: 'order'; order: PoliceOrder };

export type EditOut =
  | { type: 'inspect'; info: DotInfo }
  /** Every dot's fan type, sent at start and whenever an edit changes one. */
  | { type: 'types'; typeIndex: Uint16Array }
  /** Sent with every frame. */
  | { type: 'scene'; scene: SceneInfo };
