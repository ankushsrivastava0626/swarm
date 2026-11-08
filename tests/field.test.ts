import { describe, expect, it } from 'vitest';
import { Field } from '../src/world/field';

describe('pheromone field', () => {
  it('halves a uniform field after one half-life', () => {
    const f = new Field(200, 100, 10, [{ halfLife: 90, diffusion: 2 }]);
    f.data[0].fill(1);
    for (let t = 0; t < 90 - 1e-9; t += 1 / 30) f.step(1 / 30);
    const mid = f.data[0][5 * f.cols + 10];
    expect(mid).toBeGreaterThan(0.495);
    expect(mid).toBeLessThan(0.505);
  });

  it('conserves mass while diffusing when nothing decays', () => {
    const f = new Field(300, 200, 10, [{ halfLife: Infinity, diffusion: 4 }]);
    f.deposit(0, 150, 100, 50);
    f.deposit(0, 3, 3, 20); // against the corner, where the edges must reflect
    const before = f.total(0);
    for (let i = 0; i < 600; i++) f.step(1 / 60);
    expect(Math.abs(f.total(0) - before) / before).toBeLessThan(0.005);
    expect(f.sample(0, 150, 100)).toBeLessThan(50); // it did spread
  });

  it('adds exactly the deposited amount and reads it back near the point', () => {
    const f = new Field(300, 200, 10, [{ halfLife: Infinity, diffusion: 0 }]);
    f.deposit(0, 123, 77, 3);
    expect(f.total(0)).toBeCloseTo(3, 6);
    expect(f.sample(0, 123, 77)).toBeGreaterThan(0.5);
    expect(f.sample(0, 250, 170)).toBe(0);
  });

  it('spreads a segment deposit along its length', () => {
    const f = new Field(300, 200, 10, [{ halfLife: Infinity, diffusion: 0 }]);
    f.depositSegment(0, 20, 100, 280, 100, 26);
    expect(f.total(0)).toBeCloseTo(26, 4);
    expect(f.sample(0, 60, 100)).toBeGreaterThan(0);
    expect(f.sample(0, 240, 100)).toBeGreaterThan(0);
    expect(f.sample(0, 150, 20)).toBe(0);
  });

  it('keeps its pattern when the world is resized', () => {
    const f = new Field(300, 200, 10, [{ halfLife: Infinity, diffusion: 0 }]);
    f.deposit(0, 75, 50, 10);
    f.resize(600, 400);
    expect(f.sample(0, 150, 100)).toBeGreaterThan(f.sample(0, 450, 300) + 0.1);
  });
});
