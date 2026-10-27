import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, hotp, otpauthUri, totp, verifyTotp } from './totp.ts';
import { DEFAULT_SCRYPT, hashPassword, parseHash, passwordProblems, verifyPassword } from './password.ts';
import { LoginRateLimiter, TokenBucket } from './ratelimit.ts';
import { FakeClock } from '../testing.ts';

const FAST = { log2N: 10, r: 8, p: 1 };

describe('scrypt passwords', () => {
  it('records its parameters in a PHC string and verifies', async () => {
    const stored = await hashPassword('a long passphrase here', FAST);
    expect(stored).toMatch(/^\$scrypt\$ln=10,r=8,p=1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    const parsed = parseHash(stored)!;
    expect(parsed.salt).toHaveLength(16);
    expect(parsed.key).toHaveLength(64);
    expect((await verifyPassword('a long passphrase here', stored, FAST)).ok).toBe(true);
    expect((await verifyPassword('a long passphrase herE', stored, FAST)).ok).toBe(false);
  });

  it('salts every hash', async () => {
    expect(await hashPassword('same password twice', FAST)).not.toBe(await hashPassword('same password twice', FAST));
  });

  it('asks for a rehash when the stored hash is weaker than policy', async () => {
    const weak = await hashPassword('upgrade me please', FAST);
    expect(await verifyPassword('upgrade me please', weak, { log2N: 11, r: 8, p: 1 })).toEqual({ ok: true, needsRehash: true });
    expect(await verifyPassword('upgrade me please', weak, FAST)).toEqual({ ok: true, needsRehash: false });
  });

  it('runs at the shipped policy (N = 2^15, r = 8, p = 3)', async () => {
    expect(DEFAULT_SCRYPT).toEqual({ log2N: 15, r: 8, p: 3 });
    const started = performance.now();
    const stored = await hashPassword('production parameters', DEFAULT_SCRYPT);
    const ms = performance.now() - started;
    expect(stored.startsWith('$scrypt$ln=15,r=8,p=3$')).toBe(true);
    expect((await verifyPassword('production parameters', stored)).ok).toBe(true);
    expect(ms).toBeLessThan(5000);
  });

  it('refuses malformed hashes rather than throwing', async () => {
    expect(await verifyPassword('x', 'plaintext')).toEqual({ ok: false, needsRehash: false });
    expect(parseHash('$scrypt$ln=99,r=8,p=1$AA==$AA==')).toBeNull();
  });

  it('turns away short, common and username-based passwords', () => {
    expect(passwordProblems('short', 'alice')).toContain('Use at least 12 characters.');
    expect(passwordProblems('alice-is-my-password', 'alice')).toContain('Do not include the username.');
    expect(passwordProblems('password1234', 'bob').join(' ')).toMatch(/too common/);
    expect(passwordProblems('a sensible passphrase', 'bob')).toEqual([]);
  });
});

describe('TOTP (RFC 6238) and HOTP (RFC 4226)', () => {
  // RFC 4226 Appendix D: secret "12345678901234567890", counters 0-9.
  it('matches the RFC 4226 HOTP test values', () => {
    const secret = Buffer.from('12345678901234567890');
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    expected.forEach((code, counter) => expect(hotp(secret, counter)).toBe(code));
  });

  // RFC 6238 Appendix B, 8 digits, 30 s step.
  const seeds = {
    sha1: Buffer.from('12345678901234567890'),
    sha256: Buffer.from('12345678901234567890123456789012'),
    sha512: Buffer.from('1234567890123456789012345678901234567890123456789012345678901234'),
  };
  const table: [number, string, string, string][] = [
    [59, '94287082', '46119246', '90693936'],
    [1111111109, '07081804', '68084774', '25091201'],
    [1111111111, '14050471', '67062674', '99943326'],
    [1234567890, '89005924', '91819424', '93441116'],
    [2000000000, '69279037', '90698825', '38618901'],
    [20000000000, '65353130', '77737706', '47863826'],
  ];
  it.each(table)('matches RFC 6238 at T=%i', (t, sha1, sha256, sha512) => {
    expect(totp(seeds.sha1, t * 1000, { digits: 8 })).toBe(sha1);
    expect(totp(seeds.sha256, t * 1000, { digits: 8, algorithm: 'sha256' })).toBe(sha256);
    expect(totp(seeds.sha512, t * 1000, { digits: 8, algorithm: 'sha512' })).toBe(sha512);
  });

  it('round-trips base32 (RFC 4648)', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Decode('MZXW6YTBOI').toString()).toBe('foobar');
    expect(base32Decode('mzxw 6ytb-oi======').toString()).toBe('foobar');
  });

  it('accepts one step of drift either side, and never the same step twice', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    const now = 1_700_000_000_000;
    const code = totp(base32Decode(secret), now);
    const step = verifyTotp(secret, code, now)!;
    expect(step).toBe(Math.floor(now / 30_000));
    expect(verifyTotp(secret, code, now + 30_000)).toBe(step);
    expect(verifyTotp(secret, code, now + 61_000)).toBeNull();
    expect(verifyTotp(secret, code, now, { lastStep: step })).toBeNull();
    expect(verifyTotp(secret, '12345', now)).toBeNull();
    expect(verifyTotp(secret, 'abcdef', now)).toBeNull();
  });

  it('writes an otpauth URI authenticator apps read', () => {
    const uri = otpauthUri('MZXW6YTBOI', 'ic.smith');
    expect(uri).toBe('otpauth://totp/Gameday%20Command:ic.smith?secret=MZXW6YTBOI&issuer=Gameday%20Command&algorithm=SHA1&digits=6&period=30');
  });
});

