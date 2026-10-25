import { describe, expect, it } from 'vitest';
import type { PlanAction, ResponsePlan } from '../../contracts.ts';
import { makeTestMap } from '../../world/src/test-map.ts';
import { playbookFor } from '../../world/src/playbook.ts';
import { incidentsFor, windowFor } from '../../world/src/incidents.ts';
import { applyDisabled, describeAction } from './PlanEditor.tsx';

const map = makeTestMap();

describe('plan editor', () => {
  it('describes every kind of plan step in the commander’s words', () => {
    const actions: PlanAction[] = [
      { at: 0, type: 'close', closableId: 'gate-1-door' },
      { at: 0, type: 'open', closableId: 'gate-2-door' },
      { at: 0, type: 'send_officers', count: 6, toPlaceId: 'gate-1' },
      { at: 0, type: 'hold_officers', officerIds: ['off-1', 'off-2'] },
      { at: 0, type: 'alert', channel: 'pa', message: 'Use Gate 2.', reachShare: 0.7 },
      { at: 0, type: 'redirect', fromPlaceId: 'gate-1', toPlaceId: 'gate-2' },
      { at: 0, type: 'shelter_order', shelterPlaceIds: ['concourse'] },
    ];
    for (const action of actions) {
      const text = describeAction(action);
      expect(text, action.type).toBeTruthy();
      expect(text).not.toContain('undefined');
    }
    expect(describeAction(actions[2]!)).toBe('Send 6 officers to gate-1');
    expect(describeAction(actions[4]!)).toBe('PA announcement reaching 70% of fans');
    // With the map, ids become the names a commander reads.
    expect(describeAction({ at: 0, type: 'send_officers', count: 6, toPlaceId: 'test-gate-a' }, map)).toBe('Send 6 officers to Gate 1');
    expect(describeAction({ at: 0, type: 'close', closableId: 'test-gate-a-door' }, map)).toBe('Close Gate 1');
  });

  it('removes only the steps the commander switched off', () => {
    const plan = playbookFor('gate_surge', map)[2]!;
    expect(plan.actions.length).toBeGreaterThan(2);

    const trimmed = applyDisabled(plan, new Set([0]));
    expect(trimmed.actions).toHaveLength(plan.actions.length - 1);
    expect(trimmed.actions).toEqual(plan.actions.slice(1));
    // the original is untouched, so toggling a step back on restores it
    expect(plan.actions).toHaveLength(trimmed.actions.length + 1);
    expect(trimmed.id).toBe(plan.id);
  });

  it('can switch a plan down to doing nothing at all', () => {
    const plan = playbookFor('gate_surge', map)[0]!;
    const off = applyDisabled(plan, new Set(plan.actions.map((_, i) => i)));
    expect(off.actions).toHaveLength(0);
  });
});

describe('what the app offers the commander', () => {
  it('offers exactly the four incidents the demo calls for', () => {
    const kinds = incidentsFor(map).map((i) => i.kind);
    expect(kinds).toEqual(['gate_surge', 'lightning_delay', 'suspicious_package', 'game_end']);
  });

  it('gives every incident at least three editable plans', () => {
    for (const incident of incidentsFor(map)) {
      const plans: ResponsePlan[] = playbookFor(incident.kind, map);
      expect(plans.length, incident.kind).toBeGreaterThanOrEqual(3);
      // editable means there is something to edit
      expect(plans.every((p) => p.actions.length > 0), incident.kind).toBe(true);
    }
  });

  it('starts the clock at kickoff minus 60, or just before the whistle for the game end, and runs past the incident', () => {
    for (const incident of incidentsFor(map)) {
      const window = windowFor(incident);
      // Game end starts with everyone seated, so it skips the hour of arrivals.
      if (incident.kind === 'game_end') expect(window.startAt).toBeLessThan(incident.at);
      else expect(window.startAt).toBe(-3600);
      expect(window.endAt).toBeGreaterThan(incident.at);
    }
  });
});
