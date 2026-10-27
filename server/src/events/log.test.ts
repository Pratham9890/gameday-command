import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Actor, AppendRequest, Position } from '../types.ts';
import { openDb } from '../db.ts';
import { migratePlatform } from '../platform/schema.ts';
import { EventError, EventLog, visibleTo } from './log.ts';
import { FakeClock, addUser, makeApp, signIn } from '../testing.ts';

const actor = (userId: string, ...grants: [Position, string?][]): Actor => ({
  userId,
  username: userId,
  displayName: userId,
  kind: 'user',
  grants: grants.map(([position, unit]) => ({ position, scope: 'osu-2026', unit: unit ?? null })),
});

const ops = actor('ops', ['operations_chief']);
const unit12 = actor('unit12', ['field_unit', 'OSU PD 12']);
const unit14 = actor('unit14', ['field_unit', 'OSU PD 14']);

function setup() {
  const db = openDb(':memory:');
  migratePlatform(db);
  const clock = new FakeClock();
  return { db, log: new EventLog(db, clock.now), clock };
}

const req = (type: AppendRequest['type'], payload: unknown, extra: Partial<AppendRequest> = {}): AppendRequest => ({ id: randomUUID(), stream: 'osu-2026/op-1', type, mode: 'live', payload, ...extra });

const expectError = (fn: () => unknown, status: number, code: string) => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(EventError);
    expect([(error as EventError).status, (error as EventError).code]).toEqual([status, code]);
    return error as EventError;
  }
  throw new Error(`expected ${status} ${code}`);
};

describe('the event log', () => {
  it('gives each event the next seq and the PLAN §5.6 envelope', () => {
    const { log } = setup();
    const r = log.append(ops, req('incident.declared', { incidentId: 'i-1', kind: 'gate_surge', place: { name: 'Gate 10' } }, { clientTime: '2026-10-31T15:59:58Z', simTime: 120 }));
    expect(r.duplicate).toBe(false);
    expect(r.event).toMatchObject({ seq: 1, stream: 'osu-2026/op-1', type: 'incident.declared', actor: { userId: 'ops', position: 'operations_chief' }, clientTime: '2026-10-31T15:59:58Z', simTime: 120, mode: 'live' });
    expect(r.event.serverTime).toBe('2026-10-31T16:00:00.000Z');
    expect(log.append(ops, req('note.logged', { text: 'second' })).event.seq).toBe(2);
  });

  it('is idempotent on the client id, and refuses an id reused for something else', () => {
    const { log } = setup();
    const request = req('note.logged', { text: 'Gate 10 queue past the bike racks' });
    const first = log.append(ops, request);
    const again = log.append(ops, request);
    expect(again.duplicate).toBe(true);
    expect(again.event.seq).toBe(first.event.seq);
    expect(log.head()).toBe(1);
    expectError(() => log.append(ops, { ...request, payload: { text: 'different' } }), 409, 'id_reused');
    expectError(() => log.append(actor('other', ['operations_chief']), request), 409, 'id_reused');
  });

  it('replays a stream after a seq, oldest first, across a mix of streams', () => {
    const { log } = setup();
    for (let i = 0; i < 5; i++) {
      log.append(ops, req('note.logged', { text: `a${i}` }));
      log.append(ops, req('note.logged', { text: `b${i}` }, { stream: 'osu-2026/op-2' }));
    }
    const all = log.since('osu-2026/op-1').map((s) => s.event.seq);
    expect(all).toEqual([1, 3, 5, 7, 9]);
    expect(log.since('osu-2026/op-1', 5).map((s) => (s.event.payload as { text: string }).text)).toEqual(['a3', 'a4']);
  });

  it('keeps exercise events out of live streams', () => {
    const { log } = setup();
    log.append(ops, req('note.logged', { text: 'live' }));
    expectError(() => log.append(ops, req('note.logged', { text: 'exercise' }, { mode: 'exercise' })), 409, 'mode_mismatch');
    expectError(() => log.append(actor('ctl', ['controller']), req('inject.released', { injectId: 'msel-1', title: 'Gate 10 surge' })), 422, 'wrong_mode');
  });

  it('checks the payload and the position', () => {
    const { log } = setup();
    expectError(() => log.append(ops, req('assignment.created', { assignmentId: 'a1', unit: 'OSU PD 12' })), 400, 'invalid_payload');
    expectError(() => log.append(unit12, req('assignment.created', { assignmentId: 'a1', unit: 'OSU PD 12', task: 'x' })), 403, 'forbidden');
    expectError(() => log.append(ops, req('document.approved', { documentId: 'd', kind: 'plan', version: 1, name: 'n' })), 403, 'server_only');
    expectError(() => log.append(ops, { ...req('note.logged', { text: 'x' }), id: 'not-a-uuid' }), 400, 'invalid_request');
    expectError(() => log.append(ops, req('note.logged', { text: 'x' }, { stream: 'Bad Stream!' })), 400, 'invalid_request');
  });

  it('warns about personal data in free text', () => {
    const { log } = setup();
    const r = log.append(ops, req('note.logged', { text: 'Driver of OH plate ABC 1234 called 614-555-0100' }));
    expect(r.warnings?.map((w) => w.kind).sort()).toEqual(['phone', 'plate']);
  });

  it('is hash chained and the chain verifies', () => {
    const { db, log } = setup();
    for (let i = 0; i < 4; i++) log.append(ops, req('note.logged', { text: `n${i}` }));
    expect(log.verify()).toMatchObject({ ok: true, events: 4 });
    db.exec('drop trigger events_append_only_update');
    db.prepare(`update events set payload = '{"text":"edited"}' where seq = 2`).run();
    expect(log.verify().problems).toEqual([{ seq: 2, kind: 'hash_mismatch' }]);
  });
});

