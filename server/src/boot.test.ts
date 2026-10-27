import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { freeTextWarnings } from './platform/freetext.ts';

/**
 * `node server/src/index.ts` must start with zero configuration (no build
 * step: Node strips the types itself). Node's stripping refuses TypeScript
 * that needs transforming (parameter properties, enums, namespaces), which
 * Vitest would happily compile — so both are checked here directly.
 */
const ROOT = resolve(import.meta.dirname, '..', '..');
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function run(env: Record<string, string>, until: RegExp, timeoutMs = 20_000): Promise<{ out: string; code: number | null }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ['server/src/index.ts'], { cwd: ROOT, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const finish = (code: number | null) => {
      clearTimeout(timer);
      done({ out, code });
    };
    const onData = (d: Buffer) => {
      out += d.toString();
      if (until.test(out)) {
        child.kill('SIGTERM');
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => finish(code));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  });
}

describe('zero-configuration start', () => {
  it('starts with no environment at all, on loopback, and serves health', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gd-boot-'));
    dirs.push(dir);
    const { out } = await run({ PORT: '0', DB_PATH: join(dir, 'gameday.db') }, /Weather feed/);
    expect(out).toMatch(/gameday server on http:\/\/127\.0\.0\.1:\d+/);
    expect(out).toMatch(/No accounts yet/);
    expect(readdirSync(dir)).toContain('gameday.db');
  }, 30_000);

  it('refuses to listen on the network before any account exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gd-boot-'));
    dirs.push(dir);
    const { out, code } = await run({ PORT: '0', HOST: '0.0.0.0', DB_PATH: join(dir, 'gameday.db') }, /Refusing/);
    expect(out).toMatch(/Refusing to listen on 0\.0\.0\.0 with no accounts/);
    expect(code).not.toBe(0);
  }, 30_000);

  it('creates the first administrator from the environment, once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gd-boot-'));
    dirs.push(dir);
    const env = { PORT: '0', DB_PATH: join(dir, 'gameday.db'), GAMEDAY_ADMIN_USER: 'first.admin', GAMEDAY_ADMIN_PASSWORD: 'a long first-run passphrase', GAMEDAY_SCRYPT_LOG2N: '10', GAMEDAY_SCRYPT_P: '1' };
    const first = await run(env, /Weather feed/);
    expect(first.out).toMatch(/Created administrator "first.admin"/);
    const second = await run(env, /Weather feed/);
    expect(second.out).not.toMatch(/Created administrator/);
    expect(statSync(join(dir, 'audit-ed25519.pem')).isFile()).toBe(true);
  }, 30_000);
});

describe('source that Node can run directly', () => {
  const walk = (dir: string): string[] =>
    !existsSync(dir) ? [] : readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'fixtures' ? [] : walk(join(dir, e.name))) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));

  it('uses only erasable TypeScript in server/ and app/src/platform/', () => {
    const files = [...walk(join(ROOT, 'server', 'src')), ...walk(join(ROOT, 'server', 'scripts')), ...walk(join(ROOT, 'app', 'src', 'platform'))];
    const bad: string[] = [];
    for (const file of files) {
      try {
        stripTypeScriptTypes(readFileSync(file, 'utf8'));
      } catch (error) {
        bad.push(`${file}: ${(error as Error).message.split('\n')[0]}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe('free-text checks', () => {
  it('stay linear on long input (no regular-expression blow-up)', () => {
    const started = performance.now();
    for (const text of ['x'.repeat(100_000), 'a@'.repeat(50_000), '1-'.repeat(50_000), 'Mr '.repeat(30_000)]) freeTextWarnings(text, 'note');
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('flag the shapes of personal data and pass ordinary police language', () => {
    expect(freeTextWarnings('Call 614-555-0123 or ops@agency.gov re case no. 26-001234', 'note').map((w) => w.kind).sort()).toEqual(['case_number', 'email', 'phone']);
    expect(freeTextWarnings('Gate 10 queue reaches the bike racks; send 2 units from Lot 5 at 1530.', 'note')).toEqual([]);
  });
});
