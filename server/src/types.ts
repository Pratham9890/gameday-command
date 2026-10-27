/**
 * Gameday Command v3 platform types (workstream WS3).
 *
 * Shared by the server and the browser client: `app/src/platform/types.ts`
 * re-exports this file. Keep it pure (no Node imports) so the app can bundle
 * it. Additive to `contracts.ts`, which this file never edits.
 */
import type { IncidentKind, ResponsePlan, Scorecard } from '../../contracts.ts';

export const PLATFORM_API_VERSION = '3.0.0';
export const PACKAGE_FORMAT = 'gameday.package';
/** SemVer of the package file schema (PLT-45). MAJOR = incompatible. */
export const PACKAGE_SCHEMA_VERSION = '1.0.0';
export const EVENT_PROTOCOL = 'gameday.events.1';

// ───────────────────────────── Positions and permissions ─────────────────────────────

/** ICS positions held per event or exercise (PLAN §1, research 06 §2.3). */
export const ICS_POSITIONS = [
  'incident_commander',
  'unified_command',
  'operations_chief',
  'planning_chief',
  'logistics_chief',
  'safety_officer',
  'pio',
  'liaison_officer',
  'division_supervisor',
  'traffic',
  'gates',
  'ems_liaison',
  'rtcc_analyst',
  'field_unit',
] as const;
/** HSEEP exercise roles. */
export const EXERCISE_ROLES = ['exercise_director', 'controller', 'evaluator', 'player', 'observer'] as const;
export const ADMIN_ROLES = ['records', 'admin'] as const;
export const DISPLAY_ROLES = ['display'] as const;
export const POSITIONS = [...ICS_POSITIONS, ...EXERCISE_ROLES, ...ADMIN_ROLES, ...DISPLAY_ROLES] as const;
export type Position = (typeof POSITIONS)[number];

/** Plain NIMS titles, as products and the UI print them. */
export const POSITION_LABELS: Record<Position, string> = {
  incident_commander: 'Incident Commander',
  unified_command: 'Unified Command member',
  operations_chief: 'Operations Section Chief',
  planning_chief: 'Planning Section Chief',
  logistics_chief: 'Logistics Section Chief',
  safety_officer: 'Safety Officer',
  pio: 'Public Information Officer',
  liaison_officer: 'Liaison Officer',
  division_supervisor: 'Division/Group Supervisor',
  traffic: 'Traffic Unit',
  gates: 'Gate and Perimeter Supervisor',
  ems_liaison: 'EMS Liaison',
  rtcc_analyst: 'RTCC Analyst',
  field_unit: 'Field Unit',
  exercise_director: 'Exercise Director',
  controller: 'Controller',
  evaluator: 'Evaluator',
  player: 'Player',
  observer: 'Observer',
  records: 'Records Custodian',
  admin: 'System Administrator',
  display: 'Read-only Display',
};

