import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { AppendRequest, ServerFrame } from '../types.ts';
import { openDb } from '../db.ts';
import { testConfig } from '../platform/config.ts';
import { startServer, type RunningServer } from '../server.ts';
import { addUser } from '../testing.ts';
import { CLOSE } from './hub.ts';

const running: RunningServer[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  for (const server of running.splice(0)) await server.close();
});

async function boot(hub = {}) {
  const server = await startServer({ db: openDb(':memory:'), config: testConfig({ mfa: 'optional' }), port: 0, host: '127.0.0.1', hub: { heartbeatMs: 200, ...hub } });
  running.push(server);
  return server;
}

interface Conn {
  ws: WebSocket;
  frames: ServerFrame[];
  send(frame: unknown): void;
  waitFor<T extends ServerFrame>(pred: (f: ServerFrame) => boolean, ms?: number): Promise<T>;
  closed: Promise<{ code: number; reason: string }>;
}

function connect(server: RunningServer, cookie: string | null, headers: Record<string, string> = {}): Promise<Conn> {
  const ws = new WebSocket(`${server.url.replace('http', 'ws')}/api/v3/events`, { headers: { ...(cookie ? { cookie } : {}), origin: server.url, ...headers } });
  sockets.push(ws);
  const frames: ServerFrame[] = [];
  const waiters: { pred: (f: ServerFrame) => boolean; done: (f: ServerFrame) => void }[] = [];
  ws.on('message', (data) => {
    const frame = JSON.parse(data.toString()) as ServerFrame;
    frames.push(frame);
    for (const w of [...waiters]) if (w.pred(frame)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.done(frame);
    }
  });
  const closed = new Promise<{ code: number; reason: string }>((done) => ws.on('close', (code, reason) => done({ code, reason: reason.toString() })));
  const conn: Conn = {
    ws,
    frames,
    closed,
    send: (frame) => ws.send(JSON.stringify(frame)),
    waitFor: (pred, ms = 5000) =>
      new Promise((done, fail) => {
        const hit = frames.find(pred);
        if (hit) return done(hit as never);
        const timer = setTimeout(() => fail(new Error(`timed out; frames: ${frames.map((f) => f.t).join(',')}`)), ms);
        waiters.push({ pred, done: (f) => (clearTimeout(timer), done(f as never)) });
      }),
  };
  return new Promise((done, fail) => {
    ws.once('open', () => done(conn));
    ws.once('unexpected-response', (_req, res) => fail(new Error(`HTTP ${res.statusCode}`)));
    ws.once('error', fail);
  });
}

async function sessionCookie(server: RunningServer, username: string, grants: Parameters<typeof addUser>[2]) {
  const user = await addUser(server.platform, username, grants);
  const { token, session } = server.platform.sessions.create(user.id);
  return { cookie: `gd_session=${token}`, user, session };
}

const note = (text: string, stream = 'osu-2026/op-1'): AppendRequest => ({ id: randomUUID(), stream, type: 'note.logged', mode: 'live', payload: { text } });

