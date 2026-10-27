import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * Password hashing with Node's built-in scrypt (RFC 7914). No dependency.
 *
 * Default parameters: N = 2^15, r = 8, p = 3, a 16-byte salt and a 64-byte
 * key — one of the tiers the OWASP Password Storage Cheat Sheet lists as
 * equivalent to its N = 2^17, r = 8, p = 1 baseline, at a quarter of the
 * memory (32 MiB per hash) so a command-post laptop can take a burst of
 * sign-ins. Every hash records its own parameters in PHC string format,
 *   $scrypt$ln=15,r=8,p=3$<salt, base64>$<key, base64>
 * so policy can be raised later: `verifyPassword` says when a stored hash is
 * weaker than the current policy and the sign-in rehashes it.
 */
export interface ScryptParams {
  log2N: number;
  r: number;
  p: number;
}

export const DEFAULT_SCRYPT: ScryptParams = { log2N: 15, r: 8, p: 3 };
const SALT_BYTES = 16;
const KEY_BYTES = 64;
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 256;

const derive = (password: string, salt: Buffer, params: ScryptParams) =>
  new Promise<Buffer>((resolve, reject) => {
    const N = 2 ** params.log2N;
    // Node rejects parameters whose working set (128 * N * r bytes) exceeds maxmem; give it headroom.
    const maxmem = 128 * N * params.r * 2 + 16 * 1024 * 1024;
    scrypt(password.normalize('NFKC'), salt, KEY_BYTES, { N, r: params.r, p: params.p, maxmem }, (error, key) => (error ? reject(error) : resolve(key)));
  });

export async function hashPassword(password: string, params: ScryptParams = DEFAULT_SCRYPT): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, params);
  return `$scrypt$ln=${params.log2N},r=${params.r},p=${params.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function parseHash(stored: string): { params: ScryptParams; salt: Buffer; key: Buffer } | null {
  const match = /^\$scrypt\$ln=(\d{1,2}),r=(\d{1,2}),p=(\d{1,2})\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/.exec(stored);
  if (!match) return null;
  const params = { log2N: Number(match[1]), r: Number(match[2]), p: Number(match[3]) };
  if (params.log2N < 1 || params.log2N > 24 || params.r < 1 || params.p < 1) return null;
  return { params, salt: Buffer.from(match[4]!, 'base64'), key: Buffer.from(match[5]!, 'base64') };
}

export async function verifyPassword(password: string, stored: string, policy: ScryptParams = DEFAULT_SCRYPT): Promise<{ ok: boolean; needsRehash: boolean }> {
  const parsed = parseHash(stored);
  if (!parsed) return { ok: false, needsRehash: false };
  const key = await derive(password, parsed.salt, parsed.params);
  const ok = key.length === parsed.key.length && timingSafeEqual(key, parsed.key);
  const weaker = 2 ** parsed.params.log2N * parsed.params.r * parsed.params.p < 2 ** policy.log2N * policy.r * policy.p;
  return { ok, needsRehash: ok && weaker };
}

/**
 * Burn the same work for an unknown account as for a known one, so response
 * time does not say whether a username exists.
 */
let dummy: Promise<string> | null = null;
export async function burnVerify(password: string, policy: ScryptParams = DEFAULT_SCRYPT): Promise<void> {
  dummy ??= hashPassword(randomBytes(16).toString('hex'), policy);
  await verifyPassword(password, await dummy, policy);
}

/** A few of the most common passwords; NIST SP 800-63B asks verifiers to refuse known-bad choices. */
const COMMON = ['password', 'password1', '123456789', '1234567890', 'qwertyuiop', 'letmein', 'welcome', 'iloveyou', 'admin', 'administrator', 'changeme', 'gameday', 'buckeyes', 'ohiostate', 'football', 'police'];

export function passwordProblems(password: string, username: string): string[] {
  const problems: string[] = [];
  if (password.length < PASSWORD_MIN) problems.push(`Use at least ${PASSWORD_MIN} characters.`);
  if (password.length > PASSWORD_MAX) problems.push(`Use at most ${PASSWORD_MAX} characters.`);
  const lower = password.toLowerCase();
  if (username && lower.includes(username.toLowerCase())) problems.push('Do not include the username.');
  if (COMMON.some((word) => lower.replace(/[^a-z0-9]/g, '').startsWith(word) && lower.length < word.length + 6)) problems.push('This password is too common.');
  if (/^(.)\1+$/.test(password)) problems.push('Do not repeat a single character.');
  return problems;
}
