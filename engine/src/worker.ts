import type { DensityGrid, TickFrame, WorkerIn, WorkerOut } from '../../contracts.ts';
import { FlowMovement } from './movement-flow.ts';
import { Simulation, type Checkpoint } from './sim.ts';
import { FRAME_EVERY_S } from '../../contracts.ts';

/**
 * Worker entry: one worker per plan, so three plans run in three isolated
 * workers on the same seed. Typed here rather than via the WebWorker lib —
 * TypeScript refuses to load the DOM and WebWorker libs together, and the app
 * needs DOM.
 */
const host = globalThis as unknown as {
  postMessage(message: WorkerOut, transfer?: Transferable[]): void;
  onmessage: ((event: { data: WorkerIn }) => void) | null;
};

const send = (message: WorkerOut, transfer?: Transferable[]) => host.postMessage(message, transfer);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let sim: Simulation | null = null;
let playing = false;
let speed = 1;
let looping = false;

/**
 * Restart points kept as the run goes, so the commander can scrub backwards.
 *
 * One every CHECKPOINT_EVERY_S of sim time: stepping forward from the nearest
 * one is quick, and keeping them sparse keeps the memory sane — each holds a
 * copy of every dot. Seeking rewinds to the closest point at or before the
 * target and steps on from there, which lands on exactly the state the run had,
 * because the seeded RNG, the movement state and the scorer all come back too.
 */
const CHECKPOINT_EVERY_S = FRAME_EVERY_S * 8;
let checkpoints: { t: number; point: Checkpoint }[] = [];
let lastCheckpointAt = Number.NEGATIVE_INFINITY;

function maybeCheckpoint(): void {
  if (!sim) return;
  if (sim.ctx.t - lastCheckpointAt < CHECKPOINT_EVERY_S) return;
  lastCheckpointAt = sim.ctx.t;
  checkpoints.push({ t: sim.ctx.t, point: sim.checkpoint() });
}

function sendFrame(frame: TickFrame, density: DensityGrid): void {
  const transfer: Transferable[] = [
    frame.x.buffer,
    frame.y.buffer,
    frame.state.buffer,
    frame.officerCells.buffer,
    density.peoplePerM2.buffer,
  ];
  const v = frame.vehicles;
  if (v) transfer.push(v.x.buffer, v.y.buffer, v.heading.buffer, v.speed.buffer, v.kind.buffer, v.state.buffer, v.waitedS.buffer);
  send({ type: 'frame', frame, density }, transfer);
}

function emitFrame(): void {
  if (!sim) return;
  sendFrame(sim.frame(), sim.ctx.density.toGrid(sim.ctx.t));
}

/**
 * Steps run between yields while catching up. Bounds how long the worker can go
 * without reading its inbox, so pause, speed and seek stay responsive.
 */
const MAX_CATCHUP_STEPS = 240;

/**
 * Pacing debt we are willing to make up. A tab the browser suspends outright
 * comes back owing the whole gap; past this we give up on it rather than run
 * flat out for minutes to settle a debt nobody watched accrue.
 */
const MAX_DEBT_MS = 2000;

async function loop(): Promise<void> {
  if (looping || !sim) return;
  looping = true;
  try {
    // `due` is the wall clock the next sim second is owed at. We step until the
    // clock has caught up, then sleep once -- NOT once per sim second, which is
    // what this used to do. A browser that clamps timers (Safari holds
    // setTimeout to ~1 s in a tab that is not frontmost, workers included) made
    // each of those per-step sleeps a full second, pacing a 90 minute run at
    // roughly real time however high `speed` was set. Sleeping once per batch
    // and then making up every step the clock owes is immune to the clamp: a
    // coarser timer means fewer, bigger batches, not a slower run.
    let due = performance.now();
    while (playing && sim && !sim.done) {
      // speed is sim seconds per wall second; it caps the run, never rushes it.
      const perStep = 1000 / Math.max(speed, 0.01);
      if (performance.now() - due > MAX_DEBT_MS) due = performance.now();

      let ran = 0;
      while (playing && sim && !sim.done && ran < MAX_CATCHUP_STEPS && performance.now() >= due) {
        await sim.step();
        if (sim.isFrameTime()) {
          maybeCheckpoint();
          emitFrame();
        }
        due += perStep;
        ran++;
      }
      if (!playing || !sim || sim.done) break;

      const wait = due - performance.now();
      await sleep(wait > 2 ? wait : 0);
    }
    if (sim?.done) {
      emitFrame();
      send({ type: 'tape', tape: sim.tape() });
      send({ type: 'done', scorecard: sim.scorecard() });
      playing = false;
    }
  } finally {
    looping = false;
  }
}

host.onmessage = (event) => {
  const message = event.data;
  try {
    switch (message.type) {
      case 'init': {
        speed = message.config.speed;
        sim = new Simulation({
          config: message.config,
          map: message.map,
          population: message.population,
          defaults: message.defaults,
          serverUrl: message.serverUrl,
          replay: message.replay,
          movement: new FlowMovement(),
          emit: send,
        });
        checkpoints = [];
        lastCheckpointAt = Number.NEGATIVE_INFINITY;
        maybeCheckpoint();
        send({ type: 'ready', runId: message.config.runId });
        emitFrame();
        return;
      }
      case 'play':
        playing = true;
        void loop();
        return;
      case 'pause':
        playing = false;
        return;
      case 'speed':
        speed = message.speed;
        return;
      case 'seek': {
        if (!sim) return;
        const target = message.t;
        // Nearest restart point at or before the target.
        let best: { t: number; point: Checkpoint } | null = null;
        for (const entry of checkpoints) {
          if (entry.t <= target && (!best || entry.t > best.t)) best = entry;
        }
        if (!best) {
          send({ type: 'error', message: `no restart point at or before ${target}` });
          return;
        }
        playing = false;
        sim.rewind(best.point);
        // Step forward to the moment asked for. Decisions on the way come from
        // the client's cache or its tape, so this repeats rather than re-asks.
        void (async () => {
          while (sim && sim.ctx.t < target && !sim.done) await sim.step();
          emitFrame();
        })();
        return;
      }
      case 'snapshot':
        if (sim) send({ type: 'snapshot', snapshot: sim.snapshot() });
        return;
    }
  } catch (error) {
    send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
