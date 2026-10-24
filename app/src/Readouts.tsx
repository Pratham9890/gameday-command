import type { TickFrame, WeatherState } from '../../contracts.ts';
import { VEHICLE_KINDS, VEHICLE_STATES } from '../../contracts.ts';
import { WEATHER_LABELS } from '../../world/src/weather.ts';

/** What one run's frame says about the sky and the traffic, for the chips over a map. */
export interface Readout {
  weather?: WeatherState;
  moving: number;
  stopped: number;
  parked: number;
  ems: string;
  hasVehicles: boolean;
}

const VS = Object.fromEntries(VEHICLE_STATES.map((s, i) => [s, i])) as Record<(typeof VEHICLE_STATES)[number], number>;
const AMBULANCE = VEHICLE_KINDS.indexOf('ambulance');

export function readoutOf(frame: TickFrame | undefined): Readout {
  const v = frame?.vehicles;
  let moving = 0;
  let stopped = 0;
  let parked = 0;
  let ems = '';
  if (v) {
    for (let i = 0; i < v.state.length; i++) {
      const s = v.state[i]!;
      if (s === VS.driving || s === VS.departing || s === VS.parking) moving++;
      else if (s === VS.stopped) stopped++;
      else if (s === VS.parked) parked++;
      if (v.kind[i] === AMBULANCE) {
        ems = s === VS.responding ? 'Ambulance en route' : s === VS.on_scene ? 'Ambulance on scene' : s === VS.stopped ? 'Ambulance blocked' : '';
      }
    }
  }
  return { weather: frame?.weather, moving, stopped, parked, ems, hasVehicles: !!v };
}

const WEATHER_ICON: Record<WeatherState['kind'], string> = {
  clear: '☀', overcast: '☁', rain: '🌧', heavy_rain: '🌧', thunderstorm: '⛈', snow: '❄', fog: '🌫', heat: '🌡',
};
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

const visibility = (m: number) => (m >= 5000 ? '5+ km' : m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);

export function ReadoutChips({ readout }: { readout: Readout }) {
  const { weather: w } = readout;
  return (
    <>
      {w && (
        <div className={`chip weather-chip wx-${w.kind}`}>
          <span className="wx-icon">{WEATHER_ICON[w.kind]}</span>
          <span>
            <strong>{WEATHER_LABELS[w.kind]}</strong>
            {w.lightning && <span className="strike"> · lightning</span>}
            <em>
              {Math.round(w.tempC)}°C · wind {Math.round(w.windMps * 2.237)} mph {COMPASS[Math.round(w.windFromDeg / 45) % 8]} · vis{' '}
              {visibility(w.visibilityM)}
            </em>
          </span>
        </div>
      )}
      {readout.hasVehicles && (
        <div className="chip traffic-chip">
          <span title="moving">
            <i className="dot moving" />
            {readout.moving.toLocaleString()} moving
          </span>
          <span title="stopped in traffic or for a crowd" className={readout.stopped > 40 ? 'hot' : undefined}>
            <i className="dot stopped" />
            {readout.stopped.toLocaleString()} stopped
          </span>
          <span title="parked">
            <i className="dot parked" />
            {readout.parked.toLocaleString()} parked
          </span>
          {readout.ems && <span className={`ems ${readout.ems.includes('blocked') ? 'hot' : ''}`}>🚑 {readout.ems}</span>}
        </div>
      )}
    </>
  );
}