describe('sign-in rate limiting', () => {
  it('locks an account after five failures in fifteen minutes, then lets it go', () => {
    const clock = new FakeClock();
    const limiter = new LoginRateLimiter({}, clock.now);
    for (let i = 0; i < 5; i++) {
      expect(limiter.retryAfterS('ic', '10.0.0.1')).toBe(0);
      limiter.fail('ic', '10.0.0.1');
      clock.advance(1000);
    }
    const wait = limiter.retryAfterS('ic', '10.0.0.9');
    expect(wait).toBeGreaterThan(14 * 60);
    expect(wait).toBeLessThanOrEqual(15 * 60);
    expect(limiter.retryAfterS('IC', '10.0.0.9')).toBe(wait);
    expect(limiter.retryAfterS('other', '10.0.0.9')).toBe(0);
    clock.advance(wait * 1000);
    expect(limiter.retryAfterS('ic', '10.0.0.1')).toBe(0);
  });

  it('limits one address across many accounts, and a success does not reset the address', () => {
    const clock = new FakeClock();
    const limiter = new LoginRateLimiter({}, clock.now);
    for (let i = 0; i < 20; i++) limiter.fail(`user${i}`, '192.0.2.7');
    limiter.succeed('user3');
    expect(limiter.retryAfterS('fresh', '192.0.2.7')).toBeGreaterThan(0);
    expect(limiter.retryAfterS('fresh', '192.0.2.8')).toBe(0);
  });

  it('keeps memory bounded', () => {
    const limiter = new LoginRateLimiter({ maxKeys: 100 });
    for (let i = 0; i < 1000; i++) limiter.fail(`u${i}`, `10.1.${i >> 8}.${i & 255}`);
    expect((limiter as unknown as { failures: Map<string, unknown> }).failures.size).toBeLessThanOrEqual(100);
  });

  it('token bucket refills over time', () => {
    const clock = new FakeClock();
    const bucket = new TokenBucket(3, 1, clock.now);
    expect([bucket.take(), bucket.take(), bucket.take(), bucket.take()]).toEqual([true, true, true, false]);
    clock.advance(1000);
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);
  });
});
