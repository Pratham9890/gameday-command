import type { AarInput, CapAlertInput, EapInput, GeoExportInput, Ics201Input, Ics214Input, IcsPlanSections, ProductMeta, SimulationAnnex, SitrepInput } from '../types.ts';

/**
 * Sample inputs for tests, the screenshot check and the API docs. Synthetic:
 * people are placeholders, radio entries name no real frequency, and every
 * number is either a sample scorecard (marked simulated) or left blank for
 * the agency. Never shipped as data.
 */
export const SAMPLE_META: ProductMeta = {
  agency: 'Sample agency (exercise data)',
  incidentName: 'Home football game, Ohio Stadium',
  incidentNumber: 'SAMPLE-2026-1031',
  operationalPeriod: { from: '2026-10-31T09:00:00-04:00', to: '2026-10-31T21:00:00-04:00' },
  preparedBy: { name: 'A. Planner (sample)', position: 'Planning Section Chief', at: '2026-10-29T14:10:00-04:00' },
  approvedBy: { name: 'B. Commander (sample)', position: 'Incident Commander', at: '2026-10-30T09:05:00-04:00' },
  version: '3 (approved)',
  classification: 'internal',
  mode: 'exercise',
  exerciseName: 'Gameday tabletop 1',
};

export const SAMPLE_SECTIONS: IcsPlanSections = {
  objectives: [
    'Keep every gate queue outside the screening lanes below the agreed holding areas from gates open to kickoff.',
    'Hold a clear emergency access route on Lane Avenue and Woody Hayes Drive for the whole operational period.',
    'If lightning is detected within the agency threshold, move spectators to shelter areas and report shelter counts every 10 minutes.',
    'Clear the stadium perimeter of pedestrians and traffic within the planned egress window after the game.',
  ],
  commandEmphasis: 'Gate operations at kickoff and the lightning policy. Unified Command meets at the command post at 08:30 and every two hours after.',
  situationalAwareness: 'A capacity crowd is expected. Fan behaviour figures in the simulation annex are assumptions, not forecasts, and are not part of this plan.',
  weatherSummary: 'See the attached NWS forecast with its issue time. Lightning is monitored by the agency weather monitor; the NWS feed carries no lightning data.',
  siteSafetyPlanRequired: true,
  siteSafetyPlanLocation: 'Command post binder and the shared drive (agency to enter)',
  organization: [
    { title: 'Incident Commander and Command Staff', rows: [{ role: 'Incident Commander', name: 'B. Commander (sample)', agency: 'Agency A' }, { role: 'Unified Command', name: 'C. Partner (sample)', agency: 'Agency B' }, { role: 'Safety Officer', name: 'D. Safety (sample)', agency: 'Agency A' }, { role: 'Public Information Officer', name: 'E. Info (sample)', agency: 'Agency A' }, { role: 'Liaison Officer', name: 'F. Liaison (sample)', agency: 'Agency C' }] },
    { title: 'Planning Section', rows: [{ role: 'Chief', name: 'A. Planner (sample)', agency: 'Agency A' }, { role: 'Situation Unit', name: 'G. Situation (sample)' }, { role: 'Resources Unit', name: 'H. Resources (sample)' }] },
    { title: 'Operations Section', rows: [{ role: 'Chief', name: 'I. Operations (sample)', agency: 'Agency A' }, { role: 'Division A (north gates)', name: 'J. Supervisor (sample)' }, { role: 'Traffic Group', name: 'K. Traffic (sample)', agency: 'Agency B' }] },
    { title: 'Logistics Section', rows: [{ role: 'Chief', name: 'L. Logistics (sample)' }, { role: 'Communications Unit', name: 'M. Comms (sample)' }, { role: 'Medical Unit', name: 'N. Medical (sample)' }] },
  ],
  assignments: [
    {
      branch: 'Ingress',
      division: 'Division A (north gates)',
      stagingArea: 'Lot staging, north (agency to confirm)',
      operationsPersonnel: [{ role: 'Operations Section Chief', name: 'I. Operations (sample)', contact: 'Command talkgroup' }, { role: 'Division/Group Supervisor', name: 'J. Supervisor (sample)', contact: 'Division A talkgroup' }],
      resources: [
        { identifier: 'Unit 12 (sample)', leader: 'Sgt. sample', persons: 4, contact: 'Division A talkgroup', reportingLocation: 'Gate 10', remarks: 'Queue line management' },
        { identifier: 'Unit 14 (sample)', leader: 'Sgt. sample', persons: 4, contact: 'Division A talkgroup', reportingLocation: 'Gate 12' },
        { identifier: 'Bike team 2 (sample)', persons: 2, contact: 'Division A talkgroup', reportingLocation: 'North plaza' },
      ],
      workAssignments: ['Hold the queue lines at Gates 10 to 12 inside the barrier lanes.', 'Report queue length at the bike racks every 15 minutes from gates open.', 'Keep the north emergency access lane clear.'],
      specialInstructions: 'Gate surge plan B applies if a queue passes the bike racks: request the second screening team through Division A.',
      communications: [{ function: 'Division A supervisor', contact: 'Division A talkgroup (see ICS 205)' }, { function: 'Command post', contact: 'Command talkgroup (see ICS 205)' }],
    },
  ],
  radio: {
    source: 'agency',
    enteredBy: 'Communications Unit (sample)',
    channels: [
      { zoneGroup: 'A', channel: '1', function: 'Command', channelName: 'SAMPLE-CMD (trunked talkgroup)', assignment: 'Command and General Staff', mode: 'D', remarks: 'Sample entry: agency to replace' },
      { zoneGroup: 'A', channel: '2', function: 'Tactical', channelName: 'SAMPLE-DIV-A (trunked talkgroup)', assignment: 'Division A', mode: 'D', remarks: 'Sample entry: agency to replace' },
      { zoneGroup: 'A', channel: '3', function: 'Tactical', channelName: 'SAMPLE-TRAFFIC (trunked talkgroup)', assignment: 'Traffic Group', mode: 'D', remarks: 'Sample entry: agency to replace' },
    ],
    specialInstructions: 'Talkgroup assignments come from the agency Communications Unit Leader. No frequencies are printed in this sample.',
  },
  medical: {
    aidStations: [{ name: 'First aid station 1 (sample)', location: 'North concourse (agency to confirm)', paramedicsOnSite: true }, { name: 'First aid station 2 (sample)', location: 'South concourse (agency to confirm)', paramedicsOnSite: true }],
    transportation: [{ service: 'Fire/EMS transport (sample)', location: 'Staged at the north emergency lane', level: 'ALS' }],
    hospitals: [{ name: 'Receiving hospital (agency to enter)', address: 'Agency to enter', traumaCenter: 'Agency to enter' }],
    specialProcedures: 'Medical requests go through the EMS liaison at the command post. Keep the emergency access lane clear at all times.',
  },
  safety: {
    message: 'Watch for crowd pressure at the north gates around kickoff. Officers do not enter a dense crowd alone. Hydrate; the weather monitor announces any lightning threshold.',
    hazards: [
      { hazard: 'Crowd pressure at gate queues', mitigation: 'Barrier lanes, queue monitoring every 15 minutes, gate surge plan B.' },
      { hazard: 'Lightning', mitigation: 'Agency lightning policy; shelter areas assigned in advance; 30-minute wait after the last strike.' },
      { hazard: 'Vehicle traffic near pedestrians', mitigation: 'Hard closures on the emergency lane; high-visibility vests at traffic posts.' },
    ],
    siteSafetyPlanRequired: true,
    siteSafetyPlanLocation: 'Command post binder (agency to enter)',
  },
};

