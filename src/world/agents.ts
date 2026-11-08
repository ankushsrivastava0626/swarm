// Every living agent body, stored as parallel typed arrays so a thousand of them cost no garbage.
import type { FrictionKind, Role } from '../runtime/protocol';

// What a body is doing in space. Work is the runtime's word; mode is the body's.
export const Mode = {
  Idle: 0, // resting in the nest, dim
  Seek: 1, // heading to its food, following the trail
  Work: 2, // feeding at its food
  Home: 3, // carrying context back to the nest, laying trail
  Peer: 4, // fetching context from a related food, laying trail
  Back: 5, // returning to its own food
  Led: 6, // following a person's scent trail
  Roam: 7, // cut loose or led nowhere, milling before it moves on
  Doubt: 8, // undecided, zigzagging between two foods
  Dying: 9, // going dark
  Bud: 10, // pinching off a parent
  Merge: 11, // folding back into a parent
} as const;
export type Mode = (typeof Mode)[keyof typeof Mode];

export const ROLES: readonly Role[] = ['scout', 'builder', 'critic'];
export const ROLE_INDEX: Record<Role, number> = { scout: 0, builder: 1, critic: 2 };
export const FRICTION_INDEX: Record<FrictionKind, number> = { contradiction: 1, retry: 2, 'tool-error': 3 };

// body and gait by role: scouts small and darting, builders big and steady, critics in between
export const SPEED = [118, 70, 88]; // px/s at moderate effort
export const RESPONSE = [6, 2.4, 4]; // how quickly a body answers a change of course, 1/s
export const WANDER = [0.55, 0.12, 0.28];
export const BODY = [2.1, 3.3, 2.7]; // core radius, px
export const SEPARATION = [9, 13, 11];

export class Agents {
  count = 0; // slots in use are all below this
  readonly id: (string | null)[];
  readonly activity: string[];
  readonly carry: string[]; // what it is carrying along a vein
  readonly alive: Uint8Array;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly heading: Float32Array;
  readonly role: Uint8Array;
  readonly mode: Uint8Array;
  readonly modeT: Float32Array;
  readonly food: Int16Array;
  readonly peer: Int16Array;
  readonly pending: Uint8Array; // on reaching its food: 0 nothing, 1 carry home, 2 fetch from peer
  readonly effort: Float32Array;
  readonly cost: Float32Array; // dollars an hour, as the runtime reports it
  readonly energy: Float32Array;
  readonly phase: Float32Array;
  readonly freq: Float32Array;
  readonly stance: Float32Array;
  readonly friction: Uint8Array;
  readonly ember: Float32Array;
  readonly glow: Float32Array;
  readonly flash: Float32Array;
  readonly attn: Float32Array;
  readonly born: Float32Array;
  readonly scale: Float32Array;
  readonly parent: Int32Array;
  readonly orbit: Float32Array;
  readonly orbitDir: Int8Array;
  readonly ring: Float32Array;
  readonly wander: Float32Array;
  readonly loopX: Float32Array;
  readonly loopY: Float32Array;
  readonly kickAt: Float32Array;
  readonly waveId: Int32Array;
  readonly waveAt: Float32Array;
  readonly waveTurn: Float32Array;
  readonly leadK: Int32Array;
  readonly flip: Float32Array;
  readonly side: Uint8Array;
  readonly biteUntil: Float32Array;
  readonly seed: Float32Array;
  private free: number[] = [];

  constructor(readonly capacity: number) {
    const f = () => new Float32Array(capacity);
    this.id = new Array(capacity).fill(null);
    this.activity = new Array(capacity).fill('');
    this.carry = new Array(capacity).fill('');
    this.alive = new Uint8Array(capacity);
    this.x = f();
    this.y = f();
    this.vx = f();
    this.vy = f();
    this.heading = f();
    this.role = new Uint8Array(capacity);
    this.mode = new Uint8Array(capacity);
    this.modeT = f();
    this.food = new Int16Array(capacity).fill(-1);
    this.peer = new Int16Array(capacity).fill(-1);
    this.pending = new Uint8Array(capacity);
    this.effort = f();
    this.cost = f();
    this.energy = f();
    this.phase = f();
    this.freq = f();
    this.stance = f().fill(NaN);
    this.friction = new Uint8Array(capacity);
    this.ember = f();
    this.glow = f();
    this.flash = f();
    this.attn = f();
    this.born = f();
    this.scale = f();
    this.parent = new Int32Array(capacity).fill(-1);
    this.orbit = f();
    this.orbitDir = new Int8Array(capacity);
    this.ring = f();
    this.wander = f();
    this.loopX = f();
    this.loopY = f();
    this.kickAt = f();
    this.waveId = new Int32Array(capacity);
    this.waveAt = f();
    this.waveTurn = f();
    this.leadK = new Int32Array(capacity);
    this.flip = f();
    this.side = new Uint8Array(capacity);
    this.biteUntil = f();
    this.seed = f();
  }

  // a fresh slot with every field reset; -1 when the colony is full
  alloc(id: string): number {
    const s = this.free.length ? this.free.pop()! : this.count < this.capacity ? this.count++ : -1;
    if (s < 0) return -1;
    this.id[s] = id;
    this.activity[s] = '';
    this.carry[s] = '';
    this.alive[s] = 1;
    this.vx[s] = this.vy[s] = 0;
    this.mode[s] = Mode.Idle;
    this.modeT[s] = 0;
    this.food[s] = -1;
    this.peer[s] = -1;
    this.pending[s] = 0;
    this.effort[s] = 0.05;
    this.cost[s] = 0;
    this.energy[s] = 0.05;
    this.stance[s] = NaN;
    this.friction[s] = 0;
    this.ember[s] = 0;
    this.glow[s] = 0;
    this.flash[s] = 0;
    this.attn[s] = 0;
    this.scale[s] = 1;
    this.parent[s] = -1;
    this.waveId[s] = 0;
    this.waveAt[s] = 0;
    this.waveTurn[s] = 0;
    this.leadK[s] = 0;
    this.biteUntil[s] = 0;
    return s;
  }

  release(s: number): void {
    this.alive[s] = 0;
    this.id[s] = null;
    this.free.push(s);
  }
}
