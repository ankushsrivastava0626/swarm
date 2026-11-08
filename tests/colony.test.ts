import { describe, expect, it } from 'vitest';
import { Colony, depthAlpha, depthCenter } from '../src/world/colony';
import { Mode } from '../src/world/agents';

const W = 1000;
const H = 700;
const run = (c: Colony, seconds: number) => {
  for (let t = 0; t < seconds; t += 1 / 30) c.step(1 / 30);
};

function colonyWithFood(x = 820, y = 180) {
  const c = new Colony({ w: W, h: H, seed: 4 });
  c.handle({ type: 'objective.created', objective: 'o1', text: 'Draft the launch notes', x, y, size: 1 });
  return c;
}

function spawn(c: Colony, id: string, role: 'scout' | 'builder' | 'critic' = 'builder') {
  c.handle({ type: 'agent.spawned', agent: id, role });
  return c.slotOf(id);
}

const distToFood = (c: Colony, slot: number, food = c.foodOf('o1')!) => Math.hypot(c.agents.x[slot] - food.x, c.agents.y[slot] - food.y);

describe('colony', () => {
  it('sends an assigned agent to its food, where it settles to work', () => {
    const c = colonyWithFood();
    const s = spawn(c, 'a1');
    c.handle({ type: 'agent.assigned', agent: 'a1', objective: 'o1' });
    run(c, 12);
    const food = c.foodOf('o1')!;
    expect(c.agents.mode[s]).toBe(Mode.Work);
    expect(distToFood(c, s)).toBeLessThan(food.r + 40);
  });

  it('brings a released agent back into the nest', () => {
    const c = colonyWithFood();
    const s = spawn(c, 'a1', 'scout');
    c.handle({ type: 'agent.assigned', agent: 'a1', objective: 'o1' });
    run(c, 10);
    c.handle({ type: 'agent.released', agent: 'a1' });
    run(c, 15);
    expect(c.agents.mode[s]).toBe(Mode.Idle);
    expect(Math.hypot(c.agents.x[s] - c.nest.x, c.agents.y[s] - c.nest.y)).toBeLessThan(c.nest.r + 10);
  });

  it('lets a failed agent go dark and settle in the midden', () => {
    const c = colonyWithFood();
    const s = spawn(c, 'a1');
    c.handle({ type: 'agent.assigned', agent: 'a1', objective: 'o1' });
    run(c, 6);
    c.handle({ type: 'agent.failed', agent: 'a1', error: 'the linter timed out three times' });
    run(c, 14);
    expect(c.slotOf('a1')).toBe(-1);
    expect(c.agents.alive[s]).toBe(0);
    expect(c.midden.husks.length).toBe(1);
    const husk = c.midden.husks[0];
    expect(Math.hypot(husk.x - c.midden.x, husk.y - c.midden.y)).toBeLessThan(c.midden.r + 20);
    expect(c.midden.log[0].text).toBe('the linter timed out three times');
  });

  it('boils with ember while in friction and cools completely when calm', () => {
    const c = colonyWithFood();
    const s = spawn(c, 'a1');
    c.handle({ type: 'agent.assigned', agent: 'a1', objective: 'o1' });
    run(c, 12);
    c.handle({ type: 'agent.friction', agent: 'a1', kind: 'contradiction', detail: 'two drafts disagree' });
    let path = 0;
    let px = c.agents.x[s];
    let py = c.agents.y[s];
    const x0 = px;
    const y0 = py;
    for (let t = 0; t < 3; t += 1 / 30) {
      c.step(1 / 30);
      path += Math.hypot(c.agents.x[s] - px, c.agents.y[s] - py);
      px = c.agents.x[s];
      py = c.agents.y[s];
    }
    expect(c.agents.ember[s]).toBeGreaterThan(0.6);
    // lots of motion, little net movement
    expect(path).toBeGreaterThan(5 * Math.hypot(px - x0, py - y0));
    c.handle({ type: 'agent.calm', agent: 'a1' });
    run(c, 6);
    expect(c.agents.ember[s]).toBeLessThan(0.01);
  });

  it('locks agreeing agents into one pulse while a dissenter keeps its own beat', () => {
    const c = colonyWithFood(500, 350);
    const team = ['a1', 'a2', 'a3', 'a4', 'a5'].map(id => spawn(c, id, 'critic'));
    const d = spawn(c, 'a6', 'critic');
    for (const id of ['a1', 'a2', 'a3', 'a4', 'a5', 'a6']) c.handle({ type: 'agent.assigned', agent: id, objective: 'o1' });
    run(c, 10);
    team.forEach((s, k) => {
      c.handle({ type: 'agent.stance', agent: c.agents.id[s]!, stance: 0.5 + k * 0.004 });
      c.agents.freq[s] = 0.5 + k * 0.03;
    });
    c.handle({ type: 'agent.stance', agent: 'a6', stance: 0.82 });
    c.agents.freq[d] = 0.8;
    run(c, 15);
    let re = 0;
    let im = 0;
    for (const s of team) {
      re += Math.cos(c.agents.phase[s]);
      im += Math.sin(c.agents.phase[s]);
    }
    expect(Math.hypot(re, im) / team.length).toBeGreaterThan(0.9);
    // the dissenter drifts against the group instead of holding a fixed offset
    const lag = () => {
      const mean = Math.atan2(im, re);
      return Math.atan2(Math.sin(c.agents.phase[d] - mean), Math.cos(c.agents.phase[d] - mean));
    };
    const offsets: number[] = [];
    for (let t = 0; t < 4; t += 0.5) {
      run(c, 0.5);
      re = 0;
      im = 0;
      for (const s of team) {
        re += Math.cos(c.agents.phase[s]);
        im += Math.sin(c.agents.phase[s]);
      }
      offsets.push(lag());
    }
    expect(Math.max(...offsets) - Math.min(...offsets)).toBeGreaterThan(1);
  });

  it('forgets an old stance when an agent moves to new work or rests', () => {
    const c = colonyWithFood();
    c.handle({ type: 'objective.created', objective: 'o2', text: 'Audit the checkout flow', x: 200, y: 500, size: 1 });
    const s = spawn(c, 'a1');
    c.handle({ type: 'agent.assigned', agent: 'a1', objective: 'o1' });
    c.handle({ type: 'agent.stance', agent: 'a1', stance: 0.4 });
    expect(c.agents.stance[s]).toBeCloseTo(0.4);
    c.handle({ type: 'agent.assigned', agent: 'a1', objective: 'o2' });
    expect(Number.isNaN(c.agents.stance[s])).toBe(true);
    c.handle({ type: 'agent.stance', agent: 'a1', stance: 0.7 });
    c.handle({ type: 'agent.released', agent: 'a1' });
    expect(Number.isNaN(c.agents.stance[s])).toBe(true);
  });

  it('remembers what a vein carries, and between where', () => {
    const c = colonyWithFood();
    const s = spawn(c, 'a1');
    c.handle({ type: 'agent.assigned', agent: 'a1', objective: 'o1' });
    run(c, 12);
    c.handle({ type: 'agent.context', agent: 'a1', op: 'write', objective: 'o1', summary: 'notes on launch' });
    const food = c.foodOf('o1')!;
    let mid: [number, number] | null = null;
    for (let t = 0; t < 20 && !mid; t += 1 / 30) {
      c.step(1 / 30);
      if (c.agents.mode[s] === Mode.Home && Math.hypot(c.agents.x[s] - food.x, c.agents.y[s] - food.y) > 150) mid = [c.agents.x[s], c.agents.y[s]];
    }
    expect(mid).not.toBeNull();
    expect(c.veinAt(mid![0], mid![1], 0.01)).toEqual({ what: 'notes on launch', from: 'Draft the launch notes', to: '' });
    // nothing laid here
    expect(c.veinAt(40, 660, 0.01)).toBeNull();
    // the way back from the nest is named by its route alone
    let back: [number, number] | null = null;
    for (let t = 0; t < 30 && !back; t += 1 / 30) {
      c.step(1 / 30);
      if (c.agents.mode[s] === Mode.Back && Math.hypot(c.agents.x[s] - c.nest.x, c.agents.y[s] - c.nest.y) > 150) back = [c.agents.x[s], c.agents.y[s]];
    }
    expect(back).not.toBeNull();
    expect(c.veinAt(back![0], back![1], 0.01)).toEqual({ what: '', from: '', to: 'Draft the launch notes' });
  });

  it('names veins right for an objective made after hundreds of others', () => {
    const c = new Colony({ w: W, h: H, seed: 4 });
    for (let i = 0; i < 300; i++) c.handle({ type: 'objective.created', objective: `o${i}`, text: `Task ${i}`, x: 820, y: 180, size: 1 });
    for (let i = 0; i < 299; i++) c.handle({ type: 'objective.abandoned', objective: `o${i}` });
    const s = spawn(c, 'a1');
    c.handle({ type: 'agent.assigned', agent: 'a1', objective: 'o299' });
    run(c, 12);
    c.handle({ type: 'agent.context', agent: 'a1', op: 'write', objective: 'o299', summary: 'notes' });
    let back: [number, number] | null = null;
    for (let t = 0; t < 40 && !back; t += 1 / 30) {
      c.step(1 / 30);
      if (c.agents.mode[s] === Mode.Back && Math.hypot(c.agents.x[s] - c.nest.x, c.agents.y[s] - c.nest.y) > 150) back = [c.agents.x[s], c.agents.y[s]];
    }
    expect(back).not.toBeNull();
    expect(c.veinAt(back![0], back![1], 0.01)).toEqual({ what: '', from: '', to: 'Task 299' });
  });

  it('keeps agreement working on an objective made after hundreds of others', () => {
    const c = new Colony({ w: W, h: H, seed: 4 });
    for (let i = 0; i < 300; i++) c.handle({ type: 'objective.created', objective: `o${i}`, text: `Task ${i}`, x: 500, y: 350, size: 1 });
    const ids = ['a1', 'a2', 'a3', 'a4', 'a5'];
    const team = ids.map(id => spawn(c, id, 'critic'));
    for (const id of ids) c.handle({ type: 'agent.assigned', agent: id, objective: 'o299' });
    run(c, 10);
    team.forEach((s, k) => {
      c.handle({ type: 'agent.stance', agent: ids[k], stance: 0.5 + k * 0.004 });
      c.agents.freq[s] = 0.5 + k * 0.03;
    });
    run(c, 15);
    let re = 0;
    let im = 0;
    for (const s of team) {
      re += Math.cos(c.agents.phase[s]);
      im += Math.sin(c.agents.phase[s]);
    }
    expect(Math.hypot(re, im) / team.length).toBeGreaterThan(0.9);
  });

  it('keeps the depth layer to the newest findings, fading with age and never stacked', () => {
    const c = new Colony({ w: W, h: H, seed: 4 });
    for (let i = 0; i < 10; i++) {
      c.handle({ type: 'objective.created', objective: `o${i}`, text: `Check service number ${i}`, x: 500, y: 300, size: 1 });
      c.handle({ type: 'objective.completed', objective: `o${i}`, finding: 'all clear' });
      run(c, 5);
    }
    run(c, 40);
    const shown = c.findings.filter(f => depthAlpha(f, c.time) > 0);
    expect(shown.map(f => f.text)).toEqual(c.findings.slice(-8).map(f => f.text));
    expect(depthAlpha(shown[0], c.time)).toBeLessThan(depthAlpha(shown[7], c.time));
    // all ten were dropped on one spot, yet the ones in view do not cover each other
    const ys = shown.map(f => depthCenter(f)[1]).sort((a, b) => a - b);
    for (let i = 1; i < ys.length; i++) expect(ys[i] - ys[i - 1]).toBeGreaterThanOrEqual(40);
    for (const y of ys) expect(y > 0 && y < H).toBe(true);
  });

  it('keeps the midden pile in its corner however many agents go dark', () => {
    const c = new Colony({ w: W, h: H, seed: 4 });
    for (let i = 0; i < 120; i++) {
      c.handle({ type: 'agent.spawned', agent: `d${i}`, role: 'builder' });
      c.handle({ type: 'agent.failed', agent: `d${i}`, error: 'timed out', past: true });
    }
    run(c, 10);
    expect(c.midden.husks.length).toBeLessThanOrEqual(48);
    for (const k of c.midden.husks) {
      expect(k.x).toBeGreaterThan(W - 200);
      expect(k.x).toBeLessThan(W);
      expect(k.y).toBeGreaterThan(H - 120);
      expect(k.y).toBeLessThan(H);
    }
    expect(c.midden.log.length).toBe(30);
  });

  it('measures how firmly a team agrees, for the steady halo', () => {
    const c = colonyWithFood(500, 350);
    const ids = ['a1', 'a2', 'a3', 'a4', 'a5'];
    const team = ids.map(id => spawn(c, id, 'critic'));
    for (const id of ids) c.handle({ type: 'agent.assigned', agent: id, objective: 'o1' });
    run(c, 10);
    expect(c.foodOf('o1')!.lock).toBe(0); // no debate yet
    team.forEach((s, k) => {
      c.handle({ type: 'agent.stance', agent: ids[k], stance: 0.5 + k * 0.004 });
      c.agents.freq[s] = 0.5 + k * 0.03;
    });
    run(c, 15);
    expect(c.foodOf('o1')!.lock).toBeGreaterThan(0.85);
  });

  it('adds up the spend the runtime reports, and knows when it reports none', () => {
    const c = colonyWithFood();
    spawn(c, 'a1');
    spawn(c, 'a2');
    run(c, 0.1);
    expect(c.spendKnown).toBe(false);
    expect(c.spend).toBe(0);
    c.handle({ type: 'agent.effort', agent: 'a1', effort: 0.5, cost: 1.2 });
    c.handle({ type: 'agent.effort', agent: 'a2', effort: 0.2, cost: 0.3 });
    run(c, 0.1);
    expect(c.spendKnown).toBe(true);
    expect(c.spend).toBeCloseTo(1.5, 5);
    c.handle({ type: 'agent.failed', agent: 'a2', error: 'timed out' });
    run(c, 2);
    expect(c.spend).toBeCloseTo(1.2, 5);
  });

  it('sends a writer home along a pheromone trail and back to work', () => {
    const c = colonyWithFood();
    const s = spawn(c, 'a1');
    c.handle({ type: 'agent.assigned', agent: 'a1', objective: 'o1' });
    run(c, 12);
    const before = c.field.total(0);
    c.handle({ type: 'agent.context', agent: 'a1', op: 'write', objective: 'o1', summary: 'notes' });
    let sawHome = false;
    let reachedNest = false;
    for (let t = 0; t < 25; t += 1 / 30) {
      c.step(1 / 30);
      if (c.agents.mode[s] === Mode.Home) sawHome = true;
      if (Math.hypot(c.agents.x[s] - c.nest.x, c.agents.y[s] - c.nest.y) < c.nest.r + 12) reachedNest = true;
    }
    expect(sawHome).toBe(true);
    expect(reachedNest).toBe(true);
    expect(c.field.total(0)).toBeGreaterThan(before + 1);
    expect(c.agents.mode[s]).toBe(Mode.Work);
  });

  it('folds a merged helper into its parent', () => {
    const c = colonyWithFood();
    spawn(c, 'a1');
    c.handle({ type: 'agent.assigned', agent: 'a1', objective: 'o1' });
    run(c, 10);
    c.handle({ type: 'agent.spawned', agent: 'h1', role: 'scout', parent: 'a1' });
    c.handle({ type: 'agent.assigned', agent: 'h1', objective: 'o1' });
    run(c, 4);
    expect(c.slotOf('h1')).toBeGreaterThanOrEqual(0);
    c.handle({ type: 'agent.merged', agent: 'h1', into: 'a1' });
    run(c, 8);
    expect(c.slotOf('h1')).toBe(-1);
    expect(c.slotOf('a1')).toBeGreaterThanOrEqual(0);
  });

  it('crystallizes a finding where the food was', () => {
    const c = colonyWithFood(600, 300);
    const found: { text: string; finding: string; x: number; y: number }[] = [];
    c.hooks.crystallize = (food, finding) => found.push({ text: food.text, finding, x: food.x, y: food.y });
    c.handle({ type: 'objective.completed', objective: 'o1', finding: 'draft ready, 640 words' });
    run(c, 2);
    expect(found).toEqual([{ text: 'Draft the launch notes', finding: 'draft ready, 640 words', x: 600, y: 300 }]);
  });

  it('turns agents within reach toward a still cursor without changing their work', () => {
    const c = colonyWithFood(500, 350);
    const near = spawn(c, 'a1');
    const far = spawn(c, 'a2');
    c.handle({ type: 'agent.assigned', agent: 'a1', objective: 'o1' });
    c.handle({ type: 'agent.assigned', agent: 'a2', objective: 'o1' });
    run(c, 12);
    const p = { x: c.agents.x[near] + 20, y: c.agents.y[near] + 10 };
    c.agents.x[far] = 900;
    c.agents.y[far] = 650;
    for (let t = 0; t < 1.5; t += 1 / 30) {
      c.pointer = { present: true, x: p.x, y: p.y, vx: 0, vy: 0, still: t > 0.3, reach: 60 };
      c.step(1 / 30);
    }
    expect(c.agents.attn[near]).toBeGreaterThan(0.6);
    expect(c.agents.attn[far]).toBeLessThan(0.05);
    expect(c.agents.mode[near]).toBe(Mode.Work);
  });
});
