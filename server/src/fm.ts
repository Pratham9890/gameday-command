import type { Briefing, BriefingRequest, Scorecard } from '../../contracts.ts';

export interface FmOptions {
  url: string;
  model: string;
  timeoutMs: number;
}

/** Roughly four characters per token. The real ceiling is about 8k; we stay under 4k. */
export const PROMPT_TOKEN_BUDGET = 4000;
export const PROMPT_CHAR_BUDGET = PROMPT_TOKEN_BUDGET * 4;

const minutes = (value: number | null) => (value === null ? 'never cleared in this window' : `${Math.round(value)} minutes`);

function planLine(card: Scorecard, name: string): string {
  return [
    `Plan ${card.label} — ${name}`,
    `  time to clear: ${minutes(card.timeToClearMin)}`,
    `  peak density: ${Math.round(card.peakDensity * 10) / 10} people per square meter`,
    `  danger minutes: ${Math.round(card.dangerMinutes)}`,
    `  first officer on scene: ${card.firstOfficerMin === null ? 'no officer reached the zone' : minutes(card.firstOfficerMin)}`,
    `  officer minutes used: ${Math.round(card.officerMinutesUsed)}`,
    `  fans not reached: ${card.fansNotReached}`,
    `  fallback decisions: ${card.fallbackDecisions}`,
  ].join('\n');
}

/**
 * The commander briefing prompt.
 *
 * Deliberately small: it is a table of numbers and a tight instruction, so it
 * stays far under the context limit. An overflow comes back from the on-device
 * model as a safety-looking error rather than a length error, which would be a
 * miserable thing to debug at 3am.
 */
export function buildBriefingPrompt(req: BriefingRequest): string {
  const planName = (planId: string) => req.plans.find((p) => p.id === planId)?.name ?? planId;
  const lines = req.scorecards.map((card) => planLine(card, planName(card.planId)));

  return [
    `You are writing a short briefing for a police commander running game day at Ohio Stadium.`,
    `Incident: ${req.incident.kind.replace(/_/g, ' ')}${req.incident.note ? ` — ${req.incident.note}` : ''}`,
    ``,
    `Simulated results for each response plan:`,
    ``,
    ...lines,
    ``,
    `Write at most 120 words of plain English comparing the plans and naming the tradeoff.`,
    `Rules you must follow:`,
    `- Use ONLY numbers that appear above. Do not calculate, round differently, or invent any number.`,
    `- Do not recommend a plan. The commander decides.`,
    `- Say that fan behavior is an assumption, not a forecast.`,
    `- No headings, no bullet points, no preamble. Just the paragraphs.`,
  ].join('\n');
}

export interface FmResult {
  text: string;
  model: string;
}

/**
 * Apple's on-device model through `fm serve`, which speaks Chat Completions.
 * Always non-streaming: the briefing is checked against the scorecard as a whole
 * before the commander is allowed to see any of it.
 */
export async function askFm(req: BriefingRequest, opts: FmOptions): Promise<FmResult | null> {
  const prompt = buildBriefingPrompt(req);
  if (prompt.length > PROMPT_CHAR_BUDGET) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const res = await fetch(`${opts.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: opts.model,
        stream: false,
        temperature: 0.2,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[]; model?: string };
    const text = body.choices?.[0]?.message?.content?.trim();
    if (!text) return null;
    return { text, model: body.model ?? opts.model };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** A briefing the model wrote, or the template if anything at all was off. */
export function briefingFrom(result: FmResult): Briefing {
  return { text: result.text, model: result.model, canned: false };
}
