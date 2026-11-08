// Small seeded generator (mulberry32) so a seeded colony plays out the same way every time.
export class Rng {
  private s: number;

  constructor(seed: number) {
    this.s = seed >>> 0 || 1;
  }

  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }

  int(a: number, b: number): number {
    return Math.floor(this.range(a, b + 1));
  }

  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.next() * xs.length)];
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  // waiting time until the next event of a process that fires `rate` times a second on average
  wait(rate: number): number {
    return -Math.log(1 - this.next()) / Math.max(rate, 1e-6);
  }
}
