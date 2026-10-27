import { dirname, join, resolve } from 'node:path';
import type { MapBundle } from '../../../contracts.ts';
import type { Db } from '../db.ts';
import type { Actor, AuthMode, Position } from '../types.ts';
import type { PlatformConfig } from './config.ts';
import { migratePlatform } from './schema.ts';
import { AuditLog, type AuditActor, loadAuditKey } from '../audit/audit.ts';
import { Users } from '../auth/users.ts';
import { Sessions } from '../auth/sessions.ts';
import { LoginRateLimiter } from '../auth/ratelimit.ts';
import { IdentityRegistry, LocalPasswordProvider, OidcProviderStub } from '../auth/identity.ts';
import { hashPassword, passwordProblems } from '../auth/password.ts';
import { EventLog } from '../events/log.ts';
import { DocumentStore } from '../library/documents.ts';
import { ComparisonStore } from '../library/comparisons.ts';
import { Allowlist } from '../net/allowlist.ts';
import { type FetchTransport, type Resolver, defaultResolver, nodeTransport } from '../net/safe-fetch.ts';
import { NwsAdapter } from '../feeds/nws.ts';
import type { EventHub } from '../events/hub.ts';
import { DISPLAY_USER_PREFIX, DisplayGrants } from '../auth/display.ts';
import type { SessionRow } from '../auth/sessions.ts';

/**
 * Every platform service, built once per database. Routes, the WebSocket hub
 * and the CLI scripts all go through this object, so they share one clock,
 * one audit log and one set of rules.
 */
export interface Platform {
  db: Db;
  config: PlatformConfig;
  now: () => number;
  users: Users;
  sessions: Sessions;
  limiter: LoginRateLimiter;
  audit: AuditLog;
  identity: IdentityRegistry;
  events: EventLog;
  documents: DocumentStore;
  comparisons: ComparisonStore;
  allowlist: Allowlist;
  weather: NwsAdapter;
  displays: DisplayGrants;
  /** The outbound network seams every feed and fetch goes through. */
  resolver: Resolver;
  transport: FetchTransport;
  hub: EventHub | null;
  /** The map bundles the server can build (set by createApp), for GIS exports and sketches. */
  maps: (id: string) => MapBundle | undefined;
  authMode(): AuthMode;
  /** The actor a live session acts as, or null if its account or display grant is gone. */
  actorForSession(session: SessionRow): Actor | null;
}

export interface PlatformOptions {
  now?: () => number;
  /** Outbound network seams, replaced in tests. */
  resolver?: Resolver;
  transport?: FetchTransport;
  /** Where the database lives, to put the audit key beside it. */
  dbPath?: string;
}

export function createPlatform(db: Db, config: PlatformConfig, opts: PlatformOptions = {}): Platform {
  migratePlatform(db);
  const now = opts.now ?? Date.now;
  const keyFile = config.auditKeyFile ?? (opts.dbPath && opts.dbPath !== ':memory:' ? join(dirname(resolve(opts.dbPath)), 'audit-ed25519.pem') : null);
  const audit = new AuditLog(db, { key: loadAuditKey(keyFile), trustedKeyIds: config.auditTrustedKeys, checkpointEvery: config.auditCheckpointEvery, now });
  const users = new Users(db, now);
  const sessions = new Sessions(db, config.session, now);
  const identity = new IdentityRegistry();
  identity.register(new LocalPasswordProvider(users, config.scrypt));
  identity.register(new OidcProviderStub());
  const allowlist = new Allowlist(db, now);
  const fetchDeps = { allowlist, resolver: opts.resolver ?? defaultResolver, transport: opts.transport ?? nodeTransport, now };
  const platform: Platform = {
    db,
    config,
    now,
    users,
    sessions,
    limiter: new LoginRateLimiter({}, now),
    audit,
    identity,
    events: new EventLog(db, now),
    documents: new DocumentStore(db, now, config.twoPersonApproval),
    comparisons: new ComparisonStore(db, now),
    allowlist,
    weather: new NwsAdapter(db, config, fetchDeps),
    displays: new DisplayGrants(db, now),
    resolver: fetchDeps.resolver,
    transport: fetchDeps.transport,
    hub: null,
    maps: () => undefined,
    authMode: () => (config.demo ? 'demo' : users.count() === 0 ? 'setup' : 'accounts'),
    actorForSession(session) {
      if (session.kind === 'display') {
        const grant = platform.displays.live(session.user_id.slice(DISPLAY_USER_PREFIX.length));
        if (!grant) return null;
        return { userId: session.user_id, username: 'display', displayName: grant.label, kind: 'display', grants: [{ position: 'display', scope: grant.scope, unit: null }], sessionId: session.id };
      }
      const user = users.byId(session.user_id);
      if (!user || user.disabled) return null;
      const actor = users.actorFor(user, session.id);
      // Until MFA enrolment finishes, a session can do nothing but enrol.
      return session.stage === 'full' ? actor : { ...actor, grants: [] };
    },
  };
  allowlist.seedDefaults();
  return platform;
}

export function auditActor(actor: Actor | null, position?: Position | string | null): AuditActor {
  if (!actor) return { userId: null, name: null, position: null };
  return { userId: actor.userId, name: actor.username, position: position ?? actor.grants[0]?.position ?? actor.kind };
}

/**
 * First-run bootstrap: create the first administrator. Used by
 * `npm run admin:create` and by the GAMEDAY_ADMIN_USER/PASSWORD variables.
 * Refuses weak passwords; there is no default password anywhere.
 */
export async function createAdmin(platform: Platform, input: { username: string; password: string; displayName?: string }, via: 'cli' | 'env'): Promise<{ userId: string }> {
  const problems = passwordProblems(input.password, input.username);
  if (problems.length) throw new Error(problems.join(' '));
  if (platform.users.byUsername(input.username)) throw new Error(`an account named ${input.username} already exists`);
  const user = platform.users.create({ username: input.username, displayName: input.displayName ?? input.username, passwordHash: await hashPassword(input.password, platform.config.scrypt) });
  platform.users.grant({ userId: user.id, position: 'admin', scope: '*', grantedBy: `bootstrap:${via}` });
  platform.audit.append({ actor: { userId: null, name: `bootstrap:${via}`, position: null }, action: 'admin.bootstrap', target: user.id, detail: { username: user.username, via } });
  return { userId: user.id };
}
