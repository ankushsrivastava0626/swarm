// The colony: turns runtime events into bodies with behaviour, and moves them.
// Everything the contract promises is decided here: who goes where, how they move, what they leave behind.
import type { RuntimeEvent } from '../runtime/protocol';
import { Rng } from '../runtime/rng';
import { Agents, BODY, FRICTION_INDEX, Mode, RESPONSE, ROLE_INDEX, SEPARATION, SPEED, WANDER } from './agents';
import { Field } from './field';
import { makeFood, radiusFor, type Food } from './foods';
import { History } from './history';
import { SpatialHash } from './spatial';

export interface PointerState {
  present: boolean;
  x: number; // world units
  y: number;
  vx: number; // world units per second
  vy: number;
  still: boolean;
  reach: number;
}
export const NO_POINTER: PointerState = { present: false, x: 0, y: 0, vx: 0, vy: 0, still: false, reach: 0 };

export interface Finding {
  food: number;
  text: string;
  finding: string;
  x: number;
  y: number;
  t0: number;
  past: boolean;
  deep: number; // 0 on the glass, 1 settled in the depth layer
  w: number; // size of its out-of-focus type in world units, set once the renderer lays it out
  h: number;
  dy: number; // moved aside as it sank, so it never lands on another finding
  shown: boolean; // among the newest few that stay in view in the depth layer
  vis: number; // eases toward shown, so a finding leaving view fades instead of vanishing
}

const DEPTH_KEEP = 8; // findings that stay in view in the depth layer
const MIDDEN_KEEP = 48; // husks the pile holds; the full record is the midden's log
const DEPTH_FADE = 120; // seconds for a settled finding to fade out for good

// where a finding that has sunk sits in the depth layer
export function depthCenter(f: Finding): [number, number] {
  return [f.x, f.y + 26 + 10 * f.deep + f.dy];
}

// how much of a finding shows in the depth layer: the newest few, fading out for good a couple of minutes on
export function depthAlpha(f: Finding, time: number): number {
  if (f.vis <= 0) return 0;
  const age = Math.max(0, time - f.t0 - 30);
  return f.deep * f.vis * Math.max(0, 1 - age / DEPTH_FADE);
}

// the box its blurred type covers, used to keep findings apart; estimated until the renderer measures it
export function depthBox(f: Finding): [number, number] {
  const w = f.w || Math.min(560, Math.max(f.text.length, f.finding.length) * 7.2) * 1.25 + 35;
  return [w * 0.9, (f.h || 80) * 0.65];
}

export interface Husk {
  x: number;
  y: number;
  vx: number;
  vy: number;
  tx: number;
  ty: number;
  angle: number;
  spin: number;
  role: number;
  slot: number;
  settled: boolean;
}

export interface MiddenEntry {
  agent: string;
  text: string;
  kind: 'failed' | 'stopped';
  time: number;
}

export interface Spark {
  from: number;
  to: number;
  t0: number;
  dur: number;
  bend: number;
  x: number;
  y: number;
  px: number;
  py: number;
}

export type LeadTarget = { kind: 'food'; food: number } | { kind: 'nest' } | { kind: 'none' };

export interface Lead {
  slots: number[];
  path: number[]; // x, y pairs in world units
  active: boolean; // the hand is still down
  target: LeadTarget | null;
}

// pheromone channels
export const COLONY = 0; // the colony's shared memory: glowing veins
export const SCENT = 1; // a person's trail: matte bone
export const HEAT = 3; // friction, for the renderer only

// a vein tag packs where context came from and where it went: from * TAG + to
const TAG = 4096;
const NEST = TAG - 1; // the nest's place in a vein tag
const TEAM = new Uint8Array(12);
for (const m of [Mode.Seek, Mode.Work, Mode.Home, Mode.Peer, Mode.Back, Mode.Doubt]) TEAM[m] = 1;
const BRIGHTNESS = [0.1, 0.42, 0.5, 0.62, 0.62, 0.45, 0.6, 0.35, 0.5, 0, 0.55, 0.55];
const TAU = Math.PI * 2;

// What the colony deposited since the renderer last looked: x0, y0, x1, y1, channel, amount.
export class Deposits {
  readonly data = new Float32Array(6 * 16384);
  n = 0;

  push(x0: number, y0: number, x1: number, y1: number, ch: number, amount: number): void {
    if (this.n >= 16384) return;
    const o = this.n++ * 6;
    const d = this.data;
    d[o] = x0;
    d[o + 1] = y0;
    d[o + 2] = x1;
    d[o + 3] = y1;
    d[o + 4] = ch;
    d[o + 5] = amount;
  }
}

export interface ColonyHooks {
  crystallize?: (food: Food, finding: string) => void;
  arrived?: (food: Food) => void;
}

// where the nest and the midden sit in a world of a given size
export type Arrange = (w: number, h: number) => { nest: [number, number]; midden: [number, number] };
// the nest in the middle, the midden low in the corner
export const CENTERED: Arrange = (w, h) => ({ nest: [w / 2, h / 2], midden: [w - 86, h - 20] });

export class Colony {
  readonly agents: Agents;
  readonly field: Field;
  readonly hash: SpatialHash;
  readonly history: History;
  readonly deposits = new Deposits();
  readonly foods: Food[] = [];
  readonly findings: Finding[] = [];
  readonly sparks: Spark[] = [];
  readonly nest = { x: 0, y: 0, r: 24, idle: 0, pulse: 0 };
  readonly midden = { x: 0, y: 0, r: 12, husks: [] as Husk[], log: [] as MiddenEntry[] };
  hooks: ColonyHooks = {};
  // false when the answers are shown elsewhere, as a live colony's open in a tab of their own
  keepFindings = true;
  pointer: PointerState = NO_POINTER;
  lead: Lead | null = null;
  time = 0;
  w: number;
  h: number;
  working = 0;
  spend = 0; // dollars an hour, summed from what the runtime reports
  spendKnown = false; // whether the runtime reports cost at all
  private slots = new Map<string, number>();
  private veinNotes = new Map<number, string>(); // vein tag to what last moved along it
  private foodIds = new Map<string, number>();
  private rng: Rng;
  private nb = new Int32Array(8);
  private near = new Int32Array(512);
  private teamStart = new Int32Array(257);
  private teamFill = new Int32Array(256);
  private teamItems: Int32Array;
  private prev = { x: 0, y: 0, present: false };
  private waveSerial = 0;
  private waving = false;
  // the landing page moves the nest and the midden clear of its label on a small screen
  private arrange: Arrange = CENTERED;


  constructor(opts: { w: number; h: number; seed: number; capacity?: number }) {
    const capacity = opts.capacity ?? 1600;
    this.w = opts.w;
    this.h = opts.h;
    this.rng = new Rng(opts.seed);
    this.agents = new Agents(capacity);
    this.field = new Field(opts.w, opts.h, 8, [
      { halfLife: 90, diffusion: 0.5 },
      { halfLife: 10, diffusion: 0.8 },
    ]);
    this.hash = new SpatialHash(32, opts.w, opts.h, capacity);
    this.history = new History(capacity);
    this.teamItems = new Int32Array(capacity);
    this.place();
  }

  private place(): void {
    const { nest, midden } = this.arrange(this.w, this.h);
    [this.nest.x, this.nest.y] = nest;
    [this.midden.x, this.midden.y] = midden;
  }

