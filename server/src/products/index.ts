import type { MapBundle } from '../../../contracts.ts';
import type { AarInput, CapAlertInput, Classification, ComparisonRecord, DocumentVersion, EapInput, GeoExportInput, Ics201Input, Ics202Input, Ics203Input, Ics204Input, Ics205Input, Ics206Input, Ics208Input, Ics214Input, PlanDocumentBody, ProductKind, ProductMeta, SimulationAnnex, SitrepInput } from '../types.ts';
import type { StoredEvent } from '../events/log.ts';
import { summarize } from '../events/registry.ts';
import { sha256Hex } from '../platform/canonical.ts';
import { type Check, parse, v } from '../platform/validate.ts';
import { atLeast, modeBanner } from './html.ts';
import { renderDocument, type SheetSpec } from './layout.ts';
import { ics201, ics202, ics203, ics204, ics205, ics206, ics208, ics214 } from './ics.ts';
import { eapDocument } from './eap.ts';
import { annexSheets } from './annex.ts';
import { sitrepSheets } from './sitrep.ts';
import { aarSheets } from './aar.ts';
import { buildCap, capSheets } from './cap.ts';
import { toGeoJson, toKml } from './geo.ts';

/**
 * One entry point for every product: check the typed input, render it, and
 * say what came out (content type, classification, pages and a hash for the
 * audit record). Templates live beside this file.
 */
export interface ProductContext {
  map?: MapBundle;
  demo: boolean;
  now: number;
  capSender: string;
}

export interface ProductOutput {
  kind: ProductKind;
  format: 'html' | 'json' | 'xml' | 'geojson' | 'kml';
  contentType: string;
  body: string;
  classification: Classification;
  pages: number | null;
  sha256: string;
  filename: string;
  /** Extra facts for the JSON form and the audit record (CAP checks, page index). */
  facts: Record<string, unknown>;
}

export class ProductError extends Error {
  readonly status: 400 | 422;
  readonly errors: string[];
  constructor(status: 400 | 422, message: string, errors: string[] = []) {
    super(message);
    this.status = status;
    this.errors = errors;
  }
}

const person = v.object({ name: v.string({ min: 1, max: 120 }), position: v.string({ min: 1, max: 120 }), at: v.optional(v.string({ max: 40 })) });
export const metaCheck = v.object(
  {
    incidentName: v.string({ min: 1, max: 200 }),
    preparedBy: person,
    approvedBy: v.optional(v.nullable(person)),
    version: v.string({ min: 1, max: 60 }),
    classification: v.literal(['public', 'internal', 'restricted'] as const),
    mode: v.literal(['exercise', 'simulation'] as const),
    operationalPeriod: v.optional(v.object({ from: v.string({ max: 40 }), to: v.string({ max: 40 }) })),
  },
  { extra: true },
);

const loose = (shape: Record<string, Check<unknown>>) => v.object(shape, { extra: true });
const arr = (max = 500) => v.array(v.any(), { max });

/** Required fields per product; the rest is optional and type-guided. */
const INPUT_CHECKS: Record<Exclude<ProductKind, 'geojson' | 'kml' | 'cap'>, Check<unknown>> = {
  ics201: loose({ meta: metaCheck, initiatedAt: v.string({ max: 40 }), situationSummary: v.string({ max: 20_000 }), objectives: v.array(v.string({ max: 2000 }), { max: 100 }), actions: arr(), organization: arr(), resources: arr() }),
  ics202: loose({ meta: metaCheck, sections: loose({ objectives: v.array(v.string({ max: 2000 }), { max: 100 }) }) }),
  ics203: loose({ meta: metaCheck, organization: arr(50) }),
  ics204: loose({ meta: metaCheck, assignments: arr(200) }),
  ics205: loose({ meta: metaCheck, radio: v.nullable(loose({ source: v.literal(['agency'] as const), channels: arr(300) })) }),
  ics206: loose({ meta: metaCheck, medical: loose({ aidStations: arr(), transportation: arr(), hospitals: arr() }) }),
  ics208: loose({ meta: metaCheck, safety: loose({ message: v.string({ max: 20_000 }) }) }),
  ics214: loose({ meta: metaCheck, name: v.string({ min: 1, max: 120 }), position: v.string({ min: 1, max: 120 }), entries: arr(5000) }),
  eap: loose({ meta: metaCheck, sections: loose({ objectives: v.array(v.string({ max: 2000 }), { max: 100 }) }) }),
  annex: loose({ meta: metaCheck, annex: loose({ scorecards: v.array(v.any(), { min: 1, max: 3 }), assumptions: v.array(v.string({ max: 2000 }), { max: 100 }), seed: v.number(), engineVersion: v.string({ max: 100 }) }) }),
  sitrep: loose({ meta: metaCheck, asOf: v.string({ max: 40 }), summary: v.string({ max: 20_000 }), keyFigures: arr(200), actionsTaken: v.array(v.string({ max: 2000 }), { max: 200 }), plannedActions: v.array(v.string({ max: 2000 }), { max: 200 }) }),
  aar: loose({ meta: metaCheck, exercise: loose({ name: v.string({ min: 1, max: 200 }), objectives: arr(50) }), analysis: arr(100), improvementPlan: arr(500) }),
};

