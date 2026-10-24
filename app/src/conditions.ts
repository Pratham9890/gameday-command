import type { Id, MapBundle } from '../../contracts.ts';

/**
 * Real conditions from outside the simulation: gate queues from turnstile
 * scans, stopped vehicles from a traffic feed. They arrive as a file the
 * commander uploads or a URL the server fetches, in one small format, and the
 * brief then reads them instead of the simulation and says where they came
 * from and how old they are.
 *
 * JSON (minuteToKickoff is optional; with it, the brief compares against
 * history at that minute; without it, it uses fixed thresholds):
 *   { "source": "Gate scans", "at": "2026-10-24T15:10:00Z", "minuteToKickoff": -20,
 *     "gates": [{ "gate": "Gate 2", "waiting": 1400 }],
 *     "roads": [{ "street": "West Lane Avenue", "stopped": 8 }] }
 *
 * CSV, one reading per line, and optionally a `minute,,-20` line:
 *   kind,name,value
 *   gate,Gate 2,1400
 *   street,West Lane Avenue,8
 *
 * Names match the map's gate and street names (case-insensitive, "(N)"-style
 * suffixes optional) or their ids. Nothing is ever made up: a gate the feed does
 * not mention is reported as unknown, not as zero.
 */
export interface Conditions {
  source: string;
  at: string | null;
  /** Minutes to kickoff when the readings were taken, negative before it. */
  minuteToKickoff: number | null;
  gates: Map<Id, number>;
  streets: Map<Id, number>;
  /** Lines or entries that did not match anything on this map. */
  unmatched: string[];
}

const norm = (s: string) => s.toLowerCase().replace(/\s*\(.*?\)\s*/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();

function matcher(map: MapBundle) {
  const gates = map.places.filter((p) => p.kind === 'gate');
  const streets = map.closables.filter((c) => !c.id.endsWith('-door'));
  return {
    gate: (name: string) => gates.find((g) => g.id === name || norm(g.name) === norm(name))?.id,
    street: (name: string) => streets.find((s) => s.id === name || norm(s.name) === norm(name))?.id,
  };
}

export function parseConditions(text: string, map: MapBundle, fallbackSource = 'Uploaded file'): Conditions {
  const out: Conditions = { source: fallbackSource, at: null, minuteToKickoff: null, gates: new Map(), streets: new Map(), unmatched: [] };
  const find = matcher(map);
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    const data = JSON.parse(trimmed) as {
      source?: string; at?: string; minuteToKickoff?: number;
      gates?: { gate: string; waiting: number }[];
      roads?: { street: string; stopped?: number }[];
    };
    if (data.source) out.source = String(data.source);
    if (data.at) out.at = String(data.at);
    if (Number.isFinite(Number(data.minuteToKickoff)) && data.minuteToKickoff !== undefined) out.minuteToKickoff = Number(data.minuteToKickoff);
    for (const g of data.gates ?? []) {
      const id = find.gate(String(g.gate));
      if (id && Number.isFinite(Number(g.waiting))) out.gates.set(id, Math.max(0, Number(g.waiting)));
      else out.unmatched.push(`gate ${g.gate}`);
    }
    for (const r of data.roads ?? []) {
      const id = find.street(String(r.street));
      if (id && Number.isFinite(Number(r.stopped))) out.streets.set(id, Math.max(0, Number(r.stopped)));
      else out.unmatched.push(`street ${r.street}`);
    }
    return out;
  }
  for (const line of trimmed.split(/\r?\n/)) {
    const [kind, name, value] = line.split(',').map((s) => s.trim());
    if (!kind || kind.toLowerCase() === 'kind' || (!name && kind.toLowerCase() !== 'minute')) continue;
    const v = Number(value);
    if (kind.toLowerCase() === 'minute' && Number.isFinite(v)) {
      out.minuteToKickoff = v;
      continue;
    }
    if (!Number.isFinite(v)) {
      out.unmatched.push(line);
      continue;
    }
    const id = kind.toLowerCase() === 'gate' ? find.gate(name) : kind.toLowerCase() === 'street' ? find.street(name) : undefined;
    if (!id) out.unmatched.push(line);
    else if (kind.toLowerCase() === 'gate') out.gates.set(id, Math.max(0, v));
    else out.streets.set(id, Math.max(0, v));
  }
  return out;
}
