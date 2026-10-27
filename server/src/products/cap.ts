import { randomUUID } from 'node:crypto';
import type { CapAlertInput, CapCheck, CapInfoInput } from '../types.ts';
import { freeTextWarnings } from '../platform/freetext.ts';
import { esc, fmtDateTime, TIME_ZONE } from './html.ts';
import { fields, raw, type SheetSpec, table, textBox } from './layout.ts';

/**
 * CAP 1.2 drafts (OASIS CAP-v1.2-os) for hand-off to the agency's authorised
 * alert originator (PLT-31). Status is Exercise or Draft only; nothing in this
 * server can send an alert. The IPAWS profile's WEA texts ride as CMAMtext
 * (90 characters) and CMAMlongtext (360 characters) parameters and are
 * checked against those limits. The XML is written in schema element order.
 */
export const CAP_NS = 'urn:oasis:names:tc:emergency:cap:1.2';
const STATUSES = ['Exercise', 'Draft'] as const;
const MSG_TYPES = ['Alert', 'Update', 'Cancel'] as const;
const SCOPES = ['Public', 'Restricted', 'Private'] as const;
const CATEGORIES = ['Geo', 'Met', 'Safety', 'Security', 'Rescue', 'Fire', 'Health', 'Env', 'Transport', 'Infra', 'CBRNE', 'Other'] as const;
const RESPONSES = ['Shelter', 'Evacuate', 'Prepare', 'Execute', 'Avoid', 'Monitor', 'Assess', 'AllClear', 'None'] as const;
const URGENCY = ['Immediate', 'Expected', 'Future', 'Past', 'Unknown'] as const;
const SEVERITY = ['Extreme', 'Severe', 'Moderate', 'Minor', 'Unknown'] as const;
const CERTAINTY = ['Observed', 'Likely', 'Possible', 'Unlikely', 'Unknown'] as const;
export const WEA_SHORT = 90;
export const WEA_LONG = 360;
/** CAP dateTime: offset required, and "Z" not allowed (UTC is written -00:00). */
export const CAP_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;
/** GSM 7-bit default alphabet (basic set), what every handset renders. */
const GSM7 = /^[@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà]*$/;

