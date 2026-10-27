import type { Classification, ComparisonRecord, DocumentVersion, PackageDocument, PackageFile } from '../types.ts';
import { DOCUMENT_KINDS, PACKAGE_FORMAT, PACKAGE_SCHEMA_VERSION } from '../types.ts';
import { CONTRACT_VERSION } from '../../../contracts.ts';
import { canonicalJson, sha256Hex } from '../platform/canonical.ts';
import { parse, v } from '../platform/validate.ts';
import { bodyHashOf, DocumentError, type DocumentStore, type Stamp } from './documents.ts';
import type { ComparisonStore } from './comparisons.ts';

/**
 * The scenario/plan/exercise package file (PLT-45): one JSON file carrying the
 * schema version (SemVer), engine and contract versions, the seed, every
 * document with its version metadata and body hash, any comparisons, and an
 * integrity hash over the whole file.
 *
 * Approval does not travel. An imported version arrives as a draft on this
 * server, with where it came from recorded, and is reviewed and approved here
 * by people who hold those positions here.
 */
export const ENGINE_VERSION_UNKNOWN = 'unspecified';

const CLASS_RANK: Record<Classification, number> = { public: 0, internal: 1, restricted: 2 };

export function buildPackage(input: {
  documents: DocumentVersion[];
  comparisons?: ComparisonRecord[];
  engineVersion?: string;
  seed?: number | null;
  exportedBy: { userId: string; position: string | null };
  now: number;
}): PackageFile {
  const documents: PackageDocument[] = input.documents.map((d) => ({
    id: d.id,
    kind: d.kind,
    version: d.version,
    status: d.status,
    name: d.name,
    scope: d.scope,
    classification: d.classification,
    author: d.author.name,
    created: d.created,
    updated: d.updated,
    reviewedBy: d.reviewedBy?.name ?? null,
    approvedBy: d.approvedBy?.name ?? null,
    approvedAt: d.approvedBy?.at ?? null,
    parentVersion: d.parentVersion,
    bodyHash: d.bodyHash,
    body: d.body,
  }));
  const scenarioSeed = input.documents.find((d) => d.kind === 'scenario')?.body as { seed?: number } | undefined;
  const classification = documents.reduce<Classification>((worst, d) => (CLASS_RANK[d.classification] > CLASS_RANK[worst] ? d.classification : worst), 'public');
  const file: Omit<PackageFile, 'integrity'> = {
    format: PACKAGE_FORMAT,
    schemaVersion: PACKAGE_SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    engineVersion: input.engineVersion ?? ENGINE_VERSION_UNKNOWN,
    exportedAt: new Date(input.now).toISOString(),
    exportedBy: input.exportedBy,
    seed: input.seed ?? scenarioSeed?.seed ?? null,
    classification,
    documents,
    comparisons: input.comparisons ?? [],
  };
  return { ...file, integrity: { algorithm: 'sha256', hash: sha256Hex(canonicalJson(file)) } };
}

const packageShape = v.object({
  format: v.literal([PACKAGE_FORMAT] as const),
  schemaVersion: v.string({ pattern: /^\d+\.\d+\.\d+$/ }),
  contractVersion: v.string({ max: 40 }),
  engineVersion: v.string({ max: 100 }),
  exportedAt: v.string({ max: 40 }),
  exportedBy: v.object({ userId: v.string({ max: 80 }), position: v.nullable(v.string({ max: 40 })) }),
  seed: v.nullable(v.number()),
  classification: v.literal(['public', 'internal', 'restricted'] as const),
  documents: v.array(
    v.object(
      {
        id: v.string({ min: 1, max: 120 }),
        kind: v.literal(DOCUMENT_KINDS),
        version: v.number({ int: true, min: 1 }),
        status: v.literal(['draft', 'reviewed', 'approved'] as const),
        name: v.string({ min: 1, max: 200 }),
        scope: v.string({ max: 80 }),
        classification: v.literal(['public', 'internal', 'restricted'] as const),
        bodyHash: v.string({ pattern: /^[0-9a-f]{64}$/ }),
        body: v.json(),
      },
      { extra: true },
    ),
    { max: 500 },
  ),
  comparisons: v.array(v.any(), { max: 1000 }),
  integrity: v.object({ algorithm: v.literal(['sha256'] as const), hash: v.string({ pattern: /^[0-9a-f]{64}$/ }) }),
});

