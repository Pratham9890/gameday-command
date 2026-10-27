import { describe, expect, it } from 'vitest';
import { addUser, client, codeFor, makeApp, PASSWORD, signIn } from '../testing.ts';
import { createAdmin } from '../platform/platform.ts';
import { testConfig } from '../platform/config.ts';
import { openDb } from '../db.ts';
import { createApp, platformOf } from '../index.ts';

const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('first run and modes', () => {
  it('starts with no accounts and no default password, and says how to make the first one', async () => {
    const { app, platform } = makeApp();
    expect(platform.users.count()).toBe(0);
    const session = await (await app.request('/api/v3/auth/session')).json();
    expect(session).toMatchObject({ mode: 'setup', setupRequired: true, authenticated: false });
    const login = await app.request('/api/v3/auth/login', json({ username: 'admin', password: 'admin' }));
    expect(login.status).toBe(503);
    expect((await app.request('/api/v3/documents')).status).toBe(503);
    // The v2 routes keep working for this (loopback, in-process) caller.
    expect((await app.request('/api/maps')).status).toBe(200);
  });

  it('bootstraps the first administrator, refusing weak passwords', async () => {
    const { platform } = makeApp();
    await expect(createAdmin(platform, { username: 'admin', password: 'admin' }, 'cli')).rejects.toThrow(/at least 12/);
    const { userId } = await createAdmin(platform, { username: 'chief.admin', password: PASSWORD }, 'cli');
    expect(platform.users.grants(userId).map((g) => [g.position, g.scope])).toEqual([['admin', '*']]);
    expect(platform.audit.list({ action: 'admin.bootstrap' })).toHaveLength(1);
    expect(platform.authMode()).toBe('accounts');
  });

  it('closes the v2 routes to callers without a session once accounts exist', async () => {
    const { app, platform } = makeApp();
    await addUser(platform, 'ic.one', [{ position: 'incident_commander' }]);
    expect((await app.request('/api/maps')).status).toBe(401);
    expect((await app.request('/api/decision-defaults')).status).toBe(401);
    const ic = await signIn(app, 'ic.one');
    expect((await ic.get('/api/maps')).status).toBe(200);
    expect((await app.request('/api/health')).status).toBe(200);
  });

  it('demo mode keeps the no-sign-in experience, clearly labelled', async () => {
    const { app } = makeApp({ demo: true });
    const session = await (await app.request('/api/v3/auth/session')).json();
    expect(session.mode).toBe('demo');
    expect(session.demo.label).toMatch(/synthetic/i);
    expect(session.user.kind).toBe('demo');
    expect((await app.request('/api/maps')).status).toBe(200);
    expect((await app.request('/api/v3/auth/login', json({ username: 'x', password: 'y' }))).status).toBe(409);
    expect((await app.request('/api/v3/users')).status).toBe(403);
  });
});

describe('sign-in and cookies', () => {
  it('sets an HttpOnly, SameSite=Strict session cookie and returns the CSRF token', async () => {
    const { app, platform } = makeApp();
    await addUser(platform, 'ops.chief', [{ position: 'operations_chief' }]);
    const res = await app.request('/api/v3/auth/login', json({ username: 'ops.chief', password: PASSWORD }));
    expect(res.status).toBe(200);
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^gd_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=43200$/);
    const info = await res.json();
    expect(info).toMatchObject({ authenticated: true, mode: 'accounts', stage: 'full' });
    expect(info.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(info.permissions['osu-2026']).toContain('assignment.write');
    // The database holds a hash of the token, never the token.
    const token = /gd_session=([^;]+)/.exec(cookie)![1]!;
    expect(JSON.stringify(platform.db.prepare('select * from sessions').all())).not.toContain(token);
  });

  it('marks the cookie Secure with the __Host- prefix over TLS', async () => {
    const { app, platform } = makeApp({ secureCookies: true });
    await addUser(platform, 'ops.chief', [{ position: 'operations_chief' }]);
    const res = await app.request('/api/v3/auth/login', json({ username: 'ops.chief', password: PASSWORD }));
    expect(res.headers.get('set-cookie')).toMatch(/^__Host-gd_session=[^;]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+; Secure$/);
    expect(res.headers.get('strict-transport-security')).toBe('max-age=31536000');
  });

  it('gives one answer for a wrong password and an unknown account', async () => {
    const { app, platform } = makeApp();
    await addUser(platform, 'ops.chief', [{ position: 'operations_chief' }]);
    const wrong = await app.request('/api/v3/auth/login', json({ username: 'ops.chief', password: 'not the password!' }));
    const unknown = await app.request('/api/v3/auth/login', json({ username: 'nobody.here', password: 'not the password!' }));
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await wrong.json()).toEqual(await unknown.json());
    const failures = platform.audit.list({ action: 'auth.login' });
    expect(failures.map((e) => [e.outcome, e.target])).toEqual([
      ['failure', platform.users.byUsername('ops.chief')!.id],
      ['failure', 'unknown-account'],
    ]);
    // What was typed is never logged.
    expect(JSON.stringify(failures)).not.toContain('not the password');
  });

  it('rate-limits sign-in: 429 with Retry-After after five failures', async () => {
    const { app, platform, clock } = makeApp();
    await addUser(platform, 'ops.chief', [{ position: 'operations_chief' }]);
    for (let i = 0; i < 5; i++) expect((await app.request('/api/v3/auth/login', json({ username: 'ops.chief', password: 'wrong wrong wrong' }))).status).toBe(401);
    const locked = await app.request('/api/v3/auth/login', json({ username: 'ops.chief', password: PASSWORD }));
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(800);
    clock.advance(16 * 60_000);
    expect((await app.request('/api/v3/auth/login', json({ username: 'ops.chief', password: PASSWORD }))).status).toBe(200);
  });

  it('refuses a disabled account', async () => {
    const { app, platform } = makeApp();
    const user = await addUser(platform, 'gone.user', [{ position: 'pio' }]);
    platform.users.update(user.id, { disabled: 1 });
    expect((await app.request('/api/v3/auth/login', json({ username: 'gone.user', password: PASSWORD }))).status).toBe(401);
  });
});

