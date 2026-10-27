import type { Db } from '../db.ts';
import type { FeedStatus, HourlyPeriod, Measured, Provenance, UsUnit, WeatherAlert, WeatherObservation, WeatherReport } from '../types.ts';
import type { PlatformConfig } from '../platform/config.ts';
import { iso } from '../platform/canonical.ts';
import type { SafeFetchDeps } from '../net/safe-fetch.ts';
import { FeedCache } from './cache.ts';

/**
 * National Weather Service adapter (api.weather.gov; PLT-24, PLT-25).
 *
 * The venue point is resolved through `/points` (cached a day, re-resolved
 * after), giving the forecast grid, the hourly forecast URL and the nearby
 * observation stations. Then the latest observation, the hourly forecast and
 * the active alerts for the point are fetched through the HTTP cache. Every
 * value comes out in US units with its provenance and age; a value the feed
 * does not give is `null` with a reason, never zero. NWS data is a US
 * Government work (public domain); the API asks for an identifying
 * User-Agent, which carries GAMEDAY_FEED_CONTACT.
 */
export const NWS_BASE = 'https://api.weather.gov';
export const NWS_ATTRIBUTION = 'Weather: NOAA National Weather Service (api.weather.gov), US Government work, public domain.';
const LICENCE = 'US Government work (public domain)';

export const NWS_INTERVALS = {
  pointsMs: 24 * 60 * 60_000,
  stationsMs: 24 * 60 * 60_000,
  observationMs: 5 * 60_000,
  hourlyMs: 15 * 60_000,
  alertsMs: 60_000,
};

/** After these ages a part is marked stale. Observations are hourly; alerts must be current. */
export const STALE_AFTER_S = { observation: 90 * 60, hourly: 3 * 60 * 60, alerts: 5 * 60 };

interface QuantValue {
  unitCode?: string;
  value?: number | null;
  qualityControl?: string;
}

const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places;

/** Unit conversions from the WMO codes the NWS uses to US customary. */
const CONVERT: Record<string, { to: UsUnit; fn: (n: number) => number; places: number }[]> = {
  'wmoUnit:degC': [{ to: 'degF', fn: (c) => (c * 9) / 5 + 32, places: 1 }],
  'wmoUnit:degF': [{ to: 'degF', fn: (f) => f, places: 1 }],
  'wmoUnit:km_h-1': [{ to: 'mph', fn: (k) => k / 1.609344, places: 1 }],
  'wmoUnit:m_s-1': [{ to: 'mph', fn: (m) => (m * 3600) / 1609.344, places: 1 }],
  'wmoUnit:Pa': [{ to: 'inHg', fn: (pa) => pa / 3386.389, places: 2 }],
  'wmoUnit:m': [
    { to: 'mi', fn: (m) => m / 1609.344, places: 1 },
    { to: 'in', fn: (m) => (m * 100) / 2.54, places: 2 },
  ],
  'wmoUnit:mm': [{ to: 'in', fn: (mm) => mm / 25.4, places: 2 }],
  'wmoUnit:percent': [{ to: 'percent', fn: (p) => p, places: 0 }],
  'wmoUnit:degree_(angle)': [{ to: 'deg', fn: (d) => d, places: 0 }],
};

export function measure(q: QuantValue | undefined | null, unit: UsUnit, provenance: Provenance): Measured {
  if (!q || q.value === null || q.value === undefined || !Number.isFinite(q.value)) return { value: null, unit, reason: 'missing', ...(q?.qualityControl ? { qc: q.qualityControl } : {}), provenance };
  if (q.qualityControl === 'X' || q.qualityControl === 'Q') return { value: null, unit, reason: 'failed_quality_control', qc: q.qualityControl, provenance };
  const conversion = CONVERT[q.unitCode ?? '']?.find((c) => c.to === unit);
  if (!conversion) return { value: null, unit, reason: 'unknown_unit', provenance };
  return { value: round(conversion.fn(q.value), conversion.places), unit, ...(q.qualityControl ? { qc: q.qualityControl } : {}), provenance };
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export const compass = (deg: number) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16]!;

