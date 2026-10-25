import { createHash } from 'node:crypto';
import { DECISION_DEFAULTS } from '../brain/src/defaults.ts';
import { makePopulation } from '../brain/src/fan-types.ts';
import { gateSurge } from '../world/src/incidents.ts';
import { makeOfficers } from '../world/src/officers.ts';
import { buildStadiumMap, loadExtract } from '../world/src/osm/stadium.ts';
import { playbookFor } from '../world/src/playbook.ts';
import { FlowMovement } from '../engine/src/movement-flow.ts';
import { Simulation } from '../engine/src/sim.ts';
import { MotionRecorder } from '../engine/src/motion.ts';

// Run from the repository root. Empty replay uses deterministic decision defaults.
// The fingerprint deliberately excludes traffic metrics: traffic only reads fans.
const map = buildStadiumMap(loadExtract());
const recordMotion = process.argv.includes('--motion');
for (const officers of [24, 60]) for (const traffic of [false, true]) {
  const config = {
    runId: 'police-baseline', label: 'A', seed: 20251023, startAt: -3600,
    endAt: 600, speed: 1000, dangerDensity: 4, mapId: map.id,
    incident: gateSurge(map, 0), plan: playbookFor('gate_surge', map)[0]!,
    officers: makeOfficers(map, officers),
    traffic: traffic ? { vehicles: 4500, seed: 77, emergencyResponse: true } : undefined,
  };
  const sim = new Simulation({config, map: structuredClone(map),
    population: makePopulation(100_000, config.seed), defaults: DECISION_DEFAULTS,
    serverUrl: '', movement: new FlowMovement(), replay: {runId: config.runId, answers: []}});
  const hash = createHash('sha256');
  const people = new MotionRecorder(3), vehicles = new MotionRecorder(), units = new MotionRecorder();
  let bytes = 0, packets = 0;
  const captureMotion = () => {
    people.capture(sim.ctx.t, sim.ctx.dots.x, sim.ctx.dots.y);
    const v = sim.traffic?.frame();
    if (v) vehicles.capture(sim.ctx.t, v.x, v.y, v.heading, v.speed);
    const o = sim.officerStatus();
    units.capture(sim.ctx.t, o.map(unit => unit.x), o.map(unit => unit.y));
    if (sim.isFrameTime()) {
      for (const r of [people, vehicles, units]) {
        const p = r.take(); bytes += p.offsets.byteLength + p.samples.byteLength;
      }
      packets++;
    }
  };
  if (recordMotion) captureMotion();
  const start = performance.now();
  while (!sim.done) {
    await sim.step();
    if (recordMotion) captureMotion();
    if (sim.ctx.t % 300 === 0) {
      const { x, y, state } = sim.ctx.dots;
      for (const a of [x, y, state]) hash.update(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
      hash.update(JSON.stringify(sim.gateStats()));
    }
  }
  const {vehicleDelayMin, peakVehiclesStopped, vehiclesOut, emergencyResponseMin, ...crowd} = sim.scorecard();
  void vehicleDelayMin; void peakVehiclesStopped; void vehiclesOut; void emergencyResponseMin;
  hash.update(JSON.stringify(crowd));
  console.log(JSON.stringify({officers, traffic, recordMotion, sha256: hash.digest('hex'),
    msPerSimSecond: (performance.now() - start) / (config.endAt - config.startAt),
    motionBytesPerFrame: packets ? Math.round(bytes / packets) : 0,
    trafficMetrics: sim.traffic?.metrics()}));
}