export const SAMPLE_ANNEX: SimulationAnnex = {
  comparisonId: 'sample-comparison',
  scorecards: [
    { runId: 'run-A', planId: 'plan-a', label: 'A', timeToClearMin: 12.5, peakDensity: 4.3, dangerMinutes: 7, firstOfficerMin: 3.2, officerMinutesUsed: 48, fansNotReached: 1500, fallbackDecisions: 12 },
    { runId: 'run-B', planId: 'plan-b', label: 'B', timeToClearMin: 18, peakDensity: 5.1, dangerMinutes: 22, firstOfficerMin: 2.1, officerMinutesUsed: 60, fansNotReached: 900, fallbackDecisions: 12 },
    { runId: 'run-C', planId: 'plan-c', label: 'C', timeToClearMin: null, peakDensity: 3.9, dangerMinutes: 4, firstOfficerMin: null, officerMinutesUsed: 20, fansNotReached: 4100, fallbackDecisions: 12 },
  ],
  planNames: { 'plan-a': 'Open Gate 20, PA alert', 'plan-b': 'Six officers to Gate 10', 'plan-c': 'Hold and redirect to Gate 12' },
  assumptions: [
    'Fan behaviour follows the shipped decision defaults and cached model answers: an assumption, not a forecast.',
    '100,000 fans, simulated as groups of five; arrival windows by fan type as shipped.',
    'Gate service rates are the map’s default throughput, not measured lane counts.',
    'Weather in the run is the scenario’s, not the NWS feed.',
  ],
  seed: 20261031,
  seeds: [20261031, 20261032, 20261033, 20261034, 20261035],
  tapeHash: '3f2a9c1e5b7d4a608e1f2c3d4b5a69788796a5b4c3d2e1f00112233445566778',
  engineVersion: 'ts-engine 0.1.0',
  mapId: 'ohio-stadium',
  planVersions: [
    { label: 'A', documentId: 'plan-a', version: 3 },
    { label: 'B', documentId: 'plan-b', version: 2 },
    { label: 'C', documentId: 'plan-c', version: 1 },
  ],
  notes: ['Sample scorecards for layout checks only.'],
};

