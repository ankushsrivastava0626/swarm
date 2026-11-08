// A uniform grid rebuilt every frame by counting sort: no allocation, constant-time neighbourhoods.
export class SpatialHash {
  private cols = 0;
  private rows = 0;
  private cellStart = new Int32Array(0);
  private cellCount = new Int32Array(0);
  private items: Int32Array;
  private cellOf: Int32Array;
  private xs: Float32Array = new Float32Array(0);
  private ys: Float32Array = new Float32Array(0);
  private bestD = new Float64Array(64);
  private bestI = new Int32Array(64);

  constructor(
    readonly cell: number,
    w: number,
    h: number,
    capacity: number,
  ) {
    this.items = new Int32Array(capacity);
    this.cellOf = new Int32Array(capacity);
    this.resize(w, h);
  }

  resize(w: number, h: number): void {
    this.cols = Math.max(1, Math.ceil(w / this.cell));
    this.rows = Math.max(1, Math.ceil(h / this.cell));
    this.cellStart = new Int32Array(this.cols * this.rows + 1);
    this.cellCount = new Int32Array(this.cols * this.rows);
  }

  private cellIndex(x: number, y: number): number {
    const cx = Math.min(this.cols - 1, Math.max(0, Math.floor(x / this.cell)));
    const cy = Math.min(this.rows - 1, Math.max(0, Math.floor(y / this.cell)));
    return cy * this.cols + cx;
  }

  rebuild(xs: Float32Array, ys: Float32Array, alive: Uint8Array, n: number): void {
    this.xs = xs;
    this.ys = ys;
    const { cellCount, cellStart, cellOf, items } = this;
    cellCount.fill(0);
    for (let i = 0; i < n; i++) {
      if (!alive[i]) {
        cellOf[i] = -1;
        continue;
      }
      const c = this.cellIndex(xs[i], ys[i]);
      cellOf[i] = c;
      cellCount[c]++;
    }
    cellStart[0] = 0;
    for (let c = 0; c < cellCount.length; c++) cellStart[c + 1] = cellStart[c] + cellCount[c];
    cellCount.fill(0);
    for (let i = 0; i < n; i++) {
      const c = cellOf[i];
      if (c < 0) continue;
      items[cellStart[c] + cellCount[c]++] = i;
    }
  }

  queryRadius(x: number, y: number, r: number, out: Int32Array): number {
    const { cell, cols, rows, cellStart, items, xs, ys } = this;
    const x0 = Math.max(0, Math.floor((x - r) / cell));
    const x1 = Math.min(cols - 1, Math.floor((x + r) / cell));
    const y0 = Math.max(0, Math.floor((y - r) / cell));
    const y1 = Math.min(rows - 1, Math.floor((y + r) / cell));
    const r2 = r * r;
    let n = 0;
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const c = cy * cols + cx;
        for (let k = cellStart[c]; k < cellStart[c + 1]; k++) {
          const j = items[k];
          const dx = xs[j] - x;
          const dy = ys[j] - y;
          if (dx * dx + dy * dy < r2 && n < out.length) out[n++] = j;
        }
      }
    }
    return n;
  }

  // the k nearest live neighbours of item i within maxR, nearest first: a starling's topological flock
  nearestK(i: number, k: number, maxR: number, out: Int32Array): number {
    const { cell, cols, rows, cellStart, items, xs, ys, bestD, bestI } = this;
    const x = xs[i];
    const y = ys[i];
    const x0 = Math.max(0, Math.floor((x - maxR) / cell));
    const x1 = Math.min(cols - 1, Math.floor((x + maxR) / cell));
    const y0 = Math.max(0, Math.floor((y - maxR) / cell));
    const y1 = Math.min(rows - 1, Math.floor((y + maxR) / cell));
    const r2 = maxR * maxR;
    let n = 0;
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const c = cy * cols + cx;
        for (let s = cellStart[c]; s < cellStart[c + 1]; s++) {
          const j = items[s];
          if (j === i) continue;
          const dx = xs[j] - x;
          const dy = ys[j] - y;
          const d = dx * dx + dy * dy;
          if (d >= r2 || (n === k && d >= bestD[n - 1])) continue;
          // insertion into the sorted best list
          let p = n < k ? n++ : n - 1;
          while (p > 0 && bestD[p - 1] > d) {
            bestD[p] = bestD[p - 1];
            bestI[p] = bestI[p - 1];
            p--;
          }
          bestD[p] = d;
          bestI[p] = j;
        }
      }
    }
    for (let m = 0; m < n; m++) out[m] = bestI[m];
    return n;
  }
}
