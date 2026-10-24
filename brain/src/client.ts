import type {
  DecisionAnswer,
  DecisionAsk,
  DecisionDefaults,
  DecisionKey,
  DecisionTape,
  Id,
  SimSeconds,
  SituationId,
} from '../../contracts.ts';
import { DECISION_TIMEOUT_MS } from '../../contracts.ts';
import { oddsAreValid } from './sample.ts';

export interface DecisionClientOptions {
  serverUrl: string;
  defaults: DecisionDefaults;
  timeoutMs?: number;
  /** When present the client never calls out; it answers from the tape. */
  replay?: DecisionTape;
  fetchImpl?: typeof fetch;
}

/**
 * The only thing that talks to Kev.
 *
 * Asks are already grouped by decisionKey upstream, so one call answers every
 * dot sharing a key. Anything slow, broken, or malformed becomes the default
 * answer, which the scorecard counts as a fallback — the run never stalls and
 * never crashes because a model is off.
 */
export class DecisionClient {
  private readonly cache = new Map<DecisionKey, DecisionAnswer>();
  private readonly optionKeys: Partial<Record<SituationId, string[]>> = {};
  private readonly tape: DecisionTape;
  private readonly timeoutMs: number;
  private readonly doFetch: typeof fetch;

  readonly runId: Id;
  private readonly opts: DecisionClientOptions;

  constructor(runId: Id, opts: DecisionClientOptions) {
    this.runId = runId;
    this.opts = opts;
    this.tape = { runId, answers: [] };
    this.timeoutMs = opts.timeoutMs ?? DECISION_TIMEOUT_MS;
    this.doFetch = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    for (const situation of opts.defaults.situations) {
      this.optionKeys[situation.id] = situation.options.map((o) => o.key);
    }
    for (const entry of opts.replay?.answers ?? []) {
      this.cache.set(entry.answer.key, entry.answer);
    }
  }

  getTape(): DecisionTape {
    return { runId: this.tape.runId, answers: [...this.tape.answers] };
  }

  private defaultAnswer(ask: DecisionAsk): DecisionAnswer {
    return { key: ask.key, odds: this.opts.defaults.defaults[ask.situation], source: 'default' };
  }

  private validate(ask: DecisionAsk, answer: DecisionAnswer | undefined): DecisionAnswer {
    if (!answer || answer.key !== ask.key) return this.defaultAnswer(ask);
    const keys = this.optionKeys[ask.situation] ?? [];
    if (!oddsAreValid(answer.odds, keys)) return this.defaultAnswer(ask);
    return answer;
  }

  /** Answer every ask raised in one step. Resolves only when all of them have an answer. */
  async answer(t: SimSeconds, asks: DecisionAsk[]): Promise<DecisionAnswer[]> {
    const answers = new Map<DecisionKey, DecisionAnswer>();
    const misses: DecisionAsk[] = [];

    for (const ask of asks) {
      const hit = this.cache.get(ask.key);
      if (hit) answers.set(ask.key, { ...hit, source: hit.source === 'default' ? 'default' : 'cache' });
      else if (!answers.has(ask.key)) misses.push(ask);
    }

    if (misses.length > 0) {
      const fresh = this.opts.replay ? [] : await this.ask(misses);
      const byKey = new Map(fresh.map((a) => [a.key, a]));
      for (const ask of misses) {
        const answer = this.validate(ask, byKey.get(ask.key));
        answers.set(ask.key, answer);
        this.cache.set(ask.key, answer);
      }
    }

    const ordered = asks.map((ask) => answers.get(ask.key) ?? this.defaultAnswer(ask));
    for (const answer of ordered) this.tape.answers.push({ t, answer });
    return ordered;
  }

  private async ask(asks: DecisionAsk[]): Promise<DecisionAnswer[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.doFetch(`${this.opts.serverUrl}/api/decide`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runId: this.runId, asks }),
        signal: controller.signal,
      });
      if (!res.ok) return [];
      const body = (await res.json()) as { answers?: DecisionAnswer[] };
      return body.answers ?? [];
    } catch {
      // Timeout, connection refused, bad JSON: all the same answer — use defaults.
      return [];
    } finally {
      clearTimeout(timer);
    }
  }
}
