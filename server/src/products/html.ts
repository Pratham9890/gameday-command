import type { Classification, ProductMeta, Provenance } from '../types.ts';

/** Escaping and the formats every product shares: 24-hour local time, US units, plain NIMS words. */
export const esc = (value: unknown): string =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

export const TIME_ZONE = 'America/New_York';

const dateTime = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' });
const timeOnly = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' });

/** "2026-10-31 15:30 EDT": a date nobody misreads, a 24-hour clock, and the zone. */
export function fmtDateTime(isoOrMs: string | number | null | undefined): string {
  if (isoOrMs === null || isoOrMs === undefined || isoOrMs === '') return '';
  const d = new Date(isoOrMs);
  if (Number.isNaN(d.getTime())) return String(isoOrMs);
  const parts = Object.fromEntries(dateTime.formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${parts.timeZoneName}`;
}

export function fmtTime(isoOrMs: string | number | null | undefined): string {
  if (isoOrMs === null || isoOrMs === undefined || isoOrMs === '') return '';
  const d = new Date(isoOrMs);
  if (Number.isNaN(d.getTime())) return String(isoOrMs);
  const parts = Object.fromEntries(timeOnly.formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.hour}:${parts.minute} ${parts.timeZoneName}`;
}

export const fmtPeriod = (p?: { from: string; to: string }) => (p ? `${fmtDateTime(p.from)} to ${fmtDateTime(p.to)}` : 'Not stated');

export function fmtNum(value: number | null | undefined, places = 0, unknown = 'unknown'): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return unknown;
  return value.toLocaleString('en-US', { minimumFractionDigits: places, maximumFractionDigits: places });
}

/** The marking printed top and bottom of every page (research 06 §2.5). */
export function classificationText(meta: Pick<ProductMeta, 'classification' | 'classificationText'>): string {
  if (meta.classificationText) return meta.classificationText.toUpperCase();
  return { public: 'PUBLIC', internal: 'INTERNAL — FOR AGENCY USE', restricted: 'RESTRICTED — NEED TO KNOW' }[meta.classification];
}

export const CLASS_RANK: Record<Classification, number> = { public: 0, internal: 1, restricted: 2 };
export const atLeast = (c: Classification, floor: Classification): Classification => (CLASS_RANK[c] >= CLASS_RANK[floor] ? c : floor);

export function modeBanner(meta: ProductMeta): string {
  if (meta.mode === 'exercise') return `EXERCISE${meta.exerciseName ? ` — ${meta.exerciseName.toUpperCase()}` : ''} — EXERCISE`;
  return 'SIMULATION-SUPPORTED PRODUCT — SIMULATED VALUES ARE NOT OBSERVATIONS';
}

/** PLT-50: what this is not, on every page. */
export const SCOPE_LINE = 'Gameday Command is decision support. It is not CAD, dispatch, radio, alerting, a records system or surveillance, and not evidence. Fan behaviour in the simulation is an assumption, not a forecast. The commander decides.';

export function provenanceLabel(p: Provenance | { kind: string; source?: string; asOf?: string | null }): string {
  const when = p.asOf ? `, ${fmtDateTime(p.asOf)}` : '';
  switch (p.kind) {
    case 'simulated':
      return `Simulated: model assumption${p.source ? ` (${p.source})` : ''}`;
    case 'observed':
      return `Observed: ${p.source ?? 'feed'}${when}`;
    case 'forecast':
      return `Forecast: ${p.source ?? 'feed'}${when}`;
    case 'estimated':
      return `Estimated: ${p.source ?? ''}${when}`;
    case 'assumed':
      return `Assumed: ${p.source ?? ''}`;
    case 'default':
      return `Default value${p.source ? `: ${p.source}` : ''}`;
    default:
      return p.source ?? p.kind;
  }
}

export const yesNo = (value: boolean | undefined | null) => (value === true ? 'Yes' : value === false ? 'No' : 'Not stated');
