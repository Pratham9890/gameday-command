import type { Classification, ProductMeta } from '../types.ts';
import { atLeast, classificationText, esc, fmtDateTime, fmtPeriod, modeBanner, SCOPE_LINE } from './html.ts';

/**
 * The page frame every product prints on: US Letter, one form per sheet in
 * the FEMA layout (numbered boxes, ruled cells), the classification marking
 * at top and bottom, the EXERCISE or SIMULATION banner, and a footer with
 * prepared by, approved by, version and page X of Y.
 *
 * Pages are laid out here, not left to the browser: every block has an
 * estimated height, long tables split by row with their header repeated, and
 * so "page X of Y" is right in any browser's print-to-PDF and in headless
 * Chromium alike. Estimates are deliberately generous (Noto Sans metrics,
 * wider than Arial); the screenshot script checks that no sheet overflows.
 */

// ── Geometry (CSS px at 96 per inch) ───────────────────────────────────────
const SHEET = { portrait: { w: 816, h: 1056 }, landscape: { w: 1056, h: 816 } } as const;
const PAD = 38;
const CHROME = 20 + 18 + 64 + 66 + 20 + 5 * 4;
export type Orientation = keyof typeof SHEET;
export const bodyHeight = (o: Orientation) => SHEET[o].h - 2 * PAD - CHROME;
export const bodyWidth = (o: Orientation) => SHEET[o].w - 2 * PAD;
/** Fill to this share of the body: estimates are estimates. */
const FILL = 0.94;

const CHAR_EM = 0.56;
const TEXT_PX = 12;
const TEXT_LINE = 16.2;
const CELL_PX = 11.33;
const CELL_LINE = 14.7;
const PART_GAP = 6;

export function linesFor(text: string, widthPx: number, fontPx = TEXT_PX): number {
  const perLine = Math.max(8, Math.floor(widthPx / (fontPx * CHAR_EM)));
  return String(text)
    .split('\n')
    .reduce((n, para) => n + Math.max(1, Math.ceil(para.length / perLine)), 0);
}

export const textHeight = (text: string, widthPx: number) => linesFor(text, widthPx) * TEXT_LINE;

// ── Parts ─────────────────────────────────────────────────────────────────

export interface Part {
  html: string;
  height: number;
  /** A table that may continue on the next sheet. */
  table?: { open: string; head: string; rows: { html: string; height: number }[]; close: string; headHeight: number; caption: string };
}

/** A numbered form box: "3. Objective(s):" over its content. */
export function box(label: string, content: string, contentHeight: number, opts: { cls?: string } = {}): Part {
  return {
    html: `<section class="box${opts.cls ? ` ${opts.cls}` : ''}"><h3 class="label">${esc(label)}</h3><div class="content">${content}</div></section>`,
    height: contentHeight + 13 + 12 + PART_GAP,
  };
}

export function textBox(label: string, text: string | undefined | null, orientation: Orientation = 'portrait', empty = 'None entered.'): Part {
  const value = text?.trim() ? text : empty;
  const html = value
    .split(/\n{2,}/)
    .map((para) => `<p>${esc(para).replace(/\n/g, '<br>')}</p>`)
    .join('');
  return box(label, html, textHeight(value, bodyWidth(orientation) - 16) + (value.split(/\n{2,}/).length - 1) * 6);
}

export function listBox(label: string, items: string[], orientation: Orientation = 'portrait', opts: { numbered?: boolean; empty?: string } = {}): Part {
  if (!items.length) return textBox(label, null, orientation, opts.empty ?? 'None entered.');
  const tag = opts.numbered === false ? 'ul' : 'ol';
  const html = `<${tag}>${items.map((item) => `<li>${esc(item)}</li>`).join('')}</${tag}>`;
  const width = bodyWidth(orientation) - 40;
  return box(label, html, items.reduce((h, item) => h + textHeight(item, width) + 2, 0));
}

/** A row of label/value cells (the FEMA header rows). */
export function fields(cells: { label: string; value: string; span?: number }[], orientation: Orientation = 'portrait'): Part {
  const total = cells.reduce((n, c) => n + (c.span ?? 1), 0);
  const width = bodyWidth(orientation);
  const height = Math.max(...cells.map((c) => linesFor(c.value || ' ', (width * (c.span ?? 1)) / total - 12) * TEXT_LINE)) + 13 + 10;
  const html = `<div class="fields" style="grid-template-columns:${cells.map((c) => `${c.span ?? 1}fr`).join(' ')}">${cells
    .map((c) => `<div class="field"><span class="label">${esc(c.label)}</span><span class="value">${c.value ? esc(c.value) : '&nbsp;'}</span></div>`)
    .join('')}</div>`;
  return { html, height: height + PART_GAP };
}

