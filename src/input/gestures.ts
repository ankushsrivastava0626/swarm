// Telling one gesture from another. Pure functions, so the thresholds can be tested.

export interface Sample {
  x: number; // screen pixels
  y: number;
  t: number; // seconds
}

export type PressTarget = 'food' | 'agents' | 'empty';
export type DragKind = 'pending' | 'lead' | 'cut' | 'move' | 'enrich' | 'pan' | 'doodle';

export const SLOP = 6; // px of wobble before a press counts as a drag
export const HOLD = 0.26; // s still on food before it counts as pressing to enrich
export const DECIDE = 0.06; // s of motion needed to tell a flick from a drag
export const CUT_SPEED = 1300; // px/s: faster hands cut, slower hands lead

// final: the hand has let go, so judge on what there is instead of waiting to be sure
export function classifyDrag(samples: Sample[], target: PressTarget, zoomed: boolean, now: number, final = false): DragKind {
  const p = samples[0];
  let moved = -1;
  for (let i = 1; i < samples.length; i++) {
    if (Math.hypot(samples[i].x - p.x, samples[i].y - p.y) >= SLOP) {
      moved = i;
      break;
    }
  }
  if (target === 'food') {
    if (moved >= 0) return 'move';
    return now - p.t >= HOLD ? 'enrich' : 'pending';
  }
  if (moved < 0) return 'pending';
  // the hand's speed since it started moving
  const start = samples[Math.max(0, moved - 1)];
  const last = samples[samples.length - 1];
  const span = last.t - start.t;
  if (span < DECIDE && !final) return 'pending';
  let path = 0;
  for (let i = Math.max(1, moved); i < samples.length; i++) path += Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y);
  if (path / Math.max(span, 1 / 120) > CUT_SPEED) return 'cut';
  // a hand that let go before it could be timed, and was not flicking, did nothing
  if (span < DECIDE) return 'pending';
  return target === 'agents' ? 'lead' : zoomed ? 'pan' : 'doodle';
}

// do segments ab and cd cross?
export function segmentsCross(a: [number, number], b: [number, number], c: [number, number], d: [number, number]): boolean {
  const o = (p: [number, number], q: [number, number], r: [number, number]) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(c, d, a);
  const d2 = o(c, d, b);
  const d3 = o(a, b, c);
  const d4 = o(a, b, d);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

// a cut frees an agent when the stroke separates it from its food
export function cutFrees(agent: [number, number], food: [number, number], stroke: [number, number][]): boolean {
  for (let i = 1; i < stroke.length; i++) if (segmentsCross(agent, food, stroke[i - 1], stroke[i])) return true;
  return false;
}
