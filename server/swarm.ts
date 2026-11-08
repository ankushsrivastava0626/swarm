// The live colony: real agents doing the work a person drops into the terrarium.
// It speaks the protocol the simulation speaks: gestures come in as commands, and what the agents
// actually do goes out as events. Everything that talks to a model sits behind Engine, so the same
// colony runs on jcode and on a stand-in in the tests.
import type { Command, FrictionKind, Role, RuntimeEvent } from '../src/runtime/protocol';
import { sizeOf } from '../src/runtime/writing.ts';
import {
  type Note,
  type Verdict,
  clip,
  decideBrief,
  firstSentence,
  mergeBrief,
  planBrief,
  planSchema,
  readDecision,
  readPlan,
  readVerdict,
  reviewBrief,
  reviewSchema,
  secondLook,
  slug,
  systemPrompt,
  taskBrief,
} from './briefs.ts';

// What an agent does while it works, as the engine sees it.
export type Signal =
  // a tool started; detail says what with, like the search or the address
  | { kind: 'tool'; name: string; detail: string }
  | { kind: 'tool-done'; name: string; error?: string }
  // a note written to or read from the shared notes, by its path in the notes folder
  | { kind: 'note'; op: 'write' | 'read'; path: string; summary: string }
  // the tokens of one model call; cached counts the part of input read from the provider's cache
  | { kind: 'tokens'; input: number; output: number; cached: number }
  // a model call is being retried, after a rate limit or a dropped connection
  | { kind: 'retry'; detail: string };

export interface Job {
  agent: string;
  role: Role;
  system: string;
  // the objective's folder in the shared notes, where everything this agent writes goes
  folder: string;
  prompt: string;
  // when set, the reply must be JSON that satisfies this schema
  schema?: Record<string, unknown>;
}

export interface TurnResult {
  text: string;
  data?: unknown;
}

export interface Engine {
  // one turn of work for one agent, reporting what it does as it goes
  turn(job: Job, signal: (s: Signal) => void): Promise<TurnResult>;
  // stop an agent's turn; its turn() still settles, and what it returns is ignored
  cancel(agent: string): void;
  // the agent is gone for good: it failed, or a helper folded back into its parent
  retire(agent: string): void;
  // the agent went back to the nest: what it holds open can close until it next has work
  rest(agent: string): void;
  // keep a plan in the shared notes, or a finished answer with the findings
  save(kind: 'note' | 'finding', path: string, content: string): void;
  // the notes in one objective's folder, the newest first chosen when there are too many to read
  notes(folder: string): Note[];
}

// dollars per token
export interface Price {
  input: number;
  output: number;
  cached: number;
}

export interface SwarmOptions {
  engine: Engine;
  // agents resting in the nest at the start
  colony: number;
  world: { w: number; h: number };
  // without a price no cost is reported, and the readout hides spend
  price?: Price | null;
  // keeps note folders from different runs apart
  tag?: string;
  today?: string;
  clock?: () => number;
  log?: (line: string) => void;
  // agents in turns at once, across every objective; unlimited unless set
  maxWorking?: number;
  // false holds new turns back, as when the machine runs short of memory; nothing is dropped
  canStart?: () => boolean;
}

const RELATED = 0.36; // objectives closer than this share of the short side are related, as in the simulation
const CUT_SECONDS = 60; // agents cut loose stay off that objective this long, and its team stays thin
const REPLACE_SECONDS = 20; // a lost agent is replaced after this
const SPEND_WINDOW = 60; // seconds of spending behind each dollars-an-hour figure
const RETRY_SECONDS = 5; // work that hit a passing error is tried again after this
const GIVE_UP = 6; // failed turns before an objective is set aside
const GIVE_UP_PASSING = 40; // passing errors, like rate limits, before an objective is set aside
const PLAN_MAX = 12; // distinct tasks in one plan: a structured reply small enough for a small model to write
const MERGE_GROUP = 8; // notes one agent merges into a digest, so a big team still ends in one answer
const AGENTS_PER_ENRICH = 10; // agents a hold adds per unit of enrichment: three for every 0.4 s held
const WORLD_BODIES = 1600; // the world draws at most this many agents: the only ceiling on a team
const BUILD_WAVE = 100; // waves of work: scouts at 0, merges from 1, builders at 100, fixes at 200
const FIX_WAVE = 200;
const ROLES: Role[] = ['scout', 'builder', 'scout', 'builder', 'critic', 'scout', 'builder', 'critic'];
const RANK: Record<Role, number> = { scout: 0, builder: 1, critic: 2 }; // most of a big team takes second looks at scouts' tasks
// the model would not do the work: asking again would only be declined again
const DECLINED = /can['’]t help with|cannot help with|can['’]t assist|cannot assist|unable to help with/i;
// trouble worth another try: rate limits and a subscription's usage limits, credit held by requests in flight,
// failing or overloaded providers, dropped connections
const PASSING = /\b(402|429|50\d|529)\b|payment required|in.?flight|rate.?limit|usage.?limit|limit reached|quota|overload|upstream|temporar|unavailable|try again|ECONNRESET|socket hang up|connection (reset|closed)|support session_tools/i;
// the provider is turning work away: fewer turns stay in flight for a while
const THROTTLED = /\b(402|429)\b|payment required|in.?flight|rate.?limit|usage.?limit|limit reached|quota/i;

type Phase = 'plan' | 'build' | 'review' | 'decide';
type Trouble = 'passing' | 'declined' | 'broken';

