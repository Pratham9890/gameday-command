import type { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Permission, Resource } from '../types.ts';
import type { Platform } from './platform.ts';
import { auditActor } from './platform.ts';
import { type AppEnv, clientAddress, type Ctx, fail, isLoopbackAddress, originAllowed, SAFE_METHODS } from './http.ts';
import { safeEqual } from './canonical.ts';
import { clearSessionCookie, cookieName } from '../auth/sessions.ts';
import { can, demoActor, localActor } from '../auth/rbac.ts';

/**
 * Who is calling, and may they? Runs before every /api route.
 *
 * 1. Demo mode: everyone is the labelled demo user.
 * 2. A session cookie: the account (or wallboard) it belongs to, if the
 *    session is still inside both deadlines.
 * 3. No accounts yet (first run) and a loopback caller: the local operator,
 *    who may use the v2 routes exactly as before and nothing in /api/v3.
 *
 * Then, for every write: refuse cross-site requests (Sec-Fetch-Site, Origin),
 * and for cookie sessions require the session's CSRF token in X-CSRF-Token.
 */
const CSRF_EXEMPT = new Set([
  '/api/v3/auth/login',
  '/api/v3/auth/display',
  // Called by the engine worker, which has the cookie but not the token. Both only compute; both still need a same-origin request.
  '/api/decide',
  '/api/briefing',
]);

const PROBLEM_TEXT: Record<string, string> = {
  idle: 'timed out after a period of inactivity',
  expired: 'reached its time limit',
  revoked: 'was ended',
  unknown: 'is not valid',
};

export function installAuth(app: Hono<AppEnv>, platform: Platform): void {
  const { config, sessions } = platform;

  app.use('/api/*', async (c, next) => {
    const address = clientAddress(c, config.trustProxy);
    c.set('address', address);
    c.set('mode', platform.authMode());
    c.set('session', null);
    c.set('sessionProblem', null);
    let clearCookie = false;
    if (config.demo) {
      c.set('actor', demoActor());
      c.set('via', 'demo');
    } else {
      c.set('actor', null);
      c.set('via', 'none');
      const token = getCookie(c, cookieName(config.secureCookies));
      if (token) {
        const resolved = sessions.resolve(token);
        const actor = resolved.state === 'ok' ? platform.actorForSession(resolved.session) : null;
        if (resolved.state === 'ok' && actor) {
          c.set('actor', actor);
          c.set('via', 'cookie');
          c.set('session', resolved.session);
        } else {
          c.set('sessionProblem', PROBLEM_TEXT[resolved.state] ?? PROBLEM_TEXT.revoked!);
          clearCookie = true;
          if (resolved.state === 'idle' || resolved.state === 'expired') {
            platform.audit.append({ actor: { userId: resolved.session?.user_id ?? null, name: null, position: null }, action: 'session.expire', target: resolved.session?.id ?? null, detail: { reason: resolved.state } });
          }
        }
      }
      if (!c.get('actor') && c.get('mode') === 'setup' && isLoopbackAddress(address)) {
        c.set('actor', localActor());
        c.set('via', 'local');
      }
    }

    if (!SAFE_METHODS.has(c.req.method)) {
      if (c.req.header('sec-fetch-site') === 'cross-site') return fail(c, 403, 'cross_site', 'Cross-site requests are refused.');
      const origin = c.req.header('origin');
      if (origin && !originAllowed(origin, c.req.header('host'), config.allowedOrigins)) return fail(c, 403, 'bad_origin', `Requests from ${origin} are not allowed.`);
      if (c.get('via') === 'cookie' && !CSRF_EXEMPT.has(c.req.path)) {
        const token = c.req.header('x-csrf-token');
        if (!token || !safeEqual(token, c.get('session')!.csrf)) return fail(c, 403, 'csrf', 'Missing or wrong X-CSRF-Token header. Read it from GET /api/v3/auth/session.');
      }
    }

    await next();
    // Clear a dead cookie, unless this response already issued a new one (a sign-in).
    if (clearCookie && !(c.res.headers.get('set-cookie') ?? '').includes(`${cookieName(config.secureCookies)}=`)) {
      c.header('set-cookie', clearSessionCookie(config.secureCookies), { append: true });
    }
  });

  // The first-run local operator exists for the v2 routes only.
  app.use('/api/v3/*', async (c, next) => {
    if (c.get('via') === 'local') {
      c.set('actor', null);
      c.set('via', 'none');
    }
    await next();
  });
}