  // a new arrangement: the nest and the midden move at once, and the colony makes its way to them
  rearrange(arrange: Arrange): void {
    this.arrange = arrange;
    const { nest, midden } = arrange(this.w, this.h);
    if (Math.hypot(nest[0] - this.nest.x, nest[1] - this.nest.y) < 0.5 && Math.hypot(midden[0] - this.midden.x, midden[1] - this.midden.y) < 0.5) return;
    this.place();
    for (const k of this.midden.husks) {
      [k.tx, k.ty] = this.huskTarget(k.slot);
      k.settled = false;
    }
  }

  slotOf(id: string): number {
    return this.slots.get(id) ?? -1;
  }

  foodOf(id: string): Food | undefined {
    const i = this.foodIds.get(id);
    return i === undefined ? undefined : this.foods[i];
  }

  // ---------- events ----------

  handle(e: RuntimeEvent): void {
    const A = this.agents;
    switch (e.type) {
      case 'agent.spawned': {
        const s = A.alloc(e.agent);
        if (s < 0) return;
        this.slots.set(e.agent, s);
        this.history.forget(s);
        const r = ROLE_INDEX[e.role];
        A.role[s] = r;
        A.freq[s] = this.rng.range(0.42, 0.78);
        A.phase[s] = this.rng.range(0, TAU);
        A.orbit[s] = this.rng.range(0, TAU);
        A.orbitDir[s] = this.rng.chance(0.5) ? 1 : -1;
        A.ring[s] = this.rng.next();
        A.wander[s] = this.rng.range(0, TAU);
        A.seed[s] = this.rng.next();
        A.born[s] = this.time;
        A.modeT[s] = this.time;
        const parent = e.parent ? this.slotOf(e.parent) : -1;
        if (parent >= 0) {
          A.parent[s] = parent;
          A.mode[s] = Mode.Bud;
          A.x[s] = A.x[parent];
          A.y[s] = A.y[parent];
          A.scale[s] = 0.3;
        } else {
          const a = this.rng.range(0, TAU);
          const d = Math.sqrt(this.rng.next()) * this.nest.r * 0.8;
          A.x[s] = this.nest.x + Math.cos(a) * d;
          A.y[s] = this.nest.y + Math.sin(a) * d;
          A.heading[s] = a + Math.PI / 2;
        }
        return;
      }
      case 'agent.assigned': {
        const s = this.slotOf(e.agent);
        const f = this.foodIds.get(e.objective);
        if (s < 0 || f === undefined) return;
        A.food[s] = f;
        A.pending[s] = 0;
        A.stance[s] = NaN; // a new job starts a new argument
        const m = A.mode[s];
        if (m === Mode.Bud || m === Mode.Led || m === Mode.Dying || m === Mode.Merge) return;
        this.setMode(s, Mode.Seek);
        return;
      }
      case 'agent.released': {
        const s = this.slotOf(e.agent);
        if (s < 0) return;
        A.food[s] = -1;
        A.pending[s] = 0;
        A.friction[s] = 0;
        A.stance[s] = NaN;
        const m = A.mode[s];
        if (m === Mode.Bud || m === Mode.Led || m === Mode.Dying || m === Mode.Merge || m === Mode.Roam) return;
        this.setMode(s, Mode.Idle);
        return;
      }
      case 'agent.effort': {
        const s = this.slotOf(e.agent);
        if (s < 0) return;
        A.effort[s] = e.effort;
        if (e.cost !== undefined) {
          A.cost[s] = e.cost;
          this.spendKnown = true;
        }
        return;
      }
      case 'agent.activity': {
        const s = this.slotOf(e.agent);
        if (s >= 0 && !A.friction[s]) A.activity[s] = e.text;
        return;
      }
      case 'agent.context': {
        const s = this.slotOf(e.agent);
        if (s < 0 || A.food[s] < 0) return;
        const want = e.op === 'write' ? 1 : 2;
        if (want === 2) {
          const p = e.from ? this.foodIds.get(e.from) : undefined;
          if (p === undefined || this.foods[p].status !== 'active') return;
          A.peer[s] = p;
        }
        A.carry[s] = e.summary;
        const m = A.mode[s];
        if (m === Mode.Work) this.carry(s, want);
        else if (m === Mode.Seek || m === Mode.Back) A.pending[s] = want;
        return;
      }
      case 'agent.handoff': {
        const a = this.slotOf(e.from);
        const b = this.slotOf(e.to);
        if (a < 0 || b < 0 || a === b || this.sparks.length >= 120) return;
        const d = Math.hypot(A.x[b] - A.x[a], A.y[b] - A.y[a]);
        this.sparks.push({
          from: a,
          to: b,
          t0: this.time,
          dur: Math.min(1.6, Math.max(0.35, d / 260)),
          bend: this.rng.range(-0.35, 0.35),
          x: A.x[a],
          y: A.y[a],
          px: A.x[a],
          py: A.y[a],
        });
        return;
      }
      case 'agent.stance': {
        const s = this.slotOf(e.agent);
        if (s >= 0) A.stance[s] = e.stance;
        return;
      }
      case 'agent.friction': {
        const s = this.slotOf(e.agent);
        if (s < 0) return;
        A.friction[s] = FRICTION_INDEX[e.kind];
        A.loopX[s] = A.x[s];
        A.loopY[s] = A.y[s];
        A.kickAt[s] = this.time + this.rng.range(0.1, 0.5);
        A.activity[s] = e.detail;
        return;
      }
      case 'agent.calm': {
        const s = this.slotOf(e.agent);
        if (s >= 0) A.friction[s] = 0;
        return;
      }
      case 'agent.undecided': {
        const s = this.slotOf(e.agent);
        const other = e.between.find(o => this.foodIds.get(o) !== A.food[s]);
        const p = other ? this.foodIds.get(other) : undefined;
        if (s < 0 || p === undefined || A.mode[s] === Mode.Led) return;
        A.peer[s] = p;
        A.side[s] = 1;
        A.flip[s] = this.time + this.rng.range(0.7, 1.2);
        this.setMode(s, Mode.Doubt);
        return;
      }
      case 'agent.decided': {
        const s = this.slotOf(e.agent);
        if (s >= 0 && A.mode[s] === Mode.Doubt) this.setMode(s, A.food[s] >= 0 ? Mode.Seek : Mode.Idle);
        return;
      }
      case 'agent.failed':
      case 'agent.stopped': {
        const s = this.slotOf(e.agent);
        const text = e.type === 'agent.failed' ? e.error : e.reason;
        this.midden.log.unshift({ agent: e.agent, text, kind: e.type === 'agent.failed' ? 'failed' : 'stopped', time: this.time });
        if (this.midden.log.length > 30) this.midden.log.pop();
        if (s < 0) return;
        if (e.type === 'agent.failed' && e.past) {
          this.toHusk(s, true);
          return;
        }
        A.friction[s] = 0;
        this.setMode(s, Mode.Dying);
        return;
      }
      case 'agent.merged': {
        const s = this.slotOf(e.agent);
        if (s < 0) return;
        A.parent[s] = e.into ? this.slotOf(e.into) : -1;
        A.friction[s] = 0;
        this.setMode(s, Mode.Merge);
        return;
      }
      case 'objective.created': {
        if (this.foodIds.has(e.objective)) return;
        const index = this.foods.length;
        const f = makeFood(index, e.objective, e.text, e.size, e.x, e.y, this.rng.next());
        this.foods.push(f);
        this.foodIds.set(e.objective, index);
        return;
      }
      case 'objective.progress': {
        const f = this.foodOf(e.objective);
        if (!f) return;
        const steps = Math.floor(e.progress * 50) - Math.floor(f.progressTarget * 50);
        f.progressTarget = Math.max(f.progressTarget, e.progress);
        for (let k = 0; k < Math.min(steps, 3); k++) this.bite(f);
        return;
      }
      case 'objective.related': {
        const a = this.foodOf(e.a);
        const b = this.foodOf(e.b);
        if (!a || !b) return;
        if (e.related) {
          a.related.add(b.index);
          b.related.add(a.index);
        } else {
          a.related.delete(b.index);
          b.related.delete(a.index);
        }
        return;
      }
      case 'objective.priority': {
        const f = this.foodOf(e.objective);
        if (f) f.priority = e.priority;
        return;
      }
      case 'objective.moved': {
        const f = this.foodOf(e.objective);
        if (f && !f.dragged) {
          f.tx = e.x;
          f.ty = e.y;
        }
        return;
      }
      case 'objective.completed': {
        const f = this.foodOf(e.objective);
        if (!f) return;
        f.status = 'completed';
        f.doneAt = this.time;
        f.progressTarget = 1;
        if (e.past) {
          f.appear = 1;
          f.r = 0;
          if (!this.keepFindings) return;
          const past: Finding = { food: f.index, text: f.text, finding: e.finding, x: f.x, y: f.y, t0: this.time - 60, past: true, deep: 0, w: 0, h: 0, dy: 0, shown: true, vis: 1 };
          past.dy = this.placeInDepth(past);
          past.deep = 1;
          this.findings.push(past);
          return;
        }
        // the colony's glow condenses: workers swirl into the droplet as it goes
        for (let s = 0; s < A.count; s++) {
          if (!A.alive[s] || A.food[s] !== f.index || A.mode[s] !== Mode.Work) continue;
          const dx = f.x - A.x[s];
          const dy = f.y - A.y[s];
          A.vx[s] += dx * 2.4 - dy * 1.2 * A.orbitDir[s];
          A.vy[s] += dy * 2.4 + dx * 1.2 * A.orbitDir[s];
          A.flash[s] = 1.2;
        }
        if (this.keepFindings) this.findings.push({ food: f.index, text: f.text, finding: e.finding, x: f.x, y: f.y, t0: this.time, past: false, deep: 0, w: 0, h: 0, dy: 0, shown: true, vis: 1 });
        this.hooks.crystallize?.(f, e.finding);
        return;
      }
      case 'objective.abandoned': {
        const f = this.foodOf(e.objective);
        if (f) f.status = 'abandoned';
        return;
      }
      case 'objective.restored': {
        const f = this.foodOf(e.objective);
        if (f) f.status = 'active';
        return;
      }
    }
  }

