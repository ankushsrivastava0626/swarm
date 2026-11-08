import { describe, expect, it } from 'vitest';
import { classifyDrag, cutFrees, type Sample } from '../src/input/gestures';
import { UndoStack } from '../src/input/undo';

// a straight drag from (0, 0) at a steady speed, sampled every 16 ms
function drag(speed: number, seconds: number, angle = 0): Sample[] {
  const out: Sample[] = [];
  for (let t = 0; t <= seconds + 1e-9; t += 0.016) out.push({ x: Math.cos(angle) * speed * t, y: Math.sin(angle) * speed * t, t });
  return out;
}

describe('gesture classification', () => {
  it('reads a slow drag that starts on agents as leading them', () => {
    const s = drag(300, 0.3);
    expect(classifyDrag(s, 'agents', false, 0.3)).toBe('lead');
  });

  it('reads a flick over 1,300 px/s as a cut, wherever it starts', () => {
    expect(classifyDrag(drag(2200, 0.12), 'agents', false, 0.12)).toBe('cut');
    expect(classifyDrag(drag(2200, 0.12), 'empty', false, 0.12)).toBe('cut');
  });

  it('waits until it can tell a flick from a drag', () => {
    expect(classifyDrag(drag(300, 0.02), 'agents', false, 0.02)).toBe('pending');
  });

  it('still reads a flick that ended before it could be timed', () => {
    expect(classifyDrag(drag(2500, 0.032), 'empty', false, 0.032)).toBe('pending');
    expect(classifyDrag(drag(2500, 0.032), 'empty', false, 0.032, true)).toBe('cut');
    // a short, slow wobble at the end of a press is still nothing
    expect(classifyDrag(drag(300, 0.032), 'agents', false, 0.032, true)).toBe('pending');
  });

  it('reads a still press on food held for 260 ms as enriching it', () => {
    const still: Sample[] = [{ x: 0, y: 0, t: 0 }, { x: 1, y: 0, t: 0.1 }, { x: 1, y: 1, t: 0.27 }];
    expect(classifyDrag(still, 'food', false, 0.27)).toBe('enrich');
    expect(classifyDrag(still.slice(0, 2), 'food', false, 0.1)).toBe('pending');
  });

  it('reads moving food 6 px before the hold as moving it', () => {
    const s: Sample[] = [{ x: 0, y: 0, t: 0 }, { x: 7, y: 0, t: 0.08 }];
    expect(classifyDrag(s, 'food', false, 0.08)).toBe('move');
  });

  it('pans an empty patch only while magnified', () => {
    expect(classifyDrag(drag(300, 0.3), 'empty', true, 0.3)).toBe('pan');
    expect(classifyDrag(drag(300, 0.3), 'empty', false, 0.3)).toBe('doodle');
  });
});

describe('cutting', () => {
  const stroke: [number, number][] = [
    [100, 0],
    [100, 200],
  ];

  it('frees an agent whose way to its food crosses the stroke', () => {
    expect(cutFrees([150, 100], [40, 100], stroke)).toBe(true);
  });

  it('keeps an agent on the food side of the stroke', () => {
    expect(cutFrees([60, 100], [40, 100], stroke)).toBe(false);
  });

  it('keeps an agent whose way passes beyond the end of the stroke', () => {
    expect(cutFrees([150, 260], [40, 260], stroke)).toBe(false);
  });

  it('follows a bent stroke, segment by segment', () => {
    const bent: [number, number][] = [
      [100, 0],
      [100, 100],
      [200, 100],
    ];
    expect(cutFrees([150, 150], [150, 50], bent)).toBe(true);
  });
});

describe('undo', () => {
  it('undoes the most recent action first and reports what it undid', () => {
    const done: string[] = [];
    const u = new UndoStack();
    u.push({ label: 'Moved the food back', undo: () => done.push('move') });
    u.push({ label: 'Restored the food', undo: () => done.push('restore') });
    expect(u.undo()).toBe('Restored the food');
    expect(done).toEqual(['restore']);
    expect(u.undo()).toBe('Moved the food back');
    expect(u.undo()).toBe(null);
  });

  it('forgets the oldest actions past its depth', () => {
    const u = new UndoStack(2);
    for (const n of [1, 2, 3]) u.push({ label: String(n), undo: () => {} });
    expect(u.undo()).toBe('3');
    expect(u.undo()).toBe('2');
    expect(u.undo()).toBe(null);
  });
});
