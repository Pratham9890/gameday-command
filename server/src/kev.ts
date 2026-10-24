import type { DecisionAsk, DecisionSituation, Odds } from '../../contracts.ts';
import { FAN_TYPES } from '../../brain/src/fan-types.ts';

export interface KevOptions {
  url: string;
  model: string;
  timeoutMs: number;
}

export interface KevResult {
  odds: Odds;
  ms: number;
  model: string;
}

/**
 * Kev's TypeSafe-compatible request shape (POST /v1/systemone).
 *
 * Kev is not a chat model and generates no text: it takes a state and typed
 * questions, does one prefill pass, and returns a probability per option. A
 * `choice` question answers with `probabilities` keyed by the option names we
 * send, which is exactly the contract's Odds — no parsing of prose, and
 * nothing to go wrong between the model and the engine.
 */
export interface SystemOneRequest {
  state: Record<string, unknown>;
  model: string;
  questions: Record<string, { type: 'choice'; instructions: string; criteria: Record<string, string> }>;
}

interface SystemOneResponse {
  model?: string;
  answers?: Record<string, { type?: string; choice?: string; confidence?: number; probabilities?: Record<string, number> }>;
  latency_ms?: number;
}

/** The question id we ask under; Kev echoes answers back under the same key. */
export const QUESTION_ID = 'decision';

/**
 * The state Kev reasons over: the rounded facts behind this decisionKey, named
 * so they read as plain fields. Everything here is already part of the key, so
 * one call still answers the whole group of dots. Compliance is not in the key
 * itself, but it is fixed per fan type, and the fan type is.
 */
export function buildSystemOneRequest(ask: DecisionAsk, situation: DecisionSituation, model: string): SystemOneRequest {
  const c = ask.context;
  const fanType = FAN_TYPES.find((t) => t.id === ask.fanTypeId);
  const criteria: Record<string, string> = {};
  for (const option of situation.options) criteria[option.key] = option.label;

  return {
    model,
    state: {
      who: `a group of ${ask.fanTypeId.replace(/-/g, ' ')} fans at Ohio Stadium on game day`,
      how_readily_they_follow_instructions: fanType?.traits.compliance,
      situation: situation.description,
      minutes_to_kickoff: c.minToKickoffBucket,
      weather: c.weather,
      crowd_where_they_are_headed: c.crowdAtTarget,
      minutes_waited_so_far: c.waitMinBucket,
      an_officer_nearby_gave_an_instruction: c.officerOrder,
      they_heard_a_pa_or_phone_alert: c.alertHeard,
    },
    questions: {
      [QUESTION_ID]: {
        type: 'choice',
        instructions: 'What does this group of fans do next?',
        criteria,
      },
    },
  };
}

/** Probabilities out of a /v1/systemone answer, or null if it is not usable. */
export function parseSystemOne(body: SystemOneResponse): Odds | null {
  const answer = body.answers?.[QUESTION_ID];
  if (!answer || answer.type !== 'choice') return null;
  const probabilities = answer.probabilities;
  if (!probabilities || Object.keys(probabilities).length === 0) return null;
  const odds: Odds = {};
  for (const [key, value] of Object.entries(probabilities)) {
    const n = typeof value === 'string' ? Number(value) : value;
    if (typeof n !== 'number' || !Number.isFinite(n)) return null;
    odds[key] = n;
  }
  return odds;
}

/**
 * Ask the local Kev server. Any failure returns null and the caller uses the
 * defaults, counting it as a fallback on the scorecard.
 */
export async function askKev(
  ask: DecisionAsk,
  situation: DecisionSituation,
  opts: KevOptions,
): Promise<KevResult | null> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const res = await fetch(`${opts.url}/v1/systemone`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildSystemOneRequest(ask, situation, opts.model)),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as SystemOneResponse;
    const odds = parseSystemOne(body);
    if (!odds) return null;
    return { odds, ms: Date.now() - started, model: body.model ?? opts.model };
  } catch {
    // Timeout, connection refused, bad JSON: all the same answer — use defaults.
    return null;
  } finally {
    clearTimeout(timer);
  }
}
