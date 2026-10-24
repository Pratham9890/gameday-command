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
  WeatherState,
  WorkerOut,
  WorldActions,
  WorldView,
} from '../../contracts.ts';
import { CELL_SIZE_M, CONTRACT_VERSION, DOT_GROUP_SIZE, FRAME_EVERY_S, decisionKey } from '../../contracts.ts';
import { DIR_DX as DIR_X, DIR_DY as DIR_Y } from './flowfield.ts';
import { DecisionClient } from '../../brain/src/client.ts';
import { sampleOdds } from '../../brain/src/sample.ts';
import { Scorer, type ScorerState } from '../../world/src/scoring.ts';
import { createWorldHooks, type WorldRuntime } from '../../world/src/hooks.ts';
import { GAME_END_S } from '../../world/src/incidents.ts';
import { CLEAR_SKY, decisionWeather, walkFactor, weatherAt } from '../../world/src/weather.ts';
import { TrafficModel } from './traffic.ts';
import { DensityField } from './density.ts';
import { DotStore, STATE_INDEX } from './dots.ts';
import type { Barricade, DotEdit, DotInfo, GateStat, OfficerStatus, PoliceOrder } from './edits.ts';
import { FlowFields, WALK_STEP } from './flowfield.ts';
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
  /** Where each dispatched officer has been posted: officer id -> place index. */
  readonly officerPost: Map<Id, number>;
  t: SimSeconds;
  /** The sky this second. Absent means clear, which is how v1 contexts were built. */
  weather?: WeatherState;
  /** Walking speed multiplier for the weather; exactly 1 when clear. */
  walkFactor?: number;
}

export interface MovementModel {
  spawn(ctx: SimContext): void;
  step(ctx: SimContext, dt: SimSeconds): void;
  /** A dot just chose an option; the model may retarget it. */
  onChoice?(ctx: SimContext, dot: number, situation: SituationId, option: string): void;
  /**
   * State the model keeps that the contract's Snapshot does not describe —
   * arrival times, assigned seats and gates, who has been admitted, the gates'
   * throughput budgets. Snapshot is frozen and carries only what crosses the
   * lane boundary, so rewinding a run needs this too or the crowd comes back
   * subtly different.
   */
  capture?(): unknown;
  restore?(state: unknown): void;
  /** The commander sent this dot somewhere by hand. */
  sendTo?(ctx: SimContext, dot: number, place: number): void;
  /** Every gate's door and flow, for the app. */
  gateStats?(ctx: SimContext): GateStat[];
  /** The game was ended early: fans not yet arrived stay away. */
  release?(ctx: SimContext): void;
  /** Movement state the inspector shows. */
  describe?(dot: number): Pick<DotInfo, 'homeGate' | 'seatCell' | 'admitted' | 'arriveAt'>;
}

