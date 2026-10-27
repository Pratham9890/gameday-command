import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Db } from '../db.ts';
import type { AuditAction, AuditCheckpoint, AuditDetail, AuditEntry, AuditProblem, AuditVerification } from '../types.ts';
import { canonicalJson, chainHash, GENESIS_HASH, iso, sha256Hex } from '../platform/canonical.ts';
import { transaction } from '../platform/schema.ts';

/**
 * The security audit log (research 06 §2.4, PLT-10): append-only and hash
 * chained. Each entry's hash is SHA-256 over the previous entry's hash and the
 * entry's canonical JSON (seq included, so reordering shows too). Every N
 * entries — and on demand — the head is signed with an Ed25519 key kept in its
 * own file, outside the database, so someone who rewrites the database and
 * recomputes every hash still cannot forge the checkpoints.
 *
 * What goes in: who (account and position), what, when (server time), the
 * target and the outcome, and a small detail record of ids and counts. What
 * never goes in: passwords, codes, tokens, client addresses, free text or video.
 */
export interface AuditActor {
  userId: string | null;
  name: string | null;
  position: string | null;
}

export interface AuditInput {
  actor: AuditActor;
  action: AuditAction;
  target?: string | null;
  outcome?: AuditEntry['outcome'];
  detail?: Record<string, unknown>;
}

const SECRET_KEY = /pass(word)?|secret|token|totp|otp|code|cookie|csrf|key$/i;
const MAX_DETAIL_KEYS = 24;
const MAX_DETAIL_STRING = 160;

/** Only primitives, short strings, and never anything that looks like a secret. */
export function sanitizeDetail(detail: Record<string, unknown> = {}): AuditDetail {
  const out: AuditDetail = {};
  for (const [key, value] of Object.entries(detail).slice(0, MAX_DETAIL_KEYS)) {
    if (SECRET_KEY.test(key)) continue;
    if (value === null || typeof value === 'boolean') out[key] = value;
    else if (typeof value === 'number') out[key] = Number.isFinite(value) ? value : null;
    else if (typeof value === 'string') out[key] = value.length > MAX_DETAIL_STRING ? `${value.slice(0, MAX_DETAIL_STRING)}…` : value;
  }
  return out;
}

interface Row {
  seq: number;
  at: number;
  actor_user: string | null;
  actor_name: string | null;
  actor_position: string | null;
  action: string;
  target: string | null;
  outcome: string;
  detail: string;
  prev_hash: string;
  hash: string;
}

const hashedFields = (row: Omit<Row, 'hash' | 'prev_hash'>) => ({
  seq: row.seq,
  at: row.at,
  actor: { userId: row.actor_user, name: row.actor_name, position: row.actor_position },
  action: row.action,
  target: row.target,
  outcome: row.outcome,
  detail: JSON.parse(row.detail) as AuditDetail,
});

const toEntry = (row: Row): AuditEntry => ({
  seq: row.seq,
  at: iso(row.at),
  actor: { userId: row.actor_user, name: row.actor_name, position: row.actor_position },
  action: row.action as AuditAction,
  target: row.target,
  outcome: row.outcome as AuditEntry['outcome'],
  detail: JSON.parse(row.detail) as AuditDetail,
  prevHash: row.prev_hash,
  hash: row.hash,
});

export interface AuditKey {
  keyId: string;
  publicKey: string;
  privateKey: KeyObject;
}

export const keyIdOf = (spkiBase64: string) => sha256Hex(Buffer.from(spkiBase64, 'base64')).slice(0, 16);

