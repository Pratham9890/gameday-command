import type { EventMode, EventPayloads, EventType, Permission, PlaceRef } from '../types.ts';
import { DOCUMENT_KINDS, POSITIONS } from '../types.ts';
import { type Check, v } from '../platform/validate.ts';

/**
 * Every event type the log accepts: who may append it, in which modes, the
 * payload schema, which payload fields are free text, and the plain-language
 * line it becomes in an ICS 214 activity log.
 */
export interface EventSpec<T extends EventType = EventType> {
  permission: Permission;
  /** Appended only by the server itself (the document workflow). */
  serverOnly?: boolean;
  modes?: readonly EventMode[];
  payload: Check<EventPayloads[T]>;
  freeText?: string[];
  /** Hidden from players, observers, displays and field units (evaluator notes). */
  controlOnly?: boolean;
  /** Field units see this type (assignment events only when addressed to their unit). */
  fieldVisible?: boolean;
  summary: (payload: EventPayloads[T]) => string;
}

const id = v.string({ min: 1, max: 80, pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]*$/ });
const unit = v.string({ min: 1, max: 60 });
const place: Check<PlaceRef | undefined> = v.optional(
  v.object({ placeId: v.optional(v.string({ max: 80 })), cell: v.optional(v.number({ int: true, min: 0 })), name: v.optional(v.string({ max: 80 })) }),
);
const priority = v.optional(v.literal(['routine', 'priority', 'urgent'] as const));
const version = v.number({ int: true, min: 1 });

const where = (p?: PlaceRef) => (p?.name ? ` at ${p.name}` : p?.placeId ? ` at ${p.placeId}` : p?.cell !== undefined ? ` at cell ${p.cell}` : '');
const words = (s: string) => s.replace(/_/g, ' ');

