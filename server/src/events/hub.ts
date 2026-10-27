import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket, type RawData } from 'ws';
import type { Actor, AppendRequest, ClientFrame, PresenceEntry, Position, ServerFrame } from '../types.ts';
import { EVENT_PROTOCOL } from '../types.ts';
import type { Platform } from '../platform/platform.ts';
import type { SessionRow } from '../auth/sessions.ts';
import { cookieName, readCookie } from '../auth/sessions.ts';
import { can, demoActor } from '../auth/rbac.ts';
import { TokenBucket } from '../auth/ratelimit.ts';
import { iso } from '../platform/canonical.ts';
import { originAllowed } from '../platform/http.ts';
import { scopeOfStream, STREAM_PATTERN } from '../platform/validate.ts';
import { EventError, type StoredEvent, visibleTo } from './log.ts';

/**
 * The WebSocket hub at /api/v3/events (research 06 §3, PLT-19).
 *
 * - Authenticated at the handshake: the session cookie (or demo mode), with
 *   an Origin check against cross-site WebSocket hijacking.
 * - `subscribe` with `since` replays everything after that seq from the log,
 *   then streams live events, filtered by `visibleTo` (need-to-know).
 * - Presence per position, with "last heard" from a heartbeat (ping every
 *   15 s; a socket that misses a pong is dropped). No GPS: status is reported.
 * - Backpressure: the log is the buffer. A slow socket is not queued in
 *   memory: sending pauses while its buffer is over the high-water mark and
 *   resumes from the last seq it was sent. Past a hard limit it is closed
 *   (1013) and the client reconnects and replays.
 * - A revoked or expired session closes its sockets at once (4401); a grant
 *   change re-checks every subscription (4403 for the ones now forbidden).
 */
export interface HubOptions {
  heartbeatMs?: number;
  highWaterBytes?: number;
  hardLimitBytes?: number;
  maxPayloadBytes?: number;
  path?: string;
}

interface Subscription {
  lastSent: number;
  pumping: boolean;
  replayed: boolean;
}

interface Client {
  id: string;
  ws: WebSocket;
  actor: Actor;
  session: SessionRow | null;
  subs: Map<string, Subscription>;
  alive: boolean;
  bucket: TokenBucket;
  presence: Map<string, PresenceEntry>;
  strikes: number;
  /** Pumps waiting for the send buffer to drain. */
  waiting: (() => void)[];
}

export const CLOSE = { revoked: 4401, forbidden: 4403, slow: 1013, policy: 1008, shutdown: 1001 } as const;

export class EventHub {
  private readonly wss: WebSocketServer;
  private readonly clients = new Set<Client>();
  private readonly streamHead = new Map<string, number>();
  private readonly heartbeatMs: number;
  private readonly highWater: number;
  private readonly hardLimit: number;
  private readonly path: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticks = 0;
  private readonly unsubscribers: (() => void)[] = [];
  /** Counters for tests and the health view: how often backpressure paused a socket, how many were closed for being slow or silent. */
  readonly stats = { paused: 0, slowClosed: 0, deadDropped: 0, revokedClosed: 0 };

  private readonly platform: Platform;
  constructor(
    platform: Platform,
    opts: HubOptions = {},
  ) {
    this.platform = platform;
    this.heartbeatMs = opts.heartbeatMs ?? 15_000;
    this.highWater = opts.highWaterBytes ?? 1024 * 1024;
    this.hardLimit = opts.hardLimitBytes ?? 8 * 1024 * 1024;
    this.path = opts.path ?? '/api/v3/events';
    this.wss = new WebSocketServer({ noServer: true, maxPayload: opts.maxPayloadBytes ?? 256 * 1024, perMessageDeflate: false });
    this.unsubscribers.push(
      platform.events.onAppend((stored) => this.onAppend(stored)),
      platform.sessions.onRevoked((session, reason) => this.dropSession(session.id, reason)),
      platform.users.onGrantsChanged((userId) => this.recheck(userId)),
    );
    this.timer = setInterval(() => this.heartbeat(), this.heartbeatMs);
    this.timer.unref?.();
    platform.hub = this;
  }