export interface Column {
  label: string;
  /** Share of the table width, any unit; normalised. */
  width: number;
  cls?: string;
}

/** A ruled table that splits by row across sheets, header repeated. */
export function table(label: string | null, columns: Column[], rows: string[][], orientation: Orientation = 'portrait', opts: { empty?: string; cls?: string } = {}): Part {
  const total = columns.reduce((n, c) => n + c.width, 0);
  const width = bodyWidth(orientation) - (label ? 0 : 0);
  const colWidths = columns.map((c) => (width * c.width) / total);
  const colgroup = `<colgroup>${columns.map((c) => `<col style="width:${((100 * c.width) / total).toFixed(2)}%">`).join('')}</colgroup>`;
  const headHeight = Math.max(...columns.map((c, i) => linesFor(c.label, colWidths[i]! - 10, 10) * 12.5)) + 8;
  const head = `<thead><tr>${columns.map((c) => `<th scope="col"${c.cls ? ` class="${c.cls}"` : ''}>${esc(c.label)}</th>`).join('')}</tr></thead>`;
  const body = rows.length
    ? rows.map((row) => ({
        html: `<tr>${row.map((cell, i) => `<td${columns[i]?.cls ? ` class="${columns[i]!.cls}"` : ''}>${cell}</td>`).join('')}</tr>`,
        height: Math.max(...row.map((cell, i) => linesFor(stripTags(cell), colWidths[i]! - 10, CELL_PX) * CELL_LINE)) + 7,
      }))
    : [{ html: `<tr><td colspan="${columns.length}" class="empty">${esc(opts.empty ?? 'None entered.')}</td></tr>`, height: CELL_LINE + 7 }];
  const caption = label ?? '';
  const open = `<section class="box tablebox${opts.cls ? ` ${opts.cls}` : ''}">${label ? `<h3 class="label">${esc(label)}</h3>` : ''}<table>${colgroup}`;
  const close = '</table></section>';
  const labelHeight = label ? 13 + 8 : 0;
  return {
    html: `${open}${head}<tbody>${body.map((r) => r.html).join('')}</tbody>${close}`,
    height: labelHeight + headHeight + body.reduce((h, r) => h + r.height, 0) + 6 + PART_GAP,
    table: { open, head, rows: body, close, headHeight: labelHeight + headHeight + 6 + PART_GAP, caption },
  };
}

/** Raw HTML of a known height (sketches, notes). */
export const raw = (html: string, height: number): Part => ({ html, height: height + PART_GAP });

