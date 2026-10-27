import { readFileSync } from 'node:fs';

/**
 * Everything the platform reads from the environment, parsed once.
 *
 * Zero configuration is a supported mode: with no variables set the server
 * listens on loopback only, has no accounts until `npm run admin:create`, makes
 * no outbound calls, and serves the v2 routes to loopback clients exactly as
 * before. Every limit below is clamped to the policy ceiling the brief and
 * NIST SP 800-63B-4 AAL2 set (24 h absolute, 1 h idle), whatever the env asks.
 */
export interface PlatformConfig {
  demo: boolean;
  host: string;
  port: number;
  tls: { certFile: string; keyFile: string } | null;
  /** Cookies get `Secure` (and the `__Host-` prefix) when TLS is on or a TLS proxy sits in front. */
  secureCookies: boolean;
  /** Read client address and scheme from X-Forwarded-* (agency-hosted behind a reverse proxy). */
  trustProxy: boolean;
  /** Extra origins allowed to call the API and open the WebSocket, beyond the request's own host. */
  allowedOrigins: string[];
  session: { absoluteMs: number; idleMs: number };
  mfa: 'required' | 'optional';
  /** Approver must differ from the author and reviewer. */
  twoPersonApproval: boolean;
  scrypt: { log2N: number; r: number; p: number };
  bootstrap: { username: string; password: string; displayName: string } | null;
  auditKeyFile: string | null;
  auditTrustedKeys: string[];
  auditCheckpointEvery: number;
  feeds: { enabled: boolean; contact: string | null; userAgent: string };
  venue: { name: string; lat: number; lon: number };
  capSender: string;
  staticDir: string | null;
  body: { defaultBytes: number; largeBytes: number };
  warnings: string[];
}

export const MAX_SESSION_ABSOLUTE_MS = 24 * 60 * 60 * 1000;
export const MAX_SESSION_IDLE_MS = 60 * 60 * 1000;
export const PROJECT_URL = 'https://github.com/Pratham9890/gameday-command';
/** Ohio Stadium, from the OSM extract the map is built from. */
export const OHIO_STADIUM = { name: 'Ohio Stadium', lat: 40.0016478, lon: -83.0197398 };

type Env = Record<string, string | undefined>;

const flag = (value: string | undefined) => value !== undefined && /^(1|true|yes|on)$/i.test(value.trim());
const num = (value: string | undefined, fallback: number) => {
  const n = Number(value);
  return value !== undefined && value.trim() !== '' && Number.isFinite(n) ? n : fallback;
};

