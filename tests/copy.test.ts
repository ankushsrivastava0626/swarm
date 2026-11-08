import { describe, expect, it } from 'vitest';
import { READOUT, restingHint } from '../src/glass/copy';

const words = (s: string) => s.split(/\s+/).filter(w => /[a-z]/i.test(w)).length;

describe('the glass at rest', () => {
  it('carries fewer than a dozen words, with a mouse or a finger', () => {
    const readout = Object.values(READOUT).reduce((n, s) => n + words(s), 0);
    for (const coarse of [false, true]) expect(words(restingHint(coarse)) + readout).toBeLessThan(12);
  });
});
