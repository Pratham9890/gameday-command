/**
 * Check the NWS feed end to end from this machine, without touching the
 * server's database: resolve the venue point, fetch the latest observation,
 * the hourly forecast and active alerts through the outbound guard, and print
 * a summary. Needs a contact for the User-Agent, as the NWS asks:
 *
 *   GAMEDAY_FEED_CONTACT=ops@agency.example.gov npm run weather:check
 */
import { openDb } from '../src/db.ts';
import { loadConfig } from '../src/platform/config.ts';
import { createPlatform } from '../src/platform/platform.ts';

const config = loadConfig({ ...process.env, GAMEDAY_FEEDS: '1' });
if (!config.feeds.contact) {
  console.error('Set GAMEDAY_FEED_CONTACT (an email address or URL the NWS can reach you at).');
  process.exit(1);
}
const platform = createPlatform(openDb(':memory:'), config);
const started = Date.now();
const report = await platform.weather.refresh({ force: true });
const o = report.observation;
console.log(
  JSON.stringify(
    {
      status: report.status,
      ms: Date.now() - started,
      userAgent: config.feeds.userAgent,
      point: report.point,
      observation: o && {
        station: o.station,
        observedAt: o.observedAt,
        temperatureF: o.temperatureF.value,
        windMph: o.windSpeedMph.value,
        windFrom: o.windFromCompass,
        gustMph: o.windGustMph.value ?? `unknown (${o.windGustMph.reason})`,
        visibilityMi: o.visibilityMi.value,
        pressureInHg: o.pressureInHg.value,
        stale: o.provenance.stale,
      },
      hourly: report.hourly && { periods: report.hourly.periods.length, first: report.hourly.periods[0], asOf: report.hourly.provenance.asOf },
      alerts: report.alerts && report.alerts.items.map((a) => `${a.event} (${a.severity}, until ${a.expires})`),
      errors: report.errors,
    },
    null,
    2,
  ),
);
