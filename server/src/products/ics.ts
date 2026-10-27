import type { MapBundle } from '../../../contracts.ts';
import type { Ics201Input, Ics203Section, Ics204Assignment, Ics205Plan, Ics206Plan, Ics208Plan, Ics214Input, IcsPlanSections, ProductMeta } from '../types.ts';
import { esc, fmtDateTime, yesNo } from './html.ts';
import { box, bodyWidth, fields, listBox, raw, type SheetSpec, table, textBox } from './layout.ts';
import { sketchSvg } from './geo.ts';

/**
 * The ICS forms of an Incident or Event Action Plan, laid out like FEMA's own
 * (box numbers and titles as on the 2010s ICS forms) so a commander's staff
 * recognise them at a glance. Each function returns the sheets for one form;
 * the radio plan is restricted by default and prints only agency entries.
 */

export function ics201(input: Ics201Input, map?: MapBundle): SheetSpec[] {
  const sketch = input.map && map
    ? box('4. Map/sketch (closures, posts, zones and markers; simulated or planned as labelled)', sketchSvg(input.map, map, bodyWidth('portrait') - 16, 300), 300)
    : textBox('4. Map/sketch', null, 'portrait', 'No sketch attached. Attach the agency map, or export the plan’s features (GeoJSON or KML).');
  return [
    {
      form: 'ICS 201',
      formTitle: 'Incident Briefing',
      preparedRole: 'Planning Section Chief or Incident Commander',
      parts: [
        fields([{ label: '3. Date/time initiated', value: fmtDateTime(input.initiatedAt) }, { label: 'Incident number', value: input.meta.incidentNumber ?? '' }, { label: 'Agency', value: input.meta.agency ?? '' }]),
        sketch,
        textBox('5. Situation summary and health and safety briefing', [input.situationSummary, input.healthSafetyBriefing].filter(Boolean).join('\n\n')),
        listBox('7. Current and planned objectives', input.objectives),
        table('8. Current and planned actions, strategies and tactics', [{ label: 'Time', width: 1.3 }, { label: 'Actions', width: 6 }], input.actions.map((a) => [esc(fmtDateTime(a.time)), esc(a.action)])),
        table('9. Current organization', [{ label: 'Position', width: 2 }, { label: 'Name', width: 2 }, { label: 'Agency', width: 2 }], input.organization.map((r) => [esc(r.role), esc(r.name), esc(r.agency ?? '')])),
        table(
          '10. Resource summary',
          [{ label: 'Resource', width: 2 }, { label: 'Resource identifier', width: 1.6 }, { label: 'Date/time ordered', width: 1.4 }, { label: 'ETA', width: 1 }, { label: 'Arrived', width: 0.8, cls: 'mark' }, { label: 'Notes', width: 2.2 }],
          input.resources.map((r) => [esc(r.resource), esc(r.identifier), esc(fmtDateTime(r.orderedAt)), esc(r.eta ? fmtDateTime(r.eta) : ''), r.arrived ? 'Yes' : r.arrived === false ? 'No' : '', esc(r.notes ?? '')]),
        ),
      ],
    },
  ];
}

/** Which IAP components this plan carries: box 6 of the ICS 202 is a checklist of them. */
function components(sections: IcsPlanSections, extras: { map?: boolean; annex?: boolean }) {
  return [
    ['ICS 203', Boolean(sections.organization?.length)],
    ['ICS 204', Boolean(sections.assignments?.length)],
    ['ICS 205', Boolean(sections.radio)],
    ['ICS 205A', false],
    ['ICS 206', Boolean(sections.medical)],
    ['ICS 207', false],
    ['ICS 208', Boolean(sections.safety)],
    ['Map/chart', Boolean(extras.map)],
    ['Weather forecast', Boolean(sections.weatherSummary)],
    ['Simulation annex', Boolean(extras.annex)],
  ] as const;
}

export function ics202(_meta: ProductMeta, sections: IcsPlanSections, extras: { map?: boolean; annex?: boolean } = {}): SheetSpec[] {
  const checks = components(sections, extras)
    .map(([name, on]) => `<span class="check"><span class="tick" aria-hidden="true">${on ? 'X' : ''}</span><span>${esc(name)}${on ? '' : ' (not attached)'}</span></span>`)
    .join('');
  return [
    {
      form: 'ICS 202',
      formTitle: 'Incident Objectives',
      preparedRole: 'Planning Section Chief',
      approvedRole: 'Incident Commander',
      parts: [
        listBox('3. Objective(s)', sections.objectives),
        textBox('4. Operational period command emphasis', sections.commandEmphasis),
        textBox('General situational awareness', sections.situationalAwareness),
        textBox('Weather (from the attached forecast; see its source and time)', sections.weatherSummary, 'portrait', 'No forecast attached.'),
        fields([
          { label: '5. Site safety plan required?', value: yesNo(sections.siteSafetyPlanRequired ?? sections.safety?.siteSafetyPlanRequired) },
          { label: 'Approved site safety plan(s) located at', value: sections.siteSafetyPlanLocation ?? sections.safety?.siteSafetyPlanLocation ?? '', span: 2 },
        ]),
        box('6. Incident Action Plan (the items marked are included in this plan)', `<div class="checks">${checks}</div>`, 3 * 16),
      ],
    },
  ];
}

