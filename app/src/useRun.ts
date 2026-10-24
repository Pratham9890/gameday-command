import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  DecisionDefaults,
  Snapshot,
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
import type { DotInfo, EditIn, EditOut, SceneInfo } from '../../engine/src/edits.ts';

export interface RunSnapshotView {
  frame: TickFrame;
  density?: DensityGrid;
  /** Wall clock it arrived, for gliding from the frame before it. */
  at?: number;
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
  /** The worker's own restart point, requested when its run ends. */
  snapshotAt: number | null;
  snapshotDots: number | null;
  error: string | null;
  /** Bumps on every frame so the canvas redraws without putting frames in state. */
  tick: number;
}

export interface RunHandle extends RunState {
  latest: React.RefObject<RunSnapshotView | null>;
  /** The frame before `latest`, so the map can move smoothly between the two. */
  previous: React.RefObject<RunSnapshotView | null>;
  frames: React.RefObject<RunSnapshotView[]>;
  /** Last decision per dot, for the dot detail panel. */
  decisionsByDot: React.RefObject<Map<number, DecisionRecord>>;
  recent: React.RefObject<DecisionRecord[]>;
  /** Every dot's fan type, as the worker last reported it. */
  typeIndex: React.RefObject<Uint16Array | null>;
  /** Officers and closures as of the latest frame. */
  scene: React.RefObject<SceneInfo | null>;
  /** Every alert this run has sent, in order, with the dots each reached. */
  alerts: React.RefObject<{ t: number; dots: Int32Array }[]>;
  /** The worker's answer to the last `inspect`. */
  inspected: DotInfo | null;
  send: (message: WorkerIn | EditIn) => void;
  /** Rewind this plan's worker to a moment and drop the frames after it. */
  seekTo: (t: number) => void;
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
  const previous = useRef<RunSnapshotView | null>(null);
  const frames = useRef<RunSnapshotView[]>([]);
  const decisionsByDot = useRef<Map<number, DecisionRecord>>(new Map());
  const recent = useRef<DecisionRecord[]>([]);
  const counts = useRef({ decisions: 0, fallbacks: 0, kev: 0 });
  const typeIndex = useRef<Uint16Array | null>(null);
  const scene = useRef<SceneInfo | null>(null);
  const alerts = useRef<{ t: number; dots: Int32Array }[]>([]);
  const [inspected, setInspected] = useState<DotInfo | null>(null);

  const [state, setState] = useState<RunState>({
    ready: false,
    t: 0,
    deciding: null,
    decisionCount: 0,
    fallbackCount: 0,
    kevCount: 0,
    frameCount: 0,
    scorecard: null,
    snapshotAt: null,
    snapshotDots: null,
    error: null,
    tick: 0,
  });

  useEffect(() => {
    if (!init) return;
    const worker = new Worker(new URL('../../engine/src/worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;
    latest.current = null;
    previous.current = null;
    frames.current = [];
    decisionsByDot.current = new Map();
    recent.current = [];
    counts.current = { decisions: 0, fallbacks: 0, kev: 0 };
    typeIndex.current = null;
    scene.current = null;
    alerts.current = [];
    setInspected(null);
    // A new run starts from nothing. Without this the last run's scorecard
    // survived a restart or a new situation, so the screen read "Finished"
    // before the new run had taken a step.
    setState({
      ready: false,
      t: init.config.startAt,
      deciding: null,
      decisionCount: 0,
      fallbackCount: 0,
      kevCount: 0,
      frameCount: 0,
      scorecard: null,
      snapshotAt: null,
      snapshotDots: null,
      error: null,
      tick: 0,
    });

    worker.onmessage = (event: MessageEvent<WorkerOut | EditOut>) => {
      const out = event.data;
      switch (out.type) {
        case 'types':
          typeIndex.current = out.typeIndex;
          return;
        case 'scene':
          scene.current = out.scene;
          if (out.scene.alerts.length > 0) alerts.current = [...alerts.current, ...out.scene.alerts];
          return;
        case 'inspect':
          setInspected(out.info);
          return;
        case 'ready':
          setState((s) => ({ ...s, ready: true, error: null }));
          return;
        case 'frame': {
          const view: RunSnapshotView = { frame: out.frame, density: out.density, at: performance.now() };
          // A frame from before the current one is a rewind: do not glide backwards.
          previous.current = latest.current && latest.current.frame.t < view.frame.t ? latest.current : null;
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
        case 'snapshot': {
          const snap = out.snapshot as Snapshot;
          setState((s) => ({ ...s, snapshotAt: snap.t, snapshotDots: snap.dots.x.length }));
          return;
        }
        case 'done':
          // Each plan's own worker hands back a restart point as it finishes,
          // so the contract's snapshot is exercised per plan and not only in
          // the bench harness.
          worker.postMessage({ type: 'snapshot' } satisfies WorkerIn);
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

  const send = useCallback((message: WorkerIn | EditIn) => workerRef.current?.postMessage(message), []);

  /**
   * Ask the worker to rewind. It restores its nearest checkpoint and steps
   * forward, so the engine itself goes back — this is not the app redrawing an
   * old frame. Frames after the target are dropped so the scrubber and the
   * running simulation agree about where the run is.
   */
  const seekTo = useCallback((target: number) => {
    frames.current = frames.current.filter((f) => f.frame.t <= target);
    alerts.current = alerts.current.filter((a) => a.t <= target);
    workerRef.current?.postMessage({ type: 'seek', t: target } satisfies WorkerIn);
    setState((s) => ({ ...s, scorecard: null, frameCount: frames.current.length }));
  }, []);

  return { ...state, latest, previous, frames, decisionsByDot, recent, typeIndex, scene, alerts, inspected, send, seekTo };
}