/** Everything needed to put a run back exactly where it was, inside one worker. */
export interface Checkpoint {
  snapshot: Snapshot;
  movement: unknown;
  scorer: ScorerState;
  traffic?: unknown;
  /** Engine bookkeeping omitted by the frozen Snapshot; world hooks keep their own state. */
  simulation?: {
    officerTargets: [Id, number][];
    officerPos: [Id, { x: number; y: number }][];
    officerPost: [Id, number][];
    officerTold: [Id, number][];
    officerFollowed: [Id, number][];
    redirects: [number, number][];
    alerted: Uint8Array;
    recalling: Id[];
    raised: RaisedSituation[];
    alerts: { t: SimSeconds; dots: Int32Array }[];
  };
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
  /** Where each officer started: their police post, or a gate on a map without one. */
  private readonly officerHome = new Map<Id, number>();
  /** People each officer has spoken to, and how many of them did as told. */
  private readonly officerTold = new Map<Id, number>();
  private readonly officerFollowed = new Map<Id, number>();
  private readonly recalling = new Set<Id>();
  /**
   * Officers' own routes. They ignore closures — police cross a closed street —
   * and keep out of the bowl the way fans do, so a dispatch is a walk along
   * the streets instead of a straight line through buildings.
   */
  private officerFields: FlowFields;
  /** Alerts that reached people since the app last asked, with who they reached. */
  private alerts: { t: SimSeconds; dots: Int32Array }[] = [];
  private readonly alerted: Uint8Array;
  private raised: RaisedSituation[] = [];
  private finished = false;
  /** Vehicles, when the run asked for them. Reads the crowd, never moves it. */
  readonly traffic: TrafficModel | null;
  /**
   * Commander edits, kept for the life of the run rather than applied and
   * forgotten: a rewind to before an edit then steps forward through it again,
   * so the edit is replayed at the same sim second instead of lost.
   */
  private edits: DotEdit[] = [];
  /** Kept across rewinds so live orders replay at the same sim second. */
  private orders: { t: SimSeconds; order: PoliceOrder }[] = [];
  private readonly barricades: Barricade[] = [];
  /** Bumps whenever any dot's fan type may have changed. */
  typesVersion = 0;

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
      officerPost: new Map<Id, number>(),
      t: config.startAt,
      weather: CLEAR_SKY,
      walkFactor: 1,
    };
    this.applyWeather();
    this.alerted = new Uint8Array(population.dots);
    for (const officer of this.ctx.officers) {
      this.officerPos.set(officer.id, this.cellCenter(officer.cell));
      this.officerHome.set(officer.id, officer.cell);
    }
    this.officerFields = new FlowFields(map);
    // A package at game end only makes sense alongside the crowd leaving.
    this.hooks = createWorldHooks(
      config.incident,
      config.plan,
      config.incident.kind === 'suspicious_package' ? config.incident.at : undefined,
    );
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

    this.traffic = config.traffic
      ? new TrafficModel({
          map,
          config: config.traffic,
          population,
          incident: config.incident,
          startAt: config.startAt,
          endAt: config.endAt,
          gameEndAt: config.incident.kind === 'suspicious_package' ? config.incident.at : config.endAt > GAME_END_S ? GAME_END_S : undefined,
        })
      : null;
  }

  /** Same timeline, same seconds, for every plan: the sky is not part of the plan. */
  private applyWeather(): void {
    const weather = weatherAt(this.opts.config.weather, this.ctx.t, this.opts.config.incident);
    this.ctx.weather = weather;
    this.ctx.walkFactor = walkFactor(weather);
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
    if (dots.x[i]! < 0 || dots.y[i]! < 0) return -1; // parked off-map, not arrived
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
        this.recalling.delete(officerId);
        // Remember what the officer was sent to manage, so fans who do as
        // they are told have somewhere to be told to go.
        const place = this.ctx.map.places.findIndex((p) => p.cells.includes(toCell));
        if (place >= 0) this.ctx.officerPost.set(officerId, place);
        // Street targets have no place field; use the straight-line fallback,
        // rather than routing the officer back to their previous post.
        else this.ctx.officerPost.delete(officerId);
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
    const { map } = this.ctx;
    for (const officer of this.ctx.officers) {
      const target = this.officerTargets.get(officer.id);
      if (target === undefined) continue;
      const pos = this.officerPos.get(officer.id)!;
      const goal = this.cellCenter(target);
      const field = this.officerField(officer.id);
      // Weather slows officers on foot the way it slows the crowd.
      let left = officer.speedMps * (this.ctx.walkFactor ?? 1) * dt;
      // Sub-steps of at most a metre: a stride longer than a cell would cut the
      // corners the route goes round.
      while (left > 0) {
        const cell = ((pos.y / CELL_SIZE_M) | 0) * map.width + ((pos.x / CELL_SIZE_M) | 0);
        const dir = field && field.dist[cell] !== 0 ? field.dir[cell]! : 0;
        const step = Math.min(left, 1);
        left -= step;
        if (dir !== 0) {
          const dx = DIR_X[dir]!;
          const dy = DIR_Y[dir]!;
          const norm = dx !== 0 && dy !== 0 ? Math.SQRT1_2 : 1;
          pos.x += dx * norm * step;
          pos.y += dy * norm * step;
          continue;
        }
        // On the destination itself, or nowhere to route from: the last
        // stretch to the exact post is a straight line.
        const gx = goal.x - pos.x;
        const gy = goal.y - pos.y;
        const dist = Math.hypot(gx, gy);
        if (dist <= step) {
          pos.x = goal.x;
          pos.y = goal.y;
          left = 0;
        } else {
          pos.x += (gx / dist) * step;
          pos.y += (gy / dist) * step;
        }
      }
      officer.cell = ((pos.y / CELL_SIZE_M) | 0) * map.width + ((pos.x / CELL_SIZE_M) | 0);
      if (pos.x === goal.x && pos.y === goal.y) {
        officer.cell = target;
        this.officerTargets.delete(officer.id);
        if (this.recalling.delete(officer.id)) {
          this.ctx.officerPost.delete(officer.id);
          continue;
        }
        // An officer reaching their post starts giving instructions to the
        // people around them. Sending officers has to change what the crowd
        // does, or dispatching them is just a number on the scorecard and two
        // plans that differ only in officers score alike. The world hooks
        // repeat it while they stay on station.
        this.raised.push({ situation: 'officer_instruction', cells: this.cellsAround(target, officer.radiusCells) });
      }
    }
  }

  /** The route to the place an officer was sent to, or null if it is not a place. */
  private officerField(id: Id) {
    const place = this.ctx.officerPost.get(id);
    if (place === undefined) return null;
    const kind = this.ctx.map.places[place]?.kind;
    // Like a fan: keep out of the bowl only when starting outside it. An
    // officer posted on the concourse has no route that avoids the bowl, and
    // the straight-line fallback then walked them through the wall.
    const officer = this.ctx.officers.find((o) => o.id === id);
    const here = officer ? this.ctx.map.cells[officer.cell] : undefined;
    const inside = here === 'stands' || here === 'concourse';
    return this.officerFields.field(place, !inside && kind !== 'seating' && kind !== 'concourse' && kind !== 'shelter');
  }

  /** What every officer is doing, for the app: where, heading where, and how much they have helped. */
  officerStatus(): OfficerStatus[] {
    return this.ctx.officers.map((officer) => {
      const target = this.officerTargets.get(officer.id);
      const place = this.ctx.officerPost.get(officer.id) ?? -1;
      const field = target !== undefined ? this.officerField(officer.id) : null;
      const cost = field ? field.dist[officer.cell] : undefined;
      const pos = this.officerPos.get(officer.id)!;
      return {
        id: officer.id,
        unit: officer.unit,
        cell: officer.cell,
        x: pos.x,
        y: pos.y,
        state: target !== undefined ? 'en_route' : place >= 0 ? 'on_scene' : 'standby',
        targetCell: target ?? -1,
        place,
        homeCell: this.officerHome.get(officer.id) ?? officer.cell,
        told: this.officerTold.get(officer.id) ?? 0,
        followed: this.officerFollowed.get(officer.id) ?? 0,
        // Route cost back to steps of open ground, then to seconds at their pace.
        etaS: cost === undefined || cost >= 0xffff ? null : ((cost / WALK_STEP) * CELL_SIZE_M) / officer.speedMps,
      };
    });
  }

  /** Every gate's door, flow and queue right now. */
  gateStats(): GateStat[] {
    return this.opts.movement.gateStats?.(this.ctx) ?? [];
  }

  /** Alerts raised since the last call, each with the dots it reached. */
  takeAlerts(): { t: SimSeconds; dots: Int32Array }[] {
    const out = this.alerts;
    this.alerts = [];
    return out;
  }

  /** The officer closest to a cell and within earshot of it, or null. */
  private officerOver(cell: number): Id | null {
    const width = this.ctx.map.width;
    const cx = cell % width;
    const cy = (cell / width) | 0;
    let best: Id | null = null;
    let bestSq = Infinity;
    for (const officer of this.ctx.officers) {
      const dx = (officer.cell % width) - cx;
      const dy = ((officer.cell / width) | 0) - cy;
      if (Math.abs(dx) > officer.radiusCells || Math.abs(dy) > officer.radiusCells) continue;
      const sq = dx * dx + dy * dy;
      if (sq < bestSq) {
        bestSq = sq;
        best = officer.id;
      }
    }
    return best;
  }

  /** Cells within a square of `radius` of this one, clipped to the map. */
  private cellsAround(cell: number, radius: number): number[] {
    const { width, height } = this.ctx.map;
    const cx = cell % width;
    const cy = Math.floor(cell / width);
    const out: number[] = [];
    for (let y = Math.max(0, cy - radius); y <= Math.min(height - 1, cy + radius); y++) {
      for (let x = Math.max(0, cx - radius); x <= Math.min(width - 1, cx + radius); x++) {
        out.push(y * width + x);
      }
    }
    return out;
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
    // A lightning delay reads as lightning from the moment it fires, as it did
    // in v1; otherwise the weather timeline says what the sky is doing.
    const sky = this.ctx.weather ?? weatherAt(config.weather, t, config.incident);
    const lightning = decisionWeather(sky);
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
        // Off the map means they have not arrived yet: a fan in their car is not
        // in the zone and cannot be reached by a PA announcement.
        const cell = this.cellOfDot(i);
        if (cell < 0) continue;
        if (inZone && !inZone.has(cell)) continue;
        if (raise.reachShare !== undefined && rng.next() >= raise.reachShare) continue;
        reached.push(i);
      }
      if (raise.situation === 'alert_received') {
        for (const i of reached) this.alerted[i] = 1;
        this.scorer.noteReached(reached);
        if (reached.length > 0) this.alerts.push({ t: this.ctx.t, dots: Int32Array.from(reached) });
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
      const byOfficer = ask.situation === 'officer_instruction';
      for (const dot of ask.dotIds) {
        const picked = sampleOdds(answer.odds, this.ctx.rng.next());
        if (byOfficer) {
          const cell = this.cellOfDot(dot);
          const officer = cell >= 0 ? this.officerOver(cell) : null;
          if (officer !== null) {
            this.officerTold.set(officer, (this.officerTold.get(officer) ?? 0) + DOT_GROUP_SIZE);
            if (picked === 'follow') this.officerFollowed.set(officer, (this.officerFollowed.get(officer) ?? 0) + DOT_GROUP_SIZE);
          }
        }
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
      vehicles: this.traffic?.frame(),
      weather: this.ctx.weather,
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

  /** Advance one sim second: world, live orders, decisions, movement, density, score. */
  async step(): Promise<void> {
    if (this.finished) return;
    const { config } = this.opts;
    this.ctx.t += SIM_DT;
    this.applyWeather();

    this.applyEdits();
    this.hooks.onStep(this.ctx.t, this.worldView(), this.worldActions());
    this.applyOrders();
    await this.resolveDecisions();
    this.stepOfficers(SIM_DT);
    this.opts.movement.step(this.ctx, SIM_DT);
    this.ctx.density.update(this.ctx.dots);
    this.traffic?.step({
      t: this.ctx.t,
      dt: SIM_DT,
      weather: this.ctx.weather ?? CLEAR_SKY,
      density: this.ctx.density,
      dots: this.ctx.dots,
      closed: this.ctx.closed,
    });
    const traffic = this.traffic?.metrics();

    const zone = config.incident.cells ?? [];
    this.scorer.observe({
      t: this.ctx.t,
      dt: SIM_DT,
      density: this.ctx.density.view(this.ctx.t),
      standingPerM2: this.ctx.density.standingPerM2,
      dotsInZone: this.ctx.density.dotsInCells(zone),
      officerInZone: zone.some((cell) => this.ctx.officers.some((o) => o.cell === cell)),
      officersCommitted: this.hooks.committedOfficers(),
      traffic,
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

  /** A full restart point for this worker: contract snapshot plus what it omits. */
  checkpoint(): Checkpoint {
    return {
      snapshot: this.snapshot(),
      movement: this.opts.movement.capture?.() ?? null,
      scorer: this.scorer.capture(),
      traffic: this.traffic?.capture(),
      simulation: {
        officerTargets: [...this.officerTargets],
        officerPos: [...this.officerPos].map(([id, pos]) => [id, { ...pos }]),
        officerPost: [...this.ctx.officerPost],
        officerTold: [...this.officerTold],
        officerFollowed: [...this.officerFollowed],
        redirects: [...this.ctx.redirects],
        alerted: this.alerted.slice(),
        recalling: [...this.recalling],
        // Arrival instructions wait until the next step's decision pass.
        raised: structuredClone(this.raised),
        alerts: this.alerts.map((alert) => ({ t: alert.t, dots: alert.dots.slice() })),
      },
    };
  }

  /** Put the run back to a checkpoint. Stepping on from here repeats exactly. */
  rewind(point: Checkpoint): void {
    this.restore(point.snapshot);
    const state = point.simulation;
    if (state) {
      this.officerTargets.clear();
      for (const [id, cell] of state.officerTargets) this.officerTargets.set(id, cell);
      this.officerPos.clear();
      for (const [id, pos] of state.officerPos) this.officerPos.set(id, { ...pos });
      this.ctx.officerPost.clear();
      for (const [id, place] of state.officerPost) this.ctx.officerPost.set(id, place);
      this.officerTold.clear();
      for (const [id, told] of state.officerTold) this.officerTold.set(id, told);
      this.officerFollowed.clear();
      for (const [id, followed] of state.officerFollowed) this.officerFollowed.set(id, followed);
      this.ctx.redirects.clear();
      for (const [from, to] of state.redirects) this.ctx.redirects.set(from, to);
      this.alerted.set(state.alerted);
      this.recalling.clear();
      for (const id of state.recalling) this.recalling.add(id);
      this.raised = structuredClone(state.raised);
      this.alerts = state.alerts.map((alert) => ({ t: alert.t, dots: alert.dots.slice() }));
    }
    // FlowMovement's routes are cached against the closures they were built
    // with, and its restored `closedKey` names the checkpoint's closures, not
    // the abandoned future's the cache still holds: a gate shut after the
    // checkpoint stayed shut in every route. A key that matches nothing makes
    // its next step re-apply ctx.closed. Calling spawn() instead also fixed it
    // but cost ~2.5 s per worker per seek on the stadium map.
    const movement = point.movement && typeof point.movement === 'object' ? { ...point.movement, closedKey: '\u0000rewound' } : point.movement;
    this.opts.movement.restore?.(movement);
    this.scorer.restore(point.scorer);
    if (point.traffic !== undefined) this.traffic?.restore(point.traffic);
    this.applyWeather();
    this.finished = false;
    this.typesVersion++;
  }

  /**
   * Queue an edit. One already in the past lands on the next step: the app asks
   * for a moment a little ahead of every plan so all three apply it at the same
   * sim second, but a worker that got there first must not drop it.
   */
  queueEdit(edit: DotEdit): void {
    const at = Math.max(Math.ceil(edit.at), this.ctx.t + SIM_DT);
    const dots = edit.dots.filter((d) => Number.isInteger(d) && d >= 0 && d < this.ctx.dots.count);
    if (dots.length === 0) return;
    this.edits.push({ ...edit, at, dots });
  }

  /** Forget edits after a moment the run was rewound to, as the frames after it are. */
  dropEditsAfter(t: SimSeconds): void {
    this.edits = this.edits.filter((e) => e.at <= t);
  }

  /** Queue a live police order for the next sim second. */
  queueOrder(order: PoliceOrder): void {
    this.orders.push({ t: this.ctx.t + SIM_DT, order });
  }

  /** Forget orders after a moment the run was rewound to. */
  dropOrdersAfter(t: SimSeconds): void {
    this.orders = this.orders.filter((entry) => entry.t <= t);
  }

  /** Live orders already applied, oldest first, for the commander's scene log. */
  ordersLog(): { t: SimSeconds; order: PoliceOrder }[] {
    return this.orders.filter((entry) => entry.t <= this.ctx.t).sort((a, b) => a.t - b.t);
  }

  /** Commander-placed barricades that are closed at this moment. */
  liveBarricades(): Barricade[] {
    return this.barricades.filter((barricade) => this.ctx.closed.has(barricade.id));
  }

  private applyOrders(): void {
    const act = this.worldActions();
    for (const { t, order } of this.orders) {
      if (t !== this.ctx.t) continue;
      switch (order.type) {
        case 'dispatch':
          for (const id of order.officerIds) {
            if (this.officerHome.has(id)) act.moveOfficer(id, order.toCell);
          }
          break;
        case 'recall':
          for (const id of order.officerIds) {
            const home = this.officerHome.get(id);
            if (home === undefined) continue;
            act.moveOfficer(id, home);
            // Keep a place route until arrival, but returning home must not
            // count as being on scene or trigger a crowd instruction.
            this.recalling.add(id);
          }
          break;
        case 'gate':
          act.setClosed(order.closableId, order.closed);
          break;
        case 'barricade':
          if (order.cells && !this.ctx.map.closables.some((c) => c.id === order.closableId)) {
            const barricade = { id: order.closableId, name: order.name ?? order.closableId, cells: order.cells };
            // Each worker owns its map; retaining the registration across
            // rewinds lets closures replay without duplicate geometry.
            this.ctx.map.closables.push(barricade);
            this.barricades.push(barricade);
          }
          act.setClosed(order.closableId, order.closed);
          break;
        case 'redirect': {
          act.setTarget(order.fromPlaceId, order.toPlaceId);
          // World hooks' standing order is private, so a live redirect must
          // reach the crowd through officers already on station here.
          const cells = new Set<number>();
          for (const officer of this.ctx.officers) {
            if (!this.ctx.officerPost.has(officer.id) || this.officerTargets.has(officer.id)) continue;
            for (const cell of this.cellsAround(officer.cell, officer.radiusCells)) cells.add(cell);
          }
          act.raiseSituation('officer_instruction', [...cells]);
          break;
        }
        case 'alert':
          act.raiseSituation('alert_received', order.zoneCells, Math.max(0, Math.min(1, order.reachShare)));
          break;
        case 'release':
          act.raiseSituation('exit_route');
          // exit_route only reaches fans on the map; the ones still on their
          // way would otherwise arrive and walk into a stadium that is emptying.
          this.opts.movement.release?.(this.ctx);
          break;
      }
    }
  }

  private applyEdits(): void {
    const { dots, population } = this.ctx;
    for (const edit of this.edits) {
      if (edit.at !== this.ctx.t) continue;
      for (const dot of edit.dots) {
        if (dots.state[dot] === GONE) continue;
        if (edit.fanType !== undefined && edit.fanType >= 0 && edit.fanType < population.types.length) {
          dots.typeIndex[dot] = edit.fanType;
        }
        if (edit.sendTo !== undefined && edit.sendTo >= 0 && edit.sendTo < this.ctx.map.places.length) {
          this.opts.movement.sendTo?.(this.ctx, dot, edit.sendTo);
        }
      }
      if (edit.fanType !== undefined) this.typesVersion++;
    }
  }

  inspect(dot: number): DotInfo | null {
    const { dots, t } = this.ctx;
    if (!Number.isInteger(dot) || dot < 0 || dot >= dots.count) return null;
    const moved = this.opts.movement.describe?.(dot) ?? { homeGate: -1, seatCell: -1, admitted: false, arriveAt: t };
    return {
      dot,
      t,
      x: dots.x[dot]!,
      y: dots.y[dot]!,
      state: dots.state[dot]!,
      typeIndex: dots.typeIndex[dot]!,
      targetPlace: dots.targetPlace[dot]!,
      ...moved,
      edits: this.edits.filter((e) => e.dots.includes(dot)).length,
    };
  }
}
