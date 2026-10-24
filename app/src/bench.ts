/**
 * Requirement 3, measured where it actually has to hold: 20,000 dots in one
 * real browser Web Worker, with a warm decision cache.
 *
 * Deliberately has no PixiJS in it. Pixi's startup probe compiles shaders in a
 * loop to find the GPU's `if` limit, which is fine on real hardware and
 * pathologically slow under software GL — so a page that renders would measure
 * the renderer rather than the engine.
 */
import type { DecisionDefaults, MapBundle, Scorecard, SimConfig, Snapshot, WorkerIn, WorkerOut } from '../../contracts.ts';
import { CONTRACT_VERSION, DEFAULT_DANGER_DENSITY, DOT_GROUP_SIZE } from '../../contracts.ts';
import { makePopulation } from '../../brain/src/fan-types.ts';
import { makeOfficers } from '../../world/src/officers.ts';
import { gateSurge, windowFor } from '../../world/src/incidents.ts';
import { playbookFor } from '../../world/src/playbook.ts';

const out = document.getElementById('out')!;
const lines: string[] = [];
const log = (line: string) => {
  lines.push(line);
  out.textContent = lines.join('\n');
  console.log(line);
};

/** Exposed so the harness driving this page can read the result. */
declare global {
  interface Window {
    benchResult?: Record<string, unknown>;
  }
}