export function loadConfig(env: Env = process.env): PlatformConfig {
  const warnings: string[] = [];
  const demo = flag(env.GAMEDAY_DEMO) || flag(env.VERCEL);

  const certFile = env.TLS_CERT_FILE?.trim();
  const keyFile = env.TLS_KEY_FILE?.trim();
  if (Boolean(certFile) !== Boolean(keyFile)) warnings.push('TLS needs both TLS_CERT_FILE and TLS_KEY_FILE; serving plain HTTP.');
  const tls = certFile && keyFile ? { certFile, keyFile } : null;

  const askedAbsolute = num(env.GAMEDAY_SESSION_HOURS, 12) * 60 * 60 * 1000;
  const askedIdle = num(env.GAMEDAY_SESSION_IDLE_MINUTES, 30) * 60 * 1000;
  if (askedAbsolute > MAX_SESSION_ABSOLUTE_MS) warnings.push('GAMEDAY_SESSION_HOURS is above 24; using 24.');
  if (askedIdle > MAX_SESSION_IDLE_MS) warnings.push('GAMEDAY_SESSION_IDLE_MINUTES is above 60; using 60.');

  const password = env.GAMEDAY_ADMIN_PASSWORD ?? (env.GAMEDAY_ADMIN_PASSWORD_FILE ? readSecretFile(env.GAMEDAY_ADMIN_PASSWORD_FILE, warnings) : undefined);
  const username = env.GAMEDAY_ADMIN_USER?.trim();
  const bootstrap = username && password ? { username, password, displayName: env.GAMEDAY_ADMIN_NAME?.trim() || username } : null;
  if (Boolean(username) !== Boolean(password)) warnings.push('Admin bootstrap needs GAMEDAY_ADMIN_USER and GAMEDAY_ADMIN_PASSWORD (or _FILE); ignored.');

  const contact = env.GAMEDAY_FEED_CONTACT?.trim() || null;
  const feedsWanted = env.GAMEDAY_FEEDS?.trim() ? flag(env.GAMEDAY_FEEDS) : Boolean(contact);
  if (feedsWanted && !contact) warnings.push('Feeds are on but GAMEDAY_FEED_CONTACT is empty; the NWS adapter stays off until a contact is set.');

  const lat = num(env.GAMEDAY_VENUE_LAT, OHIO_STADIUM.lat);
  const lon = num(env.GAMEDAY_VENUE_LON, OHIO_STADIUM.lon);

  return {
    demo,
    host: env.HOST?.trim() || '127.0.0.1',
    port: num(env.PORT, 8787),
    tls,
    secureCookies: Boolean(tls) || flag(env.GAMEDAY_SECURE_COOKIES),
    trustProxy: flag(env.GAMEDAY_TRUST_PROXY),
    allowedOrigins: (env.GAMEDAY_ORIGINS ?? '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean),
    session: {
      absoluteMs: clamp(askedAbsolute, 5 * 60 * 1000, MAX_SESSION_ABSOLUTE_MS),
      idleMs: clamp(askedIdle, 60 * 1000, MAX_SESSION_IDLE_MS),
    },
    mfa: env.GAMEDAY_MFA?.trim().toLowerCase() === 'optional' ? 'optional' : 'required',
    twoPersonApproval: flag(env.GAMEDAY_TWO_PERSON),
    scrypt: {
      log2N: clamp(num(env.GAMEDAY_SCRYPT_LOG2N, 15), 10, 20),
      r: clamp(num(env.GAMEDAY_SCRYPT_R, 8), 1, 32),
      p: clamp(num(env.GAMEDAY_SCRYPT_P, 3), 1, 16),
    },
    bootstrap,
    auditKeyFile: env.GAMEDAY_AUDIT_KEY_FILE?.trim() || null,
    auditTrustedKeys: (env.GAMEDAY_AUDIT_TRUSTED_KEYS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    auditCheckpointEvery: clamp(num(env.GAMEDAY_AUDIT_CHECKPOINT_EVERY, 100), 1, 100_000),
    feeds: {
      enabled: feedsWanted && Boolean(contact),
      contact,
      userAgent: `GamedayCommand/3.0 (+${PROJECT_URL}${contact ? `; ${contact}` : ''})`,
    },
    venue: { name: env.GAMEDAY_VENUE_NAME?.trim() || OHIO_STADIUM.name, lat, lon },
    capSender: env.GAMEDAY_CAP_SENDER?.trim() || 'gameday-command.local',
    staticDir: env.GAMEDAY_STATIC_DIR?.trim() || null,
    body: {
      defaultBytes: clamp(num(env.GAMEDAY_BODY_LIMIT_KB, 1024), 16, 64 * 1024) * 1024,
      largeBytes: clamp(num(env.GAMEDAY_LARGE_BODY_LIMIT_MB, 16), 1, 256) * 1024 * 1024,
    },
    warnings,
  };
}

/** Defaults for tests and in-process use (`createApp(db)`), with overrides. */
export function testConfig(overrides: Partial<PlatformConfig> = {}): PlatformConfig {
  return { ...loadConfig({}), scrypt: { log2N: 10, r: 8, p: 1 }, ...overrides };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function readSecretFile(path: string, warnings: string[]): string | undefined {
  try {
    return readFileSync(path, 'utf8').replace(/\r?\n$/, '');
  } catch {
    warnings.push(`Could not read GAMEDAY_ADMIN_PASSWORD_FILE (${path}).`);
    return undefined;
  }
}

export const isLoopbackHost = (host: string) => host === 'localhost' || host === '::1' || host.startsWith('127.');
