import type { DecisionContext, Incident, SimSeconds, WeatherKind, WeatherState, WeatherTimeline } from '../../contracts.ts';

/**
 * Weather scenarios for game day in Columbus. Like fan behavior, these are an
 * assumption chosen to show tradeoffs, not a forecast.
 *
 * Weather changes three things and nothing else: how fast people walk, how fast
 * vehicles drive, and the `weather` field of a decision's context (which is what
 * lets the model answer a fan in the rain differently from one in the sun).
 * Clear weather multiplies every speed by exactly 1 and leaves the decision
 * context at 'clear', so a clear-day run is step for step the v1 run.
 */

const state = (kind: WeatherKind, s: Partial<WeatherState> = {}): WeatherState => ({
  kind,
  intensity: 0,
  tempC: 12,
  windMps: 3,
  windFromDeg: 250,
  visibilityM: 10_000,
  lightning: false,
  ...s,
});

export const CLEAR_SKY: WeatherState = state('clear');

export const WEATHER_TIMELINES: WeatherTimeline[] = [
  { id: 'clear', label: 'Clear, 12°C', segments: [{ from: -Infinity, state: CLEAR_SKY }] },
  {
    id: 'rain-at-kickoff',
    label: 'Rain moving in at kickoff',
    segments: [
      { from: -Infinity, state: state('overcast', { intensity: 0.3, tempC: 10, windMps: 5 }) },
      { from: -1200, state: state('rain', { intensity: 0.45, tempC: 9, windMps: 6, visibilityM: 4000 }) },
      { from: 0, state: state('heavy_rain', { intensity: 0.9, tempC: 8, windMps: 9, windFromDeg: 230, visibilityM: 1200 }) },
      { from: 1800, state: state('rain', { intensity: 0.5, tempC: 8, windMps: 6, visibilityM: 3000 }) },
    ],
  },
  {
    id: 'thunderstorm',
    label: 'Thunderstorm in the second quarter',
    segments: [
      { from: -Infinity, state: state('overcast', { intensity: 0.5, tempC: 24, windMps: 4, windFromDeg: 210 }) },
      { from: 900, state: state('rain', { intensity: 0.5, tempC: 22, windMps: 8, windFromDeg: 210, visibilityM: 3000 }) },
      { from: 1800, state: state('thunderstorm', { intensity: 1, tempC: 19, windMps: 14, windFromDeg: 260, visibilityM: 800, lightning: true }) },
    ],
  },
  {
    id: 'snow',
    label: 'Late-season snow',
    segments: [
      { from: -Infinity, state: state('snow', { intensity: 0.35, tempC: -2, windMps: 5, windFromDeg: 320, visibilityM: 2500 }) },
      { from: -600, state: state('snow', { intensity: 0.75, tempC: -3, windMps: 8, windFromDeg: 320, visibilityM: 700 }) },
    ],
  },
  {
    id: 'fog',
    label: 'Dense river fog',
    segments: [
      { from: -Infinity, state: state('fog', { intensity: 0.8, tempC: 7, windMps: 1, visibilityM: 150 }) },
      { from: 1800, state: state('fog', { intensity: 0.5, tempC: 9, windMps: 2, visibilityM: 400 }) },
    ],
  },
  {
    id: 'heat',
    label: 'Early-season heat',
    segments: [{ from: -Infinity, state: state('heat', { intensity: 0.8, tempC: 33, windMps: 2, windFromDeg: 180 }) }],
  },
];

export const weatherTimeline = (id: string) => WEATHER_TIMELINES.find((w) => w.id === id) ?? WEATHER_TIMELINES[0]!;

/**
 * The sky at time t. A lightning delay always has lightning once it fires,
 * whatever scenario was picked: the incident IS the lightning, and the map
 * showing sunshine over a lightning delay would be a lie. The all-clear comes
 * 30 minutes after the strike.
 */
export const LIGHTNING_CLEAR_S = 30 * 60;

export function weatherAt(timeline: WeatherTimeline | undefined, t: SimSeconds, incident?: Incident): WeatherState {
  let current = CLEAR_SKY;
  for (const segment of timeline?.segments ?? []) {
    if (segment.from <= t) current = segment.state;
    else break;
  }
  const lightningNow =
    incident?.kind === 'lightning_delay' && t >= incident.at && t < incident.at + LIGHTNING_CLEAR_S;
  if (lightningNow && !current.lightning) {
    return {
      ...current,
      kind: 'thunderstorm',
      intensity: Math.max(current.intensity, 0.7),
      windMps: Math.max(current.windMps, 9),
      visibilityM: Math.min(current.visibilityM, 2000),
      lightning: true,
    };
  }
  return current;
}

/** Walking speed multiplier. Wet ground, snow and heat slow a crowd; exactly 1 when clear. */
export function walkFactor(w: WeatherState): number {
  switch (w.kind) {
    case 'rain':
      return 1 - 0.08 * w.intensity;
    case 'heavy_rain':
      // Research bands: heavy rain costs about 27% of free walking speed.
      return 1 - 0.27 * w.intensity;
    case 'thunderstorm':
      return 1 - 0.1 * w.intensity;
    case 'snow':
      // And snow about 20%, not the 30% first assumed.
      return 1 - 0.2 * w.intensity;
    case 'fog':
      return 1 - 0.04 * w.intensity;
    case 'heat':
      return 1 - 0.12 * w.intensity;
    default:
      return 1;
  }
}

/** Driving speed multiplier: rain and snow lengthen braking, fog caps speed to what you can see. */
export function driveFactor(w: WeatherState): number {
  const sight = Math.min(1, Math.max(0.35, w.visibilityM / 300));
  switch (w.kind) {
    case 'rain':
      return Math.min(sight, 1 - 0.2 * w.intensity);
    case 'heavy_rain':
      // About a 16% loss at full intensity, as measured, not 38%.
      return Math.min(sight, 1 - 0.16 * w.intensity);
    case 'thunderstorm':
      return Math.min(sight, 1 - 0.16 * w.intensity);
    case 'snow':
      return Math.min(sight, 1 - 0.5 * w.intensity);
    case 'fog':
      // Fog has a floor near -12%: drivers slow, they do not stop.
      return Math.min(1, Math.max(0.88, w.visibilityM / 1250));
    default:
      return 1;
  }
}

/**
 * The decision context only knows three skies. Snow reads as 'rain' (wet, cold,
 * people want cover); fog and heat read as 'clear' because they do not change
 * whether a fan heads for shelter.
 */
export function decisionWeather(w: WeatherState): DecisionContext['weather'] {
  if (w.lightning) return 'lightning';
  if (w.kind === 'rain' || w.kind === 'heavy_rain' || w.kind === 'thunderstorm' || w.kind === 'snow') return 'rain';
  return 'clear';
}

export const WEATHER_LABELS: Record<WeatherKind, string> = {
  clear: 'Clear',
  overcast: 'Overcast',
  rain: 'Rain',
  heavy_rain: 'Heavy rain',
  thunderstorm: 'Thunderstorm',
  snow: 'Snow',
  fog: 'Fog',
  heat: 'Heat',
};