/**
 * The permission check every route makes: null if allowed, else the response
 * to return (503 before setup, 401 without a session, 403 without the
 * position). Refusals to signed-in accounts are audited.
 */
export function deny(c: Ctx, platform: Platform, action: Permission, resource: Resource = {}): Response | null {
  const actor = c.get('actor');
  if (can(actor, action, resource)) return null;
  if (!actor) {
    if (c.get('mode') === 'setup') return fail(c, 503, 'setup_required', 'No accounts exist yet. On the server, run: npm run admin:create');
    const problem = c.get('sessionProblem');
    return fail(c, 401, 'unauthenticated', problem ? `Your session ${problem}. Sign in again.` : 'Sign in first.');
  }
  if (c.get('session')?.stage === 'mfa_enrolment') return fail(c, 403, 'mfa_enrolment_required', 'Set up two-factor sign-in first (POST /api/v3/auth/mfa/totp/setup).');
  if (actor.kind === 'user' || actor.kind === 'display') {
    platform.audit.append({ actor: auditActor(actor), action: 'access.denied', target: c.req.path.slice(0, 120), outcome: 'denied', detail: { permission: action, scope: resource.scope ?? null, method: c.req.method } });
  }
  return fail(c, 403, 'forbidden', `Your position does not allow ${action}${resource.scope ? ` in ${resource.scope}` : ''}.`, { permission: action });
}

/** The v2 routes and the permission each needs. Anything under /api not listed here and not in /api/v3 is refused. */
export const LEGACY_RULES: { method: 'GET' | 'POST'; path: RegExp; permission: Permission | null }[] = [
  { method: 'GET', path: /^\/api\/health$/, permission: null },
  { method: 'GET', path: /^\/api\/maps$/, permission: 'legacy.read' },
  { method: 'GET', path: /^\/api\/maps\/[^/]+$/, permission: 'legacy.read' },
  { method: 'GET', path: /^\/api\/decision-defaults$/, permission: 'legacy.read' },
  { method: 'POST', path: /^\/api\/decide$/, permission: 'legacy.compute' },
  { method: 'GET', path: /^\/api\/plans$/, permission: 'plan.read' },
  { method: 'POST', path: /^\/api\/plans$/, permission: 'plan.write' },
  { method: 'POST', path: /^\/api\/comparisons$/, permission: 'comparison.write' },
  { method: 'GET', path: /^\/api\/comparisons\/[^/]+$/, permission: 'comparison.read' },
  { method: 'POST', path: /^\/api\/briefing$/, permission: 'legacy.compute' },
  { method: 'GET', path: /^\/api\/stadiums\/search$/, permission: 'stadium.import' },
  { method: 'POST', path: /^\/api\/stadiums\/import$/, permission: 'stadium.import' },
  { method: 'GET', path: /^\/api\/history$/, permission: 'legacy.read' },
  { method: 'POST', path: /^\/api\/history$/, permission: 'legacy.write' },
  { method: 'GET', path: /^\/api\/feedback$/, permission: 'legacy.read' },
  { method: 'POST', path: /^\/api\/feedback$/, permission: 'legacy.write' },
  { method: 'POST', path: /^\/api\/conditions\/fetch$/, permission: 'feed.read' },
];

export function installLegacyGuard(app: Hono<AppEnv>, platform: Platform): void {
  app.use('/api/*', async (c, next) => {
    const path = c.req.path;
    if (path === '/api/v3' || path.startsWith('/api/v3/')) return next();
    const method = c.req.method === 'HEAD' ? 'GET' : c.req.method;
    const rule = LEGACY_RULES.find((r) => r.method === method && r.path.test(path));
    if (!rule) return fail(c, 404, 'not_found', 'No such route.');
    if (rule.permission) {
      const refused = deny(c, platform, rule.permission);
      if (refused) return refused;
    }
    return next();
  });
}
