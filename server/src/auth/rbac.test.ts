import { describe, expect, it } from 'vitest';
import type { Actor, Permission, Position } from '../types.ts';
import { PERMISSIONS, POSITIONS } from '../types.ts';
import { can, demoActor, GLOBAL_ONLY, localActor, permissionsByScope, positionFor, ROLE_PERMISSIONS } from './rbac.ts';

const actor = (position: Position, scope = 'osu-2026', unit: string | null = null): Actor => ({
  userId: `u-${position}`,
  username: position,
  displayName: position,
  kind: 'user',
  grants: [{ position, scope, unit }],
});

/**
 * The permission matrix, row by row: what each position may and may not do
 * in its own event. One expectation per line keeps a change to the table a
 * visible change to this test.
 */
const MATRIX: [Position, Permission[], Permission[]][] = [
  ['incident_commander', ['plan.approve', 'order.simulate', 'assignment.write', 'cap.draft', 'product.export.restricted', 'video.view', 'display.manage'], ['user.manage', 'audit.read', 'exercise.control', 'msel.read']],
  ['unified_command', ['plan.approve', 'scenario.approve', 'incident.declare'], ['grant.manage', 'exercise.evaluate']],
  ['operations_chief', ['assignment.write', 'order.simulate', 'plan.write', 'plan.review', 'report.decide'], ['plan.approve', 'cap.draft', 'user.manage']],
  ['planning_chief', ['plan.write', 'plan.review', 'scenario.write', 'product.export.restricted', 'stadium.import', 'decision.record'], ['plan.approve', 'assignment.write', 'order.simulate']],
  ['logistics_chief', ['plan.read', 'product.export.restricted', 'note.log'], ['plan.write', 'assignment.write']],
  ['safety_officer', ['plan.review', 'report.create'], ['plan.approve', 'plan.write', 'assignment.write']],
  ['pio', ['cap.draft', 'product.export'], ['plan.write', 'order.simulate', 'product.export.restricted']],
  ['liaison_officer', ['plan.read', 'note.log'], ['cap.draft', 'plan.write']],
  ['division_supervisor', ['assignment.respond', 'assignment.write', 'report.create'], ['plan.write', 'order.simulate']],
  ['traffic', ['plan.write', 'assignment.respond', 'comparison.write'], ['plan.approve', 'assignment.write']],
  ['gates', ['plan.write', 'report.create'], ['plan.review', 'cap.draft']],
  ['ems_liaison', ['plan.write', 'product.export'], ['plan.approve', 'video.view']],
  ['rtcc_analyst', ['video.view', 'report.create'], ['plan.write', 'assignment.write', 'order.simulate']],
  ['field_unit', ['assignment.respond', 'report.create', 'event.read'], ['plan.read', 'note.log', 'order.simulate', 'comparison.read', 'legacy.compute']],
  ['exercise_director', ['exercise.approve', 'exercise.control', 'exercise.evaluate', 'msel.read', 'scenario.approve'], ['plan.approve', 'assignment.write']],
  ['controller', ['exercise.control', 'msel.read', 'exercise.write'], ['exercise.approve', 'exercise.evaluate']],
  ['evaluator', ['exercise.evaluate', 'msel.read'], ['exercise.control', 'order.simulate']],
  ['player', ['order.simulate', 'decision.record', 'exercise.read'], ['msel.read', 'exercise.control', 'exercise.evaluate']],
  ['observer', ['exercise.read', 'event.read'], ['msel.read', 'note.log', 'order.simulate']],
  ['display', ['event.read', 'feed.read'], ['note.log', 'plan.read', 'presence.announce']],
];

