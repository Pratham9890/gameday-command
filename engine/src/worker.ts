import type { DensityGrid, TickFrame, WorkerIn, WorkerOut } from '../../contracts.ts';
import { CircleMovement } from './movement-circle.ts';
import { Simulation } from './sim.ts';

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

function sendFrame(frame: TickFrame, density: DensityGrid): void {
  send({ type: 'frame', frame, density }, [
    frame.x.buffer,
    frame.y.buffer,
    frame.state.buffer,
    frame.officerCells.buffer,
    density.peoplePerM2.buffer,
  ]);
}

function emitFrame(): void {
  if (!sim) return;
  sendFrame(sim.frame(), sim.ctx.density.toGrid(sim.ctx.t));
}

async function loop(): Promise<void> {
  if (looping || !sim) return;
  looping = true;
  try {
    let due = performance.now();
    let steps = 0;
    while (playing && sim && !sim.done) {
      await sim.step();
      if (sim.isFrameTime()) emitFrame();
      // speed is sim seconds per wall second; it caps the run, never rushes it.
      due += 1000 / Math.max(speed, 0.01);
      const wait = due - performance.now();
      if (wait > 2) await sleep(wait);
      else if (++steps % 64 === 0) await sleep(0);
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
          movement: new CircleMovement(),
          emit: send,
        });
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
        // Milestone 1 has no snapshot history yet; the app scrubs frames it kept.
        send({ type: 'error', message: `seek to ${message.t} is not wired until replay lands` });
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