/** An instant written the CAP way, in local time with its offset: 2026-10-31T15:30:00-04:00. */
export function capTime(isoOrMs: string | number): string {
  const d = new Date(isoOrMs);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset' })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  const offset = String(parts.timeZoneName).replace('GMT', '') || '+00:00';
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset === '+00:00' ? '-00:00' : offset}`;
}

const restricted = /[\s,<&]/;

export function checkCap(input: CapAlertInput): CapCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!(STATUSES as readonly string[]).includes(input.status)) errors.push(`status must be Exercise or Draft (got ${String(input.status)}); this server never prepares an Actual alert`);
  if (input.status === 'Exercise' && !input.exerciseId?.trim()) errors.push('an Exercise alert must name its exercise (exerciseId), which goes in <note>');
  if (!(MSG_TYPES as readonly string[]).includes(input.msgType)) errors.push('msgType must be Alert, Update or Cancel');
  if (input.msgType !== 'Alert' && !input.references?.trim()) errors.push(`${input.msgType} needs <references> to the message it updates or cancels`);
  if (!(SCOPES as readonly string[]).includes(input.scope)) errors.push('scope must be Public, Restricted or Private');
  if (input.scope === 'Restricted' && !input.restriction?.trim()) errors.push('Restricted scope needs <restriction>');
  if (input.scope === 'Private' && !input.addresses?.trim()) errors.push('Private scope needs <addresses>');
  if (input.identifier !== undefined && (restricted.test(input.identifier) || !input.identifier)) errors.push('identifier may not contain spaces, commas, < or &');
  if (input.sender !== undefined && restricted.test(input.sender)) errors.push('sender may not contain spaces, commas, < or &');
  if (input.sent !== undefined && !CAP_DATETIME.test(input.sent)) errors.push('sent must be a CAP dateTime with an offset, e.g. 2026-10-31T15:30:00-04:00');
  if (!input.info?.length) errors.push('at least one <info> block is needed');
  let short: CapCheck['wea']['short'] = null;
  let long: CapCheck['wea']['long'] = null;
  (input.info ?? []).forEach((info, i) => {
    const at = `info[${i}]`;
    if (!info.category?.length || info.category.some((c) => !(CATEGORIES as readonly string[]).includes(c))) errors.push(`${at}.category: one or more of ${CATEGORIES.join(', ')}`);
    if (!info.event?.trim()) errors.push(`${at}.event is required`);
    if (info.responseType?.some((r) => !(RESPONSES as readonly string[]).includes(r))) errors.push(`${at}.responseType: ${RESPONSES.join(', ')}`);
    if (!(URGENCY as readonly string[]).includes(info.urgency)) errors.push(`${at}.urgency: ${URGENCY.join(', ')}`);
    if (!(SEVERITY as readonly string[]).includes(info.severity)) errors.push(`${at}.severity: ${SEVERITY.join(', ')}`);
    if (!(CERTAINTY as readonly string[]).includes(info.certainty)) errors.push(`${at}.certainty: ${CERTAINTY.join(', ')}`);
    for (const key of ['effective', 'onset', 'expires'] as const) {
      const value = info[key];
      if (value !== undefined && Number.isNaN(Date.parse(value))) errors.push(`${at}.${key} is not a date-time`);
    }
    if (info.onset && info.expires && Date.parse(info.expires) <= Date.parse(info.onset)) errors.push(`${at}.expires must be after onset`);
    if (!info.area?.length) errors.push(`${at}.area: at least one area`);
    info.area?.forEach((area, j) => {
      if (!area.areaDesc?.trim()) errors.push(`${at}.area[${j}].areaDesc is required`);
      if (area.polygon) {
        if (area.polygon.length < 3) errors.push(`${at}.area[${j}].polygon needs at least three points`);
        if (area.polygon.some((p) => !(Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180))) errors.push(`${at}.area[${j}].polygon has a point off the Earth`);
      }
      if (area.circle && !(area.circle.radiusKm > 0 && Math.abs(area.circle.lat) <= 90 && Math.abs(area.circle.lon) <= 180)) errors.push(`${at}.area[${j}].circle needs a centre and a radius above 0 km`);
    });
    if (info.wea) {
      const s = info.wea.short ?? '';
      short = { length: [...s].length, limit: WEA_SHORT, ok: [...s].length > 0 && [...s].length <= WEA_SHORT };
      if (!short.ok) errors.push(`${at}.wea.short is ${short.length} characters; WEA allows ${WEA_SHORT}`);
      if (!GSM7.test(s)) warnings.push(`${at}.wea.short has characters outside the GSM 7-bit set (curly quotes, dashes, emoji); some handsets will show them wrongly`);
      if (info.wea.long !== undefined) {
        const l = info.wea.long;
        long = { length: [...l].length, limit: WEA_LONG, ok: [...l].length <= WEA_LONG };
        if (!long.ok) errors.push(`${at}.wea.long is ${long.length} characters; WEA allows ${WEA_LONG}`);
        if (!GSM7.test(l)) warnings.push(`${at}.wea.long has characters outside the GSM 7-bit set`);
      }
    } else warnings.push(`${at}: no WEA text; the originator writes the 90- and 360-character messages`);
    for (const [field, text] of [['headline', info.headline], ['description', info.description], ['instruction', info.instruction], ['wea.short', info.wea?.short], ['wea.long', info.wea?.long]] as const) {
      if (text) for (const w of freeTextWarnings(text, `${at}.${field}`)) warnings.push(w.message);
    }
  });
  return { ok: errors.length === 0, errors, warnings, wea: { short, long } };
}

const x = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch]!);
const el = (name: string, value: unknown, indent: string) => (value === undefined || value === null || value === '' ? '' : `${indent}<${name}>${x(value)}</${name}>\n`);

export interface CapDraft {
  xml: string;
  check: CapCheck;
  identifier: string;
  sent: string;
}

/** Build the draft. Refuses (throws) if the structure check fails: a malformed alert is never handed on. */
export function buildCap(input: CapAlertInput, ctx: { sender: string; now: number }): CapDraft {
  const check = checkCap(input);
  if (!check.ok) throw new CapInvalid(check);
  const identifier = input.identifier ?? `gameday-${randomUUID()}`;
  const sent = input.sent ?? capTime(ctx.now);
  const exerciseNote = input.status === 'Exercise' ? `Exercise ${input.exerciseId}. ` : '';
  const note = `${exerciseNote}NOT SENT: draft prepared by Gameday Command for review by an authorised alert originator.${input.note ? ` ${input.note}` : ''}`;
  const info = input.info.map((i) => infoXml(i)).join('');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<alert xmlns="${CAP_NS}">
${el('identifier', identifier, '  ')}${el('sender', input.sender ?? ctx.sender, '  ')}${el('sent', sent, '  ')}${el('status', input.status, '  ')}${el('msgType', input.msgType, '  ')}${el('source', 'Gameday Command (draft, not sent)', '  ')}${el('scope', input.scope, '  ')}${el('restriction', input.restriction, '  ')}${el('addresses', input.addresses, '  ')}${el('code', 'IPAWSv1.0', '  ')}${el('note', note, '  ')}${el('references', input.references, '  ')}${el('incidents', input.incidents, '  ')}${info}</alert>
`;
  return { xml, check, identifier, sent };
}

