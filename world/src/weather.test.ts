import { describe, expect, it } from 'vitest';
import type { SimConfig } from '../../contracts.ts';
import { DECISION_DEFAULTS } from '../../brain/src/defaults.ts';
import { makePopulation } from '../../brain/src/fan-types.ts';
import { FlowMovement } from '../../engine/src/movement-flow.ts';
import { Simulation } from '../../engine/src/sim.ts';
import { lightningDelay, testGateSurge } from './incidents.ts';
import { makeOfficers } from './officers.ts';
import { playbookFor } from './playbook.ts';
import { makeTestMap } from './test-map.ts';
import { CLEAR_SKY, decisionWeather, driveFactor, walkFactor, weatherAt, weatherTimeline, WEATHER_TIMELINES } from './weather.ts';

const map = makeTestMap();

function sim(weather?: SimConfig['weather']) {
  const config: SimConfig = {
    runId: 'wx',
    label: 'A',
    seed: 99,
    startAt: -900,
    endAt: -300,
    speed: 1000,
    dangerDensity: 4,
    mapId: map.id,
    incident: testGateSurge(map, 0),
    plan: playbookFor('gate_surge', map)[0]!,
    officers: makeOfficers(map, 6),
    weather,
  };
  return new Simulation({
    config,
    map,
    population: makePopulation(1200, 99),
    defaults: DECISION_DEFAULTS,
    serverUrl: '',
    movement: new FlowMovement(),
    replay: { runId: 'wx', answers: [] },
  });
}

async function finish(s: Simulation) {
  while (!s.done) await s.step();
  return s;
}

describe('weather', () => {
  it('leaves a clear day exactly as v1 ran it', async () => {
    expect(walkFactor(CLEAR_SKY)).toBe(1);
    expect(driveFactor(CLEAR_SKY)).toBe(1);
    expect(decisionWeather(CLEAR_SKY)).toBe('clear');
    const none = await finish(sim());
    const clear = await finish(sim(weatherTimeline('clear')));
    expect(clear.frame().x).toEqual(none.frame().x);
    expect(clear.scorecard()).toEqual(none.scorecard());
  });

  it('slows the crowd in heavy rain and snow', async () => {
    const clear = await finish(sim(weatherTimeline('clear')));
    const snow = await finish(sim(weatherTimeline('snow')));
    // Same seed, same crowd, slower feet: the frames must differ.
    expect(snow.frame().x).not.toEqual(clear.frame().x);
    expect(walkFactor(weatherAt(weatherTimeline('rain-at-kickoff'), 60))).toBeLessThan(1);
    // Research coefficients: heavy rain costs 27% of walking speed, snow 20%,
    // and fog has a driving floor near -12% (old: fog < 0.6).
    expect(walkFactor(weatherAt(weatherTimeline('rain-at-kickoff'), 60))).toBeCloseTo(0.757, 3);
    expect(walkFactor(weatherAt(weatherTimeline('snow'), 0))).toBeCloseTo(0.85, 3);
    const fogDrive = driveFactor(weatherAt(weatherTimeline('fog'), 0));
    expect(fogDrive).toBeCloseTo(0.88, 3);
    expect(fogDrive).toBeGreaterThan(0.8);
    expect(fogDrive).toBeLessThan(0.95);
  });

  it('follows the timeline and puts lightning over a lightning delay', () => {
    const storm = weatherTimeline('thunderstorm');
    expect(weatherAt(storm, 0).lightning).toBe(false);
    expect(weatherAt(storm, 1800).lightning).toBe(true);
    const incident = lightningDelay(map, 600);
    expect(weatherAt(weatherTimeline('clear'), 599, incident).lightning).toBe(false);
    const after = weatherAt(weatherTimeline('clear'), 600, incident);
    expect(after.lightning).toBe(true);
    expect(decisionWeather(after)).toBe('lightning');
    // The all-clear comes 30 minutes after the strike.
    const cleared = weatherAt(weatherTimeline('clear'), 600 + 30 * 60, incident);
    expect(cleared.lightning).toBe(false);
    expect(decisionWeather(cleared)).toBe('clear');
  });

  it('maps every scenario onto the three skies a decision knows', () => {
    for (const timeline of WEATHER_TIMELINES) {
      for (const segment of timeline.segments) {
        expect(['clear', 'rain', 'lightning']).toContain(decisionWeather(segment.state));
      }
    }
  });
});
