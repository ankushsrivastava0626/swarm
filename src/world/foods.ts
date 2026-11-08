// Objectives as the colony sees them: droplets of nectar that shrink as they are eaten.

export interface Bite {
  angle: number;
  depth: number; // 0..1, heals back toward 0
}

export interface Food {
  index: number;
  id: string;
  text: string;
  size: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  tx: number; // where it is being pulled: the runtime's position, or the hand dragging it
  ty: number;
  r0: number;
  r: number;
  progress: number;
  progressTarget: number;
  priority: number;
  plume: number; // how far its scent reaches, smoothed
  enriching: number; // 0..1 while a hand presses on it
  status: 'active' | 'completed' | 'abandoned';
  appear: number; // 0..1 while the droplet forms
  sink: number; // 0..1 while it sinks out of focus
  dragged: boolean;
  edge: number; // 0..1 how close a dragged droplet is to the abandon edge
  bites: Bite[];
  related: Set<number>;
  workers: number;
  lock: number; // how firmly the team on it agrees, 0 to 1
  doneAt: number;
  seed: number;
}

export const foodRadius = (size: number): number => 15 + 7 * size;

export function makeFood(index: number, id: string, text: string, size: number, x: number, y: number, seed: number): Food {
  const r0 = foodRadius(size);
  return {
    index,
    id,
    text,
    size,
    x,
    y,
    vx: 0,
    vy: 0,
    tx: x,
    ty: y,
    r0,
    r: 0,
    progress: 0,
    progressTarget: 0,
    priority: 1,
    plume: 0.6,
    enriching: 0,
    status: 'active',
    appear: 0,
    sink: 0,
    dragged: false,
    edge: 0,
    bites: [],
    related: new Set(),
    workers: 0,
    lock: 0,
    doneAt: 0,
    seed,
  };
}

// area shrinks with the work done, so the last bites are visibly the last
export function radiusFor(f: Food): number {
  const left = Math.max(0.06, 1 - 0.94 * f.progress);
  const formed = 1 - Math.pow(1 - Math.min(1, f.appear), 3);
  return f.r0 * Math.sqrt(left) * formed;
}
