/**
 * Gameday Command — shared contract (contracts.ts)
 *
 * Frozen at hour 1. Every lane imports ONLY from this file to talk to another lane.
 * Changing it = a 2 minute huddle with all four lanes, then bump CONTRACT_VERSION.
 *
 * Units: meters, seconds of sim time, grid cells of CELL_SIZE_M meters.
 * Ownership tags: [A] Engine, [B] World (incidents, responders, scoring), [C] Brain, [D] App + server.
 * Runs entirely on one Mac. Live fan decisions come from a local Kev server (MLX, port 8009).
 *
 * v2 (approved by Nipun): vehicle traffic and weather. Every addition is
 * optional, so a run with no traffic and no weather steps exactly as v1 did.
 */

export const CONTRACT_VERSION = 'gameday.v3' as const;
export const CELL_SIZE_M = 2;            // grid cell edge in meters
export const DOT_GROUP_SIZE = 5;         // one dot = this many fans
export const DEFAULT_DANGER_DENSITY = 4; // people per square meter, editable per run
export const FRAME_EVERY_S = 15;         // replay frame cadence in sim seconds

export type Id = string;
export type SimSeconds = number;         // seconds since scenario start

// ───────────────────────── Weather [B] ─────────────────────────────

export type WeatherKind = 'clear' | 'overcast' | 'rain' | 'heavy_rain' | 'thunderstorm' | 'snow' | 'fog' | 'heat';

/** What the sky is doing at one moment. Same for every plan in a comparison. */
export interface WeatherState {
  kind: WeatherKind;
  intensity: number;                     // 0..1, how hard it is raining, snowing, fogging
  tempC: number;
  windMps: number;
  windFromDeg: number;                   // compass bearing the wind blows FROM
  visibilityM: number;
  lightning: boolean;                    // strikes within 8 miles right now
}

/** A weather scenario: the sky changes at these moments. Applies to all three plans. */
export interface WeatherTimeline {
  id: Id;
  label: string;                         // "Rain moving in at kickoff"
  segments: { from: SimSeconds; state: WeatherState }[]; // sorted by from
}

// ───────────────────────── Vehicles [A + B] ────────────────────────

export type VehicleKind =
  | 'compact' | 'sedan' | 'suv' | 'pickup' | 'minivan' | 'rideshare'
  | 'motorcycle' | 'rv' | 'bus' | 'police' | 'ambulance';
export const VEHICLE_KINDS: VehicleKind[] = [
  'compact', 'sedan', 'suv', 'pickup', 'minivan', 'rideshare', 'motorcycle', 'rv', 'bus', 'police', 'ambulance',
];

export type VehicleState =
  | 'waiting'      // not on the map yet
  | 'driving'      // moving on a road
  | 'stopped'      // in traffic, at a crowd, or behind a closure
  | 'parking'      // creeping down a lot aisle to its stall
  | 'parked'
  | 'departing'    // pulling out of the lot
  | 'responding'   // emergency vehicle on its way to the incident
  | 'on_scene'
  | 'gone';
export const VEHICLE_STATES: VehicleState[] = [
  'waiting', 'driving', 'stopped', 'parking', 'parked', 'departing', 'responding', 'on_scene', 'gone',
];

export interface VehicleType {
  kind: VehicleKind;
  label: string;
  lengthM: number;                       // real-world footprint, drawn to scale
  widthM: number;
  maxSpeedMps: number;                   // city driving, before weather and crowds
  passengers: number;                    // typical occupancy on game day
  share: number;                         // fraction of general traffic, sums to 1 (emergency kinds 0)
}

/** Traffic settings for a run. Absent = no vehicles, which is exactly v1. */
export interface TrafficConfig {
  vehicles: number;                      // general traffic, a sample of game-day cars
  seed: number;                          // separate stream so traffic never shifts the crowd's RNG
  emergencyResponse: boolean;            // dispatch an ambulance to the incident when it fires
}

/** Packed per frame. Index i = vehicle i. */
export interface VehicleFrame {
  x: Float32Array;                       // meters, centre of the vehicle
  y: Float32Array;
  heading: Float32Array;                 // radians, 0 = east, clockwise (screen y grows south)
  speed: Float32Array;                   // m/s
  kind: Uint8Array;                      // index into VEHICLE_KINDS
  state: Uint8Array;                     // index into VEHICLE_STATES
  waitedS: Float32Array;                 // seconds spent stopped so far
}

