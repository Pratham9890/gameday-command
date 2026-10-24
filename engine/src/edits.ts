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
}

export type EditIn = { type: 'edit'; edit: DotEdit } | { type: 'inspect'; dot: number };

export type EditOut =
  | { type: 'inspect'; info: DotInfo }
  /** Every dot's fan type, sent at start and whenever an edit changes one. */
  | { type: 'types'; typeIndex: Uint16Array }
  /** Sent with every frame. */
  | { type: 'scene'; scene: SceneInfo };
