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
  decisionCount: number;
  fallbackCount: number;
  kevCount: number;
  frameCount: number;
  scorecard: Scorecard | null;
  error: string | null;
  /** Bumps on every frame so the canvas redraws without putting frames in state. */
  tick: number;
}

export interface RunHandle extends RunState {
  latest: React.RefObject<RunSnapshotView | null>;
  frames: React.RefObject<RunSnapshotView[]>;
  /** Last decision per dot, for the dot detail panel. */
  decisionsByDot: React.RefObject<Map<number, DecisionRecord>>;
  recent: React.RefObject<DecisionRecord[]>;
  send: (message: WorkerIn) => void;
}

export interface RunInit {
  config: SimConfig;
  map: MapBundle;
  population: Population;
  defaults: DecisionDefaults;
}

const RECENT_DECISIONS = 12;

/**
 * One Web Worker per run. Frames and decision records land in refs rather than
 * React state: a frame carries five typed arrays and a lightning delay emits
 * tens of thousands of records, so re-rendering the tree for each one would
 * cost far more than drawing it.
 */
export function useRun(init: RunInit | null): RunHandle {
  const workerRef = useRef<Worker | null>(null);
  const latest = useRef<RunSnapshotView | null>(null);
  const frames = useRef<RunSnapshotView[]>([]);
  const decisionsByDot = useRef<Map<number, DecisionRecord>>(new Map());
  const recent = useRef<DecisionRecord[]>([]);
  const counts = useRef({ decisions: 0, fallbacks: 0, kev: 0 });

  const [state, setState] = useState<RunState>({
    ready: false,
    t: 0,
    deciding: null,
    decisionCount: 0,
    fallbackCount: 0,
    kevCount: 0,
    frameCount: 0,
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
    decisionsByDot.current = new Map();
    recent.current = [];
    counts.current = { decisions: 0, fallbacks: 0, kev: 0 };

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
          setState((s) => ({
            ...s,
            t: out.frame.t,
            deciding: null,
            tick: s.tick + 1,
            frameCount: frames.current.length,
            decisionCount: counts.current.decisions,
            fallbackCount: counts.current.fallbacks,
            kevCount: counts.current.kev,
          }));
          return;
        }
        case 'deciding':
          setState((s) => ({ ...s, deciding: out.pendingKeys }));
          return;
        case 'decision': {
          // Counted in a ref and surfaced on the next frame: a lightning delay
          // raises tens of thousands of these in a single step.
          const record = out.record;
          decisionsByDot.current.set(record.dot, record);
          counts.current.decisions++;
          if (record.source === 'default') counts.current.fallbacks++;
          if (record.source === 'kev') counts.current.kev++;
          if (recent.current[0]?.key !== record.key) {
            recent.current = [record, ...recent.current].slice(0, RECENT_DECISIONS);
          }
          return;
        }
        case 'done':
          setState((s) => ({
            ...s,
            scorecard: out.scorecard,
            deciding: null,
            decisionCount: counts.current.decisions,
            fallbackCount: counts.current.fallbacks,
            kevCount: counts.current.kev,
          }));
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

  return { ...state, latest, frames, decisionsByDot, recent, send };
}
