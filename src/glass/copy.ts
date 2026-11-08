// The words the glass carries at rest. They are counted: fewer than a dozen, with a mouse or a finger.
export const READOUT = { working: 'at work', spend: 'an hour', simulated: 'simulated' } as const;

// what a screen reader is told the page is, when the agents are real rather than simulated
export const ABOUT_LIVE = 'A live swarm of real AI agents shown as a glowing colony. Type anywhere to give it an objective. Press Alt+H for the full list of keys.';

export function restingHint(coarse: boolean): string {
  return coarse ? 'Tap anywhere, then type' : 'Type anywhere to feed the colony';
}