export function ics203(organization: Ics203Section[]): SheetSpec[] {
  return [
    {
      form: 'ICS 203',
      formTitle: 'Organization Assignment List',
      preparedRole: 'Resources Unit Leader',
      parts: organization.length
        ? organization.map((section, i) => table(`${i + 3}. ${section.title}`, [{ label: 'Position', width: 2.2 }, { label: 'Name', width: 2.2 }, { label: 'Agency', width: 1.8 }], section.rows.map((r) => [esc(r.role), esc(r.name), esc(r.agency ?? '')])))
        : [textBox('3. Organization', null, 'portrait', 'No organization entered.')],
    },
  ];
}

export function ics204(assignments: Ics204Assignment[]): SheetSpec[] {
  if (!assignments.length) return [{ form: 'ICS 204', formTitle: 'Assignment List', preparedRole: 'Resources Unit Leader', approvedRole: 'Planning Section Chief', parts: [textBox('Assignments', null, 'portrait', 'No assignments entered.')] }];
  return assignments.map((a) => ({
    form: 'ICS 204',
    formTitle: `Assignment List${a.division ? `: ${a.division}` : a.group ? `: ${a.group}` : ''}`,
    preparedRole: 'Resources Unit Leader',
    approvedRole: 'Planning Section Chief',
    parts: [
      fields([
        { label: '3. Branch', value: a.branch ?? '' },
        { label: 'Division', value: a.division ?? '' },
        { label: 'Group', value: a.group ?? '' },
        { label: 'Staging area', value: a.stagingArea ?? '' },
      ]),
      table('4. Operations personnel', [{ label: 'Position', width: 2 }, { label: 'Name', width: 2 }, { label: 'Contact number(s)', width: 2 }], a.operationsPersonnel.map((p) => [esc(p.role), esc(p.name), esc(p.contact ?? '')])),
      table(
        '5. Resources assigned',
        [{ label: 'Resource identifier', width: 1.6 }, { label: 'Leader', width: 1.4 }, { label: 'Persons', width: 0.7, cls: 'num' }, { label: 'Contact', width: 1.3 }, { label: 'Reporting location, equipment, remarks', width: 3 }],
        a.resources.map((r) => [esc(r.identifier), esc(r.leader ?? ''), r.persons === undefined ? '' : String(r.persons), esc(r.contact ?? ''), esc([r.reportingLocation, r.equipment, r.remarks].filter(Boolean).join('; '))]),
      ),
      listBox('6. Work assignments', a.workAssignments),
      textBox('7. Special instructions', a.specialInstructions),
      table('8. Communications (radio and phone contacts for this assignment)', [{ label: 'Name/function', width: 2 }, { label: 'Primary contact', width: 3 }], a.communications.map((c) => [esc(c.function), esc(c.contact)])),
    ],
  }));
}

export function ics205(radio: Ics205Plan | null | undefined): SheetSpec[] {
  const parts = radio?.channels.length
    ? [
        table(
          '4. Basic radio channel use',
          [
            { label: 'Zone group', width: 0.8 },
            { label: 'Ch #', width: 0.5 },
            { label: 'Function', width: 1.2 },
            { label: 'Channel name / trunked radio system talkgroup', width: 2 },
            { label: 'Assignment', width: 1.6 },
            { label: 'RX freq N or W', width: 0.9 },
            { label: 'RX tone/NAC', width: 0.8 },
            { label: 'TX freq N or W', width: 0.9 },
            { label: 'TX tone/NAC', width: 0.8 },
            { label: 'Mode (A, D or M)', width: 0.7, cls: 'mark' },
            { label: 'Remarks', width: 1.6 },
          ],
          radio.channels.map((ch) => [ch.zoneGroup, ch.channel, ch.function, ch.channelName, ch.assignment, ch.rxFreq, ch.rxTone, ch.txFreq, ch.txTone, ch.mode, ch.remarks].map((v) => esc(v ?? ''))),
          'landscape',
        ),
        textBox('5. Special instructions', radio.specialInstructions, 'landscape'),
        fields([{ label: 'Source of these entries', value: `Entered by the agency${radio.enteredBy ? ` (${radio.enteredBy})` : ''}. Gameday Command never generates channels, talkgroups or frequencies.` }], 'landscape'),
      ]
    : [
        raw(
          `<section class="box notice"><h3 class="label">No radio plan has been entered</h3><p>The Communications Unit Leader enters channel and talkgroup assignments. Gameday Command never generates or guesses channels, talkgroups, frequencies or tones, so this form stays empty until the agency fills it in.</p></section>`,
          70,
        ),
      ];
  return [{ form: 'ICS 205', formTitle: 'Incident Radio Communications Plan', orientation: 'landscape', classification: 'restricted', preparedRole: 'Communications Unit Leader', parts }];
}

