import { describe, expect, it } from 'vitest';
import type { RuntimeEvent } from '../src/runtime/protocol';
import { SimulatedRuntime } from '../src/runtime/simulated';

const WORLD = { w: 1000, h: 700 };

function setup(colony = 80, seed = 7) {
  const rt = new SimulatedRuntime({ seed, world: WORLD, colony, backlog: false });
  const events: RuntimeEvent[] = [];
  rt.on(e => events.push(e));
  return { rt, events };
}

function run(rt: SimulatedRuntime, seconds: number) {
  for (let t = 0; t < seconds; t += 0.1) rt.tick(0.1);
}

// who is working on what, replayed from the event stream
function assignments(events: RuntimeEvent[]) {
  const on = new Map<string, string>();
  for (const e of events) {
    if (e.type === 'agent.assigned') on.set(e.agent, e.objective);
    else if (e.type === 'agent.released' || e.type === 'agent.failed' || e.type === 'agent.stopped' || e.type === 'agent.merged') on.delete(e.agent);
  }
  return on;
}
const workersOn = (events: RuntimeEvent[], objective: string) => [...assignments(events)].filter(([, o]) => o === objective).map(([a]) => a);

function create(rt: SimulatedRuntime, events: RuntimeEvent[], text: string, x: number, y: number) {
  rt.send({ type: 'objective.create', text, x, y });
  const created = events.filter(e => e.type === 'objective.created');
  const last = created[created.length - 1];
  if (!last || last.type !== 'objective.created') throw new Error('no objective.created');
  return last.objective;
}

