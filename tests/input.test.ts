import { describe, expect, it } from 'vitest';
import { harness } from './harness';

describe('keys', () => {
  it('never acts on the world while someone is still typing', () => {
    const h = harness();
    h.food('Draft the launch notes', 300, 200);
    h.type('ab');
    h.key('Delete'); // forward delete inside the draft
    h.type('a');
    h.key('Backspace');
    h.type('');
    h.key('Backspace', { repeat: true }); // the held key runs on past the last letter
    h.key('Backspace'); // and is pressed once more, straight after
    expect(h.events.some(e => e.type === 'objective.abandoned')).toBe(false);
  });

  it('leaves Cmd+Z to the text while a draft is being typed', () => {
    const h = harness();
    h.food('Draft the launch notes', 300, 200);
    h.key('Enter'); // pick the food up
    h.key('ArrowRight', { shiftKey: true });
    h.key('Enter'); // and put it down: a move that can be undone
    const moves = h.events.filter(e => e.type === 'objective.moved').length;
    h.type('ab');
    const prevented = h.key('z', { metaKey: true });
    expect(prevented).toBe(false);
    expect(h.events.filter(e => e.type === 'objective.moved').length).toBe(moves);
  });

  it('undoes an abandon by restoring the objective', () => {
    const h = harness();
    h.food('Draft the launch notes', 300, 200);
    h.key('Delete');
    expect(h.events.some(e => e.type === 'objective.abandoned')).toBe(true);
    h.key('z', { metaKey: true });
    expect(h.events.some(e => e.type === 'objective.restored')).toBe(true);
  });
});