export const SAMPLE_EAP: EapInput = { meta: SAMPLE_META, sections: SAMPLE_SECTIONS, annex: SAMPLE_ANNEX };

export const SAMPLE_201: Ics201Input = {
  meta: { ...SAMPLE_META, approvedBy: null, version: '1 (draft)' },
  initiatedAt: '2026-10-31T13:42:00-04:00',
  situationSummary: 'At 13:40 the queue at Gate 10 reached the bike racks with gates open for 40 minutes. Division A reports pressure at the barrier lanes. No injuries reported.',
  healthSafetyBriefing: 'Officers work in pairs at the barrier lanes. Watch for people going down in the queue.',
  objectives: ['Reduce the Gate 10 queue below the bike racks within 20 minutes.', 'Keep the north emergency lane clear.'],
  actions: [
    { time: '2026-10-31T13:44:00-04:00', action: 'Division A asked for the second screening team at Gate 10.' },
    { time: '2026-10-31T13:47:00-04:00', action: 'PA message directing ticket holders to Gate 12.' },
  ],
  organization: [{ role: 'Incident Commander', name: 'B. Commander (sample)' }, { role: 'Division A supervisor', name: 'J. Supervisor (sample)' }],
  resources: [{ resource: 'Screening team', identifier: 'Team 2 (sample)', orderedAt: '2026-10-31T13:44:00-04:00', eta: '2026-10-31T13:55:00-04:00', arrived: false }],
};

export const SAMPLE_214: Ics214Input = {
  meta: SAMPLE_META,
  name: 'I. Operations (sample)',
  position: 'Operations Section Chief',
  homeAgency: 'Agency A',
  resourcesAssigned: [{ name: 'J. Supervisor (sample)', position: 'Division A supervisor', homeAgency: 'Agency A' }],
  entries: [
    { at: '2026-10-31T09:00:00-04:00', activity: 'Operational period began. Briefing at the command post.' },
    { at: '2026-10-31T12:00:00-04:00', activity: 'Gates opened.' },
    { at: '2026-10-31T13:42:00-04:00', activity: 'Assignment a-17: Unit 12 (sample) to hold the Gate 10 queue line (priority).' },
    { at: '2026-10-31T13:44:00-04:00', activity: 'Assignment a-17 acknowledged (version 1).' },
  ],
};

export const SAMPLE_SITREP: SitrepInput = {
  meta: { ...SAMPLE_META, mode: 'simulation' },
  number: 4,
  asOf: '2026-10-31T14:00:00-04:00',
  summary: 'Gate 10 queue reduced after the second screening team arrived. All gates open. No injuries reported.',
  keyFigures: [
    { label: 'People waiting at Gate 10 (simulated)', value: 1240, provenance: { kind: 'simulated', source: 'Plan A run, seed 20261031', asOf: '2026-10-31T14:00:00-04:00' } },
    { label: 'Gate scan rate, all gates', value: null, unit: 'per minute', provenance: { kind: 'observed', source: 'gate scan feed not connected', asOf: null } },
    { label: 'Units committed', value: 18, provenance: { kind: 'observed', source: 'event log, assignments', asOf: '2026-10-31T14:00:00-04:00' } },
  ],
  weather: null,
  events: [{ at: '2026-10-31T13:42:00-04:00', text: 'Gate 10 queue reached the bike racks.' }, { at: '2026-10-31T13:55:00-04:00', text: 'Second screening team on scene at Gate 10.' }],
  resources: [{ kind: 'Patrol units', committed: 18, available: 6, outOfService: 0 }, { kind: 'Screening teams', committed: 9, available: 1 }],
  actionsTaken: ['Second screening team to Gate 10.', 'PA message for Gate 12.'],
  plannedActions: ['Return the second screening team to staging after the queue clears.'],
  nextReportAt: '2026-10-31T15:00:00-04:00',
};