/** Load the checkpoint signing key from its file, creating it (mode 0600) on first run. `null` = in memory only. */
export function loadAuditKey(file: string | null): AuditKey {
  let privateKey: KeyObject;
  if (file && existsSync(file)) {
    privateKey = createPrivateKey(readFileSync(file, 'utf8'));
  } else {
    privateKey = generateKeyPairSync('ed25519').privateKey;
    if (file) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, privateKey.export({ format: 'pem', type: 'pkcs8' }) as string, { mode: 0o600 });
      try {
        chmodSync(file, 0o600);
      } catch {
        /* Windows has no POSIX modes; the data directory's ACL protects it there. */
      }
    }
  }
  const publicKey = (createPublicKey(privateKey).export({ format: 'der', type: 'spki' }) as Buffer).toString('base64');
  return { keyId: keyIdOf(publicKey), publicKey, privateKey };
}

const checkpointMessage = (cp: { seq: number; hash: string; at: number; keyId: string }) =>
  Buffer.from(canonicalJson({ purpose: 'gameday.audit.checkpoint.1', seq: cp.seq, hash: cp.hash, at: cp.at, keyId: cp.keyId }));

export class AuditLog {
  private readonly key: AuditKey;
  private readonly trusted: Set<string>;
  private readonly checkpointEvery: number;
  private readonly now: () => number;
  private readonly listeners = new Set<(entry: AuditEntry) => void>();

  private readonly db: Db;
  constructor(
    db: Db,
    opts: { key: AuditKey; trustedKeyIds?: string[]; checkpointEvery?: number; now?: () => number },
  ) {
    this.db = db;
    this.key = opts.key;
    this.trusted = new Set([opts.key.keyId, ...(opts.trustedKeyIds ?? [])]);
    this.checkpointEvery = opts.checkpointEvery ?? 100;
    this.now = opts.now ?? Date.now;
  }

  get publicKey(): { keyId: string; spki: string } {
    return { keyId: this.key.keyId, spki: this.key.publicKey };
  }

