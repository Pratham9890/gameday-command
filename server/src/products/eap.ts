import type { MapBundle } from '../../../contracts.ts';
import type { EapInput, ProductMeta } from '../types.ts';
import { esc, fmtDateTime, fmtPeriod, modeBanner } from './html.ts';
import { box, bodyWidth, raw, renderDocument, type RenderedDocument, type SheetSpec, table } from './layout.ts';
import { ics202, ics203, ics204, ics205, ics206, ics208 } from './ics.ts';
import { annexSheets } from './annex.ts';
import { sketchSvg } from './geo.ts';

/**
 * The Event Action Plan for one operational period (PLT-33): a cover with the
 * approval block and contents, the ICS 202 to 208 forms that have content,
 * the map, and the simulation annex last and apart. Page numbers run across
 * the whole bundle and every page carries its marking and banner.
 */
function cover(meta: ProductMeta, index: RenderedDocument['index'], input: EapInput): SheetSpec {
  const approval = meta.approvedBy
    ? `Approved by ${esc(meta.approvedBy.name)}, ${esc(meta.approvedBy.position)}${meta.approvedBy.at ? `, ${esc(fmtDateTime(meta.approvedBy.at))}` : ''}.`
    : '<strong>Not approved.</strong> This version is a draft for review and is not the plan of record.';
  const html = `<section class="cover">
<p class="sub">${esc(meta.agency ?? '')}</p>
<h1>Event Action Plan: ${esc(meta.incidentName)}</h1>
<p class="sub">Operational period ${esc(fmtPeriod(meta.operationalPeriod))}</p>
<p>${approval}</p>
<p>Prepared by ${esc(meta.preparedBy.name)}, ${esc(meta.preparedBy.position)}${meta.preparedBy.at ? `, ${esc(fmtDateTime(meta.preparedBy.at))}` : ''}. Version ${esc(meta.version)}.</p>
<p class="note">${esc(modeBanner(meta))}. The simulation annex at the back shows simulated trade-offs that informed this plan; it is not part of the approved plan.</p>
</section>`;
  return {
    form: 'EAP',
    formTitle: 'Event Action Plan: cover and contents',
    cover: true,
    parts: [
      raw(html, 250),
      table('Contents', [{ label: 'Form', width: 1.2 }, { label: 'Title', width: 4 }, { label: 'Page', width: 0.9, cls: 'num' }], index.map((e) => [esc(e.form), esc(e.formTitle), e.pages > 1 ? `${e.page} to ${e.page + e.pages - 1}` : String(e.page)])),
      ...(input.sections.radio ? [raw('<p class="note">The ICS 205 radio plan is marked restricted. Withhold it, and any other restricted page, by removing those pages: nothing else refers to their contents.</p>', 30)] : []),
    ],
  };
}

export function eapDocument(input: EapInput, map?: MapBundle): RenderedDocument {
  const { meta, sections } = input;
  const specs: SheetSpec[] = [...ics202(meta, sections, { map: Boolean(input.map && map), annex: Boolean(input.annex) })];
  if (sections.organization?.length) specs.push(...ics203(sections.organization));
  if (sections.assignments?.length) specs.push(...ics204(sections.assignments));
  if (sections.radio) specs.push(...ics205(sections.radio));
  if (sections.medical) specs.push(...ics206(sections.medical));
  if (sections.safety) specs.push(...ics208(sections.safety));
  if (input.map && map) {
    const w = bodyWidth('landscape') - 16;
    specs.push({ form: 'Map', formTitle: `Operations map: ${map.name}`, orientation: 'landscape', parts: [box('Closures, posts, zones and markers (planned or simulated as labelled; not to survey accuracy)', sketchSvg(input.map, map, w, 420), 420)] });
  }
  if (input.annex) specs.push(...annexSheets(input.annex));
  return renderDocument(`Event Action Plan: ${meta.incidentName}`, meta, specs, { coverIndex: (index) => cover(meta, index, input) });
}