const geoCheck = loose({ mapId: v.string({ min: 1, max: 120 }), provenance: loose({ kind: v.string({ max: 20 }), source: v.string({ max: 200 }) }) });
const capCheck = loose({ status: v.string({ max: 20 }), msgType: v.string({ max: 20 }), scope: v.string({ max: 20 }), info: v.array(v.any(), { min: 1, max: 4 }) });

const FILE: Record<ProductKind, string> = {
  ics201: 'ICS-201-incident-briefing',
  ics202: 'ICS-202-incident-objectives',
  ics203: 'ICS-203-organization',
  ics204: 'ICS-204-assignment-list',
  ics205: 'ICS-205-radio-plan',
  ics206: 'ICS-206-medical-plan',
  ics208: 'ICS-208-safety-message',
  ics214: 'ICS-214-activity-log',
  eap: 'event-action-plan',
  annex: 'simulation-annex',
  sitrep: 'situation-report',
  geojson: 'features',
  kml: 'features',
  cap: 'CAP-draft-NOT-SENT',
  aar: 'AAR-IP',
};

function checked<T>(check: Check<unknown>, input: unknown): T {
  const result = parse(check, input, 'input');
  if (!result.ok) throw new ProductError(400, result.errors[0]!, result.errors);
  return input as T;
}

/** Plan pages that carry the radio plan are restricted, whatever the plan's own marking. */
export function classificationOf(kind: ProductKind, input: { meta?: ProductMeta; sections?: { radio?: unknown }; classification?: Classification }): Classification {
  const base = input.meta?.classification ?? input.classification ?? 'internal';
  if (kind === 'ics205' || (kind === 'eap' && input.sections?.radio)) return atLeast(base, 'restricted');
  return base;
}

