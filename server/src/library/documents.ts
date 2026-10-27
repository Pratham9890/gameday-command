import { randomUUID } from 'node:crypto';
import type { Db } from '../db.ts';
import type { Classification, DocumentKind, DocumentStatus, DocumentSummary, DocumentVersion, FreeTextWarning, PersonStamp } from '../types.ts';
import { canonicalJson, iso, sha256Hex } from '../platform/canonical.ts';
import { transaction } from '../platform/schema.ts';
import { type Check, ID_PATTERN, parse, v } from '../platform/validate.ts';
import { warnFields } from '../platform/freetext.ts';

/**
 * Versioned scenarios, plans and exercise packages (PLT-30, PLAN D15).
 *
 * A version moves draft → reviewed → approved, the Planning P's approval
 * step. A draft is edited in place (each save bumps `revision`, the
 * compare-and-set token, and an edit to a reviewed draft sends it back to
 * draft). An approved version is never changed: SQLite triggers refuse it, and
 * editing it creates version n + 1 as a new draft whose parent is n.
 */
export class DocumentError extends Error {
  readonly status: 400 | 403 | 404 | 409 | 422;
  readonly code: string;
  readonly extra: Record<string, unknown>;
  constructor(
    status: 400 | 403 | 404 | 409 | 422,
    code: string,
    message: string,
    extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

interface Row {
  id: string;
  version: number;
  kind: string;
  scope: string;
  name: string;
  status: string;
  classification: string;
  revision: number;
  author_user: string;
  author_name: string;
  author_position: string | null;
  created_at: number;
  updated_at: number;
  reviewed_by: string | null;
  approved_by: string | null;
  parent_version: number | null;
  body: string;
  body_hash: string;
  imported_from: string | null;
}

export interface Stamp {
  userId: string;
  name: string;
  position: string | null;
}

const toVersion = (row: Row): DocumentVersion => ({
  id: row.id,
  kind: row.kind as DocumentKind,
  version: row.version,
  revision: row.revision,
  status: row.status as DocumentStatus,
  scope: row.scope,
  name: row.name,
  classification: row.classification as Classification,
  author: { userId: row.author_user, name: row.author_name, position: row.author_position, at: iso(row.created_at) },
  created: iso(row.created_at),
  updated: iso(row.updated_at),
  reviewedBy: row.reviewed_by ? (JSON.parse(row.reviewed_by) as PersonStamp) : null,
  approvedBy: row.approved_by ? (JSON.parse(row.approved_by) as PersonStamp) : null,
  parentVersion: row.parent_version,
  bodyHash: row.body_hash,
  body: JSON.parse(row.body),
  importedFrom: row.imported_from ? JSON.parse(row.imported_from) : null,
});

export const summaryOf = (doc: DocumentVersion): DocumentSummary => {
  const { body: _body, ...rest } = doc;
  return rest;
};

export const bodyHashOf = (body: unknown) => sha256Hex(canonicalJson(body));

const INCIDENT_KINDS = ['game_end', 'lightning_delay', 'gate_surge', 'suspicious_package', 'medical', 'fight'] as const;
const ACTION_TYPES = ['close', 'open', 'send_officers', 'hold_officers', 'alert', 'redirect', 'shelter_order'] as const;

const responsePlan = v.object(
  {
    id: v.string({ min: 1, max: 120 }),
    name: v.string({ min: 1, max: 200 }),
    forIncident: v.literal(INCIDENT_KINDS),
    actions: v.array(v.object({ at: v.number(), type: v.literal(ACTION_TYPES) }, { extra: true }), { max: 500 }),
    officersAvailable: v.number({ min: 0, max: 100_000 }),
  },
  { extra: true },
);

/** Known fields are checked; unknown fields are kept, so later workstreams can extend a body without a migration. */
export const BODY_CHECKS: Record<DocumentKind, Check<unknown>> = {
  plan: v.object({ responsePlan: v.optional(responsePlan), ics: v.optional(v.object({ objectives: v.array(v.string({ max: 1000 }), { max: 50 }) }, { extra: true })), notes: v.optional(v.string({ max: 20_000 })) }, { extra: true }),
  scenario: v.object(
    {
      mapId: v.string({ min: 1, max: 120 }),
      seed: v.number({ int: true, min: 0, max: 2 ** 32 - 1 }),
      incident: v.optional(v.object({ kind: v.literal(INCIDENT_KINDS), at: v.number() }, { extra: true })),
      notes: v.optional(v.string({ max: 20_000 })),
    },
    { extra: true },
  ),
  exercise: v.object(
    {
      title: v.string({ min: 1, max: 200 }),
      objectives: v.array(v.object({ id: v.string({ min: 1, max: 40 }), text: v.string({ min: 1, max: 1000 }) }, { extra: true }), { max: 50 }),
      msel: v.array(
        v.object(
          {
            number: v.string({ min: 1, max: 20 }),
            scenarioTime: v.number(),
            type: v.literal(['inject', 'contingency_inject', 'expected_action'] as const),
            mode: v.literal(['radio', 'phone', 'email', 'in_person', 'simulation', 'other'] as const),
            from: v.string({ max: 120 }),
            to: v.string({ max: 120 }),
            message: v.string({ min: 1, max: 4000 }),
          },
          { extra: true },
        ),
        { max: 2000 },
      ),
    },
    { extra: true },
  ),
};

export const FREE_TEXT_FIELDS: Record<DocumentKind, string[]> = {
  plan: ['notes', 'ics.commandEmphasis', 'ics.situationalAwareness', 'ics.safety.message'],
  scenario: ['notes', 'incident.note'],
  exercise: ['notes', 'msel.message', 'msel.notes', 'msel.expectedResponse'],
};

const MAX_BODY_BYTES = 2 * 1024 * 1024;
export const DOCUMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;

export function checkBody(kind: DocumentKind, body: unknown): { warnings: FreeTextWarning[] } {
  const size = JSON.stringify(body ?? null).length;
  if (size > MAX_BODY_BYTES) throw new DocumentError(400, 'too_large', `A ${kind} body may be at most 2 MB.`);
  const parsed = parse(BODY_CHECKS[kind], body, 'body');
  if (!parsed.ok) throw new DocumentError(400, 'invalid_body', parsed.errors[0]!, { errors: parsed.errors });
  return { warnings: warnFields(body, FREE_TEXT_FIELDS[kind]) };
}

export class DocumentStore {
  private readonly db: Db;
  private readonly now: () => number;
  private readonly twoPerson: boolean;
  constructor(db: Db, now: () => number = Date.now, twoPerson = false) {
    this.db = db;
    this.now = now;
    this.twoPerson = twoPerson;
  }

  private row(id: string, version?: number): Row | undefined {
    return (version === undefined
      ? this.db.prepare('select * from documents where id = ? order by version desc limit 1').get(id)
      : this.db.prepare('select * from documents where id = ? and version = ?').get(id, version)) as Row | undefined;
  }

  latest(id: string): DocumentVersion | null {
    const row = this.row(id);
    return row ? toVersion(row) : null;
  }

  get(id: string, version: number): DocumentVersion | null {
    const row = this.row(id, version);
    return row ? toVersion(row) : null;
  }

  /** The newest approved version, the one products and runs should use. */
  latestApproved(id: string): DocumentVersion | null {
    const row = this.db.prepare("select * from documents where id = ? and status = 'approved' order by version desc limit 1").get(id) as Row | undefined;
    return row ? toVersion(row) : null;
  }

  versions(id: string): DocumentSummary[] {
    return (this.db.prepare('select * from documents where id = ? order by version').all(id) as unknown as Row[]).map((r) => summaryOf(toVersion(r)));
  }

  list(filter: { kind?: DocumentKind; scope?: string } = {}): DocumentSummary[] {
    const rows = this.db
      .prepare(
        `select d.* from documents d join (select id, max(version) as v from documents group by id) m on d.id = m.id and d.version = m.v
         where (? is null or d.kind = ?) and (? is null or d.scope = ?) order by d.updated_at desc limit 1000`,
      )
      .all(filter.kind ?? null, filter.kind ?? null, filter.scope ?? null, filter.scope ?? null) as unknown as Row[];
    return rows.map((r) => summaryOf(toVersion(r)));
  }

  create(by: Stamp, input: { id?: string; kind: DocumentKind; scope: string; name: string; body: unknown; classification?: Classification; importedFrom?: DocumentVersion['importedFrom'] }): { doc: DocumentVersion; warnings: FreeTextWarning[] } {
    const { warnings } = checkBody(input.kind, input.body);
    const id = input.id ?? randomUUID();
    if (!DOCUMENT_ID.test(id)) throw new DocumentError(400, 'invalid_id', 'Document ids are letters, digits, dot, dash, colon and underscore (at most 120).');
    if (!ID_PATTERN.test(input.scope)) throw new DocumentError(400, 'invalid_scope', 'scope must be a lower-case event or exercise id.');
    if (this.row(id)) throw new DocumentError(409, 'exists', `A document with id ${id} already exists.`);
    const now = this.now();
    this.db
      .prepare(
        'insert into documents (id, version, kind, scope, name, status, classification, revision, author_user, author_name, author_position, created_at, updated_at, body, body_hash, imported_from) values (?, 1, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, input.kind, input.scope, input.name, 'draft', input.classification ?? 'internal', by.userId, by.name, by.position, now, now, canonicalJson(input.body), bodyHashOf(input.body), input.importedFrom ? JSON.stringify(input.importedFrom) : null);
    return { doc: this.latest(id)!, warnings };
  }

  /**
   * Save an edit. `expectedVersion` and `expectedRevision` are what the editor
   * last loaded; if someone saved in between, this refuses with the current
   * version so nothing is silently overwritten.
   */
  update(by: Stamp, id: string, input: { expectedVersion: number; expectedRevision?: number; name?: string; body?: unknown; classification?: Classification }): { doc: DocumentVersion; newVersion: boolean; warnings: FreeTextWarning[] } {
    return transaction(this.db, () => {
      const current = this.row(id);
      if (!current) throw new DocumentError(404, 'not_found', `No document ${id}.`);
      const latest = toVersion(current);
      if (input.expectedVersion !== current.version || (input.expectedRevision !== undefined && current.status !== 'approved' && input.expectedRevision !== current.revision)) {
        throw new DocumentError(409, 'version_conflict', `Document ${id} changed since you opened it (now version ${current.version}, revision ${current.revision}).`, { current: summaryOf(latest) });
      }
      const body = input.body === undefined ? latest.body : input.body;
      const { warnings } = checkBody(latest.kind, body);
      const now = this.now();
      if (current.status === 'approved') {
        const version = current.version + 1;
        this.db
          .prepare(
            'insert into documents (id, version, kind, scope, name, status, classification, revision, author_user, author_name, author_position, created_at, updated_at, parent_version, body, body_hash) values (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(id, version, current.kind, current.scope, input.name ?? current.name, 'draft', input.classification ?? current.classification, by.userId, by.name, by.position, now, now, current.version, canonicalJson(body), bodyHashOf(body));
        return { doc: this.get(id, version)!, newVersion: true, warnings };
      }
      this.db
        .prepare("update documents set name = ?, classification = ?, body = ?, body_hash = ?, revision = revision + 1, status = 'draft', reviewed_by = null, updated_at = ? where id = ? and version = ?")
        .run(input.name ?? current.name, input.classification ?? current.classification, canonicalJson(body), bodyHashOf(body), now, id, current.version);
      return { doc: this.get(id, current.version)!, newVersion: false, warnings };
    });
  }

  private transition(by: Stamp, id: string, version: number, from: DocumentStatus, to: DocumentStatus, expectedRevision?: number): DocumentVersion {
    return transaction(this.db, () => {
      const row = this.row(id, version);
      if (!row) throw new DocumentError(404, 'not_found', `No version ${version} of document ${id}.`);
      const latest = this.row(id)!;
      if (latest.version !== version) throw new DocumentError(409, 'not_latest', `Version ${version} is not the latest (${latest.version} is).`);
      if (row.status !== from) throw new DocumentError(409, 'invalid_state', `Version ${version} is ${row.status}; it must be ${from} first.`, { current: summaryOf(toVersion(row)) });
      if (expectedRevision !== undefined && expectedRevision !== row.revision) {
        throw new DocumentError(409, 'version_conflict', `Version ${version} was edited (revision ${row.revision}) since you read it.`, { current: summaryOf(toVersion(row)) });
      }
      const stamp = JSON.stringify({ userId: by.userId, name: by.name, position: by.position, at: iso(this.now()) } satisfies PersonStamp);
      if (to === 'reviewed') {
        if (this.twoPerson && row.author_user === by.userId) throw new DocumentError(403, 'two_person_rule', 'The author cannot review their own version on this server.');
        this.db.prepare("update documents set status = 'reviewed', reviewed_by = ?, updated_at = ? where id = ? and version = ?").run(stamp, this.now(), id, version);
      } else if (to === 'approved') {
        if (this.twoPerson && row.author_user === by.userId) throw new DocumentError(403, 'two_person_rule', 'The author cannot approve their own version on this server.');
        this.db.prepare("update documents set status = 'approved', approved_by = ?, updated_at = ? where id = ? and version = ?").run(stamp, this.now(), id, version);
      } else {
        this.db.prepare("update documents set status = 'draft', reviewed_by = null, updated_at = ? where id = ? and version = ?").run(this.now(), id, version);
      }
      return this.get(id, version)!;
    });
  }

  review(by: Stamp, id: string, version: number, expectedRevision?: number): DocumentVersion {
    return this.transition(by, id, version, 'draft', 'reviewed', expectedRevision);
  }

  returnToDraft(by: Stamp, id: string, version: number): DocumentVersion {
    return this.transition(by, id, version, 'reviewed', 'draft');
  }

  approve(by: Stamp, id: string, version: number, expectedRevision?: number): DocumentVersion {
    return this.transition(by, id, version, 'reviewed', 'approved', expectedRevision);
  }
}