export const SAMPLE_GEO: GeoExportInput = {
  mapId: 'ohio-stadium',
  includeMapFeatures: true,
  provenance: { kind: 'planned', source: 'Sample plan A, version 3', planId: 'plan-a', planVersion: 3 },
};

export const SAMPLE_CAP: CapAlertInput = {
  status: 'Exercise',
  exerciseId: 'Gameday tabletop 1',
  msgType: 'Alert',
  scope: 'Public',
  info: [
    {
      category: ['Met', 'Safety'],
      event: 'Lightning shelter advisory',
      responseType: ['Shelter'],
      urgency: 'Immediate',
      severity: 'Severe',
      certainty: 'Likely',
      onset: '2026-10-31T15:10:00-04:00',
      expires: '2026-10-31T16:10:00-04:00',
      senderName: 'Sample agency (exercise)',
      headline: 'EXERCISE: lightning near Ohio Stadium; move to shelter areas',
      description: 'EXERCISE. Lightning has been detected near the stadium. Play is suspended.',
      instruction: 'EXERCISE. Follow staff to the shelter areas on the concourses. Do not wait in the open or in the parking lots.',
      wea: {
        short: 'EXERCISE: Lightning near Ohio Stadium. Go to the concourse shelter areas now.',
        long: 'EXERCISE ONLY. Lightning is near Ohio Stadium and play is suspended. Follow stadium staff to the shelter areas on the concourses. Do not wait in the open or in parking lots. Updates will follow from stadium staff.',
      },
      area: [{ areaDesc: 'Ohio Stadium and surrounding lots, Columbus, OH', circle: { lat: 40.0016478, lon: -83.0197398, radiusKm: 1.2 } }],
    },
  ],
};

export const SAMPLE_AAR: AarInput = {
  meta: { ...SAMPLE_META, version: '1 (draft)', approvedBy: null },
  exercise: {
    name: 'Gameday tabletop 1',
    dates: '2026-10-29',
    scope: 'Discussion-based game for command and general staff; no real resources moved.',
    type: 'Game (HSEEP discussion-based)',
    missionAreas: ['Prevention', 'Protection', 'Response'],
    coreCapabilities: ['Operational Coordination', 'Public Information and Warning', 'On-scene Security, Protection, and Law Enforcement'],
    objectives: [
      { id: '1', text: 'Decide and communicate a gate surge response within 10 minutes of the first report.' },
      { id: '2', text: 'Issue a lightning shelter message to all channels within 5 minutes of the threshold.' },
    ],
    threatOrHazard: 'Gate surge at kickoff; lightning delay',
    scenario: 'A capacity home game; a gate surge at kickoff, then lightning within the agency threshold in the third quarter.',
    sponsor: 'Sample agency',
    participatingOrganizations: ['Agency A (sample)', 'Agency B (sample)', 'Venue operations (sample)'],
    pointsOfContact: [{ role: 'Exercise Director', name: 'O. Director (sample)', organization: 'Agency A' }],
  },
  analysis: [
    { objectiveId: '1', coreCapability: 'Operational Coordination', rating: 'S', strengths: ['Division A reported the queue at the bike racks early.'], areasForImprovement: [{ title: 'Request routing', observation: 'The second screening team request went through two people before reaching logistics.', reference: 'Gate surge plan B', analysis: 'No single owner for screening team requests on the day.' }] },
    { objectiveId: '2', coreCapability: 'Public Information and Warning', rating: 'P', strengths: ['The PIO had a pre-approved shelter message ready.'], areasForImprovement: [] },
  ],
  improvementPlan: [{ coreCapability: 'Operational Coordination', issue: 'Request routing for screening teams', correctiveAction: 'Name the Logistics Section as owner of screening team requests in the plan.', capabilityElement: 'Planning', primaryResponsibleOrganization: 'Agency A (sample)', organizationPoc: 'Planning Section Chief', startDate: '2026-11-02', completionDate: '2026-11-20' }],
  annex: SAMPLE_ANNEX,
};
