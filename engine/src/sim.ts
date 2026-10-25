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
import { GAME_END_S, lateRushFor } from '../../world/src/incidents.ts';
import { CLEAR_SKY, decisionWeather, walkFactor, weatherAt } from '../../world/src/weather.ts';
import {OFFICER_REACH_CELLS, OFFICER_SPEED_MPS} from '../../world/src/officers.ts';
import { TrafficModel } from './traffic.ts';
import { DensityField, type DensityContribution } from './density.ts';
import { DotStore, STATE_INDEX } from './dots.ts';
import type { Barricade, DotEdit, DotInfo, GateStat, OfficerStatus, PoliceOrder, PoliceMission } from './edits.ts';
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
  readonly officerRelief?: Map<Id, number>;
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
  /** Turn `count` of the arrivals parked nearest `gate` into a rush on it between `fromS` and `toS`. */
  lateRush?(ctx: SimContext, gate: number, count: number, fromS: SimSeconds, toS: SimSeconds): void;
  /** The game was ended early: fans not yet arrived stay away. */
  release?(ctx: SimContext): void;
  /** Movement state the inspector shows. */
  describe?(dot: number): Pick<DotInfo, 'homeGate' | 'seatCell' | 'admitted' | 'arriveAt'>;
  /**
   * The movement model's own per-cell counts for this step, so the density pass
   * can adopt them instead of walking every dot; `touched` names the cells whose
   * totals changed. Absent means the field counts the dots itself.
   */
  densityContribution?(): DensityContribution;
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
    missions?: [Id, PoliceMission][];
    instructionAt?: [Id, number][];
    instructionAreas?: [number, number][];
    patrols?: [Id, NonNullable<OfficerStatus['patrol']>][];
    officerHome?: [Id, number][];
    nextOfficer?: number;
    arrivals?: {officerId:Id;startedAt:number;arrivedAt:number;targetCell:number}[];
    officerRelief?: [Id, number][];
    vehicleClosed?: Id[];
    pedestrianOnly?: Id[];
    markers?: NonNullable<import('./edits.ts').SceneInfo['markers']>;
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
  private readonly missions = new Map<Id, PoliceMission>();
  private readonly patrols = new Map<Id, NonNullable<OfficerStatus['patrol']>>();
  private nextOfficer = 1;
  private arrivals: {officerId:Id;startedAt:number;arrivedAt:number;targetCell:number}[] = [];
  private instructionStats: {t:number;gates:GateStat[]}|null = null;
  private readonly instructionAt = new Map<Id, number>();
  private readonly instructionAreas = new Map<number, number>();
  private reliefFields: FlowFields | null = null;
  /**
   * Officers' own routes. They ignore closures — police cross a closed street —
   * and keep out of the bowl the way fans do, so a dispatch is a walk along
   * the streets instead of a straight line through buildings.
   */
  private officerFields: FlowFields;
  /** The incident zone as configured, for the dot count. */
  private readonly zoneCells: readonly number[];
  /** The same zone as one byte per map cell: membership is a single read. */
  private readonly zoneMask: Uint8Array;
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
  private readonly vehicleClosed = new Set<Id>();
  private readonly pedestrianOnly = new Set<Id>();
  private markers: NonNullable<import('./edits.ts').SceneInfo['markers']> = [];
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
      officerRelief: new Map<Id, number>(),
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
    this.zoneCells = config.incident.cells ?? [];
    this.zoneMask = new Uint8Array(map.width * map.height);
    for (const cell of this.zoneCells) {
      if (cell >= 0 && cell < this.zoneMask.length) this.zoneMask[cell] = 1;
    }
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
    // A gate surge's late rush, turned from the ordinary arrivals so the crowd
    // stays the same size and every plan meets the same rush.
    const rush = lateRushFor(config.incident);
    const rushGate = rush ? map.places.findIndex((p) => p.id === config.incident.placeId) : -1;
    if (rush && rushGate >= 0) {
      opts.movement.lateRush?.(this.ctx, rushGate, Math.round(rush.fans / DOT_GROUP_SIZE), rush.fromS, rush.toS);
    }
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
        const beat = this.patrols.get(officerId);
        if (beat) beat.active = false;
        this.missions.delete(officerId);
        this.ctx.officerRelief?.delete(officerId);
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
      let target = this.officerTargets.get(officer.id);
      const mission = this.missions.get(officer.id);
      const patrol = this.patrols.get(officer.id);
      if (patrol?.active && this.ctx.t % 15 === 0) this.instructLive(officer.id);
      if (target === undefined && mission?.phase === 'working') {
        const onSceneS = this.ctx.t - (mission.arrivedAt ?? this.ctx.t);
        if (mission.returnAfterS !== null && onSceneS >= mission.returnAfterS) {
          target = this.officerHome.get(officer.id)!;
          this.officerTargets.set(officer.id, target);
          this.recalling.add(officer.id);
          this.ctx.officerPost.delete(officer.id);
          this.ctx.officerRelief?.delete(officer.id);
          mission.phase = 'returning';
        } else if (this.ctx.t - (this.instructionAt.get(officer.id) ?? -Infinity) >= 90) {
          this.instructLive(officer.id);
        }
      }
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
        if (field && field.dist[cell] !== 0) break; // Unreachable: wait rather than cross a wall.
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
        if (patrol?.active) {
          if (patrol.index + 1 < patrol.waypoints.length || patrol.loop) {
            patrol.index = (patrol.index + 1) % patrol.waypoints.length;
            this.officerTargets.set(officer.id, patrol.waypoints[patrol.index]!);
          } else {
            patrol.active = false;
            this.missions.set(officer.id, {kind:'crowd',reason:patrol.name,targetCell:target,startedAt:this.ctx.t,arrivedAt:this.ctx.t,returnAfterS:null,phase:'working'});
          }
          continue;
        }
        if (this.recalling.delete(officer.id)) {
          this.ctx.officerPost.delete(officer.id);
          this.missions.delete(officer.id);
          this.ctx.officerRelief?.delete(officer.id);
          continue;
        }
        // An officer reaching their post starts giving instructions to the
        // people around them. Sending officers has to change what the crowd
        // does, or dispatching them is just a number on the scorecard and two
        // plans that differ only in officers score alike. The world hooks
        // repeat it while they stay on station.
        if (mission) {
          mission.phase = 'working'; mission.arrivedAt = this.ctx.t;
          if (mission.returnAfterS !== null) this.arrivals.push({officerId:officer.id,startedAt:mission.startedAt,arrivedAt:this.ctx.t,targetCell:target});
          this.instructLive(officer.id);
        } else this.raised.push({ situation: 'officer_instruction', cells: this.cellsAround(target, officer.radiusCells) });
      }
    }
  }

  private instructLive(id: Id): void {
    const officer = this.ctx.officers.find(o => o.id === id);
    if (!officer) return;
    this.instructionAt.set(id, this.ctx.t);
    this.reliefFields ??= new FlowFields(this.ctx.map);
    this.reliefFields.setClosed(this.ctx.closed);
    // Rank open gates by current queue clearance plus walking cost, not a forecast.
    let best = -1, score = Infinity;
    if (!this.instructionStats || this.instructionStats.t !== this.ctx.t) this.instructionStats = {t:this.ctx.t,gates:this.gateStats()};
    for (const gate of this.instructionStats.gates) {
      if (!gate.open || gate.capacityPerMin <= 0) continue;
      const cost = this.reliefFields.field(gate.place, true).dist[officer.cell]!;
      if (cost === 0xffff) continue;
      const candidate = gate.waiting / gate.capacityPerMin * 60 + cost / WALK_STEP * CELL_SIZE_M / 1.2;
      if (candidate < score) {score = candidate; best = gate.place;}
    }
    if (best >= 0) this.ctx.officerRelief?.set(id, best);
    const block = Math.floor(officer.cell / this.ctx.map.width / 6) * Math.ceil(this.ctx.map.width / 6) + Math.floor(officer.cell % this.ctx.map.width / 6);
    if (this.ctx.t - (this.instructionAreas.get(block) ?? -Infinity) < 90) return;
    this.instructionAreas.set(block, this.ctx.t);
    this.raised.push({situation: 'officer_instruction', cells: this.cellsAround(officer.cell, officer.radiusCells)});
  }

  /** The route to the place an officer was sent to, or null if it is not a place. */
  private officerField(id: Id) {
    const target = this.officerTargets.get(id);
    if (target !== undefined && (this.missions.has(id) || this.recalling.has(id) || this.patrols.get(id)?.active)) return this.officerFields.toCell(target);
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
  officerStatus(withRoutes = false): OfficerStatus[] {
    return this.ctx.officers.map((officer) => {
      const target = this.officerTargets.get(officer.id);
      const place = this.ctx.officerPost.get(officer.id) ?? -1;
      const field = target !== undefined ? this.officerField(officer.id) : null;
      const cost = field ? field.dist[officer.cell] : undefined;
      const pos = this.officerPos.get(officer.id)!;
      let route: number[] | undefined, routeMeters = 0;
      if (withRoutes && target !== undefined && field && cost !== 0xffff) {
        route = [officer.cell];let at = officer.cell,guard = this.ctx.map.cells.length;
        while (at !== target && guard-- > 0) {
          const dir = field.dir[at]!;if (!dir) break;
          routeMeters += Math.hypot(DIR_X[dir]!,DIR_Y[dir]!) * CELL_SIZE_M;
          at += DIR_X[dir]! + DIR_Y[dir]! * this.ctx.map.width;route.push(at);
        }
        if (at !== target && field.dist[at] === 0) {routeMeters += Math.hypot(at % this.ctx.map.width - target % this.ctx.map.width,Math.floor(at / this.ctx.map.width)-Math.floor(target / this.ctx.map.width))*CELL_SIZE_M;route.push(target);}
      }
      return {
        id: officer.id,
        unit: officer.unit,
        cell: officer.cell,
        x: pos.x,
        y: pos.y,
        state: this.patrols.get(officer.id)?.active ? 'patrolling' : target !== undefined ? 'en_route' : place >= 0 || this.missions.has(officer.id) ? 'on_scene' : 'standby',
        route,
        radiusCells: officer.radiusCells,
        patrol: this.patrols.has(officer.id) ? structuredClone(this.patrols.get(officer.id)) : undefined,
        mission: this.missions.has(officer.id) ? structuredClone(this.missions.get(officer.id)) : undefined,
        targetCell: target ?? -1,
        place,
        homeCell: this.officerHome.get(officer.id) ?? officer.cell,
        told: this.officerTold.get(officer.id) ?? 0,
        followed: this.officerFollowed.get(officer.id) ?? 0,
        // Route cost back to steps of open ground, then to seconds at their pace.
        etaS: cost === undefined || cost >= 0xffff ? null : (route ? routeMeters : (cost / WALK_STEP) * CELL_SIZE_M) / (officer.speedMps * (this.ctx.walkFactor ?? 1)),
      };
    });
  }

  /** Every gate's door, flow and queue right now. */
  gateStats(): GateStat[] {
    return this.opts.movement.gateStats?.(this.ctx) ?? [];
  }

  responseArrivals() {return this.arrivals.map(v=>({...v}));}

  /** Actual length of each outdoor flow route, evaluated at frame boundaries. */
  responseTimes(cells: number[], officerId?: Id) {
    const eligible=this.ctx.officers.filter(o=>officerId===o.id || !this.officerTargets.has(o.id) || this.patrols.get(o.id)?.active);
    const reverse=!officerId && new Set(eligible.map(o=>o.cell)).size<=cells.length;
    const memo=new Map<string,number|null>();
    return cells.map(cell=>({cell,units:this.ctx.officers.map(o=>{
      if(!eligible.includes(o))return {id:o.id,etaS:null};
      const from=reverse?cell:o.cell,to=reverse?o.cell:cell,key=from+':'+to;
      if(!memo.has(key)) {
        const field=this.officerFields.toCell(to);
        let at=from,distance=0,guard=this.ctx.map.cells.length;
        while(at!==to && guard-->0 && field.dist[at]!==0xffff) {
          const dir=field.dir[at]!;if(!dir)break;
          distance+=Math.hypot(DIR_X[dir]!,DIR_Y[dir]!)*CELL_SIZE_M;
          at+=DIR_X[dir]!+DIR_Y[dir]!*this.ctx.map.width;
        }
        memo.set(key,at===to?distance:null);
      }
      const distance=memo.get(key)!;
      return {id:o.id,etaS:distance===null?null:distance/(o.speedMps*(this.ctx.walkFactor??1))};
    })}));
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

  /** True when any officer stands on an incident cell. */
  private officerInZone(): boolean {
    const mask = this.zoneMask;
    for (const officer of this.ctx.officers) {
      const cell = officer.cell;
      // Officers are on the map; the fallback keeps an off-map cell exact.
      if (cell >= 0 && cell < mask.length) {
        if (mask[cell] === 1) return true;
      } else if (this.zoneCells.includes(cell)) return true;
    }
    return false;
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
    // Movement state is restored after this snapshot; its counts still describe
    // the abandoned future. Scan the restored dots instead.
    this.ctx.density.update(this.ctx.dots);
  }

  get done(): boolean {
    return this.finished;
  }

  /** Advance one sim second: world, live orders, decisions, movement, density, score. */
  private committedOfficerCount(): number {
    const planned=this.hooks.committedOfficers();
    if(!this.missions.size&&!this.patrols.size&&this.ctx.officers.length===this.opts.config.officers.length)return planned;
    const active=new Set([...this.officerTargets.keys(),...this.ctx.officerPost.keys(),...this.missions.keys(),
      ...[...this.patrols].filter(([,p])=>p.active).map(([id])=>id)]);
    return Math.min(this.ctx.officers.length,Math.max(planned,active.size));
  }

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
    this.ctx.density.update(this.ctx.dots, this.opts.movement.densityContribution?.());
    this.traffic?.step({
      t: this.ctx.t,
      dt: SIM_DT,
      weather: this.ctx.weather ?? CLEAR_SKY,
      density: this.ctx.density,
      dots: this.ctx.dots,
      closed: this.trafficClosures(),
      controlPoints: [...this.missions].filter(([,m])=>m.kind==='traffic' && m.phase==='working').map(([,m])=>m.targetCell),
    });
    const traffic = this.traffic?.metrics();

    const zone = this.zoneCells;
    this.scorer.observe({
      t: this.ctx.t,
      dt: SIM_DT,
      density: this.ctx.density.view(this.ctx.t),
      standingPerM2: this.ctx.density.standingPerM2,
      // Live cells only: empty ones cannot cross a threshold, so the sums hold.
      occupied: this.ctx.density.occupied,
      occupiedCount: this.ctx.density.occupiedCount,
      dotsInZone: this.ctx.density.dotsInCells(zone),
      officerInZone: this.officerInZone(),
      officersCommitted: this.committedOfficerCount(),
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
        markers: structuredClone(this.markers),
        vehicleClosed: [...this.vehicleClosed],
        pedestrianOnly: [...this.pedestrianOnly],
        patrols: structuredClone([...this.patrols]),
        officerHome: [...this.officerHome],
        nextOfficer: this.nextOfficer,
        arrivals: this.responseArrivals(),
        missions: structuredClone([...this.missions]),
        instructionAt: [...this.instructionAt],
        instructionAreas: [...this.instructionAreas],
        officerRelief: [...(this.ctx.officerRelief ?? [])],
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
      this.markers=structuredClone(state.markers??[]);
      this.vehicleClosed.clear();for(const id of state.vehicleClosed??[])this.vehicleClosed.add(id);
      this.pedestrianOnly.clear();for(const id of state.pedestrianOnly??[])this.pedestrianOnly.add(id);
      this.patrols.clear();
      for (const [id, beat] of state.patrols ?? []) this.patrols.set(id, structuredClone(beat));
      if (state.officerHome) {this.officerHome.clear(); for (const [id, cell] of state.officerHome) this.officerHome.set(id, cell);}
      this.nextOfficer = state.nextOfficer ?? 1;
      this.arrivals = (state.arrivals ?? []).map(v=>({...v}));
      this.instructionStats = null;
      this.missions.clear();
      for (const [id, mission] of state.missions ?? []) this.missions.set(id, structuredClone(mission));
      this.instructionAreas.clear();
      for (const [cell, t] of state.instructionAreas ?? []) this.instructionAreas.set(cell, t);
      this.instructionAt.clear();
      for (const [id, t] of state.instructionAt ?? []) this.instructionAt.set(id, t);
      this.ctx.officerRelief?.clear();
      for (const [id, gate] of state.officerRelief ?? []) this.ctx.officerRelief?.set(id, gate);
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
    return this.barricades.filter((barricade) => this.ctx.closed.has(barricade.id)||this.vehicleClosed.has(barricade.id));
  }

  closedIds(): Id[] {return [...new Set([...this.ctx.closed,...this.vehicleClosed])];}
  markerStatus() {return structuredClone(this.markers);}
  trafficClosures(): ReadonlySet<Id> {
    if(!this.vehicleClosed.size&&!this.pedestrianOnly.size)return this.ctx.closed;
    return new Set([...this.ctx.closed].filter(id=>!this.pedestrianOnly.has(id)).concat([...this.vehicleClosed]));
  }

  private applyOrders(): void {
    const act = this.worldActions();
    for (const { t, order } of this.orders) {
      if (t !== this.ctx.t) continue;
      switch (order.type) {
        case 'place_marker': {
          const m=order.marker,kind=this.ctx.map.cells[m.cell];
          if(!Number.isInteger(m.cell)||!kind||kind==='blocked'||kind==='stands'||kind==='concourse')break;
          this.markers=this.markers.filter(v=>v.id!==m.id);
          this.markers.push({...m,name:m.name.slice(0,64),radiusCells:Math.max(1,Math.min(100,m.radiusCells))});break;
        }
        case 'remove_marker': this.markers=this.markers.filter(v=>v.id!==order.id);break;
        case 'officer_report':
        case 'report_decision': break;
        case 'dismiss_suggestion': break;
        case 'add_officer': {
          const kind = this.ctx.map.cells[order.cell];
          if (!Number.isInteger(order.cell) || !kind || kind === 'blocked' || kind === 'stands' || kind === 'concourse' || !order.unit.trim()) break;
          let id: string;
          do {id = 'live-off-' + this.nextOfficer++;} while (this.officerHome.has(id));
          this.ctx.officers.push({id,unit:order.unit.trim().slice(0,64),cell:order.cell,speedMps:OFFICER_SPEED_MPS,radiusCells:OFFICER_REACH_CELLS});
          this.officerHome.set(id, order.cell); this.officerPos.set(id, this.cellCenter(order.cell));
          break;
        }
        case 'remove_officer': {
          const index = this.ctx.officers.findIndex(o=>o.id===order.officerId);
          if (index < 0) break;
          this.ctx.officers.splice(index,1);
          for (const values of [this.officerHome,this.officerTargets,this.officerPos,this.ctx.officerPost,this.ctx.officerRelief,this.missions,this.patrols,this.instructionAt]) values?.delete(order.officerId);
          this.recalling.delete(order.officerId);
          break;
        }
        case 'patrol':
        case 'resume_patrol': {
          for (const id of order.officerIds) {
            const officer = this.ctx.officers.find(o=>o.id===id);
            const beat = order.type === 'patrol' ? {waypoints: [...order.waypoints],loop:order.loop,name:order.name ?? 'Outdoor patrol',index:0,active:true,direction:1 as const} : this.patrols.get(id);
            if (!officer || !beat || !beat.waypoints.length || beat.waypoints.some(c=>!Number.isInteger(c)||!['walk','road','parking'].includes(this.ctx.map.cells[c]!)||this.officerFields.toCell(c).dist[officer.cell]===0xffff)) continue;
            act.moveOfficer(id,beat.waypoints[beat.index]!);
            this.ctx.officerPost.delete(id);
            beat.active = true; this.patrols.set(id,beat);
          }
          break;
        }
        case 'respond':
        case 'dispatch': {
          const cell = order.toCell;
          const kind = this.ctx.map.cells[cell];
          if (!Number.isInteger(cell) || !kind || kind === 'blocked' || kind === 'stands' || kind === 'concourse') break;
          const field = this.officerFields.toCell(cell);
          for (const id of order.officerIds) {
            const officer = this.ctx.officers.find(o => o.id === id);
            if (!officer || field.dist[officer.cell] === 0xffff) continue;
            act.moveOfficer(id, cell);
            this.missions.set(id, {kind: order.type === 'respond' ? order.kind : 'crowd',
              reason: order.type === 'respond' ? order.reason : '', targetCell: cell,
              startedAt: this.ctx.t, arrivedAt: null, returnAfterS: order.type === 'respond' ? Math.max(60, Math.min(900, order.returnAfterS || 180)) : null,
              phase: 'responding'});
          }
          break;
        }
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
          if (!this.barricades.some(b=>b.id===order.closableId)) {
            const known=this.ctx.map.closables.find(c=>c.id===order.closableId);
            if(known)this.barricades.push({...known,...(order.blocks?{blocks:order.blocks}:{})});
          }
          if (order.cells && !this.ctx.map.closables.some((c) => c.id === order.closableId)) {
            const barricade = { id: order.closableId, name: order.name ?? order.closableId, cells: order.cells,...(order.blocks?{blocks:order.blocks}:{}) };
            // Each worker owns its map; retaining the registration across
            // rewinds lets closures replay without duplicate geometry.
            this.ctx.map.closables.push(barricade);
            this.barricades.push(barricade);
          }
          if(order.blocks==='vehicles'||this.barricades.find(b=>b.id===order.closableId)?.blocks==='vehicles') {
            if(order.closed)this.vehicleClosed.add(order.closableId);else this.vehicleClosed.delete(order.closableId);
            act.setClosed(order.closableId,false);
          } else {
            if(order.blocks==='pedestrians')this.pedestrianOnly.add(order.closableId);
            act.setClosed(order.closableId,order.closed);
          }
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
