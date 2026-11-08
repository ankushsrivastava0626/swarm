// Where the glass is empty. A coarse grid of everything a label would hide: the agents, the paths they walked
// while those veins still show, food and the crowd feeding on it, the nest, the midden, answers on the glass and
// in the depth layer, the page's own furniture, and whatever a scene is about to do. A label goes only where it
// is empty.
import { Mode } from '../world/agents';
import type { Camera } from '../world/camera';
import { depthAlpha, depthBox, depthCenter, SCENT, type Colony } from '../world/colony';

export type Box = [number, number, number, number]; // left, top, width and height on the screen

// what a scene is about to cover, in world units
export type Shape =
  | { kind: 'circle'; x: number; y: number; r: number }
  | { kind: 'lane'; x0: number; y0: number; x1: number; y1: number; r: number }
  | { kind: 'box'; x: number; y: number; w: number; h: number };

const CELL = 8; // px of screen to a cell
const WALKED = 240; // seconds a walked path stays taken: about as long as the vein it leaves shows
const LIGHT = 9; // px around an agent that its light reaches
// the gaits that lay a vein, or walk a person's scent
const TRAILING = new Set<number>([Mode.Seek, Mode.Back, Mode.Home, Mode.Peer, Mode.Doubt, Mode.Led, Mode.Roam]);

export class Clearance {
  private cols = 0;
  private rows = 0;
  private taken = new Uint8Array(0);
  private sums = new Int32Array(0);
  // when an agent last walked each cell of the world, in the colony's time
  private walked = new Float32Array(0);
  private wcols = 0;
  private wrows = 0;
  private world = { w: 0, h: 0 };

  // every frame: where agents walk, so the veins they leave stay taken for as long as they show
  trace(C: Colony): void {
    if (C.w !== this.world.w || C.h !== this.world.h) {
      this.world = { w: C.w, h: C.h };
      this.wcols = Math.ceil(C.w / CELL);
      this.wrows = Math.ceil(C.h / CELL);
      this.walked = new Float32Array(this.wcols * this.wrows).fill(-Infinity);
    }
    const A = C.agents;
    const { wcols, wrows, walked } = this;
    for (let s = 0; s < A.count; s++) {
      if (!A.alive[s] || !TRAILING.has(A.mode[s])) continue;
      const cx = Math.floor(A.x[s] / CELL);
      const cy = Math.floor(A.y[s] / CELL);
      for (let y = Math.max(0, cy - 1); y <= Math.min(wrows - 1, cy + 1); y++) {
        for (let x = Math.max(0, cx - 1); x <= Math.min(wcols - 1, cx + 1); x++) walked[y * wcols + x] = C.time;
      }
    }
  }

  // the screen, cell by cell: what a label put there would hide
  build(w: number, h: number, C: Colony, cam: Camera, boxes: Box[], plan: Shape[]): void {
    const cols = Math.max(1, Math.ceil(w / CELL));
    const rows = Math.max(1, Math.ceil(h / CELL));
    if (cols !== this.cols || rows !== this.rows) {
      this.cols = cols;
      this.rows = rows;
      this.taken = new Uint8Array(cols * rows);
      this.sums = new Int32Array((cols + 1) * (rows + 1));
    } else this.taken.fill(0);
    const T = this.taken;
    const z = cam.zoom;
    const sx = (x: number) => (x - cam.cx) * z + cam.viewW / 2;
    const sy = (y: number) => (y - cam.cy) * z + cam.viewH / 2;

    // veins: the paths agents walked lately, and a person's scent
    for (let cy = 0; cy < rows; cy++) {
      const wy = cam.cy + ((cy + 0.5) * CELL - cam.viewH / 2) / z;
      const gy = Math.floor(wy / CELL);
      for (let cx = 0; cx < cols; cx++) {
        const wx = cam.cx + ((cx + 0.5) * CELL - cam.viewW / 2) / z;
        const gx = Math.floor(wx / CELL);
        const walked = gx >= 0 && gy >= 0 && gx < this.wcols && gy < this.wrows && C.time - this.walked[gy * this.wcols + gx] < WALKED;
        if (walked || C.field.sample(SCENT, wx, wy) > 0.05) T[cy * cols + cx] = 1;
      }
    }

    // every agent, and the husks on their way to the midden
    const A = C.agents;
    for (let s = 0; s < A.count; s++) if (A.alive[s]) this.disc(sx(A.x[s]), sy(A.y[s]), LIGHT * Math.max(1, z));
    for (const k of C.midden.husks) this.disc(sx(k.x), sy(k.y), 7 * z);
    // the nest's well of light, with the agents resting in it, and the midden's haze
    this.disc(sx(C.nest.x), sy(C.nest.y), (C.nest.r + 26) * z);
    const M = C.midden;
    const ry = (M.r * 1.15 + 16) * 1.05;
    const rx = ry / 0.62;
    this.rect(sx(M.x - rx), sy(M.y - ry), 2 * rx * z, 2 * ry * z);
    // food, the crowd feeding on it, the rings of a press, and food that is going
    for (const f of C.foods) {
      let r = 0;
      if (f.status === 'active') r = f.r + 18 + Math.sqrt(Math.max(1, f.workers)) * 5.5 + 10;
      if (f.enriching > 0) r = Math.max(r, f.r + 92);
      if (f.status === 'completed' && C.time - f.doneAt < 2) r = f.r0 + 20;
      if (f.status === 'abandoned' && f.sink < 1) r = f.r + 12;
      if (r > 0) this.disc(sx(f.x), sy(f.y), r * z);
    }
    // answers sunk into the depth layer, while they still show
    for (const f of C.findings) {
      if (depthAlpha(f, C.time) < 0.02) continue;
      const [bw, bh] = depthBox(f);
      const [cx, cy] = depthCenter(f);
      this.rect(sx(cx - bw / 2), sy(cy - bh / 2), bw * z, bh * z);
    }
    for (const [x, y, bw, bh] of boxes) this.rect(x, y, bw, bh);
    for (const p of plan) {
      if (p.kind === 'circle') this.disc(sx(p.x), sy(p.y), p.r * z);
      else if (p.kind === 'lane') this.lane(sx(p.x0), sy(p.y0), sx(p.x1), sy(p.y1), p.r * z);
      else this.rect(sx(p.x), sy(p.y), p.w * z, p.h * z);
    }

    // summed areas, so any box is counted at once
    const S = this.sums;
    const W = cols + 1;
    for (let y = 0; y < rows; y++) {
      let run = 0;
      for (let x = 0; x < cols; x++) {
        run += T[y * cols + x];
        S[(y + 1) * W + x + 1] = S[y * W + x + 1] + run;
      }
    }
  }

