import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PlanAction, ResponsePlan } from '../../contracts.ts';
import { makeTestMap } from '../../world/src/test-map.ts';
import { playbookFor } from '../../world/src/playbook.ts';
import { incidentsFor, windowFor } from '../../world/src/incidents.ts';
import { applyDisabled, describeAction, PlanEditor } from './PlanEditor.tsx';
import { stepStatus } from './live-steps.ts';

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
    expect(describeAction(actions[4]!)).toBe('PA announcement aimed at 70% of fans in range');
    // With the map, ids become the names a commander reads.
    expect(describeAction({ at: 0, type: 'send_officers', count: 6, toPlaceId: 'test-gate-a' }, map)).toBe('Send 6 officers to Gate 1');
    expect(describeAction({ at: 0, type: 'close', closableId: 'test-gate-a-door' }, map)).toBe('Close Gate 1');
  });

  it('keeps the share an alert aims at apart from the number it has reached', () => {
    const alert: PlanAction = { at: 0, type: 'alert', channel: 'pa', message: 'Use Gate 2.', reachShare: 0.7 };
    const planned = describeAction(alert);
    const live = stepStatus(alert, 0, 5, null, [{ t: 1, dots: new Int32Array(200) }], map)!;
    expect(planned).toBe('PA announcement aimed at 70% of fans in range');
    expect(live).toBe('reached 1,000 fans so far');
    // One is a share of the fans the alert can reach; the other is a count it
    // actually touched, so neither sentence may borrow the other's wording.
    expect(planned).toContain('aimed at 70%');
    expect(planned).not.toContain('so far');
    expect(live).not.toContain('%');
    expect(live).not.toContain('aimed at');
  });

  it('labels the timing and the officer count in radio words', () => {
    const plan: ResponsePlan = {
      id: 'plan-x',
      name: 'Plan X',
      forIncident: 'gate_surge',
      officersAvailable: 12,
      actions: [
        { at: 0, type: 'send_officers', count: 6, toPlaceId: 'gate-1' },
        { at: 30, type: 'alert', channel: 'pa', message: 'Use Gate 2.', reachShare: 0.7 },
      ],
    };
    const html = renderToStaticMarkup(createElement(PlanEditor, { plan, map, disabled: new Set<number>(), onChange: () => {} }));
    expect(html).toContain('min after the incident');
    expect(html).not.toContain('min in');
    // the officer stepper's own label, not the "Send 6 officers" description
    expect(html).toMatch(/officers<\/label>/);
    expect(html).not.toContain('cops');
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