describe('assignments: compare-and-set and idempotent acknowledgement', () => {
  const create = (log: EventLog) => log.append(ops, req('assignment.created', { assignmentId: 'asg-1', unit: 'OSU PD 12', task: 'Hold the Gate 10 queue line', place: { placeId: 'gate-10', name: 'Gate 10' }, priority: 'priority' }));

  it('refuses a change based on a version someone else already moved past, and returns the current state', () => {
    const { log } = setup();
    create(log);
    const sergeant = actor('sgt', ['operations_chief']);
    log.append(ops, req('assignment.updated', { assignmentId: 'asg-1', expectedVersion: 1, task: 'Hold the line at the bike racks' }));
    const conflict = expectError(() => log.append(sergeant, req('assignment.reassigned', { assignmentId: 'asg-1', expectedVersion: 1, unit: 'OSU PD 14' })), 409, 'version_conflict');
    expect(conflict.extra.current).toMatchObject({ version: 2, unit: 'OSU PD 12', task: 'Hold the line at the bike racks' });
    log.append(sergeant, req('assignment.reassigned', { assignmentId: 'asg-1', expectedVersion: 2, unit: 'OSU PD 14' }));
    expect(log.getAssignment('asg-1')).toMatchObject({ version: 3, unit: 'OSU PD 14', status: 'assigned' });
  });

  it('accepts an acknowledgement once per version and account, whatever the client id', () => {
    const { log } = setup();
    create(log);
    const first = log.append(unit12, req('assignment.acknowledged', { assignmentId: 'asg-1', version: 1 }));
    const retry = log.append(unit12, req('assignment.acknowledged', { assignmentId: 'asg-1', version: 1 }));
    expect(retry).toMatchObject({ duplicate: true, event: { seq: first.event.seq } });
    expect(log.getAssignment('asg-1')).toMatchObject({ status: 'acknowledged', acknowledged: { userId: 'unit12', seq: first.event.seq } });
    expect(log.head()).toBe(2);
  });

  it('refuses an acknowledgement of a version that has changed, and one from another unit', () => {
    const { log } = setup();
    create(log);
    log.append(ops, req('assignment.updated', { assignmentId: 'asg-1', expectedVersion: 1, priority: 'urgent' }));
    expectError(() => log.append(unit12, req('assignment.acknowledged', { assignmentId: 'asg-1', version: 1 })), 409, 'version_conflict');
    expectError(() => log.append(unit14, req('assignment.acknowledged', { assignmentId: 'asg-1', version: 2 })), 403, 'forbidden');
    expectError(() => log.append(unit12, req('assignment.acknowledged', { assignmentId: 'nope', version: 1 })), 404, 'no_such_assignment');
    log.append(unit12, req('assignment.acknowledged', { assignmentId: 'asg-1', version: 2 }));
    log.append(unit12, req('assignment.completed', { assignmentId: 'asg-1', version: 2 }));
    expect(log.getAssignment('asg-1')!.status).toBe('completed');
  });
});