export function renderProduct(kind: ProductKind, raw: unknown, format: string | undefined, ctx: ProductContext): ProductOutput {
  const stamp = (meta: ProductMeta): ProductMeta => ({ ...meta, demo: ctx.demo || meta.demo, generatedAt: new Date(ctx.now).toISOString() });
  const done = (out: Omit<ProductOutput, 'sha256'>): ProductOutput => ({ ...out, sha256: sha256Hex(out.body) });

  if (kind === 'geojson' || kind === 'kml') {
    const input = checked<GeoExportInput>(geoCheck, raw);
    if (!ctx.map) throw new ProductError(422, `no map ${input.mapId}`);
    if (!ctx.map.geo) throw new ProductError(422, `map ${input.mapId} has no georeference, so it cannot be exported to GIS`);
    const banner = `${ctx.demo ? 'DEMO — SYNTHETIC DATA — ' : ''}${input.provenance.kind === 'planned' ? 'PLANNED FEATURES' : 'SIMULATION'}`;
    const opts = { generatedAt: new Date(ctx.now).toISOString(), banner };
    const classification = input.classification ?? 'internal';
    if (kind === 'geojson') {
      const collection = toGeoJson(input, ctx.map, opts);
      return done({ kind, format: 'geojson', contentType: 'application/geo+json', body: JSON.stringify(collection), classification, pages: null, filename: `${FILE.geojson}.geojson`, facts: { features: collection.features.length } });
    }
    const kml = toKml(input, ctx.map, opts);
    return done({ kind, format: 'kml', contentType: 'application/vnd.google-earth.kml+xml', body: kml, classification, pages: null, filename: `${FILE.kml}.kml`, facts: {} });
  }

  if (kind === 'cap') {
    const input = checked<CapAlertInput & { meta?: ProductMeta }>(capCheck, raw);
    const draft = (() => {
      try {
        return buildCap(input, { sender: ctx.capSender, now: ctx.now });
      } catch (error) {
        const check = (error as { check?: { errors: string[] } }).check;
        throw new ProductError(422, error instanceof Error ? error.message : String(error), check?.errors ?? []);
      }
    })();
    const classification: Classification = input.scope === 'Public' ? 'internal' : 'restricted';
    if (format === 'html') {
      const meta: ProductMeta = stamp(input.meta ?? { incidentName: input.info[0]!.event, preparedBy: { name: 'Not stated', position: 'PIO' }, version: 'draft', classification, mode: input.status === 'Exercise' ? 'exercise' : 'simulation', exerciseName: input.exerciseId });
      const doc = renderDocument(`CAP draft: ${input.info[0]!.event}`, meta, capSheets(input, draft));
      return done({ kind, format: 'html', contentType: 'text/html; charset=utf-8', body: doc.html, classification, pages: doc.pages, filename: `${FILE.cap}.html`, facts: { check: draft.check, identifier: draft.identifier } });
    }
    if (format === 'json') {
      return done({ kind, format: 'json', contentType: 'application/json', body: JSON.stringify({ identifier: draft.identifier, sent: draft.sent, status: input.status, check: draft.check, xml: draft.xml, notSent: true }), classification, pages: null, filename: `${FILE.cap}.json`, facts: { check: draft.check } });
    }
    return done({ kind, format: 'xml', contentType: 'application/xml; charset=utf-8', body: draft.xml, classification, pages: null, filename: `${FILE.cap}-${draft.identifier}.xml`, facts: { check: draft.check, identifier: draft.identifier } });
  }

  const input = checked<{ meta: ProductMeta }>(INPUT_CHECKS[kind], raw);
  const meta = stamp(input.meta);
  const classification = classificationOf(kind, input as never);
  let specs: SheetSpec[] = [];
  let title = '';
  let rendered: { html: string; pages: number; index: unknown } | null = null;
  switch (kind) {
    case 'ics201':
      specs = ics201(input as Ics201Input, ctx.map);
      title = 'ICS 201 Incident Briefing';
      break;
    case 'ics202':
      specs = ics202(meta, (input as Ics202Input).sections);
      title = 'ICS 202 Incident Objectives';
      break;
    case 'ics203':
      specs = ics203((input as Ics203Input).organization);
      title = 'ICS 203 Organization Assignment List';
      break;
    case 'ics204':
      specs = ics204((input as Ics204Input).assignments);
      title = 'ICS 204 Assignment List';
      break;
    case 'ics205':
      specs = ics205((input as Ics205Input).radio);
      title = 'ICS 205 Incident Radio Communications Plan';
      break;
    case 'ics206':
      specs = ics206((input as Ics206Input).medical);
      title = 'ICS 206 Medical Plan';
      break;
    case 'ics208':
      specs = ics208((input as Ics208Input).safety);
      title = 'ICS 208 Safety Message/Plan';
      break;
    case 'ics214':
      specs = ics214(input as Ics214Input);
      title = 'ICS 214 Activity Log';
      break;
    case 'annex':
      specs = annexSheets((input as unknown as { annex: SimulationAnnex }).annex);
      title = 'Simulation annex';
      break;
    case 'sitrep':
      specs = sitrepSheets(input as SitrepInput);
      title = 'Situation report';
      break;
    case 'aar':
      specs = aarSheets(input as AarInput);
      title = `After-Action Report/Improvement Plan: ${(input as AarInput).exercise.name}`;
      break;
    case 'eap':
      rendered = eapDocument({ ...(input as EapInput), meta: { ...meta, classification } }, ctx.map);
      title = 'Event Action Plan';
      break;
  }
  rendered ??= renderDocument(`${title}: ${meta.incidentName}`, { ...meta, classification }, specs);
  if (format === 'json') {
    const body = JSON.stringify({ kind, title, classification, banner: modeBanner(meta), pages: rendered.pages, index: rendered.index, input: { ...input, meta } });
    return done({ kind, format: 'json', contentType: 'application/json', body, classification, pages: rendered.pages, filename: `${FILE[kind]}.json`, facts: { index: rendered.index } });
  }
  return done({ kind, format: 'html', contentType: 'text/html; charset=utf-8', body: rendered.html, classification, pages: rendered.pages, filename: `${FILE[kind]}.html`, facts: { index: rendered.index } });
}

