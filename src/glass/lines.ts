// Engraved lines on the glass: the crosshair, viewfinder corners, rings, the knife's mark.
import type { App } from '../app';
import type { Input } from '../input/input';

const SNOW = '243, 241, 236'; // the glass's own white, as its words

export type Engrave = (path: () => void, alpha: number, width?: number) => void;

export class Lines {
  // drawn last, by others who write on the glass: the landing page's leader lines
  overlay: ((c: CanvasRenderingContext2D, engrave: Engrave) => void) | null = null;
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private w = 0;
  private h = 0;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  private fit(w: number, h: number): void {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    if (w === this.w && h === this.h && dpr === this.dpr) return;
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
  }

  // a line cut into glass: a dark groove under a pale edge
  private engrave(path: () => void, alpha: number, width = 1): void {
    const c = this.ctx;
    c.lineWidth = width;
    c.save();
    c.translate(0, 1);
    c.strokeStyle = `rgba(0, 0, 0, ${(alpha * 0.7).toFixed(3)})`;
    c.beginPath();
    path();
    c.stroke();
    c.restore();
    c.strokeStyle = `rgba(${SNOW}, ${alpha.toFixed(3)})`;
    c.beginPath();
    path();
    c.stroke();
  }

  draw(app: App, input: Input): void {
    this.fit(app.w, app.h);
    const c = this.ctx;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, this.w, this.h);
    c.lineCap = 'round';
    const cam = app.camera;
    const t = app.clock;

    // viewfinder corners
    const inset = 22;
    const arm = 16;
    const corner = (x: number, y: number, dx: number, dy: number) =>
      this.engrave(() => {
        c.moveTo(x + dx * arm, y);
        c.lineTo(x, y);
        c.lineTo(x, y + dy * arm);
      }, 0.16);
    corner(inset, inset, 1, 1);
    corner(this.w - inset, inset, -1, 1);
    corner(inset, this.h - inset, 1, -1);
    corner(this.w - inset, this.h - inset, -1, -1);

    // a frozen moment gets a shutter frame
    if (app.exposure > 0.02 && app.frozen) {
      const a = 0.22 * app.exposure;
      this.engrave(() => c.rect(inset + 8, inset + 8, this.w - 2 * inset - 16, this.h - 2 * inset - 16), a);
    }

    // food you are looking at or have picked
    const ring = (fx: number, fy: number, r: number, alpha: number, dashed = false) => {
      const [sx, sy] = cam.toScreen(fx, fy);
      if (dashed) c.setLineDash([3, 4]);
      this.engrave(() => c.arc(sx, sy, r, 0, Math.PI * 2), alpha);
      c.setLineDash([]);
    };
    const hover = input.hover.kind === 'food' ? input.hover.food : null;
    if (hover && !input.gesture) ring(hover.x, hover.y, hover.r * cam.zoom + 12, 0.42);
    if (input.selected && input.selected.status === 'active') ring(input.selected.x, input.selected.y, input.selected.r * cam.zoom + 18, 0.5, true);

    // pressing to enrich: rings spread from the food like a pulse
    if (input.enriching) {
      const f = input.enriching;
      for (let k = 0; k < 3; k++) {
        const u = (t * 0.9 + k / 3) % 1;
        ring(f.x, f.y, (f.r + 10 + u * 70) * cam.zoom, 0.38 * (1 - u));
      }
    }

    // a dragged food near the edge: the edge it would sink through lights up
    if (input.edge > 0.01) {
      const a = 0.15 + 0.6 * input.edge;
      const s = input.edgeSide;
      const m = 6;
      this.engrave(() => {
        if (s === 'left') {
          c.moveTo(m, this.h * 0.2);
          c.lineTo(m, this.h * 0.8);
        } else if (s === 'right') {
          c.moveTo(this.w - m, this.h * 0.2);
          c.lineTo(this.w - m, this.h * 0.8);
        } else if (s === 'top') {
          c.moveTo(this.w * 0.2, m);
          c.lineTo(this.w * 0.8, m);
        } else {
          c.moveTo(this.w * 0.2, this.h - m);
          c.lineTo(this.w * 0.8, this.h - m);
        }
      }, a, 1.5);
    }

    // the knife's mark fades after a cut
    for (const k of input.cuts) {
      const age = t - k.t0;
      if (age > 0.9 || k.points.length < 2) continue;
      this.engrave(() => {
        k.points.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
      }, 0.75 * (1 - age / 0.9), 1.25);
    }

    // the crosshair: a body, not an arrow
    if (input.present || input.keyboard) {
      const { x, y } = input.aim;
      const press = input.pressing ? 1 : 0;
      const gap = 5 - press * 2;
      const len = 9 - press * 2;
      const a = input.keyboard && !input.present ? 0.85 : 0.7;
      this.engrave(() => {
        c.moveTo(x - gap - len, y);
        c.lineTo(x - gap, y);
        c.moveTo(x + gap, y);
        c.lineTo(x + gap + len, y);
        c.moveTo(x, y - gap - len);
        c.lineTo(x, y - gap);
        c.moveTo(x, y + gap);
        c.lineTo(x, y + gap + len);
      }, a);
      // when still, the reach the colony can feel
      if (input.still > 0.01 && !input.gesture) {
        this.engrave(() => c.arc(x, y, input.reachPx, 0, Math.PI * 2), 0.14 * input.still);
      }
    }

    this.overlay?.(c, (path, alpha, width) => this.engrave(path, alpha, width));
  }
}