describe('sessions: deadlines and revocation', () => {
  it('ends a session after the idle limit, and keeps it alive while used', async () => {
    const { app, platform, clock } = makeApp({ session: { absoluteMs: 12 * 3_600_000, idleMs: 30 * 60_000 } });
    await addUser(platform, 'pio.one', [{ position: 'pio' }]);
    const pio = await signIn(app, 'pio.one');
    for (let i = 0; i < 6; i++) {
      clock.advance(20 * 60_000);
      expect((await pio.get('/api/v3/feeds/weather')).status).toBe(200);
    }
    clock.advance(31 * 60_000);
    const res = await pio.get('/api/v3/feeds/weather');
    expect(res.status).toBe(401);
    expect((await res.json()).message).toMatch(/inactivity/);
    expect(platform.audit.list({ action: 'session.expire' })).toHaveLength(1);
  });

  it('ends a session at the absolute limit however busy it is', async () => {
    const { app, platform, clock } = makeApp({ session: { absoluteMs: 2 * 3_600_000, idleMs: 60 * 60_000 } });
    await addUser(platform, 'pio.one', [{ position: 'pio' }]);
    const pio = await signIn(app, 'pio.one');
    for (let i = 0; i < 7; i++) {
      clock.advance(17 * 60_000);
      expect((await pio.get('/api/v3/feeds/weather')).status).toBe(200);
    }
    clock.advance(10 * 60_000);
    expect((await pio.get('/api/v3/feeds/weather')).status).toBe(401);
  });

  it('clamps configured limits to 24 h and 1 h', () => {
    const config = testConfig();
    expect(config.session.absoluteMs).toBeLessThanOrEqual(24 * 3_600_000);
    expect(config.session.idleMs).toBeLessThanOrEqual(3_600_000);
  });

  it('signs out, and an administrator can revoke a session', async () => {
    const { app, platform } = makeApp();
    await addUser(platform, 'admin.one', [{ position: 'admin', scope: '*' }]);
    await addUser(platform, 'pio.one', [{ position: 'pio' }]);
    const pio = await signIn(app, 'pio.one');
    const pio2 = await signIn(app, 'pio.one');
    const admin = await signIn(app, 'admin.one');
    const sessions = (await admin.json('GET', `/api/v3/sessions?userId=${platform.users.byUsername('pio.one')!.id}`)).body as { id: string }[];
    expect(sessions).toHaveLength(2);
    expect((await admin.del(`/api/v3/sessions/${sessions[0]!.id}`)).status).toBe(200);
    const statuses = [(await pio.get('/api/v3/feeds/weather')).status, (await pio2.get('/api/v3/feeds/weather')).status].sort();
    expect(statuses).toEqual([200, 401]);
    const live = (await pio.get('/api/v3/feeds/weather')).status === 200 ? pio : pio2;
    expect((await live.post('/api/v3/auth/logout')).status).toBe(200);
    expect((await live.get('/api/v3/feeds/weather')).status).toBe(401);
    expect(platform.audit.list({ action: 'session.revoke' })).toHaveLength(1);
  });

  it('a password change ends the other sessions', async () => {
    const { app, platform } = makeApp();
    await addUser(platform, 'pio.one', [{ position: 'pio' }]);
    const a = await signIn(app, 'pio.one');
    const b = await signIn(app, 'pio.one');
    const res = await a.post('/api/v3/auth/password', { current: PASSWORD, next: 'an entirely new passphrase' });
    expect(res.status).toBe(200);
    expect((await a.get('/api/v3/feeds/weather')).status).toBe(200);
    expect((await b.get('/api/v3/feeds/weather')).status).toBe(401);
    await signIn(app, 'pio.one', 'an entirely new passphrase');
  });
});

