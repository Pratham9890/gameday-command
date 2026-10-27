import type { Hono } from 'hono';
import { POSITIONS } from '../types.ts';
import type { Platform } from '../platform/platform.ts';
import { auditActor } from '../platform/platform.ts';
import { type AppEnv, fail, readBody } from '../platform/http.ts';
import { v } from '../platform/validate.ts';
import { deny } from '../platform/middleware.ts';
import { hashPassword, passwordProblems } from '../auth/password.ts';
import { SCOPE_PATTERN, USERNAME_PATTERN } from '../auth/users.ts';
import { HOST_PATTERN } from '../net/allowlist.ts';

/** Accounts, grants, sessions and the outbound allowlist: the System Administrator's routes. */
export function addAdminRoutes(app: Hono<AppEnv>, platform: Platform): void {
  const { users, sessions, audit, config } = platform;

  app.get('/api/v3/users', (c) => deny(c, platform, 'user.manage') ?? c.json(users.list()));

  app.post('/api/v3/users', async (c) => {
    const refused = deny(c, platform, 'user.manage');
    if (refused) return refused;
    const body = await readBody(c, v.object({ username: v.string({ pattern: USERNAME_PATTERN }), displayName: v.string({ min: 1, max: 80, trim: true }), password: v.string({ min: 1, max: 1024 }) }));
    if (!body.ok) return body.response;
    if (users.byUsername(body.value.username)) return fail(c, 409, 'exists', 'That username is taken.');
    const problems = passwordProblems(body.value.password, body.value.username);
    if (problems.length) return fail(c, 400, 'weak_password', problems.join(' '), { problems });
    const user = users.create({ username: body.value.username, displayName: body.value.displayName, passwordHash: await hashPassword(body.value.password, config.scrypt) });
    audit.append({ actor: auditActor(c.get('actor'), 'admin'), action: 'user.create', target: user.id, detail: { username: user.username } });
    return c.json(users.toPublic(user), 201);
  });

  app.patch('/api/v3/users/:id', async (c) => {
    const refused = deny(c, platform, 'user.manage');
    if (refused) return refused;
    const user = users.byId(c.req.param('id'));
    if (!user) return fail(c, 404, 'not_found', 'No such account.');
    const body = await readBody(c, v.object({ displayName: v.optional(v.string({ min: 1, max: 80, trim: true })), disabled: v.optional(v.boolean()) }));
    if (!body.ok) return body.response;
    if (body.value.disabled && user.id === c.get('actor')!.userId) return fail(c, 409, 'self', 'You cannot disable your own account.');
    users.update(user.id, { ...(body.value.displayName ? { display_name: body.value.displayName } : {}), ...(body.value.disabled === undefined ? {} : { disabled: body.value.disabled ? 1 : 0 }) });
    const ended = body.value.disabled ? sessions.revokeAllForUser(user.id, 'account disabled') : 0;
    if (body.value.disabled !== undefined) users.emitGrants(user.id);
    audit.append({ actor: auditActor(c.get('actor'), 'admin'), action: 'user.update', target: user.id, detail: { disabled: body.value.disabled ?? null, renamed: Boolean(body.value.displayName), sessionsEnded: ended } });
    return c.json(users.toPublic(users.byId(user.id)!));
  });

  app.post('/api/v3/users/:id/password', async (c) => {
    const refused = deny(c, platform, 'user.manage');
    if (refused) return refused;
    const user = users.byId(c.req.param('id'));
    if (!user) return fail(c, 404, 'not_found', 'No such account.');
    const body = await readBody(c, v.object({ password: v.string({ min: 1, max: 1024 }) }));
    if (!body.ok) return body.response;
    const problems = passwordProblems(body.value.password, user.username);
    if (problems.length) return fail(c, 400, 'weak_password', problems.join(' '), { problems });
    users.update(user.id, { password_hash: await hashPassword(body.value.password, config.scrypt) });
    const ended = sessions.revokeAllForUser(user.id, 'password reset by an administrator');
    audit.append({ actor: auditActor(c.get('actor'), 'admin'), action: 'auth.password.change', target: user.id, detail: { byAdmin: true, sessionsEnded: ended } });
    return c.json({ ok: true, sessionsEnded: ended });
  });

  app.delete('/api/v3/users/:id/mfa', (c) => {
    const refused = deny(c, platform, 'user.manage');
    if (refused) return refused;
    const user = users.byId(c.req.param('id'));
    if (!user) return fail(c, 404, 'not_found', 'No such account.');
    users.update(user.id, { totp_secret: null, totp_pending: null, totp_last_step: null });
    const ended = sessions.revokeAllForUser(user.id, 'two-factor reset');
    audit.append({ actor: auditActor(c.get('actor'), 'admin'), action: 'auth.mfa.reset', target: user.id, detail: { sessionsEnded: ended } });
    return c.json({ ok: true, sessionsEnded: ended });
  });

  app.get('/api/v3/grants', (c) => {
    const refused = deny(c, platform, 'grant.manage');
    if (refused) return refused;
    const userId = c.req.query('userId');
    return c.json(userId ? users.grants(userId) : users.grantsIn(c.req.query('scope') || undefined));
  });

  app.post('/api/v3/grants', async (c) => {
    const refused = deny(c, platform, 'grant.manage');
    if (refused) return refused;
    const body = await readBody(c, v.object({ userId: v.string({ min: 1, max: 80 }), position: v.literal(POSITIONS), scope: v.string({ pattern: SCOPE_PATTERN }), unit: v.optional(v.nullable(v.string({ min: 1, max: 60, trim: true }))) }));
    if (!body.ok) return body.response;
    if (!users.byId(body.value.userId)) return fail(c, 404, 'not_found', 'No such account.');
    if ((body.value.position === 'admin' || body.value.position === 'records') && body.value.scope !== '*') return fail(c, 400, 'global_position', `${body.value.position} is held in scope * only.`);
    const grant = users.grant({ ...body.value, grantedBy: c.get('actor')!.userId });
    audit.append({ actor: auditActor(c.get('actor'), 'admin'), action: 'grant.create', target: grant.id, detail: { userId: grant.userId, position: grant.position, scope: grant.scope, unit: grant.unit } });
    return c.json(grant, 201);
  });

  app.delete('/api/v3/grants/:id', (c) => {
    const refused = deny(c, platform, 'grant.manage');
    if (refused) return refused;
    const grant = users.revokeGrant(c.req.param('id'), c.get('actor')!.userId);
    if (!grant) return fail(c, 404, 'not_found', 'No such active grant.');
    audit.append({ actor: auditActor(c.get('actor'), 'admin'), action: 'grant.revoke', target: grant.id, detail: { userId: grant.userId, position: grant.position, scope: grant.scope } });
    return c.json({ ok: true });
  });

  app.get('/api/v3/sessions', (c) => {
    const refused = deny(c, platform, 'session.revoke');
    if (refused) return refused;
    return c.json(sessions.list(c.req.query('userId') || undefined, c.req.query('all') === '1'));
  });

  app.delete('/api/v3/sessions/:id', (c) => {
    const refused = deny(c, platform, 'session.revoke');
    if (refused) return refused;
    const target = sessions.byId(c.req.param('id'));
    if (!target || !sessions.revoke(target.id, 'revoked by an administrator')) return fail(c, 404, 'not_found', 'No such live session.');
    audit.append({ actor: auditActor(c.get('actor'), 'admin'), action: 'session.revoke', target: target.id, detail: { userId: target.user_id } });
    return c.json({ ok: true });
  });

  app.get('/api/v3/feeds/allowlist', (c) => deny(c, platform, 'allowlist.manage') ?? c.json(platform.allowlist.list()));

  app.post('/api/v3/feeds/allowlist', async (c) => {
    const refused = deny(c, platform, 'allowlist.manage');
    if (refused) return refused;
    const body = await readBody(c, v.object({ host: v.string({ min: 3, max: 253, trim: true }), ports: v.optional(v.array(v.number({ int: true, min: 1, max: 65535 }), { max: 8 })), httpsOnly: v.optional(v.boolean()), note: v.optional(v.string({ max: 200 })) }));
    if (!body.ok) return body.response;
    if (!HOST_PATTERN.test(body.value.host.toLowerCase())) return fail(c, 400, 'invalid_host', 'host must be a DNS name (optionally *.domain) or an IPv4 address.');
    const entry = platform.allowlist.add({ ...body.value, addedBy: c.get('actor')!.userId });
    audit.append({ actor: auditActor(c.get('actor'), 'admin'), action: 'allowlist.add', target: entry.host, detail: { ports: entry.ports.join(','), httpsOnly: entry.httpsOnly } });
    return c.json(entry, 201);
  });

  app.delete('/api/v3/feeds/allowlist/:host', (c) => {
    const refused = deny(c, platform, 'allowlist.manage');
    if (refused) return refused;
    const host = decodeURIComponent(c.req.param('host'));
    if (!platform.allowlist.remove(host)) return fail(c, 404, 'not_found', 'That host is not on the allowlist.');
    audit.append({ actor: auditActor(c.get('actor'), 'admin'), action: 'allowlist.remove', target: host });
    return c.json({ ok: true });
  });
}