export const EVENT_SPECS: { [T in EventType]: EventSpec<T> } = {
  'assignment.created': {
    permission: 'assignment.write',
    payload: v.object({ assignmentId: id, unit, division: v.optional(v.string({ max: 60 })), task: v.string({ min: 1, max: 280 }), place, priority }),
    fieldVisible: true,
    summary: (p) => `Assignment ${p.assignmentId}: ${p.unit} to ${p.task}${where(p.place)}${p.priority && p.priority !== 'routine' ? ` (${p.priority})` : ''}.`,
  },
  'assignment.updated': {
    permission: 'assignment.write',
    payload: v.object({ assignmentId: id, expectedVersion: version, task: v.optional(v.string({ min: 1, max: 280 })), place, priority, division: v.optional(v.string({ max: 60 })) }),
    fieldVisible: true,
    summary: (p) => `Assignment ${p.assignmentId} changed${p.task ? `: ${p.task}` : ''}${where(p.place)}.`,
  },
  'assignment.reassigned': {
    permission: 'assignment.write',
    payload: v.object({ assignmentId: id, expectedVersion: version, unit, division: v.optional(v.string({ max: 60 })) }),
    fieldVisible: true,
    summary: (p) => `Assignment ${p.assignmentId} reassigned to ${p.unit}.`,
  },
  'assignment.acknowledged': {
    permission: 'assignment.respond',
    payload: v.object({ assignmentId: id, version }),
    fieldVisible: true,
    summary: (p) => `Assignment ${p.assignmentId} acknowledged (version ${p.version}).`,
  },
  'assignment.completed': {
    permission: 'assignment.respond',
    payload: v.object({ assignmentId: id, version }),
    fieldVisible: true,
    summary: (p) => `Assignment ${p.assignmentId} completed.`,
  },
  'assignment.cancelled': {
    permission: 'assignment.write',
    payload: v.object({ assignmentId: id, expectedVersion: version, reason: v.optional(v.literal(['no_longer_needed', 'duplicate', 'superseded', 'other'] as const)) }),
    fieldVisible: true,
    summary: (p) => `Assignment ${p.assignmentId} cancelled${p.reason ? ` (${words(p.reason)})` : ''}.`,
  },
  'unit.status': {
    permission: 'assignment.respond',
    payload: v.object({ unit, status: v.literal(['available', 'assigned', 'en_route', 'on_scene', 'returning', 'out_of_service'] as const), place }),
    summary: (p) => `${p.unit} reports ${words(p.status)}${where(p.place)}.`,
  },
  'report.created': {
    permission: 'report.create',
    payload: v.object({ reportId: id, kind: v.literal(['backup', 'crowd_crush', 'medical', 'fight', 'traffic', 'suspicious_item', 'other'] as const), unit: v.optional(unit), place, priority }),
    summary: (p) => `${p.unit ?? 'A unit'} reported ${words(p.kind)}${where(p.place)}${p.priority && p.priority !== 'routine' ? ` (${p.priority})` : ''}.`,
  },
  'report.decided': {
    permission: 'report.decide',
    payload: v.object({ reportId: id, decision: v.literal(['accepted', 'dismissed', 'assigned'] as const), assignmentId: v.optional(id) }),
    summary: (p) => `Report ${p.reportId} ${p.decision}${p.assignmentId ? ` as assignment ${p.assignmentId}` : ''}.`,
  },
  'order.simulated': {
    permission: 'order.simulate',
    modes: ['plan', 'rehearse', 'exercise'],
    payload: v.object({ runId: v.optional(v.string({ max: 80 })), planLabel: v.optional(v.literal(['A', 'B', 'C'] as const)), order: v.object({ type: v.string({ min: 1, max: 40 }) }, { extra: true }) as Check<{ type: string } & Record<string, unknown>> }),
    summary: (p) => `Simulated order (${words(p.order.type)})${p.planLabel ? ` in plan ${p.planLabel}` : ''}.`,
  },
  'decision.recorded': {
    permission: 'decision.record',
    payload: v.object({ title: v.string({ min: 1, max: 160 }), choice: v.string({ min: 1, max: 160 }), rationale: v.optional(v.string({ max: 4000 })), comparisonId: v.optional(v.string({ max: 80 })) }),
    freeText: ['title', 'choice', 'rationale'],
    summary: (p) => `Decision recorded: ${p.title}: ${p.choice}.`,
  },
  'note.logged': {
    permission: 'note.log',
    payload: v.object({ text: v.string({ min: 1, max: 4000 }), unit: v.optional(unit) }),
    freeText: ['text'],
    summary: (p) => p.text,
  },
  'incident.declared': {
    permission: 'incident.declare',
    payload: v.object({
      incidentId: id,
      kind: v.literal(['game_end', 'lightning_delay', 'gate_surge', 'suspicious_package', 'medical', 'fight'] as const),
      place,
      severity: v.optional(v.literal(['minor', 'moderate', 'major'] as const)),
    }),
    fieldVisible: true,
    summary: (p) => `Incident ${p.incidentId} declared: ${words(p.kind)}${where(p.place)}${p.severity ? ` (${p.severity})` : ''}.`,
  },
  'incident.updated': {
    permission: 'incident.declare',
    payload: v.object({ incidentId: id, status: v.literal(['active', 'contained', 'closed'] as const) }),
    fieldVisible: true,
    summary: (p) => `Incident ${p.incidentId} ${p.status}.`,
  },
  'inject.released': {
    permission: 'exercise.control',
    modes: ['exercise'],
    payload: v.object({ injectId: id, mselNumber: v.optional(v.string({ max: 20 })), title: v.string({ min: 1, max: 200 }), to: v.optional(v.array(v.literal(POSITIONS), { max: 30 })) }),
    fieldVisible: true,
    summary: (p) => `Inject ${p.mselNumber ?? p.injectId} released: ${p.title}.`,
  },
  'observation.recorded': {
    permission: 'exercise.evaluate',
    modes: ['exercise'],
    payload: v.object({ observationId: id, objectiveId: v.optional(v.string({ max: 40 })), capability: v.optional(v.string({ max: 120 })), text: v.string({ min: 1, max: 4000 }), rating: v.optional(v.literal(['P', 'S', 'M', 'U'] as const)) }),
    freeText: ['text'],
    controlOnly: true,
    summary: (p) => `Evaluator observation${p.objectiveId ? ` on objective ${p.objectiveId}` : ''}${p.rating ? ` (rating ${p.rating})` : ''}.`,
  },
  'exercise.started': { permission: 'exercise.control', modes: ['exercise'], payload: v.object({ exerciseId: id }), fieldVisible: true, summary: (p) => `Exercise ${p.exerciseId} started.` },
  'exercise.paused': { permission: 'exercise.control', modes: ['exercise'], payload: v.object({ exerciseId: id }), fieldVisible: true, summary: (p) => `Exercise ${p.exerciseId} paused.` },
  'exercise.ended': { permission: 'exercise.control', modes: ['exercise'], payload: v.object({ exerciseId: id }), fieldVisible: true, summary: (p) => `Exercise ${p.exerciseId} ended (ENDEX).` },
  'feed.viewed': {
    permission: 'video.view',
    payload: v.object({ feedId: id, action: v.literal(['start', 'stop'] as const) }),
    summary: (p) => `Video feed ${p.feedId} view ${p.action === 'start' ? 'started' : 'stopped'}.`,
  },
  'document.reviewed': {
    permission: 'plan.review',
    serverOnly: true,
    payload: v.object({ documentId: id, kind: v.literal(DOCUMENT_KINDS), version, name: v.string({ max: 200 }) }),
    summary: (p) => `${p.kind[0]!.toUpperCase()}${p.kind.slice(1)} "${p.name}" version ${p.version} reviewed.`,
  },
  'document.approved': {
    permission: 'plan.approve',
    serverOnly: true,
    payload: v.object({ documentId: id, kind: v.literal(DOCUMENT_KINDS), version, name: v.string({ max: 200 }) }),
    summary: (p) => `${p.kind[0]!.toUpperCase()}${p.kind.slice(1)} "${p.name}" version ${p.version} approved.`,
  },
};

export function summarize(type: EventType, payload: unknown): string {
  const spec = EVENT_SPECS[type] as EventSpec;
  try {
    return spec.summary(payload as never);
  } catch {
    return type;
  }
}