describe('CSRF and cross-site writes', () => {
  it('requires the session CSRF token on cookie-authenticated writes', async () => {
    const { app, platform } = makeApp();
    await addUser(platform, 'ops.chief', [{ position: 'operations_chief' }]);
    const ops = await signIn(app, 'ops.chief');
    const body = { kind: 'plan', scope: 'osu-2026', name: 'Gate 10 surge', body: {} };
    const token = ops.csrf;
    ops.csrf = null;
    const missing = await ops.post('/api/v3/documents', body);
    expect(missing.status).toBe(403);
    expect((await missing.json()).error).toBe('csrf');
    ops.csrf = 'x'.repeat(43);
    expect((await ops.post('/api/v3/documents', body)).status).toBe(403);
    ops.csrf = token;
    expect((await ops.post('/api/v3/documents', body)).status).toBe(201);
  });

  it('refuses writes from another origin, or marked cross-site, even with the token', async () => {
    const { app, platform } = makeApp();
    await addUser(platform, 'ops.chief', [{ position: 'operations_chief' }]);
    const ops = await signIn(app, 'ops.chief');
    const body = { kind: 'plan', scope: 'osu-2026', name: 'x', body: {} };
    expect((await ops.post('/api/v3/documents', body, { origin: 'https://evil.example', host: 'gameday.local' })).status).toBe(403);
    expect((await ops.post('/api/v3/documents', body, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await ops.post('/api/v3/documents', body, { origin: 'http://gameday.local', host: 'gameday.local' })).status).toBe(201);
  });

  it('protects first-run loopback mode from cross-site posts too', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/feedback', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example', host: '127.0.0.1:8787' }, body: JSON.stringify({ mapId: 'm' }) });
    expect(res.status).toBe(403);
  });

  it('only accepts JSON bodies as JSON (no cross-site form posts)', async () => {
    const { app, platform } = makeApp();
    await addUser(platform, 'ops.chief', [{ position: 'operations_chief' }]);
    const res = await app.request('/api/v3/auth/login', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ username: 'ops.chief', password: PASSWORD }) });
    expect(res.status).toBe(415);
  });
});

describe('two-factor sign-in (TOTP)', () => {
  it('requires enrolment before anything else when MFA is required', async () => {
    const { app, platform, clock } = makeApp({ mfa: 'required' });
    await addUser(platform, 'ic.one', [{ position: 'incident_commander' }]);
    const ic = await signIn(app, 'ic.one');
    const info = await (await ic.get('/api/v3/auth/session')).json();
    expect(info.stage).toBe('mfa_enrolment');
    const blocked = await ic.get('/api/v3/documents');
    expect(blocked.status).toBe(403);
    expect((await blocked.json()).error).toBe('mfa_enrolment_required');

    const setup = (await ic.json('POST', '/api/v3/auth/mfa/totp/setup', {})).body as { secret: string; otpauthUri: string };
    expect(setup.otpauthUri).toContain(`secret=${setup.secret}`);
    expect((await ic.post('/api/v3/auth/mfa/totp/confirm', { code: '000000' })).status).toBe(401);
    const confirm = await ic.post('/api/v3/auth/mfa/totp/confirm', { code: codeFor(setup.secret, clock.now()) });
    expect(confirm.status).toBe(200);
    ic.csrf = (await confirm.json()).csrfToken;
    expect((await ic.get('/api/v3/documents')).status).toBe(200);
    expect(platform.audit.list({ action: 'auth.mfa.enrol' })).toHaveLength(1);

    // Next sign-in needs a code; a used code cannot be replayed.
    clock.advance(31_000);
    const noCode = await client(app).post('/api/v3/auth/login', { username: 'ic.one', password: PASSWORD });
    expect(noCode.status).toBe(401);
    expect((await noCode.json()).error).toBe('mfa_required');
    const code = codeFor(setup.secret, clock.now());
    await signIn(app, 'ic.one', PASSWORD, code);
    const replay = await client(app).post('/api/v3/auth/login', { username: 'ic.one', password: PASSWORD, totp: code });
    expect(replay.status).toBe(401);
    expect((await replay.json()).error).toBe('invalid_mfa');
  });

  it('an administrator can reset a lost authenticator, which ends the sessions', async () => {
    const { app, platform, clock } = makeApp({ mfa: 'required' });
    await addUser(platform, 'admin.one', [{ position: 'admin', scope: '*' }]);
    const user = await addUser(platform, 'ic.one', [{ position: 'incident_commander' }]);
    platform.users.update(user.id, { totp_secret: 'MZXW6YTBOI' });
    platform.users.update((platform.users.byUsername('admin.one'))!.id, { totp_secret: 'GEZDGNBVGY3TQOJQ' });
    const admin = await signIn(app, 'admin.one', PASSWORD, codeFor('GEZDGNBVGY3TQOJQ', clock.now()));
    const ic = await signIn(app, 'ic.one', PASSWORD, codeFor('MZXW6YTBOI', clock.now()));
    expect((await admin.del(`/api/v3/users/${user.id}/mfa`)).status).toBe(200);
    expect((await ic.get('/api/v3/documents')).status).toBe(401);
    expect(platform.users.byId(user.id)!.totp_secret).toBeNull();
  });
});