const stripTags = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&[a-z#0-9]+;/gi, 'x');

// ── Sheets and the document ───────────────────────────────────────────────

export interface SheetSpec {
  form: string;
  formTitle: string;
  parts: Part[];
  orientation?: Orientation;
  /** Raise the marking for this form (the radio plan is restricted by default). */
  classification?: Classification;
  /** Who signs this form, when it is not the product's preparer (FEMA names the position). */
  preparedRole?: string;
  approvedRole?: string;
  /** Appears under the footer, beside the scope statement. */
  note?: string;
  /** A cover page: no form header boxes. */
  cover?: boolean;
}

interface Page {
  spec: SheetSpec;
  parts: string[];
  continued: boolean;
}

function paginate(spec: SheetSpec): Page[] {
  const orientation = spec.orientation ?? 'portrait';
  const capacity = bodyHeight(orientation) * FILL;
  const pages: Page[] = [];
  let current: Page = { spec, parts: [], continued: false };
  let used = 0;
  const flush = () => {
    pages.push(current);
    current = { spec, parts: [], continued: true };
    used = 0;
  };
  for (const part of spec.parts) {
    if (used + part.height <= capacity || (used === 0 && !part.table)) {
      current.parts.push(part.html);
      used += part.height;
      continue;
    }
    if (!part.table) {
      flush();
      current.parts.push(part.html);
      used += part.height;
      continue;
    }
    // Split the table by rows, repeating its head on each sheet.
    const t = part.table;
    let rows: string[] = [];
    let first = true;
    const emit = () => {
      const label = first ? '' : ' (continued)';
      const open = first ? t.open : t.open.replace(/(<h3 class="label">)(.*?)(<\/h3>)/, `$1$2${label}$3`);
      current.parts.push(`${open}${t.head}<tbody>${rows.join('')}</tbody>${t.close}`);
      rows = [];
      first = false;
    };
    if (used + t.headHeight + (t.rows[0]?.height ?? 0) > capacity) flush();
    used += t.headHeight;
    for (const row of t.rows) {
      if (used + row.height > capacity && rows.length) {
        emit();
        flush();
        used += t.headHeight;
      }
      rows.push(row.html);
      used += row.height;
    }
    if (rows.length) emit();
  }
  if (current.parts.length || !pages.length) pages.push(current);
  return pages;
}

export interface RenderedDocument {
  html: string;
  pages: number;
  /** Which page each form starts on, for a table of contents. */
  index: { form: string; formTitle: string; page: number; pages: number }[];
}

export function renderDocument(title: string, meta: ProductMeta, specs: SheetSpec[], opts: { coverIndex?: (index: RenderedDocument['index']) => SheetSpec } = {}): RenderedDocument {
  let pages = specs.flatMap(paginate);
  let index = indexOf(pages);
  if (opts.coverIndex) {
    // A contents page lists where each form starts, so lay the rest out first and put it in front.
    const cover = opts.coverIndex(index.map((e) => ({ ...e, page: e.page + 1 })));
    const coverPages = paginate(cover);
    if (coverPages.length > 1) {
      const again = opts.coverIndex(index.map((e) => ({ ...e, page: e.page + coverPages.length })));
      pages = [...paginate(again), ...pages];
    } else pages = [...coverPages, ...pages];
    index = indexOf(pages);
  }
  const total = pages.length;
  const generated = meta.generatedAt ?? new Date().toISOString();
  const sheets = pages.map((page, i) => sheetHtml(page, meta, i + 1, total, generated)).join('\n');
  return {
    html: `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Gameday Command products 1">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main class="document" aria-label="${esc(title)}">
${sheets}
</main>
</body>
</html>`,
    pages: total,
    index,
  };
}

function indexOf(pages: Page[]): RenderedDocument['index'] {
  const index: RenderedDocument['index'] = [];
  pages.forEach((page, i) => {
    const last = index.at(-1);
    if (last && last.form === page.spec.form && page.continued) last.pages++;
    else index.push({ form: page.spec.form, formTitle: page.spec.formTitle, page: i + 1, pages: 1 });
  });
  return index;
}

function sheetHtml(page: Page, meta: ProductMeta, n: number, total: number, generated: string): string {
  const spec = page.spec;
  const orientation = spec.orientation ?? 'portrait';
  const marking = classificationText({ ...meta, classification: atLeast(meta.classification, spec.classification ?? 'public') });
  const approved = meta.approvedBy
    ? `${esc(meta.approvedBy.name)}, ${esc(meta.approvedBy.position)}${meta.approvedBy.at ? `, ${esc(fmtDateTime(meta.approvedBy.at))}` : ''}`
    : '<strong>Not approved</strong>: draft for review';
  const banner = `${meta.demo ? 'DEMO — SYNTHETIC DATA — ' : ''}${modeBanner(meta)}`;
  const head = `<header class="formhead">
  <div class="formid"><span class="formno">${esc(spec.form)}</span><span class="formname">${esc(spec.formTitle)}${page.continued ? ' (continued)' : ''}</span></div>
  <div class="field"><span class="label">1. Incident name</span><span class="value">${esc(meta.incidentName)}${meta.incidentNumber ? `, ${esc(meta.incidentNumber)}` : ''}</span></div>
  <div class="field"><span class="label">2. Operational period</span><span class="value">${esc(fmtPeriod(meta.operationalPeriod))}</span></div>
</header>`;
  return `<article class="sheet ${orientation}${meta.mode === 'exercise' ? ' exercise' : ''}" aria-label="Page ${n} of ${total}">
<div class="marking">${esc(marking)}</div>
<div class="mode">${esc(banner)}</div>
${head}
<div class="body">
${page.parts.join('\n')}
</div>
<footer class="foot">
  <div class="field"><span class="label">Prepared by${spec.preparedRole ? ` (${esc(spec.preparedRole)})` : ''}</span><span class="value">${esc(meta.preparedBy.name)}, ${esc(meta.preparedBy.position)}${meta.preparedBy.at ? `, ${esc(fmtDateTime(meta.preparedBy.at))}` : ''}</span></div>
  <div class="field"><span class="label">Approved by${spec.approvedRole ? ` (${esc(spec.approvedRole)})` : ''}</span><span class="value">${approved}</span></div>
  <div class="field narrow"><span class="label">Version</span><span class="value">${esc(meta.version)}</span></div>
  <div class="field narrow"><span class="label">Page</span><span class="value page">${n} of ${total}</span></div>
  <p class="scope">${esc(spec.form)}. ${esc(SCOPE_LINE)} Generated ${esc(fmtDateTime(generated))}.${spec.note ? ` ${esc(spec.note)}` : ''}</p>
</footer>
<div class="marking bottom">${esc(marking)}</div>
</article>`;
}

/**
 * One stylesheet for every product: tokens first, greyscale so it reads the
 * same in black-and-white print, the body face FEMA's own forms use.
 */
export const STYLE = `/* Hallmark · shape: app screen · genre: modern-minimal · theme: custom
 * paper: oklch(100% 0 0) · accent: oklch(30% 0.02 250) · display: Arial · body: Arial
 * nav: none, a printed form set · signature: the ruled, numbered ICS form box · states: draft, approved, exercise, restricted, empty
 * axes: light/grotesk/neutral · posture: austere · contrast: pass · v2.0.0 */
/* Hallmark · pre-emit critique: P4 H5 E4 S5 R5 V3 · weakest: V, the forms must look like the FEMA forms commanders already file; variety yields to recognition */
:root {
  --color-paper: oklch(100% 0 0); --color-paper-2: oklch(95.5% 0 0); --color-paper-3: oklch(90% 0 0);
  --color-ink: oklch(20% 0 0); --color-ink-2: oklch(32% 0 0); --color-muted: oklch(42% 0 0);
  --color-rule: oklch(28% 0 0); --color-rule-soft: oklch(70% 0 0);
  --color-accent: oklch(30% 0.02 250); --color-accent-ink: oklch(100% 0 0); --color-focus: oklch(45% 0.12 250);
  --color-desk: oklch(88% 0.005 250);
  --font-body: Arial, "Helvetica Neue", Helvetica, "Liberation Sans", "Noto Sans", sans-serif;
  --font-mono: ui-monospace, "Cascadia Mono", Consolas, "Liberation Mono", monospace;
  --shadow-sheet: 0 1px 3px oklch(20% 0 0 / 0.25);
  --text-cell: 8.5pt; --text-body: 9pt; --text-label: 7.5pt; --text-form: 13pt; --text-cover: 20pt;
  --rule: 1px; --rule-heavy: 2px;
}
*, *::before, *::after { box-sizing: border-box; }
html, body { overflow-x: clip; }
@page { size: letter; margin: 0; }
@page landscape { size: letter landscape; margin: 0; }
html { background: var(--color-desk); -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; color: var(--color-ink); font-family: var(--font-body); font-size: var(--text-body); line-height: 1.35; }
:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
h3, p { margin: 0; }
.document { display: grid; justify-content: center; gap: 24px; padding: 24px 0; }
.sheet { background: var(--color-paper); width: 8.5in; height: 11in; padding: ${PAD}px; display: grid; grid-template-rows: 20px 18px 64px 1fr 66px 20px; gap: 4px; overflow: hidden; break-after: page; page-break-after: always; box-shadow: var(--shadow-sheet); }
.sheet.landscape { width: 11in; height: 8.5in; page: landscape; }
.sheet:last-child { break-after: auto; page-break-after: auto; }
.marking { display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: var(--text-body); border-block: var(--rule-heavy) solid var(--color-rule); }
.mode { display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: var(--text-label); background: var(--color-accent); color: var(--color-accent-ink); }
.exercise .mode { font-size: var(--text-body); }
.formhead { display: grid; grid-template-columns: 1.15fr 1.25fr 1.6fr; border: var(--rule) solid var(--color-rule); }
.formhead > * { padding: 4px 6px; border-inline-start: var(--rule) solid var(--color-rule); }
.formhead > :first-child { border-inline-start: 0; }
.formid { display: grid; align-content: center; }
.formno { font-size: var(--text-form); font-weight: 700; }
.formname { font-size: var(--text-body); font-weight: 700; }
.field { display: grid; align-content: start; gap: 1px; min-width: 0; }
.label { font-size: var(--text-label); font-weight: 700; color: var(--color-ink-2); }
.value { font-size: var(--text-body); overflow-wrap: anywhere; }
.body { display: grid; align-content: start; gap: 6px; min-height: 0; overflow: hidden; }
.box { border: var(--rule) solid var(--color-rule); padding: 4px 6px 6px; break-inside: avoid; }
.box > .label { display: block; margin-block-end: 3px; }
.box p + p { margin-block-start: 6px; }
.box ol, .box ul { margin: 0; padding-inline-start: 20px; }
.box li + li { margin-block-start: 2px; }
.tablebox { padding: 4px 0 0; }
.tablebox > .label { padding-inline: 6px; }
.fields { display: grid; border: var(--rule) solid var(--color-rule); }
.fields > .field { padding: 4px 6px; border-inline-start: var(--rule) solid var(--color-rule); }
.fields > .field:first-child { border-inline-start: 0; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: var(--text-cell); line-height: 1.3; }
th { text-align: start; vertical-align: bottom; font-size: var(--text-label); font-weight: 700; color: var(--color-ink-2); background: var(--color-paper-2); padding: 3px 5px; border-block: var(--rule) solid var(--color-rule); border-inline-start: var(--rule) solid var(--color-rule-soft); }
td { vertical-align: top; padding: 3px 5px; border-block-start: var(--rule) solid var(--color-rule-soft); border-inline-start: var(--rule) solid var(--color-rule-soft); overflow-wrap: anywhere; }
th:first-child, td:first-child { border-inline-start: 0; }
td.num, th.num { text-align: end; font-variant-numeric: tabular-nums; }
td.mark, th.mark { text-align: center; }
td.code, .code { font-family: var(--font-mono); font-size: 7.5pt; overflow-wrap: anywhere; }
td.empty { color: var(--color-muted); }
.foot { display: grid; grid-template-columns: 1.6fr 1.6fr 0.9fr 0.6fr; grid-template-rows: auto 1fr; border: var(--rule) solid var(--color-rule); }
.foot > .field { padding: 3px 6px; border-inline-start: var(--rule) solid var(--color-rule); border-block-end: var(--rule) solid var(--color-rule); }
.foot > .field:first-child { border-inline-start: 0; }
.foot .page { font-weight: 700; font-variant-numeric: tabular-nums; }
.scope { grid-column: 1 / -1; padding: 3px 6px; font-size: 6.5pt; line-height: 1.25; color: var(--color-muted); }
.note { font-size: var(--text-cell); color: var(--color-ink-2); }
.notice { border: var(--rule-heavy) solid var(--color-rule); padding: 8px 10px; }
.notice > .label { font-size: var(--text-body); color: var(--color-ink); }
.checks { display: grid; grid-template-columns: repeat(4, 1fr); gap: 2px 12px; padding: 2px 0; }
.check { display: flex; gap: 6px; align-items: baseline; }
.tick { display: inline-block; width: 10px; height: 10px; border: var(--rule) solid var(--color-rule); text-align: center; font-size: 7pt; line-height: 9px; flex: none; }
.cover { display: grid; align-content: start; gap: 18px; padding: 24px 8px; }
.cover h1 { margin: 0; font-size: var(--text-cover); line-height: 1.15; overflow-wrap: break-word; min-width: 0; }
.cover .sub { font-size: 11pt; color: var(--color-ink-2); }
.sketch { border: var(--rule) solid var(--color-rule-soft); background: var(--color-paper); }
.sketch .road { stroke: var(--color-rule-soft); }
.sketch .closure { fill: var(--color-paper-3); stroke: var(--color-ink); }
.sketch .zone { fill: none; stroke: var(--color-ink-2); stroke-dasharray: 4 3; }
.sketch .gate { fill: var(--color-paper); stroke: var(--color-ink); }
.sketch .post { fill: var(--color-ink); }
.sketch .marker { fill: var(--color-paper); stroke: var(--color-ink); }
.sketch text { font-family: var(--font-body); font-size: 8px; fill: var(--color-ink); }
.columns2 { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 6px; align-items: start; }
@media screen and (max-width: 60rem) { .document { justify-content: start; overflow-x: auto; } }
@media print { html { background: none; } .document { display: block; padding: 0; } .sheet { box-shadow: none; margin: 0; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; } }
`;
