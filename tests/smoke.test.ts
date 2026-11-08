import { describe, expect, it } from 'vitest';
import { PALETTE, toLinear } from '../src/palette';

describe('palette', () => {
  it('keeps the approved hex values', () => {
    expect(PALETTE).toEqual({
      abyss: '#041012',
      silt: '#10262A',
      luciferin: '#5FE3C2',
      bloom: '#E4FFF5',
      ember: '#FF7442',
      bone: '#D8D0C0',
    });
  });

  it('converts sRGB hex to linear light', () => {
    const [r, g, b] = toLinear('#FFFFFF');
    expect([r, g, b]).toEqual([1, 1, 1]);
    expect(toLinear('#000000')).toEqual([0, 0, 0]);
    expect(toLinear('#808080')[0]).toBeCloseTo(0.2159, 3);
  });
});
