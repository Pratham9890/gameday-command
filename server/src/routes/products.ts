import type { Hono } from 'hono';
import type { ProductKind } from '../types.ts';
import { PRODUCT_KINDS } from '../types.ts';
import type { Platform } from '../platform/platform.ts';
import { auditActor } from '../platform/platform.ts';
import { type AppEnv, type Ctx, fail, readBody } from '../platform/http.ts';
import { ID_PATTERN, scopeOfStream, STREAM_PATTERN, v } from '../platform/validate.ts';
import { deny } from '../platform/middleware.ts';
import { PRODUCT_CSP } from '../platform/headers.ts';
import { can, positionFor } from '../auth/rbac.ts';
import { visibleTo } from '../events/log.ts';
import { activityFromEvents, classificationOf, eapFromDocument, ProductError, type ProductOutput, renderProduct } from '../products/index.ts';

/**
 * Product exports: ICS 201 to 214, the Event Action Plan with its simulation
 * annex, the situation report, GeoJSON and KML, CAP drafts and the HSEEP
 * AAR/IP. HTML (print to PDF from any browser) or JSON; every export is
 * audited with its hash; restricted products need the restricted permission.
 */
const FORMATS = new Set(['html', 'json', 'xml', 'geojson', 'kml']);

const DEFAULT_ASSUMPTIONS = [
  'Fan behaviour follows the shipped decision defaults and cached model answers: an assumption, not a forecast.',
  'Scenario weather, crowd size and arrival windows are those stored with the comparison, not live feeds.',
];

export function addProductRoutes(app: Hono<AppEnv>, platform: Platform): void {
  const send = (c: Ctx, out: ProductOutput, scope: string, extra: Record<string, unknown> = {}) => {
    const actor = c.get('actor')!;
    const permission = out.kind === 'cap' ? 'cap.draft' : 'product.export';
    platform.audit.append({
      actor: auditActor(actor, positionFor(actor, permission, { scope, classification: out.classification })),
      action: out.kind === 'cap' ? 'cap.draft' : 'product.export',
      target: `${out.kind}:${scope}`,
      detail: { kind: out.kind, format: out.format, pages: out.pages, classification: out.classification, sha256: out.sha256, ...extra },
    });
    const headers: Record<string, string> = {
      'content-type': out.contentType,
      'content-disposition': `${out.format === 'html' ? 'inline' : 'attachment'}; filename="${out.filename}"`,
      'x-gameday-classification': out.classification,
      'x-gameday-sha256': out.sha256,
      ...(out.pages === null ? {} : { 'x-gameday-pages': String(out.pages) }),
      ...(out.kind === 'cap' ? { 'x-gameday-not-sent': 'true' } : {}),
    };
    if (out.format === 'html') headers['content-security-policy'] = PRODUCT_CSP;
    return c.body(out.body, 200, headers);
  };

  const render = (c: Ctx, kind: ProductKind, input: unknown, mapId?: string) => {
    try {
      return renderProduct(kind, input, c.req.query('format'), { map: mapId ? platform.maps(mapId) : undefined, demo: platform.config.demo, now: platform.now(), capSender: platform.config.capSender });
    } catch (error) {
      if (error instanceof ProductError) return fail(c, error.status, error.status === 422 ? 'unprocessable' : 'invalid_request', error.message, { errors: error.errors });
      throw error;
    }
  };

  app.post('/api/v3/products/:kind', async (c) => {
    const kind = c.req.param('kind') as ProductKind;
    if (!(PRODUCT_KINDS as readonly string[]).includes(kind)) return fail(c, 404, 'not_found', `No product ${kind}. Products: ${PRODUCT_KINDS.join(', ')}.`);
    const format = c.req.query('format');
    if (format !== undefined && !FORMATS.has(format)) return fail(c, 400, 'invalid_format', 'format is html, json, xml, geojson or kml.');
    const body = await readBody(
      c,
      v.object({
        scope: v.string({ pattern: ID_PATTERN }),
        input: v.object({}, { extra: true }),
        fromStream: v.optional(v.object({ stream: v.string({ pattern: STREAM_PATTERN }), position: v.optional(v.string({ max: 40 })), unit: v.optional(v.string({ max: 60 })), includeFreeText: v.optional(v.boolean()) })),
      }),
    );
    if (!body.ok) return body.response;
    const { scope, fromStream } = body.value;
    let input = body.value.input as Record<string, unknown>;
    const classification = kind === 'cap' ? (input.scope === 'Public' ? 'internal' : 'restricted') : classificationOf(kind, input as never);
    const refused = deny(c, platform, kind === 'cap' ? 'cap.draft' : 'product.export', { scope, classification });
    if (refused) return refused;

    if (kind === 'ics214' && fromStream) {
      if (scopeOfStream(fromStream.stream) !== scope) return fail(c, 400, 'invalid_request', 'fromStream.stream must belong to scope.');
      const actor = c.get('actor')!;
      const events = platform.events.since(fromStream.stream, 0, 5000).filter((s) => visibleTo(actor, s));
      input = { ...input, entries: activityFromEvents(events, fromStream) };
    }
    const out = render(c, kind, input, typeof input.mapId === 'string' ? input.mapId : typeof (input.map as { mapId?: string } | undefined)?.mapId === 'string' ? (input.map as { mapId: string }).mapId : undefined);
    if (out instanceof Response) return out;
    return send(c, out, scope, { fromStream: fromStream?.stream ?? null, freeText: fromStream?.includeFreeText ?? false });
  });

  /** The Event Action Plan straight from a stored plan version: prepared and approved by come from the workflow. */
  app.get('/api/v3/documents/:id/versions/:version/eap', (c) => {
    const doc = platform.documents.get(c.req.param('id'), Number(c.req.param('version')));
    if (!doc || doc.kind !== 'plan') return fail(c, 404, 'not_found', 'No such plan version.');
    const refused = deny(c, platform, 'plan.read', { scope: doc.scope }) ?? deny(c, platform, 'product.export', { scope: doc.scope, classification: doc.classification });
    if (refused) return refused;
    const comparisonId = c.req.query('comparisonId');
    const comparison = comparisonId
      ? platform.comparisons.get(comparisonId)
      : (platform.comparisons.list(doc.scope).find((r) => r.planRefs.some((p) => p.documentId === doc.id && p.version === doc.version)) ?? null);
    if (comparison && !can(c.get('actor'), 'comparison.read', { scope: comparison.scope })) return fail(c, 403, 'forbidden', 'You may not read that comparison.');
    try {
      const input = eapFromDocument(doc, { comparison, mode: c.req.query('mode') === 'exercise' ? 'exercise' : 'simulation', assumptions: DEFAULT_ASSUMPTIONS });
      const out = render(c, 'eap', input, comparison?.mapId);
      if (out instanceof Response) return out;
      return send(c, out, doc.scope, { documentId: doc.id, version: doc.version, comparisonId: comparison?.id ?? null });
    } catch (error) {
      if (error instanceof ProductError) return fail(c, error.status, 'unprocessable', error.message);
      throw error;
    }
  });
}
