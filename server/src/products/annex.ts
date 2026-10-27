import type { Scorecard } from '../../../contracts.ts';
import { CONTRACT_VERSION } from '../../../contracts.ts';
import type { SimulationAnnex } from '../types.ts';
import { esc, fmtNum } from './html.ts';
import { fields, listBox, raw, type SheetSpec, table } from './layout.ts';

/**
 * The simulation annex (PLT-37): what the simulation said, and everything
 * needed to reproduce it — seed, decision tape hash, engine and contract
 * versions, map, plan versions, and how many decisions fell back to defaults.
 * Kept apart from the approved plan: the plan is the commander's decision;
 * the annex is the evidence that informed it, with its assumptions in view.
 * It shows the trade-offs side by side and ranks nothing.
 */
const minutes = (v: number | null | undefined) => (v === null || v === undefined ? 'did not clear in the window' : `${fmtNum(v, 1)} min`);

/** Fruin level of service for walkways, by people per square metre (Fruin 1971, metric as in docs/research/01 §1.4). */
export function fruinLos(density: number): string {
  if (density <= 0.31) return 'A';
  if (density <= 0.43) return 'B';
  if (density <= 0.72) return 'C';
  if (density <= 1.08) return 'D';
  if (density <= 2.15) return 'E';
  return 'F';
}

export function annexSheets(annex: SimulationAnnex): SheetSpec[] {
  const name = (card: Scorecard) => annex.planNames?.[card.planId] ?? card.planId;
  const cards = [...annex.scorecards].sort((a, b) => a.label.localeCompare(b.label));
  const traffic = cards.some((c) => c.vehicleDelayMin !== undefined);
  const rows: [string, (c: Scorecard) => string][] = [
    ['Time for the incident zone to clear', (c) => minutes(c.timeToClearMin)],
    ['Peak crowd density (people per m², Fruin level)', (c) => `${fmtNum(c.peakDensity, 1)} (${fruinLos(c.peakDensity)})`],
    ['Cell-minutes above the danger density', (c) => fmtNum(c.dangerMinutes)],
    ['First officer on scene', (c) => (c.firstOfficerMin === null ? 'none reached the zone' : `${fmtNum(c.firstOfficerMin, 1)} min`)],
    ['Officer minutes used', (c) => fmtNum(c.officerMinutesUsed)],
    ['Fans not reached by an instruction', (c) => fmtNum(c.fansNotReached)],
    ['Decisions that fell back to defaults', (c) => fmtNum(c.fallbackDecisions)],
    ...(traffic
      ? ([
          ['Ambulance on scene', (c) => (c.emergencyResponseMin == null ? 'did not reach the scene' : `${fmtNum(c.emergencyResponseMin, 1)} min`)],
          ['Vehicle minutes stopped', (c) => fmtNum(c.vehicleDelayMin ?? null)],
          ['Vehicles out of the area', (c) => fmtNum(c.vehiclesOut ?? null)],
        ] as [string, (c: Scorecard) => string][])
      : []),
  ];
  const fallbacks = annex.scorecards.reduce((n, c) => n + c.fallbackDecisions, 0);
  const versions = (annex.planVersions ?? []).map((p) => `${p.label}: ${p.documentId ?? 'unsaved plan'}${p.version ? ` version ${p.version}` : ''}`).join('; ');
  return [
    {
      form: 'Simulation annex',
      formTitle: 'Simulated outcomes, assumptions and reproducibility',
      note: 'Not part of the approved plan.',
      parts: [
        raw(
          `<section class="box notice"><h3 class="label">How to read this annex</h3><p>Each column is one response plan run on the same simulated crowd (same seed). The numbers are simulated outcomes under the assumptions listed below, not observations and not a forecast. They show trade-offs; they do not choose a plan.</p></section>`,
          58,
        ),
        table(
          'Simulated outcomes by plan',
          [{ label: 'Measure', width: 2.6 }, ...cards.map((c) => ({ label: `Plan ${c.label}: ${name(c)}`, width: 1.6, cls: 'num' }))],
          rows.map(([label, fn]) => [esc(label), ...cards.map((c) => esc(fn(c)))]),
        ),
        listBox('Assumptions', annex.assumptions.length ? annex.assumptions : ['Fan behaviour follows the shipped decision defaults and cached model answers; it is an assumption, not a forecast.']),
        table(
          'Reproducibility (same seed + same decision tape = the same run, bit for bit)',
          [{ label: 'Item', width: 1.6 }, { label: 'Value', width: 5, cls: 'code' }],
          [
            ['Seed', annex.seeds?.length ? `${annex.seed} (ensemble of ${annex.seeds.length}: ${annex.seeds.slice(0, 12).join(', ')}${annex.seeds.length > 12 ? ', …' : ''})` : String(annex.seed)],
            ['Decision tape hash (SHA-256)', annex.tapeHash ?? 'not recorded: this run cannot be replayed exactly'],
            ['Engine version', annex.engineVersion],
            ['Contract version', annex.contractVersion ?? CONTRACT_VERSION],
            ['Map', annex.mapId ?? 'not stated'],
            ['Plan versions', versions || 'not stated'],
            ['Comparison record', annex.comparisonId ?? 'not saved'],
            ['Decisions that fell back to defaults (all plans)', String(fallbacks)],
          ].map(([k, value]) => [esc(k), esc(value)]),
        ),
        ...(annex.notes?.length ? [listBox('Notes', annex.notes, 'portrait', { numbered: false })] : []),
        fields([{ label: 'Limits of the model', value: 'The crowd model cannot represent densities above about 5.4 people per m² (its jam density), so it cannot show a crush. A run that approaches that density is outside what this model can assess.' }]),
      ],
    },
  ];
}