export function ics206(medical: Ics206Plan): SheetSpec[] {
  return [
    {
      form: 'ICS 206',
      formTitle: 'Medical Plan',
      preparedRole: 'Medical Unit Leader',
      approvedRole: 'Safety Officer',
      parts: [
        table('3. Medical aid stations', [{ label: 'Name', width: 2 }, { label: 'Location', width: 2.4 }, { label: 'Contact number(s)/frequency', width: 1.8 }, { label: 'Paramedics on site?', width: 1, cls: 'mark' }], medical.aidStations.map((s) => [esc(s.name), esc(s.location), esc(s.contact ?? ''), yesNo(s.paramedicsOnSite)])),
        table('4. Transportation', [{ label: 'Ambulance service', width: 2.2 }, { label: 'Location', width: 2 }, { label: 'Contact number(s)/frequency', width: 1.8 }, { label: 'Level of service', width: 1, cls: 'mark' }], medical.transportation.map((t) => [esc(t.service), esc(t.location ?? ''), esc(t.contact ?? ''), esc(t.level ?? '')])),
        table(
          '5. Hospitals',
          [{ label: 'Hospital name', width: 2 }, { label: 'Address', width: 2 }, { label: 'Contact number(s)/frequency', width: 1.4 }, { label: 'Travel time (ground / air)', width: 1.1 }, { label: 'Trauma center', width: 0.9 }, { label: 'Burn center', width: 0.7, cls: 'mark' }, { label: 'Helipad', width: 0.7, cls: 'mark' }],
          medical.hospitals.map((h) => [esc(h.name), esc(h.address ?? ''), esc(h.contact ?? ''), esc([h.travelTimeGround, h.travelTimeAir].map((t) => t ?? 'not entered').join(' / ')), esc(h.traumaCenter ?? 'No'), yesNo(h.burnCenter), yesNo(h.helipad)]),
        ),
        textBox(`6. Special medical emergency procedures${medical.aviationAssets ? ' (aviation assets are used for rescue)' : ''}`, medical.specialProcedures),
      ],
    },
  ];
}

export function ics208(safety: Ics208Plan): SheetSpec[] {
  return [
    {
      form: 'ICS 208',
      formTitle: 'Safety Message/Plan',
      preparedRole: 'Safety Officer',
      parts: [
        textBox('3. Safety message, expanded safety message, safety plan, site safety plan', safety.message),
        table('Hazards and mitigations', [{ label: 'Hazard', width: 2 }, { label: 'Mitigation', width: 4 }], (safety.hazards ?? []).map((h) => [esc(h.hazard), esc(h.mitigation)]), 'portrait', { empty: 'No hazards listed.' }),
        fields([
          { label: '4. Site safety plan required?', value: yesNo(safety.siteSafetyPlanRequired) },
          { label: 'Approved site safety plan(s) located at', value: safety.siteSafetyPlanLocation ?? '', span: 2 },
        ]),
      ],
    },
  ];
}

export function ics214(input: Ics214Input): SheetSpec[] {
  return [
    {
      form: 'ICS 214',
      formTitle: 'Activity Log',
      parts: [
        fields([
          { label: '3. Name', value: input.name },
          { label: '4. ICS position', value: input.position },
          { label: '5. Home agency (and unit)', value: input.homeAgency ?? '' },
        ]),
        table('6. Resources assigned', [{ label: 'Name', width: 2 }, { label: 'ICS position', width: 2 }, { label: 'Home agency (and unit)', width: 2 }], (input.resourcesAssigned ?? []).map((r) => [esc(r.name), esc(r.position), esc(r.homeAgency ?? '')]), 'portrait', { empty: 'None listed.' }),
        table('7. Activity log', [{ label: 'Date/time', width: 1.4 }, { label: 'Notable activities', width: 6 }], input.entries.map((e) => [esc(fmtDateTime(e.at)), esc(e.activity)]), 'portrait', { empty: 'No activity recorded in this period.' }),
      ],
    },
  ];
}