  onAppend(listener: (entry: AuditEntry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  append(input: AuditInput): AuditEntry {
    const entry = transaction(this.db, () => {
      const head = this.db.prepare('select seq, hash from audit_log order by seq desc limit 1').get() as { seq: number; hash: string } | undefined;
      const fields = {
        seq: (head?.seq ?? 0) + 1,
        at: this.now(),
        actor_user: input.actor.userId,
        actor_name: input.actor.name,
        actor_position: input.actor.position,
        action: input.action,
        target: input.target ?? null,
        outcome: input.outcome ?? 'success',
        detail: canonicalJson(sanitizeDetail(input.detail)),
      };
      const prev = head?.hash ?? GENESIS_HASH;
      const hash = chainHash(prev, hashedFields(fields));
      this.db
        .prepare('insert into audit_log (seq, at, actor_user, actor_name, actor_position, action, target, outcome, detail, prev_hash, hash) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(fields.seq, fields.at, fields.actor_user, fields.actor_name, fields.actor_position, fields.action, fields.target, fields.outcome, fields.detail, prev, hash);
      const row: Row = { ...fields, prev_hash: prev, hash };
      if (fields.seq % this.checkpointEvery === 0) this.signHead(row);
      return toEntry(row);
    });
    for (const listener of this.listeners) listener(entry);
    return entry;
  }

  list(opts: { sinceSeq?: number; limit?: number; action?: string } = {}): AuditEntry[] {
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
    const rows = (opts.action
      ? this.db.prepare('select * from audit_log where seq > ? and action = ? order by seq limit ?').all(opts.sinceSeq ?? 0, opts.action, limit)
      : this.db.prepare('select * from audit_log where seq > ? order by seq limit ?').all(opts.sinceSeq ?? 0, limit)) as unknown as Row[];
    return rows.map(toEntry);
  }

  /** Sign the current head now. Returns null on an empty log. */
  checkpoint(): AuditCheckpoint | null {
    const head = this.db.prepare('select * from audit_log order by seq desc limit 1').get() as Row | undefined;
    if (!head) return null;
    return this.signHead(head);
  }

  checkpoints(): AuditCheckpoint[] {
    return (this.db.prepare('select * from audit_checkpoints order by seq').all() as unknown as { seq: number; hash: string; at: number; key_id: string; public_key: string; signature: string }[]).map((r) => ({
      seq: r.seq,
      hash: r.hash,
      at: iso(r.at),
      keyId: r.key_id,
      publicKey: r.public_key,
      signature: r.signature,
    }));
  }

  private signHead(head: Pick<Row, 'seq' | 'hash'>): AuditCheckpoint {
    const at = this.now();
    const signature = sign(null, checkpointMessage({ seq: head.seq, hash: head.hash, at, keyId: this.key.keyId }), this.key.privateKey).toString('base64');
    this.db.prepare('insert or replace into audit_checkpoints (seq, hash, at, key_id, public_key, signature) values (?, ?, ?, ?, ?, ?)').run(head.seq, head.hash, at, this.key.keyId, this.key.publicKey, signature);
    return { seq: head.seq, hash: head.hash, at: iso(at), keyId: this.key.keyId, publicKey: this.key.publicKey, signature };
  }

  /** Recompute the whole chain and check every checkpoint. */
  verify(): AuditVerification {
    const problems: AuditProblem[] = [];
    const hashes = new Map<number, string>();
    let prev = GENESIS_HASH;
    let expected = 1;
    let entries = 0;
    let lastSeq = 0;
    for (const row of this.db.prepare('select * from audit_log order by seq').iterate() as Iterable<Row>) {
      entries++;
      if (row.seq !== expected) problems.push({ seq: expected, kind: 'gap', message: `entries ${expected} to ${row.seq - 1} are missing` });
      if (row.prev_hash !== prev) problems.push({ seq: row.seq, kind: 'broken_link', message: `entry ${row.seq} does not follow the entry before it` });
      let recomputed = '';
      try {
        recomputed = chainHash(row.prev_hash, hashedFields(row));
      } catch {
        recomputed = 'unreadable';
      }
      if (recomputed !== row.hash) problems.push({ seq: row.seq, kind: 'hash_mismatch', message: `entry ${row.seq} was changed after it was written` });
      hashes.set(row.seq, row.hash);
      prev = row.hash;
      expected = row.seq + 1;
      lastSeq = row.seq;
    }
    const checkpoints = this.checkpoints();
    let verified = 0;
    for (const cp of checkpoints) {
      let good = false;
      try {
        const key = createPublicKey({ key: Buffer.from(cp.publicKey, 'base64'), format: 'der', type: 'spki' });
        good = keyIdOf(cp.publicKey) === cp.keyId && verify(null, checkpointMessage({ seq: cp.seq, hash: cp.hash, at: Date.parse(cp.at), keyId: cp.keyId }), key, Buffer.from(cp.signature, 'base64'));
      } catch {
        good = false;
      }
      if (!good) {
        problems.push({ seq: cp.seq, kind: 'bad_signature', message: `checkpoint at ${cp.seq} has an invalid signature` });
        continue;
      }
      if (!this.trusted.has(cp.keyId)) {
        problems.push({ seq: cp.seq, kind: 'untrusted_key', message: `checkpoint at ${cp.seq} is signed by key ${cp.keyId}, which this server does not trust` });
        continue;
      }
      if (cp.seq > lastSeq) {
        problems.push({ seq: cp.seq, kind: 'truncated', message: `a signed checkpoint covers entry ${cp.seq} but the log ends at ${lastSeq}` });
        continue;
      }
      if (hashes.get(cp.seq) !== cp.hash) {
        problems.push({ seq: cp.seq, kind: 'checkpoint_mismatch', message: `entry ${cp.seq} no longer matches the hash signed at the checkpoint` });
        continue;
      }
      verified++;
    }
    return { ok: problems.length === 0, entries, lastSeq, lastHash: prev, checkpoints: { total: checkpoints.length, verified }, problems, verifiedAt: iso(this.now()) };
  }
}
