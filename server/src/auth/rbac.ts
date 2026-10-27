import type { Actor, ActorGrant, Permission, Position, Resource } from '../types.ts';
import { PERMISSIONS, POSITIONS } from '../types.ts';

/**
 * Position-based access control (research 06 §2.3, PLT-08).
 *
 * Privileges attach to a position held in a scope (an event or exercise), the
 * way WebEOC signs people in to a position and an incident. One table maps
 * every position to what it may do; `can()` is the only place that reads it,
 * and every route asks `can()`.
 *
 * Choices worth knowing:
 * - The System Administrator manages accounts, grants, the allowlist and
 *   security audit, and sees no operational content (no plans, no events).
 * - Approving a plan is the Incident Commander's or Unified Command's call
 *   (the IC/UC signature on the ICS 202).
 * - The radio plan and other restricted annexes need `product.export.restricted`.
 * - Field units and players see only what is theirs: see `visibleTo` in the event log.
 */
const READ_COMMON: Permission[] = ['event.read', 'presence.announce', 'feed.read', 'legacy.read'];
const SIM: Permission[] = ['legacy.compute', 'legacy.write', 'comparison.read', 'comparison.write'];

export const ROLE_PERMISSIONS: Record<Position, readonly Permission[]> = {
  incident_commander: [
    ...READ_COMMON, ...SIM,
    'order.simulate', 'assignment.write', 'report.create', 'report.decide', 'note.log', 'decision.record', 'incident.declare',
    'plan.read', 'plan.write', 'plan.review', 'plan.approve', 'scenario.read', 'scenario.write', 'scenario.review', 'scenario.approve',
    'exercise.read', 'product.export', 'product.export.restricted', 'cap.draft', 'video.view', 'display.manage',
  ],
  unified_command: [
    ...READ_COMMON, ...SIM,
    'order.simulate', 'assignment.write', 'report.create', 'report.decide', 'note.log', 'decision.record', 'incident.declare',
    'plan.read', 'plan.write', 'plan.review', 'plan.approve', 'scenario.read', 'scenario.write', 'scenario.review', 'scenario.approve',
    'exercise.read', 'product.export', 'product.export.restricted', 'cap.draft', 'video.view', 'display.manage',
  ],
  operations_chief: [
    ...READ_COMMON, ...SIM,
    'order.simulate', 'assignment.write', 'report.create', 'report.decide', 'note.log', 'incident.declare',
    'plan.read', 'plan.write', 'plan.review', 'scenario.read', 'scenario.write', 'exercise.read',
    'product.export', 'product.export.restricted', 'video.view',
  ],
  planning_chief: [
    ...READ_COMMON, ...SIM,
    'note.log', 'decision.record', 'plan.read', 'plan.write', 'plan.review', 'scenario.read', 'scenario.write', 'scenario.review',
    'exercise.read', 'product.export', 'product.export.restricted', 'stadium.import',
  ],
  logistics_chief: [...READ_COMMON, 'legacy.compute', 'comparison.read', 'note.log', 'plan.read', 'scenario.read', 'product.export', 'product.export.restricted'],
  safety_officer: [...READ_COMMON, 'legacy.compute', 'comparison.read', 'report.create', 'note.log', 'plan.read', 'plan.review', 'scenario.read', 'scenario.review', 'product.export'],
  pio: [...READ_COMMON, 'comparison.read', 'note.log', 'plan.read', 'cap.draft', 'product.export'],
  liaison_officer: [...READ_COMMON, 'comparison.read', 'note.log', 'plan.read', 'product.export'],
  division_supervisor: [...READ_COMMON, 'legacy.compute', 'assignment.write', 'assignment.respond', 'report.create', 'note.log', 'plan.read'],
  traffic: [...READ_COMMON, ...SIM, 'assignment.respond', 'report.create', 'note.log', 'plan.read', 'plan.write', 'scenario.read'],
  gates: [...READ_COMMON, ...SIM, 'assignment.respond', 'report.create', 'note.log', 'plan.read', 'plan.write', 'scenario.read'],
  ems_liaison: [...READ_COMMON, ...SIM, 'assignment.respond', 'report.create', 'note.log', 'plan.read', 'plan.write', 'scenario.read', 'product.export'],
  rtcc_analyst: [...READ_COMMON, 'report.create', 'note.log', 'plan.read', 'video.view'],
  field_unit: [...READ_COMMON, 'assignment.respond', 'report.create'],
  exercise_director: [
    ...READ_COMMON, ...SIM,
    'note.log', 'decision.record', 'scenario.read', 'scenario.write', 'scenario.review', 'scenario.approve', 'plan.read',
    'exercise.read', 'exercise.write', 'exercise.review', 'exercise.approve', 'exercise.control', 'exercise.evaluate', 'msel.read',
    'product.export', 'cap.draft', 'display.manage',
  ],
  controller: [...READ_COMMON, ...SIM, 'note.log', 'scenario.read', 'plan.read', 'exercise.read', 'exercise.write', 'exercise.control', 'msel.read'],
  evaluator: [...READ_COMMON, 'legacy.compute', 'comparison.read', 'note.log', 'plan.read', 'exercise.read', 'exercise.evaluate', 'msel.read', 'product.export'],
  player: [...READ_COMMON, ...SIM, 'order.simulate', 'note.log', 'decision.record', 'plan.read', 'exercise.read'],
  observer: [...READ_COMMON, 'comparison.read', 'exercise.read'],
  records: ['event.read', 'feed.read', 'audit.read', 'audit.verify', 'plan.read', 'scenario.read', 'exercise.read', 'comparison.read', 'product.export', 'product.export.restricted'],
  admin: ['user.manage', 'grant.manage', 'session.revoke', 'display.manage', 'allowlist.manage', 'feed.configure', 'feed.read', 'audit.read', 'audit.verify', 'audit.checkpoint', 'stadium.import'],
  display: ['event.read', 'feed.read', 'legacy.read'],
};