// ───────────────────────────── Map [B] ─────────────────────────────

export type CellKind = 'blocked' | 'walk' | 'road' | 'stands' | 'concourse' | 'shelter' | 'parking';

export interface Place {
  id: Id;
  name: string;                          // "Gate 10", "North concourse", "Lot 5"
  kind: 'gate' | 'seating' | 'concourse' | 'shelter' | 'parking' | 'bus_stop' | 'tailgate' | 'exit';
  cells: number[];                       // cell indexes the place covers
  capacity: number;                      // people
  throughputPerMin?: number;             // gates, bus stops
}

export interface MapBundle {
  version: typeof CONTRACT_VERSION;
  id: Id;
  name: string;                          // "Ohio Stadium + 0.5 mi"
  width: number;                         // cells
  height: number;                        // cells
  cells: CellKind[];                     // row major, length width*height
  places: Place[];
  /** Named edges that can be closed (a street segment, a gate door). */
  closables: { id: Id; name: string; cells: number[] }[];
  sources: { label: string; url: string }[]; // OSM export, public gate times
  /** v2: street centrelines in meters, flat [x0, y0, x1, y1, ...], for drawing lanes and names. */
  streets?: { name: string; kind: string; points: number[] }[];
  /** v2: the playing field's cells, inside the bowl. Nobody is seated there. */
  field?: number[];
}

// ─────────────────────────── Crowd [C] ─────────────────────────────

export type FanTypeId = Id;

export interface FanType {
  id: FanTypeId;                         // "student-section", "alumni-family", "away-fan"
  label: string;
  share: number;                         // fraction of the crowd, all types sum to 1
  walkSpeedMps: number;                  // free walking speed
  groupSize: number;                     // typical group, used for display only
  arrivalWindowMin: [number, number];    // minutes before kickoff they arrive
  traits: { patience: number; compliance: number; mobility: number }; // 0..1
}

export interface Population {
  seed: number;
  totalFans: number;                     // e.g. 100_000
  dots: number;                          // totalFans / DOT_GROUP_SIZE
  types: FanType[];
}

// ─────────────────────── Decisions [C → A] ─────────────────────────

/** A moment where a dot must choose. The engine knows when these happen. */
export type SituationId =
  | 'pick_gate'
  | 'leave_tailgate'
  | 'leave_early'
  | 'lightning_shelter'
  | 'gate_jammed'
  | 'street_closed'
  | 'officer_instruction'
  | 'alert_received'
  | 'heard_rumor'
  | 'exit_route';

export interface DecisionOption {
  key: string;                           // "follow", "ignore", "go_car", "go_concourse"
  label: string;
}

export interface DecisionSituation {
  id: SituationId;
  description: string;                   // what the dot knows, plain words
  options: DecisionOption[];
}

/** Odds per option, must sum to 1 within 0.001. */
export type Odds = Record<string, number>;

export const DECISION_TIMEOUT_MS = 2000; // slower than this = default odds + fallback count

/** Rounded facts. Rounding is what lets thousands of dots share one Kev call. */
export interface DecisionContext {
  crowdAtTarget: 'low' | 'medium' | 'high';
  waitMinBucket: number;                 // wait time rounded to 5 minute steps
  minToKickoffBucket: number;            // rounded to 15 minute steps, negative after kickoff
  weather: 'clear' | 'rain' | 'lightning';
  officerOrder: boolean;                 // an officer in range gave an instruction
  alertHeard: boolean;                   // PA or phone alert reached this group
}

/** Stable string built from fanTypeId + situation + context. Same key = same answer. */
export type DecisionKey = string;
export function decisionKey(fanTypeId: FanTypeId, situation: SituationId, c: DecisionContext): DecisionKey {
  return [fanTypeId, situation, c.crowdAtTarget, c.waitMinBucket, c.minToKickoffBucket, c.weather, +c.officerOrder, +c.alertHeard].join('|');
}

/** [A → C] One per distinct key raised in a step. dotIds are the dots waiting on it. */
export interface DecisionAsk {
  key: DecisionKey;
  fanTypeId: FanTypeId;
  situation: SituationId;
  context: DecisionContext;
  dotIds: number[];
}

/** [C → A] One per key. */
export interface DecisionAnswer {
  key: DecisionKey;
  odds: Odds;
  source: 'kev' | 'cache' | 'default';
  model?: string;                        // e.g. "jaredpalmer/kev-4b"
  ms?: number;                           // Kev time, for the deciding indicator
}