  private setMode(s: number, m: Mode): void {
    this.agents.mode[s] = m;
    this.agents.modeT[s] = this.time;
  }

  // leave the food with something to share: home to the nest, or over to a related food
  private carry(s: number, want: number): void {
    const A = this.agents;
    A.pending[s] = 0;
    if (want === 2 && A.peer[s] >= 0) this.setMode(s, Mode.Peer);
    else {
      A.peer[s] = -1;
      this.setMode(s, Mode.Home);
    }
  }

  // a progress step takes a visible bite, by the nearest worker if there is one
  private bite(f: Food): void {
    const A = this.agents;
    let angle = this.rng.range(0, TAU);
    let best = -1;
    let bestD = Infinity;
    const probe = this.rng.range(0, TAU);
    for (let s = 0; s < A.count; s++) {
      if (!A.alive[s] || A.food[s] !== f.index || A.mode[s] !== Mode.Work) continue;
      const a = Math.atan2(A.y[s] - f.y, A.x[s] - f.x);
      const d = Math.abs(Math.atan2(Math.sin(a - probe), Math.cos(a - probe)));
      if (d < bestD) {
        bestD = d;
        best = s;
        angle = a;
      }
    }
    if (best >= 0) {
      A.biteUntil[best] = this.time + 0.35;
      A.flash[best] = Math.max(A.flash[best], 0.5);
    }
    f.bites.push({ angle, depth: 1 });
    if (f.bites.length > 8) f.bites.shift();
  }

  // ---------- gestures the input layer calls ----------

  // slots of the living agents within reach of a point, nearest first
  within(x: number, y: number, r: number, max = 60): number[] {
    const A = this.agents;
    const n = this.hash.queryRadius(x, y, r, this.near);
    const out: number[] = [];
    for (let k = 0; k < n; k++) {
      const s = this.near[k];
      const m = A.mode[s];
      if (A.alive[s] && m !== Mode.Dying && m !== Mode.Merge && m !== Mode.Bud) out.push(s);
    }
    out.sort((a, b) => Math.hypot(A.x[a] - x, A.y[a] - y) - Math.hypot(A.x[b] - x, A.y[b] - y));
    return out.slice(0, max);
  }

  // what moved along the vein at a point in the last 40 s, and between where; '' names shared memory
  veinAt(x: number, y: number, minStrength = 3): { what: string; from: string; to: string } | null {
    if (this.field.sample(COLONY, x, y) < minStrength) return null;
    const tag = this.field.tagNear(x, y, 2);
    if (!tag || this.time - tag.time > 40) return null;
    const ends = [Math.floor(tag.id / TAG), tag.id % TAG];
    if (ends[0] === ends[1] || ends.some(i => i !== NEST && !this.foods[i])) return null;
    const [from, to] = ends.map(i => (i === NEST ? '' : this.foods[i].text));
    return { what: this.veinNotes.get(tag.id) ?? '', from, to };
  }

  foodAt(x: number, y: number, pad = 10): Food | null {
    let best: Food | null = null;
    let bestD = Infinity;
    for (const f of this.foods) {
      if (f.status !== 'active') continue;
      const d = Math.hypot(f.x - x, f.y - y) - f.r;
      if (d < pad && d < bestD) {
        bestD = d;
        best = f;
      }
    }
    return best;
  }

  inNest(x: number, y: number): boolean {
    return Math.hypot(x - this.nest.x, y - this.nest.y) < Math.max(36, this.nest.r);
  }

  startLead(slots: number[], x: number, y: number): void {
    const A = this.agents;
    this.lead = { slots, path: [x, y], active: true, target: null };
    for (const s of slots) {
      A.leadK[s] = 0;
      A.friction[s] = 0;
      this.setMode(s, Mode.Led);
    }
  }

  extendLead(x: number, y: number): void {
    const L = this.lead;
    if (!L || !L.active) return;
    const n = L.path.length;
    const lx = L.path[n - 2];
    const ly = L.path[n - 1];
    if (Math.hypot(x - lx, y - ly) < 10) return;
    this.layScent(lx, ly, x, y);
    L.path.push(x, y);
  }

