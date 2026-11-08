// The landing page's director: it plays each chapter's scene on the simulated colony, says where that chapter's
// label is pinned, and what the scene will cover before it is over, so the label can keep clear of all of it.
// One question carries the scenes from foraging to quorum; a chapter visited out of order sets up whatever its
// scene needs first.
import type { App } from '../app';
import type { Glass } from '../glass/glass';
import type { Input } from '../input/input';
import type { SimulatedRuntime } from '../runtime/simulated';
import { sizeOf } from '../runtime/writing';
import { COLONY } from '../world/colony';
import { foodRadius, type Food } from '../world/foods';
import { STORIES, type Anchor } from './chapters';
import type { Shape } from './clearance';

// where a label is pinned, on the screen: a point, how far around it to keep clear, and how to mark it
export interface Pin {
  x: number;
  y: number;
  r: number;
  ring: 'circle' | 'pile' | 'dot' | 'none';
}

// the part of the screen where scenes happen, clear of the chapter list and of a docked label;
// typed words end before textRight
export interface Stage {
  left: number;
  top: number;
  right: number;
  bottom: number;
  textRight: number;
}

type Story = (typeof STORIES)[number];
type Rect = [number, number, number, number];

const TYPE_GAP = 0.045; // seconds between letters as a question types itself
const LINGER = 0.7; // seconds a typed question waits before it drops
const FRESH = 12; // seconds a question is still being foraged, so a return to that chapter finds it as it was

// how many agents a question draws in the end, as the simulation staffs it
const crowd = (size: number, priority: number) => Math.round((30 + 50 * size) * (0.6 + 0.4 * priority));
// how far from a droplet's middle that crowd feeds, its light included
const feeding = (size: number, workers: number) => foodRadius(size) + 18 + Math.sqrt(Math.max(1, workers)) * 5.5 + 12;

export class Director {
  stage: Stage = { left: 0, top: 0, right: 0, bottom: 0, textRight: 0 };
  private chapter = '';
  private story: string | null = null; // the objective the scenes follow
  private tale: Story = STORIES[0];
  private storyAt = -Infinity;
  private beside: string | null = null;
  private besideAt: [number, number] | null = null; // where the related question will land
  private told = 0;
  private typing: (Story & { x: number; y: number; t0: number; first: boolean }) | null = null;
  private beats: { at: number; run: () => void }[] = [];
  private holding = false;
  private clock = 0;
  private dt = 0;
  private trail = { food: -1, at: -Infinity, x: 0, y: 0, tx: 0, ty: 0 };
  private ruler: HTMLElement;

  constructor(
    private app: App,
    private sim: SimulatedRuntime,
    private input: Input,
    private glass: Glass,
  ) {
    // words are measured as the glass sets them, so a scene knows how much room its typing takes
    this.ruler = document.createElement('div');
    this.ruler.className = 'draft';
    this.ruler.setAttribute('aria-hidden', 'true');
    document.getElementById('glass')!.append(this.ruler);
  }

  enter(chapter: string): void {
    this.chapter = chapter;
    this.beats = [];
    this.besideAt = null;
    this.press(false);
    this.dropNow();
    if (chapter === 'forage') this.forage();
    else if (chapter === 'trails') this.trails();
    else if (chapter === 'recruit') this.recruit();
    else if (chapter === 'midden') this.midden();
    else if (chapter === 'quorum') this.quorum();
  }

  update(dt: number): void {
    this.clock += dt;
    this.dt = dt;
    const due = this.beats.filter(b => b.at <= this.clock);
    if (due.length) {
      this.beats = this.beats.filter(b => b.at > this.clock);
      for (const b of due) b.run();
    }
    const t = this.typing;
    if (t) {
      const reduced = this.app.reduced.matches;
      const n = reduced ? t.ask.length : Math.floor((this.clock - t.t0) / TYPE_GAP);
      const [sx, sy] = this.app.camera.toScreen(t.x, t.y);
      this.input.aim = { x: sx, y: sy };
      this.input.draft = t.ask.slice(0, n);
      if (this.clock - t.t0 > (reduced ? 0 : t.ask.length * TYPE_GAP) + LINGER) this.dropNow();
    }
    // the scene's hand stays on the droplet as it drifts
    const f = this.storyFood();
    if (this.holding && f) [this.input.aim.x, this.input.aim.y] = this.app.camera.toScreen(f.x, f.y);
  }

