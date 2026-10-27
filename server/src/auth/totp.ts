import { createHmac, randomBytes } from 'node:crypto';
import { safeEqual } from '../platform/canonical.ts';

/**
 * TOTP (RFC 6238) on HOTP (RFC 4226), with `node:crypto` only.
 *
 * Authenticator apps expect SHA-1, 6 digits and a 30 s step, so those are the
 * defaults. Codes are accepted one step either side of now for clock drift,
 * and a step is never accepted twice for the same account (the caller stores
 * the last step used), so an observed code cannot be replayed.
 */
export type TotpAlgorithm = 'sha1' | 'sha256' | 'sha512';

export interface TotpOptions {
  algorithm?: TotpAlgorithm;
  digits?: number;
  periodS?: number;
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const index = BASE32.indexOf(ch);
    if (index < 0) throw new Error('not base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 160-bit secret, the length RFC 4226 recommends. */
export const newTotpSecret = (): string => base32Encode(randomBytes(20));

export function hotp(secret: Uint8Array, counter: number, digits = 6, algorithm: TotpAlgorithm = 'sha1'): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(algorithm, secret).update(message).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export const totpStep = (unixMs: number, periodS = 30) => Math.floor(unixMs / 1000 / periodS);

export function totp(secret: Uint8Array, unixMs: number, opts: TotpOptions = {}): string {
  return hotp(secret, totpStep(unixMs, opts.periodS ?? 30), opts.digits ?? 6, opts.algorithm ?? 'sha1');
}

/**
 * The step a code matches within ±window steps of now, or null. The caller
 * must refuse a step at or below the last one it accepted.
 */
export function verifyTotp(secretBase32: string, code: string, unixMs: number, opts: TotpOptions & { window?: number; lastStep?: number | null } = {}): number | null {
  const digits = opts.digits ?? 6;
  if (!new RegExp(`^\\d{${digits}}$`).test(code.trim())) return null;
  const secret = base32Decode(secretBase32);
  const now = totpStep(unixMs, opts.periodS ?? 30);
  const window = opts.window ?? 1;
  let matched: number | null = null;
  // Check every candidate so the time taken does not depend on which one matched.
  for (let step = now - window; step <= now + window; step++) {
    if (safeEqual(hotp(secret, step, digits, opts.algorithm ?? 'sha1'), code.trim()) && matched === null) matched = step;
  }
  if (matched === null) return null;
  if (opts.lastStep !== undefined && opts.lastStep !== null && matched <= opts.lastStep) return null;
  return matched;
}

export function otpauthUri(secretBase32: string, account: string, issuer = 'Gameday Command'): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  // Percent-encoding, not '+', for spaces: some authenticator apps show a literal '+'.
  const query = Object.entries({ secret: secretBase32, issuer, algorithm: 'SHA1', digits: '6', period: '30' })
    .map(([k, value]) => `${k}=${encodeURIComponent(value)}`)
    .join('&');
  return `otpauth://totp/${label}?${query}`;
}