interface Agent {
  id: string;
  role: Role;
  parent: Agent | null; // helpers bud from a working agent and fold back into it
  alive: boolean;
  gone: 'failed' | 'merged' | null;
  error: string;
  objective: Obj | null;
  busy: boolean; // in a turn, or finishing one that was cancelled
  standingBy: boolean; // led to an objective by hand, waiting for work there
  effort: number;
  effortSent: number;
  costSent: number;
  brightUntil: number;
  spent: { at: number; usd: number }[];
  troubled: FrictionKind | null;
  calmAt: number;
  freedFrom: Obj | null;
  freedUntil: number;
}

interface Task {
  // a task the lead planned, a second look at one, a merge of notes, or a fix a critic asked for
  kind: 'task' | 'look' | 'merge' | 'fix';
  from: Task | null;
  role: Role;
  title: string;
  brief: string;
  note: string;
  wave: number;
  state: 'pending' | 'running' | 'done' | 'failed';
  agent: Agent | null;
  tries: number; // failed turns; passing errors do not count
  passing: number; // passing errors, each followed by a longer wait
  after: number; // not before this time, after a passing error
  inputs: string[]; // notes to start from
}

interface Obj {
  id: string;
  text: string;
  x: number;
  y: number;
  size: number;
  folder: string;
  status: 'active' | 'abandoned' | 'completed';
  phase: Phase;
  priority: number; // for the world: how far the droplet's pull reaches
  want: number; // the team the person asked for, beyond the lead; 0 leaves it to the lead's plan
  wantSaid: number;
  wantAt: number;
  lead: Agent | null;
  planning: boolean;
  deciding: boolean;
  retryAt: number;
  tasks: Task[];
  mergeLevel: number;
  merged: boolean;
  inputs: string[];
  verdicts: Verdict[];
  critics: Set<Agent>;
  reviewing: Set<Agent>;
  revised: boolean;
  failures: number;
  passing: number;
  progress: number;
  progressSent: number;
  related: Set<Obj>;
  cap: number;
  capUntil: number;
  finding: string;
}

interface Turn {
  obj: Obj;
  cancelled: boolean;
}