  pin(anchor: Anchor): Pin {
    const C = this.app.colony;
    const cam = this.app.camera;
    const at = (x: number, y: number, r: number, ring: Pin['ring']): Pin => {
      const [sx, sy] = cam.toScreen(x, y);
      return { x: sx, y: sy, r: r * cam.zoom, ring };
    };
    if (anchor === 'nest') return at(C.nest.x, C.nest.y, C.nest.r + 6, 'circle');
    if (anchor === 'midden') return at(C.midden.x, C.midden.y - C.midden.r * 0.35, C.midden.r * 1.15, 'pile');
    // just under the hint at the top of the glass
    if (anchor === 'hint') return { x: this.app.w / 2, y: 50, r: 4, ring: 'none' };
    const t = this.typing;
    if (anchor === 'story' && t) return at(t.x, t.y, 24, 'circle');
    const f = this.storyFood();
    if (!f) return this.pin('nest');
    if (anchor === 'trail') {
      const [x, y] = this.trailPoint(f);
      return at(x, y, 4, 'dot');
    }
    // a finished droplet leaves its answer where it was
    return f.status === 'active' ? at(f.x, f.y, Math.max(f.r, 10) + 8, 'circle') : at(f.x, f.y, 10, 'none');
  }

  // what the scene will cover before it is over, in world units: the nest, every question still being worked
  // on with the crowd it will draw and the lanes to it, the words being typed, and what this chapter adds
  footprint(): Shape[] {
    const C = this.app.colony;
    const N = C.nest;
    const out: Shape[] = [];
    const circle = (x: number, y: number, r: number) => out.push({ kind: 'circle', x, y, r });
    // a stream between two places: the farther it runs, the wider it wanders
    const lane = (x0: number, y0: number, x1: number, y1: number, r: number, spread = 0.1) =>
      out.push({ kind: 'lane', x0, y0, x1, y1, r: r + spread * Math.hypot(x1 - x0, y1 - y0) });
    const box = ([x, y, w, h]: Rect) => out.push({ kind: 'box', x, y, w, h });
    const feed = (x: number, y: number, size: number, workers: number) => {
      circle(x, y, feeding(size, workers));
      lane(N.x, N.y, x, y, 30);
    };
    // words typed beside where they land, and the way they dissolve into the droplet
    const words = (text: string, x: number, y: number) => {
      const b = this.typedBox(text, x, y);
      box(b);
      lane(b[0] + b[2] / 2, b[1] + b[3] / 2, x, y, 14, 0);
    };

    circle(N.x, N.y, N.r + 40);
    const story = this.storyFood();
    for (const f of C.foods) {
      if (f.status !== 'active') continue;
      // the press in this chapter raises the story's food as high as it goes
      const priority = f === story && this.chapter === 'recruit' ? 4 : f.priority;
      feed(f.x, f.y, f.size, Math.max(f.workers, crowd(f.size, priority)));
    }
    const t = this.typing;
    if (t) {
      const size = sizeOf(t.ask);
      feed(t.x, t.y, size, crowd(size, 1));
      words(t.ask, t.x, t.y);
    }
    const live = story?.status === 'active' ? story : null;
    const besideF = this.besideFood();
    const planned = this.chapter === 'trails' && !besideF ? this.besideAt : null;
    if (planned) {
      const size = sizeOf(this.tale.beside);
      feed(planned[0], planned[1], size, crowd(size, 1));
      words(this.tale.beside, planned[0], planned[1]);
    }
    // related questions trade context, and the undecided zigzag between them
    const other = besideF ? [besideF.x, besideF.y] : planned;
    if (live && other) lane(live.x, live.y, other[0], other[1], 24, 0.08);
    // a husk's flight from the trouble to the midden
    if (live && this.chapter === 'midden') lane(live.x, live.y, C.midden.x, C.midden.y, 34, 0);
    if (live && this.chapter === 'quorum') {
      // the answer is written above the droplet, then sinks into the depth layer beneath it
      box([live.x - 180, live.y - 22 - 80, 360, 80]);
      box([live.x - 250, live.y + 4, 500, 76]);
    }
    return out;
  }

  // ---------- the scenes ----------

  private forage(): void {
    // a question still being foraged is this scene already; an older one gives way to a new question
    const f = this.storyFood();
    if (f?.status === 'active' && this.clock - this.storyAt < FRESH) return;
    this.ask(true);
  }

  private trails(): void {
    const id = this.ensure();
    if (!id) return;
    this.sim.hasten(id, 'build');
    this.muster(id, 30);
    const f = this.storyFood();
    if (f && !this.besideFood()) {
      // decided now, so the label knows where it will land
      this.besideAt = this.near(f);
      this.after(2.5, () => this.askBeside());
    }
  }

  private recruit(): void {
    const id = this.ensure();
    if (!id) return;
    this.sim.hasten(id, 'build');
    this.muster(id, 20);
    this.after(0.9, () => this.press(true));
    this.after(5.4, () => this.press(false));
  }

