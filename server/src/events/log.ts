import type { Db } from '../db.ts';
import type { Actor, AppendRequest, AppendResult, AssignmentState, EventEnvelope, EventMode, EventPayloads, EventType, Position, Resource } from '../types.ts';
import { EVENT_MODES, EVENT_TYPES } from '../types.ts';
import { canonicalJson, chainHash, GENESIS_HASH, iso, isUuid, sha256Hex } from '../platform/canonical.ts';
import { ISO_PATTERN, parse, scopeOfStream, STREAM_PATTERN } from '../platform/validate.ts';
import { warnFields } from '../platform/freetext.ts';
import { transaction } from '../platform/schema.ts';
import { can, positionFor } from '../auth/rbac.ts';
import { EVENT_SPECS, type EventSpec } from './registry.ts';

/**
 * The operational event log (research 06 §3, PLT-18 to PLT-20): one
 * server-authoritative, append-only log. The server gives each event the next
 * `seq`; the client's UUID is the idempotency key, so a retry after a dropped
 * link stores nothing twice. Events are hash chained like the audit log.
 *
 * Assignments are the one place two people can collide, so they use
 * compare-and-set: a change names the version it was based on and the server
 * refuses it if the assignment moved on, returning the current state so the UI
 * can show both. Acknowledgements are idempotent per assignment version and
 * account: acknowledging twice returns the first acknowledgement.
 */
