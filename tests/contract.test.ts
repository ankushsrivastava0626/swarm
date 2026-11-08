// The spec's contract and hands, row by row: what the agents do and what you see.
import { describe, expect, it } from 'vitest';
import { Mode } from '../src/world/agents';
import { Colony } from '../src/world/colony';

const W = 1000;
const H = 700;
const run = (c: Colony, seconds: number) => {
  for (let t = 0; t < seconds; t += 1 / 30) c.step(1 / 30);
};
function colony() {
  const c = new Colony({ w: W, h: H, seed: 4 });
  c.handle({ type: 'objective.created', objective: 'o1', text: 'Draft the launch notes', x: 300, y: 200, size: 1 });
  return c;
}
function worker(c: Colony, id: string, objective = 'o1') {
  c.handle({ type: 'agent.spawned', agent: id, role: 'builder' });
  c.handle({ type: 'agent.assigned', agent: id, objective });
  return c.slotOf(id);
}

describe('the contract', () => {
  it('makes an agent that thinks harder move faster and glow brighter', () => {
    const c = colony();
    const hard = worker(c, 'a1');
    const easy = worker(c, 'a2');
    run(c, 10);
    c.handle({ type: 'agent.effort', agent: 'a1', effort: 0.95 });
    c.handle({ type: 'agent.effort', agent: 'a2', effort: 0.05 });
    run(c, 6);
    let sh = 0;
    let se = 0;
    let gh = 0;
    let ge = 0;
    for (let i = 0; i < 90; i++) {
      c.step(1 / 30);
      sh += Math.hypot(c.agents.vx[hard], c.agents.vy[hard]);
      se += Math.hypot(c.agents.vx[easy], c.agents.vy[easy]);
      gh += c.agents.glow[hard];
      ge += c.agents.glow[easy];
    }
    expect(c.agents.mode[hard]).toBe(Mode.Work);
    expect(sh).toBeGreaterThan(se * 1.3);
    expect(gh).toBeGreaterThan(ge * 1.5);
  });

  it('passes a spark from one agent to another, and lights the one it reaches', () => {
    const c = colony();
    worker(c, 'a1');
    const to = worker(c, 'a2');
    run(c, 10);
    c.handle({ type: 'agent.handoff', from: 'a1', to: 'a2', summary: 'notes' });
    expect(c.sparks.length).toBe(1);
    let landed = false;
    for (let t = 0; t < 3 && !landed; t += 1 / 30) {
      c.step(1 / 30);
      if (c.sparks.length === 0) landed = true;
    }
    expect(landed).toBe(true);
    expect(c.agents.flash[to]).toBeGreaterThan(0.3);
  });

  it('draws a retry as a loop, again and again around the same place', () => {
    const c = colony();
    const s = worker(c, 'a1');
    run(c, 10);
    c.handle({ type: 'agent.friction', agent: 'a1', kind: 'retry', detail: 'the test runner flaked, trying again' });
    run(c, 1);
    const cx = c.agents.loopX[s];
    const cy = c.agents.loopY[s];
    const radii: number[] = [];
    let path = 0;
    let px = c.agents.x[s];
    let py = c.agents.y[s];
    for (let i = 0; i < 120; i++) {
      c.step(1 / 30);
      radii.push(Math.hypot(c.agents.x[s] - cx, c.agents.y[s] - cy));
      path += Math.hypot(c.agents.x[s] - px, c.agents.y[s] - py);
      px = c.agents.x[s];
      py = c.agents.y[s];
    }
    radii.sort((a, b) => a - b);
    // it keeps going round (several laps in 4 s) at a steady distance from the same centre
    expect(path).toBeGreaterThan(3 * 2 * Math.PI * 15);
    expect(radii[Math.floor(radii.length * 0.9)] - radii[Math.floor(radii.length * 0.1)]).toBeLessThan(12);
  });

  it('zigzags an undecided agent between the two foods it cannot choose between', () => {
    const c = colony();
    c.handle({ type: 'objective.created', objective: 'o2', text: 'Audit the checkout flow', x: 760, y: 200, size: 1 });
    const s = worker(c, 'a1');
    run(c, 10);
    c.handle({ type: 'agent.undecided', agent: 'a1', between: ['o1', 'o2'] });
    let flips = 0;
    let last = 0;
    for (let i = 0; i < 240; i++) {
      c.step(1 / 30);
      const v = Math.sign(c.agents.vx[s]);
      if (v && last && v !== last) flips++;
      if (v) last = v;
    }
    expect(c.agents.mode[s]).toBe(Mode.Doubt);
    expect(flips).toBeGreaterThanOrEqual(3);
  });
});

describe('the hand', () => {
  it('parts agents like water as it passes through them', () => {
    const away = (present: boolean) => {
      const c = colony();
      const s = worker(c, 'a1');
      run(c, 10);
      const x = c.agents.x[s];
      const y = c.agents.y[s];
      // the hand sweeps past 10 px to one side, moving at 600 px/s
      c.pointer = { present, x: x - 10, y: y - 30, vx: 0, vy: 600, still: false, reach: 40 };
      for (let i = 0; i < 4; i++) {
        c.pointer = { ...c.pointer, y: c.pointer.y + 20 };
        c.step(1 / 30);
      }
      return c.agents.x[s] - x;
    };
    expect(away(true)).toBeGreaterThan(away(false) + 2);
  });

  it('sends one turn rippling through the flock, well beyond the hand', () => {
    const c = colony();
    const slots: number[] = [];
    for (let i = 0; i < 60; i++) {
      c.handle({ type: 'agent.spawned', agent: `a${i}`, role: 'builder' });
      const s = c.slotOf(`a${i}`);
      c.agents.x[s] = 200 + (i % 20) * 22;
      c.agents.y[s] = 500 + Math.floor(i / 20) * 22;
      c.agents.vx[s] = 30;
      slots.push(s);
    }
    c.step(1 / 30);
    // a quick pass across the left end of the flock
    c.pointer = { present: true, x: 190, y: 460, vx: 0, vy: 1800, still: false, reach: 40 };
    c.step(1 / 60);
    for (let i = 0; i < 3; i++) {
      c.pointer = { ...c.pointer, y: c.pointer.y + 30 };
      c.step(1 / 60);
    }
    c.pointer = { ...c.pointer, present: false };
    run(c, 1.5);
    const turned = slots.filter(s => c.agents.waveId[s] > 0);
    const far = turned.filter(s => c.agents.x[s] > 330);
    expect(turned.length).toBeGreaterThan(30);
    expect(far.length).toBeGreaterThan(10);
  });
});
