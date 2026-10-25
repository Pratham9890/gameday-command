import { describe, expect, it } from 'vitest';
import type { SceneInfo, OfficerStatus } from '../../engine/src/edits.ts';
import { makeTestMap } from '../../world/src/test-map.ts';
import { stepStatus } from './live-steps.ts';

const map = makeTestMap();
const gate = map.places.findIndex((p) => p.kind === 'gate');
const officer = (state: OfficerStatus['state'], etaS: number | null, told = 0): OfficerStatus => ({
  id: 'o', unit: 'OSU PD', cell: 0, x: 0, y: 0, state, targetCell: 0, place: gate, homeCell: 0, told, followed: 0, etaS,
});
const scene = (officers: OfficerStatus[], closed: string[] = []): SceneInfo => ({ t: 0, officers, gates: [], closed, alerts: [] });
const send = { at: 0, type: 'send_officers' as const, count: 3, toPlaceId: map.places[gate]!.id };

describe('plan step status', () => {
  it('says nothing before the step fires', () => {
    expect(stepStatus(send, 60, 30, scene([officer('en_route', 120)]), [], map)).toBeNull();
  });

  it('shows officers on their way, with the slowest one’s arrival', () => {
    const s = scene([officer('on_scene', null), officer('en_route', 100), officer('en_route', 170)]);
    expect(stepStatus(send, 0, 10, s, [], map)).toBe('1 of 3 on scene, 2 on the way, about 3 min');
  });

  it('counts the fans officers have directed once they are all there', () => {
    const s = scene([officer('on_scene', null, 40), officer('on_scene', null, 15)]);
    expect(stepStatus(send, 0, 10, s, [], map)).toBe('all 2 on scene, 55 fans directed');
  });

  it('reports how many fans an alert reached', () => {
    const alert = { at: 0, type: 'alert' as const, channel: 'pa' as const, message: 'Use Gate 2', reachShare: 0.7 };
    expect(stepStatus(alert, 0, 5, null, [], map)).toBe('going out…');
    expect(stepStatus(alert, 0, 5, null, [{ t: 1, dots: new Int32Array(200) }], map)).toBe('reached 1,000 fans so far');
    // a live count is not the share the plan aimed at, and must not read as one
    const status = stepStatus(alert, 0, 5, null, [{ t: 1, dots: new Int32Array(200) }], map)!;
    expect(status).toContain('so far');
    expect(status).not.toContain('%');
    expect(status).not.toContain('aimed at');
  });

  it('marks a door shut only once it really is', () => {
    const close = { at: 0, type: 'close' as const, closableId: map.closables[0]!.id };
    expect(stepStatus(close, 0, 5, scene([]), [], map)).toBeNull();
    expect(stepStatus(close, 0, 5, scene([], [map.closables[0]!.id]), [], map)).toBe('shut');
  });
});