function infoXml(i: CapInfoInput): string {
  const t = (v: string | undefined) => (v ? capTime(v) : undefined);
  const parameters = [
    ...(i.wea ? [{ valueName: 'CMAMtext', value: i.wea.short }, ...(i.wea.long ? [{ valueName: 'CMAMlongtext', value: i.wea.long }] : [])] : []),
    ...(i.parameters ?? []),
  ];
  const areas = i.area
    .map((a) => {
      const ring = a.polygon ? [...a.polygon, ...(a.polygon[0] && (a.polygon[0].lat !== a.polygon.at(-1)!.lat || a.polygon[0].lon !== a.polygon.at(-1)!.lon) ? [a.polygon[0]] : [])] : null;
      return `    <area>\n${el('areaDesc', a.areaDesc, '      ')}${ring ? el('polygon', ring.map((p) => `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`).join(' '), '      ') : ''}${a.circle ? el('circle', `${a.circle.lat.toFixed(6)},${a.circle.lon.toFixed(6)} ${a.circle.radiusKm}`, '      ') : ''}${(a.geocodes ?? []).map((g) => `      <geocode>\n${el('valueName', g.valueName, '        ')}${el('value', g.value, '        ')}      </geocode>\n`).join('')}    </area>\n`;
    })
    .join('');
  return `  <info>
${el('language', i.language ?? 'en-US', '    ')}${i.category.map((c) => el('category', c, '    ')).join('')}${el('event', i.event, '    ')}${(i.responseType ?? []).map((r) => el('responseType', r, '    ')).join('')}${el('urgency', i.urgency, '    ')}${el('severity', i.severity, '    ')}${el('certainty', i.certainty, '    ')}${el('audience', i.audience, '    ')}${el('effective', t(i.effective), '    ')}${el('onset', t(i.onset), '    ')}${el('expires', t(i.expires), '    ')}${el('senderName', i.senderName, '    ')}${el('headline', i.headline, '    ')}${el('description', i.description, '    ')}${el('instruction', i.instruction, '    ')}${el('web', i.web, '    ')}${el('contact', i.contact, '    ')}${parameters.map((p) => `    <parameter>\n${el('valueName', p.valueName, '      ')}${el('value', p.value, '      ')}    </parameter>\n`).join('')}${areas}  </info>
`;
}

export class CapInvalid extends Error {
  readonly check: CapCheck;
  constructor(check: CapCheck) {
    super(`CAP draft refused: ${check.errors.join('; ')}`);
    this.check = check;
  }
}

/** A review sheet for the draft: what it says, the WEA checks, and that it was not sent. */
export function capSheets(input: CapAlertInput, draft: CapDraft): SheetSpec[] {
  const info = input.info[0]!;
  const wea = draft.check.wea;
  return [
    {
      form: 'CAP 1.2 draft',
      formTitle: `Public alert draft (${input.status}), not sent`,
      parts: [
        raw(`<section class="box notice"><h3 class="label">Not sent</h3><p>This is a CAP 1.2 ${esc(input.status)} message for an authorised alert originator to review in the agency’s own alerting software. Gameday Command cannot send alerts.</p></section>`, 58),
        fields([
          { label: 'Identifier', value: draft.identifier, span: 2 },
          { label: 'Sent (prepared)', value: fmtDateTime(Date.parse(draft.sent)) },
          { label: 'Status / type / scope', value: `${input.status} / ${input.msgType} / ${input.scope}` },
        ]),
        fields([
          { label: 'Event', value: info.event },
          { label: 'Urgency, severity, certainty', value: `${info.urgency}, ${info.severity}, ${info.certainty}` },
          { label: 'Response', value: (info.responseType ?? []).join(', ') || 'Not stated' },
          { label: 'Expires', value: info.expires ? fmtDateTime(info.expires) : 'Not stated' },
        ]),
        textBox('Headline', info.headline),
        textBox('Description', info.description),
        textBox('Instruction', info.instruction),
        table(
          'Wireless Emergency Alert text (IPAWS profile)',
          [{ label: 'Message', width: 1.2 }, { label: 'Text', width: 5 }, { label: 'Length', width: 1.2, cls: 'num' }],
          [
            ['90-character', esc(info.wea?.short ?? 'not written'), wea.short ? `${wea.short.length} of ${WEA_SHORT}${wea.short.ok ? '' : ' (too long)'}` : ''],
            ['360-character', esc(info.wea?.long ?? 'not written'), wea.long ? `${wea.long.length} of ${WEA_LONG}${wea.long.ok ? '' : ' (too long)'}` : ''],
          ],
        ),
        table('Areas', [{ label: 'Area', width: 2.5 }, { label: 'Shape', width: 4 }], info.area.map((a) => [esc(a.areaDesc), esc(a.circle ? `circle ${a.circle.radiusKm} km around ${a.circle.lat.toFixed(4)}, ${a.circle.lon.toFixed(4)}` : a.polygon ? `polygon of ${a.polygon.length} points` : (a.geocodes ?? []).map((g) => `${g.valueName} ${g.value}`).join(', ') || 'description only')])),
        table('Checks', [{ label: 'Result', width: 1 }, { label: 'Detail', width: 6 }], [...draft.check.errors.map((e) => ['Error', esc(e)]), ...draft.check.warnings.map((w) => ['Warning', esc(w)]), ...(draft.check.errors.length + draft.check.warnings.length === 0 ? [['Passed', 'CAP 1.2 structure and WEA lengths']] : [])]),
      ],
    },
  ];
}
