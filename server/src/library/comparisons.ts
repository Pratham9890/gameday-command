import { randomUUID } from 'node:crypto';
import type { Db } from '../db.ts';
import type { ComparisonRecord } from '../types.ts';
import { CONTRACT_VERSION } from '../../../contracts.ts';
import { canonicalJson, iso, sha256Hex } from '../platform/canonical.ts';
import { ID_PATTERN, v } from '../platform/validate.ts';
import type { Stamp } from './documents.ts';

/**
 * Comparisons with what it takes to reproduce them (PLT-37, PLT-45): the seed
 * (and every seed of an ensemble), the decision tape's hash, the engine and
 * contract versions, the map and the plan versions. Same seed + same tape =
 * same run, so these fields are enough to recompute a comparison bit for bit.
 */
const scorecard = v.object(
  {
    runId: v.string({ max: 120 }),
    planId: v.string({ max: 120 }),
    label: v.literal(['A', 'B', 'C'] as const),
    timeToClearMin: v.nullable(v.number()),
    peakDensity: v.number(),
    dangerMinutes: v.number(),
    firstOfficerMin: v.nullable(v.number()),
    officerMinutesUsed: v.number(),
    fansNotReached: v.number(),
    fallbackDecisions: v.number({ min: 0 }),
  },
  { extra: true },
);

export const comparisonInput = v.object({
  scope: v.string({ pattern: ID_PATTERN }),
  incident: v.object({ id: v.string({ max: 120 }), kind: v.literal(['game_end', 'lightning_delay', 'gate_surge', 'suspicious_package', 'medical', 'fight'] as const), at: v.number() }, { extra: true }),
  scorecards: v.array(scorecard, { min: 1, max: 3 }),
  seed: v.number({ int: true, min: 0, max: 2 ** 32 - 1 }),
  seeds: v.optional(v.array(v.number({ int: true, min: 0, max: 2 ** 32 - 1 }), { max: 1000 })),
  tapeHash: v.optional(v.string({ pattern: /^[0-9a-f]{64}$/ })),
  tape: v.optional(v.object({ runId: v.string({ max: 120 }), answers: v.array(v.any(), { max: 500_000 }) })),
  engineVersion: v.string({ min: 1, max: 100 }),
  mapId: v.string({ min: 1, max: 120 }),
  planRefs: v.optional(
    v.array(v.object({ planId: v.string({ max: 120 }), label: v.literal(['A', 'B', 'C'] as const), documentId: v.optional(v.string({ max: 120 })), version: v.optional(v.number({ int: true, min: 1 })) }), { max: 3 }),
  ),
  scenarioRef: v.optional(v.object({ id: v.string({ max: 120 }), version: v.number({ int: true, min: 1 }) })),
});

/** The tape hash is SHA-256 over the tape's canonical JSON. */
export const tapeHashOf = (tape: unknown) => sha256Hex(canonicalJson(tape));

export class ComparisonStore {
  private readonly db: Db;
  private readonly now: () => number;
  constructor(
    db: Db,
    now: () => number = Date.now,
  ) {
    this.db = db;
    this.now = now;
  }

  create(by: Stamp, input: ReturnType<typeof comparisonInput>): ComparisonRecord {
    const computed = input.tape ? tapeHashOf(input.tape) : null;
    if (computed && input.tapeHash && computed !== input.tapeHash) throw new Error('tapeHash does not match the tape sent with it');
    const now = this.now();
    const record: ComparisonRecord = {
      id: randomUUID(),
      scope: input.scope,
      incident: input.incident as ComparisonRecord['incident'],
      scorecards: input.scorecards as ComparisonRecord['scorecards'],
      seed: input.seed,
      seeds: input.seeds ?? null,
      tapeHash: computed ?? input.tapeHash ?? null,
      engineVersion: input.engineVersion,
      contractVersion: CONTRACT_VERSION,
      mapId: input.mapId,
      planRefs: input.planRefs ?? input.scorecards.map((s) => ({ planId: s.planId, label: s.label })),
      scenarioRef: input.scenarioRef ?? null,
      createdBy: { userId: by.userId, name: by.name, position: by.position, at: iso(now) },
      createdAt: iso(now),
    };
    this.db.prepare('insert into comparisons_v3 (id, scope, json, created_at) values (?, ?, ?, ?)').run(record.id, record.scope, JSON.stringify(record), now);
    return record;
  }

  get(id: string): ComparisonRecord | null {
    const row = this.db.prepare('select json from comparisons_v3 where id = ?').get(id) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as ComparisonRecord) : null;
  }

  list(scope?: string, limit = 100): ComparisonRecord[] {
    const rows = (scope
      ? this.db.prepare('select json from comparisons_v3 where scope = ? order by created_at desc limit ?').all(scope, limit)
      : this.db.prepare('select json from comparisons_v3 order by created_at desc limit ?').all(limit)) as { json: string }[];
    return rows.map((r) => JSON.parse(r.json) as ComparisonRecord);
  }

  /** Imported comparisons keep their id if it is free. */
  importRecord(record: ComparisonRecord): boolean {
    if (this.get(record.id)) return false;
    this.db.prepare('insert into comparisons_v3 (id, scope, json, created_at) values (?, ?, ?, ?)').run(record.id, record.scope, JSON.stringify(record), Date.parse(record.createdAt) || this.now());
    return true;
  }
}
