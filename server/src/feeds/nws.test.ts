import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db.ts';
import { migratePlatform } from '../platform/schema.ts';
import { testConfig } from '../platform/config.ts';
import { Allowlist } from '../net/allowlist.ts';
import type { FetchTransport } from '../net/safe-fetch.ts';
import { compass, measure, NwsAdapter, parseWindRange, pointUrl } from './nws.ts';
import { freshnessMs } from './cache.ts';
import { FakeClock, addUser, makeApp, signIn } from '../testing.ts';

interface Fixture {
  url: string;
  status: number;
  headers: Record<string, string>;
  body: unknown;
}
const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', `${name}.json`), 'utf8')) as Fixture;

const RECORDED_AT = Date.parse('2026-10-27T01:17:00Z');

/** Serves the recorded NWS answers by path, honouring If-None-Match, and records every request. */
function nwsFixtures(overrides: Record<string, Fixture | ((req: { headers: Record<string, string> }) => Fixture)> = {}) {
  const byPath: Record<string, Fixture | ((req: { headers: Record<string, string> }) => Fixture)> = {
    '/points/40.0016,-83.0197': fixture('nws-points'),
    '/gridpoints/ILN/84,83/stations': fixture('nws-stations'),
    '/stations/KOSU/observations/latest': fixture('nws-observation-latest'),
    '/gridpoints/ILN/84,83/forecast/hourly': fixture('nws-forecast-hourly'),
    '/alerts/active': fixture('nws-alerts-none'),
    ...overrides,
  };
  const requests: { path: string; headers: Record<string, string> }[] = [];
  const transport: FetchTransport = async (req) => {
    requests.push({ path: req.url.pathname + req.url.search, headers: req.headers });
    const entry = byPath[req.url.pathname];
    if (!entry) return { status: 404, headers: {}, body: Buffer.from('{}') };
    const f = typeof entry === 'function' ? entry(req) : entry;
    if (f.headers.etag && req.headers['if-none-match'] === f.headers.etag) return { status: 304, headers: { 'cache-control': f.headers['cache-control'] ?? '' }, body: Buffer.alloc(0) };
    return { status: f.status, headers: f.headers, body: Buffer.from(typeof f.body === 'string' ? f.body : JSON.stringify(f.body)) };
  };
  return { transport, requests };
}

function adapter(net: ReturnType<typeof nwsFixtures>, contact: string | null = 'ops@agency.example.gov', clock = new FakeClock(RECORDED_AT)) {
  const db = openDb(':memory:');
  migratePlatform(db);
  const allowlist = new Allowlist(db);
  allowlist.seedDefaults();
  const config = testConfig({ feeds: { enabled: Boolean(contact), contact, userAgent: `GamedayCommand/3.0 (+https://github.com/Pratham9890/gameday-command${contact ? `; ${contact}` : ''})` } });
  const nws = new NwsAdapter(db, config, { allowlist, resolver: async () => [{ address: '23.215.0.136', family: 4 }], transport: net.transport, now: clock.now }, () => 1);
  return { nws, clock, db };
}

