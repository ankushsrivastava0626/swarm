import { describe, expect, it } from 'vitest';
import { isLive } from '../src/app';
import type { RuntimeEvent } from '../src/runtime/protocol';
import { RemoteRuntime, type EventStream } from '../src/runtime/remote';
import { type Note, readDecision, readPlan, readVerdict } from '../server/briefs';
import { type Engine, type Job, type Price, type Signal, Swarm, type TurnResult } from '../server/swarm';

interface Pending {
  job: Job;
  signal: (s: Signal) => void;
  resolve: (r: TurnResult) => void;
  reject: (e: Error) => void;
  settled: boolean;
}

// a stand-in for jcode: every turn waits until the test answers it
class FakeEngine implements Engine {
  turns: Pending[] = [];
  cancelled: string[] = [];
  retired: string[] = [];
  saved: { kind: string; path: string; content: string }[] = [];

  turn(job: Job, signal: (s: Signal) => void): Promise<TurnResult> {
    return new Promise((resolve, reject) => {
      const t: Pending = { job, signal, resolve: r => ((t.settled = true), resolve(r)), reject: e => ((t.settled = true), reject(e)), settled: false };
      this.turns.push(t);
    });
  }

  cancel(agent: string): void {
    this.cancelled.push(agent);
    this.waiting(t => t.agent === agent)[0]?.reject(new Error('interrupted'));
  }

  retire(agent: string): void {
    this.retired.push(agent);
  }

  rest(): void {}

  save(kind: 'note' | 'finding', path: string, content: string): void {
    this.saved.push({ kind, path, content });
  }

  notes(folder: string): Note[] {
    return this.saved.filter(s => s.kind === 'note' && s.path.startsWith(`${folder}/`)).map(({ path, content }) => ({ path, content }));
  }

  waiting(match: (j: Job) => boolean = () => true): Pending[] {
    return this.turns.filter(t => !t.settled && match(t.job));
  }
}

const isPlan = (j: Job) => j.prompt.includes('Plan the work');
const isTask = (j: Job) => j.prompt.includes('Your task:');
const isReview = (j: Job) => j.prompt.includes('how well these notes');
const isAnswer = (j: Job) => j.prompt.includes("write the team's answer");
const settle = () => new Promise(r => setTimeout(r, 0));

function colony(price: Price | null = null) {
  let now = 0;
  const engine = new FakeEngine();
  const swarm = new Swarm({ engine, colony: 8, world: { w: 1000, h: 800 }, price, tag: 't', today: '2026-10-28', clock: () => now });
  const events: RuntimeEvent[] = [];
  swarm.on(e => events.push(e));
  const later = (seconds: number) => {
    now += seconds;
    swarm.tick();
  };
  const of = <T extends RuntimeEvent['type']>(type: T) => events.filter((e): e is Extract<RuntimeEvent, { type: T }> => e.type === type);
  return { engine, swarm, events, later, of };
}

const plan = (...tasks: [role: string, title: string][]) => ({ text: '', data: { tasks: tasks.map(([role, title]) => ({ role, title, brief: `do: ${title}` })) } });

