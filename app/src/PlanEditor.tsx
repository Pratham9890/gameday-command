import type { PlanAction, ResponsePlan } from '../../contracts.ts';

/** A one-line description of what a plan step does, in the commander's words. */
export function describeAction(action: PlanAction): string {
  switch (action.type) {
    case 'close':
      return `Close ${action.closableId}`;
    case 'open':
      return `Open ${action.closableId}`;
    case 'send_officers':
      return `Send ${action.count} officers to ${action.toPlaceId}`;
    case 'hold_officers':
      return `Hold ${action.officerIds.length} officers`;
    case 'alert':
      return `${action.channel === 'pa' ? 'PA' : 'Phone'} alert, ${Math.round(action.reachShare * 100)}% reached`;
    case 'redirect':
      return `Redirect ${action.fromPlaceId} to ${action.toPlaceId}`;
    case 'shelter_order':
      return `Shelter order (${action.shelterPlaceIds.length} places)`;
  }
}

export interface PlanEditorProps {
  plan: ResponsePlan;
  /** Steps the commander has switched off, by index. */
  disabled: Set<number>;
  onChange: (plan: ResponsePlan, disabled: Set<number>) => void;
}

/**
 * Edits one plan in place. Times are minutes after the incident, which is how a
 * commander thinks about it; the contract stores seconds.
 */
export function PlanEditor({ plan, disabled, onChange }: PlanEditorProps) {
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
          <span className="step-what">{describeAction(action)}</span>
          <label className="step-at">
            <input
              type="number"
              min={0}
              max={60}
              step={0.5}
              value={action.at / 60}
              onChange={(e) => update(index, { at: Math.max(0, Number(e.target.value)) * 60 })}
            />
            min
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
              off.
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
