import type { SitrepInput, WeatherReport } from '../types.ts';
import { esc, fmtDateTime, fmtNum, provenanceLabel } from './html.ts';
import { fields, listBox, raw, type SheetSpec, table, textBox } from './layout.ts';

/**
 * A situation report for EOC partners (PER-30): the summary, the key figures
 * each with where it came from and how old it is, the weather from the feed
 * (or "unknown" with the reason), what happened, resources, and what is next.
 */
function weatherRows(weather: WeatherReport | null | undefined): string[][] {
  if (!weather) return [['Weather', 'Not attached', '']];
  if (weather.status === 'not_configured') return [['Weather', 'Unknown: the weather feed is not configured on this server', '']];
  const o = weather.observation;
  const rows: string[][] = [];
  if (o) {
    const t = o.temperatureF.value === null ? `unknown (${o.temperatureF.reason})` : `${fmtNum(o.temperatureF.value, 0)} °F`;
    const wind = o.windSpeedMph.value === null ? 'wind unknown' : o.windFromCompass === 'calm' || o.windSpeedMph.value === 0 ? 'wind calm' : `wind ${o.windFromCompass ?? 'direction unknown'} ${fmtNum(o.windSpeedMph.value, 0)} mph`;
    const gust = o.windGustMph.value === null ? 'gusts not reported' : `gusts ${fmtNum(o.windGustMph.value, 0)} mph`;
    const vis = o.visibilityMi.value === null ? 'visibility unknown' : `visibility ${fmtNum(o.visibilityMi.value, 1)} mi`;
    rows.push(['Observed weather', `${o.description ?? 'Conditions'}; ${t}; ${wind}; ${gust}; ${vis}`, `${provenanceLabel(o.provenance)}${o.provenance.stale ? ' (stale)' : ''}`]);
    rows.push(['Lightning', 'Unknown: lightning is not in the NWS feed; use the agency lightning service', '']);
  } else rows.push(['Observed weather', 'Unknown: no observation received', '']);
  const next = weather.hourly?.periods.slice(0, 3) ?? [];
  if (next.length && weather.hourly) {
    rows.push([
      'Next hours',
      next.map((p) => `${fmtDateTime(p.startTime).slice(11)} ${p.temperatureF === null ? '?' : `${p.temperatureF} °F`}, ${p.shortForecast ?? 'no summary'}, rain chance ${p.precipChancePct === null ? 'unknown' : `${p.precipChancePct}%`}`).join('; '),
      `${provenanceLabel(weather.hourly.provenance)}${weather.hourly.provenance.stale ? ' (stale)' : ''}`,
    ]);
  }
  if (weather.alerts) {
    rows.push(['Weather alerts', weather.alerts.items.length ? weather.alerts.items.map((a) => `${a.event} until ${fmtDateTime(a.expires)}`).join('; ') : 'None in effect for the venue', `${provenanceLabel(weather.alerts.provenance)}${weather.alerts.provenance.stale ? ' (stale)' : ''}`]);
  } else rows.push(['Weather alerts', 'Unknown: alerts not received', '']);
  return rows.map((r) => r.map((cell) => esc(cell)));
}

export function sitrepSheets(input: SitrepInput): SheetSpec[] {
  return [
    {
      form: 'Situation report',
      formTitle: `Situation report${input.number !== undefined ? ` no. ${input.number}` : ''}`,
      parts: [
        fields([
          { label: 'As of', value: fmtDateTime(input.asOf) },
          { label: 'Report number', value: input.number === undefined ? '' : String(input.number) },
          { label: 'Next report', value: input.nextReportAt ? fmtDateTime(input.nextReportAt) : 'Not scheduled' },
        ]),
        textBox('Current situation', input.summary),
        table(
          'Key figures (each with its source and age)',
          [{ label: 'Figure', width: 2.2 }, { label: 'Value', width: 1.2, cls: 'num' }, { label: 'Source', width: 3 }],
          input.keyFigures.map((f) => [esc(f.label), esc(f.value === null ? 'unknown' : typeof f.value === 'number' ? `${fmtNum(f.value, Number.isInteger(f.value) ? 0 : 1)}${f.unit ? ` ${f.unit}` : ''}` : `${f.value}${f.unit ? ` ${f.unit}` : ''}`), esc(`${provenanceLabel(f.provenance)}${f.provenance.range ? `, range ${f.provenance.range.low} to ${f.provenance.range.high}` : ''}`)]),
        ),
        table('Weather', [{ label: 'Item', width: 1.4 }, { label: 'Value', width: 4 }, { label: 'Source', width: 2 }], weatherRows(input.weather)),
        table('Significant events', [{ label: 'Time', width: 1.4 }, { label: 'Event', width: 6 }], (input.events ?? []).map((e) => [esc(fmtDateTime(e.at)), esc(e.text)]), 'portrait', { empty: 'None since the last report.' }),
        table('Resources', [{ label: 'Resource', width: 2.4 }, { label: 'Committed', width: 1, cls: 'num' }, { label: 'Available', width: 1, cls: 'num' }, { label: 'Out of service', width: 1, cls: 'num' }], (input.resources ?? []).map((r) => [esc(r.kind), fmtNum(r.committed), fmtNum(r.available), fmtNum(r.outOfService ?? null, 0, '')])),
        listBox('Actions taken', input.actionsTaken, 'portrait', { numbered: false }),
        listBox('Planned actions', input.plannedActions, 'portrait', { numbered: false }),
        ...(input.issues?.length ? [listBox('Issues and requests', input.issues, 'portrait', { numbered: false })] : []),
        raw('<p class="note">Values marked simulated are model outputs under stated assumptions, not observations. Unknown means the source did not report it, never zero.</p>', 24),
      ],
    },
  ];
}