/** Shipped with the app. Used for timeouts, errors, and odds that do not add up. */
export interface DecisionDefaults {
  version: typeof CONTRACT_VERSION;
  situations: DecisionSituation[];
  defaults: Record<SituationId, Odds>;
}

/** Every answer a run used, in order. Replay feeds this back instead of calling Kev. */
export interface DecisionTape {
  runId: Id;
  answers: { t: SimSeconds; answer: DecisionAnswer }[];
}

// ─────────────────── Incidents and responders [B] ──────────────────

export type IncidentKind = 'game_end' | 'lightning_delay' | 'gate_surge' | 'suspicious_package' | 'medical' | 'fight';

export interface Incident {
  id: Id;
  kind: IncidentKind;
  at: SimSeconds;                        // when it triggers
  placeId?: Id;                          // where, if it has a place
  cells?: number[];                      // affected zone
  safeCount?: number;                    // zone counts as "clear" at or below this
  note?: string;
}

export interface Officer {
  id: Id;
  unit: string;                          // "OSU PD 12", label only
  cell: number;
  radiusCells: number;                   // how far their instruction reaches
  speedMps: number;
}

/** One step in a response plan. B applies these through WorldHooks. */
export type PlanAction =
  | { at: SimSeconds; type: 'close'; closableId: Id }
  | { at: SimSeconds; type: 'open'; closableId: Id }
  | { at: SimSeconds; type: 'send_officers'; count: number; toPlaceId: Id }
  | { at: SimSeconds; type: 'hold_officers'; officerIds: Id[] }
  | { at: SimSeconds; type: 'alert'; channel: 'pa' | 'phone'; message: string; reachShare: number; zoneCells?: number[] }
  | { at: SimSeconds; type: 'redirect'; fromPlaceId: Id; toPlaceId: Id }
  | { at: SimSeconds; type: 'shelter_order'; shelterPlaceIds: Id[] };

export interface ResponsePlan {
  id: Id;
  name: string;                          // "Open Gate 20, PA alert, 6 officers to Gate 10"
  forIncident: IncidentKind;
  actions: PlanAction[];                 // times are relative to Incident.at
  officersAvailable: number;
}

// ───────────────────────── Run setup [D → A] ───────────────────────

export interface SimConfig {
  runId: Id;
  label: 'A' | 'B' | 'C';
  seed: number;                          // SAME seed for all plans in a comparison
  startAt: SimSeconds;                   // e.g. kickoff minus 3600
  endAt: SimSeconds;
  speed: number;                         // wall pacing only, 1..60
  dangerDensity: number;                 // people per square meter
  mapId: Id;
  incident: Incident;
  plan: ResponsePlan;
  officers: Officer[];
  startFrom?: Snapshot;                  // later: built from sensor zone counts
  traffic?: TrafficConfig;               // v2: absent = pedestrians only
  weather?: WeatherTimeline;             // v2: absent = clear all day
}

// ─────────────────────────── Engine output [A] ─────────────────────

export type DotState = 'arriving' | 'tailgating' | 'queued' | 'walking' | 'seated' | 'sheltering' | 'leaving' | 'gone';

/** Packed for transfer to the main thread. Index i = dot i. */
export interface TickFrame {
  runId: Id;
  t: SimSeconds;
  x: Float32Array;                       // meters
  y: Float32Array;
  state: Uint8Array;                     // index into DOT_STATES
  officerCells: Int32Array;
  vehicles?: VehicleFrame;               // v2
  weather?: WeatherState;                // v2
}
export const DOT_STATES: DotState[] = ['arriving', 'tailgating', 'queued', 'walking', 'seated', 'sheltering', 'leaving', 'gone'];

export interface DensityGrid {
  t: SimSeconds;
  width: number;
  height: number;
  peoplePerM2: Float32Array;             // per cell
}

/** Everything needed to restart a run exactly. No functions, no closures. */
export interface Snapshot {
  version: typeof CONTRACT_VERSION;
  t: SimSeconds;
  rngState: number[];
  dots: { x: Float32Array; y: Float32Array; state: Uint8Array; typeIndex: Uint16Array; targetPlace: Int32Array };
  officers: Officer[];
  closed: Id[];
}

