// Wires the runtime, the colony, the lens and the hands together, and keeps time.
import type { Runtime } from './runtime/protocol';
import { RemoteRuntime } from './runtime/remote';
import { SimulatedRuntime, type Scenario } from './runtime/simulated';
import { OPENING, wearInTrails } from './scenario';
import { Renderer } from './render/renderer';
import { Camera } from './world/camera';
import { Colony, NO_POINTER } from './world/colony';
import { MIN_WORLD, resizeWorld } from './world/resize';

const PREWARM = 9; // seconds the colony runs before anyone looks

// ?colony=N runs a bigger or smaller simulated colony, for stress tests; helpers stay within the world's 1,600 bodies
export function colonySize(search: string, fallback = 700): number {
  const n = Number(new URLSearchParams(search).get('colony'));
  return Number.isFinite(n) && n > 0 ? Math.round(Math.min(1100, Math.max(50, n))) : fallback;
}

// /live (or the older ?live) watches real agents from the live colony's server instead of the simulation
export function isLive(search: string, path = '/'): boolean {
  return path.replace(/\/+$/, '') === '/live' || new URLSearchParams(search).has('live');
}

export interface AppOptions {
  live: boolean;
  // the scene a simulated colony opens on
  opening?: Scenario;
  // whether the simulation feeds itself the scene's backlog of objectives
  backlog?: boolean;
  // how many agents a simulated colony has, when the address does not say
  colony?: number;
}

// the opening: the lens racks into focus over the first second; with reduced motion it is simply sharp
export function openingDefocus(clock: number, reduced: boolean): number {
  if (reduced) return 0;
  return Math.pow(1 - Math.min(1, clock / 1.1), 3);
}

export class App {
  readonly runtime: Runtime;
  // the simulation itself, when the agents are simulated: the landing page stages its scenes on it
  readonly sim: SimulatedRuntime | null;
  readonly colony: Colony;
  readonly camera: Camera;
  readonly renderer: Renderer;
  readonly reduced = matchMedia('(prefers-reduced-motion: reduce)');
  w = 0;
  h = 0;
  scale = 1;
  // time
  clock = 0; // real seconds since the focus pull began
  worldTime = 0;
  timeScale = 1;
  frozen = false;
  exposure = 0;
  live = 1;
  private stillRefreshAt = 0;
  private last = 0;
  private frames: number[] = [];
  private onFrame: ((dt: number) => void)[] = [];

  constructor(
    readonly canvas: HTMLCanvasElement,
    opts: AppOptions,
  ) {
    // a frame hidden at start reports no size: begin at a usual one, and follow the window once it shows
    this.w = innerWidth >= MIN_WORLD ? innerWidth : 1280;
    this.h = innerHeight >= MIN_WORLD ? innerHeight : 800;
    const sim = opts.live ? null : new SimulatedRuntime({ seed: 26, world: { w: this.w, h: this.h }, colony: colonySize(location.search, opts.colony), backlog: opts.backlog });
    this.sim = sim;
    this.runtime = sim ?? new RemoteRuntime();
    this.colony = new Colony({ w: this.w, h: this.h, seed: 10 });
    // a live colony's answers open in a tab of their own, so none is left on the world
    if (!sim) this.colony.keepFindings = false;
    this.runtime.on(e => this.colony.handle(e));
    this.camera = new Camera(this.w, this.h);
    this.renderer = new Renderer(canvas);
    this.scale = Math.min(devicePixelRatio || 1, 1.5);
    this.renderer.resize(this.w, this.h, this.scale, this.w, this.h, true);
    // the simulation opens on a scene already in motion; a live colony starts from what the agents are doing
    if (sim) sim.seed(opts.opening ?? OPENING);
    else this.runtime.send({ type: 'world.resize', w: this.w, h: this.h });
    canvas.addEventListener('webglcontextrestored', () => this.renderer.restore(this.colony));
    addEventListener('resize', () => this.resize());
  }

  get world(): { w: number; h: number } {
    return { w: this.w, h: this.h };
  }

