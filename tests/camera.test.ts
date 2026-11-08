import { describe, expect, it } from 'vitest';
import { Camera } from '../src/world/camera';

const settle = (c: Camera) => { for (let i = 0; i < 240; i++) c.step(1 / 60); };

describe('camera', () => {
  it('keeps the world point under the cursor fixed while magnifying', () => {
    const c = new Camera(1200, 800);
    const [wx, wy] = c.toWorld(300, 200);
    c.zoomAt(300, 200, 2.5);
    settle(c);
    expect(c.zoom).toBeCloseTo(2.5, 3);
    const [ax, ay] = c.toWorld(300, 200);
    expect(ax).toBeCloseTo(wx, 2);
    expect(ay).toBeCloseTo(wy, 2);
  });

  it('never magnifies below 1 and returns to the whole world', () => {
    const c = new Camera(1200, 800);
    c.zoomAt(1100, 700, 3);
    settle(c);
    c.zoomAt(100, 100, 0.01);
    settle(c);
    expect(c.zoom).toBe(1);
    expect(c.toWorld(600, 400)).toEqual([600, 400]);
  });

  it('round-trips between screen and world', () => {
    const c = new Camera(1200, 800);
    c.zoomAt(900, 300, 4);
    settle(c);
    const [wx, wy] = c.toWorld(123, 456);
    const [sx, sy] = c.toScreen(wx, wy);
    expect(sx).toBeCloseTo(123, 4);
    expect(sy).toBeCloseTo(456, 4);
  });
});
