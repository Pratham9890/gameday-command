import { expect, it } from 'vitest';
import { CELL_SIZE_M, VEHICLE_KINDS, VEHICLE_STATES } from '../../contracts.ts';
import { makePopulation } from '../../brain/src/fan-types.ts';
import { GAME_END_S, gameEnd } from '../../world/src/incidents.ts';
import { buildStadiumMap, loadExtract } from '../../world/src/osm/stadium.ts';
import { CLEAR_SKY } from '../../world/src/weather.ts';
import { DensityField } from './density.ts';
import { DotStore } from './dots.ts';
import { TrafficModel } from './traffic.ts';

it('starts regular traffic parked and advances departures when fans return to their cars', () => {
  const map = buildStadiumMap(loadExtract());
  const startAt = GAME_END_S - 300;
  const traffic = new TrafficModel({ map, population: makePopulation(100_000, 20251023), incident: gameEnd(map),
    config: { vehicles: 1500, seed: 77, emergencyResponse: false }, startAt, endAt: GAME_END_S + 3600, gameEndAt: GAME_END_S });
  const before = traffic.frame();
  let parked = 0;
  const dots = new DotStore(before.x.length);
  for (let i = 0; i < before.x.length; i++) {
    if (VEHICLE_KINDS[before.kind[i]!] !== 'rideshare') {
      expect(VEHICLE_STATES[before.state[i]!], `vehicle ${i} ${VEHICLE_KINDS[before.kind[i]!]}`).toBe('parked');
      parked++;
    }
    dots.x[i] = before.x[i]!;
    dots.y[i] = before.y[i]!;
    dots.setState(i, 'gone');
  }
  expect(parked).toBeGreaterThan(1000);
  const density = DensityField.forMap(map);
  // The scheduled exodus starts six minutes after the whistle. Departures
  // before that must come from fans reaching the lots, not the timer.
  for (let t = GAME_END_S; t <= GAME_END_S + 180; t++) {
    traffic.step({ t, dt: 1, weather: CLEAR_SKY, density, dots, closed: new Set() });
  }
  const after = traffic.frame();
  let departed = 0;
  for (let i = 0; i < after.x.length; i++) {
    if (VEHICLE_KINDS[after.kind[i]!] === 'rideshare') continue;
    if (VEHICLE_STATES[after.state[i]!] !== 'parked') departed++;
    if (after.x[i]! >= 0) {
      const cell = Math.floor(after.y[i]! / CELL_SIZE_M) * map.width + Math.floor(after.x[i]! / CELL_SIZE_M);
      expect(map.cells[cell]).not.toBe('blocked');
    }
  }
  expect(departed).toBeGreaterThan(0);
});
