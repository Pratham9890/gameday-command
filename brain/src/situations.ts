import type { DecisionSituation, SituationId } from '../../contracts.ts';

/**
 * Every moment a dot can stop and choose. Option keys are the vocabulary the
 * engine acts on, so they stay short and stable; labels are what the commander
 * reads in the dot detail panel.
 */
export const SITUATIONS: Record<SituationId, DecisionSituation> = {
  pick_gate: {
    id: 'pick_gate',
    description: 'You are walking to the stadium and have to pick a gate.',
    options: [
      { key: 'my_gate', label: 'Use the gate on my ticket' },
      { key: 'nearest_gate', label: 'Use the closest gate' },
      { key: 'shortest_line', label: 'Use whichever line looks shortest' },
    ],
  },
  leave_tailgate: {
    id: 'leave_tailgate',
    description: 'Kickoff is coming and you are still at the tailgate.',
    options: [
      { key: 'go_now', label: 'Head for the gate now' },
      { key: 'wait', label: 'Stay a bit longer' },
    ],
  },
  leave_early: {
    id: 'leave_early',
    description: 'The game is decided and you could beat the crowd out.',
    options: [
      { key: 'leave_now', label: 'Leave now' },
      { key: 'stay', label: 'Stay to the end' },
    ],
  },
  lightning_shelter: {
    id: 'lightning_shelter',
    description: 'A lightning delay was announced. You have to get out of the open.',
    options: [
      { key: 'go_concourse', label: 'Move into the concourse' },
      { key: 'go_car', label: 'Walk back to the car' },
      { key: 'stay_put', label: 'Stay where I am' },
    ],
  },
  gate_jammed: {
    id: 'gate_jammed',
    description: 'The gate in front of you is packed and barely moving.',
    options: [
      { key: 'hold_place', label: 'Hold my place in line' },
      { key: 'try_other_gate', label: 'Walk to another gate' },
      { key: 'back_off', label: 'Back out of the crush and wait' },
    ],
  },
  street_closed: {
    id: 'street_closed',
    description: 'The street you were walking down is closed off.',
    options: [
      { key: 'follow_detour', label: 'Take the detour' },
      { key: 'push_through', label: 'Try to get through anyway' },
      { key: 'wait', label: 'Wait and see' },
    ],
  },
  officer_instruction: {
    id: 'officer_instruction',
    description: 'An officer right next to you just told your group where to go.',
    options: [
      { key: 'follow', label: 'Do what the officer said' },
      { key: 'ignore', label: 'Keep doing what I was doing' },
    ],
  },
  alert_received: {
    id: 'alert_received',
    description: 'A PA announcement or phone alert reached your group.',
    options: [
      { key: 'follow', label: 'Follow the instruction' },
      { key: 'ignore', label: 'Ignore it' },
      { key: 'tell_group', label: 'Stop and tell the people with me' },
    ],
  },
  heard_rumor: {
    id: 'heard_rumor',
    description: 'People around you are saying something happened nearby.',
    options: [
      { key: 'believe', label: 'Act on it' },
      { key: 'ignore', label: 'Ignore it' },
    ],
  },
  exit_route: {
    id: 'exit_route',
    description: 'The game is over and you are picking a way out.',
    options: [
      { key: 'nearest_exit', label: 'Nearest exit' },
      { key: 'my_gate', label: 'Back out the gate I came in' },
      { key: 'wait_in_seat', label: 'Sit and let it thin out' },
    ],
  },
};

export const SITUATION_IDS = Object.keys(SITUATIONS) as SituationId[];
