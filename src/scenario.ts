// The scene you open onto: a colony that was busy before you looked.
import type { Scenario } from './runtime/simulated';
import { Rng } from './runtime/rng';
import { COLONY, type Colony } from './world/colony';

export const OPENING: Scenario = {
  objectives: [
    {
      text: 'Why do refunds post twice?',
      x: 0.25,
      y: 0.33,
      phase: 'build',
      progress: 0.34,
      workers: 70,
      friction: [
        { kind: 'contradiction', agents: 6, seconds: 18 },
        { kind: 'retry', agents: 3, seconds: 15 },
      ],
    },
    { text: 'Move billing and invoices onto the new ledger', x: 0.28, y: 0.66, phase: 'build', progress: 0.12, workers: 110 },
    {
      text: 'Audit the checkout flow',
      x: 0.75,
      y: 0.3,
      phase: 'decide',
      progress: 0.94,
      workers: 46,
      dissent: true,
      finding: 'two real issues, both in address entry',
    },
    { text: 'Draft the launch notes', x: 0.72, y: 0.64, phase: 'review', progress: 0.8, workers: 30, finding: 'draft ready, 640 words, two open questions' },
  ],
  past: {
    findings: [
      { text: 'Speed up search', finding: 'p95 down from 420 to 180 ms', x: 0.6, y: 0.13 },
      { text: 'Pick an error tracker', finding: 'three compared; the cheapest one wins', x: 0.44, y: 0.8 },
    ],
    failures: 9,
  },
  backlog: [
    'Find which emails bounce',
    'Write the migration runbook',
    'Compare three caching strategies',
    'Check the signup flow on mobile',
    'Summarize this week’s incidents',
  ],
};

// The landing page's colony: every agent at rest in the nest, and a few husks from before anyone looked.
// Its chapters stage everything else.
export const LANDING: Scenario = { objectives: [], past: { failures: 5 } };

// Lay down the veins a busy colony would already have worn in: nest to each food, and between related food.
export function wearInTrails(colony: Colony, seed: number): void {
  const rng = new Rng(seed);
  const strand = (ax: number, ay: number, bx: number, by: number, amount: number) => {
    let x = ax;
    let y = ay;
    let h = Math.atan2(by - ay, bx - ax) + rng.range(-0.9, 0.9);
    for (let i = 0; i < 400; i++) {
      const want = Math.atan2(by - y, bx - x);
      const d = Math.hypot(bx - x, by - y);
      if (d < 40) break;
      h += rng.range(-0.35, 0.35);
      h += Math.atan2(Math.sin(want - h), Math.cos(want - h)) * 0.16;
      const nx = x + Math.cos(h) * 6;
      const ny = y + Math.sin(h) * 6;
      colony.field.depositSegment(COLONY, x, y, nx, ny, amount * 6);
      colony.deposits.push(x, y, nx, ny, COLONY, amount * 6);
      x = nx;
      y = ny;
    }
  };
  const { nest } = colony;
  for (const f of colony.foods) {
    if (f.status !== 'active') continue;
    for (let k = 0; k < 4; k++) strand(nest.x, nest.y, f.x, f.y, rng.range(0.6, 1.4));
    for (const j of f.related) {
      if (j < f.index) continue;
      const g = colony.foods[j];
      for (let k = 0; k < 3; k++) strand(f.x, f.y, g.x, g.y, rng.range(0.5, 1));
    }
  }
}