  // how many cells of a box on the screen are taken: none means a label there hides nothing
  count(x: number, y: number, w: number, h: number): number {
    const c0 = Math.max(0, Math.floor(x / CELL));
    const r0 = Math.max(0, Math.floor(y / CELL));
    const c1 = Math.min(this.cols, Math.ceil((x + w) / CELL));
    const r1 = Math.min(this.rows, Math.ceil((y + h) / CELL));
    if (c1 <= c0 || r1 <= r0) return 0;
    const W = this.cols + 1;
    const S = this.sums;
    return S[r1 * W + c1] - S[r0 * W + c1] - S[r1 * W + c0] + S[r0 * W + c0];
  }

  private disc(x: number, y: number, r: number): void {
    if (!(r > 0)) return;
    const { cols, rows, taken } = this;
    const c0 = Math.max(0, Math.floor((x - r) / CELL));
    const c1 = Math.min(cols - 1, Math.floor((x + r) / CELL));
    const r0 = Math.max(0, Math.floor((y - r) / CELL));
    const r1 = Math.min(rows - 1, Math.floor((y + r) / CELL));
    for (let cy = r0; cy <= r1; cy++) {
      const dy = Math.min(Math.max(y, cy * CELL), (cy + 1) * CELL) - y;
      for (let cx = c0; cx <= c1; cx++) {
        const dx = Math.min(Math.max(x, cx * CELL), (cx + 1) * CELL) - x;
        if (dx * dx + dy * dy <= r * r) taken[cy * cols + cx] = 1;
      }
    }
  }

  // a band around a line, as a stream of agents or a husk's flight takes
  private lane(x0: number, y0: number, x1: number, y1: number, r: number): void {
    const { cols, rows, taken } = this;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len2 = dx * dx + dy * dy || 1;
    const reach = r + CELL * 0.71;
    const c0 = Math.max(0, Math.floor((Math.min(x0, x1) - reach) / CELL));
    const c1 = Math.min(cols - 1, Math.floor((Math.max(x0, x1) + reach) / CELL));
    const r0 = Math.max(0, Math.floor((Math.min(y0, y1) - reach) / CELL));
    const r1 = Math.min(rows - 1, Math.floor((Math.max(y0, y1) + reach) / CELL));
    for (let cy = r0; cy <= r1; cy++) {
      const py = (cy + 0.5) * CELL;
      for (let cx = c0; cx <= c1; cx++) {
        const px = (cx + 0.5) * CELL;
        const t = Math.min(1, Math.max(0, ((px - x0) * dx + (py - y0) * dy) / len2));
        const ex = x0 + dx * t - px;
        const ey = y0 + dy * t - py;
        if (ex * ex + ey * ey <= reach * reach) taken[cy * cols + cx] = 1;
      }
    }
  }

  private rect(x: number, y: number, w: number, h: number): void {
    if (!(w > 0 && h > 0)) return;
    const { cols, rows, taken } = this;
    const c0 = Math.max(0, Math.floor(x / CELL));
    const c1 = Math.min(cols - 1, Math.ceil((x + w) / CELL) - 1);
    const r0 = Math.max(0, Math.floor(y / CELL));
    const r1 = Math.min(rows - 1, Math.ceil((y + h) / CELL) - 1);
    for (let cy = r0; cy <= r1; cy++) taken.fill(1, cy * cols + c0, cy * cols + c1 + 1);
  }
}