describe('need-to-know on the stream', () => {
  it('shows a field unit its own assignments and the broadcast types only', () => {
    const { log } = setup();
    log.append(ops, req('assignment.created', { assignmentId: 'a12', unit: 'OSU PD 12', task: 'Gate 10' }));
    log.append(ops, req('assignment.created', { assignmentId: 'a14', unit: 'OSU PD 14', task: 'Lot 5' }));
    log.append(ops, req('incident.declared', { incidentId: 'i1', kind: 'medical' }));
    log.append(ops, req('note.logged', { text: 'command post moved' }));
    const seen = (who: Actor) => log.since('osu-2026/op-1').filter((s) => visibleTo(who, s)).map((s) => s.event.type + ':' + ((s.event.payload as { assignmentId?: string }).assignmentId ?? ''));
    expect(seen(unit12)).toEqual(['assignment.created:a12', 'incident.declared:']);
    expect(seen(unit14)).toEqual(['assignment.created:a14', 'incident.declared:']);
    expect(seen(ops)).toHaveLength(4);
  });

  it('keeps evaluator observations from players and observers', () => {
    const { log } = setup();
    const evaluator: Actor = { ...actor('eva'), grants: [{ position: 'evaluator', scope: 'tabletop-1', unit: null }] };
    log.append(evaluator, req('observation.recorded', { observationId: 'o1', objectiveId: '2', text: 'Gate 10 closure took 6 min to communicate', rating: 'S' }, { mode: 'exercise', stream: 'tabletop-1' }));
    const stored = log.since('tabletop-1')[0]!;
    const inExercise = (position: Position): Actor => ({ ...actor(position, [position]), grants: [{ position, scope: 'tabletop-1', unit: null }] });
    expect(visibleTo(inExercise('player'), stored)).toBe(false);
    expect(visibleTo(inExercise('observer'), stored)).toBe(false);
    expect(visibleTo(inExercise('controller'), stored)).toBe(true);
    expect(visibleTo(inExercise('exercise_director'), stored)).toBe(true);
  });
});

describe('events over REST', () => {
  it('appends, replays since seq, and lists assignments for the unit', async () => {
    const { app, platform } = makeApp();
    await addUser(platform, 'ops.one', [{ position: 'operations_chief' }]);
    await addUser(platform, 'unit.12', [{ position: 'field_unit', unit: 'OSU PD 12' }]);
    const opsC = await signIn(app, 'ops.one');
    const unit = await signIn(app, 'unit.12');
    const event = { id: randomUUID(), stream: 'osu-2026/op-1', type: 'assignment.created', mode: 'live', payload: { assignmentId: 'a1', unit: 'OSU PD 12', task: 'Gate 10' } };
    const created = await opsC.json('POST', '/api/v3/events', event);
    expect(created.status).toBe(201);
    expect((await opsC.json('POST', '/api/v3/events', event)).status).toBe(200);
    await opsC.post('/api/v3/events', { ...event, id: randomUUID(), payload: { assignmentId: 'a2', unit: 'OSU PD 14', task: 'Lot 5' } });
    const conflict = await opsC.json('POST', '/api/v3/events', { id: randomUUID(), stream: 'osu-2026/op-1', type: 'assignment.updated', mode: 'live', payload: { assignmentId: 'a1', expectedVersion: 7 } });
    expect(conflict.status).toBe(409);
    expect(conflict.body.current.version).toBe(1);
    const replay = (await unit.json('GET', '/api/v3/events?stream=osu-2026/op-1&since=0')).body;
    expect(replay.events.map((e: { payload: { assignmentId: string } }) => e.payload.assignmentId)).toEqual(['a1']);
    expect(replay.lastSeq).toBe(2);
    expect(((await unit.json('GET', '/api/v3/assignments?stream=osu-2026/op-1')).body as { assignmentId: string }[]).map((a) => a.assignmentId)).toEqual(['a1']);
    const ack = await unit.json('POST', '/api/v3/events', { id: randomUUID(), stream: 'osu-2026/op-1', type: 'assignment.acknowledged', mode: 'live', payload: { assignmentId: 'a1', version: 1 } });
    expect(ack.status).toBe(201);
    expect((await unit.get('/api/v3/events?stream=msu-2026')).status).toBe(403);
  });
});