  // a person's scent: the same chemistry as the colony's, in bone, and quicker to fade
  layScent(x0: number, y0: number, x1: number, y1: number): void {
    const d = Math.hypot(x1 - x0, y1 - y0);
    if (d <= 0) return;
    this.field.depositSegment(SCENT, x0, y0, x1, y1, d * 0.5);
    this.deposits.push(x0, y0, x1, y1, SCENT, d * 0.5);
  }

  endLead(target: LeadTarget): void {
    if (!this.lead) return;
    this.lead.active = false;
    this.lead.target = target;
  }

  // a person's hand moved an agent: let it go to work where it was put
  resolveLead(s: number): void {
    const A = this.agents;
    const t = this.lead?.target;
    if (t?.kind === 'food' && A.food[s] === t.food) this.setMode(s, Mode.Seek);
    else if (t?.kind === 'nest' || A.food[s] < 0) this.setMode(s, A.food[s] >= 0 ? Mode.Seek : Mode.Idle);
    else this.setMode(s, Mode.Roam);
    if (this.lead) this.lead.slots = this.lead.slots.filter(x => x !== s);
  }

  scatter(s: number, dx: number, dy: number, speed: number): void {
    const d = Math.hypot(dx, dy) || 1;
    this.agents.vx[s] += (dx / d) * speed;
    this.agents.vy[s] += (dy / d) * speed;
    this.agents.flash[s] = Math.max(this.agents.flash[s], 0.8);
  }

  // ---------- simulation ----------

  step(dt: number): void {
    this.time += dt;
    const A = this.agents;
    this.hash.rebuild(A.x, A.y, A.alive, A.count);
    this.census(dt);
    this.pulse(dt);
    for (let s = 0; s < A.count; s++) if (A.alive[s]) this.move(s, dt);
    this.waves();
    this.stepSparks(dt);
    this.stepFoods(dt);
    this.stepHusks(dt);
    this.stepFindings(dt);
    this.field.step(dt);
    this.history.tick(dt, A.count, A.alive, A.x, A.y, A.glow, A.ember);
    this.prev = { x: this.pointer.x, y: this.pointer.y, present: this.pointer.present };
  }

  // headcounts: the nest grows with spare capacity, spend follows effort
  private census(dt: number): void {
    const A = this.agents;
    let idle = 0;
    let working = 0;
    let spend = 0;
    for (const f of this.foods) f.workers = 0;
    for (let s = 0; s < A.count; s++) {
      if (!A.alive[s]) continue;
      const m = A.mode[s];
      if (m === Mode.Idle) idle++;
      else if (m !== Mode.Dying && m !== Mode.Merge) {
        working++;
        if (A.food[s] >= 0 && m === Mode.Work) this.foods[A.food[s]].workers++;
      }
      // spend is what the runtime says each agent costs; the colony never estimates money
      if (m !== Mode.Dying && m !== Mode.Merge) spend += A.cost[s];
    }
    this.nest.idle = idle;
    this.working = working;
    this.spend = spend;
    const r = 24 + Math.sqrt(idle) * 3.4;
    this.nest.r += (r - this.nest.r) * (1 - Math.exp(-dt / 1.5));
    this.nest.pulse *= Math.exp(-dt / 0.6);
  }

  // Firefly lock: agents on the same food pull each other's flicker into phase, as strongly as their stances agree
  private pulse(dt: number): void {
    const A = this.agents;
    const nf = this.foods.length;
    if (this.teamStart.length < nf + 1) {
      this.teamStart = new Int32Array(nf * 2 + 1);
      this.teamFill = new Int32Array(nf * 2);
    }
    const { teamStart, teamItems, teamFill } = this;
    teamStart.fill(0, 0, nf + 1);
    for (let s = 0; s < A.count; s++) {
      if (A.alive[s] && A.food[s] >= 0 && TEAM[A.mode[s]] && A.stance[s] === A.stance[s]) teamStart[A.food[s] + 1]++;
    }
    for (let f = 0; f < nf; f++) teamStart[f + 1] += teamStart[f];
    teamFill.fill(0, 0, nf);
    for (let s = 0; s < A.count; s++) {
      if (A.alive[s] && A.food[s] >= 0 && TEAM[A.mode[s]] && A.stance[s] === A.stance[s]) {
        const f = A.food[s];
        teamItems[teamStart[f] + teamFill[f]++] = s;
      }
    }
    const K = 2.6;
    const shift = Math.floor(this.time * 7);
    for (let s = 0; s < A.count; s++) {
      if (!A.alive[s]) continue;
      let dphi = TAU * A.freq[s];
      const f = A.food[s];
      if (f >= 0 && TEAM[A.mode[s]] && A.stance[s] === A.stance[s]) {
        const a = teamStart[f];
        const n = teamStart[f + 1] - a;
        const samples = Math.min(n - 1, 8);
        let c = 0;
        let sims = 0;
        let fsum = 0;
        for (let k = 1; k <= samples; k++) {
          const j = teamItems[a + ((k * 7 + shift + s) % n)];
          if (j === s) continue;
          const d = (A.stance[s] - A.stance[j]) / 0.06;
          const sim = Math.exp(-d * d);
          c += sim * Math.sin(A.phase[j] - A.phase[s]);
          sims += sim;
          fsum += sim * A.freq[j];
        }
        if (samples > 0) {
          dphi += (K * c) / samples;
          if (sims / samples > 0.3) A.freq[s] += (fsum / sims - A.freq[s]) * Math.min(1, 0.5 * dt);
        }
      }
      let p = A.phase[s] + dphi * dt;
      if (p > TAU) p -= TAU;
      A.phase[s] = p;
    }
    // how firmly each team agrees: the order parameter of its flicker, drawn as a steady halo under reduced motion
    const k = 1 - Math.exp(-dt);
    for (let f = 0; f < nf; f++) {
      const a = teamStart[f];
      const n = teamStart[f + 1] - a;
      let order = 0;
      if (n >= 3) {
        let re = 0;
        let im = 0;
        for (let i = a; i < a + n; i++) {
          re += Math.cos(A.phase[teamItems[i]]);
          im += Math.sin(A.phase[teamItems[i]]);
        }
        order = Math.hypot(re, im) / n;
      }
      const food = this.foods[f];
      food.lock += (order - food.lock) * k;
      if (food.lock < 1e-3) food.lock = 0;
    }
  }