describe('the live colony', () => {
  it('plans with a lead, works the tasks with real agents, and finishes on the lead’s finding', async () => {
    const { engine, swarm, of } = colony();
    swarm.send({ type: 'objective.create', text: 'compare three vector databases', x: 300, y: 300 });
    expect(of('objective.created')[0]).toMatchObject({ objective: 'o1', text: 'compare three vector databases' });

    const [planning] = engine.waiting(isPlan);
    const lead = planning.job.agent;
    expect(of('agent.assigned')).toContainEqual({ type: 'agent.assigned', agent: lead, objective: 'o1' });
    planning.resolve(plan(['scout', 'find the options'], ['scout', 'find the prices'], ['builder', 'make the table']));
    await settle();

    // the plan is shared, and scouts go first: the builder waits for what they find
    expect(engine.saved.find(s => s.kind === 'note' && s.path.endsWith('/plan.md'))?.content).toContain('make the table');
    expect(of('agent.context')).toContainEqual(expect.objectContaining({ agent: lead, op: 'write', objective: 'o1' }));
    const scouts = engine.waiting(isTask);
    expect(scouts.map(t => t.job.role)).toEqual(['scout', 'scout']);
    expect(scouts[0].job.prompt).toContain('t-1-compare-three-vector-databases/scout-1.md');

    // a scout searches, hits a broken tool, gets past it and writes a note
    const scout = scouts[0];
    scout.signal({ kind: 'tool', name: 'websearch', detail: 'searching “vector databases”' });
    scout.signal({ kind: 'tool-done', name: 'websearch', error: 'DuckDuckGo served an anti-bot page' });
    scout.signal({ kind: 'tool-done', name: 'webfetch' });
    scout.signal({ kind: 'note', op: 'write', path: 't-1-compare-three-vector-databases/scout-1.md', summary: 'three options with sources' });
    expect(of('agent.activity')).toContainEqual({ type: 'agent.activity', agent: scout.job.agent, text: 'searching “vector databases”' });
    expect(of('agent.friction')).toContainEqual(expect.objectContaining({ agent: scout.job.agent, kind: 'tool-error' }));
    expect(of('agent.calm')).toContainEqual({ type: 'agent.calm', agent: scout.job.agent });
    expect(of('agent.context')).toContainEqual(expect.objectContaining({ agent: scout.job.agent, op: 'write', summary: 'three options with sources' }));

    scouts[0].resolve({ text: 'Found three options. Details are in the note.' });
    scouts[1].resolve({ text: 'Prices are noted.' });
    await settle();
    expect(of('agent.handoff')).toContainEqual({ type: 'agent.handoff', from: scout.job.agent, to: lead, summary: 'Found three options' });
    expect(of('agent.released').map(e => e.agent)).toEqual(expect.arrayContaining(scouts.map(t => t.job.agent)));

    const [builder] = engine.waiting(isTask);
    expect(builder.job.prompt).toContain('make the table');
    builder.resolve({ text: 'The table is in the note.' });
    await settle();

    // a critic scores the work, with the team's notes in its brief; the score is its stance
    const [review] = engine.waiting(isReview);
    expect(review.job.schema).toBeDefined();
    expect(review.job.prompt).toContain('--- t-1-compare-three-vector-databases/plan.md');
    review.resolve({ text: '', data: { verdict: 'accept', score: 0.8, issues: [] } });
    await settle();
    expect(of('agent.stance')).toContainEqual({ type: 'agent.stance', agent: review.job.agent, stance: 0.8 });

    const [answer] = engine.waiting(isAnswer);
    expect(answer.job.agent).toBe(lead);
    expect(answer.job.schema).toBeUndefined();
    answer.resolve({ text: 'Finding: Qdrant is the easiest of the three to run yourself.\n\n# Answer\n\nQdrant.' });
    await settle();
    expect(of('objective.completed')).toEqual([{ type: 'objective.completed', objective: 'o1', finding: 'Qdrant is the easiest of the three to run yourself' }]);
    expect(engine.saved.find(s => s.kind === 'finding')?.path).toBe('t-1-compare-three-vector-databases.md');
    expect(of('agent.released').map(e => e.agent)).toEqual(expect.arrayContaining([lead, review.job.agent]));
    expect(swarm.status().objectives[0]).toMatchObject({ status: 'completed', tasks: '3/3' });
  });

  it('sends the work back once when a critic objects, then answers', async () => {
    const { engine, swarm, of } = colony();
    swarm.send({ type: 'objective.create', text: 'draft a launch post', x: 300, y: 300 });
    engine.waiting(isPlan)[0].resolve(plan(['builder', 'write the draft']));
    await settle();
    engine.waiting(isTask)[0].resolve({ text: 'Drafted.' });
    await settle();
    const [review] = engine.waiting(isReview);
    review.resolve({ text: '', data: { verdict: 'revise', score: 0.4, issues: ['add the price'] } });
    await settle();

    // the objection is the colony's contradiction, and a builder takes the fix
    expect(of('agent.friction')).toContainEqual(expect.objectContaining({ agent: review.job.agent, kind: 'contradiction', detail: 'add the price' }));
    const [fix] = engine.waiting(isTask);
    expect(fix.job.prompt).toContain('fix: add the price');
    fix.resolve({ text: 'Added the price.' });
    await settle();
    expect(engine.waiting(isReview)).toHaveLength(0);
    expect(engine.waiting(isAnswer)[0].job.prompt).toContain('asked for: add the price');
  });

  it('cuts an agent loose: its turn stops, its task goes back on the list, and the team stays thin a minute', async () => {
    const { engine, swarm, later, of } = colony();
    swarm.send({ type: 'objective.create', text: 'find the best hiking trails near Boston', x: 300, y: 300 });
    engine.waiting(isPlan)[0].resolve(plan(['scout', 'north shore trails'], ['scout', 'west of the city']));
    await settle();
    const [cut, kept] = engine.waiting(isTask);
    swarm.send({ type: 'agents.release', agents: [cut.job.agent] });
    await settle();

    expect(engine.cancelled).toEqual([cut.job.agent]);
    expect(of('agent.released')).toContainEqual({ type: 'agent.released', agent: cut.job.agent });
    expect(of('agent.failed')).toHaveLength(0);
    later(5);
    expect(engine.waiting(isTask)).toEqual([kept]);

    later(60);
    const again = engine.waiting(isTask).find(t => t !== kept);
    expect(again?.job.prompt).toContain(cut.job.prompt.split('\n\n')[1]);
  });

  it('abandons an objective with every turn on it stopped, and an undo starts it again', async () => {
    const { engine, swarm, of } = colony();
    swarm.send({ type: 'objective.create', text: 'summarize this week in robotics', x: 300, y: 300 });
    engine.waiting(isPlan)[0].resolve(plan(['scout', 'robot news'], ['scout', 'robot papers']));
    await settle();
    const working = engine.waiting(isTask).map(t => t.job.agent);
    swarm.send({ type: 'objective.abandon', objective: 'o1' });
    await settle();

    expect(engine.cancelled).toEqual(expect.arrayContaining(working));
    expect(of('objective.abandoned')).toEqual([{ type: 'objective.abandoned', objective: 'o1' }]);
    expect(engine.waiting()).toHaveLength(0);

    swarm.send({ type: 'objective.restore', objective: 'o1' });
    expect(of('objective.restored')).toEqual([{ type: 'objective.restored', objective: 'o1' }]);
    expect(engine.waiting(isTask)).toHaveLength(2);
  });

  it('sends an agent whose turn fails to the midden, and grows a new one', async () => {
    const { engine, swarm, later, of } = colony();
    swarm.send({ type: 'objective.create', text: 'list open source LLM routers', x: 300, y: 300 });
    const [first] = engine.waiting(isPlan);
    first.reject(new Error('invalid request: unknown model'));
    await settle();

    expect(of('agent.failed')).toEqual([{ type: 'agent.failed', agent: first.job.agent, error: 'invalid request: unknown model' }]);
    expect(engine.retired).toContain(first.job.agent);
    const [second] = engine.waiting(isPlan);
    expect(second.job.agent).not.toBe(first.job.agent);

    later(21);
    expect(of('agent.spawned')).toEqual([{ type: 'agent.spawned', agent: 'a9', role: 'scout' }]);
  });

  it('leads resting agents to an objective: they join its team and take its first tasks', async () => {
    const { engine, swarm, of } = colony();
    swarm.send({ type: 'objective.create', text: 'plan a team offsite', x: 300, y: 300 });
    const lead = engine.waiting(isPlan)[0];
    swarm.send({ type: 'agents.reassign', agents: ['a2', 'a4'], objective: 'o1' });
    expect(of('agent.activity')).toContainEqual({ type: 'agent.activity', agent: 'a2', text: 'standing by for work' });

    // a team of three, two more led to it: the two planned tasks and three second looks
    lead.resolve(plan(['scout', 'venues'], ['scout', 'dates']));
    await settle();
    const workers = engine.waiting(isTask).map(t => t.job.agent);
    expect(workers).toHaveLength(5);
    expect(workers.slice(0, 2)).toEqual(['a2', 'a4']);
  });

  it('reports what each agent costs from the tokens it uses, and no cost without a price', () => {
    const priced = colony({ input: 1e-6, output: 2e-6, cached: 1e-7 });
    priced.swarm.send({ type: 'objective.create', text: 'compare two editors', x: 300, y: 300 });
    const [turn] = priced.engine.waiting(isPlan);
    turn.signal({ kind: 'tokens', input: 10_000, output: 1_000, cached: 0 });
    priced.later(1);
    // $0.012 in the last minute is $0.72 an hour
    const cost = priced.of('agent.effort').filter(e => e.agent === turn.job.agent).at(-1)?.cost;
    expect(cost).toBeCloseTo(0.72, 3);
    expect(priced.swarm.status().spentUsd).toBeCloseTo(0.012, 6);

    const free = colony(null);
    free.swarm.send({ type: 'objective.create', text: 'compare two editors', x: 300, y: 300 });
    free.engine.waiting(isPlan)[0].signal({ kind: 'tokens', input: 10_000, output: 1_000, cached: 0 });
    free.later(1);
    expect(free.of('agent.effort').every(e => e.cost === undefined)).toBe(true);
  });

  it('carries a trail between objectives when an agent reads another one’s notes', async () => {
    const { engine, swarm, of } = colony();
    swarm.send({ type: 'objective.create', text: 'find cheap flights to Lisbon', x: 300, y: 300 });
    swarm.send({ type: 'objective.create', text: 'plan three days in Lisbon', x: 400, y: 320 });
    expect(of('objective.related')).toEqual([{ type: 'objective.related', a: 'o2', b: 'o1', related: true }]);
    const second = engine.waiting(isPlan).find(t => t.job.prompt.includes('three days'));
    expect(second?.job.prompt).toContain('t-1-find-cheap-flights-to-lisbon/');
    second?.signal({ kind: 'note', op: 'read', path: 't-1-find-cheap-flights-to-lisbon/scout-1.md', summary: 'TAP flies direct' });
    expect(of('agent.context')).toContainEqual({ type: 'agent.context', agent: second?.job.agent, op: 'read', objective: 'o2', from: 'o1', summary: 'TAP flies direct' });
  });

  it('gives a new viewer the colony as it is', async () => {
    const { engine, swarm } = colony();
    swarm.send({ type: 'objective.create', text: 'compare three vector databases', x: 300, y: 300 });
    engine.waiting(isPlan)[0].resolve(plan(['scout', 'find the options']));
    await settle();
    const picture = swarm.snapshot();
    expect(picture.filter(e => e.type === 'agent.spawned')).toHaveLength(8);
    expect(picture).toContainEqual({ type: 'objective.created', objective: 'o1', text: 'compare three vector databases', x: 300, y: 300, size: 1 });
    const working = engine.waiting(isTask)[0].job.agent;
    expect(picture).toContainEqual({ type: 'agent.assigned', agent: working, objective: 'o1' });
    // the founding agents come from the snapshot alone, not the stream as well
    const streamed: RuntimeEvent[] = [];
    new Swarm({ engine: new FakeEngine(), colony: 4, world: { w: 1000, h: 800 } }).on(e => streamed.push(e));
    expect(streamed).toHaveLength(0);
  });
});

