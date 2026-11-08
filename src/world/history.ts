// The last few seconds of every body's path, for the long exposure.
export const HISTORY_HZ = 15;
export const HISTORY_SAMPLES = 90; // six seconds

export class History {
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly glow: Uint8Array;
  readonly ember: Uint8Array;
  readonly valid: Uint8Array;
  head = 0; // next sample to write
  filled = 0;
  private acc = 0;

  constructor(readonly capacity: number) {
    const n = capacity * HISTORY_SAMPLES;
    this.x = new Float32Array(n);
    this.y = new Float32Array(n);
    this.glow = new Uint8Array(n);
    this.ember = new Uint8Array(n);
    this.valid = new Uint8Array(n);
  }

  // a reused slot must not draw a line from its previous owner
  forget(slot: number): void {
    this.valid.fill(0, slot * HISTORY_SAMPLES, (slot + 1) * HISTORY_SAMPLES);
  }

  tick(
    dt: number,
    count: number,
    alive: Uint8Array,
    xs: Float32Array,
    ys: Float32Array,
    glow: Float32Array,
    ember: Float32Array,
  ): void {
    this.acc += dt;
    if (this.acc < 1 / HISTORY_HZ) return;
    this.acc %= 1 / HISTORY_HZ;
    const k = this.head;
    for (let s = 0; s < count; s++) {
      const i = s * HISTORY_SAMPLES + k;
      if (!alive[s]) {
        this.valid[i] = 0;
        continue;
      }
      this.x[i] = xs[s];
      this.y[i] = ys[s];
      this.glow[i] = Math.min(255, glow[s] * 200);
      this.ember[i] = Math.min(255, ember[s] * 255);
      this.valid[i] = 1;
    }
    for (let s = count; s < this.capacity; s++) this.valid[s * HISTORY_SAMPLES + k] = 0;
    this.head = (k + 1) % HISTORY_SAMPLES;
    this.filled = Math.min(HISTORY_SAMPLES, this.filled + 1);
  }

  scale(kx: number, ky: number): void {
    for (let i = 0; i < this.x.length; i++) {
      this.x[i] *= kx;
      this.y[i] *= ky;
    }
  }
}