async function run(label: string, fans: number): Promise<Record<string, unknown>> {
  const map = (await (await fetch('/api/maps/default')).json()) as MapBundle;
  const defaults = (await (await fetch('/api/decision-defaults')).json()) as DecisionDefaults;
  const population = makePopulation(fans, 20251023);
  const incident = gateSurge(map, 0);
  const window_ = windowFor(incident);
  const plan = playbookFor('gate_surge', map)[0]!;

  const config: SimConfig = {
    runId: `bench-${label}`,
    label: 'A',
    seed: 20251023,
    startAt: window_.startAt,
    endAt: window_.endAt,
    // Very high: pacing must never be what limits the measurement.
    speed: 1_000_000,
    dangerDensity: DEFAULT_DANGER_DENSITY,
    mapId: map.id,
    incident,
    plan,
    officers: makeOfficers(map, 24),
  };

  log(`${label}: ${map.name}, ${fans.toLocaleString()} fans as ${population.dots.toLocaleString()} dots`);

  const worker = new Worker(new URL('../../engine/src/worker.ts', import.meta.url), { type: 'module' });
  const sources = { kev: 0, cache: 0, default: 0 };
  let frames = 0;
  let pauses = 0;
  let keys = 0;
  let pausedMs = 0;
  let decidingAt = 0;

  let snapshot: Snapshot | null = null;
  let askedForSnapshot = false;
  let seekFrameT: number | null = null;
  let seekError: string | null = null;
  let seeking = false;
  let resolveSeek: (() => void) | null = null;

  const done = new Promise<Scorecard>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<WorkerOut>) => {
      const message = event.data;
      if (message.type === 'frame') {
        frames++;
        if (seeking) {
          seekFrameT = message.frame.t;
          resolveSeek?.();
        }
        // Part way in, ask the worker for a snapshot: the contract's restart
        // point has to come out of the worker itself, not just the engine
        // module under Node.
        if (frames === 20 && !askedForSnapshot) {
          askedForSnapshot = true;
          worker.postMessage({ type: 'snapshot' } satisfies WorkerIn);
        }
      } else if (message.type === 'snapshot') {
        snapshot = message.snapshot;
      } else if (message.type === 'error' && seeking) {
        seekError = message.message;
        resolveSeek?.();
      }
      else if (message.type === 'deciding') {
        pauses++;
        keys += message.pendingKeys;
        decidingAt = performance.now();
      } else if (message.type === 'decision') {
        sources[message.record.source]++;
        if (decidingAt) {
          pausedMs += performance.now() - decidingAt;
          decidingAt = 0;
        }
      } else if (message.type === 'done') resolve(message.scorecard);
      else if (message.type === 'error') reject(new Error(message.message));
    };
  });

  const started = performance.now();
  worker.postMessage({
    type: 'init',
    config,
    map,
    population,
    defaults,
    serverUrl: '',
  } satisfies WorkerIn);
  worker.postMessage({ type: 'play' } satisfies WorkerIn);

  const card = await done;
  const wallSeconds = (performance.now() - started) / 1000;
  worker.terminate();

  // Rewind through the worker: a seek has to restore a checkpoint and step
  // forward, which is the contract's restore path exercised across the worker
  // boundary rather than only inside the engine module.
  const seekTarget = Math.round(config.startAt + (config.endAt - config.startAt) * 0.25);
  const seekWorker = new Worker(new URL('../../engine/src/worker.ts', import.meta.url), { type: 'module' });
  let seekResult: Record<string, unknown> = { ok: false, reason: 'seek never answered' };
  try {
    await new Promise<void>((resolve) => {
      let ready = false;
      let framesSeen = 0;
      seekWorker.onmessage = (event: MessageEvent<WorkerOut>) => {
        const m = event.data;
        if (m.type === 'ready') ready = true;
        else if (m.type === 'frame') {
          framesSeen++;
          if (seeking) {
            // Frames emitted before the pause are still arriving; the one we
            // want is the frame the seek itself produced, at the moment asked
            // for. Anything earlier is in-flight traffic, not an answer.
            if (m.frame.t >= seekTarget - 1) {
              seekFrameT = m.frame.t;
              resolve();
            }
          } else if (ready && framesSeen > 30) {
            // far enough in to have banked a checkpoint or two
            seekWorker.postMessage({ type: 'pause' } satisfies WorkerIn);
            seeking = true;
            seekWorker.postMessage({ type: 'seek', t: seekTarget } satisfies WorkerIn);
          }
        } else if (m.type === 'error' && seeking) {
          seekError = m.message;
          resolve();
        }
      };
      resolveSeek = resolve;
      seekWorker.postMessage({ type: 'init', config, map, population, defaults, serverUrl: '' } satisfies WorkerIn);
      seekWorker.postMessage({ type: 'play' } satisfies WorkerIn);
      setTimeout(resolve, 60_000);
    });
    seekResult = seekError
      ? { ok: false, error: seekError }
      : {
          // The sought frame must land on the moment asked for, not merely
          // somewhere earlier in the run.
          ok: seekFrameT !== null && Math.abs(seekFrameT - seekTarget) <= 1,
          askedFor: seekTarget,
          cameBackAt: seekFrameT,
        };
  } finally {
    seekWorker.terminate();
  }

  const snap = snapshot as Snapshot | null;
  const snapshotCheck = snap
    ? {
        ok:
          snap.version === CONTRACT_VERSION &&
          Number.isFinite(snap.t) &&
          snap.rngState.length === 4 &&
          snap.dots.x.length === population.dots &&
          snap.dots.y.length === population.dots &&
          snap.dots.state.length === population.dots &&
          snap.dots.typeIndex.length === population.dots &&
          snap.dots.targetPlace.length === population.dots &&
          Array.isArray(snap.officers) &&
          snap.officers.length > 0,
        t: snap.t,
        rngState: snap.rngState.length,
        dots: snap.dots.x.length,
        officers: snap.officers.length,
        closed: snap.closed.length,
      }
    : { ok: false, reason: 'no snapshot came back from the worker' };

  const simSeconds = config.endAt - config.startAt;
  const ratio = simSeconds / wallSeconds;
  const result = {
    label,
    dots: population.dots,
    fans,
    simSeconds,
    wallSeconds: Number(wallSeconds.toFixed(2)),
    timesRealTime: Number(ratio.toFixed(1)),
    frames,
    pauses,
    keys,
    pausedSeconds: Number((pausedMs / 1000).toFixed(2)),
    sources,
    peakDensity: card.peakDensity,
    fallbackDecisions: card.fallbackDecisions,
    snapshot: snapshotCheck,
    seek: seekResult,
  };

  log(
    `${label}: ${simSeconds} sim s in ${wallSeconds.toFixed(1)}s = ${ratio.toFixed(1)}x real time ` +
      `(${frames} frames, ${pauses} pause(s) over ${keys} keys costing ${(pausedMs / 1000).toFixed(1)}s)`,
  );
  log(`${label}: decisions ${JSON.stringify(sources)}, peak ${card.peakDensity.toFixed(2)}/m², fallbacks ${card.fallbackDecisions}`);
  log(`${label}: worker snapshot ${JSON.stringify(snapshotCheck)}`);
  log(`${label}: worker seek ${JSON.stringify(seekResult)}`);
  return result;
}

(async () => {
  try {
    // First pass warms the server's decision cache; the second is the measurement.
    const warm = await run('warm-up pass', 100_000);
    const measured = await run('measured (warm cache)', 100_000);
    window.benchResult = {
      warm,
      measured,
      dotGroupSize: DOT_GROUP_SIZE,
      ok:
        (measured.timesRealTime as number) >= 10 &&
        (measured.snapshot as { ok: boolean }).ok &&
        (measured.seek as { ok: boolean }).ok,
    };
    log(`\nRESULT: ${(measured.timesRealTime as number) >= 10 ? 'PASS' : 'FAIL'} — requirement 3 wants 10x or faster.`);
  } catch (error) {
    log(`bench failed: ${error instanceof Error ? error.message : String(error)}`);
    window.benchResult = { error: String(error) };
  }
})();