  private midden(): void {
    const id = this.ensure();
    if (!id) return;
    this.sim.hasten(id, 'build');
    // agents just sent out reach the droplet before the trouble starts
    const wait = this.muster(id, 14) ? 2.6 : 1.2;
    this.after(wait, () => this.sim.trouble(id, 6, 1, 5));
  }

  private quorum(): void {
    const id = this.ensure();
    if (!id) return;
    const wait = this.muster(id, 12) ? 2.2 : 0.6;
    this.after(wait, () => this.sim.hasten(id, 'decide', { dissent: true }));
  }

  // ---------- the question the scenes follow ----------

  private storyFood(): Food | undefined {
    return this.story ? this.app.colony.foods.find(f => f.id === this.story) : undefined;
  }

  private besideFood(): Food | undefined {
    const f = this.beside ? this.app.colony.foods.find(g => g.id === this.beside) : undefined;
    return f?.status === 'active' ? f : undefined;
  }

  // the story's objective, asking a new question at once if there is none still being worked on
  private ensure(): string | null {
    if (this.storyFood()?.status !== 'active') this.ask(false);
    return this.storyFood()?.status === 'active' ? this.story : null;
  }

  // a typed question types itself beside where it will land, then dissolves into a droplet there
  private ask(typed: boolean): void {
    const tale = STORIES[this.told++ % STORIES.length];
    const [x, y] = this.spot(tale.ask);
    if (!typed) {
      this.land(tale, x, y);
      return;
    }
    this.glass.draftLeft = this.typedLeft(x, this.measure(tale.ask).w);
    // the help under a first drop belongs to the visitor's own first drop
    this.typing = { ...tale, x, y, t0: this.clock, first: !this.input.droppedOnce };
    this.input.droppedOnce = true;
  }

  private dropNow(): void {
    const t = this.typing;
    if (!t) return;
    this.land(t, t.x, t.y);
    this.input.draft = '';
    this.input.droppedOnce = !t.first;
    this.glass.draftLeft = false;
    this.typing = null;
  }

  private land(tale: Story, x: number, y: number): void {
    const cam = this.app.camera;
    const [sx, sy] = cam.toScreen(x, y);
    // the words dissolve from where they were typed, or from beside the droplet when nothing was
    const box = this.typedBox(tale.ask, x, y);
    const [bx, by] = cam.toScreen(box[0], box[1]);
    const from = this.typing && this.input.draft ? this.glass.draftAt : { x: bx, y: by };
    this.story = this.sim.plant(tale.ask, x, y, tale.finding);
    this.tale = tale;
    this.storyAt = this.clock;
    this.beside = null;
    this.glass.dissolve(tale.ask, from.x, from.y, sx, sy);
  }

  private askBeside(): void {
    const f = this.storyFood();
    const at = this.besideAt;
    if (!f || f.status !== 'active' || this.besideFood() || !at) return;
    const cam = this.app.camera;
    const [x, y] = at;
    const [sx, sy] = cam.toScreen(x, y);
    const [bx, by] = this.typedBox(this.tale.beside, x, y);
    const [fx, fy] = cam.toScreen(bx, by);
    this.beside = this.sim.plant(this.tale.beside, x, y);
    this.glass.dissolve(this.tale.beside, fx, fy, sx, sy);
  }

  // sends agents straight out until the team is at least n strong; says whether any had to go
  private muster(id: string, n: number): boolean {
    const f = this.storyFood();
    const short = n - (f?.workers ?? 0);
    if (short > 0) this.sim.muster(id, short);
    return short > 0;
  }

  // the scene's hand: a press held on the droplet, as a visitor enriches food
  private press(on: boolean): void {
    const f = this.storyFood();
    this.holding = on && f?.status === 'active';
    this.input.hold(this.holding ? f! : null);
    this.input.pressing = this.holding;
  }

  private after(seconds: number, run: () => void): void {
    this.beats.push({ at: this.clock + seconds, run });
  }

  // ---------- words ----------

  // the size of words as the glass types them, caret included
  private measure(text: string): { w: number; h: number } {
    this.ruler.textContent = text;
    return { w: this.ruler.offsetWidth + 4, h: this.ruler.offsetHeight };
  }

  // typed words go on the side of their droplet away from the nest, unless only the other side has room
  private typedLeft(x: number, w: number): boolean {
    const fitsLeft = x - 18 - w >= 16;
    const fitsRight = x + 18 + w <= this.stage.textRight;
    return x < this.app.colony.nest.x ? fitsLeft || !fitsRight : !fitsRight && fitsLeft;
  }

