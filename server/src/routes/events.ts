import type { Hono } from 'hono';
import type { AppendRequest } from '../types.ts';
import type { Platform } from '../platform/platform.ts';
import { type AppEnv, fail, readBody } from '../platform/http.ts';
import { scopeOfStream, STREAM_PATTERN, v } from '../platform/validate.ts';
import { deny } from '../platform/middleware.ts';
import { can } from '../auth/rbac.ts';
import { EventError, visibleTo } from '../events/log.ts';

/** REST access to the event log; the WebSocket hub carries the same envelopes live. */
export function addEventRoutes(app: Hono<AppEnv>, platform: Platform): void {
  const { events } = platform;

  const streamOf = (raw: string | undefined) => (raw && STREAM_PATTERN.test(raw) ? raw : null);

  app.get('/api/v3/streams', (c) => {
    const actor = c.get('actor');
    const scope = c.req.query('scope') || undefined;
    const refused = deny(c, platform, 'event.read', { scope });
    if (refused) return refused;
    return c.json(events.streams(scope).filter((s) => can(actor, 'event.read', { scope: s.scope })));
  });

  app.get('/api/v3/events', (c) => {
    const stream = streamOf(c.req.query('stream'));
    if (!stream) return fail(c, 400, 'invalid_stream', 'Give ?stream=<event-id>[/<period>].');
    const refused = deny(c, platform, 'event.read', { scope: scopeOfStream(stream) });
    if (refused) return refused;
    const since = Math.max(0, Number(c.req.query('since') ?? 0) || 0);
    const limit = Math.min(1000, Math.max(1, Number(c.req.query('limit') ?? 500) || 500));
    const batch = events.since(stream, since, limit);
    const actor = c.get('actor')!;
    return c.json({
      stream,
      mode: events.streamMode(stream),
      events: batch.filter((stored) => visibleTo(actor, stored)).map((s) => s.event),
      // Continue from here, even if the last events were not yours to see.
      lastSeq: batch.at(-1)?.event.seq ?? since,
      more: batch.length === limit,
    });
  });

  app.post('/api/v3/events', async (c) => {
    const body = await readBody(c, v.object({}, { extra: true }));
    if (!body.ok) return body.response;
    const actor = c.get('actor');
    const request = body.value as unknown as AppendRequest;
    const scope = typeof request.stream === 'string' && STREAM_PATTERN.test(request.stream) ? scopeOfStream(request.stream) : undefined;
    if (!actor) return deny(c, platform, 'event.read', { scope })!;
    if (c.get('session')?.stage === 'mfa_enrolment') return deny(c, platform, 'event.read', { scope })!;
    try {
      const result = events.append(actor, request);
      return c.json(result, result.duplicate ? 200 : 201);
    } catch (error) {
      if (error instanceof EventError) return fail(c, error.status, error.code, error.message, error.extra);
      throw error;
    }
  });

  app.get('/api/v3/assignments', (c) => {
    const stream = streamOf(c.req.query('stream'));
    if (!stream) return fail(c, 400, 'invalid_stream', 'Give ?stream=<event-id>[/<period>].');
    const scope = scopeOfStream(stream);
    const refused = deny(c, platform, 'event.read', { scope });
    if (refused) return refused;
    const actor = c.get('actor')!;
    const inScope = actor.grants.filter((g) => g.scope === scope || g.scope === '*');
    const fieldOnly = actor.kind !== 'demo' && inScope.length > 0 && inScope.every((g) => g.position === 'field_unit');
    const units = new Set(inScope.map((g) => g.unit).filter(Boolean));
    return c.json(events.assignments(stream).filter((a) => !fieldOnly || units.has(a.unit)));
  });

  app.get('/api/v3/presence', (c) => {
    const stream = streamOf(c.req.query('stream'));
    if (!stream) return fail(c, 400, 'invalid_stream', 'Give ?stream=<event-id>[/<period>].');
    const refused = deny(c, platform, 'event.read', { scope: scopeOfStream(stream) });
    if (refused) return refused;
    return c.json(platform.hub?.presenceFor(stream) ?? []);
  });
}