export class EventError extends Error {
  readonly status: 400 | 401 | 403 | 404 | 409 | 422;
  readonly code: string;
  readonly extra: Record<string, unknown>;
  constructor(
    status: 400 | 401 | 403 | 404 | 409 | 422,
    code: string,
    message: string,
    extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

interface EventRow {
  seq: number;
  id: string;
  stream: string;
  type: string;
  actor_user: string;
  actor_position: string;
  server_time: number;
  client_time: string | null;
  sim_time: number | null;
  mode: string;
  caused_by: string | null;
  payload: string;
  audience: string | null;
  content_hash: string;
  prev_hash: string;
  hash: string;
}

export interface StoredEvent {
  event: EventEnvelope;
  /** Units an assignment event is addressed to; null = everyone in the stream. */
  audience: string[] | null;
}

const toStored = (row: EventRow): StoredEvent => ({
  event: {
    seq: row.seq,
    id: row.id,
    stream: row.stream,
    type: row.type as EventType,
    actor: { userId: row.actor_user, position: row.actor_position as Position | 'system' },
    serverTime: iso(row.server_time),
    clientTime: row.client_time,
    ...(row.sim_time === null ? {} : { simTime: row.sim_time }),
    mode: row.mode as EventMode,
    ...(row.caused_by ? { causedBy: row.caused_by } : {}),
    payload: JSON.parse(row.payload),
    hash: row.hash,
  },
  audience: row.audience ? (JSON.parse(row.audience) as string[]) : null,
});

const hashed = (e: Omit<EventEnvelope, 'hash'>) => ({
  seq: e.seq,
  id: e.id,
  stream: e.stream,
  type: e.type,
  actor: e.actor,
  serverTime: e.serverTime,
  clientTime: e.clientTime,
  simTime: e.simTime ?? null,
  mode: e.mode,
  causedBy: e.causedBy ?? null,
  payload: e.payload,
});

const contentHash = (r: { stream: string; type: string; mode: string; payload: unknown; causedBy?: string; simTime?: number }) =>
  sha256Hex(canonicalJson({ stream: r.stream, type: r.type, mode: r.mode, payload: r.payload, causedBy: r.causedBy ?? null, simTime: r.simTime ?? null }));

export class EventLog {
  private readonly listeners = new Set<(stored: StoredEvent) => void>();

  private readonly db: Db;
  private readonly now: () => number;
  constructor(
    db: Db,
    now: () => number = Date.now,
  ) {
    this.db = db;
    this.now = now;
  }

  onAppend(listener: (stored: StoredEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  head(): number {
    return (this.db.prepare('select coalesce(max(seq), 0) as seq from events').get() as { seq: number }).seq;
  }

  /** Validate, authorize and append, or return the stored event for a repeated id. */
  append(actor: Actor, request: AppendRequest, opts: { system?: boolean } = {}): AppendResult {
    const req = this.check(request);
    const spec = EVENT_SPECS[req.type] as EventSpec;
    if (spec.serverOnly && !opts.system) throw new EventError(403, 'server_only', `${req.type} events are written by the server, not by clients`);
    if (spec.modes && !spec.modes.includes(req.mode)) throw new EventError(422, 'wrong_mode', `${req.type} is only allowed in ${spec.modes.join(' or ')} mode`);
    const payloadCheck = parse(spec.payload, req.payload, 'payload');
    if (!payloadCheck.ok) throw new EventError(400, 'invalid_payload', payloadCheck.errors[0]!, { errors: payloadCheck.errors });
    const payload = payloadCheck.value as Record<string, unknown>;
    const scope = scopeOfStream(req.stream);

    let stored: StoredEvent | null = null;
    let duplicate = false;
    transaction(this.db, () => {
      const existing = this.db.prepare('select * from events where id = ?').get(req.id) as EventRow | undefined;
      if (existing) {
        if (existing.content_hash !== contentHash({ ...req, payload }) || existing.actor_user !== actor.userId) {
          throw new EventError(409, 'id_reused', 'This event id was already used for a different event.');
        }
        stored = toStored(existing);
        duplicate = true;
        return;
      }
      const streamRow = this.db.prepare('select mode from streams where id = ?').get(req.stream) as { mode: string } | undefined;
      if (streamRow && streamRow.mode !== req.mode) {
        throw new EventError(409, 'mode_mismatch', `Stream ${req.stream} is a ${streamRow.mode} stream; ${req.mode} events go in their own stream.`);
      }

      // Assignment rules: compare-and-set, idempotent acknowledgement, and the unit for the permission check.
      const effect = this.assignmentEffect(req.type, payload, req.stream, actor);
      if (effect.duplicateOf) {
        stored = toStored(this.db.prepare('select * from events where seq = ?').get(effect.duplicateOf) as unknown as EventRow);
        duplicate = true;
        return;
      }
      const resource: Resource = { scope, ...effect.resource };
      const position = opts.system ? (req.asPosition ?? 'system') : this.authorize(actor, spec, resource, req.asPosition, req.type);

      if (!streamRow) this.db.prepare('insert into streams (id, scope, mode, created_at, created_by) values (?, ?, ?, ?, ?)').run(req.stream, scope, req.mode, this.now(), actor.userId);
      const head = this.db.prepare('select seq, hash from events order by seq desc limit 1').get() as { seq: number; hash: string } | undefined;
      const serverTime = this.now();
      const envelope: Omit<EventEnvelope, 'hash'> = {
        seq: (head?.seq ?? 0) + 1,
        id: req.id,
        stream: req.stream,
        type: req.type,
        actor: { userId: actor.userId, position: position as Position | 'system' },
        serverTime: iso(serverTime),
        clientTime: req.clientTime ?? null,
        ...(req.simTime === undefined ? {} : { simTime: req.simTime }),
        mode: req.mode,
        ...(req.causedBy ? { causedBy: req.causedBy } : {}),
        payload,
      };
      const prev = head?.hash ?? GENESIS_HASH;
      const hash = chainHash(prev, hashed(envelope));
      this.db
        .prepare(
          'insert into events (seq, id, stream, type, actor_user, actor_position, server_time, client_time, sim_time, mode, caused_by, payload, audience, content_hash, prev_hash, hash) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          envelope.seq, envelope.id, envelope.stream, envelope.type, actor.userId, String(position), serverTime, envelope.clientTime, req.simTime ?? null, req.mode,
          req.causedBy ?? null, canonicalJson(payload), effect.audience ? JSON.stringify(effect.audience) : null, contentHash({ ...req, payload }), prev, hash,
        );
      effect.apply?.(envelope.seq, serverTime, actor, String(position));
      stored = { event: { ...envelope, hash }, audience: effect.audience };
    });
    const result = stored as unknown as StoredEvent;
    if (!duplicate) for (const listener of this.listeners) listener(result);
    const warnings = spec.freeText ? warnFields(payload, spec.freeText) : [];
    return { event: result.event, duplicate, ...(warnings.length ? { warnings } : {}) };
  }

  private check(request: AppendRequest): AppendRequest {
    if (typeof request !== 'object' || request === null) throw new EventError(400, 'invalid_request', 'Expected an event object.');
    if (!isUuid(request.id)) throw new EventError(400, 'invalid_request', 'id must be a UUID chosen by the client (it is the idempotency key).');
    if (typeof request.stream !== 'string' || !STREAM_PATTERN.test(request.stream)) throw new EventError(400, 'invalid_request', 'stream must look like "event-id" or "event-id/period".');
    if (!(EVENT_TYPES as readonly string[]).includes(request.type)) throw new EventError(400, 'unknown_type', `unknown event type ${String(request.type)}`);
    if (!EVENT_MODES.includes(request.mode)) throw new EventError(400, 'invalid_request', 'mode must be plan, rehearse, exercise or live.');
    if (request.clientTime !== undefined && (typeof request.clientTime !== 'string' || !ISO_PATTERN.test(request.clientTime))) throw new EventError(400, 'invalid_request', 'clientTime must be RFC 3339.');
    if (request.simTime !== undefined && (typeof request.simTime !== 'number' || !Number.isFinite(request.simTime))) throw new EventError(400, 'invalid_request', 'simTime must be a number of sim seconds.');
    if (request.causedBy !== undefined && !isUuid(request.causedBy)) throw new EventError(400, 'invalid_request', 'causedBy must be an event id.');
    return request;
  }

  private authorize(actor: Actor, spec: EventSpec, resource: Resource, wanted: Position | undefined, type: string): Position {
    if (!can(actor, spec.permission, resource)) {
      throw new EventError(actor.kind === 'local' ? 401 : 403, 'forbidden', `Your position does not allow ${type} here.`, { permission: spec.permission });
    }
    const position = positionFor(actor, spec.permission, resource, wanted);
    if (!position) throw new EventError(403, 'forbidden', `You do not hold ${wanted} for ${type} here.`);
    return position;
  }

  private assignment(id: string): AssignmentState | null {
    const row = this.db.prepare('select state from assignments where id = ?').get(id) as { state: string } | undefined;
    return row ? (JSON.parse(row.state) as AssignmentState) : null;
  }

  private saveAssignment(state: AssignmentState): void {
    this.db.prepare('insert or replace into assignments (id, stream, version, state, updated_seq) values (?, ?, ?, ?, ?)').run(state.assignmentId, state.stream, state.version, JSON.stringify(state), state.updatedSeq);
  }

  private assignmentEffect(
    type: EventType,
    payload: Record<string, unknown>,
    stream: string,
    actor: Actor,
  ): { resource?: Resource; audience: string[] | null; duplicateOf?: number; apply?: (seq: number, at: number, actor: Actor, position: string) => void } {
    if (!type.startsWith('assignment.')) {
      if (type === 'unit.status') return { resource: { unit: payload.unit as string }, audience: null };
      return { audience: null };
    }
    const assignmentId = payload.assignmentId as string;
    const current = this.assignment(assignmentId);
    if (current && current.stream !== stream) throw new EventError(409, 'wrong_stream', `Assignment ${assignmentId} belongs to stream ${current.stream}.`);

    if (type === 'assignment.created') {
      const p = payload as EventPayloads['assignment.created'];
      if (current) throw new EventError(409, 'exists', `Assignment ${assignmentId} already exists.`, { current });
      return {
        resource: { unit: p.unit, division: p.division ?? null },
        audience: [p.unit],
        apply: (seq) =>
          this.saveAssignment({ assignmentId, stream, version: 1, unit: p.unit, division: p.division ?? null, task: p.task, place: p.place ?? null, priority: p.priority ?? 'routine', status: 'assigned', acknowledged: null, createdSeq: seq, updatedSeq: seq }),
      };
    }
    if (!current) throw new EventError(404, 'no_such_assignment', `There is no assignment ${assignmentId}.`);

    if (type === 'assignment.acknowledged' || type === 'assignment.completed') {
      const p = payload as EventPayloads['assignment.acknowledged'];
      if (type === 'assignment.acknowledged') {
        const prior = this.db.prepare('select event_seq from acknowledgements where assignment_id = ? and version = ? and user_id = ?').get(assignmentId, p.version, actor.userId) as { event_seq: number } | undefined;
        if (prior) return { audience: [current.unit], duplicateOf: prior.event_seq };
      }
      if (p.version !== current.version) {
        throw new EventError(409, 'version_conflict', `Assignment ${assignmentId} changed (now version ${current.version}) since version ${p.version} was shown.`, { current });
      }
      if (current.status === 'cancelled' || (type === 'assignment.completed' && current.status === 'completed')) {
        throw new EventError(409, 'invalid_state', `Assignment ${assignmentId} is ${current.status}.`, { current });
      }
      return {
        resource: { unit: current.unit, division: current.division },
        audience: [current.unit],
        apply: (seq, at, who, position) => {
          if (type === 'assignment.acknowledged') {
            this.db.prepare('insert into acknowledgements (assignment_id, version, user_id, event_seq) values (?, ?, ?, ?)').run(assignmentId, p.version, who.userId, seq);
            this.saveAssignment({ ...current, status: current.status === 'assigned' ? 'acknowledged' : current.status, acknowledged: { userId: who.userId, position, seq, at: iso(at) }, updatedSeq: seq });
          } else {
            this.saveAssignment({ ...current, status: 'completed', updatedSeq: seq });
          }
        },
      };
    }

    // updated, reassigned, cancelled: compare-and-set on the version the client saw.
    const expected = payload.expectedVersion as number;
    if (expected !== current.version) {
      throw new EventError(409, 'version_conflict', `Assignment ${assignmentId} is at version ${current.version}, not ${expected}. Someone changed it first.`, { current });
    }
    if (current.status === 'cancelled' || current.status === 'completed') throw new EventError(409, 'invalid_state', `Assignment ${assignmentId} is ${current.status}.`, { current });
    const next: AssignmentState = { ...current, version: current.version + 1 };
    let audience = [current.unit];
    if (type === 'assignment.updated') {
      const p = payload as EventPayloads['assignment.updated'];
      Object.assign(next, { task: p.task ?? current.task, place: p.place ?? current.place, priority: p.priority ?? current.priority, division: p.division ?? current.division, status: 'assigned', acknowledged: null });
    } else if (type === 'assignment.reassigned') {
      const p = payload as EventPayloads['assignment.reassigned'];
      Object.assign(next, { unit: p.unit, division: p.division ?? current.division, status: 'assigned', acknowledged: null });
      audience = [...new Set([current.unit, p.unit])];
    } else {
      next.status = 'cancelled';
    }
    return {
      resource: { unit: next.unit, division: next.division },
      audience,
      apply: (seq) => this.saveAssignment({ ...next, updatedSeq: seq }),
    };
  }

  /** The last seq in one stream (0 if empty). */
  streamHead(stream: string): number {
    return (this.db.prepare('select coalesce(max(seq), 0) as seq from events where stream = ?').get(stream) as { seq: number }).seq;
  }

  /** Events in a stream after `afterSeq`, oldest first. */
  since(stream: string, afterSeq = 0, limit = 500): StoredEvent[] {
    const rows = this.db.prepare('select * from events where stream = ? and seq > ? order by seq limit ?').all(stream, afterSeq, Math.min(Math.max(limit, 1), 5000)) as unknown as EventRow[];
    return rows.map(toStored);
  }

  bySeq(seq: number): StoredEvent | null {
    const row = this.db.prepare('select * from events where seq = ?').get(seq) as EventRow | undefined;
    return row ? toStored(row) : null;
  }

  streamMode(stream: string): EventMode | null {
    return ((this.db.prepare('select mode from streams where id = ?').get(stream) as { mode: string } | undefined)?.mode as EventMode) ?? null;
  }

  streams(scope?: string): { id: string; scope: string; mode: EventMode; createdAt: string }[] {
    const rows = (scope ? this.db.prepare('select * from streams where scope = ? order by id').all(scope) : this.db.prepare('select * from streams order by id').all()) as unknown as {
      id: string;
      scope: string;
      mode: string;
      created_at: number;
    }[];
    return rows.map((r) => ({ id: r.id, scope: r.scope, mode: r.mode as EventMode, createdAt: iso(r.created_at) }));
  }

  assignments(stream: string): AssignmentState[] {
    return (this.db.prepare('select state from assignments where stream = ? order by id').all(stream) as { state: string }[]).map((r) => JSON.parse(r.state) as AssignmentState);
  }

  getAssignment(id: string): AssignmentState | null {
    return this.assignment(id);
  }

  /** Recompute the event chain. */
  verify(): { ok: boolean; events: number; problems: { seq: number; kind: string }[] } {
    const problems: { seq: number; kind: string }[] = [];
    let prev = GENESIS_HASH;
    let n = 0;
    for (const row of this.db.prepare('select * from events order by seq').iterate() as Iterable<EventRow>) {
      n++;
      const { event } = toStored(row);
      if (row.prev_hash !== prev) problems.push({ seq: row.seq, kind: 'broken_link' });
      const { hash: _hash, ...rest } = event;
      if (chainHash(row.prev_hash, hashed(rest)) !== row.hash) problems.push({ seq: row.seq, kind: 'hash_mismatch' });
      prev = row.hash;
    }
    return { ok: problems.length === 0, events: n, problems };
  }
}

/**
 * Need-to-know on the stream: evaluator notes only for exercise control and
 * evaluation (and records); field units see their own assignments and the
 * few broadcast types; everyone else in the scope sees the rest.
 */
export function visibleTo(actor: Actor, stored: StoredEvent): boolean {
  const scope = scopeOfStream(stored.event.stream);
  if (!can(actor, 'event.read', { scope })) return false;
  const spec = EVENT_SPECS[stored.event.type] as EventSpec;
  const inScope = actor.grants.filter((g) => g.scope === '*' || g.scope === scope);
  if (spec.controlOnly) {
    return actor.kind === 'demo' || can(actor, 'exercise.evaluate', { scope }) || can(actor, 'exercise.control', { scope }) || inScope.some((g) => g.position === 'records');
  }
  const fieldOnly = actor.kind !== 'demo' && inScope.length > 0 && inScope.every((g) => g.position === 'field_unit');
  if (!fieldOnly) return true;
  if (!spec.fieldVisible) return stored.event.actor.userId === actor.userId;
  if (stored.audience) return inScope.some((g) => g.unit !== null && stored.audience!.includes(g.unit));
  if (stored.event.type === 'inject.released') {
    const to = (stored.event.payload as EventPayloads['inject.released']).to;
    return !to || to.includes('field_unit');
  }
  return true;
}