  attach(server: Server): void {
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (!this.handleUpgrade(req, socket, head)) refuse(socket, 404, 'Not Found');
    });
  }

  get size(): number {
    return this.clients.size;
  }

  presenceFor(stream: string): PresenceEntry[] {
    const out: PresenceEntry[] = [];
    for (const client of this.clients) {
      const entry = client.presence.get(stream);
      if (entry) out.push(entry);
    }
    return out.sort((a, b) => a.position.localeCompare(b.position) || a.displayName.localeCompare(b.displayName));
  }

  /** Returns false if the URL is not ours; otherwise answers (accepting or refusing). */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== this.path) return false;
    const { config, sessions } = this.platform;
    const origin = req.headers.origin;
    if (origin && !originAllowed(origin, req.headers.host, config.allowedOrigins)) {
      refuse(socket, 403, 'Forbidden');
      return true;
    }
    let actor: Actor | null = null;
    let session: SessionRow | null = null;
    if (config.demo) actor = demoActor();
    else {
      const resolved = sessions.resolve(readCookie(req.headers.cookie, cookieName(config.secureCookies)));
      if (resolved.state === 'ok' && resolved.session.stage === 'full') {
        actor = this.platform.actorForSession(resolved.session);
        if (actor) session = resolved.session;
      }
    }
    if (!actor) {
      refuse(socket, 401, 'Unauthorized');
      return true;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws, actor!, session));
    return true;
  }

  private accept(ws: WebSocket, actor: Actor, session: SessionRow | null): void {
    const client: Client = { id: randomUUID(), ws, actor, session, subs: new Map(), alive: true, bucket: new TokenBucket(60, 20, this.platform.now), presence: new Map(), strikes: 0, waiting: [] };
    this.clients.add(client);
    ws.on('pong', () => this.heard(client));
    ws.on('message', (data) => this.onMessage(client, data));
    ws.on('close', () => this.remove(client));
    ws.on('error', () => this.remove(client));
    this.send(client, {
      t: 'hello',
      protocol: EVENT_PROTOCOL,
      serverTime: iso(this.platform.now()),
      demo: actor.kind === 'demo',
      actor: { userId: actor.userId, displayName: actor.displayName, grants: actor.grants },
      heartbeatMs: this.heartbeatMs,
    });
  }

  private remove(client: Client): void {
    if (!this.clients.delete(client)) return;
    for (const stream of client.presence.keys()) this.broadcastPresence(stream);
  }

  private send(client: Client, frame: ServerFrame): boolean {
    if (client.ws.readyState !== client.ws.OPEN) return false;
    // The callback runs once this frame is handed to the kernel: the moment to resume a paused pump.
    client.ws.send(JSON.stringify(frame), () => this.flushed(client));
    if (client.ws.bufferedAmount > this.hardLimit) {
      this.stats.slowClosed++;
      client.ws.close(CLOSE.slow, 'too far behind; reconnect and replay from your last seq');
      return false;
    }
    return true;
  }

  private flushed(client: Client): void {
    if (!client.waiting.length || client.ws.bufferedAmount > this.highWater / 2) return;
    const resume = client.waiting.splice(0);
    for (const fn of resume) fn();
  }

  /** Run `fn` when the socket has drained below half the high-water mark (or after a second, whichever is first). */
  private whenDrained(client: Client, fn: () => void): void {
    let done = false;
    const once = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(once, 1000);
    client.waiting.push(once);
  }

  private heard(client: Client): void {
    client.alive = true;
    const now = iso(this.platform.now());
    for (const entry of client.presence.values()) entry.lastHeard = now;
    // A wallboard has nobody touching it: its heartbeat is what keeps its read-only session alive.
    if (client.session?.kind === 'display') this.platform.sessions.touch(client.session);
  }

  private onMessage(client: Client, data: RawData): void {
    this.heard(client);
    if (!client.bucket.take()) {
      client.strikes++;
      this.send(client, { t: 'error', error: 'rate_limited', message: 'Too many messages; slow down.' });
      if (client.strikes > 20) client.ws.close(CLOSE.policy, 'rate limit');
      return;
    }
    let frame: ClientFrame;
    try {
      frame = JSON.parse(data.toString()) as ClientFrame;
    } catch {
      this.send(client, { t: 'error', error: 'invalid_json', message: 'Frames are JSON objects.' });
      return;
    }
    if (client.session) {
      const state = this.platform.sessions.check(client.session, client.session.kind === 'user').state;
      if (state !== 'ok') {
        this.dropSession(client.session.id, state);
        return;
      }
    }
    switch (frame?.t) {
      case 'subscribe':
        return this.subscribe(client, frame.stream, frame.since);
      case 'unsubscribe':
        client.subs.delete(frame.stream);
        if (client.presence.delete(frame.stream)) this.broadcastPresence(frame.stream);
        return;
      case 'append':
        return this.append(client, frame.event);
      case 'presence':
        return this.announce(client, frame.stream, frame.position, frame.status ?? 'online');
      case 'ping': {
        const received = this.platform.now();
        this.send(client, { t: 'pong', id: String(frame.id ?? ''), clientTime: Number(frame.clientTime) || 0, serverReceived: received, serverSent: this.platform.now() });
        return;
      }
      default:
        this.send(client, { t: 'error', error: 'unknown_frame', message: 'Unknown frame type.' });
    }
  }

  private subscribe(client: Client, stream: string, since?: number): void {
    if (typeof stream !== 'string' || !STREAM_PATTERN.test(stream)) {
      this.send(client, { t: 'error', error: 'invalid_stream', message: 'Not a stream id.', stream: String(stream) });
      return;
    }
    if (!can(client.actor, 'event.read', { scope: scopeOfStream(stream) })) {
      this.send(client, { t: 'error', error: 'forbidden', message: 'You hold no position in this event.', stream });
      return;
    }
    const from = Number.isInteger(since) && since! >= 0 ? since! : 0;
    client.subs.set(stream, { lastSent: from, pumping: false, replayed: false });
    this.send(client, { t: 'subscribed', stream, since: from });
    const position = this.defaultPosition(client.actor, stream);
    if (position) this.announce(client, stream, position, 'online', false);
    this.send(client, { t: 'presence', stream, entries: this.presenceFor(stream) });
    this.pump(client, stream);
  }

  private defaultPosition(actor: Actor, stream: string): Position | null {
    const scope = scopeOfStream(stream);
    return actor.grants.find((g) => g.scope === scope)?.position ?? actor.grants.find((g) => g.scope === '*')?.position ?? null;
  }

  private announce(client: Client, stream: string, position: Position, status: 'online' | 'away', reply = true): void {
    const scope = scopeOfStream(stream);
    const grant = client.actor.grants.find((g) => g.position === position && (g.scope === scope || g.scope === '*'));
    if (!client.subs.has(stream) || !grant || !can(client.actor, 'event.read', { scope })) {
      if (reply) this.send(client, { t: 'error', error: 'forbidden', message: 'You do not hold that position here, or are not subscribed.', stream });
      return;
    }
    const now = iso(this.platform.now());
    const prior = client.presence.get(stream);
    client.presence.set(stream, {
      stream,
      userId: client.actor.userId,
      displayName: client.actor.displayName,
      position,
      unit: grant.unit,
      status,
      since: prior && prior.position === position ? prior.since : now,
      lastHeard: now,
    });
    this.broadcastPresence(stream);
  }

  private broadcastPresence(stream: string): void {
    const entries = this.presenceFor(stream);
    for (const client of this.clients) if (client.subs.has(stream)) this.send(client, { t: 'presence', stream, entries });
  }

  private append(client: Client, request: AppendRequest): void {
    const id = typeof request?.id === 'string' ? request.id : '';
    try {
      const result = this.platform.events.append(client.actor, request);
      this.send(client, { t: 'ack', id, seq: result.event.seq, duplicate: result.duplicate, ...(result.warnings ? { warnings: result.warnings } : {}) });
    } catch (error) {
      if (error instanceof EventError) this.send(client, { t: 'nack', id, status: error.status, error: error.code, message: error.message, ...(error.extra.current ? { current: error.extra.current } : {}) });
      else this.send(client, { t: 'nack', id, status: 500, error: 'internal', message: 'The server could not store the event.' });
    }
  }

  private onAppend(stored: StoredEvent): void {
    const stream = stored.event.stream;
    const previous = this.streamHead.get(stream);
    this.streamHead.set(stream, stored.event.seq);
    for (const client of this.clients) {
      const sub = client.subs.get(stream);
      if (!sub) continue;
      // Fast path: the client is caught up to the event before this one, and its socket has room.
      if (!sub.pumping && sub.replayed && previous !== undefined && sub.lastSent >= previous && client.ws.bufferedAmount <= this.highWater) {
        sub.lastSent = stored.event.seq;
        if (visibleTo(client.actor, stored)) this.send(client, { t: 'event', event: stored.event });
      } else {
        this.pump(client, stream);
      }
    }
  }

  /** Send everything after `lastSent` from the log, pausing while the socket is over the high-water mark. */
  private pump(client: Client, stream: string): void {
    const sub = client.subs.get(stream);
    if (!sub || sub.pumping) return;
    sub.pumping = true;
    const step = () => {
      const current = client.subs.get(stream);
      if (current !== sub || client.ws.readyState !== client.ws.OPEN) return;
      const batch = this.platform.events.since(stream, sub.lastSent, 200);
      for (const stored of batch) {
        // Over the high-water mark: stop here, remember where, and look again shortly.
        if (client.ws.bufferedAmount > this.highWater) {
          this.stats.paused++;
          this.whenDrained(client, step);
          return;
        }
        sub.lastSent = stored.event.seq;
        if (visibleTo(client.actor, stored) && !this.send(client, { t: 'event', event: stored.event })) return;
      }
      if (batch.length === 200) {
        setImmediate(step);
        return;
      }
      sub.pumping = false;
      if (!sub.replayed) {
        sub.replayed = true;
        this.send(client, { t: 'replayed', stream, lastSeq: sub.lastSent });
      }
      if (!this.streamHead.has(stream)) this.streamHead.set(stream, this.platform.events.streamHead(stream));
      // An event may have landed while we were reading; catch it.
      const head = this.streamHead.get(stream)!;
      if (head > sub.lastSent) this.pump(client, stream);
    };
    step();
  }

  private heartbeat(): void {
    this.ticks++;
    for (const client of [...this.clients]) {
      if (!client.alive) {
        this.stats.deadDropped++;
        client.ws.terminate();
        this.remove(client);
        continue;
      }
      if (client.session) {
        const state = this.platform.sessions.check(client.session).state;
        if (state !== 'ok') {
          this.dropSession(client.session.id, state);
          continue;
        }
      }
      client.alive = false;
      client.ws.ping();
    }
    if (this.ticks % 4 === 0) {
      const streams = new Set<string>();
      for (const client of this.clients) for (const stream of client.presence.keys()) streams.add(stream);
      for (const stream of streams) this.broadcastPresence(stream);
    }
  }

  private dropSession(sessionId: string, reason: string): void {
    for (const client of [...this.clients]) {
      if (client.session?.id !== sessionId) continue;
      this.send(client, { t: 'revoked', reason });
      this.stats.revokedClosed++;
      client.ws.close(CLOSE.revoked, `session ${reason}`.slice(0, 120));
      this.remove(client);
    }
  }

  private recheck(userId: string): void {
    for (const client of [...this.clients]) {
      if (client.actor.userId !== userId || !client.session) continue;
      const actor = this.platform.actorForSession(client.session);
      if (!actor) {
        this.dropSession(client.session.id, 'account changed');
        continue;
      }
      client.actor = actor;
      for (const stream of [...client.subs.keys()]) {
        if (can(client.actor, 'event.read', { scope: scopeOfStream(stream) })) continue;
        client.subs.delete(stream);
        client.presence.delete(stream);
        this.send(client, { t: 'error', error: 'forbidden', message: 'Your positions changed; this stream is no longer yours to see.', stream });
        this.broadcastPresence(stream);
      }
      if (client.subs.size === 0 && client.actor.grants.length === 0) client.ws.close(CLOSE.forbidden, 'no positions');
    }
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    for (const client of this.clients) client.ws.close(CLOSE.shutdown, 'server shutting down');
    this.clients.clear();
    this.wss.close();
    if (this.platform.hub === this) this.platform.hub = null;
  }
}

function refuse(socket: Duplex, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}
