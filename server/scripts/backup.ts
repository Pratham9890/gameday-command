/**
 * Consistent backup of a running or stopped server.
 *
 *   npm run backup -- [out-dir]          (default ./backups/<timestamp>)
 *
 * Writes a VACUUM INTO copy of the SQLite database (safe while the server is
 * running; WAL contents included), a copy of the audit signing key, and
 * manifest.json with SHA-256 of each file and the audit-chain verification at
 * the moment of the backup. Encrypt the directory before it leaves the
 * machine (docs/v3/deploy.md, "Backup and restore").
 */
import { copyFileSync, createReadStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { openDb } from '../src/db.ts';
import { loadConfig } from '../src/platform/config.ts';
import { createPlatform } from '../src/platform/platform.ts';

const sha256 = (file: string) =>
  new Promise<string>((done, fail) => {
    const hash = createHash('sha256');
    createReadStream(file).on('data', (d) => hash.update(d)).on('end', () => done(hash.digest('hex'))).on('error', fail);
  });

async function main() {
  const dbPath = resolve(process.env.DB_PATH ?? './data/gameday.db');
  if (!existsSync(dbPath)) throw new Error(`No database at ${dbPath}.`);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = resolve(process.argv[2] ?? join('backups', stamp));
  mkdirSync(out, { recursive: true });
  const config = loadConfig();
  const db = openDb(dbPath);
  const target = join(out, basename(dbPath));
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  const keyFile = config.auditKeyFile ?? join(dirname(dbPath), 'audit-ed25519.pem');
  const files: Record<string, string> = { [basename(target)]: await sha256(target) };
  if (existsSync(keyFile)) {
    copyFileSync(keyFile, join(out, basename(keyFile)));
    files[basename(keyFile)] = await sha256(join(out, basename(keyFile)));
  }
  const platform = createPlatform(db, config, { dbPath });
  const verification = platform.audit.verify();
  writeFileSync(join(out, 'manifest.json'), JSON.stringify({ createdAt: new Date().toISOString(), source: dbPath, files, audit: { ok: verification.ok, entries: verification.entries, lastHash: verification.lastHash, keyId: platform.audit.publicKey.keyId } }, null, 2));
  console.log(`Backup written to ${out} (audit chain ${verification.ok ? 'verified' : 'HAS PROBLEMS'}, ${verification.entries} entries).`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