const open = (t: Task) => t.state === 'pending' || t.state === 'running';
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class Swarm {
  private engine: Engine;
  private world: { w: number; h: number };
  private price: Price | null;
  private tag: string;
  private today: string;
  private clock: () => number;
  private log: (line: string) => void;
  private maxWorking: number;
  private canStart: () => boolean;
  private ids = { agent: 0, helper: 0, objective: 0 };
  private agents: Agent[] = [];
  private objectives: Obj[] = [];
  private turns = new Map<Agent, Turn>();
  private replacements: { at: number; role: Role }[] = [];
  private listeners = new Set<(e: RuntimeEvent) => void>();
  private queue: RuntimeEvent[] = [];
  private lastTick: number;
  private spentTotal = 0;
  private tokens = { input: 0, output: 0 };
  // turns at once the provider is taking now: lowered when it turns work away, raised again as turns go through
  private limit = Infinity;
  private throttledAt = -Infinity;
  private throttleSaid = -Infinity;

  constructor(opts: SwarmOptions) {
    this.engine = opts.engine;
    this.world = { ...opts.world };
    this.price = opts.price ?? null;
    this.tag = opts.tag ?? 'run';
    this.today = opts.today ?? new Date().toISOString().slice(0, 10);
    this.clock = opts.clock ?? (() => performance.now() / 1000);
    this.log = opts.log ?? (() => {});
    this.maxWorking = opts.maxWorking ?? Infinity;
    this.canStart = opts.canStart ?? (() => true);
    this.lastTick = this.clock();
    for (let i = 0; i < opts.colony; i++) this.spawn(ROLES[i % ROLES.length], null);
    // the colony a viewer first sees comes from snapshot(), so the founding agents are not sent twice
    this.queue = [];
  }

  on(listener: (e: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // effort and spend drift, troubles calm, lost agents are replaced, waiting work starts
  tick(): void {
    const now = this.clock();
    const dt = Math.max(0, now - this.lastTick);
    this.lastTick = now;
    for (const a of this.agents) if (a.alive) this.live(a, dt, now);
    for (let i = this.replacements.length - 1; i >= 0; i--) {
      if (now < this.replacements[i].at) continue;
      this.spawn(this.replacements[i].role, null);
      this.replacements.splice(i, 1);
    }
    // a hold changes the team every 0.4 s: say what it came to once the hand has let go
    for (const o of this.objectives) {
      if (o.want === o.wantSaid || now - o.wantAt < 1.5) continue;
      o.wantSaid = o.want;
      this.say(`${o.id} team of ${o.want}`);
    }
    this.pump();
    this.flush();
  }

  send(cmd: Command): void {
    switch (cmd.type) {
      case 'world.resize':
        this.world = { w: cmd.w, h: cmd.h };
        for (const o of this.objectives) if (o.status === 'active') this.relate(o);
        break;
      case 'objective.create':
        this.create(cmd.text, cmd.x, cmd.y);
        break;
      case 'objective.move': {
        const o = this.objective(cmd.objective);
        if (!o || o.status === 'completed') break;
        o.x = cmd.x;
        o.y = cmd.y;
        this.emit({ type: 'objective.moved', objective: o.id, x: o.x, y: o.y });
        if (o.status === 'active') this.relate(o);
        break;
      }
      case 'objective.enrich': {
        const o = this.objective(cmd.objective);
        if (!o || o.status !== 'active') break;
        o.priority = Math.round(Math.min(4, Math.max(1, o.priority + cmd.amount)) * 100) / 100;
        // the longer the hold, the bigger the team; an undo gives the agents back
        this.grow(o, Math.round(cmd.amount * AGENTS_PER_ENRICH));
        if (cmd.amount > 0) o.capUntil = 0;
        this.emit({ type: 'objective.priority', objective: o.id, priority: o.priority });
        break;
      }
      case 'objective.abandon': {
        const o = this.objective(cmd.objective);
        if (!o || o.status !== 'active') break;
        this.setAside(o);
        this.say(`${o.id} abandoned`);
        break;
      }
      case 'objective.restore': {
        const o = this.objective(cmd.objective);
        if (!o || o.status !== 'abandoned') break;
        o.status = 'active';
        o.failures = 0;
        o.passing = 0;
        o.capUntil = 0;
        this.emit({ type: 'objective.restored', objective: o.id });
        this.relate(o);
        break;
      }
      case 'agents.reassign': {
        // a resting agent led to an objective joins its team: it stands by there and takes its next task;
        // an agent already in a turn finishes it where it is
        const o = this.objective(cmd.objective);
        if (!o || o.status !== 'active') break;
        let joined = 0;
        for (const id of cmd.agents) {
          const a = this.agent(id);
          if (!a || a.busy || a.parent || a.objective === o || (a.objective && !a.standingBy)) continue;
          this.detach(a);
          a.objective = o;
          a.standingBy = true;
          this.emit({ type: 'agent.assigned', agent: a.id, objective: o.id });
          this.activity(a, 'standing by for work');
          joined++;
        }
        this.grow(o, joined);
        o.capUntil = 0;
        break;
      }
      case 'agents.release': {
        // cut loose: the agent stops, its task goes back on the list, and the team stays thin for a minute
        const touched = new Set<Obj>();
        for (const id of cmd.agents) {
          const a = this.agent(id);
          const o = a?.objective;
          if (!a || !o) continue;
          touched.add(o);
          a.freedFrom = o;
          a.freedUntil = this.clock() + CUT_SECONDS;
          this.stop(a);
          this.release(a);
        }
        for (const o of touched) {
          o.cap = Math.max(1, o.tasks.filter(t => t.state === 'running').length);
          o.capUntil = this.clock() + CUT_SECONDS;
        }
        break;
      }
    }
    this.pump();
    this.flush();
  }

  // everything a new viewer needs to see the colony as it is now
  snapshot(): RuntimeEvent[] {
    const out: RuntimeEvent[] = [];
    for (const a of this.agents) {
      if (a.alive) out.push(a.parent?.alive ? { type: 'agent.spawned', agent: a.id, role: a.role, parent: a.parent.id } : { type: 'agent.spawned', agent: a.id, role: a.role });
      else if (a.gone === 'failed') out.push({ type: 'agent.spawned', agent: a.id, role: a.role }, { type: 'agent.failed', agent: a.id, error: a.error, past: true });
    }
    for (const o of this.objectives) {
      out.push({ type: 'objective.created', objective: o.id, text: o.text, x: o.x, y: o.y, size: o.size });
      if (o.status === 'completed') {
        out.push({ type: 'objective.completed', objective: o.id, finding: o.finding, past: true });
        continue;
      }
      if (o.progress > 0) out.push({ type: 'objective.progress', objective: o.id, progress: Math.round(o.progress * 1000) / 1000 });
      if (o.priority !== 1) out.push({ type: 'objective.priority', objective: o.id, priority: o.priority });
      if (o.status === 'abandoned') out.push({ type: 'objective.abandoned', objective: o.id });
    }
    for (const o of this.objectives) for (const p of o.related) if (o.id < p.id) out.push({ type: 'objective.related', a: o.id, b: p.id, related: true });
    for (const a of this.agents) {
      if (!a.alive) continue;
      if (a.objective) out.push({ type: 'agent.assigned', agent: a.id, objective: a.objective.id });
      const effort = Math.round(a.effortSent * 100) / 100;
      if (effort > 0.1) out.push(this.price ? { type: 'agent.effort', agent: a.id, effort, cost: a.costSent } : { type: 'agent.effort', agent: a.id, effort });
    }
    return out;
  }

  status() {
    return {
      agents: this.agents.filter(a => a.alive).length,
      working: this.agents.filter(a => a.alive && a.busy).length,
      failed: this.agents.filter(a => a.gone === 'failed').length,
      atOnce: this.limit === Infinity ? 'no limit' : this.limit,
      spentUsd: Math.round(this.spentTotal * 10000) / 10000,
      tokens: { ...this.tokens },
      objectives: this.objectives.map(o => ({
        id: o.id,
        text: o.text,
        status: o.status,
        phase: o.phase,
        progress: Math.round(o.progress * 100) / 100,
        team: o.want || o.tasks.filter(t => t.kind === 'task').length,
        working: this.agents.filter(a => a.alive && a.busy && a.objective === o).length,
        tasks: `${o.tasks.filter(t => t.state === 'done').length}/${o.tasks.length}`,
        finding: o.finding || undefined,
        folder: o.folder,
      })),
    };
  }

  // stop every turn, for shutdown
  halt(): void {
    for (const [a, turn] of this.turns) {
      turn.cancelled = true;
      this.engine.cancel(a.id);
    }
  }

  // ---------- the work, phase by phase ----------

  private pump(): void {
    for (const o of this.objectives) if (o.status === 'active') this.advance(o);
  }

  private advance(o: Obj): void {
    if (o.phase === 'plan') this.plan(o);
    else if (o.phase === 'build') this.build(o);
    else if (o.phase === 'review') this.review(o);
    else this.decide(o);
  }

  // the lead tastes the food and comes back with a plan for the team
  private plan(o: Obj): void {
    if (o.planning || this.clock() < o.retryAt || !this.lead(o, 'reading the objective')) return;
    const lead = o.lead as Agent;
    if (lead.busy || !this.room()) return;
    const max = Math.max(1, Math.min(PLAN_MAX, o.want || this.base(o)));
    o.planning = true;
    this.activity(lead, 'planning the work');
    this.start(
      lead,
      o,
      { prompt: planBrief(o.text, max, this.nearby(o)), schema: planSchema(max) },
      r => {
        o.planning = false;
        const planned = readPlan(r.data, o.text, max);
        o.tasks = planned.map((t, i) => this.task('task', null, t.role, t.title, t.brief, `${o.folder}/${t.role}-${i + 1}.md`, t.role === 'scout' ? 0 : BUILD_WAVE));
        this.engine.save('note', `${o.folder}/plan.md`, `# ${o.text}\n\n${planned.map((t, i) => `${i + 1}. ${t.role}, ${t.title}: ${t.brief}`).join('\n')}\n`);
        this.emit({ type: 'agent.context', agent: lead.id, op: 'write', objective: o.id, summary: clip(`plan: ${planned.map(t => t.title).join(', ')}`, 70) });
        o.phase = 'build';
        this.setProgress(o, 0.1);
        this.fill(o);
        this.activity(lead, `waiting on a team of ${o.tasks.length}`);
        this.say(`${o.id} planned: ${planned.map(t => `${t.role} "${t.title}"`).join(', ')}${o.tasks.length > planned.length ? `, and ${o.tasks.length - planned.length} second looks` : ''}`);
      },
      kind => {
        o.planning = false;
        if (kind !== 'broken') o.retryAt = this.clock() + RETRY_SECONDS;
      },
    );
  }

  private build(o: Obj): void {
    this.fill(o);
    // once the scouts are back, their notes are merged eight at a time until few enough remain to build from
    if (!o.merged && !o.tasks.some(t => t.wave < BUILD_WAVE && open(t))) this.layerUp(o);
    const left = o.tasks.filter(open);
    if (!left.length) {
      o.phase = o.revised ? 'decide' : 'review';
      this.setProgress(o, o.revised ? 0.88 : 0.75);
      this.advance(o);
      return;
    }
    const now = this.clock();
    const wave = Math.min(...left.map(t => t.wave));
    const cap = now < o.capUntil ? o.cap : Infinity;
    let running = o.tasks.filter(t => t.state === 'running').length;
    for (const t of o.tasks) {
      if (running >= cap || !this.room()) break;
      if (t.state !== 'pending' || t.wave !== wave || now < t.after) continue;
      const a = this.take(o, [t.role, t.role === 'scout' ? 'critic' : 'scout', 'builder', 'critic']) ?? this.bud(o, t.role);
      if (!a) break;
      this.work(a, o, t);
      running++;
    }
    // work that cannot start yet still has its agents waiting at the droplet
    this.summon(o);
  }

  // the team grows to what the person asked for: second looks while the scouts are out, and an undo
  // takes back the second looks no one has started; asked for later, the extra agents become critics
  private fill(o: Obj): void {
    if (o.phase !== 'build' || !o.want) return;
    const team = o.tasks.filter(t => t.kind === 'task' || t.kind === 'look');
    let gap = o.want - team.length;
    if (gap < 0) {
      for (let i = o.tasks.length - 1; i >= 0 && gap < 0; i--) {
        if (o.tasks[i].kind !== 'look' || o.tasks[i].state !== 'pending') continue;
        o.tasks.splice(i, 1);
        gap++;
      }
      return;
    }
    // second looks go to the scouts' work while it is open, or to the builders' when there were no scouts
    const scouts = o.tasks.filter(t => t.kind === 'task' && t.wave === 0);
    const builders = o.tasks.filter(t => t.kind === 'task' && t.wave === BUILD_WAVE);
    const pool = scouts.length ? (scouts.some(open) || o.tasks.some(t => t.wave === 0 && open(t)) ? scouts : []) : builders.some(open) ? builders : [];
    for (let k = 0; k < gap && pool.length; k++) {
      const of = pool[k % pool.length];
      const n = o.tasks.filter(t => t.from === of).length + 2;
      o.tasks.push(this.task('look', of, of.role, of.title, secondLook(of.brief, n - 2), of.note.replace(/\.md$/, `-${n}.md`), of.wave));
    }
  }

  private layerUp(o: Obj): void {
    const layer = o.mergeLevel
      ? o.tasks.filter(t => t.kind === 'merge' && t.wave === o.mergeLevel).flatMap(t => (t.state === 'done' ? [t.note] : t.inputs))
      : o.tasks.filter(t => t.wave === 0 && t.state === 'done').map(t => t.note);
    if (layer.length <= MERGE_GROUP) {
      o.merged = true;
      o.inputs = o.mergeLevel ? layer : [];
      return;
    }
    const level = ++o.mergeLevel;
    for (let g = 0; g * MERGE_GROUP < layer.length; g++) {
      const paths = layer.slice(g * MERGE_GROUP, (g + 1) * MERGE_GROUP);
      const t = this.task('merge', null, 'builder', `merge ${paths.length} notes`, mergeBrief(paths), `${o.folder}/digest-${level}-${g + 1}.md`, level);
      t.inputs = paths;
      o.tasks.push(t);
    }
    this.say(`${o.id} merging ${layer.length} notes in ${Math.ceil(layer.length / MERGE_GROUP)} digests`);
  }

  private work(a: Agent, o: Obj, t: Task): void {
    t.state = 'running';
    t.agent = a;
    this.assign(a, o, t.kind === 'merge' ? t.title : t.kind === 'look' ? `another look: ${t.title}` : t.title);
    const inputs = t.kind === 'merge' ? [] : t.wave >= BUILD_WAVE ? o.inputs : [];
    this.start(
      a,
      o,
      { prompt: taskBrief(o.text, t.title, t.brief, t.note, o.folder, this.nearby(o), inputs) },
      r => {
        t.state = 'done';
        t.agent = null;
        const lead = this.leadOf(o);
        if (lead && lead !== a) this.emit({ type: 'agent.handoff', from: a.id, to: lead.id, summary: firstSentence(r.text) || t.title });
        this.release(a);
        const settled = o.tasks.filter(x => x.state === 'done' || x.state === 'failed').length;
        this.setProgress(o, 0.1 + (0.62 * settled) / o.tasks.length);
      },
      kind => {
        t.agent = null;
        if (kind === 'passing' && ++t.passing < 8) {
          t.state = 'pending';
          // each task waits longer each time, and a little differently, so a crowd that hit a rate limit does not return at once
          t.after = this.clock() + RETRY_SECONDS * 2 ** Math.min(t.passing - 1, 5) * (0.5 + Math.random());
        } else if (kind !== 'broken') t.state = 'failed';
        else t.state = ++t.tries >= 2 ? 'failed' : 'pending';
      },
    );
  }

  // critics read everything the team wrote and score it; their scores are their stances
  private review(o: Obj): void {
    // one critic, and one more for every agent asked for once the scouting was over
    const team = o.tasks.filter(t => t.kind === 'task' || t.kind === 'look').length;
    const want = 1 + Math.max(0, (o.want || team) - team);
    while (o.verdicts.length + o.reviewing.size < want && this.room()) {
      const a = this.take(o, ['critic', 'scout', 'builder']) ?? this.bud(o, 'critic');
      if (!a) return;
      o.reviewing.add(a);
      o.critics.add(a);
      this.assign(a, o, 'reading the team’s notes');
      this.start(
        a,
        o,
        { prompt: reviewBrief(o.text, this.engine.notes(o.folder)), schema: reviewSchema },
        r => {
          o.reviewing.delete(a);
          const v = readVerdict(r.data);
          o.verdicts.push(v);
          this.emit({ type: 'agent.stance', agent: a.id, stance: Math.round(v.score * 1000) / 1000 });
          const lead = this.leadOf(o);
          if (lead) this.emit({ type: 'agent.handoff', from: a.id, to: lead.id, summary: clip(`scored it ${v.score.toFixed(2)}${v.issues[0] ? `: ${v.issues[0]}` : ''}`, 90) });
          // an objection is the colony's contradiction: the critic boils while the builders rework it
          if (v.verdict === 'revise') this.trouble(a, 'contradiction', v.issues[0], 10);
          this.activity(a, v.verdict === 'revise' ? `asked for ${v.issues.length} fixes` : `scored the work ${v.score.toFixed(2)}`);
          if (!o.reviewing.size && o.verdicts.length >= want) this.reviewed(o);
        },
        () => {
          o.reviewing.delete(a);
          o.critics.delete(a);
        },
      );
    }
  }

  // one pass of fixes when critics ask for them, then the answer
  private reviewed(o: Obj): void {
    const asks = [...new Set(o.verdicts.filter(v => v.verdict === 'revise').flatMap(v => v.issues))].slice(0, 4);
    if (asks.length && !o.revised) {
      o.revised = true;
      asks.forEach((ask, i) =>
        o.tasks.push(
          this.task('fix', null, 'builder', clip(`fix: ${ask}`, 60), `A critic asked for this fix to the team's notes: ${ask}\nRead the notes, then write the fix as a note of its own.`, `${o.folder}/fix-${i + 1}.md`, FIX_WAVE),
        ),
      );
      o.phase = 'build';
      this.say(`${o.id} sent back for ${asks.length} fixes`);
    } else {
      o.phase = 'decide';
      this.setProgress(o, 0.88);
    }
  }

  // the lead reads the notes and writes the answer; the team's stances settle on how good it is
  private decide(o: Obj): void {
    if (o.deciding || this.clock() < o.retryAt || !this.lead(o, 'reading the team’s notes')) return;
    const lead = o.lead as Agent;
    if (lead.busy || !this.room()) return;
    o.deciding = true;
    this.activity(lead, 'writing the answer');
    if (o.verdicts.length) {
      const agreed = o.verdicts.reduce((s, v) => s + v.score, 0) / o.verdicts.length;
      this.emit({ type: 'agent.stance', agent: lead.id, stance: Math.round(agreed * 1000) / 1000 });
    }
    this.start(
      lead,
      o,
      { prompt: decideBrief(o.text, this.engine.notes(o.folder), o.verdicts) },
      r => {
        o.deciding = false;
        const d = readDecision(r.text);
        this.engine.save('finding', `${o.folder}.md`, `# ${o.text}\n\n**${d.finding}**\n\n${d.report}\n`);
        this.complete(o, d.finding);
      },
      kind => {
        o.deciding = false;
        if (kind !== 'broken') o.retryAt = this.clock() + RETRY_SECONDS;
      },
    );
  }

  private complete(o: Obj, finding: string): void {
    o.status = 'completed';
    o.finding = finding;
    this.setProgress(o, 1);
    this.emit({ type: 'objective.completed', objective: o.id, finding });
    this.vacate(o);
    this.unrelate(o);
    this.say(`${o.id} done: ${finding}`);
  }

  // abandoned by hand, or after too many failed turns: it waits, and an undo restores it
  private setAside(o: Obj): void {
    o.status = 'abandoned';
    this.vacate(o);
    this.unrelate(o);
    this.emit({ type: 'objective.abandoned', objective: o.id });
  }

  // the person asks for more agents by holding the droplet or leading agents to it, and an undo gives them back;
  // the team never drops below what the lead planned
  private grow(o: Obj, agents: number): void {
    if (!agents) return;
    const floor = o.phase === 'plan' ? this.base(o) : o.tasks.filter(t => t.kind === 'task').length;
    o.want = Math.max(floor, (o.want || floor) + agents);
    o.wantAt = this.clock();
    this.fill(o);
    this.summon(o);
  }

  // the team a lead plans for when no one has asked for more: three for a short objective, up to five for a sweeping one
  private base(o: Obj): number {
    return Math.round(2 + o.size);
  }

  // ---------- turns ----------

  private start(a: Agent, o: Obj, job: { prompt: string; schema?: Record<string, unknown> }, done: (r: TurnResult) => void, failed: (kind: Trouble) => void): void {
    a.busy = true;
    a.brightUntil = this.clock() + 3;
    const turn: Turn = { obj: o, cancelled: false };
    this.turns.set(a, turn);
    this.engine.turn({ agent: a.id, role: a.role, system: systemPrompt(a.role, this.today), folder: o.folder, ...job }, s => this.signal(a, o, turn, s)).then(
      r => this.settle(a, turn, () => {
        this.ease();
        done(r);
      }),
      err => this.settle(a, turn, () => {
        const text = message(err);
        const kind: Trouble = DECLINED.test(text) ? 'declined' : PASSING.test(text) ? 'passing' : 'broken';
        if (THROTTLED.test(text)) this.throttle();
        failed(kind);
        this.fail(a, o, err, kind);
      }),
    );
  }

  private settle(a: Agent, turn: Turn, then: () => void): void {
    if (this.turns.get(a) === turn) this.turns.delete(a);
    a.busy = false;
    // an agent cut loose mid-turn is already resting, or a helper already folded back: its seat can go now
    if (!a.alive) this.engine.retire(a.id);
    else if (!a.objective) this.engine.rest(a.id);
    if (!turn.cancelled && a.alive && turn.obj.status === 'active') then();
    this.pump();
    this.flush();
  }

  private signal(a: Agent, o: Obj, turn: Turn, s: Signal): void {
    if (turn.cancelled || !a.alive) return;
    const now = this.clock();
    a.brightUntil = now + 3;
    switch (s.kind) {
      case 'tool':
        this.activity(a, s.detail);
        break;
      case 'tool-done':
        if (s.error) this.trouble(a, 'tool-error', `${s.name}: ${s.error}`);
        else if (a.troubled && a.troubled !== 'contradiction') this.calm(a);
        break;
      case 'note': {
        if (s.op === 'write') {
          this.emit({ type: 'agent.context', agent: a.id, op: 'write', objective: o.id, summary: clip(s.summary || s.path, 70) });
          break;
        }
        // reading another objective's notes carries its trail here and back
        const from = this.objectives.find(p => p !== o && s.path.startsWith(`${p.folder}/`));
        if (from) this.emit({ type: 'agent.context', agent: a.id, op: 'read', objective: o.id, from: from.id, summary: clip(s.summary || s.path, 70) });
        break;
      }
      case 'tokens': {
        this.tokens.input += s.input;
        this.tokens.output += s.output;
        if (this.price) {
          const cached = Math.min(s.cached, s.input);
          const usd = (s.input - cached) * this.price.input + cached * this.price.cached + s.output * this.price.output;
          a.spent.push({ at: now, usd });
          this.spentTotal += usd;
        }
        if (a.troubled === 'retry') this.calm(a);
        break;
      }
      case 'retry':
        this.trouble(a, 'retry', s.detail);
        break;
    }
    this.flush();
  }

  // a passing error leaves the agent alive and its work waiting; work it declines is dropped and the agent goes
  // back to the nest; anything else sends it to the midden. A big team gets more of each before it is set aside
  private fail(a: Agent, o: Obj, err: unknown, kind: Trouble): void {
    const error = clip(message(err), 100) || 'stopped without saying why';
    if (kind !== 'broken') {
      this.say(kind === 'declined' ? `${a.id} declined work on ${o.id}: ${error}` : `${a.id} hit a passing error on ${o.id}, trying again shortly: ${error}`);
      if (o.lead !== a) this.release(a);
      if (a.alive) this.trouble(a, kind === 'declined' ? 'contradiction' : 'retry', error, RETRY_SECONDS);
      const count = kind === 'declined' ? ++o.failures : ++o.passing;
      const most = kind === 'declined' ? GIVE_UP + Math.floor(o.tasks.length / 4) : GIVE_UP_PASSING + 2 * o.tasks.length;
      if (count >= most && o.status === 'active') {
        this.setAside(o);
        this.say(`${o.id} set aside after ${count} ${kind === 'declined' ? 'declined or failed turns' : 'passing errors'}`);
      }
      return;
    }
    this.say(`${a.id} failed on ${o.id}: ${error}`);
    this.detach(a);
    a.alive = false;
    a.gone = 'failed';
    a.error = error;
    this.engine.retire(a.id);
    // a turn stopped for running too long is stopped, not broken; both go dark
    if (/ran out of time/i.test(error)) this.emit({ type: 'agent.stopped', agent: a.id, reason: error });
    else this.emit({ type: 'agent.failed', agent: a.id, error });
    if (!a.parent) this.replacements.push({ at: this.clock() + REPLACE_SECONDS, role: a.role });
    if (++o.failures >= GIVE_UP + Math.floor(o.tasks.length / 4) && o.status === 'active') {
      this.setAside(o);
      this.say(`${o.id} set aside after ${o.failures} failed turns`);
    }
  }

  // stop what an agent is doing and put its work back on the list
  private stop(a: Agent): void {
    const turn = this.turns.get(a);
    if (turn && !turn.cancelled) {
      turn.cancelled = true;
      this.engine.cancel(a.id);
    }
    const o = a.objective;
    if (!o) return;
    for (const t of o.tasks) {
      if (t.agent !== a) continue;
      t.agent = null;
      t.state = 'pending';
    }
    if (o.lead === a) {
      o.planning = false;
      o.deciding = false;
    }
    o.reviewing.delete(a);
    o.critics.delete(a);
  }

  // ---------- agents ----------

  private live(a: Agent, dt: number, now: number): void {
    const target = !a.objective ? 0.05 : !a.busy ? 0.2 : now < a.brightUntil ? 0.9 : 0.5;
    a.effort += (target - a.effort) * (1 - Math.exp(-dt / 1.2));
    while (a.spent.length && a.spent[0].at < now - SPEND_WINDOW) a.spent.shift();
    const cost = this.price ? (a.spent.reduce((s, x) => s + x.usd, 0) * 3600) / SPEND_WINDOW : undefined;
    const costMoved = cost !== undefined && Math.abs(cost - a.costSent) > Math.max(0.002, a.costSent * 0.1);
    if (Math.abs(a.effort - a.effortSent) >= 0.07 || costMoved) {
      a.effortSent = a.effort;
      const effort = Math.round(a.effort * 100) / 100;
      if (cost === undefined) this.emit({ type: 'agent.effort', agent: a.id, effort });
      else {
        a.costSent = Math.round(cost * 1000) / 1000;
        this.emit({ type: 'agent.effort', agent: a.id, effort, cost: a.costSent });
      }
    }
    if (a.troubled && now >= a.calmAt) this.calm(a);
  }

  private spawn(role: Role, parent: Agent | null): Agent {
    const a: Agent = {
      id: parent ? `h${++this.ids.helper}` : `a${++this.ids.agent}`,
      role,
      parent,
      alive: true,
      gone: null,
      error: '',
      objective: null,
      busy: false,
      standingBy: false,
      effort: 0.05,
      effortSent: 0.05,
      costSent: 0,
      brightUntil: 0,
      spent: [],
      troubled: null,
      calmAt: 0,
      freedFrom: null,
      freedUntil: 0,
    };
    this.agents.push(a);
    this.emit(parent ? { type: 'agent.spawned', agent: a.id, role, parent: parent.id } : { type: 'agent.spawned', agent: a.id, role });
    return a;
  }

  // an agent free for this objective: first those led to it by hand, then the nest, in the roles asked for
  private take(o: Obj, roles: Role[]): Agent | null {
    const now = this.clock();
    const free = (a: Agent) => a.alive && !a.busy && !(a.freedFrom === o && now < a.freedUntil);
    const standing = this.agents.filter(a => free(a) && a.standingBy && a.objective === o);
    const resting = this.agents.filter(a => free(a) && !a.objective && !a.parent);
    for (const pool of [standing, resting]) {
      for (const role of roles) {
        const a = pool.find(b => b.role === role);
        if (a) return a;
      }
    }
    return standing[0] ?? resting[0] ?? null;
  }

  // when the nest has no one to spare, a helper buds from someone already on the work;
  // the colony grows as far as the person asks, up to what the world can draw
  private bud(o: Obj, role: Role): Agent | null {
    if (this.agents.filter(a => a.alive).length >= WORLD_BODIES) return null;
    const parent = [o.lead, ...this.agents.filter(a => a.objective === o && a.busy)].find(a => a?.alive && a.objective === o && !a.parent);
    return parent ? this.spawn(role, parent) : null;
  }

  private lead(o: Obj, what: string): boolean {
    if (o.lead?.alive && o.lead.objective === o) return true;
    const a = this.take(o, ['scout', 'critic', 'builder']);
    if (!a) return false;
    o.lead = a;
    this.assign(a, o, what);
    return true;
  }

  private leadOf(o: Obj): Agent | null {
    return o.lead?.alive && o.lead.objective === o ? o.lead : null;
  }

  private assign(a: Agent, o: Obj, what: string): void {
    if (a.objective !== o) {
      this.detach(a);
      a.objective = o;
      this.emit({ type: 'agent.assigned', agent: a.id, objective: o.id });
    }
    a.standingBy = false;
    this.activity(a, what);
  }

  // back to the nest; a helper folds back into the agent it budded from
  private release(a: Agent): void {
    if (!a.alive) return;
    this.calm(a);
    this.detach(a);
    if (a.parent) {
      a.alive = false;
      a.gone = 'merged';
      if (!a.busy) this.engine.retire(a.id);
      const into = a.parent.alive ? a.parent.id : undefined;
      this.emit(into ? { type: 'agent.merged', agent: a.id, into } : { type: 'agent.merged', agent: a.id });
      return;
    }
    // a resting agent holds no session, so a nest of a thousand costs nothing until they work
    if (!a.busy) this.engine.rest(a.id);
    this.emit({ type: 'agent.released', agent: a.id });
  }

  private detach(a: Agent): void {
    const o = a.objective;
    if (!o) return;
    if (o.lead === a) o.lead = null;
    o.critics.delete(a);
    o.reviewing.delete(a);
    a.objective = null;
    a.standingBy = false;
  }

  private vacate(o: Obj): void {
    for (const a of this.agents) {
      if (a.objective !== o) continue;
      this.stop(a);
      this.release(a);
    }
  }

  private activity(a: Agent, text: string): void {
    this.emit({ type: 'agent.activity', agent: a.id, text: clip(text, 64) });
  }

  private trouble(a: Agent, kind: FrictionKind, detail: string, seconds = 30): void {
    a.calmAt = this.clock() + seconds;
    if (a.troubled) return;
    a.troubled = kind;
    this.emit({ type: 'agent.friction', agent: a.id, kind, detail: clip(detail, 90) });
  }

  private calm(a: Agent): void {
    if (!a.troubled) return;
    a.troubled = null;
    this.emit({ type: 'agent.calm', agent: a.id });
  }

  // ---------- objectives ----------

  private create(text: string, x: number, y: number): void {
    const clean = text.trim();
    if (!clean) return;
    const o = this.blank(++this.ids.objective, clean, x, y);
    this.objectives.push(o);
    this.emit({ type: 'objective.created', objective: o.id, text: o.text, x, y, size: o.size });
    this.relate(o);
    this.say(`${o.id} dropped: ${o.text}`);
  }

  private blank(n: number, text: string, x: number, y: number): Obj {
    return {
      id: `o${n}`,
      text,
      x,
      y,
      size: sizeOf(text),
      folder: `${this.tag}-${n}-${slug(text)}`,
      status: 'active',
      phase: 'plan',
      priority: 1,
      want: 0,
      wantSaid: 0,
      wantAt: 0,
      lead: null,
      planning: false,
      deciding: false,
      retryAt: 0,
      tasks: [],
      mergeLevel: 0,
      merged: false,
      inputs: [],
      verdicts: [],
      critics: new Set(),
      reviewing: new Set(),
      revised: false,
      failures: 0,
      passing: 0,
      progress: 0,
      progressSent: 0,
      related: new Set(),
      cap: Infinity,
      capUntil: 0,
      finding: '',
    };
  }

  private task(kind: Task['kind'], from: Task | null, role: Role, title: string, brief: string, note: string, wave: number): Task {
    return { kind, from, role, title, brief, note, wave, state: 'pending', agent: null, tries: 0, passing: 0, after: 0, inputs: [] };
  }

  private room(): boolean {
    return this.turns.size < Math.min(this.maxWorking, this.limit) && this.canStart();
  }

  // agents come the moment the person asks for them: they leave the nest at once and stand by at the
  // droplet until there is work for them, as during the lead's planning; an undo sends them back
  private summon(o: Obj): void {
    if (!o.want || o.status !== 'active') return;
    const started = o.tasks.filter(t => (t.kind === 'task' || t.kind === 'look') && t.state !== 'pending').length;
    const standing = this.agents.filter(a => a.alive && a.standingBy && a.objective === o);
    let gap = o.want - started - standing.length;
    while (gap < 0 && standing.length) {
      this.release(standing.pop() as Agent);
      gap++;
    }
    if (gap <= 0) return;
    const now = this.clock();
    const resting = this.agents
      .filter(a => a.alive && !a.busy && !a.objective && !a.parent && !(a.freedFrom === o && now < a.freedUntil))
      .sort((x, y) => RANK[x.role] - RANK[y.role]);
    for (const a of resting.slice(0, gap)) {
      a.objective = o;
      a.standingBy = true;
      this.emit({ type: 'agent.assigned', agent: a.id, objective: o.id });
      this.activity(a, 'standing by for work');
    }
  }

  // the provider is turning work away, out of credit for this many requests at once, rate limited or at a
  // subscription's usage limit: keep fewer turns in flight, and let the number climb back as turns go through
  private throttle(): void {
    const now = this.clock();
    this.limit = Math.max(4, Math.floor(this.turns.size * 0.7));
    this.throttledAt = now;
    if (now - this.throttleSaid < 15) return;
    this.throttleSaid = now;
    this.say(`the provider is turning work away (out of credit for this many at once, rate limited, or at a usage limit): ${this.limit} at work for now, more as turns go through`);
  }

  private ease(): void {
    if (this.limit !== Infinity && this.clock() - this.throttledAt >= 20) this.limit++;
  }

  private nearby(o: Obj): { text: string; folder: string }[] {
    return [...o.related].map(p => ({ text: p.text, folder: p.folder }));
  }

  private setProgress(o: Obj, p: number): void {
    o.progress = Math.max(o.progress, Math.min(1, p));
    if (o.progressSent >= 1 || (o.progress - o.progressSent < 0.01 && o.progress < 1)) return;
    o.progressSent = o.progress;
    this.emit({ type: 'objective.progress', objective: o.id, progress: Math.round(o.progress * 1000) / 1000 });
  }

  private relate(o: Obj): void {
    const limit = RELATED * Math.min(this.world.w, this.world.h);
    for (const p of this.objectives) {
      if (p === o || p.status !== 'active') continue;
      const near = Math.hypot(p.x - o.x, p.y - o.y) < limit;
      if (near === o.related.has(p)) continue;
      if (near) {
        o.related.add(p);
        p.related.add(o);
      } else {
        o.related.delete(p);
        p.related.delete(o);
      }
      this.emit({ type: 'objective.related', a: o.id, b: p.id, related: near });
    }
  }

  private unrelate(o: Obj): void {
    for (const p of o.related) {
      p.related.delete(o);
      this.emit({ type: 'objective.related', a: o.id, b: p.id, related: false });
    }
    o.related.clear();
  }

  private objective(id: string): Obj | undefined {
    return this.objectives.find(o => o.id === id);
  }

  private agent(id: string): Agent | undefined {
    const a = this.agents.find(b => b.id === id);
    return a?.alive ? a : undefined;
  }

  private say(line: string): void {
    this.log(line);
  }

  private emit(e: RuntimeEvent): void {
    this.queue.push(e);
  }

  // events go out after each change completes, so a listener may send commands safely
  private flush(): void {
    while (this.queue.length) {
      const batch = this.queue;
      this.queue = [];
      for (const e of batch) for (const l of this.listeners) l(e);
    }
  }
}