  every(fn: (dt: number) => void): void {
    this.onFrame.push(fn);
  }

  // let the colony live for a few seconds so the first thing anyone sees is already in motion
  prewarm(): void {
    wearInTrails(this.colony, 3);
    const dt = 1 / 30;
    for (let t = 0; t < PREWARM; t += dt) {
      this.runtime.tick(dt);
      this.colony.step(dt);
      this.renderer.stepField(this.colony, dt);
      this.worldTime += dt;
    }
  }

  start(): void {
    this.last = performance.now();
    requestAnimationFrame(t => this.frame(t));
  }

  private resize(): void {
    if (resizeWorld(this, innerWidth, innerHeight)) this.renderer.resize(this.w, this.h, this.scale, this.w, this.h);
  }

  freeze(on: boolean): void {
    if (on === this.frozen) return;
    this.frozen = on;
    if (on) this.renderer.buildExposure(this.colony);
  }

  private frame(now: number): void {
    const real = Math.min(0.05, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    this.clock += real;
    this.adapt(real);

    // time slows to a stop when frozen, and eases back
    const want = this.frozen ? 0 : 1;
    this.timeScale += (want - this.timeScale) * (1 - Math.exp(-real / 0.12));
    if (this.timeScale < 0.002) this.timeScale = 0;
    const dt = real * this.timeScale;
    const reduced = this.reduced.matches;
    const showExposure = this.frozen || reduced ? 1 : 0;
    this.exposure += (showExposure - this.exposure) * (1 - Math.exp(-real / 0.25));
    const showLive = reduced ? 0 : 1;
    this.live += (showLive - this.live) * (1 - Math.exp(-real / 0.3));

    if (reduced && !this.frozen && this.clock > this.stillRefreshAt) {
      // reduced motion: a still long exposure that refreshes every few seconds
      this.stillRefreshAt = this.clock + 4;
      this.renderer.buildExposure(this.colony);
    }

    this.camera.step(real);
    for (const fn of this.onFrame) fn(real);
    if (dt > 0) {
      this.runtime.tick(dt);
      this.colony.step(dt);
      this.worldTime += dt;
    }

    const defocus = openingDefocus(this.clock, reduced);
    const zoomBlur = Math.min(1, Math.max(0, (this.camera.zoom - 1.05) / 1.6));
    const focus = this.focusPoint();
    this.renderer.render({
      colony: this.colony,
      camera: this.camera,
      // with reduced motion the shaders' own movement holds still between refreshes too
      time: reduced ? Math.floor(this.worldTime / 4) * 4 : this.worldTime,
      dt,
      exposure: this.exposure,
      live: this.live,
      focus: { x: focus[0], y: focus[1], radius: 0.36 / Math.pow(this.camera.zoom, 0.55), amount: zoomBlur * 0.95 },
      defocus,
      hand: this.hand,
      hoverFood: this.hoverFood,
      pulse: reduced ? 0 : 1,
      reduced,
    });
    requestAnimationFrame(t => this.frame(t));
  }

  // set by the input layer
  focusPoint: () => [number, number] = () => [this.w / 2, this.h / 2];
  hand = { x: 0, y: 0, reach: 0, pressure: 0 };
  hoverFood = -1;

  // dynamic resolution: if frames run long, draw fewer pixels
  private adapt(real: number): void {
    this.frames.push(real);
    if (this.frames.length < 90) return;
    const avg = this.frames.reduce((s, x) => s + x, 0) / this.frames.length;
    this.frames.length = 0;
    const max = Math.min(devicePixelRatio || 1, 1.5);
    let next = this.scale;
    if (avg > 1 / 45) next = Math.max(0.6, this.scale - 0.15);
    else if (avg < 1 / 58 && this.scale < max) next = Math.min(max, this.scale + 0.1);
    if (next !== this.scale) {
      this.scale = next;
      this.renderer.resize(this.w, this.h, this.scale, this.w, this.h);
    }
  }
}

export { NO_POINTER };