describe('what real agents are told and how their replies are read', () => {
  it('turns an unusable plan into a scout and a builder, and caps a long one', () => {
    expect(readPlan(null, 'pick a laptop', 4).map(t => t.role)).toEqual(['scout', 'builder']);
    expect(readPlan({ tasks: [{ role: 'boss', title: 'x', brief: 'y' }] }, 'pick a laptop', 4).map(t => t.role)).toEqual(['scout', 'builder']);
    const many = { tasks: Array.from({ length: 9 }, (_, i) => ({ role: 'scout', title: `t${i}`, brief: 'b' })) };
    expect(readPlan(many, 'pick a laptop', 4)).toHaveLength(4);
  });

  it('reads the finding line off a plain answer: short, without a full stop, with names as written', () => {
    const d = readDecision('**Finding:** Qdrant wins on ease of running it yourself, by a wide margin today.\n\n# Why\n\nIt ships one binary.');
    expect(d.finding).toBe('Qdrant wins on ease of running it yourself, by a wide margin');
    expect(d.report).toBe('# Why\n\nIt ships one binary.');
    expect(readDecision('The cheapest flight is $180. More below.').finding).toBe('The cheapest flight is $180');
  });

  it('counts a revise with nothing to fix as an accept, and keeps scores in range', () => {
    expect(readVerdict({ verdict: 'revise', score: 0.3, issues: [] })).toEqual({ verdict: 'accept', score: 0.3, issues: [] });
    expect(readVerdict({ verdict: 'accept', score: 7, issues: [] }).score).toBe(1);
    expect(readVerdict('nonsense')).toEqual({ verdict: 'accept', score: 0.5, issues: [] });
  });
});