describe('the NWS adapter, on recorded answers', () => {
  it('resolves the venue point and normalises the latest observation into US units', async () => {
    const net = nwsFixtures();
    const { nws } = adapter(net);
    const report = await nws.refresh();
    expect(report.status).toBe('ok');
    expect(report.point).toMatchObject({ gridId: 'ILN', gridX: 84, gridY: 83, forecastZone: 'OHZ055', county: 'OHC049', timeZone: 'America/New_York', stations: ['KOSU', 'KCMH', 'KTZR'] });
    const o = report.observation!;
    expect(o.station).toEqual({ id: 'KOSU', name: 'Columbus, Ohio State University Airport' });
    expect(o.observedAt).toBe('2026-10-27T00:45:00.000Z');
    expect(o.temperatureF).toMatchObject({ value: 60.8, unit: 'degF', qc: 'V' });
    expect(o.dewpointF.value).toBe(44.6);
    expect(o.relativeHumidityPct.value).toBe(55);
    expect(o.pressureInHg).toMatchObject({ value: 30.3, unit: 'inHg' });
    expect(o.visibilityMi).toMatchObject({ value: 10, unit: 'mi' });
    // A real, quality-checked zero is a zero ...
    expect(o.windSpeedMph).toMatchObject({ value: 0, unit: 'mph' });
    // ... but a calm wind has no direction, and a missing gust is unknown, never 0.
    expect(o.windFromDeg).toMatchObject({ value: null, reason: 'calm' });
    expect(o.windFromCompass).toBe('calm');
    expect(o.windGustMph).toMatchObject({ value: null, reason: 'missing', qc: 'Z' });
    expect(o.heatIndexF.value).toBeNull();
    expect(o.precipLastHourIn).toMatchObject({ value: null, reason: 'missing' });
    expect(o.lightning).toMatchObject({ value: null, reason: 'not_in_feed' });
    expect(o.provenance).toMatchObject({ kind: 'observed', asOf: '2026-10-27T00:45:00.000Z', stale: false, licence: expect.stringMatching(/public domain/) });
    expect(o.provenance.source).toContain('KOSU');
    expect(o.temperatureF.provenance).toEqual(o.provenance);
  });

  it('carries the hourly forecast with its provenance', async () => {
    const { nws } = adapter(nwsFixtures());
    const { hourly } = await nws.refresh();
    expect(hourly!.provenance).toMatchObject({ kind: 'forecast', asOf: '2026-10-26T20:00:34.000Z', stale: false });
    expect(hourly!.periods[0]).toMatchObject({ startTime: '2026-10-26T21:00:00-04:00', temperatureF: 59, windSpeedMph: { low: 0, high: 0 }, windFrom: null, precipChancePct: 2, dewpointF: 47, shortForecast: 'Partly Cloudy' });
    expect(hourly!.periods.length).toBeGreaterThan(20);
  });

  it('reads active alerts, and an empty list as an empty list', async () => {
    expect((await adapter(nwsFixtures()).nws.refresh()).alerts!.items).toEqual([]);
    const report = await adapter(nwsFixtures({ '/alerts/active': fixture('nws-alerts-one') })).nws.refresh();
    expect(report.alerts!.items).toHaveLength(1);
    expect(report.alerts!.items[0]).toMatchObject({ event: 'Flash Flood Warning', severity: 'Severe', urgency: 'Immediate', certainty: 'Likely', status: 'Actual', senderName: 'NWS Midland/Odessa TX' });
  });

  it('identifies itself with the configured contact and asks only api.weather.gov', async () => {
    const net = nwsFixtures();
    await adapter(net).nws.refresh();
    expect(net.requests.map((r) => r.path)).toEqual([
      '/points/40.0016,-83.0197',
      '/gridpoints/ILN/84,83/stations',
      '/stations/KOSU/observations/latest',
      '/gridpoints/ILN/84,83/forecast/hourly?units=us',
      '/alerts/active?point=40.0016,-83.0197',
    ]);
    for (const r of net.requests) {
      expect(r.headers['user-agent']).toMatch(/^GamedayCommand\/3\.0 \(\+https:\/\/github\.com\/Pratham9890\/gameday-command; ops@agency\.example\.gov\)$/);
      expect(r.headers.accept).toBe('application/geo+json');
    }
    expect(pointUrl(40.0016478, -83.0197398)).toBe('https://api.weather.gov/points/40.0016,-83.0197');
  });

  it('is an HTTP cache: nothing refetched while fresh, then revalidated with ETag', async () => {
    const net = nwsFixtures();
    const { nws, clock } = adapter(net);
    await nws.refresh();
    expect(net.requests).toHaveLength(5);
    clock.advance(30_000);
    await nws.refresh();
    expect(net.requests).toHaveLength(5);
    clock.advance(31_000);
    await nws.refresh();
    const alerts = net.requests.slice(5);
    expect(alerts.map((r) => r.path)).toEqual(['/alerts/active?point=40.0016,-83.0197']);
    expect(alerts[0]!.headers['if-none-match']).toBe('W/"da93513ef9cf99e3091b086f0b638a34"');
    clock.advance(5 * 60_000);
    await nws.refresh();
    const obs = net.requests.find((r, i) => i > 5 && r.path.startsWith('/stations/'))!;
    expect(obs.headers['if-modified-since']).toBe('Tue, 27 Oct 2026 00:45:00 GMT');
  });

  it('backs off after errors, keeps the last good values, and marks them stale as they age', async () => {
    let failing = false;
    const good = fixture('nws-observation-latest');
    const net = nwsFixtures({
      '/stations/KOSU/observations/latest': () => (failing ? { url: '', status: 503, headers: { 'retry-after': '120' }, body: { title: 'Service Unavailable' } } : good),
    });
    const { nws, clock } = adapter(net);
    await nws.refresh();
    failing = true;
    clock.advance(6 * 60_000);
    let report = await nws.refresh();
    expect(report.errors.map((e) => e.part)).toContain('observation KOSU');
    expect(report.errors[0]!.message).toMatch(/HTTP 503/);
    expect(report.observation!.temperatureF.value).toBe(60.8);
    const before = net.requests.filter((r) => r.path.startsWith('/stations/KOSU')).length;
    clock.advance(60_000);
    await nws.refresh();
    expect(net.requests.filter((r) => r.path.startsWith('/stations/KOSU')).length).toBe(before);
    clock.advance(2 * 60 * 60_000);
    report = await nws.refresh();
    expect(report.observation!.provenance.stale).toBe(true);
    expect(report.observation!.temperatureF.provenance.stale).toBe(true);
    expect(report.status).toBe('stale');
  });

  it('keeps the last report across a restart (SQLite) and recomputes its age', async () => {
    const net = nwsFixtures();
    const { nws, clock, db } = adapter(net);
    await nws.refresh();
    clock.advance(4 * 60 * 60_000);
    const reborn = new NwsAdapter(db, testConfig({ feeds: { enabled: true, contact: 'ops@agency.example.gov', userAgent: 'x' } }), { allowlist: new Allowlist(db), resolver: async () => [], transport: net.transport, now: clock.now });
    const report = reborn.report();
    expect(report.observation!.temperatureF.value).toBe(60.8);
    expect(report.status).toBe('stale');
  });

  it('makes no request at all until a contact is configured', async () => {
    const net = nwsFixtures();
    const { nws } = adapter(net, null);
    const report = await nws.refresh();
    expect(report.status).toBe('not_configured');
    expect(report.observation).toBeNull();
    expect(net.requests).toEqual([]);
  });

  it('turns an unknown unit or a failed quality check into unknown, not a number', () => {
    const p = { kind: 'observed' as const, source: 't', asOf: null };
    expect(measure({ unitCode: 'wmoUnit:furlong', value: 3 }, 'mi', p)).toMatchObject({ value: null, reason: 'unknown_unit' });
    expect(measure({ unitCode: 'wmoUnit:degC', value: 40, qualityControl: 'X' }, 'degF', p)).toMatchObject({ value: null, reason: 'failed_quality_control' });
    expect(measure({ unitCode: 'wmoUnit:m_s-1', value: 10 }, 'mph', p).value).toBe(22.4);
    expect(parseWindRange('5 to 15 mph')).toEqual({ low: 5, high: 15 });
    expect(parseWindRange('')).toEqual({ low: null, high: null });
    expect([compass(0), compass(95), compass(350)]).toEqual(['N', 'E', 'N']);
    expect(freshnessMs({ 'cache-control': 'public, max-age=161, s-maxage=300' }, 0)).toBe(161_000);
    expect(freshnessMs({ expires: 'Tue, 27 Oct 2026 01:19:36 GMT', date: 'Tue, 27 Oct 2026 01:16:55 GMT' }, 0)).toBe(161_000);
  });
});

