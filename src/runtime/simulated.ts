// A believable stand-in for a real agent runtime. It schedules a colony of agents onto objectives,
// makes progress, argues, fails and recovers, and reports all of it through the protocol.
import type { Command, FrictionKind, Role, Runtime, RuntimeEvent } from './protocol';
import { Rng } from './rng';
import { activity, contextSummary, failure, finding, frictionDetail, kindOf, sizeOf, topicOf, type Kind } from './writing';

export type Phase = 'scout' | 'build' | 'review' | 'decide';

export interface ScenarioObjective {
  text: string;
  x: number; // fraction of the world's width
  y: number; // fraction of the world's height
  phase?: Phase;
  progress?: number;
  workers?: number;
  priority?: number;
  friction?: { kind: FrictionKind; agents: number; seconds: number }[];
  dissent?: boolean;
  finding?: string;
}

export interface Scenario {
  objectives: ScenarioObjective[];
  past?: { findings?: { text: string; finding: string; x: number; y: number }[]; failures?: number };
  backlog?: string[];
}

export interface SimOptions {
  seed: number;
  world: { w: number; h: number };
  colony: number;
  backlog?: boolean;
}

const STEP = 0.1; // seconds per simulation step
const RELATED = 0.36; // objectives closer than this fraction of the short side are related
const DISSENT_RATE = 0.08; // how fast a dissenter comes round: still apart after 18 s
const STAGED_DISSENT_RATE = 0.25; // a staged dissenter comes round in about eight seconds, while someone is watching
const STAGED_PACE = 6; // staged food takes this many times longer to eat, so it waits for its scenes
const ROLE_SHARE: [Role, number][] = [
  ['scout', 0.2],
  ['builder', 0.55],
  ['critic', 0.25],
];
const PREFERRED: Record<Phase, Role[]> = {
  scout: ['scout', 'critic', 'builder'],
  build: ['builder', 'builder', 'builder', 'critic', 'scout'],
  review: ['critic', 'critic', 'builder', 'scout'],
  decide: ['critic', 'builder', 'scout'],
};
const FRICTION_MIX: Record<Kind, [FrictionKind, number][]> = {
  investigate: [['contradiction', 0.6], ['retry', 0.3], ['tool-error', 0.1]],
  build: [['tool-error', 0.45], ['retry', 0.35], ['contradiction', 0.2]],
  review: [['contradiction', 0.6], ['retry', 0.4]],
  write: [['contradiction', 0.7], ['retry', 0.3]],
  compare: [['contradiction', 0.8], ['retry', 0.2]],
  research: [['tool-error', 0.4], ['retry', 0.4], ['contradiction', 0.2]],
};
const FRICTION_GAP: Record<Kind, number> = { investigate: 30, build: 45, review: 40, write: 70, compare: 50, research: 55 };

interface Agent {
  id: string;
  role: Role;
  objective: Obj | null;
  parent: Agent | null;
  helper: boolean;
  alive: boolean;
  effort: number;
  effortTarget: number;
  effortSent: number;
  nextEffortAt: number;
  stance: number;
  stanceSent: number;
  stanceSentAt: number;
  dissenter: boolean;
  friction: { kind: FrictionKind; until: number; fatal: boolean } | null;
  undecided: { until: number; other: Obj } | null;
  nextContextAt: number;
  nextActivityAt: number;
  pinnedUntil: number;
  assignedAt: number;
  reported: boolean;
  freedFrom: Obj | null;
  freedUntil: number;
}

interface Obj {
  id: string;
  text: string;
  kind: Kind;
  topic: string;
  size: number;
  x: number;
  y: number;
  progress: number;
  progressSent: number;
  priority: number;
  status: 'active' | 'completed' | 'abandoned';
  phase: Phase;
  phaseAt: number;
  workload: number;
  agents: Set<Agent>;
  related: Set<Obj>;
  frictionUntil: number;
  nextFrictionAt: number;
  nextHandoffAt: number;
  nextBudAt: number;
  nextDoubtAt: number;
  allowance: number;
  shedding: number;
  cap: number; // a cut keeps the team at most this big for a while
  capUntil: number;
  groupStance: number;
  consensusSince: number;
  dissentRate: number;
  finding?: string;
}

