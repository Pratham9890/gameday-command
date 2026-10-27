import type { Hono } from 'hono';
import type { SessionInfo } from '../types.ts';
import { CONTRACT_VERSION } from '../../../contracts.ts';
import { EVENT_TYPES, PACKAGE_SCHEMA_VERSION, PLATFORM_API_VERSION, POSITION_LABELS, POSITIONS, PRODUCT_KINDS } from '../types.ts';
import type { Platform } from '../platform/platform.ts';
import { auditActor } from '../platform/platform.ts';
import { type AppEnv, type Ctx, fail, readBody } from '../platform/http.ts';
import { iso } from '../platform/canonical.ts';
import { v } from '../platform/validate.ts';
import { deny } from '../platform/middleware.ts';
import { DEMO_POSITIONS, GLOBAL_ONLY, permissionsByScope, ROLE_PERMISSIONS } from '../auth/rbac.ts';
import { sessionCookie, type SessionRow } from '../auth/sessions.ts';
import { newTotpSecret, otpauthUri, verifyTotp } from '../auth/totp.ts';
import { hashPassword, passwordProblems, verifyPassword } from '../auth/password.ts';
import { DISPLAY_USER_PREFIX } from '../auth/display.ts';
import { EVENT_SPECS } from '../events/registry.ts';

/** Sign-in, sessions, MFA enrolment, display pairing, and the public health and meta routes. */
export function sessionInfo(c: Ctx, platform: Platform, override?: { session: SessionRow }): SessionInfo {
  const { config } = platform;
  const session = override?.session ?? c.get('session');
  const actor = override ? platform.actorForSession(override.session) : c.get('actor');
  const mode = platform.authMode();
  const user = actor && actor.kind === 'user' ? platform.users.byId(actor.userId) : undefined;
  const local = c.get('via') === 'local';
  return {
    authenticated: Boolean(actor) && !local,
    mode,
    setupRequired: mode === 'setup',
    demo: config.demo ? { label: 'Public demo — synthetic data. No sign-in; nothing here is agency data.' } : null,
    user: actor && !local ? { id: actor.userId, username: actor.username, displayName: actor.displayName, mfaEnrolled: Boolean(user?.totp_secret), kind: actor.kind } : null,
    grants: actor && !local ? actor.grants : [],
    permissions: actor && !local ? permissionsByScope(actor) : {},
    stage: session ? session.stage : actor && !local ? 'full' : null,
    csrfToken: session?.csrf ?? null,
    absoluteExpiresAt: session ? iso(session.expires_at) : null,
    idleExpiresAt: session ? iso(Math.min(session.expires_at, session.last_seen_at + platform.sessions.idleMs)) : null,
    serverTime: iso(platform.now()),
    policy: { absoluteHours: config.session.absoluteMs / 3_600_000, idleMinutes: config.session.idleMs / 60_000, mfa: config.mfa },
  };
}

const loginBody = v.object({ username: v.string({ min: 1, max: 80, trim: true }), password: v.string({ min: 1, max: 1024 }), totp: v.optional(v.string({ max: 12, trim: true })) });