describe('GET /api/v3/feeds/weather', () => {
  it('serves the report to any signed-in position and lets an administrator force a refresh', async () => {
    const net = nwsFixtures();
    const { app, platform } = makeApp(
      { feeds: { enabled: true, contact: 'ops@agency.example.gov', userAgent: 'GamedayCommand/3.0 (test)' } },
      { resolver: async () => [{ address: '23.215.0.136', family: 4 }], transport: net.transport, clock: new FakeClock(RECORDED_AT) },
    );
    await addUser(platform, 'admin.one', [{ position: 'admin', scope: '*' }]);
    await addUser(platform, 'unit.12', [{ position: 'field_unit', unit: 'OSU PD 12' }]);
    const admin = await signIn(app, 'admin.one');
    const unit = await signIn(app, 'unit.12');
    expect((await unit.post('/api/v3/feeds/weather/refresh')).status).toBe(403);
    const refreshed = await admin.json('POST', '/api/v3/feeds/weather/refresh');
    expect(refreshed.body.status).toBe('ok');
    const report = await unit.json('GET', '/api/v3/feeds/weather');
    expect(report.status).toBe(200);
    expect(report.body).toMatchObject({ feed: 'nws', units: 'us', venue: { name: 'Ohio Stadium' }, observation: { temperatureF: { value: 60.8 } } });
    expect(report.body.attribution).toMatch(/National Weather Service/);
    expect(platform.audit.list({ action: 'feed.refresh' })).toHaveLength(1);
  });
});