describe('accounts and grants (administrator)', () => {
  it('creates accounts and grants positions, all audited', async () => {
    const { app, platform } = makeApp();
    await addUser(platform, 'admin.one', [{ position: 'admin', scope: '*' }]);
    const admin = await signIn(app, 'admin.one');
    const created = await admin.json('POST', '/api/v3/users', { username: 'unit.12', displayName: 'OSU PD 12', password: 'twelve twelve twelve' });
    expect(created.status).toBe(201);
    expect((await admin.post('/api/v3/users', { username: 'weak.one', displayName: 'w', password: 'short' })).status).toBe(400);
    const grant = await admin.json('POST', '/api/v3/grants', { userId: created.body.id, position: 'field_unit', scope: 'osu-2026', unit: 'OSU PD 12' });
    expect(grant.status).toBe(201);
    expect((await admin.post('/api/v3/grants', { userId: created.body.id, position: 'admin', scope: 'osu-2026' })).status).toBe(400);
    const unit = await signIn(app, 'unit.12', 'twelve twelve twelve');
    expect((await unit.get('/api/v3/auth/session').then((r) => r.json())).grants).toEqual([{ position: 'field_unit', scope: 'osu-2026', unit: 'OSU PD 12' }]);
    expect((await admin.del(`/api/v3/grants/${grant.body.id}`)).status).toBe(200);
    expect(platform.audit.list().map((e) => e.action)).toEqual(expect.arrayContaining(['user.create', 'grant.create', 'grant.revoke']));
    // An operational position cannot manage accounts.
    expect((await unit.get('/api/v3/users')).status).toBe(403);
    expect(platform.audit.list({ action: 'access.denied' }).length).toBeGreaterThan(0);
  });
});

describe('wallboard display grants', () => {
  it('pairs a screen once with a code, read-only, and revoking it ends the session', async () => {
    const { app, platform } = makeApp();
    await addUser(platform, 'ic.one', [{ position: 'incident_commander' }]);
    const ic = await signIn(app, 'ic.one');
    const made = await ic.json('POST', '/api/v3/display-grants', { scope: 'osu-2026', label: 'EOC wall 1' });
    expect(made.status).toBe(201);
    expect((await ic.post('/api/v3/display-grants', { scope: 'msu-2026', label: 'Not mine' })).status).toBe(403);
    const wall = client(app);
    expect((await wall.post('/api/v3/auth/display', { code: '00000-00000' })).status).toBe(401);
    const paired = await wall.post('/api/v3/auth/display', { code: made.body.code });
    expect(paired.status).toBe(200);
    wall.csrf = (await paired.json()).csrfToken;
    expect((await client(app).post('/api/v3/auth/display', { code: made.body.code })).status).toBe(401);
    expect((await wall.get('/api/v3/events?stream=osu-2026')).status).toBe(200);
    expect((await wall.get('/api/v3/events?stream=msu-2026')).status).toBe(403);
    expect((await wall.post('/api/v3/events', { id: crypto.randomUUID(), stream: 'osu-2026', type: 'note.logged', mode: 'live', payload: { text: 'hi' } })).status).toBe(403);
    expect((await ic.del(`/api/v3/display-grants/${made.body.grant.id}`)).status).toBe(200);
    expect((await wall.get('/api/v3/events?stream=osu-2026')).status).toBe(401);
  });
});

describe('the v2 routes behind can()', () => {
  it('maps every v2 route to a permission and refuses unknown ones', async () => {
    const db = openDb(':memory:');
    const app = createApp(db, { config: testConfig({ mfa: 'optional' }) });
    expect((await app.request('/api/not-a-route')).status).toBe(404);
    const platform = platformOf(app);
    await addUser(platform, 'field.12', [{ position: 'field_unit', unit: 'OSU PD 12' }]);
    const unit = await signIn(app, 'field.12');
    expect((await unit.get('/api/maps')).status).toBe(200);
    expect((await unit.get('/api/plans?incident=gate_surge')).status).toBe(403);
    expect((await unit.post('/api/history', { mapId: 'm', runId: 'r', samples: [] })).status).toBe(403);
  });
});