export function addAuthRoutes(app: Hono<AppEnv>, platform: Platform): void {
  const { config, users, sessions, limiter, audit } = platform;

  const issue = (c: Ctx, userId: string, kind: 'user' | 'display', stage: 'full' | 'mfa_enrolment') => {
    const prior = c.get('session');
    if (prior) sessions.revoke(prior.id, 'replaced at sign-in');
    const { token, session } = sessions.create(userId, kind, stage);
    c.header('set-cookie', sessionCookie(token, (session.expires_at - session.created_at) / 1000, config.secureCookies), { append: true });
    return session;
  };

  app.get('/api/v3/health', (c) =>
    c.json({
      ok: true,
      apiVersion: PLATFORM_API_VERSION,
      mode: platform.authMode(),
      demo: config.demo,
      setupRequired: platform.authMode() === 'setup',
      tls: Boolean(config.tls),
      feeds: { weather: platform.weather.enabled ? 'on' : 'off' },
      serverTime: iso(platform.now()),
    }),
  );

  app.get('/api/v3/meta', (c) =>
    c.json({
      apiVersion: PLATFORM_API_VERSION,
      contractVersion: CONTRACT_VERSION,
      packageSchemaVersion: PACKAGE_SCHEMA_VERSION,
      positions: POSITIONS.map((id) => ({ id, label: POSITION_LABELS[id], permissions: ROLE_PERMISSIONS[id] })),
      globalOnlyPermissions: [...GLOBAL_ONLY],
      demoPositions: DEMO_POSITIONS,
      eventTypes: EVENT_TYPES.map((type) => {
        const spec = EVENT_SPECS[type];
        return { type, permission: spec.permission, modes: spec.modes ?? null, serverOnly: Boolean(spec.serverOnly), freeText: spec.freeText ?? [], controlOnly: Boolean(spec.controlOnly) };
      }),
      productKinds: PRODUCT_KINDS,
      identityProviders: platform.identity.list(),
    }),
  );

  app.get('/api/v3/auth/session', (c) => c.json(sessionInfo(c, platform)));
  app.get('/api/v3/auth/providers', (c) => c.json(platform.identity.list()));

  app.get('/api/v3/auth/oidc/:provider/start', (c) =>
    fail(c, 501, 'not_configured', 'Single sign-on is not configured on this server. See docs/v3/deploy.md (OIDC) and server/src/auth/identity.ts.'),
  );

  app.post('/api/v3/auth/login', async (c) => {
    if (config.demo) return fail(c, 409, 'demo_mode', 'This is the public demo: there are no accounts and no sign-in.');
    if (platform.authMode() === 'setup') return fail(c, 503, 'setup_required', 'No accounts exist yet. On the server, run: npm run admin:create');
    const body = await readBody(c, loginBody);
    if (!body.ok) return body.response;
    const { username, password, totp } = body.value;
    const address = c.get('address');
    const wait = limiter.retryAfterS(username, address);
    if (wait > 0) {
      c.header('retry-after', String(wait));
      return fail(c, 429, 'rate_limited', `Too many failed sign-ins. Try again in ${wait} s.`, { retryAfterS: wait });
    }
    const failed = (reason: string, userId: string | null, status: 401 | 403 = 401, error = 'invalid_credentials', message = 'Wrong username or password.') => {
      limiter.fail(username, address);
      audit.append({ actor: { userId, name: userId ? username : null, position: null }, action: 'auth.login', target: userId ?? 'unknown-account', outcome: 'failure', detail: { reason, lockedOut: limiter.retryAfterS(username, address) > 0 } });
      return fail(c, status, error, message);
    };

    const verified = await platform.identity.password().verify(username, password);
    if (!verified) return failed('bad_password', users.byUsername(username)?.id ?? null);
    const user = verified.user;
    if (user.disabled) return failed('disabled', user.id);
    if (user.totp_secret) {
      if (!totp) return fail(c, 401, 'mfa_required', 'Enter the six-digit code from your authenticator app.', { mfa: 'totp' });
      const step = verifyTotp(user.totp_secret, totp, platform.now(), { lastStep: user.totp_last_step });
      if (step === null) return failed('bad_totp', user.id, 401, 'invalid_mfa', 'That code is wrong or was already used.');
      users.update(user.id, { totp_last_step: step });
    }
    if (verified.needsRehash) users.update(user.id, { password_hash: await hashPassword(password, config.scrypt) });
    const stage = user.totp_secret || config.mfa === 'optional' ? 'full' : 'mfa_enrolment';
    const session = issue(c, user.id, 'user', stage);
    limiter.succeed(username);
    audit.append({ actor: { userId: user.id, name: user.username, position: null }, action: 'auth.login', target: user.id, detail: { mfa: Boolean(user.totp_secret), stage, session: session.id } });
    return c.json(sessionInfo(c, platform, { session }));
  });

  app.post('/api/v3/auth/logout', (c) => {
    const session = c.get('session');
    if (session) {
      sessions.revoke(session.id, 'signed out');
      audit.append({ actor: auditActor(c.get('actor')), action: 'auth.logout', target: session.id });
    }
    c.header('set-cookie', sessionCookie('', 0, config.secureCookies), { append: true });
    return c.json({ ok: true });
  });

  app.post('/api/v3/auth/logout-all', (c) => {
    const session = c.get('session');
    if (!session || session.kind !== 'user') return fail(c, 401, 'unauthenticated', 'Sign in first.');
    const n = sessions.revokeAllForUser(session.user_id, 'signed out everywhere');
    audit.append({ actor: auditActor(c.get('actor')), action: 'auth.logout', target: session.user_id, detail: { everywhere: true, sessions: n } });
    c.header('set-cookie', sessionCookie('', 0, config.secureCookies), { append: true });
    return c.json({ ok: true, sessions: n });
  });

  const ownUser = (c: Ctx) => {
    const session = c.get('session');
    return session && session.kind === 'user' ? users.byId(session.user_id) : undefined;
  };

  app.post('/api/v3/auth/mfa/totp/setup', (c) => {
    const user = ownUser(c);
    if (!user) return fail(c, 401, 'unauthenticated', 'Sign in first.');
    if (user.totp_secret) return fail(c, 409, 'already_enrolled', 'Two-factor sign-in is already set up. An administrator can reset it.');
    const secret = newTotpSecret();
    users.update(user.id, { totp_pending: secret });
    return c.json({ secret, otpauthUri: otpauthUri(secret, user.username), algorithm: 'SHA1', digits: 6, periodS: 30 });
  });

  app.post('/api/v3/auth/mfa/totp/confirm', async (c) => {
    const user = ownUser(c);
    if (!user) return fail(c, 401, 'unauthenticated', 'Sign in first.');
    if (!user.totp_pending) return fail(c, 409, 'no_pending_setup', 'Start with POST /api/v3/auth/mfa/totp/setup.');
    const body = await readBody(c, v.object({ code: v.string({ min: 6, max: 12, trim: true }) }));
    if (!body.ok) return body.response;
    const wait = limiter.retryAfterS(user.username, c.get('address'));
    if (wait > 0) return fail(c, 429, 'rate_limited', `Too many wrong codes. Try again in ${wait} s.`, { retryAfterS: wait });
    const step = verifyTotp(user.totp_pending, body.value.code, platform.now());
    if (step === null) {
      limiter.fail(user.username, c.get('address'));
      return fail(c, 401, 'invalid_mfa', 'That code is wrong. Check the time on your phone and try the next code.');
    }
    users.update(user.id, { totp_secret: user.totp_pending, totp_pending: null, totp_last_step: step });
    const session = issue(c, user.id, 'user', 'full');
    audit.append({ actor: { userId: user.id, name: user.username, position: null }, action: 'auth.mfa.enrol', target: user.id, detail: { method: 'totp' } });
    return c.json(sessionInfo(c, platform, { session }));
  });

  app.post('/api/v3/auth/password', async (c) => {
    const user = ownUser(c);
    if (!user || c.get('session')?.stage !== 'full') return fail(c, 401, 'unauthenticated', 'Sign in first.');
    const body = await readBody(c, v.object({ current: v.string({ min: 1, max: 1024 }), next: v.string({ min: 1, max: 1024 }) }));
    if (!body.ok) return body.response;
    if (!user.password_hash || !(await verifyPassword(body.value.current, user.password_hash, config.scrypt)).ok) {
      limiter.fail(user.username, c.get('address'));
      return fail(c, 401, 'invalid_credentials', 'The current password is wrong.');
    }
    const problems = passwordProblems(body.value.next, user.username);
    if (problems.length) return fail(c, 400, 'weak_password', problems.join(' '), { problems });
    users.update(user.id, { password_hash: await hashPassword(body.value.next, config.scrypt) });
    const ended = sessions.revokeAllForUser(user.id, 'password changed', c.get('session')!.id);
    audit.append({ actor: auditActor(c.get('actor')), action: 'auth.password.change', target: user.id, detail: { otherSessionsEnded: ended } });
    return c.json({ ok: true, otherSessionsEnded: ended });
  });

  // ── Wallboards ─────────────────────────────────────────────

  app.post('/api/v3/auth/display', async (c) => {
    if (config.demo) return fail(c, 409, 'demo_mode', 'The public demo needs no pairing.');
    const body = await readBody(c, v.object({ code: v.string({ min: 6, max: 20, trim: true }) }));
    if (!body.ok) return body.response;
    const address = c.get('address');
    const wait = limiter.retryAfterS('display-pairing', address);
    if (wait > 0) return fail(c, 429, 'rate_limited', `Too many wrong codes. Try again in ${wait} s.`, { retryAfterS: wait });
    const grant = platform.displays.pair(body.value.code);
    if (!grant) {
      limiter.fail('display-pairing', address);
      return fail(c, 401, 'invalid_code', 'That pairing code is wrong, used or expired.');
    }
    const session = issue(c, `${DISPLAY_USER_PREFIX}${grant.id}`, 'display', 'full');
    audit.append({ actor: { userId: `${DISPLAY_USER_PREFIX}${grant.id}`, name: grant.label, position: 'display' }, action: 'display.pair', target: grant.id, detail: { scope: grant.scope } });
    return c.json(sessionInfo(c, platform, { session }));
  });

  app.get('/api/v3/display-grants', (c) => {
    const scope = c.req.query('scope');
    const refused = deny(c, platform, 'display.manage', { scope });
    if (refused) return refused;
    return c.json(platform.displays.list(scope));
  });

  app.post('/api/v3/display-grants', async (c) => {
    const body = await readBody(c, v.object({ scope: v.string({ min: 1, max: 64, pattern: /^[a-z0-9][a-z0-9._-]*$/ }), label: v.string({ min: 1, max: 80, trim: true }) }));
    if (!body.ok) return body.response;
    const refused = deny(c, platform, 'display.manage', { scope: body.value.scope });
    if (refused) return refused;
    const actor = c.get('actor')!;
    const { grant, code } = platform.displays.create({ ...body.value, createdBy: actor.userId });
    audit.append({ actor: auditActor(actor), action: 'display.create', target: grant.id, detail: { scope: grant.scope } });
    return c.json({ grant, code, expiresInS: 600, pair: 'POST /api/v3/auth/display {"code": "..."} from the wallboard' }, 201);
  });

  app.delete('/api/v3/display-grants/:id', (c) => {
    const grant = platform.displays.get(c.req.param('id'));
    if (!grant) return fail(c, 404, 'not_found', 'No such display grant.');
    const refused = deny(c, platform, 'display.manage', { scope: grant.scope });
    if (refused) return refused;
    platform.displays.revoke(grant.id);
    const ended = sessions.revokeAllForUser(`${DISPLAY_USER_PREFIX}${grant.id}`, 'display grant revoked');
    audit.append({ actor: auditActor(c.get('actor')), action: 'display.revoke', target: grant.id, detail: { sessionsEnded: ended } });
    return c.json({ ok: true, sessionsEnded: ended });
  });
}