describe('the permission matrix', () => {
  it.each(MATRIX)('%s', (position, allowed, refused) => {
    const a = actor(position);
    for (const p of allowed) expect(can(a, p, { scope: 'osu-2026' }), `${position} should ${p}`).toBe(true);
    for (const p of refused) expect(can(a, p, { scope: 'osu-2026' }), `${position} should not ${p}`).toBe(false);
  });

  it('covers every position and only known permissions', () => {
    expect(Object.keys(ROLE_PERMISSIONS).sort()).toEqual([...POSITIONS].sort());
    for (const list of Object.values(ROLE_PERMISSIONS)) for (const p of list) expect(PERMISSIONS).toContain(p);
  });

  it('gives the System Administrator no operational content', () => {
    const admin = actor('admin', '*');
    for (const p of ['user.manage', 'grant.manage', 'session.revoke', 'allowlist.manage', 'audit.verify'] as Permission[]) expect(can(admin, p)).toBe(true);
    for (const p of ['plan.read', 'event.read', 'scenario.read', 'exercise.read', 'comparison.read', 'order.simulate', 'legacy.read'] as Permission[]) expect(can(admin, p, { scope: 'osu-2026' })).toBe(false);
  });

  it('keeps a position inside its own event', () => {
    const ic = actor('incident_commander', 'osu-2026');
    expect(can(ic, 'plan.approve', { scope: 'osu-2026' })).toBe(true);
    expect(can(ic, 'plan.approve', { scope: 'msu-2026' })).toBe(false);
    expect(can(ic, 'plan.read')).toBe(true); // "in any scope" for listings, filtered per item after
  });

  it('honours security permissions only when held globally', () => {
    for (const p of GLOBAL_ONLY) expect(can(actor('admin', 'osu-2026'), p)).toBe(false);
    expect(can(actor('records', '*'), 'audit.read')).toBe(true);
    expect(can(actor('records', 'osu-2026'), 'audit.read')).toBe(false);
  });

  it('lets a field unit respond only for its own unit', () => {
    const unit12 = actor('field_unit', 'osu-2026', 'OSU PD 12');
    expect(can(unit12, 'assignment.respond', { scope: 'osu-2026', unit: 'OSU PD 12' })).toBe(true);
    expect(can(unit12, 'assignment.respond', { scope: 'osu-2026', unit: 'OSU PD 14' })).toBe(false);
    expect(can(actor('field_unit', 'osu-2026'), 'assignment.respond', { scope: 'osu-2026', unit: 'OSU PD 12' })).toBe(false);
  });

  it('lets a division supervisor assign only inside the division', () => {
    const divA = actor('division_supervisor', 'osu-2026', 'Division A');
    expect(can(divA, 'assignment.write', { scope: 'osu-2026', unit: 'OSU PD 12', division: 'Division A' })).toBe(true);
    expect(can(divA, 'assignment.write', { scope: 'osu-2026', unit: 'OSU PD 12', division: 'Division B' })).toBe(false);
    expect(can(actor('operations_chief'), 'assignment.write', { scope: 'osu-2026', unit: 'any', division: 'Division B' })).toBe(true);
  });

  it('needs the restricted export permission for restricted products', () => {
    expect(can(actor('pio'), 'product.export', { scope: 'osu-2026', classification: 'internal' })).toBe(true);
    expect(can(actor('pio'), 'product.export', { scope: 'osu-2026', classification: 'restricted' })).toBe(false);
    expect(can(actor('planning_chief'), 'product.export', { scope: 'osu-2026', classification: 'restricted' })).toBe(true);
  });

  it('refuses nobody-in-particular', () => {
    expect(can(null, 'event.read')).toBe(false);
    expect(can(undefined, 'feed.read')).toBe(false);
  });

  it('gives the first-run local operator the v2 routes only', () => {
    const local = localActor();
    expect(can(local, 'legacy.compute')).toBe(true);
    expect(can(local, 'plan.write')).toBe(true);
    expect(can(local, 'event.read')).toBe(false);
    expect(can(local, 'user.manage')).toBe(false);
  });

  it('gives the demo user every operating position and nothing administrative', () => {
    const demo = demoActor();
    expect(can(demo, 'plan.approve', { scope: 'anything' })).toBe(true);
    expect(can(demo, 'exercise.control', { scope: 'anything' })).toBe(true);
    expect(can(demo, 'user.manage')).toBe(false);
    expect(can(demo, 'audit.read')).toBe(false);
  });

  it('attributes an action to the position that allows it', () => {
    const both: Actor = { ...actor('pio'), grants: [{ position: 'pio', scope: 'osu-2026', unit: null }, { position: 'planning_chief', scope: 'osu-2026', unit: null }] };
    expect(positionFor(both, 'plan.write', { scope: 'osu-2026' })).toBe('planning_chief');
    expect(positionFor(both, 'cap.draft', { scope: 'osu-2026' })).toBe('pio');
    expect(positionFor(both, 'plan.write', { scope: 'osu-2026' }, 'pio')).toBeNull();
    expect(permissionsByScope(both)['osu-2026']).toContain('cap.draft');
  });
});