describe('the WebSocket hub', () => {
  it('refuses a handshake without a session, or from another origin', async () => {
    const server = await boot();
    await expect(connect(server, null)).rejects.toThrow(/401/);
    const { cookie } = await sessionCookie(server, 'ops.one', [{ position: 'operations_chief' }]);
    await expect(connect(server, cookie, { origin: 'https://evil.example' })).rejects.toThrow(/403/);
    const ok = await connect(server, cookie);
    const hello = await ok.waitFor((f) => f.t === 'hello');
    expect(hello).toMatchObject({ protocol: 'gameday.events.1', demo: false, heartbeatMs: 200 });
  });

  it('replays since a seq, then streams live events, with acks and idempotent retries', async () => {
    const server = await boot();
    const { cookie, user } = await sessionCookie(server, 'ops.one', [{ position: 'operations_chief' }]);
    const actor = server.platform.users.actorFor(user);
    for (let i = 1; i <= 5; i++) server.platform.events.append(actor, note(`before ${i}`));
    const conn = await connect(server, cookie);
    conn.send({ t: 'subscribe', stream: 'osu-2026/op-1', since: 2 });
    const replayed = await conn.waitFor((f) => f.t === 'replayed');
    expect(replayed).toMatchObject({ lastSeq: 5 });
    expect(conn.frames.filter((f) => f.t === 'event').map((f) => (f as { event: { seq: number } }).event.seq)).toEqual([3, 4, 5]);

    const request = note('over the socket');
    conn.send({ t: 'append', event: request });
    const ack = await conn.waitFor((f) => f.t === 'ack');
    expect(ack).toMatchObject({ id: request.id, seq: 6, duplicate: false });
    await conn.waitFor((f) => f.t === 'event' && f.event.seq === 6);
    conn.send({ t: 'append', event: request });
    await conn.waitFor((f) => f.t === 'ack' && f.duplicate);
    expect(server.platform.events.head()).toBe(6);

    conn.send({ t: 'append', event: { ...note('x'), type: 'assignment.updated', payload: { assignmentId: 'nope', expectedVersion: 1 } } });
    const nack = await conn.waitFor((f) => f.t === 'nack');
    expect(nack).toMatchObject({ status: 404, error: 'no_such_assignment' });
  });

  it('shows who holds which position, and answers clock pings', async () => {
    const server = await boot();
    const a = await sessionCookie(server, 'ops.one', [{ position: 'operations_chief' }]);
    const b = await sessionCookie(server, 'unit.12', [{ position: 'field_unit', unit: 'OSU PD 12' }]);
    const ops = await connect(server, a.cookie);
    const unit = await connect(server, b.cookie);
    ops.send({ t: 'subscribe', stream: 'osu-2026/op-1' });
    unit.send({ t: 'subscribe', stream: 'osu-2026/op-1' });
    const presence = await ops.waitFor((f) => f.t === 'presence' && f.entries.length === 2);
    expect((presence as { entries: { position: string; unit: string | null }[] }).entries.map((e) => [e.position, e.unit])).toEqual([
      ['field_unit', 'OSU PD 12'],
      ['operations_chief', null],
    ]);
    unit.ws.close();
    await ops.waitFor((f) => f.t === 'presence' && f.entries.length === 1);
    const t0 = Date.now();
    ops.send({ t: 'ping', id: 'p1', clientTime: t0 });
    const pong = await ops.waitFor((f) => f.t === 'pong');
    expect(pong).toMatchObject({ id: 'p1', clientTime: t0 });
    expect((pong as { serverReceived: number }).serverReceived).toBeGreaterThanOrEqual(t0 - 5);
  });

  it('streams a field unit only its own assignments', async () => {
    const server = await boot();
    const ops = await sessionCookie(server, 'ops.one', [{ position: 'operations_chief' }]);
    const u = await sessionCookie(server, 'unit.12', [{ position: 'field_unit', unit: 'OSU PD 12' }]);
    const unit = await connect(server, u.cookie);
    unit.send({ t: 'subscribe', stream: 'osu-2026/op-1' });
    await unit.waitFor((f) => f.t === 'replayed');
    const opsActor = server.platform.users.actorFor(ops.user);
    const assign = (id: string, unitName: string) =>
      server.platform.events.append(opsActor, { id: randomUUID(), stream: 'osu-2026/op-1', type: 'assignment.created', mode: 'live', payload: { assignmentId: id, unit: unitName, task: 'post' } });
    assign('a14', 'OSU PD 14');
    assign('a12', 'OSU PD 12');
    server.platform.events.append(opsActor, note('staff only'));
    await unit.waitFor((f) => f.t === 'event' && (f.event.payload as { assignmentId?: string }).assignmentId === 'a12');
    await new Promise((r) => setTimeout(r, 100));
    expect(unit.frames.filter((f) => f.t === 'event').map((f) => (f as { event: { payload: { assignmentId?: string } } }).event.payload.assignmentId)).toEqual(['a12']);
  });

  it('closes the socket the moment its session is revoked', async () => {
    const server = await boot();
    const { cookie, session } = await sessionCookie(server, 'ops.one', [{ position: 'operations_chief' }]);
    const conn = await connect(server, cookie);
    conn.send({ t: 'subscribe', stream: 'osu-2026/op-1' });
    await conn.waitFor((f) => f.t === 'replayed');
    server.platform.sessions.revoke(session.id, 'revoked by an administrator');
    const closed = await conn.closed;
    expect(closed.code).toBe(CLOSE.revoked);
    expect(conn.frames.some((f) => f.t === 'revoked')).toBe(true);
    await expect(connect(server, cookie)).rejects.toThrow(/401/);
  });

  it('drops a subscription when the grant behind it is revoked', async () => {
    const server = await boot();
    const { cookie, user } = await sessionCookie(server, 'pio.one', [{ position: 'pio' }, { position: 'pio', scope: 'msu-2026' }]);
    const conn = await connect(server, cookie);
    conn.send({ t: 'subscribe', stream: 'osu-2026/op-1' });
    await conn.waitFor((f) => f.t === 'replayed');
    const grant = server.platform.users.grants(user.id).find((g) => g.scope === 'osu-2026')!;
    server.platform.users.revokeGrant(grant.id, 'admin');
    const error = await conn.waitFor((f) => f.t === 'error');
    expect(error).toMatchObject({ error: 'forbidden', stream: 'osu-2026/op-1' });
    conn.send({ t: 'subscribe', stream: 'osu-2026/op-1' });
    await conn.waitFor((f) => f.t === 'error' && (f as { message: string }).message.includes('no position'));
  });

  it('applies backpressure from the log instead of buffering, and loses nothing', async () => {
    // A long heartbeat: a paused socket would otherwise (rightly) be dropped as dead.
    const server = await boot({ highWaterBytes: 16 * 1024, heartbeatMs: 60_000 });
    const { cookie, user } = await sessionCookie(server, 'ops.one', [{ position: 'operations_chief' }]);
    const actor = server.platform.users.actorFor(user);
    const conn = await connect(server, cookie);
    conn.send({ t: 'subscribe', stream: 'osu-2026/op-1' });
    await conn.waitFor((f) => f.t === 'replayed');
    // Stop reading: the kernel buffers fill, then the server's send buffer passes the high-water mark.
    (conn.ws as unknown as { _socket: { pause(): void; resume(): void } })._socket.pause();
    const N = 1500;
    const filler = 'x'.repeat(3000);
    for (let i = 0; i < N; i++) server.platform.events.append(actor, note(`${i} ${filler}`));
    await new Promise((r) => setTimeout(r, 300));
    expect(server.hub.stats.paused).toBeGreaterThan(0);
    (conn.ws as unknown as { _socket: { resume(): void } })._socket.resume();
    await conn.waitFor((f) => f.t === 'event' && f.event.seq === N, 20_000);
    const seqs = conn.frames.filter((f) => f.t === 'event').map((f) => (f as { event: { seq: number } }).event.seq);
    expect(seqs).toEqual(Array.from({ length: N }, (_, i) => i + 1));
  }, 30_000);

  it('drops a socket that stops answering the heartbeat', async () => {
    const server = await boot({ heartbeatMs: 100 });
    const { cookie } = await sessionCookie(server, 'ops.one', [{ position: 'operations_chief' }]);
    const conn = await connect(server, cookie);
    conn.send({ t: 'subscribe', stream: 'osu-2026/op-1' });
    await conn.waitFor((f) => f.t === 'replayed');
    expect(server.hub.size).toBe(1);
    (conn.ws as unknown as { _socket: { pause(): void } })._socket.pause();
    await new Promise((r) => setTimeout(r, 450));
    expect(server.hub.size).toBe(0);
    expect(server.hub.stats.deadDropped).toBe(1);
  });

  it('serves the same stream to the demo user without a sign-in', async () => {
    const server = await startServer({ db: openDb(':memory:'), config: testConfig({ demo: true }), port: 0, host: '127.0.0.1' });
    running.push(server);
    const conn = await connect(server, null);
    expect(await conn.waitFor((f) => f.t === 'hello')).toMatchObject({ demo: true });
    conn.send({ t: 'subscribe', stream: 'demo-event' });
    await conn.waitFor((f) => f.t === 'replayed');
    conn.send({ t: 'append', event: note('demo note', 'demo-event') });
    await conn.waitFor((f) => f.t === 'event');
  });
});
