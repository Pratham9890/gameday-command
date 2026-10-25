import { useMemo, useState } from 'react';
import type { MapBundle, PlanAction } from '../../contracts.ts';
import { buildStep, STEP_KINDS, stepChoices, type StepDraft, type StepKind } from './plan-steps.ts';

/** Add a step to a plan from dropdowns: what to do, where, when. */
export function StepAdder({ map, maxOfficers, onAdd }: { map: MapBundle; maxOfficers: number; onAdd: (step: PlanAction) => void }) {
  const choices = useMemo(() => stepChoices(map), [map]);
  const [draft, setDraft] = useState<StepDraft>({ kind: 'close', atMin: 0, count: 4, channel: 'pa', reachPct: 60 });
  const set = (patch: Partial<StepDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const step = buildStep(draft, choices);

  const select = (value: string | undefined, options: { id: string; label: string }[], onPick: (id: string) => void, placeholder: string) => (
    <select value={value ?? ''} onChange={(e) => onPick(e.target.value)}>
      <option value="">{placeholder}</option>
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.label}
        </option>
      ))}
    </select>
  );

  return (
    <div className="step-adder">
      <select value={draft.kind} onChange={(e) => set({ kind: e.target.value as StepKind, target: undefined, from: undefined, to: undefined })}>
        {STEP_KINDS.map((k) => (
          <option key={k.kind} value={k.kind}>
            {k.label}
          </option>
        ))}
      </select>
      {(draft.kind === 'close' || draft.kind === 'open') && select(draft.target, choices.closables, (target) => set({ target }), 'which gate or street…')}
      {draft.kind === 'send_officers' && (
        <>
          <input type="number" min={1} max={maxOfficers} value={draft.count} onChange={(e) => set({ count: Number(e.target.value) })} />
          {select(draft.target, choices.places, (target) => set({ target }), 'to where…')}
        </>
      )}
      {draft.kind === 'redirect' && (
        <>
          {select(draft.from, choices.gates, (from) => set({ from }), 'from gate…')}
          {select(draft.to, choices.places, (to) => set({ to }), 'to…')}
        </>
      )}
      {draft.kind === 'alert' && (
        <>
          <select value={draft.channel} onChange={(e) => set({ channel: e.target.value as 'pa' | 'phone' })}>
            <option value="pa">PA</option>
            <option value="phone">Phone</option>
          </select>
          <input type="number" min={5} max={100} value={draft.reachPct} onChange={(e) => set({ reachPct: Number(e.target.value) })} title="% of fans reached" />
          <input type="text" placeholder="message" value={draft.message ?? ''} onChange={(e) => set({ message: e.target.value })} />
        </>
      )}
      <label className="step-at">
        at
        <input type="number" min={0} max={60} step={0.5} value={draft.atMin} onChange={(e) => set({ atMin: Number(e.target.value) })} />
        min
      </label>
      <button className="small" disabled={!step} onClick={() => step && onAdd(step)}>
        Add step
      </button>
    </div>
  );
}