/** Permissions that only count when held in the global scope `*`. */
export const GLOBAL_ONLY: ReadonlySet<Permission> = new Set([
  'user.manage', 'grant.manage', 'session.revoke', 'allowlist.manage', 'feed.configure', 'audit.read', 'audit.verify', 'audit.checkpoint',
]);

/** Positions tied to a unit or division: they may only respond for that unit. */
const UNIT_BOUND: ReadonlySet<Position> = new Set(['field_unit', 'division_supervisor', 'traffic', 'gates', 'ems_liaison']);

const grantCovers = (grant: ActorGrant, scope: string | undefined) => grant.scope === '*' || scope === undefined || grant.scope === scope;

function allowedBy(grant: ActorGrant, action: Permission, resource: Resource): boolean {
  if (!ROLE_PERMISSIONS[grant.position]?.includes(action)) return false;
  if (GLOBAL_ONLY.has(action) && grant.scope !== '*') return false;
  if (!grantCovers(grant, resource.scope)) return false;
  // Unit-bound positions act only for their own unit or division.
  if ((action === 'assignment.respond' || action === 'assignment.write') && UNIT_BOUND.has(grant.position)) {
    if (resource.unit === undefined && resource.division === undefined) return true;
    if (!grant.unit) return false;
    if (grant.position === 'division_supervisor') return resource.division === grant.unit || resource.unit === grant.unit;
    if (action === 'assignment.write') return false;
    return resource.unit === grant.unit;
  }
  return true;
}

/**
 * The single access decision. `resource.scope` undefined means "in any scope"
 * (listings, then filtered per item); a restricted resource needs the
 * restricted variant of an export.
 */
export function can(actor: Actor | null | undefined, action: Permission, resource: Resource = {}): boolean {
  if (!actor) return false;
  if (actor.kind === 'local') return LOCAL_PERMISSIONS.has(action);
  const effective: Permission = action === 'product.export' && resource.classification === 'restricted' ? 'product.export.restricted' : action;
  return actor.grants.some((grant) => allowedBy(grant, effective, resource));
}

/** The first of the actor's positions (in table order) that may do this, for attribution. */
export function positionFor(actor: Actor, action: Permission, resource: Resource = {}, wanted?: Position): Position | null {
  const candidates = actor.grants.filter((grant) => allowedBy(grant, action, resource));
  if (wanted) return candidates.some((g) => g.position === wanted) ? wanted : null;
  const order = POSITIONS as readonly Position[];
  candidates.sort((a, b) => order.indexOf(a.position) - order.indexOf(b.position));
  return candidates[0]?.position ?? null;
}

/** Everything an actor may do, per scope, for the session endpoint. */
export function permissionsByScope(actor: Actor | null): Record<string, Permission[]> {
  if (!actor) return {};
  const out: Record<string, Set<Permission>> = {};
  for (const grant of actor.grants) {
    const set = (out[grant.scope] ??= new Set());
    for (const p of ROLE_PERMISSIONS[grant.position] ?? []) if (!GLOBAL_ONLY.has(p) || grant.scope === '*') set.add(p);
  }
  return Object.fromEntries(Object.entries(out).map(([scope, set]) => [scope, PERMISSIONS.filter((p) => set.has(p))]));
}

/** The demo user holds every operating and exercise position, and nothing administrative. */
export const DEMO_POSITIONS: Position[] = POSITIONS.filter((p) => p !== 'admin' && p !== 'records' && p !== 'display' && p !== 'field_unit' && p !== 'observer');

export function demoActor(): Actor {
  return {
    userId: 'demo',
    username: 'demo',
    displayName: 'Demo user (no sign-in)',
    kind: 'demo',
    grants: DEMO_POSITIONS.map((position) => ({ position, scope: '*', unit: null })),
  };
}

/**
 * Before any account exists, loopback callers may use the v2 routes exactly as
 * they always could, and nothing else: the v3 API waits for `admin:create`.
 */
export const LOCAL_PERMISSIONS: ReadonlySet<Permission> = new Set([
  'legacy.read', 'legacy.compute', 'legacy.write', 'plan.read', 'plan.write', 'comparison.read', 'comparison.write', 'stadium.import', 'feed.read',
]);

export function localActor(): Actor {
  return { userId: 'local', username: 'local', displayName: 'Local operator (no accounts yet)', kind: 'local', grants: [] };
}
