import type {
  DecisionAsk,
  DecisionContext,
  DecisionDefaults,
  DecisionTape,
  Id,
  MapBundle,
  Officer,
  Population,
  Scorecard,
  SimConfig,
  SimSeconds,
  SituationId,
  Snapshot,
  TickFrame,
  WorkerOut,
  WorldActions,
  WorldView,
} from '../../contracts.ts';
import { CELL_SIZE_M, CONTRACT_VERSION, FRAME_EVERY_S, decisionKey } from '../../contracts.ts';
import { DecisionClient } from '../../brain/src/client.ts';
import { sampleOdds } from '../../brain/src/sample.ts';
import { Scorer } from '../../world/src/scoring.ts';
import { createWorldHooks, type WorldRuntime } from '../../world/src/hooks.ts';
import { DensityField } from './density.ts';
import { DotStore, STATE_INDEX } from './dots.ts';
import { Rng } from './rng.ts';

/** One sim second per step. Coarse enough for 10x real time, fine enough for 2 m cells. */
export const SIM_DT: SimSeconds = 1;

export interface SimContext {
  readonly map: MapBundle;
  readonly population: Population;
  readonly dots: DotStore;
  readonly rng: Rng;
  readonly density: DensityField;
  readonly officers: Officer[];
  readonly closed: Set<Id>;
  /** Redirects set by a plan: place index -> place index. */
  readonly redirects: Map<number, number>;
  t: SimSeconds;
}

export interface MovementModel {
  spawn(ctx: SimContext): void;
  step(ctx: SimContext, dt: SimSeconds): void;
  /** A dot just chose an option; the model may retarget it. */
  onChoice?(ctx: SimContext, dot: number, situation: SituationId, option: string): void;
}

interface RaisedSituation {
  situation: SituationId;
  cells?: number[];
  reachShare?: number;
}

export interface SimulationOptions {
  config: SimConfig;
  map: MapBundle;
  population: Population;
  defaults: DecisionDefaults;
  serverUrl: string;
  movement: MovementModel;
  replay?: DecisionTape;
  emit?: (out: WorkerOut) => void;
  client?: DecisionClient;
}

const GONE = STATE_INDEX.gone;

export class Simulation {
  readonly ctx: SimContext;
  private readonly hooks: WorldRuntime;
  private readonly scorer: Scorer;
  private readonly client: DecisionClient;
  private readonly emit: (out: WorkerOut) => void;
  private readonly officerTargets = new Map<Id, number>();
  private readonly officerPos = new Map<Id, { x: number; y: number }>();
  private readonly alerted: Uint8Array;
  private raised: RaisedSituation[] = [];
  private finished = false;

  private readonly opts: SimulationOptions;

  constructor(opts: SimulationOptions) {
    this.opts = opts;
    const { config, map, population } = opts;
    this.emit = opts.emit ?? (() => {});
    const dots = new DotStore(population.dots);
    this.ctx = {
      map,
      population,
      dots,
      rng: new Rng(config.seed),
      density: DensityField.forMap(map),
      officers: config.officers.map((o) => ({ ...o })),
      closed: new Set<Id>(),
      redirects: new Map<number, number>(),
      t: config.startAt,
    };
    this.alerted = new Uint8Array(population.dots);
    for (const officer of this.ctx.officers) {
      this.officerPos.set(officer.id, this.cellCenter(officer.cell));
    }
    this.hooks = createWorldHooks(config.incident, config.plan);
    this.scorer = new Scorer({
      runId: config.runId,
      planId: config.plan.id,
      label: config.label,
      incident: config.incident,
      dangerDensity: config.dangerDensity,
      totalDots: population.dots,
    });
    this.client =
      opts.client ??
      new DecisionClient(config.runId, {
        serverUrl: opts.serverUrl,
        defaults: opts.defaults,
        replay: opts.replay,
      });

    opts.movement.spawn(this.ctx);
    this.ctx.density.update(dots);
  }

  private cellCenter(cell: number): { x: number; y: number } {
    const width = this.ctx?.map.width ?? this.opts.map.width;
    return {
      x: ((cell % width) + 0.5) * CELL_SIZE_M,
      y: (Math.floor(cell / width) + 0.5) * CELL_SIZE_M,
    };
  }

