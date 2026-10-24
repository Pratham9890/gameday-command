import type { SimSeconds } from '../../contracts.ts';

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

export type EditIn = { type: 'edit'; edit: DotEdit } | { type: 'inspect'; dot: number };

export type EditOut =
  | { type: 'inspect'; info: DotInfo }
  /** Every dot's fan type, sent at start and whenever an edit changes one. */
  | { type: 'types'; typeIndex: Uint16Array };