// ── From the server's own records ──────────────────────────────────────────

const FREE_TEXT_TYPES = new Set(['note.logged', 'observation.recorded']);

/** ICS 214 lines from the event log: every notable activity by (or for) a position or unit, oldest first. */
export function activityFromEvents(events: StoredEvent[], opts: { position?: string; unit?: string; userId?: string; includeFreeText?: boolean }): Ics214Input['entries'] {
  return events
    .filter(({ event }) => {
      if (opts.userId && event.actor.userId !== opts.userId) return false;
      if (opts.position && event.actor.position !== opts.position) return false;
      if (opts.unit) {
        const p = event.payload as { unit?: string };
        return p.unit === opts.unit || (event.actor.position === 'field_unit' && (opts.userId ? event.actor.userId === opts.userId : true));
      }
      return true;
    })
    .map(({ event }) => {
      let activity = summarize(event.type, event.payload);
      if (FREE_TEXT_TYPES.has(event.type) && !opts.includeFreeText) activity = event.type === 'note.logged' ? 'Note logged (free text left out of this export; include it on request).' : 'Evaluator observation recorded (text left out of this export).';
      if (event.type === 'decision.recorded' && opts.includeFreeText) {
        const rationale = (event.payload as { rationale?: string }).rationale;
        if (rationale) activity += ` Rationale: ${rationale}`;
      }
      return { at: event.serverTime, activity: `${activity}${opts.position ? '' : ` (${event.actor.position.replace(/_/g, ' ')})`}` };
    });
}

/** The simulation annex from a stored comparison. */
export function annexFromComparison(record: ComparisonRecord, planNames: Record<string, string>, assumptions: string[]): SimulationAnnex {
  return {
    comparisonId: record.id,
    scorecards: record.scorecards,
    planNames,
    assumptions,
    seed: record.seed,
    ...(record.seeds ? { seeds: record.seeds } : {}),
    tapeHash: record.tapeHash,
    engineVersion: record.engineVersion,
    contractVersion: record.contractVersion,
    mapId: record.mapId,
    planVersions: record.planRefs.map((p) => ({ label: p.label, documentId: p.documentId, version: p.version })),
  };
}

/** An Event Action Plan from a stored plan version: prepared and approved by come from the workflow itself. */
export function eapFromDocument(doc: DocumentVersion, opts: { comparison?: ComparisonRecord | null; mode: 'simulation' | 'exercise'; assumptions: string[]; agency?: string }): EapInput {
  const body = doc.body as PlanDocumentBody;
  if (!body.ics) throw new ProductError(422, `plan ${doc.id} version ${doc.version} has no ICS sections (body.ics) to print`);
  const meta: ProductMeta = {
    agency: opts.agency,
    incidentName: doc.name,
    operationalPeriod: (body.ics as { operationalPeriod?: { from: string; to: string } }).operationalPeriod,
    preparedBy: { name: doc.author.name, position: doc.author.position ?? 'Planning Section', at: doc.created },
    approvedBy: doc.approvedBy ? { name: doc.approvedBy.name, position: doc.approvedBy.position ?? 'Incident Commander', at: doc.approvedBy.at } : null,
    version: `${doc.version} (${doc.status})`,
    classification: doc.classification,
    mode: opts.mode,
  };
  const planNames = body.responsePlan ? { [body.responsePlan.id]: body.responsePlan.name } : {};
  return { meta, sections: body.ics, ...(opts.comparison ? { annex: annexFromComparison(opts.comparison, planNames, opts.assumptions) } : {}) };
}
