import type { Briefing, BriefingRequest } from '../../contracts.ts';

/**
 * Every number a briefing may say: the scorecard values, at the precision a
 * briefing would say them, plus any number already written into the names the
 * request supplied ("Gate 1", "Lot 5"). Those are given facts, not model claims.
 */
export function allowedNumbers(req: BriefingRequest): number[] {
  const values: number[] = [];
  for (const s of req.scorecards) {
    const fields = [
      s.timeToClearMin,
      s.peakDensity,
      s.dangerMinutes,
      s.firstOfficerMin,
      s.officerMinutesUsed,
      s.fansNotReached,
      s.fallbackDecisions,
      s.emergencyResponseMin ?? null,
      s.vehicleDelayMin ?? null,
      s.peakVehiclesStopped ?? null,
      s.vehiclesOut ?? null,
    ];
    for (const value of fields) {
      if (value === null) continue;
      values.push(value, Math.round(value), Math.round(value * 10) / 10);
    }
  }
  const names = [...req.plans.map((p) => p.name), req.incident.note ?? '', ...req.plans.flatMap((p) => p.actions.map((a) => ('message' in a ? a.message : '')))];
  for (const name of names) values.push(...numbersIn(name));
  return values;
}

export function numbersIn(text: string): number[] {
  return [...text.matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
}

/**
 * The guard on the briefing: a model may only repeat numbers that are already on
 * a scorecard. One invented figure and the whole briefing is thrown away for the
 * template, because a commander cannot check arithmetic mid-incident.
 */
export function briefingIsSupported(text: string, req: BriefingRequest): boolean {
  const allowed = allowedNumbers(req);
  return numbersIn(text).every((n) => allowed.some((a) => Math.abs(a - n) < 0.051));
}

const minutes = (value: number | null) => (value === null ? 'never cleared in this window' : `${Math.round(value)} minutes`);

/** Deterministic fallback. Says only what the scorecards say, so it always verifies. */
export function templateBriefing(req: BriefingRequest): Briefing {
  const planName = (planId: string) => req.plans.find((p) => p.id === planId)?.name ?? planId;
  const lines = req.scorecards.map((s) => {
    const parts = [
      `Plan ${s.label}, ${planName(s.planId)}:`,
      `clears in ${minutes(s.timeToClearMin)},`,
      `peak density ${Math.round(s.peakDensity * 10) / 10} people per square meter,`,
      `${Math.round(s.dangerMinutes)} danger minutes,`,
      `first officer on scene at ${s.firstOfficerMin === null ? 'no officer reached the zone' : minutes(s.firstOfficerMin)},`,
      `${Math.round(s.officerMinutesUsed)} officer minutes used,`,
      `${s.fansNotReached} fans not reached,`,
      `${s.fallbackDecisions} fallback decisions.`,
    ];
    if (s.vehicleDelayMin !== undefined) {
      parts.push(
        `Ambulance ${s.emergencyResponseMin == null ? 'never reached the scene' : `on scene in ${Math.round(s.emergencyResponseMin * 10) / 10} minutes`},`,
        `${Math.round(s.vehicleDelayMin)} vehicle minutes stopped in traffic,`,
        `${s.vehiclesOut ?? 0} vehicles out.`,
      );
    }
    return parts.join(' ');
  });

  const text = [
    `Incident: ${req.incident.kind.replace(/_/g, ' ')}.`,
    ...lines,
    `Fan behavior here is an assumption, not a forecast. The call is yours.`,
  ].join('\n');

  return { text, model: 'template', canned: true };
}
