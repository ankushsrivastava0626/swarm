import { describe, expect, it } from 'vitest';
import { Camera } from '../src/world/camera';
import { Colony } from '../src/world/colony';
import { resizeWorld } from '../src/world/resize';
import { H, harness, W } from './harness';

describe('resizing the window', () => {
  it('ignores a window squeezed to nothing, and keeps the world whole', () => {
    const c = new Colony({ w: W, h: H, seed: 4 });
    c.handle({ type: 'objective.created', objective: 'o1', text: 'Draft the launch notes', x: 820, y: 180, size: 1 });
    c.handle({ type: 'agent.spawned', agent: 'a1', role: 'builder' });
    c.handle({ type: 'agent.assigned', agent: 'a1', objective: 'o1' });
    for (let t = 0; t < 6; t += 1 / 30) c.step(1 / 30);
    const mass = c.field.total(0);
    c.resize(W, 0);
    c.resize(W, H);
    const s = c.slotOf('a1');
    expect(Number.isFinite(c.agents.x[s]) && Number.isFinite(c.agents.y[s])).toBe(true);
    expect(c.foodOf('o1')!.y).toBeCloseTo(180, 3);
    expect(c.field.total(0)).toBeCloseTo(mass, 3);

    const cam = new Camera(W, H);
    cam.resize(W, 0);
    cam.resize(W, H);
    const [x, y] = cam.toWorld(500, 350);
    expect([Math.round(x), Math.round(y)]).toEqual([500, 350]);
  });

  it('leaves the world alone when the window reports a tiny size', () => {
    const h = harness();
    expect(resizeWorld(h.app, 1200, 30)).toBe(false);
    expect([h.app.w, h.app.h]).toEqual([W, H]);
    expect(resizeWorld(h.app, 500, 350)).toBe(true);
    expect([h.app.w, h.app.h, h.colony.w, h.colony.h]).toEqual([500, 350, 500, 350]);
  });

  it('undoes a move to the same place in the world after the window changes size', () => {
    const h = harness();
    h.food('Draft the launch notes', 800, 200);
    h.key('Enter'); // pick the food up
    for (let i = 0; i < 6; i++) h.key('ArrowLeft', { shiftKey: true }); // carry it 384 px left
    h.key('Enter'); // put it down
    resizeWorld(h.app, 500, 350); // the window halves
    h.key('z', { metaKey: true });
    const back = [...h.events].reverse().find(e => e.type === 'objective.moved');
    expect(back && back.type === 'objective.moved' && Math.round(back.x)).toBe(400);
    expect(back && back.type === 'objective.moved' && Math.round(back.y)).toBe(100);
  });
});