export const PERMISSIONS = [
  // Event log and collaboration
  'event.read',
  'presence.announce',
  'order.simulate',
  'assignment.write',
  'assignment.respond',
  'report.create',
  'report.decide',
  'note.log',
  'decision.record',
  'incident.declare',
  // Documents
  'plan.read',
  'plan.write',
  'plan.review',
  'plan.approve',
  'scenario.read',
  'scenario.write',
  'scenario.review',
  'scenario.approve',
  'exercise.read',
  'exercise.write',
  'exercise.review',
  'exercise.approve',
  'exercise.control',
  'exercise.evaluate',
  'msel.read',
  'comparison.read',
  'comparison.write',
  // Products
  'product.export',
  'product.export.restricted',
  'cap.draft',
  // Feeds and video
  'feed.read',
  'feed.configure',
  'video.view',
  // Security administration
  'audit.read',
  'audit.verify',
  'audit.checkpoint',
  'user.manage',
  'grant.manage',
  'session.revoke',
  'display.manage',
  'allowlist.manage',
  // The v2 routes under /api
  'legacy.read',
  'legacy.compute',
  'legacy.write',
  'stadium.import',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** One position held by one account in one scope (an event or exercise id, or `*`). */
export interface Grant {
  id: string;
  userId: string;
  position: Position;
  scope: string;
  /** Unit or division the position is tied to: "OSU PD 12", "Division A". */
  unit: string | null;
  grantedBy: string;
  grantedAt: string;
}

export interface ActorGrant {
  position: Position;
  scope: string;
  unit: string | null;
}

/** Who is making a request, after authentication. */
export interface Actor {
  userId: string;
  username: string;
  displayName: string;
  /** `demo`: GAMEDAY_DEMO; `local`: first-run loopback before any account exists; `display`: a wallboard grant. */
  kind: 'user' | 'display' | 'demo' | 'local';
  grants: ActorGrant[];
  sessionId?: string;
}

/** What `can()` is asked about. Every field is optional. */
export interface Resource {
  scope?: string;
  /** For assignments: the unit and division it is for. */
  unit?: string | null;
  division?: string | null;
  classification?: Classification;
}

export type AuthMode = 'demo' | 'setup' | 'accounts';

export interface SessionInfo {
  authenticated: boolean;
  mode: AuthMode;
  /** True before any account exists: run `npm run admin:create`. */
  setupRequired: boolean;
  demo: { label: string } | null;
  user: { id: string; username: string; displayName: string; mfaEnrolled: boolean; kind: Actor['kind'] } | null;
  grants: ActorGrant[];
  /** Permissions per scope, so a client can hide what it cannot do. The server still checks every call. */
  permissions: Record<string, Permission[]>;
  stage: 'full' | 'mfa_enrolment' | null;
  csrfToken: string | null;
  absoluteExpiresAt: string | null;
  idleExpiresAt: string | null;
  serverTime: string;
  policy: { absoluteHours: number; idleMinutes: number; mfa: 'required' | 'optional' };
}

export interface LoginRequest {
  username: string;
  password: string;
  totp?: string;
}

// ───────────────────────────── Event log (PLAN §5.6) ─────────────────────────────

export type EventMode = 'plan' | 'rehearse' | 'exercise' | 'live';
export const EVENT_MODES: readonly EventMode[] = ['plan', 'rehearse', 'exercise', 'live'];

export const EVENT_TYPES = [
  'assignment.created',
  'assignment.updated',
  'assignment.reassigned',
  'assignment.acknowledged',
  'assignment.completed',
  'assignment.cancelled',
  'unit.status',
  'report.created',
  'report.decided',
  'order.simulated',
  'decision.recorded',
  'note.logged',
  'incident.declared',
  'incident.updated',
  'inject.released',
  'observation.recorded',
  'exercise.started',
  'exercise.paused',
  'exercise.ended',
  'feed.viewed',
  'document.reviewed',
  'document.approved',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface EventActor {
  userId: string;
  position: Position | 'system';
}

/** The envelope every event carries, over REST, WebSocket and BroadcastChannel alike. */
export interface EventEnvelope<P = unknown> {
  /** Server sequence within the whole log: strictly increasing, gap-free per server. */
  seq: number;
  /** Client-chosen UUID; also the idempotency key. */
  id: string;
  stream: string;
  type: EventType;
  actor: EventActor;
  serverTime: string;
  clientTime: string | null;
  simTime?: number;
  mode: EventMode;
  causedBy?: string;
  payload: P;
  /** SHA-256 chain over the previous event's hash and this event's canonical JSON. */
  hash: string;
}

export interface AppendRequest<P = unknown> {
  id: string;
  stream: string;
  type: EventType;
  mode: EventMode;
  payload: P;
  clientTime?: string;
  simTime?: number;
  causedBy?: string;
  /** Which of the actor's positions this is done as. Defaults to the first that may. */
  asPosition?: Position;
}

export interface AppendResult {
  event: EventEnvelope;
  duplicate: boolean;
  warnings?: FreeTextWarning[];
}

export interface PlaceRef {
  placeId?: string;
  cell?: number;
  name?: string;
}

export type AssignmentPriority = 'routine' | 'priority' | 'urgent';
export type UnitStatus = 'available' | 'assigned' | 'en_route' | 'on_scene' | 'returning' | 'out_of_service';
export type ReportKind = 'backup' | 'crowd_crush' | 'medical' | 'fight' | 'traffic' | 'suspicious_item' | 'other';

/** Payloads by event type. Free-text fields are marked; they raise warnings and are left out of exports by default. */
export interface EventPayloads {
  'assignment.created': { assignmentId: string; unit: string; division?: string; task: string; place?: PlaceRef; priority?: AssignmentPriority };
  'assignment.updated': { assignmentId: string; expectedVersion: number; task?: string; place?: PlaceRef; priority?: AssignmentPriority; division?: string };
  'assignment.reassigned': { assignmentId: string; expectedVersion: number; unit: string; division?: string };
  'assignment.acknowledged': { assignmentId: string; version: number };
  'assignment.completed': { assignmentId: string; version: number };
  'assignment.cancelled': { assignmentId: string; expectedVersion: number; reason?: 'no_longer_needed' | 'duplicate' | 'superseded' | 'other' };
  'unit.status': { unit: string; status: UnitStatus; place?: PlaceRef };
  'report.created': { reportId: string; kind: ReportKind; unit?: string; place?: PlaceRef; priority?: AssignmentPriority };
  'report.decided': { reportId: string; decision: 'accepted' | 'dismissed' | 'assigned'; assignmentId?: string };
  /** Today's `PoliceOrder` (engine/src/edits.ts) for one plan's run. */
  'order.simulated': { runId?: string; planLabel?: 'A' | 'B' | 'C'; order: { type: string } & Record<string, unknown> };
  /** `rationale` is free text. */
  'decision.recorded': { title: string; choice: string; rationale?: string; comparisonId?: string };
  /** `text` is free text. */
  'note.logged': { text: string; unit?: string };
  'incident.declared': { incidentId: string; kind: IncidentKind; place?: PlaceRef; severity?: 'minor' | 'moderate' | 'major' };
  'incident.updated': { incidentId: string; status: 'active' | 'contained' | 'closed' };
  'inject.released': { injectId: string; mselNumber?: string; title: string; to?: Position[] };
  /** Evaluator notes; `text` is free text. Hidden from players and observers. */
  'observation.recorded': { observationId: string; objectiveId?: string; capability?: string; text: string; rating?: 'P' | 'S' | 'M' | 'U' };
  'exercise.started': { exerciseId: string };
  'exercise.paused': { exerciseId: string };
  'exercise.ended': { exerciseId: string };
  'feed.viewed': { feedId: string; action: 'start' | 'stop' };
  'document.reviewed': { documentId: string; kind: DocumentKind; version: number; name: string };
  'document.approved': { documentId: string; kind: DocumentKind; version: number; name: string };
}

export interface AssignmentState {
  assignmentId: string;
  stream: string;
  version: number;
  unit: string;
  division: string | null;
  task: string;
  place: PlaceRef | null;
  priority: AssignmentPriority;
  status: 'assigned' | 'acknowledged' | 'completed' | 'cancelled';
  acknowledged: { userId: string; position: string; seq: number; at: string } | null;
  createdSeq: number;
  updatedSeq: number;
}

export interface PresenceEntry {
  stream: string;
  userId: string;
  displayName: string;
  position: Position;
  unit: string | null;
  status: 'online' | 'away';
  since: string;
  lastHeard: string;
}

/** WebSocket frames from the server. */
export type ServerFrame =
  | { t: 'hello'; protocol: typeof EVENT_PROTOCOL; serverTime: string; demo: boolean; actor: { userId: string; displayName: string; grants: ActorGrant[] }; heartbeatMs: number }
  | { t: 'event'; event: EventEnvelope }
  | { t: 'replayed'; stream: string; lastSeq: number }
  | { t: 'subscribed'; stream: string; since: number }
  | { t: 'ack'; id: string; seq: number; duplicate: boolean; warnings?: FreeTextWarning[] }
  | { t: 'nack'; id: string; status: number; error: string; message: string; current?: unknown }
  | { t: 'presence'; stream: string; entries: PresenceEntry[] }
  | { t: 'pong'; id: string; clientTime: number; serverReceived: number; serverSent: number }
  | { t: 'error'; error: string; message: string; stream?: string }
  | { t: 'revoked'; reason: string };

/** WebSocket frames from a client. */
export type ClientFrame =
  | { t: 'subscribe'; stream: string; since?: number }
  | { t: 'unsubscribe'; stream: string }
  | { t: 'append'; event: AppendRequest }
  | { t: 'presence'; stream: string; position: Position; status?: 'online' | 'away' }
  | { t: 'ping'; id: string; clientTime: number };

// ───────────────────────────── Documents: scenarios, plans, exercises ─────────────────────────────

export type DocumentKind = 'scenario' | 'plan' | 'exercise';
export const DOCUMENT_KINDS: readonly DocumentKind[] = ['scenario', 'plan', 'exercise'];
export type DocumentStatus = 'draft' | 'reviewed' | 'approved';
/** Research 06 §2.5. Restricted = need-to-know; every view and export is audited. */
export type Classification = 'public' | 'internal' | 'restricted';
export const CLASSIFICATIONS: readonly Classification[] = ['public', 'internal', 'restricted'];

export interface PersonStamp {
  userId: string;
  name: string;
  position: string | null;
  at: string;
}

export interface DocumentVersion<B = unknown> {
  id: string;
  kind: DocumentKind;
  version: number;
  /** Saves of this version while it was a draft; the compare-and-set token. */
  revision: number;
  status: DocumentStatus;
  scope: string;
  name: string;
  classification: Classification;
  author: PersonStamp;
  created: string;
  updated: string;
  reviewedBy: PersonStamp | null;
  approvedBy: PersonStamp | null;
  parentVersion: number | null;
  bodyHash: string;
  body: B;
  importedFrom: { packageHash: string; version: number; status: DocumentStatus; approvedBy: string | null } | null;
}

export type DocumentSummary = Omit<DocumentVersion, 'body'>;

export interface PlanDocumentBody {
  /** Today's playbook plan, exactly as the engine runs it. */
  responsePlan?: ResponsePlan;
  /** The ICS sections the Event Action Plan prints. */
  ics?: IcsPlanSections;
  /** Free text. */
  notes?: string;
}

export interface ScenarioDocumentBody {
  mapId: string;
  seed: number;
  incident?: { kind: IncidentKind; at: number; placeId?: string; note?: string };
  startAt?: number;
  endAt?: number;
  weatherId?: string;
  traffic?: { vehicles: number; seed: number; emergencyResponse: boolean };
  /** Free text. */
  notes?: string;
}

export interface MselEntry {
  number: string;
  scenarioTime: number;
  type: 'inject' | 'contingency_inject' | 'expected_action';
  mode: 'radio' | 'phone' | 'email' | 'in_person' | 'simulation' | 'other';
  from: string;
  to: string;
  message: string;
  expectedResponse?: string;
  objective?: string;
  notes?: string;
}

export interface ExerciseDocumentBody {
  title: string;
  objectives: { id: string; text: string; coreCapability?: string }[];
  msel: MselEntry[];
  scenarioRef?: { id: string; version: number };
  planRefs?: { id: string; version: number }[];
  notes?: string;
}

export interface PackageDocument {
  id: string;
  kind: DocumentKind;
  version: number;
  status: DocumentStatus;
  name: string;
  scope: string;
  classification: Classification;
  author: string;
  created: string;
  updated: string;
  reviewedBy: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  parentVersion: number | null;
  bodyHash: string;
  body: unknown;
}

/** The import/export file (PLT-45): schema version, engine version, seed and definitions. */
export interface PackageFile {
  format: typeof PACKAGE_FORMAT;
  schemaVersion: string;
  contractVersion: string;
  engineVersion: string;
  exportedAt: string;
  exportedBy: { userId: string; position: string | null };
  seed: number | null;
  classification: Classification;
  documents: PackageDocument[];
  comparisons: ComparisonRecord[];
  integrity: { algorithm: 'sha256'; hash: string };
}

/** A comparison stored with everything needed to reproduce it (PLT-37, PLT-45). */
export interface ComparisonRecord {
  id: string;
  scope: string;
  incident: { id: string; kind: IncidentKind; at: number; placeId?: string; note?: string };
  scorecards: Scorecard[];
  seed: number;
  seeds: number[] | null;
  tapeHash: string | null;
  engineVersion: string;
  contractVersion: string;
  mapId: string;
  planRefs: { planId: string; label: 'A' | 'B' | 'C'; documentId?: string; version?: number }[];
  scenarioRef: { id: string; version: number } | null;
  createdBy: PersonStamp;
  createdAt: string;
}

// ───────────────────────────── Provenance and feeds ─────────────────────────────

/** PLAN §5.7 provenance tag, plus the feed fields research 06 §4 asks for. */
export type ProvenanceKind = 'simulated' | 'estimated' | 'forecast' | 'assumed' | 'default' | 'observed';
export interface Provenance {
  kind: ProvenanceKind;
  source: string;
  asOf: string | null;
  range?: { low: number; high: number };
  fetchedAt?: string;
  staleAfterS?: number;
  stale?: boolean;
  licence?: string;
  url?: string;
}

export type UsUnit = 'degF' | 'mph' | 'percent' | 'inHg' | 'mi' | 'in' | 'deg';

/** One value in US units. `value: null` is unknown, never zero; `reason` says why. */
export interface Measured {
  value: number | null;
  unit: UsUnit;
  reason?: 'missing' | 'failed_quality_control' | 'unknown_unit' | 'calm';
  qc?: string;
  provenance: Provenance;
}

export interface WeatherObservation {
  station: { id: string; name: string | null } | null;
  observedAt: string | null;
  description: string | null;
  temperatureF: Measured;
  dewpointF: Measured;
  relativeHumidityPct: Measured;
  heatIndexF: Measured;
  windChillF: Measured;
  windSpeedMph: Measured;
  windGustMph: Measured;
  windFromDeg: Measured;
  windFromCompass: string | null;
  visibilityMi: Measured;
  pressureInHg: Measured;
  precipLastHourIn: Measured;
  /** Lightning is not in the NWS API: always unknown here, never "no lightning". */
  lightning: { value: null; reason: 'not_in_feed'; provenance: Provenance };
  provenance: Provenance;
}

export interface HourlyPeriod {
  startTime: string;
  endTime: string;
  isDaytime: boolean | null;
  temperatureF: number | null;
  windSpeedMph: { low: number | null; high: number | null };
  windFrom: string | null;
  precipChancePct: number | null;
  relativeHumidityPct: number | null;
  dewpointF: number | null;
  shortForecast: string | null;
}

export interface WeatherAlert {
  id: string;
  event: string;
  headline: string | null;
  severity: string;
  urgency: string;
  certainty: string;
  status: string;
  messageType: string;
  sent: string | null;
  effective: string | null;
  onset: string | null;
  expires: string | null;
  ends: string | null;
  senderName: string | null;
  areaDesc: string;
  description: string | null;
  instruction: string | null;
  response: string | null;
}

export type FeedStatus = 'ok' | 'stale' | 'unavailable' | 'not_configured' | 'disabled';

export interface WeatherReport {
  feed: 'nws';
  status: FeedStatus;
  venue: { name: string; lat: number; lon: number };
  point: {
    gridId: string;
    gridX: number;
    gridY: number;
    forecastZone: string | null;
    county: string | null;
    timeZone: string | null;
    stations: string[];
    resolvedAt: string;
  } | null;
  observation: WeatherObservation | null;
  hourly: { periods: HourlyPeriod[]; provenance: Provenance } | null;
  alerts: { items: WeatherAlert[]; provenance: Provenance } | null;
  errors: { part: string; message: string; at: string }[];
  attribution: string;
  units: 'us';
  generatedAt: string;
}

export interface AllowlistEntry {
  host: string;
  ports: number[];
  httpsOnly: boolean;
  note: string;
  addedBy: string;
  addedAt: string;
}

// ───────────────────────────── Audit ─────────────────────────────

export const AUDIT_ACTIONS = [
  'auth.login',
  'auth.logout',
  'auth.mfa.enrol',
  'auth.mfa.reset',
  'auth.password.change',
  'session.revoke',
  'session.expire',
  'user.create',
  'user.update',
  'grant.create',
  'grant.revoke',
  'display.create',
  'display.pair',
  'display.revoke',
  'document.create',
  'document.update',
  'document.review',
  'document.return',
  'document.approve',
  'document.view',
  'package.import',
  'package.export',
  'comparison.create',
  'product.export',
  'cap.draft',
  'video.view.start',
  'video.view.stop',
  'feed.refresh',
  'allowlist.add',
  'allowlist.remove',
  'outbound.blocked',
  'access.denied',
  'audit.checkpoint',
  'audit.verify',
  'admin.bootstrap',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export type AuditDetail = Record<string, string | number | boolean | null>;

export interface AuditEntry {
  seq: number;
  at: string;
  actor: { userId: string | null; name: string | null; position: string | null };
  action: AuditAction;
  target: string | null;
  outcome: 'success' | 'failure' | 'denied';
  detail: AuditDetail;
  prevHash: string;
  hash: string;
}

export interface AuditCheckpoint {
  seq: number;
  hash: string;
  at: string;
  keyId: string;
  /** Ed25519 public key, SPKI DER in base64. */
  publicKey: string;
  signature: string;
}

export interface AuditProblem {
  seq: number;
  kind: 'hash_mismatch' | 'broken_link' | 'gap' | 'checkpoint_mismatch' | 'bad_signature' | 'untrusted_key' | 'truncated';
  message: string;
}

export interface AuditVerification {
  ok: boolean;
  entries: number;
  lastSeq: number;
  lastHash: string;
  checkpoints: { total: number; verified: number };
  problems: AuditProblem[];
  verifiedAt: string;
}

export interface FreeTextWarning {
  field: string;
  kind: 'email' | 'phone' | 'ssn' | 'plate' | 'dob' | 'case_number' | 'personal_title';
  message: string;
}

// ───────────────────────────── Products (ICS, EAP, sitrep, GIS, CAP, AAR) ─────────────────────────────

/** The banner on every product page. */
export type ProductMode = 'exercise' | 'simulation';

export interface ProductMeta {
  agency?: string;
  incidentName: string;
  incidentNumber?: string;
  operationalPeriod?: { from: string; to: string };
  preparedBy: { name: string; position: string; at?: string };
  /** null or absent = not approved; the footer then says so. */
  approvedBy?: { name: string; position: string; at?: string } | null;
  version: string;
  classification: Classification;
  /** An agency marking to print instead of the default text for the class. */
  classificationText?: string;
  mode: ProductMode;
  exerciseName?: string;
  generatedAt?: string;
  /** Set by the server in demo mode: adds a DEMO — SYNTHETIC DATA banner. */
  demo?: boolean;
}

export interface OrgRow {
  role: string;
  name: string;
  agency?: string;
}

export interface Ics201Input {
  meta: ProductMeta;
  initiatedAt: string;
  situationSummary: string;
  healthSafetyBriefing?: string;
  objectives: string[];
  actions: { time: string; action: string }[];
  organization: OrgRow[];
  resources: { resource: string; identifier: string; orderedAt?: string; eta?: string; arrived?: boolean; notes?: string }[];
  /** Optional sketch drawn from map features. */
  map?: GeoExportInput;
}

export interface Ics203Section {
  title: string;
  rows: OrgRow[];
}

export interface Ics204Assignment {
  branch?: string;
  division?: string;
  group?: string;
  stagingArea?: string;
  operationsPersonnel: { role: string; name: string; contact?: string }[];
  resources: { identifier: string; leader?: string; persons?: number; contact?: string; reportingLocation?: string; equipment?: string; remarks?: string }[];
  workAssignments: string[];
  specialInstructions?: string;
  communications: { function: string; contact: string }[];
}

export interface Ics205Channel {
  zoneGroup?: string;
  channel?: string;
  function: string;
  channelName: string;
  assignment?: string;
  rxFreq?: string;
  rxTone?: string;
  txFreq?: string;
  txTone?: string;
  mode?: 'A' | 'D' | 'M';
  remarks?: string;
}

/** The radio plan prints only what the agency's Communications Unit entered. */
export interface Ics205Plan {
  source: 'agency';
  enteredBy?: string;
  channels: Ics205Channel[];
  specialInstructions?: string;
}

export interface Ics206Plan {
  aidStations: { name: string; location: string; contact?: string; paramedicsOnSite?: boolean }[];
  transportation: { service: string; location?: string; contact?: string; level?: 'ALS' | 'BLS' }[];
  hospitals: { name: string; address?: string; contact?: string; travelTimeGround?: string; travelTimeAir?: string; traumaCenter?: string | null; burnCenter?: boolean; helipad?: boolean }[];
  specialProcedures?: string;
  aviationAssets?: boolean;
}

export interface Ics208Plan {
  message: string;
  hazards?: { hazard: string; mitigation: string }[];
  siteSafetyPlanRequired?: boolean;
  siteSafetyPlanLocation?: string;
}

/** Everything an Event Action Plan prints, per operational period. */
export interface IcsPlanSections {
  objectives: string[];
  commandEmphasis?: string;
  situationalAwareness?: string;
  weatherSummary?: string;
  siteSafetyPlanRequired?: boolean;
  siteSafetyPlanLocation?: string;
  organization?: Ics203Section[];
  assignments?: Ics204Assignment[];
  radio?: Ics205Plan;
  medical?: Ics206Plan;
  safety?: Ics208Plan;
}

export interface Ics202Input { meta: ProductMeta; sections: IcsPlanSections }
export interface Ics203Input { meta: ProductMeta; organization: Ics203Section[] }
export interface Ics204Input { meta: ProductMeta; assignments: Ics204Assignment[] }
export interface Ics205Input { meta: ProductMeta; radio: Ics205Plan | null }
export interface Ics206Input { meta: ProductMeta; medical: Ics206Plan }
export interface Ics208Input { meta: ProductMeta; safety: Ics208Plan }

export interface Ics214Input {
  meta: ProductMeta;
  name: string;
  position: string;
  homeAgency?: string;
  resourcesAssigned?: { name: string; position: string; homeAgency?: string }[];
  entries: { at: string; activity: string }[];
}

/** The simulation annex printed with every simulation-backed product (PLT-37). */
export interface SimulationAnnex {
  comparisonId?: string;
  scorecards: Scorecard[];
  planNames?: Record<string, string>;
  assumptions: string[];
  seed: number;
  seeds?: number[];
  tapeHash: string | null;
  engineVersion: string;
  contractVersion?: string;
  mapId?: string;
  planVersions?: { label: string; documentId?: string; version?: number }[];
  notes?: string[];
}

export interface EapInput {
  meta: ProductMeta;
  sections: IcsPlanSections;
  annex?: SimulationAnnex;
  map?: GeoExportInput;
}

export interface SitrepInput {
  meta: ProductMeta;
  number?: number;
  asOf: string;
  summary: string;
  keyFigures: { label: string; value: number | string | null; unit?: string; provenance: Provenance }[];
  weather?: WeatherReport | null;
  events?: { at: string; text: string }[];
  resources?: { kind: string; committed: number | null; available: number | null; outOfService?: number | null }[];
  actionsTaken: string[];
  plannedActions: string[];
  issues?: string[];
  nextReportAt?: string;
}

/** Features to export as GeoJSON/KML, in the map's own cells. */
export interface GeoExportInput {
  mapId: string;
  closures?: { id: string; name?: string; closableId?: string; cells?: number[]; blocks?: 'all' | 'vehicles' | 'pedestrians'; status?: 'closed' | 'planned' }[];
  posts?: { id: string; unit: string; position?: string; cell: number }[];
  zones?: { id: string; name?: string; kind?: string; placeId?: string; cells?: number[] }[];
  markers?: { id: string; kind: 'staging' | 'medical' | 'pa' | 'incident' | 'other'; name: string; cell: number; radiusCells?: number }[];
  /** Export every gate and closable on the map as well. */
  includeMapFeatures?: boolean;
  provenance: { kind: ProvenanceKind | 'planned'; source: string; runId?: string; seed?: number; engineVersion?: string; tapeHash?: string; planId?: string; planVersion?: number };
  classification?: Classification;
}

export type CapCategory = 'Geo' | 'Met' | 'Safety' | 'Security' | 'Rescue' | 'Fire' | 'Health' | 'Env' | 'Transport' | 'Infra' | 'CBRNE' | 'Other';
export type CapResponseType = 'Shelter' | 'Evacuate' | 'Prepare' | 'Execute' | 'Avoid' | 'Monitor' | 'Assess' | 'AllClear' | 'None';

export interface CapInfoInput {
  language?: string;
  category: CapCategory[];
  event: string;
  responseType?: CapResponseType[];
  urgency: 'Immediate' | 'Expected' | 'Future' | 'Past' | 'Unknown';
  severity: 'Extreme' | 'Severe' | 'Moderate' | 'Minor' | 'Unknown';
  certainty: 'Observed' | 'Likely' | 'Possible' | 'Unlikely' | 'Unknown';
  audience?: string;
  effective?: string;
  onset?: string;
  expires?: string;
  senderName?: string;
  headline?: string;
  description?: string;
  instruction?: string;
  web?: string;
  contact?: string;
  /** WEA text for the IPAWS profile: 90 and 360 characters. */
  wea?: { short: string; long?: string };
  parameters?: { valueName: string; value: string }[];
  area: { areaDesc: string; polygon?: { lat: number; lon: number }[]; circle?: { lat: number; lon: number; radiusKm: number }; geocodes?: { valueName: string; value: string }[] }[];
}

/** A CAP 1.2 draft. Status is Exercise or Draft only, and nothing is ever sent. */
export interface CapAlertInput {
  identifier?: string;
  sender?: string;
  sent?: string;
  status: 'Exercise' | 'Draft';
  msgType: 'Alert' | 'Update' | 'Cancel';
  scope: 'Public' | 'Restricted' | 'Private';
  restriction?: string;
  addresses?: string;
  exerciseId?: string;
  note?: string;
  references?: string;
  incidents?: string;
  info: CapInfoInput[];
}

export interface CapCheck {
  ok: boolean;
  errors: string[];
  warnings: string[];
  wea: { short: { length: number; limit: 90; ok: boolean } | null; long: { length: number; limit: 360; ok: boolean } | null };
}

export type AarRating = 'P' | 'S' | 'M' | 'U';

/** HSEEP After-Action Report / Improvement Plan skeleton (the exercise model comes later, WS7). */
export interface AarInput {
  meta: ProductMeta;
  exercise: {
    name: string;
    dates: string;
    scope: string;
    type: string;
    missionAreas: string[];
    coreCapabilities: string[];
    objectives: { id: string; text: string }[];
    threatOrHazard: string;
    scenario: string;
    sponsor?: string;
    participatingOrganizations: string[];
    pointsOfContact: { role: string; name: string; organization?: string }[];
  };
  analysis: {
    objectiveId: string;
    coreCapability: string;
    rating: AarRating;
    strengths: string[];
    areasForImprovement: { title: string; observation: string; reference?: string; analysis?: string }[];
  }[];
  improvementPlan: {
    coreCapability: string;
    issue: string;
    correctiveAction: string;
    capabilityElement: 'Planning' | 'Organization' | 'Equipment' | 'Training' | 'Exercise';
    primaryResponsibleOrganization: string;
    organizationPoc: string;
    startDate: string;
    completionDate: string;
  }[];
  annex?: SimulationAnnex;
}

export const PRODUCT_KINDS = [
  'ics201',
  'ics202',
  'ics203',
  'ics204',
  'ics205',
  'ics206',
  'ics208',
  'ics214',
  'eap',
  'annex',
  'sitrep',
  'geojson',
  'kml',
  'cap',
  'aar',
] as const;
export type ProductKind = (typeof PRODUCT_KINDS)[number];

export interface ApiError {
  error: string;
  message: string;
  [key: string]: unknown;
}
