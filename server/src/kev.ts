import type { DecisionAsk, DecisionSituation, Odds } from '../../contracts.ts';

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
 * Prompt for one decision key. Short on purpose: it answers for a whole group of
 * dots sharing the key, and it must stay well under the context limit even when
 * a step raises dozens of keys at once.
 */
export function buildPrompt(ask: DecisionAsk, situation: DecisionSituation): string {
  const { context: c } = ask;
  const when =
    c.minToKickoffBucket > 0 ? `${c.minToKickoffBucket} minutes before kickoff` : `${-c.minToKickoffBucket} minutes after kickoff`;
  const options = situation.options.map((o) => `- ${o.key}: ${o.label}`).join('\n');
  return [
    `You model how a group of college football fans behaves. Answer with probabilities only.`,
    ``,
    `Group: ${ask.fanTypeId}`,
    `Situation: ${situation.description}`,
    `It is ${when}. Weather is ${c.weather}. The crowd around them is ${c.crowdAtTarget}.`,
    `Wait so far: about ${c.waitMinBucket} minutes.`,
    `An officer is giving instructions nearby: ${c.officerOrder ? 'yes' : 'no'}.`,
    `They heard a PA or phone alert: ${c.alertHeard ? 'yes' : 'no'}.`,
    ``,
    `Options:`,
    options,
    ``,
    `Reply with one JSON object mapping every option key to a probability. The values must add up to 1. No other text.`,
  ].join('\n');
}

/** First JSON object in a model reply, since small models like to add a sentence. */
export function parseOdds(text: string): Odds | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    const odds: Odds = {};
    for (const [key, value] of Object.entries(parsed)) {
      const n = typeof value === 'string' ? Number(value) : value;
      if (typeof n !== 'number' || !Number.isFinite(n)) return null;
      odds[key] = n;
    }
    return odds;
  } catch {
    return null;
  }
}

/**
 * Ask the local Kev server. Assumes an OpenAI-compatible /v1/chat/completions,
 * which is what `kev.serve` exposes; everything about that assumption is
 * contained in this file. Any failure returns null and the caller uses defaults.
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
    const res = await fetch(`${opts.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: opts.model,
        stream: false,
        temperature: 0,
        max_tokens: 200,
        messages: [{ role: 'user', content: buildPrompt(ask, situation) }],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = body.choices?.[0]?.message?.content;
    if (!text) return null;
    const odds = parseOdds(text);
    if (!odds) return null;
    return { odds, ms: Date.now() - started, model: opts.model };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