describe('the page’s side of the live colony', () => {
  it('watches real agents only when the address asks for it', () => {
    expect(isLive('?live')).toBe(true);
    expect(isLive('?colony=300')).toBe(false);
  });

  it('hands streamed events to the world on the frame clock, and posts gestures back', () => {
    const handlers = new Map<string, (e: MessageEvent<string>) => void>();
    const stream: EventStream = { addEventListener: (type, fn) => handlers.set(type, fn) };
    const posted: [string, string][] = [];
    let resets = 0;
    const runtime = new RemoteRuntime({ open: () => stream, post: (url, body) => posted.push([url, body]), reset: () => resets++ });
    const seen: RuntimeEvent[] = [];
    runtime.on(e => seen.push(e));

    handlers.get('message')?.({ data: JSON.stringify([{ type: 'agent.spawned', agent: 'a1', role: 'scout' }]) } as MessageEvent<string>);
    expect(seen).toHaveLength(0);
    runtime.tick();
    expect(seen).toEqual([{ type: 'agent.spawned', agent: 'a1', role: 'scout' }]);

    runtime.send({ type: 'objective.create', text: 'hello', x: 1, y: 2 });
    expect(posted).toEqual([['/live/command', JSON.stringify({ type: 'objective.create', text: 'hello', x: 1, y: 2 })]]);
    handlers.get('reset')?.({ data: '{}' } as MessageEvent<string>);
    expect(resets).toBe(1);
    expect(runtime.simulated).toBe(false);
  });
});