const ageS = (asOf: string | null, now: number) => (asOf ? (now - Date.parse(asOf)) / 1000 : Infinity);

export function normalizeObservation(body: unknown, url: string, fetchedAt: number, now: number): WeatherObservation | null {
  const p = (body as { properties?: Record<string, unknown> })?.properties;
  if (!p) return null;
  const stationId = typeof p.stationId === 'string' ? p.stationId : typeof p.station === 'string' ? p.station.split('/').pop()! : null;
  const stationName = typeof p.stationName === 'string' ? p.stationName : null;
  const observedAt = typeof p.timestamp === 'string' ? new Date(p.timestamp).toISOString() : null;
  const provenance: Provenance = {
    kind: 'observed',
    source: `NWS observation, station ${stationId ?? 'unknown'}${stationName ? ` (${stationName})` : ''}`,
    asOf: observedAt,
    fetchedAt: iso(fetchedAt),
    staleAfterS: STALE_AFTER_S.observation,
    stale: ageS(observedAt, now) > STALE_AFTER_S.observation,
    licence: LICENCE,
    url,
  };
  const q = (key: string) => p[key] as QuantValue | undefined;
  const windSpeed = measure(q('windSpeed'), 'mph', provenance);
  let windFrom = measure(q('windDirection'), 'deg', provenance);
  // A calm report gives direction 0 with speed 0: that is "no direction", not north.
  if (windSpeed.value === 0) windFrom = { value: null, unit: 'deg', reason: 'calm', provenance };
  return {
    station: stationId ? { id: stationId, name: stationName } : null,
    observedAt,
    description: typeof p.textDescription === 'string' && p.textDescription ? p.textDescription : null,
    temperatureF: measure(q('temperature'), 'degF', provenance),
    dewpointF: measure(q('dewpoint'), 'degF', provenance),
    relativeHumidityPct: measure(q('relativeHumidity'), 'percent', provenance),
    heatIndexF: measure(q('heatIndex'), 'degF', provenance),
    windChillF: measure(q('windChill'), 'degF', provenance),
    windSpeedMph: windSpeed,
    windGustMph: measure(q('windGust'), 'mph', provenance),
    windFromDeg: windFrom,
    windFromCompass: windFrom.value === null ? (windFrom.reason === 'calm' ? 'calm' : null) : compass(windFrom.value),
    visibilityMi: measure(q('visibility'), 'mi', provenance),
    pressureInHg: measure(q('barometricPressure'), 'inHg', provenance),
    precipLastHourIn: measure(q('precipitationLastHour'), 'in', provenance),
    lightning: { value: null, reason: 'not_in_feed', provenance: { kind: 'observed', source: 'not available from the NWS API; use an agency lightning service', asOf: null } },
    provenance,
  };
}

