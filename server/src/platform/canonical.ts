import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Canonical JSON: keys sorted by UTF-16 code unit, no whitespace, numbers and
 * strings exactly as `JSON.stringify` writes them. For the plain data this
 * server hashes, that is the JSON Canonicalization Scheme (RFC 8785), so a
 * hash computed here can be recomputed by any JCS library.
 */
export function canonicalJson(value: unknown): string {
  return write(value, 0);
}

function write(value: unknown, depth: number): string {
  if (depth > 64) throw new Error('canonical JSON: nested too deeply');
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new Error('canonical JSON: numbers must be finite');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? 'null' : write(item, depth + 1))).join(',')}]`;
      const withJson = value as { toJSON?: () => unknown };
      if (typeof withJson.toJSON === 'function') return write(withJson.toJSON(), depth + 1);
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined && typeof v !== 'function')
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${write(v, depth + 1)}`).join(',')}}`;
    }
    default:
      throw new Error(`canonical JSON: cannot encode a ${typeof value}`);
  }
}

export const sha256Hex = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

export const GENESIS_HASH = '0'.repeat(64);

/** One link of a hash chain: SHA-256 over the previous hash, a newline, and the entry's canonical JSON. */
export const chainHash = (prevHash: string, entry: unknown): string => sha256Hex(`${prevHash}\n${canonicalJson(entry)}`);

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

/** Constant-time string comparison that does not leak length through an exception. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

/** UUID shape check (any version, including client UUIDv7). */
export const isUuid = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

export const iso = (ms: number): string => new Date(ms).toISOString();
