import type { Hono } from 'hono';
import { AUDIT_ACTIONS } from '../types.ts';
import type { Platform } from '../platform/platform.ts';
import { auditActor } from '../platform/platform.ts';
import { type AppEnv, readBody } from '../platform/http.ts';
import { ID_PATTERN, v } from '../platform/validate.ts';
import { deny } from '../platform/middleware.ts';
import { positionFor } from '../auth/rbac.ts';

/**
 * The security audit log over HTTP, and the hook the vision workstream calls
 * whenever a video feed is opened or closed (PLT-10: video-feed views are
 * audited, start and stop).
 */
export function addAuditRoutes(app: Hono<AppEnv>, platform: Platform): void {
  const { audit } = platform;

  app.get('/api/v3/audit', (c) => {
    const refused = deny(c, platform, 'audit.read');
    if (refused) return refused;
    const action = c.req.query('action');
    return c.json(audit.list({ sinceSeq: Number(c.req.query('since') ?? 0) || 0, limit: Number(c.req.query('limit') ?? 200) || 200, action: action && (AUDIT_ACTIONS as readonly string[]).includes(action) ? action : undefined }));
  });

  app.get('/api/v3/audit/verify', (c) => {
    const refused = deny(c, platform, 'audit.verify');
    if (refused) return refused;
    const result = audit.verify();
    const events = platform.events.verify();
    audit.append({ actor: auditActor(c.get('actor')), action: 'audit.verify', outcome: result.ok && events.ok ? 'success' : 'failure', detail: { entries: result.entries, problems: result.problems.length, eventProblems: events.problems.length } });
    return c.json({ ...result, eventLog: events, publicKey: audit.publicKey });
  });

  app.get('/api/v3/audit/checkpoints', (c) => deny(c, platform, 'audit.read') ?? c.json({ publicKey: audit.publicKey, checkpoints: audit.checkpoints() }));

  app.post('/api/v3/audit/checkpoints', (c) => {
    const refused = deny(c, platform, 'audit.checkpoint');
    if (refused) return refused;
    audit.append({ actor: auditActor(c.get('actor')), action: 'audit.checkpoint' });
    return c.json(audit.checkpoint(), 201);
  });

  app.post('/api/v3/audit/video-views', async (c) => {
    const body = await readBody(c, v.object({ scope: v.string({ pattern: ID_PATTERN }), feedId: v.string({ min: 1, max: 80, pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]*$/ }), action: v.literal(['start', 'stop'] as const), zones: v.optional(v.number({ int: true, min: 0, max: 10_000 })) }));
    if (!body.ok) return body.response;
    const refused = deny(c, platform, 'video.view', { scope: body.value.scope });
    if (refused) return refused;
    const actor = c.get('actor')!;
    const entry = audit.append({
      actor: auditActor(actor, positionFor(actor, 'video.view', { scope: body.value.scope })),
      action: body.value.action === 'start' ? 'video.view.start' : 'video.view.stop',
      target: body.value.feedId,
      detail: { scope: body.value.scope, zones: body.value.zones ?? null },
    });
    return c.json({ seq: entry.seq, at: entry.at }, 201);
  });
}