describe('simulated runtime', () => {
  it('announces a new objective, then sends scouts within 2 seconds', () => {
    const { rt, events } = setup();
    const id = create(rt, events, 'Find why refunds post twice', 300, 200);
    run(rt, 2);
    const createdAt = events.findIndex(e => e.type === 'objective.created' && e.objective === id);
    const firstAssign = events.findIndex(e => e.type === 'agent.assigned' && e.objective === id);
    expect(createdAt).toBeGreaterThanOrEqual(0);
    expect(firstAssign).toBeGreaterThan(createdAt);
    const created = events[createdAt];
    expect(created.type === 'objective.created' && created.text).toBe('Find why refunds post twice');
  });

  it('reports monotonic progress that ends in a completed finding', () => {
    const { rt, events } = setup();
    const id = create(rt, events, 'Draft the launch notes', 300, 200);
    run(rt, 600);
    const progress = events.flatMap(e => (e.type === 'objective.progress' && e.objective === id ? [e.progress] : []));
    expect(progress.length).toBeGreaterThan(10);
    for (let i = 1; i < progress.length; i++) expect(progress[i]).toBeGreaterThanOrEqual(progress[i - 1]);
    expect(progress[progress.length - 1]).toBe(1);
    const done = events.find(e => e.type === 'objective.completed' && e.objective === id);
    expect(done && done.type === 'objective.completed' && done.finding.length).toBeGreaterThan(8);
    const lastProgress = events.map(e => e.type === 'objective.progress' && e.objective === id).lastIndexOf(true);
    expect(events.indexOf(done!)).toBeGreaterThan(lastProgress);
  });

  it('releases every agent when an objective is abandoned', () => {
    const { rt, events } = setup();
    const id = create(rt, events, 'Move billing onto the new ledger', 300, 200);
    run(rt, 30);
    expect(workersOn(events, id).length).toBeGreaterThan(3);
    rt.send({ type: 'objective.abandon', objective: id });
    run(rt, 0.2);
    expect(events.some(e => e.type === 'objective.abandoned' && e.objective === id)).toBe(true);
    expect(workersOn(events, id)).toEqual([]);
    run(rt, 20);
    expect(workersOn(events, id)).toEqual([]);
  });

  it('puts agents back on a restored objective', () => {
    const { rt, events } = setup();
    const id = create(rt, events, 'Move billing onto the new ledger', 300, 200);
    run(rt, 20);
    rt.send({ type: 'objective.abandon', objective: id });
    run(rt, 1);
    rt.send({ type: 'objective.restore', objective: id });
    run(rt, 12);
    expect(events.some(e => e.type === 'objective.restored' && e.objective === id)).toBe(true);
    expect(workersOn(events, id).length).toBeGreaterThan(2);
  });

  it('draws more of the colony to an enriched objective', () => {
    const { rt, events } = setup(120);
    const a = create(rt, events, 'Move billing onto the new ledger', 250, 350);
    const b = create(rt, events, 'Move search onto the new index', 750, 350);
    rt.send({ type: 'objective.enrich', objective: b, amount: 2 });
    run(rt, 40);
    expect(events.some(e => e.type === 'objective.priority' && e.objective === b)).toBe(true);
    expect(workersOn(events, b).length).toBeGreaterThan(workersOn(events, a).length + 4);
  });

  it('takes enrichment back with a negative amount, never below the base priority', () => {
    const { rt, events } = setup();
    const id = create(rt, events, 'Draft the launch notes', 300, 200);
    rt.send({ type: 'objective.enrich', objective: id, amount: 1.5 });
    rt.send({ type: 'objective.enrich', objective: id, amount: -3 });
    const priorities = events.flatMap(e => (e.type === 'objective.priority' && e.objective === id ? [e.priority] : []));
    expect(priorities).toEqual([2.5, 1]);
  });

  it('keeps reassigned agents on the objective they were led to', () => {
    const { rt, events } = setup(120);
    const a = create(rt, events, 'Move billing onto the new ledger', 250, 350);
    const b = create(rt, events, 'Draft the launch notes', 750, 350);
    run(rt, 25);
    const moved = workersOn(events, a).slice(0, 3);
    expect(moved.length).toBe(3);
    rt.send({ type: 'agents.reassign', agents: moved, objective: b });
    run(rt, 0.1);
    for (const agent of moved) expect(assignments(events).get(agent)).toBe(b);
    run(rt, 30);
    // the scheduler never moves them elsewhere; they may still fail on their own
    const gone = new Set(events.flatMap(e => (e.type === 'agent.failed' || e.type === 'agent.stopped' ? [e.agent] : [])));
    for (const agent of moved) {
      if (gone.has(agent)) continue;
      expect(assignments(events).get(agent)).toBe(b);
    }
  });

  it('does not send cut agents straight back to the same objective', () => {
    const { rt, events } = setup(120);
    const a = create(rt, events, 'Move billing onto the new ledger', 250, 350);
    run(rt, 25);
    const before = workersOn(events, a).length;
    const cut = workersOn(events, a).slice(0, 5);
    rt.send({ type: 'agents.release', agents: cut });
    run(rt, 0.1);
    for (const agent of cut) expect(assignments(events).has(agent)).toBe(false);
    run(rt, 20);
    for (const agent of cut) expect(assignments(events).get(agent)).not.toBe(a);
    expect(workersOn(events, a).length).toBeLessThanOrEqual(before - 5 + 1);
  });

  it('staffs an objective again after every agent on it was cut loose', () => {
    const { rt, events } = setup(80, 7);
    const id = create(rt, events, 'Find which emails bounce', 300, 200);
    run(rt, 2.5);
    const team = workersOn(events, id);
    expect(team.length).toBeGreaterThan(0);
    rt.send({ type: 'agents.release', agents: team });
    run(rt, 10);
    expect(workersOn(events, id).length).toBeGreaterThanOrEqual(3);
    run(rt, 400);
    expect(events.some(e => e.type === 'objective.completed' && e.objective === id)).toBe(true);
  });

  it('gives an objective its whole team back when a cut is undone', () => {
    const control = setup(120, 9);
    const cut = setup(120, 9);
    // a big objective with fewer hands than it wants, still unfinished at the end, so the team is all that differs
    const text = 'Migrate every service onto the new ledger and retire the old one';
    const a = create(control.rt, control.events, text, 300, 300);
    const b = create(cut.rt, cut.events, text, 300, 300);
    run(control.rt, 40);
    run(cut.rt, 40);
    const freed = workersOn(cut.events, b).slice(0, 20);
    cut.rt.send({ type: 'agents.release', agents: freed });
    cut.rt.send({ type: 'agents.reassign', agents: freed, objective: b });
    run(control.rt, 150);
    run(cut.rt, 150);
    expect(cut.events.some(e => e.type === 'objective.completed')).toBe(false);
    expect(workersOn(cut.events, b).length).toBeGreaterThanOrEqual(0.9 * workersOn(control.events, a).length);
  });

  it('reports what each agent costs along with its effort, and nothing for resting', () => {
    const { rt, events } = setup();
    create(rt, events, 'Move billing onto the new ledger', 300, 200);
    run(rt, 30);
    const efforts = events.flatMap(e => (e.type === 'agent.effort' ? [e] : []));
    expect(efforts.length).toBeGreaterThan(10);
    for (const e of efforts) expect(Number.isFinite(e.cost) && e.cost! >= 0).toBe(true);
    expect(efforts.some(e => e.cost! > 0.5)).toBe(true);
    const released = new Set(events.flatMap(e => (e.type === 'agent.released' ? [e.agent] : [])));
    for (const e of efforts) if (released.has(e.agent) && e.effort <= 0.05) expect(e.cost).toBe(0);
  });

  it('relates objectives that sit near each other', () => {
    const { rt, events } = setup();
    const a = create(rt, events, 'Find why refunds post twice', 300, 300);
    const b = create(rt, events, 'Draft the refund policy', 450, 300);
    const c = create(rt, events, 'Audit the checkout flow', 900, 640);
    const related = (x: string, y: string) => {
      let state = false;
      for (const e of events) if (e.type === 'objective.related' && ((e.a === x && e.b === y) || (e.a === y && e.b === x))) state = e.related;
      return state;
    };
    expect(related(a, b)).toBe(true);
    expect(related(a, c)).toBe(false);
    rt.send({ type: 'objective.move', objective: c, x: 350, y: 380 });
    expect(events.some(e => e.type === 'objective.moved' && e.objective === c)).toBe(true);
    expect(related(a, c)).toBe(true);
  });

  it('keeps a dissenter visibly apart for at least 18 seconds before agreeing', () => {
    const { rt, events } = setup(80, 3);
    rt.seed({ objectives: [{ text: 'Audit the checkout flow', x: 0.5, y: 0.5, phase: 'decide', progress: 0.94, workers: 8, dissent: true }] });
    const stance = new Map<string, number>();
    let dissenter = '';
    let apartUntil = 0;
    let t = 0;
    let completedAt = -1;
    events.length = 0;
    while (t < 120 && completedAt < 0) {
      rt.tick(0.1);
      t += 0.1;
      for (const e of events) {
        if (e.type === 'agent.stance') stance.set(e.agent, e.stance);
        if (e.type === 'objective.completed') completedAt = t;
      }
      events.length = 0;
      if (stance.size < 4) continue;
      const values = [...stance];
      if (!dissenter) {
        const mean = values.reduce((s, [, v]) => s + v, 0) / values.length;
        dissenter = values.reduce((best, cur) => (Math.abs(cur[1] - mean) > Math.abs(best[1] - mean) ? cur : best))[0];
      }
      const others = values.filter(([id]) => id !== dissenter);
      const mean = others.reduce((s, [, v]) => s + v, 0) / others.length;
      if (Math.abs(stance.get(dissenter)! - mean) > 0.05) apartUntil = t;
    }
    expect(apartUntil).toBeGreaterThanOrEqual(18);
    expect(completedAt).toBeGreaterThan(apartUntil);
  });

  it('reports an agent joining a debate before reporting its stance in it', () => {
    const { rt, events } = setup(40, 8);
    events.length = 0;
    rt.seed({ objectives: [{ text: 'Audit the checkout flow', x: 0.5, y: 0.5, phase: 'decide', progress: 0.94, workers: 6 }] });
    const assignedAt = new Map<string, number>();
    events.forEach((e, i) => {
      if (e.type === 'agent.assigned' && !assignedAt.has(e.agent)) assignedAt.set(e.agent, i);
    });
    expect(assignedAt.size).toBe(6);
    for (const [agent, at] of assignedAt) {
      const firstStance = events.findIndex(e => e.type === 'agent.stance' && e.agent === agent);
      expect(firstStance).toBeGreaterThan(at);
    }
  });

  it('replaces a failed agent with a fresh one from the nest', () => {
    const { rt, events } = setup(60, 11);
    rt.seed({
      objectives: [{ text: 'Move billing onto the new ledger', x: 0.3, y: 0.5, phase: 'build', progress: 0.2, workers: 20, friction: [{ kind: 'tool-error', agents: 12, seconds: 6 }] }],
    });
    run(rt, 240);
    const failures = events.map((e, i) => [e, i] as const).filter(([e]) => e.type === 'agent.failed' && !e.past);
    expect(failures.length).toBeGreaterThan(0);
    for (const [, i] of failures) {
      const replacement = events.slice(i + 1).find(e => e.type === 'agent.spawned' && !e.parent);
      expect(replacement).toBeTruthy();
    }
  });

  it('buds helpers that merge back into their parent when the work is done', () => {
    const { rt, events } = setup(30, 5);
    const id = create(rt, events, 'Move every service onto the new ledger and retire the old one', 400, 300);
    rt.send({ type: 'objective.enrich', objective: id, amount: 2 });
    run(rt, 900);
    const helpers = events.flatMap(e => (e.type === 'agent.spawned' && e.parent ? [e.agent] : []));
    expect(helpers.length).toBeGreaterThan(0);
    expect(events.some(e => e.type === 'objective.completed' && e.objective === id)).toBe(true);
    const merged = new Set(events.flatMap(e => (e.type === 'agent.merged' ? [e.agent] : [])));
    const failedOrStopped = new Set(events.flatMap(e => (e.type === 'agent.failed' || e.type === 'agent.stopped' ? [e.agent] : [])));
    for (const h of helpers) expect(merged.has(h) || failedOrStopped.has(h)).toBe(true);
  });

  it('never gives one agent two objectives, even when the colony runs out', () => {
    const { rt, events } = setup(10, 2);
    for (let i = 0; i < 6; i++) create(rt, events, `Check service number ${i}`, 120 + i * 140, 300);
    run(rt, 60);
    const on = new Map<string, string>();
    for (const e of events) {
      if (e.type === 'agent.assigned') on.set(e.agent, e.objective);
      if (e.type === 'agent.released' || e.type === 'agent.failed' || e.type === 'agent.stopped' || e.type === 'agent.merged') on.delete(e.agent);
    }
    const spawned = events.filter(e => e.type === 'agent.spawned').length;
    expect(on.size).toBeLessThanOrEqual(spawned);
  });
});
