import type { DecisionDefaults, DecisionSituation, Odds, SituationId } from '../../contracts.ts';
import { CONTRACT_VERSION } from '../../contracts.ts';
import { SITUATIONS, SITUATION_IDS } from './situations.ts';

/** Even odds across a situation's options. Milestone 1 ships these as the only answer. */
export function evenOdds(situation: DecisionSituation): Odds {
  const share = 1 / situation.options.length;
  const odds: Odds = {};
  for (const option of situation.options) odds[option.key] = share;
  return odds;
}

/**
 * The fallback table. Used whenever Kev is slow, broken, off, or returns odds
 * that do not add up — and every one of those counts as a fallback decision on
 * the scorecard, so the commander can see how much of a run was guessed.
 */
export function makeDecisionDefaults(): DecisionDefaults {
  const defaults = {} as Record<SituationId, Odds>;
  for (const id of SITUATION_IDS) defaults[id] = evenOdds(SITUATIONS[id]);
  return {
    version: CONTRACT_VERSION,
    situations: SITUATION_IDS.map((id) => SITUATIONS[id]),
    defaults,
  };
}

export const DECISION_DEFAULTS: DecisionDefaults = makeDecisionDefaults();