/** "10 mph", "5 to 15 mph", "" → numbers or null. */
export function parseWindRange(text: unknown): { low: number | null; high: number | null } {
  if (typeof text !== 'string') return { low: null, high: null };
  const numbers = [...text.matchAll(/(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
  if (!numbers.length) return { low: null, high: null };
  const factor = /km\/h/i.test(text) ? 1 / 1.609344 : 1;
  return { low: round(numbers[0]! * factor, 1), high: round(numbers[numbers.length - 1]! * factor, 1) };
}

export function normalizeHourly(body: unknown, url: string, fetchedAt: number, now: number, gridLabel: string, limit = 48): { periods: HourlyPeriod[]; provenance: Provenance } | null {
  const p = (body as { properties?: { periods?: unknown[]; updateTime?: string; generatedAt?: string } })?.properties;
  if (!p || !Array.isArray(p.periods)) return null;
  const asOf = p.updateTime ? new Date(p.updateTime).toISOString() : p.generatedAt ? new Date(p.generatedAt).toISOString() : null;
  const provenance: Provenance = {
    kind: 'forecast',
    source: `NWS hourly forecast, grid ${gridLabel}`,
    asOf,
    fetchedAt: iso(fetchedAt),
    staleAfterS: STALE_AFTER_S.hourly,
    stale: ageS(asOf, now) > STALE_AFTER_S.hourly,
    licence: LICENCE,
    url,
  };
  const periods: HourlyPeriod[] = [];
  for (const raw of p.periods as Record<string, unknown>[]) {
    if (typeof raw.startTime !== 'string' || typeof raw.endTime !== 'string') continue;
    if (Date.parse(raw.endTime) <= now) continue;
    const temp = typeof raw.temperature === 'number' ? (raw.temperatureUnit === 'C' ? round((raw.temperature * 9) / 5 + 32, 0) : raw.temperature) : null;
    const pop = raw.probabilityOfPrecipitation as QuantValue | undefined;
    const rh = raw.relativeHumidity as QuantValue | undefined;
    periods.push({
      startTime: raw.startTime,
      endTime: raw.endTime,
      isDaytime: typeof raw.isDaytime === 'boolean' ? raw.isDaytime : null,
      temperatureF: temp,
      windSpeedMph: parseWindRange(raw.windSpeed),
      windFrom: typeof raw.windDirection === 'string' && raw.windDirection ? raw.windDirection : null,
      precipChancePct: pop && typeof pop.value === 'number' ? pop.value : null,
      relativeHumidityPct: rh && typeof rh.value === 'number' ? rh.value : null,
      dewpointF: measure(raw.dewpoint as QuantValue, 'degF', provenance).value,
      shortForecast: typeof raw.shortForecast === 'string' && raw.shortForecast ? raw.shortForecast : null,
    });
    if (periods.length >= limit) break;
  }
  return { periods, provenance };
}

export function normalizeAlerts(body: unknown, url: string, fetchedAt: number, now: number): { items: WeatherAlert[]; provenance: Provenance } | null {
  const features = (body as { features?: { properties?: Record<string, unknown> }[] })?.features;
  if (!Array.isArray(features)) return null;
  const s = (v: unknown) => (typeof v === 'string' && v ? v : null);
  const items: WeatherAlert[] = features
    .map((f) => f.properties ?? {})
    .filter((p) => !p.expires || Date.parse(String(p.expires)) > now)
    .map((p) => ({
      id: String(p.id ?? ''),
      event: String(p.event ?? 'Alert'),
      headline: s(p.headline),
      severity: String(p.severity ?? 'Unknown'),
      urgency: String(p.urgency ?? 'Unknown'),
      certainty: String(p.certainty ?? 'Unknown'),
      status: String(p.status ?? 'Unknown'),
      messageType: String(p.messageType ?? 'Alert'),
      sent: s(p.sent),
      effective: s(p.effective),
      onset: s(p.onset),
      expires: s(p.expires),
      ends: s(p.ends),
      senderName: s(p.senderName),
      areaDesc: String(p.areaDesc ?? ''),
      description: s(p.description),
      instruction: s(p.instruction),
      response: s(p.response),
    }));
  return {
    items,
    provenance: {
      kind: 'observed',
      source: 'NWS active alerts for the venue point',
      asOf: iso(fetchedAt),
      fetchedAt: iso(fetchedAt),
      staleAfterS: STALE_AFTER_S.alerts,
      stale: (now - fetchedAt) / 1000 > STALE_AFTER_S.alerts,
      licence: LICENCE,
      url,
    },
  };
}

interface PointInfo {
  gridId: string;
  gridX: number;
  gridY: number;
  forecastHourly: string;
  observationStations: string;
  forecastZone: string | null;
  county: string | null;
  timeZone: string | null;
}

export function parsePoint(body: unknown): PointInfo | null {
  const p = (body as { properties?: Record<string, unknown> })?.properties;
  if (!p || typeof p.gridId !== 'string' || typeof p.forecastHourly !== 'string' || typeof p.observationStations !== 'string') return null;
  const last = (v: unknown) => (typeof v === 'string' ? v.split('/').pop()! : null);
  return {
    gridId: p.gridId,
    gridX: Number(p.gridX),
    gridY: Number(p.gridY),
    forecastHourly: p.forecastHourly,
    observationStations: p.observationStations,
    forecastZone: last(p.forecastZone),
    county: last(p.county),
    timeZone: typeof p.timeZone === 'string' ? p.timeZone : null,
  };
}

/** NWS wants at most four decimal places on /points. */
export const pointUrl = (lat: number, lon: number) => `${NWS_BASE}/points/${lat.toFixed(4)},${lon.toFixed(4)}`;
const onNws = (url: string) => url.startsWith(`${NWS_BASE}/`);

export class NwsAdapter {
  private readonly cache: FeedCache;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight: Promise<WeatherReport> | null = null;
  private readonly now: () => number;

  private readonly db: Db;
  private readonly config: PlatformConfig;
  constructor(
    db: Db,
    config: PlatformConfig,
    deps: SafeFetchDeps & { now?: () => number },
    jitter?: () => number,
  ) {
    this.db = db;
    this.config = config;
    this.now = deps.now ?? Date.now;
    this.cache = new FeedCache(db, deps, { userAgent: config.feeds.userAgent, now: this.now, jitter });
  }

  get enabled(): boolean {
    return this.config.feeds.enabled;
  }

  /** The last report, with staleness recomputed for now. */
  report(): WeatherReport {
    const row = this.db.prepare("select json from feed_snapshots where feed = 'nws'").get() as { json: string } | undefined;
    if (!row) return this.empty(this.enabled ? 'unavailable' : 'not_configured');
    const report = JSON.parse(row.json) as WeatherReport;
    if (!this.enabled) report.status = 'not_configured';
    return restale(report, this.now());
  }

  private empty(status: FeedStatus): WeatherReport {
    return { feed: 'nws', status, venue: this.config.venue, point: null, observation: null, hourly: null, alerts: null, errors: [], attribution: NWS_ATTRIBUTION, units: 'us', generatedAt: iso(this.now()) };
  }

  refresh(opts: { force?: boolean } = {}): Promise<WeatherReport> {
    this.inflight ??= this.doRefresh(opts).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async doRefresh(opts: { force?: boolean }): Promise<WeatherReport> {
    if (!this.enabled) return this.empty('not_configured');
    const now = this.now();
    const errors: WeatherReport['errors'] = [];
    const note = (part: string, message: string | null) => {
      if (message) errors.push({ part, message, at: iso(now) });
    };
    const json = (text: string | null) => {
      try {
        return text ? JSON.parse(text) : null;
      } catch {
        return null;
      }
    };

    const venue = this.config.venue;
    const pUrl = pointUrl(venue.lat, venue.lon);
    const pointRes = await this.cache.get(pUrl, { minIntervalMs: NWS_INTERVALS.pointsMs, force: opts.force });
    note('points', pointRes.error);
    const point = parsePoint(json(pointRes.body));
    if (!point) {
      const report = { ...this.empty('unavailable'), errors };
      this.save(report);
      return report;
    }

    const stationsRes = onNws(point.observationStations) ? await this.cache.get(point.observationStations, { minIntervalMs: NWS_INTERVALS.stationsMs, force: opts.force }) : null;
    note('stations', stationsRes?.error ?? (stationsRes ? null : 'station list is not on api.weather.gov'));
    const stations = ((json(stationsRes?.body ?? null) as { features?: { properties?: { stationIdentifier?: string } }[] } | null)?.features ?? [])
      .map((f) => f.properties?.stationIdentifier)
      .filter((id): id is string => typeof id === 'string' && /^[A-Z0-9]{3,5}$/.test(id))
      .slice(0, 3);

    let observation: WeatherObservation | null = null;
    for (const station of stations) {
      const url = `${NWS_BASE}/stations/${station}/observations/latest`;
      const res = await this.cache.get(url, { minIntervalMs: NWS_INTERVALS.observationMs, force: opts.force });
      note(`observation ${station}`, res.error);
      const parsed = res.body && res.fetchedAt ? normalizeObservation(json(res.body), url, res.fetchedAt, now) : null;
      if (parsed && parsed.temperatureF.value !== null && !parsed.provenance.stale) {
        observation = parsed;
        break;
      }
      observation ??= parsed;
    }

    const hourlyUrl = `${point.forecastHourly}${point.forecastHourly.includes('?') ? '&' : '?'}units=us`;
    const hourlyRes = onNws(hourlyUrl) ? await this.cache.get(hourlyUrl, { minIntervalMs: NWS_INTERVALS.hourlyMs, force: opts.force }) : null;
    note('hourly', hourlyRes?.error ?? null);
    const hourly = hourlyRes?.body && hourlyRes.fetchedAt ? normalizeHourly(json(hourlyRes.body), hourlyUrl, hourlyRes.fetchedAt, now, `${point.gridId} ${point.gridX},${point.gridY}`) : null;

    const alertsUrl = `${NWS_BASE}/alerts/active?point=${venue.lat.toFixed(4)},${venue.lon.toFixed(4)}`;
    const alertsRes = await this.cache.get(alertsUrl, { minIntervalMs: NWS_INTERVALS.alertsMs, force: opts.force });
    note('alerts', alertsRes.error);
    const alerts = alertsRes.body && alertsRes.fetchedAt ? normalizeAlerts(json(alertsRes.body), alertsUrl, alertsRes.fetchedAt, now) : null;

    const report: WeatherReport = {
      feed: 'nws',
      status: 'ok',
      venue,
      point: { gridId: point.gridId, gridX: point.gridX, gridY: point.gridY, forecastZone: point.forecastZone, county: point.county, timeZone: point.timeZone, stations, resolvedAt: iso(pointRes.fetchedAt ?? now) },
      observation,
      hourly,
      alerts,
      errors,
      attribution: NWS_ATTRIBUTION,
      units: 'us',
      generatedAt: iso(now),
    };
    const finished = restale(report, now);
    this.save(finished);
    return finished;
  }

  private save(report: WeatherReport): void {
    this.db.prepare("insert or replace into feed_snapshots (feed, json, updated_at) values ('nws', ?, ?)").run(JSON.stringify(report), this.now());
  }

  start(everyMs = 60_000): void {
    if (!this.enabled || this.timer) return;
    void this.refresh().catch(() => {});
    this.timer = setInterval(() => void this.refresh().catch(() => {}), everyMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/** Recompute every part's staleness for `now`, and the overall status from them. */
export function restale(report: WeatherReport, now: number): WeatherReport {
  const stale = (p: Provenance | undefined, from: 'asOf' | 'fetchedAt') => {
    if (!p) return true;
    const at = from === 'asOf' ? p.asOf : p.fetchedAt ?? null;
    p.stale = ageS(at, now) > (p.staleAfterS ?? Infinity);
    return p.stale;
  };
  const parts: boolean[] = [];
  if (report.observation) {
    const s = stale(report.observation.provenance, 'asOf');
    for (const [key, value] of Object.entries(report.observation)) {
      if (key !== 'lightning' && key !== 'provenance' && value && typeof value === 'object' && 'provenance' in value) (value as Measured).provenance.stale = s;
    }
    parts.push(s);
  }
  if (report.hourly) parts.push(stale(report.hourly.provenance, 'asOf'));
  if (report.alerts) parts.push(stale(report.alerts.provenance, 'fetchedAt'));
  if (report.status === 'not_configured' || report.status === 'disabled') return report;
  const any = report.observation || report.hourly || report.alerts;
  report.status = !any ? 'unavailable' : parts.some(Boolean) || !report.observation || !report.hourly || !report.alerts ? 'stale' : 'ok';
  return report;
}