  private cellOfDot(i: number): number {
    const { dots, map } = this.ctx;
    const cx = (dots.x[i]! / CELL_SIZE_M) | 0;
    const cy = (dots.y[i]! / CELL_SIZE_M) | 0;
    if (cx < 0 || cy < 0 || cx >= map.width || cy >= map.height) return -1;
    return cy * map.width + cx;
  }

  private worldView(): WorldView {
    const { map, density, officers, t } = this.ctx;
    return {
      map,
      density: density.view(t),
      officers,
      dotsInCells: (cells) => density.dotsInCells(cells),
    };
  }

  private worldActions(): WorldActions {
    return {
      setClosed: (closableId, closed) => {
        if (closed) this.ctx.closed.add(closableId);
        else this.ctx.closed.delete(closableId);
      },
      moveOfficer: (officerId, toCell) => {
        this.officerTargets.set(officerId, toCell);
      },
      raiseSituation: (situation, cells, reachShare) => {
        this.raised.push({ situation, cells, reachShare });
      },
      setTarget: (fromPlaceId, toPlaceId) => {
        const from = this.ctx.map.places.findIndex((p) => p.id === fromPlaceId);
        const to = this.ctx.map.places.findIndex((p) => p.id === toPlaceId);
        if (from >= 0 && to >= 0) this.ctx.redirects.set(from, to);
      },
    };
  }

  private stepOfficers(dt: SimSeconds): void {
    for (const officer of this.ctx.officers) {
      const target = this.officerTargets.get(officer.id);
      if (target === undefined) continue;
      const pos = this.officerPos.get(officer.id)!;
      const goal = this.cellCenter(target);
      const dx = goal.x - pos.x;
      const dy = goal.y - pos.y;
      const dist = Math.hypot(dx, dy);
      const stride = officer.speedMps * dt;
      if (dist <= stride) {
        pos.x = goal.x;
        pos.y = goal.y;
        officer.cell = target;
        this.officerTargets.delete(officer.id);
      } else {
        pos.x += (dx / dist) * stride;
        pos.y += (dy / dist) * stride;
        officer.cell = ((pos.y / CELL_SIZE_M) | 0) * this.ctx.map.width + ((pos.x / CELL_SIZE_M) | 0);
      }
    }
  }

  private officerNear(cell: number): boolean {
    if (cell < 0) return false;
    const width = this.ctx.map.width;
    const cx = cell % width;
    const cy = Math.floor(cell / width);
    for (const officer of this.ctx.officers) {
      const ox = officer.cell % width;
      const oy = Math.floor(officer.cell / width);
      if (Math.abs(ox - cx) <= officer.radiusCells && Math.abs(oy - cy) <= officer.radiusCells) return true;
    }
    return false;
  }

  private contextFor(dot: number, situation: SituationId): DecisionContext {
    const { t, density, map, config } = { ...this.ctx, config: this.opts.config };
    const cell = this.cellOfDot(dot);
    const people = cell >= 0 ? density.peoplePerM2[cell]! : 0;
    const crowdAtTarget = people < 1.5 ? 'low' : people < 3 ? 'medium' : 'high';
    const minToKickoff = -t / 60;
    const lightning =
      config.incident.kind === 'lightning_delay' && t >= config.incident.at ? 'lightning' : 'clear';
    void map;
    return {
      crowdAtTarget,
      waitMinBucket: 0,
      minToKickoffBucket: Math.round(minToKickoff / 15) * 15,
      weather: lightning,
      officerOrder: situation === 'officer_instruction' || this.officerNear(cell),
      alertHeard: this.alerted[dot] === 1,
    };
  }

  /** Turn raised situations into one ask per distinct decisionKey. */
  private buildAsks(raised: RaisedSituation[]): DecisionAsk[] {
    const { dots, population, rng } = this.ctx;
    const byKey = new Map<string, DecisionAsk>();
    const types = population.types;

    for (const raise of raised) {
      const inZone = raise.cells ? new Set(raise.cells) : null;
      const reached: number[] = [];
      for (let i = 0; i < dots.count; i++) {
        if (dots.state[i] === GONE) continue;
        if (inZone && !inZone.has(this.cellOfDot(i))) continue;
        if (raise.reachShare !== undefined && rng.next() >= raise.reachShare) continue;
        reached.push(i);
      }
      if (raise.situation === 'alert_received') {
        for (const i of reached) this.alerted[i] = 1;
        this.scorer.noteReached(reached);
      }
      for (const i of reached) {
        const fanTypeId = types[dots.typeIndex[i]!]?.id ?? types[0]!.id;
        const context = this.contextFor(i, raise.situation);
        const key = decisionKey(fanTypeId, raise.situation, context);
        const existing = byKey.get(key);
        if (existing) existing.dotIds.push(i);
        else byKey.set(key, { key, fanTypeId, situation: raise.situation, context, dotIds: [i] });
      }
    }
    return [...byKey.values()];
  }