  private move(s: number, dt: number): void {
    const A = this.agents;
    const role = A.role[s];
    const mode = A.mode[s];
    const x0 = A.x[s];
    const y0 = A.y[s];
    const t = this.time;
    A.energy[s] += (A.effort[s] - A.energy[s]) * (1 - Math.exp(-dt / 1.2));
    const speed = SPEED[role] * (0.75 + 0.5 * A.energy[s]);
    let dvx = 0;
    let dvy = 0;
    let ax = 0;
    let ay = 0;
    let goal = -1; // a food to head for, or NEST_GOAL for the nest
    let follow = 0;
    let lay = 0;
    let tag = -1;
    let note = '';
    let pace = 1;
    const own = A.food[s] >= 0 ? this.foods[A.food[s]] : null;

    switch (mode) {
      case Mode.Idle: {
        const dx = x0 - this.nest.x;
        const dy = y0 - this.nest.y;
        const d = Math.hypot(dx, dy) || 1;
        if (d > this.nest.r + 24) {
          goal = -2;
          follow = 0.4;
          pace = 0.8;
        } else {
          // a slow murmuration around the nest
          const want = this.nest.r * (0.18 + 0.72 * A.ring[s]) * (1 + 0.08 * Math.sin(t * 0.4 + A.seed[s] * 9));
          const swirl = 14 + 10 * A.ring[s];
          dvx = (-dy / d) * swirl + (dx / d) * (want - d) * 0.9;
          dvy = (dx / d) * swirl + (dy / d) * (want - d) * 0.9;
        }
        break;
      }
      case Mode.Seek:
      case Mode.Back: {
        if (!own || own.status !== 'active') {
          this.setMode(s, Mode.Roam);
          break;
        }
        goal = own.index;
        follow = 1;
        // trails end at the edge of the feeding ground; the ground itself is not a vein
        const near = Math.hypot(own.x - x0, own.y - y0) < own.r + 34;
        lay = near ? 0 : mode === Mode.Back ? 0.03 : role === 0 ? 0 : 0.012;
        if (mode === Mode.Back) {
          tag = A.peer[s] >= 0 ? A.peer[s] * TAG + own.index : NEST * TAG + own.index;
          note = A.peer[s] >= 0 ? A.carry[s] : ''; // from the nest: the route says it all
        }
        if (Math.hypot(own.x - x0, own.y - y0) < own.r + 24) {
          this.setMode(s, Mode.Work);
          A.loopX[s] = x0;
          A.loopY[s] = y0;
          this.hooks.arrived?.(own);
        }
        break;
      }
      case Mode.Work: {
        if (!own || own.status !== 'active') {
          if (own && own.status === 'completed' && t - own.doneAt < 0.9) {
            // pulled into the collapsing droplet
            dvx = (own.x - x0) * 3;
            dvy = (own.y - y0) * 3;
            break;
          }
          this.setMode(s, A.food[s] >= 0 ? Mode.Roam : Mode.Idle);
          break;
        }
        if (A.pending[s] && t - A.modeT[s] > 0.5) {
          this.carry(s, A.pending[s]);
          break;
        }
        A.orbit[s] += A.orbitDir[s] * (0.06 + 0.14 * A.energy[s]) * dt;
        const bite = t < A.biteUntil[s];
        const spread = 10 + Math.sqrt(Math.max(1, own.workers)) * 5.5;
        const rr = bite ? own.r - 3 : own.r + 8 + A.ring[s] * spread;
        const tx = own.x + Math.cos(A.orbit[s]) * rr;
        const ty = own.y + Math.sin(A.orbit[s]) * rr;
        const k = bite ? 6 : 2.2;
        dvx = (tx - x0) * k;
        dvy = (ty - y0) * k;
        const v = Math.hypot(dvx, dvy);
        if (v > speed) {
          dvx *= speed / v;
          dvy *= speed / v;
        }
        // the feeding ground smells of the work, so seekers home in; it is not drawn
        this.field.deposit(COLONY, x0, y0, 0.25 * dt);
        break;
      }
      case Mode.Home: {
        goal = -2;
        follow = 0.6;
        pace = 1.08;
        const first = A.food[s] >= 0 && t - A.modeT[s] < 30 && role === 0;
        const leaving = own ? Math.hypot(own.x - x0, own.y - y0) < own.r + 34 : false;
        lay = leaving ? 0 : first ? 0.14 : 0.085;
        tag = A.food[s] >= 0 ? A.food[s] * TAG + NEST : -1;
        note = A.carry[s];
        if (Math.hypot(this.nest.x - x0, this.nest.y - y0) < Math.max(14, this.nest.r * 0.5)) {
          this.nest.pulse = Math.min(1, this.nest.pulse + 0.25);
          A.flash[s] = Math.max(A.flash[s], 0.6);
          A.peer[s] = -1;
          this.setMode(s, own && own.status === 'active' ? Mode.Back : Mode.Idle);
        }
        break;
      }
      case Mode.Peer: {
        const p = A.peer[s] >= 0 ? this.foods[A.peer[s]] : null;
        if (!p || p.status !== 'active' || !own) {
          this.setMode(s, own ? Mode.Back : Mode.Idle);
          break;
        }
        goal = p.index;
        follow = 0.5;
        lay = Math.hypot(p.x - x0, p.y - y0) < p.r + 34 || Math.hypot(own.x - x0, own.y - y0) < own.r + 34 ? 0 : 0.085;
        tag = own.index * TAG + p.index;
        note = A.carry[s] ? `a request for ${A.carry[s]}` : '';
        if (Math.hypot(p.x - x0, p.y - y0) < p.r + 22) {
          A.flash[s] = Math.max(A.flash[s], 0.6);
          this.setMode(s, Mode.Back);
        }
        break;
      }
      case Mode.Led: {
        const L = this.lead;
        if (!L || !L.slots.includes(s)) {
          this.resolveLead(s);
          break;
        }
        const n = L.path.length / 2;
        let k = Math.min(A.leadK[s], n - 1);
        let tx = L.path[k * 2];
        let ty = L.path[k * 2 + 1];
        if (Math.hypot(tx - x0, ty - y0) < 18 && k < n - 1) {
          A.leadK[s] = ++k;
          tx = L.path[k * 2];
          ty = L.path[k * 2 + 1];
        }
        const d = Math.hypot(tx - x0, ty - y0) || 1;
        const v = Math.min(speed * 1.25, d * 3);
        dvx = ((tx - x0) / d) * v;
        dvy = ((ty - y0) / d) * v;
        if (!L.active && k >= n - 1 && d < 30) this.resolveLead(s);
        break;
      }
      case Mode.Roam: {
        A.wander[s] += (this.rng.next() - 0.5) * 3 * dt;
        dvx = Math.cos(A.wander[s]) * speed * 0.4;
        dvy = Math.sin(A.wander[s]) * speed * 0.4;
        if (t - A.modeT[s] > 2.5) this.setMode(s, own && own.status === 'active' ? Mode.Seek : Mode.Idle);
        break;
      }
      case Mode.Doubt: {
        const p = A.peer[s] >= 0 ? this.foods[A.peer[s]] : null;
        if (!p || !own || p.status !== 'active' || own.status !== 'active') {
          this.setMode(s, own && own.status === 'active' ? Mode.Seek : Mode.Idle);
          break;
        }
        if (t > A.flip[s]) {
          A.side[s] ^= 1;
          A.flip[s] = t + this.rng.range(0.9, 1.6);
        }
        goal = A.side[s] ? p.index : own.index;
        pace = 0.95;
        break;
      }
      case Mode.Dying: {
        A.vx[s] *= Math.exp(-dt / 0.5);
        A.vy[s] *= Math.exp(-dt / 0.5);
        A.vy[s] += 10 * dt;
        A.x[s] += A.vx[s] * dt;
        A.y[s] += A.vy[s] * dt;
        A.glow[s] *= Math.exp(-dt / 0.35);
        if (t - A.modeT[s] > 1.3) this.toHusk(s, false);
        return;
      }
      case Mode.Bud: {
        const p = A.parent[s];
        const age = (t - A.modeT[s]) / 0.9;
        if (p < 0 || !A.alive[p] || age >= 1) {
          if (p >= 0 && A.alive[p]) this.scatter(s, A.x[s] - A.x[p], A.y[s] - A.y[p], 50);
          A.scale[s] = 1;
          this.setMode(s, A.food[s] >= 0 ? Mode.Seek : Mode.Idle);
          break;
        }
        const h = A.heading[p] + Math.PI / 2;
        const off = (BODY[A.role[p]] + BODY[role]) * (0.3 + 1.7 * age);
        A.x[s] = A.x[p] + Math.cos(h) * off;
        A.y[s] = A.y[p] + Math.sin(h) * off;
        A.vx[s] = A.vx[p];
        A.vy[s] = A.vy[p];
        A.heading[s] = A.heading[p];
        A.scale[s] = 0.3 + 0.7 * age;
        A.glow[s] = Math.max(A.glow[s], A.glow[p]);
        return;
      }
      case Mode.Merge: {
        const p = A.parent[s];
        const live = p >= 0 && A.alive[p] && A.mode[p] !== Mode.Dying;
        const tx = live ? A.x[p] : this.nest.x;
        const ty = live ? A.y[p] : this.nest.y;
        const d = Math.hypot(tx - x0, ty - y0) || 1;
        A.scale[s] = Math.min(1, Math.max(0.2, d / 40));
        if (d < 7) {
          if (live) A.flash[p] = Math.max(A.flash[p], 0.9);
          else this.nest.pulse = Math.min(1, this.nest.pulse + 0.2);
          this.remove(s);
          return;
        }
        const v = Math.min(speed * 1.3, d * 3);
        dvx = ((tx - x0) / d) * v;
        dvy = ((ty - y0) / d) * v;
        break;
      }
    }

    // head for a goal, following any trail that leads roughly the same way
    if (goal !== -1) {
      // gait by role: builders steady, scouts dash, critics stop and go, pausing to inspect
      if (role === 0) pace *= 0.85 + 0.5 * Math.max(0, Math.sin(t * 2.3 + A.seed[s] * 17)) ** 3;
      else if (role === 2) pace *= 0.3 + 0.95 * (0.5 + 0.5 * Math.sin(t * 4.2 + A.seed[s] * 23)) ** 2;
      const gx = goal === -2 ? this.nest.x : this.foods[goal].x;
      const gy = goal === -2 ? this.nest.y : this.foods[goal].y;
      const gd = Math.hypot(gx - x0, gy - y0) || 1;
      let ux = (gx - x0) / gd;
      let uy = (gy - y0) / gd;
      A.wander[s] += (this.rng.next() - 0.5) * 2.4 * dt;
      const ww = WANDER[role] * Math.min(1, gd / 120);
      let fx = ux + Math.cos(A.wander[s]) * ww;
      let fy = uy + Math.sin(A.wander[s]) * ww;
      if (follow > 0 && gd > 40) {
        const h = A.heading[s];
        let best = 0;
        let bx = 0;
        let by = 0;
        for (let k = -1; k <= 1; k++) {
          const a = h + k * 0.55;
          const cx = Math.cos(a);
          const cy = Math.sin(a);
          if (cx * ux + cy * uy < 0.35) continue;
          const c = this.field.sample(COLONY, x0 + cx * 20, y0 + cy * 20);
          if (c > best) {
            best = c;
            bx = cx;
            by = cy;
          }
        }
        // positive feedback: the stronger the trail, the harder it pulls, so lanes bundle into veins
        const strength = (best / (best + 1.5)) * follow * 2.4;
        fx += bx * strength;
        fy += by * strength;
      }
      const fd = Math.hypot(fx, fy) || 1;
      const arrive = Math.min(1, gd / 50);
      dvx = (fx / fd) * speed * pace * (0.35 + 0.65 * arrive);
      dvy = (fy / fd) * speed * pace * (0.35 + 0.65 * arrive);
      ux = 0;
      uy = 0;
    }

    // friction: boiling in place
    const kind = mode === Mode.Work ? A.friction[s] : 0;
    const emberTarget = kind ? 1 : 0;
    A.ember[s] += (emberTarget - A.ember[s]) * (1 - Math.exp(-dt / (kind ? 0.35 : 0.8)));
    if (A.ember[s] < 1e-4) A.ember[s] = 0;
    let sepScale = 1;
    if (kind === 1) {
      // contradiction: jostling and colliding, a lot of motion and no headway.
      // The shove changes direction about ten times a second; the pull back to the work stays.
      if (t > A.kickAt[s]) {
        A.kickAt[s] = t + this.rng.range(0.07, 0.14);
        A.wander[s] = this.rng.range(0, TAU);
      }
      ax += Math.cos(A.wander[s]) * 1500;
      ay += Math.sin(A.wander[s]) * 1500;
      sepScale = 0.25;
    } else if (kind === 2) {
      // retry: the same loop, again and again
      const lx = x0 - A.loopX[s];
      const ly = y0 - A.loopY[s];
      const ld = Math.hypot(lx, ly) || 1;
      const R = 15 + 4 * A.seed[s];
      const v = (TAU * R) / 1.05;
      dvx = (-ly / ld) * v * A.orbitDir[s] + (lx / ld) * (R - ld) * 4;
      dvy = (lx / ld) * v * A.orbitDir[s] + (ly / ld) * (R - ld) * 4;
    } else if (kind === 3) {
      // a broken tool: still, then a spasm
      dvx *= 0.2;
      dvy *= 0.2;
      if (t > A.kickAt[s]) {
        A.kickAt[s] = t + this.rng.range(0.35, 0.9);
        const a = this.rng.range(0, TAU);
        A.vx[s] += Math.cos(a) * 170;
        A.vy[s] += Math.sin(a) * 170;
      }
      const a = this.rng.range(0, TAU);
      ax += Math.cos(a) * 500;
      ay += Math.sin(a) * 500;
    }

    // steer: bodies answer at the speed their role allows; a boiling body is held hard to its place
    const resp = kind ? 8 : RESPONSE[role];
    ax += (dvx - A.vx[s]) * resp;
    ay += (dvy - A.vy[s]) * resp;

    // neighbours: keep a little room, and fall in with those going the same way
    const n = this.hash.nearestK(s, 7, 40, this.nb);
    const sep = SEPARATION[role] * (A.scale[s] || 1);
    let avx = 0;
    let avy = 0;
    let an = 0;
    const transit = mode === Mode.Seek || mode === Mode.Back || mode === Mode.Home || mode === Mode.Peer;
    const flowing = transit || mode === Mode.Idle;
    if (transit) sepScale *= 0.5; // on a trail, ants pass close
    for (let k = 0; k < n; k++) {
      const j = this.nb[k];
      const dx = x0 - A.x[j];
      const dy = y0 - A.y[j];
      const d = Math.hypot(dx, dy) || 0.01;
      const r = Math.max(sep, SEPARATION[A.role[j]]);
      // a helper folding back into its parent has to be allowed to touch it
      if (d < r && mode !== Mode.Merge && A.mode[j] !== Mode.Merge) {
        const push = (1 - d / r) * 520 * sepScale;
        ax += (dx / d) * push;
        ay += (dy / d) * push;
      }
      if (flowing && A.vx[j] * A.vx[s] + A.vy[j] * A.vy[s] > 0) {
        avx += A.vx[j];
        avy += A.vy[j];
        an++;
      }
    }
    if (an) {
      ax += (avx / an - A.vx[s]) * 0.9;
      ay += (avy / an - A.vy[s]) * 0.9;
    }

    // the hand: agents part around a moving cursor and turn to face a still one
    const P = this.pointer;
    let attn = 0;
    if (P.present) {
      const dx = x0 - P.x;
      const dy = y0 - P.y;
      const d = Math.hypot(dx, dy) || 0.01;
      const ps = Math.hypot(P.vx, P.vy);
      if (ps > 40 && d < 40) {
        const push = (1 - d / 40) ** 2 * 2200 * Math.min(1, ps / 500);
        ax += (dx / d) * push + (P.vx / ps) * push * 0.3;
        ay += (dy / d) * push + (P.vy / ps) * push * 0.3;
      }
      if (P.still && d < P.reach) attn = 1;
    }
    A.attn[s] += (attn - A.attn[s]) * (1 - Math.exp(-dt / 0.18));

    // integrate
    A.vx[s] += ax * dt;
    A.vy[s] += ay * dt;
    const vmax = speed * 2.2 + 200 * A.ember[s];
    const v = Math.hypot(A.vx[s], A.vy[s]);
    if (v > vmax) {
      A.vx[s] *= vmax / v;
      A.vy[s] *= vmax / v;
    }
    let x = x0 + A.vx[s] * dt;
    let y = y0 + A.vy[s] * dt;
    if (x < 3 || x > this.w - 3) {
      A.vx[s] *= -0.5;
      x = Math.min(this.w - 3, Math.max(3, x));
    }
    if (y < 3 || y > this.h - 3) {
      A.vy[s] *= -0.5;
      y = Math.min(this.h - 3, Math.max(3, y));
    }
    A.x[s] = x;
    A.y[s] = y;

    // heading follows motion; attention turns the body toward the hand
    if (v > 6) {
      const target = Math.atan2(A.vy[s], A.vx[s]);
      const turn = Math.atan2(Math.sin(target - A.heading[s]), Math.cos(target - A.heading[s]));
      A.heading[s] += turn * (1 - Math.exp(-dt * (role === 1 ? 5 : 9)));
    }
    if (A.attn[s] > 0.01 && P.present) {
      const face = Math.atan2(P.y - y, P.x - x);
      const turn = Math.atan2(Math.sin(face - A.heading[s]), Math.cos(face - A.heading[s]));
      A.heading[s] += turn * A.attn[s] * (1 - Math.exp(-dt * 10));
    }

    // what it leaves behind
    if (lay > 0) {
      const d = Math.hypot(x - x0, y - y0);
      if (d > 0) {
        this.field.depositSegment(COLONY, x0, y0, x, y, lay * d);
        this.deposits.push(x0, y0, x, y, COLONY, lay * d);
        if (tag >= 0) {
          this.field.tag(x, y, tag, t);
          if (note) this.veinNotes.set(tag, note);
        }
      }
    }
    if (A.ember[s] > 0.05) this.deposits.push(x, y, x, y, HEAT, A.ember[s] * dt * 3);

    // light: effort and mode set it, flashes ride on top
    const base = BRIGHTNESS[mode];
    const working = mode !== Mode.Idle && mode !== Mode.Roam;
    const target = base * (working ? 0.4 + 1.1 * A.energy[s] : 1) * (1 + 0.6 * A.attn[s]);
    const fadeIn = Math.min(1, (t - A.born[s]) / 1.2);
    A.glow[s] += (target * fadeIn - A.glow[s]) * (1 - Math.exp(-dt / 0.4));
    A.flash[s] *= Math.exp(-dt / 0.25);
  }