export class SimulatedRuntime implements Runtime {
  readonly simulated = true;
  private rng: Rng;
  private world: { w: number; h: number };
  private colony: number;
  private backlogOn: boolean;
  private backlog: string[] = [];
  private lastBacklogAt = 0;
  private now = 0;
  private acc = 0;
  private ids = { agent: 0, helper: 0, objective: 0 };
  private agents: Agent[] = [];
  private idle: Agent[] = [];
  private objectives: Obj[] = [];
  private replacements: { at: number; role: Role }[] = [];
  private listeners = new Set<(e: RuntimeEvent) => void>();
  private queue: RuntimeEvent[] = [];

  constructor(opts: SimOptions) {
    this.rng = new Rng(opts.seed);
    this.world = { ...opts.world };
    this.colony = opts.colony;
    this.backlogOn = opts.backlog ?? true;
    for (let i = 0; i < opts.colony; i++) this.spawn(this.pickRole(), null);
  }

  on(listener: (e: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  tick(dt: number): void {
    this.acc += Math.max(0, dt);
    let steps = 0;
    while (this.acc >= STEP - 1e-9 && steps < 6000) {
      this.step();
      this.acc -= STEP;
      steps++;
    }
    this.flush();
  }

  send(cmd: Command): void {
    switch (cmd.type) {
      case 'world.resize':
        this.world = { w: cmd.w, h: cmd.h };
        for (const o of this.active()) this.relate(o);
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
        if (cmd.amount > 0) o.cap = Infinity;
        o.allowance = Math.max(o.allowance, 1.5);
        this.emit({ type: 'objective.priority', objective: o.id, priority: o.priority });
        break;
      }
      case 'objective.abandon': {
        const o = this.objective(cmd.objective);
        if (!o || o.status !== 'active') break;
        o.status = 'abandoned';
        this.vacate(o);
        this.unrelate(o);
        this.emit({ type: 'objective.abandoned', objective: o.id });
        break;
      }
      case 'objective.restore': {
        const o = this.objective(cmd.objective);
        if (!o || o.status !== 'abandoned') break;
        o.status = 'active';
        o.phaseAt = this.now;
        o.allowance = 2;
        o.cap = Infinity;
        this.emit({ type: 'objective.restored', objective: o.id });
        this.relate(o);
        break;
      }
      case 'agents.reassign': {
        const o = this.objective(cmd.objective);
        if (!o || o.status !== 'active') break;
        for (const id of cmd.agents) {
          const a = this.agent(id);
          if (!a || a.objective === o) continue;
          this.assign(a, o);
          a.pinnedUntil = this.now + 90;
        }
        // agents led to it, or put back by an undo, lift any limit a cut set
        o.cap = Infinity;
        o.capUntil = 0;
        break;
      }
      case 'agents.release': {
        const touched = new Set<Obj>();
        for (const id of cmd.agents) {
          const a = this.agent(id);
          if (!a || !a.objective) continue;
          const o = a.objective;
          touched.add(o);
          a.freedFrom = o;
          a.freedUntil = this.now + 60;
          if (a.helper) this.merge(a);
          else this.release(a, true);
        }
        // a cut thins the team for a minute, as long as the freed agents stay away
        for (const o of touched) {
          o.cap = o.agents.size;
          o.capUntil = this.now + 60;
        }
        break;
      }
    }
    this.flush();
  }

  // Start from a scene already in motion, as if the swarm was busy before anyone looked.
  seed(scenario: Scenario): void {
    this.backlog = [...(scenario.backlog ?? [])];
    this.lastBacklogAt = this.now;
    for (const p of scenario.past?.findings ?? []) {
      const o = this.create(p.text, p.x * this.world.w, p.y * this.world.h, true);
      o.status = 'completed';
      this.emit({ type: 'objective.completed', objective: o.id, finding: p.finding, past: true });
    }
    for (let i = 0; i < (scenario.past?.failures ?? 0); i++) {
      const a = this.spawn(this.pickRole(), null);
      this.idle.splice(this.idle.indexOf(a), 1);
      a.alive = false;
      this.emit({ type: 'agent.failed', agent: a.id, error: failure(this.rng, 'an old task'), past: true });
    }
    for (const s of scenario.objectives) {
      const o = this.create(s.text, s.x * this.world.w, s.y * this.world.h);
      o.phase = s.phase ?? 'build';
      o.progress = o.progressSent = s.progress ?? 0;
      o.priority = s.priority ?? 1;
      o.finding = s.finding;
      if (o.progress > 0) this.emit({ type: 'objective.progress', objective: o.id, progress: o.progress });
      if (o.priority !== 1) this.emit({ type: 'objective.priority', objective: o.id, priority: o.priority });
      for (let i = 0; i < (s.workers ?? 0); i++) {
        const a = this.takeIdle(o);
        if (!a) break;
        this.assign(a, o);
        a.reported = true;
        a.nextContextAt = this.now + this.rng.range(0.5, 12);
      }
      for (const f of s.friction ?? []) {
        const pool = [...o.agents].filter(a => !a.friction);
        for (let i = 0; i < f.agents && pool.length; i++) {
          const a = pool.splice(this.rng.int(0, pool.length - 1), 1)[0];
          this.startFriction(a, o, f.kind, f.seconds + this.rng.range(-1, 2));
        }
        o.frictionUntil = this.now + f.seconds + 2;
        o.nextFrictionAt = this.now + f.seconds + this.rng.wait(1 / FRICTION_GAP[o.kind]);
      }
      if (o.phase === 'decide') this.openDebate(o, s.dissent ?? false);
    }
    this.flush();
  }

  // ---------- staged scenes: the landing page acts out how the swarm works ----------

  // food for a scene: slow to eat and free of trouble until a scene moves it on, ending on the finding given
  plant(text: string, x: number, y: number, finding?: string): string {
    const o = this.create(text, x, y);
    o.finding = finding;
    o.workload *= STAGED_PACE;
    o.nextFrictionAt = Infinity;
    this.flush();
    return o.id;
  }

  // agents leave the nest for it at once, rather than as recruitment snowballs
  muster(objective: string, n: number): void {
    const o = this.objective(objective);
    if (!o || o.status !== 'active') return;
    for (let i = 0; i < n; i++) {
      const a = this.takeIdle(o);
      if (!a) break;
      this.assign(a, o);
    }
    this.flush();
  }

  // skip ahead to a later phase: the work done jumps to where that phase begins
  hasten(objective: string, phase: Phase, opts: { dissent?: boolean } = {}): void {
    const o = this.objective(objective);
    const order: Phase[] = ['scout', 'build', 'review', 'decide'];
    if (!o || o.status !== 'active' || order.indexOf(phase) <= order.indexOf(o.phase)) return;
    const start = phase === 'review' ? 0.72 : phase === 'decide' ? 0.94 : 0;
    o.phase = phase;
    o.phaseAt = this.now;
    if (o.progress < start) {
      o.progress = o.progressSent = start;
      this.emit({ type: 'objective.progress', objective: o.id, progress: start });
    }
    // the scouts still out have told what they found
    for (const a of o.agents) a.reported = true;
    if (phase === 'decide') {
      o.dissentRate = opts.dissent ? STAGED_DISSENT_RATE : DISSENT_RATE;
      this.openDebate(o, opts.dissent ?? false);
    }
    this.flush();
  }

  // an episode of trouble: some of the team boil for a few seconds, and the fatal ones go dark
  trouble(objective: string, agents: number, fatal: number, seconds = 5): void {
    const o = this.objective(objective);
    if (!o || o.status !== 'active') return;
    // helpers are not replaced when they die, so the scene takes only agents of the colony's own
    const pool = [...o.agents].filter(a => !a.friction && !a.undecided && !a.helper);
    for (let i = 0; i < agents && pool.length; i++) {
      const a = pool.splice(this.rng.int(0, pool.length - 1), 1)[0];
      const kind: FrictionKind = i < fatal ? 'tool-error' : this.rng.chance(0.5) ? 'contradiction' : 'retry';
      a.friction = { kind, until: this.now + seconds + this.rng.range(-0.8, 0.8), fatal: i < fatal };
      this.emit({ type: 'agent.friction', agent: a.id, kind, detail: frictionDetail(this.rng, kind, o.topic) });
    }
    o.frictionUntil = this.now + seconds;
    this.flush();
  }

  // ---------- one step of simulated time ----------

  private step(): void {
    this.now += STEP;
    for (const o of this.objectives) {
      if (o.status !== 'active') continue;
      this.advancePhase(o);
      this.staff(o);
      this.work(o);
      this.stir(o);
      this.chatter(o);
      this.bud(o);
      this.debate(o);
    }
    for (const a of this.agents) if (a.alive) this.live(a);
    for (let i = this.replacements.length - 1; i >= 0; i--) {
      if (this.now < this.replacements[i].at) continue;
      this.spawn(this.replacements[i].role, null);
      this.replacements.splice(i, 1);
    }
    this.feedBacklog();
  }

  private advancePhase(o: Obj): void {
    const next =
      o.phase === 'scout' && this.now - o.phaseAt >= 6 ? 'build'
      : o.phase === 'build' && o.progress >= 0.72 ? 'review'
      : o.phase === 'review' && o.progress >= 0.94 ? 'decide'
      : null;
    if (!next) return;
    o.phase = next;
    o.phaseAt = this.now;
    if (next === 'decide') this.openDebate(o, o.agents.size >= 4 && this.rng.chance(0.6));
  }

  private desired(o: Obj): number {
    const push = 0.6 + 0.4 * o.priority;
    const base = Math.round((30 + 50 * o.size) * push);
    const n =
      o.phase === 'scout' ? Math.round(3 + 2 * o.size)
      : o.phase === 'build' ? base
      : o.phase === 'review' ? Math.round(base * 0.75)
      : Math.max(o.agents.size, 3);
    // a cut can thin the team, never empty it: the work always keeps a few hands
    const cap = this.now < o.capUntil ? Math.max(o.cap, Math.round(3 + 2 * o.size)) : Infinity;
    return Math.min(n, cap);
  }

  private staff(o: Obj): void {
    const want = this.desired(o);
    const team = o.agents.size;
    if (team < want) {
      // recruitment snowballs: the more agents already on the trail, the faster others join
      o.allowance = Math.min(3, o.allowance + (0.8 + 0.15 * team) * (0.6 + 0.4 * o.priority) * STEP);
      while (o.allowance >= 1 && o.agents.size < want) {
        const a = this.takeIdle(o);
        if (!a) break;
        this.assign(a, o);
        o.allowance -= 1;
      }
    } else if (team > want + 2) {
      o.shedding += 0.5 * STEP;
      while (o.shedding >= 1) {
        o.shedding -= 1;
        const keep = PREFERRED[o.phase][0];
        const spare = [...o.agents].find(a => a.pinnedUntil < this.now && !a.friction && (a.role !== keep || a.helper));
        if (!spare) break;
        if (spare.helper) this.merge(spare);
        else this.release(spare, false);
      }
    }
  }

  private work(o: Obj): void {
    if (o.phase === 'scout') return;
    let rate = 0;
    for (const a of o.agents) {
      const skill =
        o.phase === 'review' ? (a.role === 'critic' ? 1 : 0.5)
        : o.phase === 'decide' ? 0.2
        : a.role === 'builder' ? 1 : a.role === 'critic' ? 0.6 : 0.4;
      rate += a.friction ? 0.1 : skill * (0.4 + 0.8 * a.effort);
    }
    const ceiling = o.phase === 'decide' ? 0.995 : 1;
    o.progress = Math.min(ceiling, o.progress + (rate * STEP) / o.workload);
    if (o.progress - o.progressSent >= 0.01) {
      o.progressSent = o.progress;
      this.emit({ type: 'objective.progress', objective: o.id, progress: Math.round(o.progress * 1000) / 1000 });
    }
  }

  // friction episodes: a handful of agents contradict each other, retry, or hit a broken tool
  private stir(o: Obj): void {
    if (this.now < o.nextFrictionAt || o.phase === 'scout' || o.phase === 'decide' || o.agents.size < 4) return;
    const kind = this.weighted(FRICTION_MIX[o.kind]);
    const seconds = this.rng.range(8, 15);
    const pool = [...o.agents].filter(a => !a.friction && !a.undecided);
    const k = Math.min(pool.length, this.rng.int(3, 7));
    for (let i = 0; i < k; i++) {
      const a = pool.splice(this.rng.int(0, pool.length - 1), 1)[0];
      this.startFriction(a, o, kind, seconds + this.rng.range(-1.5, 1.5));
    }
    o.frictionUntil = this.now + seconds;
    o.nextFrictionAt = this.now + seconds + this.rng.wait(1 / FRICTION_GAP[o.kind]);
  }

  private startFriction(a: Agent, o: Obj, kind: FrictionKind, seconds: number): void {
    const fatal = kind === 'tool-error' ? this.rng.chance(0.25) : kind === 'retry' ? this.rng.chance(0.06) : false;
    a.friction = { kind, until: this.now + seconds, fatal };
    this.emit({ type: 'agent.friction', agent: a.id, kind, detail: frictionDetail(this.rng, kind, o.topic) });
  }

  // shared context and handoffs: what makes veins and sparks
  private chatter(o: Obj): void {
    for (const a of o.agents) {
      if (a.friction || a.undecided || this.now < a.nextContextAt) continue;
      if (o.phase === 'scout') {
        // a scout tastes the food, then hurries back laying trail
        if (a.reported || this.now - a.assignedAt < 3.5) continue;
        a.reported = true;
        this.emit({ type: 'agent.context', agent: a.id, op: 'write', objective: o.id, summary: contextSummary(this.rng, o.topic) });
        a.nextContextAt = this.now + this.rng.range(8, 16);
        continue;
      }
      const peers = [...o.related];
      if (peers.length && this.rng.chance(0.3)) {
        const from = this.rng.pick(peers);
        this.emit({ type: 'agent.context', agent: a.id, op: 'read', objective: o.id, from: from.id, summary: contextSummary(this.rng, from.topic) });
      } else {
        this.emit({ type: 'agent.context', agent: a.id, op: 'write', objective: o.id, summary: contextSummary(this.rng, o.topic) });
      }
      a.nextContextAt = this.now + this.rng.wait(1 / 14);
    }
    if (this.now >= o.nextHandoffAt && o.agents.size >= 2) {
      const team = [...o.agents].filter(a => !a.friction);
      const peers = [...o.related].flatMap(r => [...r.agents].filter(a => !a.friction));
      if (team.length >= 2) {
        const from = this.rng.pick(team);
        const pool = peers.length && this.rng.chance(0.15) ? peers : team.filter(a => a !== from);
        const to = this.rng.pick(pool);
        this.emit({ type: 'agent.handoff', from: from.id, to: to.id, summary: contextSummary(this.rng, o.topic) });
      }
      o.nextHandoffAt = this.now + this.rng.wait(0.3 + 0.02 * o.agents.size);
    }
    // indecision: an agent torn between this objective and a related one
    if (o.related.size && this.now >= o.nextDoubtAt) {
      o.nextDoubtAt = this.now + this.rng.wait(1 / 70);
      const pool = [...o.agents].filter(a => !a.friction && !a.undecided && a.pinnedUntil < this.now && !a.helper);
      if (pool.length) {
        const a = this.rng.pick(pool);
        const other = this.rng.pick([...o.related]);
        a.undecided = { until: this.now + this.rng.range(7, 11), other };
        this.emit({ type: 'agent.undecided', agent: a.id, between: [o.id, other.id] });
      }
    }
  }

  // helpers bud off builders when the work outgrows the colony, or when the objective is urgent
  private bud(o: Obj): void {
    if (o.phase !== 'build' || this.now < o.nextBudAt) return;
    o.nextBudAt = this.now + this.rng.wait(1 / 7);
    const short = o.agents.size < this.desired(o) && !this.idle.some(a => this.canTake(a, o));
    if (!short && o.priority < 2) return;
    const helpers = [...o.agents].filter(a => a.helper).length;
    const alive = this.agents.filter(a => a.alive).length;
    if (helpers >= Math.round(3 * o.size) || alive >= this.colony * 1.4 || o.agents.size >= this.desired(o)) return;
    const parents = [...o.agents].filter(a => !a.helper && !a.friction && a.role === 'builder');
    if (!parents.length) return;
    const parent = this.rng.pick(parents);
    const h = this.spawn(this.rng.chance(0.7) ? 'builder' : 'scout', parent);
    this.assign(h, o);
  }

  // agreement: stances drift together; a dissenter comes round slowly
  private openDebate(o: Obj, dissent: boolean): void {
    o.groupStance = this.rng.range(0.2, 0.8);
    o.consensusSince = 0;
    const team = [...o.agents];
    for (const a of team) {
      a.dissenter = false;
      a.stance = o.groupStance + this.rng.range(-0.12, 0.12);
    }
    if (dissent && team.length) {
      const d = this.rng.pick(team.filter(a => !a.helper).length ? team.filter(a => !a.helper) : team);
      d.dissenter = true;
      d.stance = o.groupStance + (o.groupStance > 0.5 ? -0.34 : 0.34);
    }
    for (const a of team) this.sendStance(a, true);
  }

  private debate(o: Obj): void {
    if (o.phase !== 'decide') return;
    let lo = Infinity;
    let hi = -Infinity;
    for (const a of o.agents) {
      const rate = a.dissenter ? o.dissentRate : 1 / 1.4;
      a.stance += (o.groupStance - a.stance) * (1 - Math.exp(-rate * STEP));
      lo = Math.min(lo, a.stance);
      hi = Math.max(hi, a.stance);
      this.sendStance(a, false);
    }
    if (!o.agents.size) return;
    // agreed only when every stance sits within 0.05 of every other
    if (hi - lo < 0.05) {
      if (!o.consensusSince) {
        o.consensusSince = this.now;
        for (const a of o.agents) this.sendStance(a, true);
      }
      if (this.now - o.consensusSince >= 3) this.complete(o);
    } else {
      o.consensusSince = 0;
    }
  }

  private sendStance(a: Agent, force: boolean): void {
    if (!force && (Math.abs(a.stance - a.stanceSent) < 0.01 || this.now - a.stanceSentAt < 0.4)) return;
    a.stanceSent = a.stance;
    a.stanceSentAt = this.now;
    this.emit({ type: 'agent.stance', agent: a.id, stance: Math.round(a.stance * 1000) / 1000 });
  }

  private complete(o: Obj): void {
    for (const a of o.agents) this.sendStance(a, true);
    o.status = 'completed';
    o.progress = 1;
    this.emit({ type: 'objective.progress', objective: o.id, progress: 1 });
    this.emit({ type: 'objective.completed', objective: o.id, finding: o.finding ?? finding(this.rng, o.kind, o.topic) });
    this.vacate(o);
    this.unrelate(o);
  }

  // per-agent life: effort, friction running out, doubts resolving, what it says it is doing
  private live(a: Agent): void {
    if (this.now >= a.nextEffortAt) {
      a.nextEffortAt = this.now + this.rng.range(2, 6);
      if (!a.objective) a.effortTarget = 0.05;
      else if (this.rng.chance(0.12)) a.effortTarget = this.rng.range(0.88, 1);
      else a.effortTarget = (a.role === 'builder' ? 0.5 : a.role === 'critic' ? 0.45 : 0.4) + this.rng.range(-0.22, 0.22);
    }
    a.effort += (a.effortTarget - a.effort) * (1 - Math.exp(-STEP / 1.5));
    if (Math.abs(a.effort - a.effortSent) >= 0.07) {
      a.effortSent = a.effort;
      // the simulation's prices: working agents spend with effort, resting ones spend nothing
      const cost = a.objective ? 0.25 + 1.6 * a.effort : 0;
      this.emit({ type: 'agent.effort', agent: a.id, effort: Math.round(a.effort * 100) / 100, cost: Math.round(cost * 100) / 100 });
    }
    if (a.friction && this.now >= a.friction.until) {
      const { fatal, kind } = a.friction;
      a.friction = null;
      if (fatal) this.die(a, kind === 'retry' ? 'stopped' : 'failed');
      else this.emit({ type: 'agent.calm', agent: a.id });
      if (!a.alive) return;
    }
    if (a.undecided && this.now >= a.undecided.until) {
      const other = a.undecided.other;
      a.undecided = null;
      this.emit({ type: 'agent.decided', agent: a.id });
      if (other.status === 'active' && this.rng.chance(0.3)) this.assign(a, other);
    }
    if (a.objective && this.now >= a.nextActivityAt) {
      a.nextActivityAt = this.now + this.rng.range(12, 25);
      this.emit({ type: 'agent.activity', agent: a.id, text: activity(this.rng, a.role, a.objective.kind, a.objective.topic) });
    }
  }

  private die(a: Agent, how: 'failed' | 'stopped'): void {
    const o = a.objective;
    const topic = o?.topic ?? 'its task';
    this.detach(a);
    a.alive = false;
    const i = this.idle.indexOf(a);
    if (i >= 0) this.idle.splice(i, 1);
    if (how === 'failed') this.emit({ type: 'agent.failed', agent: a.id, error: failure(this.rng, topic) });
    else this.emit({ type: 'agent.stopped', agent: a.id, reason: this.rng.pick(['stopped after 12 retries', 'hit its 30-minute budget']) });
    // its helpers find a new parent on the same objective
    for (const h of this.agents) {
      if (!h.alive || h.parent !== a) continue;
      h.parent = o ? [...o.agents].find(b => !b.helper) ?? null : null;
    }
    if (!a.helper) this.replacements.push({ at: this.now + this.rng.range(2, 4), role: a.role });
  }

  private feedBacklog(): void {
    if (!this.backlogOn || !this.backlog.length) return;
    if (this.active().length >= 3) {
      this.lastBacklogAt = this.now;
      return;
    }
    if (this.now - this.lastBacklogAt < 25) return;
    this.lastBacklogAt = this.now;
    const [x, y] = this.freeSpot();
    this.create(this.backlog.shift()!, x, y);
  }

  private freeSpot(): [number, number] {
    const { w, h } = this.world;
    const short = Math.min(w, h);
    let best: [number, number] = [w * 0.3, h * 0.3];
    let bestScore = -Infinity;
    for (let i = 0; i < 48; i++) {
      const x = this.rng.range(0.14, 0.86) * w;
      const y = this.rng.range(0.16, 0.8) * h;
      if (x > 0.78 * w && y > 0.7 * h) continue; // the midden's corner
      const fromNest = Math.hypot(x - w / 2, y - h / 2);
      let score = fromNest < 0.22 * short ? -1000 : 0;
      let nearest = Infinity;
      for (const o of this.active()) nearest = Math.min(nearest, Math.hypot(o.x - x, o.y - y));
      score += Math.min(nearest, 0.4 * short);
      if (score > bestScore) {
        bestScore = score;
        best = [x, y];
      }
    }
    return best;
  }

  // ---------- bookkeeping ----------

  private create(text: string, x: number, y: number, past = false): Obj {
    const kind = kindOf(text);
    const size = sizeOf(text);
    const o: Obj = {
      id: `o${++this.ids.objective}`,
      text: text.trim(),
      kind,
      topic: topicOf(text),
      size,
      x,
      y,
      progress: 0,
      progressSent: 0,
      priority: 1,
      status: 'active',
      phase: 'scout',
      phaseAt: this.now,
      workload: 3500 * Math.pow(size, 1.5),
      agents: new Set(),
      related: new Set(),
      frictionUntil: 0,
      nextFrictionAt: this.now + 10 + this.rng.wait(1 / FRICTION_GAP[kind]),
      nextHandoffAt: this.now + this.rng.range(1, 3),
      nextBudAt: this.now + this.rng.range(4, 9),
      nextDoubtAt: this.now + this.rng.range(20, 60),
      allowance: 1,
      shedding: 0,
      cap: Infinity,
      capUntil: 0,
      groupStance: 0.5,
      consensusSince: 0,
      dissentRate: DISSENT_RATE,
    };
    this.objectives.push(o);
    this.emit({ type: 'objective.created', objective: o.id, text: o.text, x, y, size });
    if (!past) this.relate(o);
    return o;
  }

  private spawn(role: Role, parent: Agent | null): Agent {
    const helper = parent !== null;
    const a: Agent = {
      id: helper ? `h${++this.ids.helper}` : `a${++this.ids.agent}`,
      role,
      objective: null,
      parent,
      helper,
      alive: true,
      effort: 0.05,
      effortTarget: 0.05,
      effortSent: 0.05,
      nextEffortAt: this.now + this.rng.range(0, 4),
      stance: this.rng.next(),
      stanceSent: -1,
      stanceSentAt: -99,
      dissenter: false,
      friction: null,
      undecided: null,
      nextContextAt: Infinity,
      nextActivityAt: Infinity,
      pinnedUntil: 0,
      assignedAt: 0,
      reported: false,
      freedFrom: null,
      freedUntil: 0,
    };
    this.agents.push(a);
    this.emit(parent ? { type: 'agent.spawned', agent: a.id, role, parent: parent.id } : { type: 'agent.spawned', agent: a.id, role });
    if (!helper) this.idle.push(a);
    return a;
  }

  private canTake(a: Agent, o: Obj): boolean {
    return a.alive && !(a.freedFrom === o && a.freedUntil > this.now);
  }

  private takeIdle(o: Obj): Agent | null {
    for (const role of PREFERRED[o.phase]) {
      const i = this.idle.findIndex(a => a.role === role && this.canTake(a, o));
      if (i >= 0) return this.idle.splice(i, 1)[0];
    }
    return null;
  }

  private assign(a: Agent, o: Obj): void {
    this.detach(a);
    const i = this.idle.indexOf(a);
    if (i >= 0) this.idle.splice(i, 1);
    a.objective = o;
    o.agents.add(a);
    a.assignedAt = this.now;
    a.effortSent = -1; // its cost changes with its work: report it on the next step
    a.reported = o.phase !== 'scout';
    a.nextContextAt = this.now + this.rng.range(5, 18);
    a.nextActivityAt = this.now + this.rng.range(12, 25);
    a.undecided = null;
    this.emit({ type: 'agent.assigned', agent: a.id, objective: o.id });
    this.emit({ type: 'agent.activity', agent: a.id, text: activity(this.rng, a.role, o.kind, o.topic) });
    // joining a debate: its stance is news only once it has joined
    if (o.phase === 'decide') {
      a.stance = o.groupStance + this.rng.range(-0.1, 0.1);
      this.sendStance(a, true);
    }
  }

  private detach(a: Agent): void {
    a.objective?.agents.delete(a);
    a.objective = null;
  }

  private release(a: Agent, freed: boolean): void {
    this.detach(a);
    a.friction = null;
    a.undecided = null;
    a.nextContextAt = Infinity;
    a.nextActivityAt = Infinity;
    a.effortSent = -1; // resting costs nothing: report it on the next step
    if (freed) this.idle.unshift(a);
    else this.idle.push(a);
    this.emit({ type: 'agent.released', agent: a.id });
  }

  private merge(h: Agent): void {
    this.detach(h);
    h.alive = false;
    const into = h.parent?.alive ? h.parent.id : undefined;
    this.emit(into ? { type: 'agent.merged', agent: h.id, into } : { type: 'agent.merged', agent: h.id });
  }

  private vacate(o: Obj): void {
    for (const a of [...o.agents]) {
      if (a.helper) this.merge(a);
      else this.release(a, false);
    }
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

  private active(): Obj[] {
    return this.objectives.filter(o => o.status === 'active');
  }

  private objective(id: string): Obj | undefined {
    return this.objectives.find(o => o.id === id);
  }

  private agent(id: string): Agent | undefined {
    const a = this.agents.find(b => b.id === id);
    return a?.alive ? a : undefined;
  }

  private pickRole(): Role {
    return this.weighted(ROLE_SHARE);
  }

  private weighted<T>(table: [T, number][]): T {
    let r = this.rng.next() * table.reduce((s, [, w]) => s + w, 0);
    for (const [v, w] of table) if ((r -= w) <= 0) return v;
    return table[table.length - 1][0];
  }

  private emit(e: RuntimeEvent): void {
    this.queue.push(e);
  }

  // events go out after each state change completes, so a listener may send commands safely
  private flush(): void {
    while (this.queue.length) {
      const batch = this.queue;
      this.queue = [];
      for (const e of batch) for (const l of this.listeners) l(e);
    }
  }
}