  /** Sim time stops here until every key has an answer. That pause is the point. */
  private async resolveDecisions(): Promise<void> {
    const raised = this.raised;
    this.raised = [];
    if (raised.length === 0) return;
    const asks = this.buildAsks(raised);
    if (asks.length === 0) return;

    this.emit({ type: 'deciding', t: this.ctx.t, pendingKeys: asks.length });
    const answers = await this.client.answer(this.ctx.t, asks);

    for (let a = 0; a < asks.length; a++) {
      const ask = asks[a]!;
      const answer = answers[a]!;
      this.scorer.noteDecision(answer.source);
      for (const dot of ask.dotIds) {
        const picked = sampleOdds(answer.odds, this.ctx.rng.next());
        this.opts.movement.onChoice?.(this.ctx, dot, ask.situation, picked);
        // One record per dot: the dot detail panel needs to explain any dot the
        // commander clicks, and DecisionRecord in the contract carries one dot.
        this.emit({
          type: 'decision',
          record: {
            dot,
            t: this.ctx.t,
            fanTypeId: ask.fanTypeId,
            situation: ask.situation,
            key: ask.key,
            odds: answer.odds,
            picked,
            source: answer.source,
          },
        });
      }
    }
  }

  frame(): TickFrame {
    const { dots, officers, t, config } = { ...this.ctx, config: this.opts.config };
    return {
      runId: config.runId,
      t,
      x: dots.x.slice(),
      y: dots.y.slice(),
      state: dots.state.slice(),
      officerCells: Int32Array.from(officers.map((o) => o.cell)),
    };
  }

  snapshot(): Snapshot {
    return {
      version: CONTRACT_VERSION,
      t: this.ctx.t,
      rngState: this.ctx.rng.state(),
      dots: this.ctx.dots.toSnapshotDots(),
      officers: this.ctx.officers.map((o) => ({ ...o })),
      closed: [...this.ctx.closed],
    };
  }

  restore(snapshot: Snapshot): void {
    this.ctx.t = snapshot.t;
    this.ctx.rng.restore(snapshot.rngState);
    this.ctx.dots.loadSnapshotDots(snapshot.dots);
    this.ctx.officers.splice(0, this.ctx.officers.length, ...snapshot.officers.map((o) => ({ ...o })));
    this.ctx.closed.clear();
    for (const id of snapshot.closed) this.ctx.closed.add(id);
    for (const officer of this.ctx.officers) this.officerPos.set(officer.id, this.cellCenter(officer.cell));
    this.ctx.density.update(this.ctx.dots);
  }

  get done(): boolean {
    return this.finished;
  }

  /** Advance one sim second: world, decisions, movement, density, score. */
  async step(): Promise<void> {
    if (this.finished) return;
    const { config } = this.opts;
    this.ctx.t += SIM_DT;

    this.hooks.onStep(this.ctx.t, this.worldView(), this.worldActions());
    await this.resolveDecisions();
    this.stepOfficers(SIM_DT);
    this.opts.movement.step(this.ctx, SIM_DT);
    this.ctx.density.update(this.ctx.dots);

    const zone = config.incident.cells ?? [];
    this.scorer.observe({
      t: this.ctx.t,
      dt: SIM_DT,
      density: this.ctx.density.view(this.ctx.t),
      dotsInZone: this.ctx.density.dotsInCells(zone),
      officerInZone: zone.some((cell) => this.ctx.officers.some((o) => o.cell === cell)),
      officersCommitted: this.hooks.committedOfficers(),
    });

    if (this.ctx.t >= config.endAt) this.finished = true;
  }

  /** True on replay-frame boundaries, where the app gets a frame and a density grid. */
  isFrameTime(): boolean {
    return Math.abs(this.ctx.t % FRAME_EVERY_S) < SIM_DT / 2;
  }

  scorecard(): Scorecard {
    return this.scorer.finish();
  }

  tape(): DecisionTape {
    return this.client.getTape();
  }
}