export interface ImportResult {
  imported: { id: string; version: number; kind: string; name: string; from: { id: string; version: number } }[];
  skipped: { id: string; version: number; reason: string }[];
  comparisons: number;
  warnings: string[];
  packageHash: string;
}

/** Check a package file and load it as drafts. Refuses an altered file or an incompatible schema. */
export function importPackage(raw: unknown, store: DocumentStore, comparisons: ComparisonStore, by: Stamp, scopeOverride?: string): ImportResult {
  const parsed = parse(packageShape, raw);
  if (!parsed.ok) throw new DocumentError(400, 'invalid_package', parsed.errors[0]!, { errors: parsed.errors });
  const file = raw as PackageFile;
  const warnings: string[] = [];
  const [major, minor] = file.schemaVersion.split('.').map(Number) as [number, number];
  const [ourMajor, ourMinor] = PACKAGE_SCHEMA_VERSION.split('.').map(Number) as [number, number];
  if (major !== ourMajor) throw new DocumentError(422, 'incompatible_schema', `This server reads package schema ${ourMajor}.x; the file is ${file.schemaVersion}.`);
  if (minor > ourMinor) warnings.push(`The file uses schema ${file.schemaVersion}, newer than this server's ${PACKAGE_SCHEMA_VERSION}; fields it does not know were kept as they are.`);
  if (file.contractVersion !== CONTRACT_VERSION) warnings.push(`The file was made for contract ${file.contractVersion}; this server runs ${CONTRACT_VERSION}. Re-run comparisons before relying on them.`);
  const { integrity, ...rest } = file;
  if (sha256Hex(canonicalJson(rest)) !== integrity.hash) throw new DocumentError(422, 'integrity_failed', 'The package was altered or damaged after it was exported (integrity hash mismatch).');

  const result: ImportResult = { imported: [], skipped: [], comparisons: 0, warnings, packageHash: integrity.hash };
  // Newest version of each document only: its history stays with the exporting server.
  const newest = new Map<string, PackageDocument>();
  for (const doc of file.documents) if ((newest.get(doc.id)?.version ?? 0) < doc.version) newest.set(doc.id, doc);
  for (const doc of newest.values()) {
    if (bodyHashOf(doc.body) !== doc.bodyHash) throw new DocumentError(422, 'integrity_failed', `Document ${doc.id} version ${doc.version} does not match its body hash.`);
    const existing = store.latest(doc.id);
    if (existing && existing.bodyHash === doc.bodyHash) {
      result.skipped.push({ id: doc.id, version: doc.version, reason: `already here as version ${existing.version}` });
      continue;
    }
    const importedFrom = { packageHash: integrity.hash, version: doc.version, status: doc.status, approvedBy: doc.approvedBy };
    const created = existing
      ? store.create(by, { kind: doc.kind, scope: scopeOverride ?? doc.scope, name: doc.name, body: doc.body, classification: doc.classification, importedFrom })
      : store.create(by, { id: doc.id, kind: doc.kind, scope: scopeOverride ?? doc.scope, name: doc.name, body: doc.body, classification: doc.classification, importedFrom });
    result.imported.push({ id: created.doc.id, version: created.doc.version, kind: doc.kind, name: doc.name, from: { id: doc.id, version: doc.version } });
  }
  for (const record of file.comparisons as ComparisonRecord[]) {
    if (record && typeof record === 'object' && typeof record.id === 'string' && comparisons.importRecord({ ...record, scope: scopeOverride ?? record.scope })) result.comparisons++;
  }
  return result;
}
