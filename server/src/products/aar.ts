import type { AarInput } from '../types.ts';
import { esc } from './html.ts';
import { box, fields, listBox, raw, type SheetSpec, table, textHeight, bodyWidth } from './layout.ts';
import { annexSheets } from './annex.ts';

/**
 * An HSEEP After-Action Report / Improvement Plan skeleton (PLT-35), in the
 * order the HSEEP template uses: exercise overview, analysis of core
 * capabilities with the four performance ratings, strengths and areas for
 * improvement per objective, the improvement plan, participants, and the
 * simulation annex where the exercise used the simulation. The exercise data
 * model itself comes later (WS7); this renders from a typed input.
 */
export const RATINGS: Record<AarInput['analysis'][number]['rating'], string> = {
  P: 'Performed without challenges',
  S: 'Performed with some challenges',
  M: 'Performed with major challenges',
  U: 'Unable to be performed',
};

export function aarSheets(input: AarInput): SheetSpec[] {
  const ex = input.exercise;
  const objective = (id: string) => ex.objectives.find((o) => o.id === id)?.text ?? id;
  const overview: [string, string][] = [
    ['Exercise name', ex.name],
    ['Exercise dates', ex.dates],
    ['Scope', ex.scope],
    ['Exercise type', ex.type],
    ['Mission area(s)', ex.missionAreas.join(', ')],
    ['Core capabilities', ex.coreCapabilities.join(', ')],
    ['Objectives', ex.objectives.map((o, i) => `${i + 1}. ${o.text}`).join('\n')],
    ['Threat or hazard', ex.threatOrHazard],
    ['Scenario', ex.scenario],
    ['Sponsor', ex.sponsor ?? ''],
    ['Participating organizations', ex.participatingOrganizations.join(', ')],
    ['Points of contact', ex.pointsOfContact.map((p) => `${p.role}: ${p.name}${p.organization ? ` (${p.organization})` : ''}`).join('\n')],
  ];
  const sheets: SheetSpec[] = [
    {
      form: 'AAR/IP',
      formTitle: 'Exercise overview',
      parts: [
        raw(
          `<section class="box notice"><h3 class="label">Handling</h3><p>This After-Action Report/Improvement Plan follows the HSEEP structure. Handle it as its marking says; it may contain exercise observations about named organizations but holds no personal data about the public.</p></section>`,
          58,
        ),
        table('Exercise overview', [{ label: 'Item', width: 1.6 }, { label: 'Detail', width: 5 }], overview.map(([k, v]) => [esc(k), esc(v || 'Not stated').replace(/\n/g, '<br>')])),
      ],
    },
    {
      form: 'AAR/IP',
      formTitle: 'Analysis of core capabilities',
      parts: [
        table(
          'Performance by objective and core capability',
          [{ label: 'Objective', width: 3 }, { label: 'Core capability', width: 1.8 }, { label: 'P', width: 0.45, cls: 'mark' }, { label: 'S', width: 0.45, cls: 'mark' }, { label: 'M', width: 0.45, cls: 'mark' }, { label: 'U', width: 0.45, cls: 'mark' }],
          input.analysis.map((a) => [esc(objective(a.objectiveId)), esc(a.coreCapability), ...(['P', 'S', 'M', 'U'] as const).map((r) => (a.rating === r ? 'X' : ''))]),
        ),
        fields((['P', 'S', 'M', 'U'] as const).map((r) => ({ label: r, value: RATINGS[r] }))),
        ...input.analysis.flatMap((a, i) => {
          const width = bodyWidth('portrait') - 30;
          const afi = a.areasForImprovement
            .map((x) => `<li><strong>${esc(x.title)}</strong><p>${esc(x.observation)}</p>${x.reference ? `<p class="note">Reference: ${esc(x.reference)}</p>` : ''}${x.analysis ? `<p>Analysis: ${esc(x.analysis)}</p>` : ''}</li>`)
            .join('');
          const afiHeight = a.areasForImprovement.reduce((h, x) => h + textHeight(`${x.title}\n${x.observation}\n${x.reference ?? ''}\n${x.analysis ?? ''}`, width), 0);
          return [
            listBox(`Objective ${i + 1}: ${objective(a.objectiveId)}. Strengths`, a.strengths, 'portrait', { numbered: false, empty: 'None recorded.' }),
            a.areasForImprovement.length ? box(`Objective ${i + 1}. Areas for improvement`, `<ol>${afi}</ol>`, afiHeight) : listBox(`Objective ${i + 1}. Areas for improvement`, [], 'portrait', { empty: 'None recorded.' }),
          ];
        }),
      ],
    },
    {
      form: 'AAR/IP',
      formTitle: 'Appendix A: Improvement plan',
      orientation: 'landscape',
      parts: [
        table(
          'Improvement plan',
          [
            { label: 'Core capability', width: 1.3 },
            { label: 'Issue/area for improvement', width: 2 },
            { label: 'Corrective action', width: 2.4 },
            { label: 'Capability element', width: 1 },
            { label: 'Primary responsible organization', width: 1.4 },
            { label: 'Organization POC', width: 1.2 },
            { label: 'Start date', width: 0.9 },
            { label: 'Completion date', width: 0.9 },
          ],
          input.improvementPlan.map((r) => [r.coreCapability, r.issue, r.correctiveAction, r.capabilityElement, r.primaryResponsibleOrganization, r.organizationPoc, r.startDate, r.completionDate].map((v) => esc(v))),
          'landscape',
          { empty: 'No corrective actions recorded.' },
        ),
      ],
    },
    {
      form: 'AAR/IP',
      formTitle: 'Appendix B: Exercise participants',
      parts: [listBox('Participating organizations', ex.participatingOrganizations, 'portrait', { numbered: false })],
    },
  ];
  if (input.annex) sheets.push(...annexSheets(input.annex));
  return sheets;
}
