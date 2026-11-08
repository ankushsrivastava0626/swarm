// The ground's chemistry: a coarse grid of pheromone the agents can smell.
// Values are amounts per cell. Diffusion reflects at the edges, so nothing leaks out of the world.

export interface ChannelSpec {
  halfLife: number; // seconds until a deposit fades to half
  diffusion: number; // cells squared per second
}

export class Field {
  cols = 0;
  rows = 0;
  data: Float32Array[] = [];
  // which objective's context last passed through each cell, and when: lets the glass name a vein
  tagId = new Int32Array(0);
  tagTime = new Float32Array(0);
  private tmp = new Float32Array(0);

  constructor(
    public w: number,
    public h: number,
    readonly cell: number,
    readonly channels: ChannelSpec[],
  ) {
    this.allocate(w, h);
  }

  private allocate(w: number, h: number): void {
    this.w = w;
    this.h = h;
    this.cols = Math.max(2, Math.ceil(w / this.cell));
    this.rows = Math.max(2, Math.ceil(h / this.cell));
    const n = this.cols * this.rows;
    this.data = this.channels.map(() => new Float32Array(n));
    this.tmp = new Float32Array(n);
    this.tagId = new Int32Array(n).fill(-1);
    this.tagTime = new Float32Array(n);
  }

  step(dt: number): void {
    for (let c = 0; c < this.channels.length; c++) {
      const { halfLife, diffusion } = this.channels[c];
      const v = this.data[c];
      if (diffusion > 0) {
        const passes = Math.max(1, Math.ceil((diffusion * dt) / 0.3));
        const k = (diffusion * dt) / passes;
        for (let p = 0; p < passes; p++) this.diffuse(v, k);
      }
      if (Number.isFinite(halfLife)) {
        const decay = Math.pow(0.5, dt / halfLife);
        for (let i = 0; i < v.length; i++) v[i] *= decay;
      }
    }
  }

  // one explicit step of the heat equation, separably, with reflecting edges
  private diffuse(v: Float32Array, k: number): void {
    const { cols, rows, tmp } = this;
    for (let y = 0; y < rows; y++) {
      const row = y * cols;
      for (let x = 0; x < cols; x++) {
        const i = row + x;
        const l = x > 0 ? v[i - 1] : v[i];
        const r = x < cols - 1 ? v[i + 1] : v[i];
        tmp[i] = v[i] + k * (l - 2 * v[i] + r);
      }
    }
    for (let y = 0; y < rows; y++) {
      const row = y * cols;
      for (let x = 0; x < cols; x++) {
        const i = row + x;
        const u = y > 0 ? tmp[i - cols] : tmp[i];
        const d = y < rows - 1 ? tmp[i + cols] : tmp[i];
        v[i] = tmp[i] + k * (u - 2 * tmp[i] + d);
      }
    }
  }

  // bilinear splat: the four nearest cell centres share the amount
  deposit(ch: number, x: number, y: number, amount: number): void {
    const { cols, rows } = this;
    const gx = Math.min(Math.max(x / this.cell - 0.5, 0), cols - 1.001);
    const gy = Math.min(Math.max(y / this.cell - 0.5, 0), rows - 1.001);
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const fx = gx - x0;
    const fy = gy - y0;
    const v = this.data[ch];
    const i = y0 * cols + x0;
    v[i] += amount * (1 - fx) * (1 - fy);
    v[i + 1] += amount * fx * (1 - fy);
    v[i + cols] += amount * (1 - fx) * fy;
    v[i + cols + 1] += amount * fx * fy;
  }

  // spread a total amount evenly along a segment, a dab every half cell
  depositSegment(ch: number, x0: number, y0: number, x1: number, y1: number, amount: number): void {
    const len = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.max(1, Math.ceil(len / (this.cell * 0.5)));
    const each = amount / n;
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      this.deposit(ch, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, each);
    }
  }

  sample(ch: number, x: number, y: number): number {
    const { cols, rows } = this;
    const gx = Math.min(Math.max(x / this.cell - 0.5, 0), cols - 1.001);
    const gy = Math.min(Math.max(y / this.cell - 0.5, 0), rows - 1.001);
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const fx = gx - x0;
    const fy = gy - y0;
    const v = this.data[ch];
    const i = y0 * cols + x0;
    return (v[i] * (1 - fx) + v[i + 1] * fx) * (1 - fy) + (v[i + cols] * (1 - fx) + v[i + cols + 1] * fx) * fy;
  }

  tag(x: number, y: number, id: number, time: number): void {
    const cx = Math.min(this.cols - 1, Math.max(0, Math.floor(x / this.cell)));
    const cy = Math.min(this.rows - 1, Math.max(0, Math.floor(y / this.cell)));
    const i = cy * this.cols + cx;
    this.tagId[i] = id;
    this.tagTime[i] = time;
  }

  // the most recent tag within a few cells of a point
  tagNear(x: number, y: number, radiusCells = 1): { id: number; time: number } | null {
    const cx = Math.floor(x / this.cell);
    const cy = Math.floor(y / this.cell);
    let best: { id: number; time: number } | null = null;
    for (let dy = -radiusCells; dy <= radiusCells; dy++) {
      for (let dx = -radiusCells; dx <= radiusCells; dx++) {
        const gx = cx + dx;
        const gy = cy + dy;
        if (gx < 0 || gy < 0 || gx >= this.cols || gy >= this.rows) continue;
        const i = gy * this.cols + gx;
        if (this.tagId[i] < 0) continue;
        if (!best || this.tagTime[i] > best.time) best = { id: this.tagId[i], time: this.tagTime[i] };
      }
    }
    return best;
  }

  total(ch: number): number {
    let s = 0;
    for (const v of this.data[ch]) s += v;
    return s;
  }

  // keep the pattern, stretched to the new size
  resize(w: number, h: number): void {
    const old = { cols: this.cols, rows: this.rows, data: this.data, tagId: this.tagId, tagTime: this.tagTime };
    this.allocate(w, h);
    for (let c = 0; c < this.data.length; c++) {
      const v = this.data[c];
      for (let y = 0; y < this.rows; y++) {
        for (let x = 0; x < this.cols; x++) {
          const ox = Math.min(old.cols - 1, Math.floor((x / this.cols) * old.cols));
          const oy = Math.min(old.rows - 1, Math.floor((y / this.rows) * old.rows));
          v[y * this.cols + x] = old.data[c][oy * old.cols + ox];
          if (c === 0) {
            this.tagId[y * this.cols + x] = old.tagId[oy * old.cols + ox];
            this.tagTime[y * this.cols + x] = old.tagTime[oy * old.cols + ox];
          }
        }
      }
    }
  }
}
