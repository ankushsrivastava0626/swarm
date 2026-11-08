// The six colours of the world. Each one means something; see the design doc.
export const PALETTE = {
  abyss: '#041012', // the medium
  silt: '#10262A', // old, faint pheromone
  luciferin: '#5FE3C2', // the colony's light
  bloom: '#E4FFF5', // luciferin at full strength
  ember: '#FF7442', // friction, and nothing else
  bone: '#D8D0C0', // anything a person made; never glows
} as const;

export type Rgb = [number, number, number];

const channel = (v: number): number => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};

// Shaders blend light linearly, so palette colours go in as linear RGB.
export function toLinear(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return [channel((n >> 16) & 255), channel((n >> 8) & 255), channel(n & 255)];
}

export const LINEAR = {
  abyss: toLinear(PALETTE.abyss),
  silt: toLinear(PALETTE.silt),
  luciferin: toLinear(PALETTE.luciferin),
  bloom: toLinear(PALETTE.bloom),
  ember: toLinear(PALETTE.ember),
  bone: toLinear(PALETTE.bone),
};
