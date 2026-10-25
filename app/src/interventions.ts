import type { Id, PlanAction } from '../../contracts.ts';

/**
 * The six intervention families the commander can add, compiled to the frozen
 * plan contract. Nothing here invents a field: gate throughput edits and a
 * true pedestrianized street are documented as contract-v3 gaps instead.
 */
export type InterventionKind =
  | 'close-road'
  | 'open-road'
  | 'post-officers'
  | 'hold-officers'
  | 'close-gate'
  | 'open-gate'
  | 'lane-control'
  | 'divert-lot'
  | 'alert-pa'
  | 'alert-phone'
  | 'shelter';

export interface InterventionContext {
  /** Seconds after the incident. */
  at?: number;
  streetId?: Id;
  gateId?: Id;
  fromLotId?: Id;
  toLotId?: Id;
  shelterIds?: Id[];
  officerIds?: Id[];
  count?: number;
  message?: string;
  reachShare?: number;
}

const requireId = (id: Id | undefined, what: string): Id => {
  if (!id) throw new Error(`${what} is required for this intervention`);
  return id;
};

/** Compile one preset to exact contract steps. */
export function interventionSteps(kind: InterventionKind, ctx: InterventionContext = {}): PlanAction[] {
  const at = ctx.at ?? 0;
  switch (kind) {
    case 'close-road':
      return [{ at, type: 'close', closableId: requireId(ctx.streetId, 'streetId') }];
    case 'open-road':
      return [{ at, type: 'open', closableId: requireId(ctx.streetId, 'streetId') }];
    case 'post-officers':
      return [
        {
          at,
          type: 'send_officers',
          count: Math.max(1, Math.round(ctx.count ?? 4)),
          toPlaceId: requireId(ctx.gateId, 'gateId'),
        },
      ];
    case 'hold-officers':
      return [{ at, type: 'hold_officers', officerIds: [...(ctx.officerIds ?? [])] }];
    case 'close-gate':
      return [{ at, type: 'close', closableId: requireId(ctx.gateId, 'gateId') }];
    case 'open-gate':
      return [{ at, type: 'open', closableId: requireId(ctx.gateId, 'gateId') }];
    case 'lane-control':
      // No throughput edit exists in the contract: an officer team on the
      // approach is the modelled lane control (+10% per officer, cap +40%).
      return [
        {
          at,
          type: 'send_officers',
          count: Math.max(1, Math.round(ctx.count ?? 4)),
          toPlaceId: requireId(ctx.gateId, 'gateId'),
        },
      ];
    case 'divert-lot':
      return [
        {
          at,
          type: 'redirect',
          fromPlaceId: requireId(ctx.fromLotId, 'fromLotId'),
          toPlaceId: requireId(ctx.toLotId, 'toLotId'),
        },
        {
          at,
          type: 'alert',
          channel: 'pa',
          message: ctx.message ?? 'Use the other lot entrance. This one is full.',
          reachShare: ctx.reachShare ?? 0.7,
        },
      ];
    case 'alert-pa':
      return [
        {
          at,
          type: 'alert',
          channel: 'pa',
          message: ctx.message ?? 'Follow the officers and use the marked route.',
          reachShare: ctx.reachShare ?? 0.9,
        },
      ];
    case 'alert-phone':
      return [
        {
          at,
          type: 'alert',
          channel: 'phone',
          message: ctx.message ?? 'Avoid the congested area. Use the marked route.',
          reachShare: ctx.reachShare ?? 0.6,
        },
      ];
    case 'shelter':
      return [{ at, type: 'shelter_order', shelterPlaceIds: [...(ctx.shelterIds ?? [])] }];
  }
}

/** Human label for a preset, used by the plan editor and tests. */
export const INTERVENTION_LABELS: Record<InterventionKind, string> = {
  'close-road': 'Close a road',
  'open-road': 'Open a road',
  'post-officers': 'Post officers',
  'hold-officers': 'Hold officers',
  'close-gate': 'Close a gate',
  'open-gate': 'Open a gate',
  'lane-control': 'Lane control (officers on the approach)',
  'divert-lot': 'Divert a lot',
  'alert-pa': 'PA alert',
  'alert-phone': 'Phone alert',
  shelter: 'Order shelter',
};