  // a quick pass of the hand starts one turn that travels through the flock, neighbour to neighbour
  private waves(): void {
    const A = this.agents;
    const P = this.pointer;
    const t = this.time;
    const speed = Math.hypot(P.vx, P.vy);
    if (P.present && this.prev.present && speed > 900) {
      if (!this.waving) {
        this.waving = true;
        this.waveSerial++;
      }
      const mx = (P.x + this.prev.x) / 2;
      const my = (P.y + this.prev.y) / 2;
      const half = Math.hypot(P.x - this.prev.x, P.y - this.prev.y) / 2 + 26;
      const n = this.hash.queryRadius(mx, my, half, this.near);
      for (let k = 0; k < n; k++) {
        const s = this.near[k];
        if (A.waveId[s] === this.waveSerial || !A.alive[s]) continue;
        if (segmentDistance(A.x[s], A.y[s], this.prev.x, this.prev.y, P.x, P.y) > 26) continue;
        const cross = P.vx * A.vy[s] - P.vy * A.vx[s];
        this.turn(s, this.waveSerial, cross >= 0 ? 0.9 : -0.9, t + 0.07);
      }
    } else {
      this.waving = false;
    }
    for (let s = 0; s < A.count; s++) {
      if (!A.alive[s] || A.waveAt[s] <= 0 || t < A.waveAt[s]) continue;
      A.waveAt[s] = 0;
      const turn = A.waveTurn[s] * 0.92;
      if (Math.abs(turn) < 0.12) continue;
      const n = this.hash.nearestK(s, 7, 70, this.nb);
      for (let k = 0; k < n; k++) {
        const j = this.nb[k];
        if (A.waveId[j] === A.waveId[s]) continue;
        this.turn(j, A.waveId[s], turn, t + this.rng.range(0.05, 0.09));
      }
    }
  }