/** Why a dot did something. Shown when the commander clicks a dot. */
export interface DecisionRecord {
  dot: number;
  t: SimSeconds;
  fanTypeId: FanTypeId;
  situation: SituationId;
  key: DecisionKey;
  odds: Odds;
  picked: string;
  source: 'kev' | 'cache' | 'default';
}

// ───────────────── Hooks between engine and world [A ↔ B] ─────────

/** A calls these every step. B implements them. Keep them pure and fast. */
export interface WorldHooks {
  /** Apply plan actions and incident effects that are due at time t. */
  onStep(t: SimSeconds, world: WorldView, act: WorldActions): void;
}

/** Read only view A gives B. */
export interface WorldView {
  map: MapBundle;
  density: DensityGrid;
  officers: readonly Officer[];
  dotsInCells(cells: number[]): number;
}

/** The only ways B may change the world. */
export interface WorldActions {
  setClosed(closableId: Id, closed: boolean): void;
  moveOfficer(officerId: Id, toCell: number): void;
  /** Raise a decision for dots in these cells (or all dots if omitted). A turns them into DecisionAsk lists for Lane C. */
  raiseSituation(situation: SituationId, cells?: number[], reachShare?: number): void;
  setTarget(fromPlaceId: Id, toPlaceId: Id): void;
}

// ────────────────────────── Scoring [B] ────────────────────────────

export interface Scorecard {
  runId: Id;
  planId: Id;
  label: 'A' | 'B' | 'C';
  timeToClearMin: number | null;         // null = never cleared before endAt
  peakDensity: number;                   // people per square meter
  dangerMinutes: number;                 // cell minutes above dangerDensity
  firstOfficerMin: number | null;
  officerMinutesUsed: number;
  fansNotReached: number;                // people, not dots
  fallbackDecisions: number;             // decisions that used defaults
  // v2, present when the run had traffic:
  emergencyResponseMin?: number | null;  // ambulance from the map edge to the incident; null = never got there
  vehicleDelayMin?: number;              // vehicle minutes spent stopped
  peakVehiclesStopped?: number;          // most vehicles stopped at one moment
  vehiclesOut?: number;                  // vehicles that drove off the map during the window
}

// ───────────────────────── Briefing [C] ────────────────────────────

export interface BriefingRequest {
  incident: Incident;
  plans: ResponsePlan[];
  scorecards: Scorecard[];
}

export interface Briefing {
  text: string;                          // plain words, may only cite numbers present in scorecards
  model: string;
  canned: boolean;                       // true = AI failed, template used
}

// ─────────────── Worker messages [D ↔ A, in the browser] ───────────

export type WorkerIn =
  | { type: 'init'; config: SimConfig; map: MapBundle; population: Population; defaults: DecisionDefaults; serverUrl: string; replay?: DecisionTape }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'speed'; speed: number }
  | { type: 'seek'; t: SimSeconds }       // restore nearest snapshot, then step forward
  | { type: 'snapshot' };

export type WorkerOut =
  | { type: 'ready'; runId: Id }
  | { type: 'frame'; frame: TickFrame; density?: DensityGrid } // transfer the typed array buffers
  | { type: 'decision'; record: DecisionRecord }
  | { type: 'deciding'; t: SimSeconds; pendingKeys: number }  // sim time is waiting on Kev
  | { type: 'tape'; tape: DecisionTape }
  | { type: 'snapshot'; snapshot: Snapshot }
  | { type: 'done'; scorecard: Scorecard }
  | { type: 'error'; message: string };

// ──────────────────────── Server API [D] ───────────────────────────
// Base path /api on the Mac. JSON in and out. The server talks to Kev on localhost:8009.

export interface Api {
  'GET /maps/:id': { res: MapBundle };
  'GET /decision-defaults': { res: DecisionDefaults };
  /** Cache first, then Kev. Answers every key, falling back to defaults past DECISION_TIMEOUT_MS. */
  'POST /decide': { req: { runId: Id; asks: DecisionAsk[] }; res: { answers: DecisionAnswer[] } };
  'GET /plans?incident=:kind': { res: ResponsePlan[] };
  'POST /plans': { req: ResponsePlan; res: { id: Id } };
  'POST /comparisons': { req: { incident: Incident; scorecards: Scorecard[] }; res: { id: Id } };
  'GET /comparisons/:id': { res: { incident: Incident; scorecards: Scorecard[]; briefing?: Briefing } };
  'POST /briefing': { req: BriefingRequest; res: Briefing };
}
