import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import type { Actor, DocumentKind, DocumentVersion, Permission } from '../types.ts';
import { CLASSIFICATIONS, DOCUMENT_KINDS } from '../types.ts';
import type { Platform } from '../platform/platform.ts';
import { auditActor } from '../platform/platform.ts';
import { type AppEnv, type Ctx, fail, readBody } from '../platform/http.ts';
import { ID_PATTERN, v } from '../platform/validate.ts';
import { deny } from '../platform/middleware.ts';
import { can, positionFor } from '../auth/rbac.ts';
import { DocumentError, type Stamp } from '../library/documents.ts';
import { buildPackage, importPackage } from '../library/packages.ts';
import { comparisonInput } from '../library/comparisons.ts';

/** Versioned scenarios, plans and exercise packages; package files; comparisons. */
const perm = (kind: DocumentKind, verb: 'read' | 'write' | 'review' | 'approve') => `${kind}.${verb}` as Permission;

export function stampFor(actor: Actor, permission: Permission, scope?: string): Stamp {
  return { userId: actor.userId, name: actor.displayName, position: positionFor(actor, permission, { scope }) };
}

export function addLibraryRoutes(app: Hono<AppEnv>, platform: Platform): void {
  const { documents, audit, comparisons } = platform;

  const handle = (c: Ctx, error: unknown) => {
    if (error instanceof DocumentError) return fail(c, error.status, error.code, error.message, error.extra);
    throw error;
  };

  const viewed = (c: Ctx, doc: DocumentVersion) => {
    if (doc.classification === 'restricted') {
      const actor = c.get('actor')!;
      audit.append({ actor: auditActor(actor, positionFor(actor, perm(doc.kind, 'read'), { scope: doc.scope })), action: 'document.view', target: `${doc.id}@${doc.version}`, detail: { kind: doc.kind, classification: doc.classification } });
    }
  };

  /** Workflow events go to the scope's library stream, so the timeline and the ICS 214 show approvals. */
  const announce = (actor: Actor, doc: DocumentVersion, type: 'document.reviewed' | 'document.approved', position: string | null) => {
    try {
      platform.events.append(
        actor,
        { id: randomUUID(), stream: `${doc.scope}/library`, type, mode: 'plan', payload: { documentId: doc.id, kind: doc.kind, version: doc.version, name: doc.name.slice(0, 200) }, asPosition: (position ?? undefined) as never },
        { system: true },
      );
    } catch {
      /* the audit entry is the record of authority; the timeline event is a convenience */
    }
  };

  app.get('/api/v3/documents', (c) => {
    const kind = c.req.query('kind') as DocumentKind | undefined;
    if (kind && !DOCUMENT_KINDS.includes(kind)) return fail(c, 400, 'invalid_kind', 'kind is scenario, plan or exercise.');
    const scope = c.req.query('scope') || undefined;
    const kinds = kind ? [kind] : [...DOCUMENT_KINDS];
    const actor = c.get('actor');
    if (!kinds.some((k) => can(actor, perm(k, 'read'), { scope }))) return deny(c, platform, perm(kinds[0]!, 'read'), { scope })!;
    return c.json(documents.list({ kind, scope }).filter((d) => can(actor, perm(d.kind, 'read'), { scope: d.scope, classification: d.classification })));
  });

  app.post('/api/v3/documents', async (c) => {
    const body = await readBody(
      c,
      v.object({
        id: v.optional(v.string({ min: 1, max: 120, pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]*$/ })),
        kind: v.literal(DOCUMENT_KINDS),
        scope: v.string({ pattern: ID_PATTERN }),
        name: v.string({ min: 1, max: 200, trim: true }),
        classification: v.optional(v.literal(CLASSIFICATIONS)),
        body: v.json(),
      }),
    );
    if (!body.ok) return body.response;
    const input = body.value;
    const refused = deny(c, platform, perm(input.kind, 'write'), { scope: input.scope });
    if (refused) return refused;
    try {
      const actor = c.get('actor')!;
      const stamp = stampFor(actor, perm(input.kind, 'write'), input.scope);
      const { doc, warnings } = documents.create(stamp, input);
      audit.append({ actor: auditActor(actor, stamp.position), action: 'document.create', target: `${doc.id}@1`, detail: { kind: doc.kind, scope: doc.scope, classification: doc.classification, bodyHash: doc.bodyHash } });
      return c.json({ document: doc, warnings }, 201);
    } catch (error) {
      return handle(c, error);
    }
  });

  const load = (c: Ctx, verb: 'read' | 'write' | 'review' | 'approve', version?: number) => {
    const id = c.req.param('id')!;
    const doc = version === undefined ? documents.latest(id) : documents.get(id, version);
    if (!doc) return { response: fail(c, 404, 'not_found', version === undefined ? `No document ${id}.` : `No version ${version} of ${id}.`) };
    const refused = deny(c, platform, perm(doc.kind, verb), { scope: doc.scope, classification: verb === 'read' ? undefined : doc.classification });
    if (refused) return { response: refused };
    return { doc };
  };

  app.get('/api/v3/documents/:id', (c) => {
    const { doc, response } = load(c, 'read');
    if (!doc) return response;
    viewed(c, doc);
    return c.json({ ...doc, versions: documents.versions(doc.id), latestApproved: documents.latestApproved(doc.id)?.version ?? null });
  });

  app.get('/api/v3/documents/:id/versions', (c) => {
    const { doc, response } = load(c, 'read');
    if (!doc) return response;
    return c.json(documents.versions(doc.id));
  });

  app.get('/api/v3/documents/:id/versions/:version', (c) => {
    const { doc, response } = load(c, 'read', Number(c.req.param('version')));
    if (!doc) return response;
    viewed(c, doc);
    return c.json(doc);
  });

  app.put('/api/v3/documents/:id', async (c) => {
    const { doc, response } = load(c, 'write');
    if (!doc) return response;
    const body = await readBody(
      c,
      v.object({
        expectedVersion: v.number({ int: true, min: 1 }),
        expectedRevision: v.optional(v.number({ int: true, min: 1 })),
        name: v.optional(v.string({ min: 1, max: 200, trim: true })),
        classification: v.optional(v.literal(CLASSIFICATIONS)),
        body: v.optional(v.json()),
      }),
    );
    if (!body.ok) return body.response;
    try {
      const actor = c.get('actor')!;
      const stamp = stampFor(actor, perm(doc.kind, 'write'), doc.scope);
      const result = documents.update(stamp, doc.id, body.value);
      audit.append({ actor: auditActor(actor, stamp.position), action: 'document.update', target: `${result.doc.id}@${result.doc.version}`, detail: { newVersion: result.newVersion, revision: result.doc.revision, bodyHash: result.doc.bodyHash } });
      return c.json({ document: result.doc, newVersion: result.newVersion, warnings: result.warnings }, result.newVersion ? 201 : 200);
    } catch (error) {
      return handle(c, error);
    }
  });

  const workflow = (verb: 'review' | 'return' | 'approve') => async (c: Ctx) => {
    const version = Number(c.req.param('version'));
    const { doc, response } = load(c, verb === 'approve' ? 'approve' : 'review', version);
    if (!doc) return response;
    let expectedRevision: number | undefined;
    if ((c.req.header('content-type') ?? '').startsWith('application/json')) {
      const body = await readBody(c, v.object({ expectedRevision: v.optional(v.number({ int: true, min: 1 })) }));
      if (!body.ok) return body.response;
      expectedRevision = body.value.expectedRevision;
    }
    try {
      const actor = c.get('actor')!;
      const permission = perm(doc.kind, verb === 'approve' ? 'approve' : 'review');
      const stamp = stampFor(actor, permission, doc.scope);
      const next = verb === 'review' ? documents.review(stamp, doc.id, version, expectedRevision) : verb === 'approve' ? documents.approve(stamp, doc.id, version, expectedRevision) : documents.returnToDraft(stamp, doc.id, version);
      audit.append({ actor: auditActor(actor, stamp.position), action: verb === 'review' ? 'document.review' : verb === 'approve' ? 'document.approve' : 'document.return', target: `${doc.id}@${version}`, detail: { kind: doc.kind, bodyHash: next.bodyHash } });
      if (verb !== 'return') announce(actor, next, verb === 'review' ? 'document.reviewed' : 'document.approved', stamp.position);
      return c.json(next);
    } catch (error) {
      return handle(c, error);
    }
  };
  app.post('/api/v3/documents/:id/versions/:version/review', workflow('review'));
  app.post('/api/v3/documents/:id/versions/:version/return', workflow('return'));
  app.post('/api/v3/documents/:id/versions/:version/approve', workflow('approve'));

  const exportDocs = (c: Ctx, docs: DocumentVersion[], engineVersion?: string, comparisonIds: string[] = []) => {
    const actor = c.get('actor')!;
    for (const doc of docs) {
      const refused = deny(c, platform, perm(doc.kind, 'read'), { scope: doc.scope }) ?? deny(c, platform, 'product.export', { scope: doc.scope, classification: doc.classification });
      if (refused) return refused;
    }
    const linked = comparisonIds.map((id) => comparisons.get(id)).filter((r): r is NonNullable<typeof r> => Boolean(r) && can(actor, 'comparison.read', { scope: r!.scope }));
    const file = buildPackage({ documents: docs, comparisons: linked, engineVersion, exportedBy: { userId: actor.userId, position: positionFor(actor, 'product.export', { scope: docs[0]?.scope }) }, now: platform.now() });
    audit.append({ actor: auditActor(actor), action: 'package.export', target: docs.map((d) => `${d.id}@${d.version}`).join(',').slice(0, 160), detail: { documents: docs.length, comparisons: linked.length, hash: file.integrity.hash, classification: file.classification } });
    c.header('content-disposition', `attachment; filename="gameday-package-${file.integrity.hash.slice(0, 12)}.json"`);
    return c.json(file);
  };

  app.get('/api/v3/documents/:id/export', (c) => {
    const version = c.req.query('version');
    const { doc, response } = load(c, 'read', version ? Number(version) : undefined);
    if (!doc) return response;
    return exportDocs(c, [doc], c.req.query('engineVersion'));
  });

  app.post('/api/v3/packages/export', async (c) => {
    const body = await readBody(c, v.object({ documents: v.array(v.object({ id: v.string({ min: 1, max: 120 }), version: v.optional(v.number({ int: true, min: 1 })) }), { min: 1, max: 200 }), comparisonIds: v.optional(v.array(v.string({ max: 80 }), { max: 100 })), engineVersion: v.optional(v.string({ max: 100 })) }));
    if (!body.ok) return body.response;
    const docs: DocumentVersion[] = [];
    for (const ref of body.value.documents) {
      const doc = ref.version ? documents.get(ref.id, ref.version) : documents.latest(ref.id);
      if (!doc) return fail(c, 404, 'not_found', `No document ${ref.id}${ref.version ? ` version ${ref.version}` : ''}.`);
      docs.push(doc);
    }
    return exportDocs(c, docs, body.value.engineVersion, body.value.comparisonIds);
  });

  app.post('/api/v3/packages/import', async (c) => {
    const body = await readBody(c, v.object({ package: v.json({ maxBytes: 64 * 1024 * 1024 }), scope: v.optional(v.string({ pattern: ID_PATTERN })) }));
    if (!body.ok) return body.response;
    const file = body.value.package as { documents?: { kind?: string; scope?: string }[] };
    const actor = c.get('actor');
    for (const d of Array.isArray(file?.documents) ? file.documents : []) {
      const kind = DOCUMENT_KINDS.includes(d.kind as DocumentKind) ? (d.kind as DocumentKind) : 'plan';
      const refused = deny(c, platform, perm(kind, 'write'), { scope: body.value.scope ?? d.scope });
      if (refused) return refused;
    }
    if (!actor) return deny(c, platform, 'plan.write')!;
    try {
      const result = importPackage(body.value.package, documents, comparisons, stampFor(actor, 'plan.write', body.value.scope), body.value.scope);
      audit.append({ actor: auditActor(actor), action: 'package.import', target: result.packageHash.slice(0, 16), detail: { imported: result.imported.length, skipped: result.skipped.length, comparisons: result.comparisons, hash: result.packageHash } });
      return c.json(result, 201);
    } catch (error) {
      return handle(c, error);
    }
  });

  // ── Comparisons (PLT-37, PLT-45) ─────────────────────────────

  app.post('/api/v3/comparisons', async (c) => {
    const body = await readBody(c, comparisonInput);
    if (!body.ok) return body.response;
    const refused = deny(c, platform, 'comparison.write', { scope: body.value.scope });
    if (refused) return refused;
    const actor = c.get('actor')!;
    try {
      const record = comparisons.create(stampFor(actor, 'comparison.write', body.value.scope), body.value);
      audit.append({ actor: auditActor(actor), action: 'comparison.create', target: record.id, detail: { scope: record.scope, seed: record.seed, tapeHash: record.tapeHash, engineVersion: record.engineVersion } });
      return c.json(record, 201);
    } catch (error) {
      return fail(c, 400, 'invalid_request', error instanceof Error ? error.message : String(error));
    }
  });

  app.get('/api/v3/comparisons', (c) => {
    const scope = c.req.query('scope') || undefined;
    const refused = deny(c, platform, 'comparison.read', { scope });
    if (refused) return refused;
    const actor = c.get('actor');
    return c.json(comparisons.list(scope).filter((r) => can(actor, 'comparison.read', { scope: r.scope })));
  });

  app.get('/api/v3/comparisons/:id', (c) => {
    const record = comparisons.get(c.req.param('id'));
    if (!record) return fail(c, 404, 'not_found', 'No such comparison.');
    return deny(c, platform, 'comparison.read', { scope: record.scope }) ?? c.json(record);
  });

}