  private turn(s: number, id: number, angle: number, passAt: number): void {
    const A = this.agents;
    A.waveId[s] = id;
    A.waveTurn[s] = angle;
    A.waveAt[s] = passAt;
    const c = Math.cos(angle);
    const sn = Math.sin(angle);
    const vx = A.vx[s];
    const vy = A.vy[s];
    const v = Math.hypot(vx, vy);
    if (v < 12) {
      const h = A.heading[s] + angle;
      A.vx[s] += Math.cos(h) * 30;
      A.vy[s] += Math.sin(h) * 30;
    } else {
      A.vx[s] = vx * c - vy * sn;
      A.vy[s] = vx * sn + vy * c;
    }
    A.flash[s] = Math.max(A.flash[s], 0.75 * Math.min(1, Math.abs(angle) * 1.2));
  }

  private stepSparks(dt: number): void {
    const A = this.agents;
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const k = this.sparks[i];
      const { from, to } = k;
      if (!A.alive[from] || !A.alive[to]) {
        this.sparks.splice(i, 1);
        continue;
      }
      const u = (this.time - k.t0) / k.dur;
      if (u >= 1) {
        A.flash[to] = Math.max(A.flash[to], 0.8);
        this.sparks.splice(i, 1);
        continue;
      }
      const x0 = A.x[from];
      const y0 = A.y[from];
      const x1 = A.x[to];
      const y1 = A.y[to];
      const dx = x1 - x0;
      const dy = y1 - y0;
      const d = Math.hypot(dx, dy);
      // mouth to mouth: close neighbours lean in, the way ants pass food
      if (d < 110 && d > 8) {
        const pull = 40 * dt;
        A.vx[from] += (dx / d) * pull;
        A.vy[from] += (dy / d) * pull;
        A.vx[to] -= (dx / d) * pull;
        A.vy[to] -= (dy / d) * pull;
      }
      const e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
      const mx = (x0 + x1) / 2 - dy * k.bend;
      const my = (y0 + y1) / 2 + dx * k.bend;
      const w = 1 - e;
      k.px = k.x;
      k.py = k.y;
      k.x = w * w * x0 + 2 * w * e * mx + e * e * x1;
      k.y = w * w * y0 + 2 * w * e * my + e * e * y1;
    }
  }

  private stepFoods(dt: number): void {
    for (const f of this.foods) {
      if (f.status === 'completed') {
        const u = (this.time - f.doneAt) / 0.8;
        f.r = u >= 1 ? 0 : radiusFor(f) * (1 - u) * (1 - u);
        continue;
      }
      // heavy: a dragged droplet lags the hand and stretches with its speed
      const w = f.dragged ? 9 : 3.5;
      const ax = w * w * (f.tx - f.x) - 2 * w * f.vx;
      const ay = w * w * (f.ty - f.y) - 2 * w * f.vy;
      f.vx += ax * dt;
      f.vy += ay * dt;
      f.x += f.vx * dt;
      f.y += f.vy * dt;
      f.appear = Math.min(1, f.appear + dt / 1.2);
      f.progress += (f.progressTarget - f.progress) * (1 - Math.exp(-dt / 0.6));
      const sunk = f.status === 'abandoned' ? 1 : 0;
      f.sink += (sunk - f.sink) * (1 - Math.exp(-dt / (sunk ? 0.7 : 0.5)));
      f.r = radiusFor(f);
      for (let i = f.bites.length - 1; i >= 0; i--) {
        f.bites[i].depth *= Math.exp(-dt / 5);
        if (f.bites[i].depth < 0.04) f.bites.splice(i, 1);
      }
      const reach = 0.55 + 0.45 * (f.priority - 1) + 1.4 * f.enriching;
      f.plume += (reach - f.plume) * (1 - Math.exp(-dt / 1.2));
    }
  }

  private toHusk(s: number, past: boolean): void {
    const A = this.agents;
    const slot = this.midden.husks.length;
    const [tx, ty] = this.huskTarget(slot);
    this.midden.husks.push({
      x: past ? tx : A.x[s],
      y: past ? ty : A.y[s],
      vx: past ? 0 : A.vx[s],
      vy: past ? 0 : A.vy[s],
      tx,
      ty,
      angle: past ? this.rng.range(0, TAU) : A.heading[s],
      spin: this.rng.range(-1.2, 1.2),
      role: A.role[s],
      slot,
      settled: past,
    });
    // the pile keeps its size: the oldest husk crumbles away and the rest settle into its place
    if (this.midden.husks.length > MIDDEN_KEEP) {
      this.midden.husks.shift();
      this.midden.husks.forEach((k, i) => {
        k.slot = i;
        [k.tx, k.ty] = this.huskTarget(i);
        k.settled = false;
      });
    }
    this.remove(s);
  }

  // husks pile into a low mound in the corner, the oldest at the bottom
  private huskTarget(k: number): [number, number] {
    const a = Math.PI * (0.06 + 0.88 * ((k * 0.6180339) % 1));
    const r = 6.5 * Math.sqrt(k + 1);
    return [this.midden.x + Math.cos(a) * r * 1.7, this.midden.y - Math.sin(a) * r * 0.8];
  }

  private stepHusks(dt: number): void {
    const M = this.midden;
    M.r = 12 + 7.5 * Math.sqrt(M.husks.length);
    const w = 1.6;
    for (const k of M.husks) {
      if (k.settled) continue;
      k.vx += (w * w * (k.tx - k.x) - 2 * w * k.vx) * dt;
      k.vy += (w * w * (k.ty - k.y) - 2 * w * k.vy) * dt;
      k.x += k.vx * dt;
      k.y += k.vy * dt;
      k.angle += k.spin * dt;
      k.spin *= Math.exp(-dt / 2);
      if (Math.hypot(k.tx - k.x, k.ty - k.y) < 0.5 && Math.hypot(k.vx, k.vy) < 1) k.settled = true;
    }
  }

  private stepFindings(dt: number): void {
    let kept = 0;
    for (let i = this.findings.length - 1; i >= 0; i--) {
      const f = this.findings[i];
      f.shown = kept < DEPTH_KEEP;
      if (f.deep > 0 || this.time - f.t0 >= 24) kept++;
      f.vis += ((f.shown ? 1 : 0) - f.vis) * (1 - Math.exp(-dt / 0.8));
      if (f.vis < 0.01) f.vis = 0;
      if (f.deep >= 1 || this.time - f.t0 < 24) continue;
      if (f.deep === 0) f.dy = this.placeInDepth(f);
      f.deep = Math.min(1, f.deep + dt / 2.5);
    }
  }

  // the nearest free place for a finding about to sink: where it was, else a little below or above
  private placeInDepth(f: Finding): number {
    const [w, h] = depthBox(f);
    const step = h + 4;
    for (let k = 0; k < 15; k++) {
      const dy = (k % 2 ? 1 : -1) * Math.ceil(k / 2) * step;
      const y = f.y + 36 + dy;
      if (y < h || y > this.h - h) continue;
      const clash = this.findings.some(g => {
        if (g === f || !g.shown || (g.deep === 0 && g.dy === 0)) return false;
        const [gw, gh] = depthBox(g);
        const [gx, gy] = depthCenter(g);
        return Math.abs(f.x - gx) < (w + gw) / 2 && Math.abs(y - (gy + 10 * (1 - g.deep))) < (h + gh) / 2;
      });
      if (!clash) return dy;
    }
    return 0;
  }

  private remove(s: number): void {
    const id = this.agents.id[s];
    if (id) this.slots.delete(id);
    this.agents.release(s);
    this.history.forget(s);
    if (this.lead) this.lead.slots = this.lead.slots.filter(x => x !== s);
    for (let i = 0; i < this.agents.count; i++) if (this.agents.parent[i] === s) this.agents.parent[i] = -1;
  }

  // the world follows the window: everything keeps its place relative to the edges
  resize(w: number, h: number): void {
    if (!(w >= 1 && h >= 1)) return; // a world with no room would lose every position: keep the last one
    const kx = w / this.w;
    const ky = h / this.h;
    if (kx === 1 && ky === 1) return;
    this.w = w;
    this.h = h;
    const A = this.agents;
    for (let s = 0; s < A.count; s++) {
      A.x[s] *= kx;
      A.y[s] *= ky;
      A.loopX[s] *= kx;
      A.loopY[s] *= ky;
    }
    for (const f of this.foods) {
      f.x *= kx;
      f.y *= ky;
      f.tx *= kx;
      f.ty *= ky;
    }
    for (const f of this.findings) {
      f.x *= kx;
      f.y *= ky;
    }
    if (this.lead) for (let i = 0; i < this.lead.path.length; i += 2) {
      this.lead.path[i] *= kx;
      this.lead.path[i + 1] *= ky;
    }
    this.place();
    for (const k of this.midden.husks) {
      [k.tx, k.ty] = this.huskTarget(k.slot);
      k.x = k.tx;
      k.y = k.ty;
      k.settled = true;
    }
    this.field.resize(w, h);
    this.hash.resize(w, h);
    this.history.scale(kx, ky);
  }
}

export function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