  // where words typed for a droplet at x, y sit, as the glass places them
  private typedBox(text: string, x: number, y: number): Rect {
    const { w, h } = this.measure(text);
    const bx = this.typedLeft(x, w) ? x - 18 - w : x + 18;
    const by = y + 14 + h > this.app.h - 16 ? y - 14 - h : y + 14;
    return [Math.max(16, bx), Math.max(16, by), w, h];
  }

  // ---------- places ----------

  // where a scene's question lands: beside the nest, clear of the food there and of the page's furniture,
  // with room for its words to be typed
  private spot(text: string): [number, number] {
    const C = this.app.colony;
    const { w, h } = this.app;
    const tw = this.measure(text).w;
    const tries: [number, number][] =
      w >= h
        ? [[-0.24, -0.2], [-0.24, 0.2], [0.21, -0.2], [0.21, 0.2], [-0.04, -0.33], [-0.04, 0.32]]
        : [[0.16, -0.22], [-0.16, -0.22], [0.16, -0.36], [-0.16, -0.36]];
    let best: [number, number] = [C.nest.x, C.nest.y];
    let bestRoom = -Infinity;
    for (const [fx, fy] of tries) {
      const [x, y] = this.onStage(C.nest.x + fx * w, C.nest.y + fy * h);
      const fits = this.typedLeft(x, tw) ? x - 18 - tw >= 16 : x + 18 + tw <= this.stage.textRight;
      const room = Math.min(this.room(x, y), Math.hypot(x - C.nest.x, y - C.nest.y) - C.nest.r - 80) - (fits ? 0 : 400);
      if (room > 40) return [x, y];
      if (room > bestRoom) {
        bestRoom = room;
        best = [x, y];
      }
    }
    return best;
  }

  // beside the story's droplet: close enough to be related, clear of the nest, the midden and other food
  private near(f: Food): [number, number] {
    const C = this.app.colony;
    const d = 0.24 * Math.min(this.app.w, this.app.h);
    const away = Math.atan2(f.y - C.nest.y, f.x - C.nest.x);
    let best: [number, number] = this.onStage(f.x, f.y + d);
    let bestRoom = -Infinity;
    for (const turn of [1.6, -1.6, 2.2, -2.2, 0.9, -0.9]) {
      const [x, y] = this.onStage(f.x + Math.cos(away + turn) * d, f.y + Math.sin(away + turn) * d);
      const room = Math.min(
        this.room(x, y, f),
        Math.hypot(x - C.nest.x, y - C.nest.y) - C.nest.r - 80,
        Math.hypot(x - C.midden.x, y - C.midden.y) - 140,
      );
      if (room > 30) return [x, y];
      if (room > bestRoom) {
        bestRoom = room;
        best = [x, y];
      }
    }
    return best;
  }

  private onStage(x: number, y: number): [number, number] {
    const S = this.stage;
    return [Math.min(S.right, Math.max(S.left, x)), Math.min(S.bottom, Math.max(S.top, y))];
  }

  // how far a point is from the nearest food still there, or finished lately and showing its answer
  private room(x: number, y: number, skip?: Food): number {
    const C = this.app.colony;
    let room = Infinity;
    for (const f of C.foods) {
      if (f === skip || (f.status !== 'active' && !(f.status === 'completed' && C.time - f.doneAt < 90))) continue;
      room = Math.min(room, Math.hypot(f.x - x, f.y - y) - f.r0 - 70);
    }
    return room;
  }

  // the brightest stretch of vein between the nest and the story's droplet, followed as it wears in
  private trailPoint(f: Food): [number, number] {
    const T = this.trail;
    if (T.food !== f.index || this.clock - T.at > 0.6) {
      const C = this.app.colony;
      const dx = f.x - C.nest.x;
      const dy = f.y - C.nest.y;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len;
      const ny = dx / len;
      let best = -1;
      T.tx = C.nest.x + dx / 2;
      T.ty = C.nest.y + dy / 2;
      for (let s = 0.35; s <= 0.651; s += 0.05) {
        for (let k = -6; k <= 6; k++) {
          const x = C.nest.x + dx * s + nx * k * 7;
          const y = C.nest.y + dy * s + ny * k * 7;
          const v = C.field.sample(COLONY, x, y) * (1 - Math.abs(k) / 14);
          if (v > best) {
            best = v;
            T.tx = x;
            T.ty = y;
          }
        }
      }
      if (T.food !== f.index) [T.x, T.y] = [T.tx, T.ty];
      T.food = f.index;
      T.at = this.clock;
    }
    const k = 1 - Math.exp(-this.dt / 0.5);
    T.x += (T.tx - T.x) * k;
    T.y += (T.ty - T.y) * k;
    return [T.x, T.y];
  }
}
