// The lens. World units are CSS pixels of the unmagnified view, so at zoom 1 the world is the window.
const MIN = 1;
const MAX = 6;

export class Camera {
  zoom = 1;
  cx: number;
  cy: number;
  private targetZoom = 1;
  private anchor: { sx: number; sy: number; wx: number; wy: number } | null = null;

  constructor(
    public viewW: number,
    public viewH: number,
  ) {
    this.cx = viewW / 2;
    this.cy = viewH / 2;
  }

  get settled(): boolean {
    return Math.abs(this.zoom - this.targetZoom) < 1e-3;
  }

  get target(): number {
    return this.targetZoom;
  }

  // the world follows the window; positions are remapped by the caller
  resize(w: number, h: number): void {
    if (!(w >= 1 && h >= 1)) return; // nothing to show: keep the last view
    const kx = w / this.viewW;
    const ky = h / this.viewH;
    this.viewW = w;
    this.viewH = h;
    this.cx *= kx;
    this.cy *= ky;
    this.anchor = null;
    this.clamp();
  }

  toWorld(sx: number, sy: number): [number, number] {
    return [this.cx + (sx - this.viewW / 2) / this.zoom, this.cy + (sy - this.viewH / 2) / this.zoom];
  }

  toScreen(wx: number, wy: number): [number, number] {
    return [(wx - this.cx) * this.zoom + this.viewW / 2, (wy - this.cy) * this.zoom + this.viewH / 2];
  }

  // magnify by factor about a screen point; that point keeps showing the same place in the world
  zoomAt(sx: number, sy: number, factor: number): void {
    const [wx, wy] = this.toWorld(sx, sy);
    this.anchor = { sx, sy, wx, wy };
    this.targetZoom = Math.min(MAX, Math.max(MIN, this.targetZoom * factor));
  }

  pan(dsx: number, dsy: number): void {
    this.anchor = null;
    this.cx -= dsx / this.zoom;
    this.cy -= dsy / this.zoom;
    this.clamp();
  }

  step(dt: number): void {
    const k = 1 - Math.exp(-dt / 0.11);
    this.zoom += (this.targetZoom - this.zoom) * k;
    if (Math.abs(this.zoom - this.targetZoom) < 1e-4) this.zoom = this.targetZoom;
    if (this.anchor) {
      const { sx, sy, wx, wy } = this.anchor;
      this.cx = wx - (sx - this.viewW / 2) / this.zoom;
      this.cy = wy - (sy - this.viewH / 2) / this.zoom;
      if (this.zoom === this.targetZoom) this.anchor = null;
    }
    this.clamp();
  }

  // the view never leaves the world
  private clamp(): void {
    const hw = this.viewW / (2 * this.zoom);
    const hh = this.viewH / (2 * this.zoom);
    this.cx = Math.min(this.viewW - hw, Math.max(hw, this.cx));
    this.cy = Math.min(this.viewH - hh, Math.max(hh, this.cy));
  }
}
