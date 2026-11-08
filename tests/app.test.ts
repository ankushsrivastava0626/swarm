import { describe, expect, it } from 'vitest';
import { colonySize, openingDefocus } from '../src/app';

describe('the opening', () => {
  it('pulls focus over the first second, and not at all for reduced motion', () => {
    expect(openingDefocus(0, false)).toBe(1);
    expect(openingDefocus(0.55, false)).toBeGreaterThan(0);
    expect(openingDefocus(1.1, false)).toBe(0);
    expect(openingDefocus(0, true)).toBe(0);
  });

  it('reads the colony size from the address, within limits', () => {
    expect(colonySize('')).toBe(700);
    expect(colonySize('?colony=1000')).toBe(1000);
    expect(colonySize('?colony=5000')).toBe(1100);
    expect(colonySize('?colony=3')).toBe(50);
    expect(colonySize('?colony=many')).toBe(700);
  });
});
