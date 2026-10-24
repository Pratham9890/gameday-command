import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  DecisionDefaults,
  DecisionRecord,
  DensityGrid,
  MapBundle,
  Population,
  Scorecard,
  SimConfig,
  TickFrame,
  WorkerIn,
  WorkerOut,
} from '../../contracts.ts';

export interface RunSnapshotView {
  frame: TickFrame;
  density?: DensityGrid;
}

export interface RunState {
  ready: boolean;
  t: number;
  /** Pending decision keys while sim time is stopped waiting on Kev. */
  deciding: number | null;
  decisions: DecisionRecord[];
  scorecard: Scorecard | null;
  error: string | null;
  /** Bumps on every frame so the canvas redraws without putting frames in state. */
  tick: number;
}

export interface RunHandle extends RunState {
  latest: React.RefObject<RunSnapshotView | null>;
  frames: React.RefObject<RunSnapshotView[]>;
  send: (message: WorkerIn) => void;
}

export interface RunInit {
  config: SimConfig;
  map: MapBundle;
  population: Population;
  defaults: DecisionDefaults;
}

const MAX_KEPT_DECISIONS = 300;

/**
 * One Web Worker per run. Frames land in refs rather than React state: a frame
 * carries five typed arrays and re-rendering the tree for each one would cost
 * more than drawing it.
 */
export function useRun(init: RunInit | null): RunHandle {
  const workerRef = useRef<Worker | null>(null);
  const latest = useRef<RunSnapshotView | null>(null);
  const frames = useRef<RunSnapshotView[]>([]);
  const [state, setState] = useState<RunState>({
    ready: false,
    t: 0,
    deciding: null,
    decisions: [],
    scorecard: null,
    error: null,
    tick: 0,
  });

  useEffect(() => {
    if (!init) return;
    const worker = new Worker(new URL('../../engine/src/worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;
    latest.current = null;
    frames.current = [];

    worker.onmessage = (event: MessageEvent<WorkerOut>) => {
      const out = event.data;
      switch (out.type) {
        case 'ready':
          setState((s) => ({ ...s, ready: true, error: null }));
          return;
        case 'frame': {
          const view: RunSnapshotView = { frame: out.frame, density: out.density };
          latest.current = view;
          frames.current.push(view);
          setState((s) => ({ ...s, t: out.frame.t, deciding: null, tick: s.tick + 1 }));
          return;
        }
        case 'deciding':
          setState((s) => ({ ...s, deciding: out.pendingKeys }));
          return;
        case 'decision':
          setState((s) => ({
            ...s,
            decisions: [out.record, ...s.decisions].slice(0, MAX_KEPT_DECISIONS),
          }));
          return;
        case 'done':
          setState((s) => ({ ...s, scorecard: out.scorecard, deciding: null }));
          return;
        case 'error':
          setState((s) => ({ ...s, error: out.message }));
          return;
        default:
          return;
      }
    };

    worker.postMessage({
      type: 'init',
      config: init.config,
      map: init.map,
      population: init.population,
      defaults: init.defaults,
      serverUrl: '',
    } satisfies WorkerIn);

    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, [init]);

  const send = useCallback((message: WorkerIn) => workerRef.current?.postMessage(message), []);

  return { ...state, latest, frames, send };
}
