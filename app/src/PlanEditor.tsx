import type { MapBundle, PlanAction, ResponsePlan } from '../../contracts.ts';

/** A one-line description of what a plan step does, in the commander's words. */
export function describeAction(action: PlanAction, map?: MapBundle): string {
  // Plans store ids; a commander reads names.
  const place = (id: string) => map?.places.find((p) => p.id === id)?.name ?? id;
  const door = (id: string) => (map?.closables.find((c) => c.id === id)?.name ?? id).replace(/ door$/, '');
  switch (action.type) {
    case 'close':
      return `Close ${door(action.closableId)}`;
    case 'open':
      return `Open ${door(action.closableId)}`;
    case 'send_officers':
      return `Send ${action.count} officers to ${place(action.toPlaceId)}`;
    case 'hold_officers':
      return `Hold ${action.officerIds.length} officers back`;
    case 'alert':
      // The plan sets a share of the fans the alert can reach; the live status
      // in live-steps.ts says how many it has reached so far. Wording them
      // apart stops the two figures reading as the same measurement.
      return `${action.channel === 'pa' ? 'PA announcement' : 'Phone alert'} aimed at ${Math.round(action.reachShare * 100)}% of fans in range`;
    case 'redirect':
      return `Send ${place(action.fromPlaceId)} fans to ${place(action.toPlaceId)}`;
    case 'shelter_order':
      return 'Order everyone to shelter';
  }
}

export interface PlanEditorProps {
  plan: ResponsePlan;
  map?: MapBundle;
  /** Steps the commander has switched off, by index. */
  disabled: Set<number>;
  onChange: (plan: ResponsePlan, disabled: Set<number>) => void;
}

/**
 * Edits one plan in place. Times are minutes after the incident, which is how a
 * commander thinks about it; the contract stores seconds.
 */
export function PlanEditor({ plan, map, disabled, onChange }: PlanEditorProps) {
  const update = (index: number, patch: Partial<PlanAction>) => {
    const actions = plan.actions.map((action, i) => (i === index ? ({ ...action, ...patch } as PlanAction) : action));
    onChange({ ...plan, actions }, disabled);
  };

  const toggle = (index: number) => {
    const next = new Set(disabled);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    onChange(plan, next);
  };

  return (
    <div className="plan-editor">
      {plan.actions.map((action, index) => (
        <div className={`step${disabled.has(index) ? ' off' : ''}`} key={`${action.type}-${index}`}>
          <label className="step-on">
            <input type="checkbox" checked={!disabled.has(index)} onChange={() => toggle(index)} />
          </label>
          <span className="step-what" title={describeAction(action, map)}>{describeAction(action, map)}</span>
          <label className="step-at">
            <input
              type="number"
              min={0}
              max={60}
              step={0.5}
              value={action.at / 60}
              onChange={(e) => update(index, { at: Math.max(0, Number(e.target.value)) * 60 })}
            />
            min after the incident
          </label>
          {action.type === 'send_officers' && (
            <label className="step-n">
              <input
                type="number"
                min={0}
                max={plan.officersAvailable}
                value={action.count}
                onChange={(e) => update(index, { count: Math.max(0, Number(e.target.value)) } as Partial<PlanAction>)}
              />
              officers
            </label>
          )}
          {action.type === 'alert' && (
            <label className="step-n">
              <input
                type="number"
                min={0}
                max={100}
                value={Math.round(action.reachShare * 100)}
                onChange={(e) =>
                  update(index, { reachShare: Math.min(1, Math.max(0, Number(e.target.value) / 100)) } as Partial<PlanAction>)
                }
              />
              %
            </label>
          )}
        </div>
      ))}
      {plan.actions.length === 0 && <p className="muted">This plan does nothing — a useful baseline.</p>}
    </div>
  );
}

/** Drop the steps the commander switched off, so the engine never sees them. */
export function applyDisabled(plan: ResponsePlan, disabled: Set<number>): ResponsePlan {
  return { ...plan, actions: plan.actions.filter((_, i) => !disabled.has(i)) };
}
