// The hands: pointer, wheel and keys become gestures, gestures become runtime commands.
// Hovering never changes anyone's work; pressing does.
import type { App } from '../app';
import type { Glass } from '../glass/glass';
import { Mode } from '../world/agents';
import { depthAlpha, depthCenter, type Finding } from '../world/colony';
import type { Food } from '../world/foods';
import { classifyDrag, cutFrees, HOLD, type DragKind, type PressTarget, type Sample } from './gestures';
import { UndoStack } from './undo';

export interface Hover {
  kind: 'none' | 'food' | 'nest' | 'midden' | 'vein' | 'depth';
  food?: Food;
  finding?: Finding;
  vein?: { what: string; from: string; to: string };
}

const REACH = 42; // the hand's reach on screen, px
const EDGE = 14; // releasing a dragged food this close to the window's edge abandons it
const WORKING = new Set<number>([Mode.Work, Mode.Seek, Mode.Back, Mode.Home, Mode.Peer, Mode.Doubt]);

interface Press {
  samples: Sample[];
  target: PressTarget;
  food: Food | null;
  slots: number[];
  t0: number;
  wx: number;
  wy: number;
  from: Place | null;
  enrichTotal: number;
  nextEnrichAt: number;
  stroke: [number, number][];
  screenStroke: [number, number][];
  prev: Map<string, string | null>;
  touch: boolean;
}

// a place in the world kept as fractions of its size, so undo still means the same spot after the window changes
interface Place {
  fx: number;
  fy: number;
}

type KeyGrab = { kind: 'food'; food: Food; from: Place } | { kind: 'lead'; prev: Map<string, string | null> };
// staged: a landing page scene pressing on the food, which leaves nothing to undo
type KeyEnrich = { food: Food; total: number; next: number; staged?: boolean };

const now = () => performance.now() / 1000;

export class Input {
  aim = { x: 0, y: 0 };
  present = false;
  keyboard = false;
  pressing = false;
  still = 0;
  draft = '';
  droppedOnce = false;
  hover: Hover = { kind: 'none' };
  selected: Food | null = null;
  gesture: DragKind | null = null;
  enriching: Food | null = null;
  edge = 0;
  edgeSide: 'left' | 'right' | 'top' | 'bottom' = 'bottom';
  cuts: { points: [number, number][]; t0: number }[] = [];
  reachPx = REACH;
  // off while the landing page's chapters play their scenes; the colony is the visitor's in the last one
  enabled = true;
  readonly undo = new UndoStack();
  private glass!: Glass;
  private vel = { x: 0, y: 0 };
  private last = { x: 0, y: 0, t: 0 };
  private stillSince = 0;
  private press: Press | null = null;
  private grab: KeyGrab | null = null;
  private keyEnrich: KeyEnrich | null = null;
  private mouse = { x: NaN, y: NaN };
  private lastEdit = -Infinity; // when the draft last changed, in seconds
  // typing goes through a real text field in a form, so input methods, screen readers and
  // on-screen keyboards all work; the form's submit is the drop
  private field = document.getElementById('draft') as HTMLInputElement;
  private form = document.getElementById('draft-form') as HTMLFormElement;
  // on a touch screen the keyboard opens only when someone taps to type
  private touchLast = false;
  private touches = new Map<number, { x: number; y: number }>();
  private pinch: { d: number; mx: number; my: number } | null = null;

  constructor(
    private app: App,
    private stage: HTMLElement,
  ) {
    this.field.addEventListener('input', () => {
      if (!this.enabled) {
        this.field.value = '';
        return;
      }
      let v = this.field.value.replace(/^\s+/, '');
      if (v !== this.field.value) this.field.value = v;
      this.draft = v;
      this.lastEdit = now();
      if (v) this.glass.hideHint();
    });
    this.form.addEventListener('submit', e => {
      e.preventDefault();
      if (this.enabled && !this.app.frozen) this.drop();
    });
    // focus is never taken back automatically: the first key typed moves into the field instead,
    // so the page can never fight the browser or a host app for the keyboard
    stage.addEventListener('pointermove', e => this.enabled && this.move(e));
    stage.addEventListener('pointerdown', e => this.enabled && this.down(e));
    stage.addEventListener('pointerup', e => this.enabled && this.up(e, false));
    stage.addEventListener('pointercancel', e => this.enabled && this.up(e, true));
    // losing the pointer mid-gesture (the window lost focus, the system took it) ends it without effect
    stage.addEventListener('lostpointercapture', () => {
      if (this.press) this.finish(this.aim.x, this.aim.y, true);
    });
    stage.addEventListener('pointerleave', () => {
      if (!this.press) this.present = false;
    });
    stage.addEventListener('wheel', e => this.enabled && this.wheel(e), { passive: false });
    addEventListener('keydown', e => this.enabled && this.keydown(e));
    addEventListener('keyup', e => this.enabled && this.keyup(e));
    addEventListener('blur', () => {
      this.app.freeze(false);
      this.stopKeyEnrich();
      if (this.press) this.finish(this.aim.x, this.aim.y, true);
    });
    this.aim = { x: app.w / 2, y: app.h / 2 };
  }

  attach(glass: Glass): void {
    this.glass = glass;
  }

  // switched off, the hands let go of whatever they held and the colony feels no one
  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    if (on) return;
    if (this.press) this.finish(this.aim.x, this.aim.y, true);
    this.cancelGrab();
    this.stopKeyEnrich();
    this.setDraft('');
    this.field.blur();
    this.app.freeze(false);
    this.glass.setLegend(false);
    this.app.camera.zoomAt(this.aim.x, this.aim.y, 1 / 99);
    this.selected = null;
    this.present = false;
    this.keyboard = false;
    this.pressing = false;
    this.touches.clear();
    this.pinch = null;
  }

  // a scene's hand on the food: it enriches as a held press does, and lets go with null
  hold(food: Food | null): void {
    const k = this.keyEnrich;
    if (k?.staged) {
      k.food.enriching = 0;
      this.enriching = null;
      this.keyEnrich = null;
    }
    if (!food || food.status !== 'active') return;
    this.keyEnrich = { food, total: 0, next: 0, staged: true };
    this.enriching = food;
    food.enriching = 1;
  }

  private focus(): void {
    if (document.activeElement !== this.field) this.field.focus({ preventScroll: true });
  }

  private setDraft(v: string): void {
    this.field.value = v;
    this.draft = v;
    this.lastEdit = now();
  }

  private place(x: number, y: number): Place {
    return { fx: x / this.app.w, fy: y / this.app.h };
  }

  private at(p: Place): [number, number] {
    return [p.fx * this.app.w, p.fy * this.app.h];
  }

  private world(x = this.aim.x, y = this.aim.y): [number, number] {
    return this.app.camera.toWorld(x, y);
  }

  private get colony() {
    return this.app.colony;
  }

  private send(cmd: Parameters<App['runtime']['send']>[0]): void {
    this.app.runtime.send(cmd);
  }

  private agentIds(slots: number[]): string[] {
    const A = this.colony.agents;
    return slots.map(s => A.id[s]).filter((x): x is string => !!x);
  }

  private foodIdOf(slot: number): string | null {
    const f = this.colony.agents.food[slot];
    return f >= 0 ? this.colony.foods[f].id : null;
  }

  // ---------- pointer ----------

  private move(e: PointerEvent): void {
    if (e.pointerType === 'touch' && this.touches.has(e.pointerId)) {
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pinch) {
        this.stepPinch();
        return;
      }
    }
    // browsers send moves to a resting mouse when the page under it changes; only real motion
    // takes the aim back from the keyboard
    if (e.clientX === this.mouse.x && e.clientY === this.mouse.y && !this.press) return;
    this.mouse = { x: e.clientX, y: e.clientY };
    const t = now();
    const dt = Math.max(1 / 240, t - this.last.t);
    const vx = (e.clientX - this.last.x) / dt;
    const vy = (e.clientY - this.last.y) / dt;
    const k = Math.min(1, dt / 0.05);
    this.vel.x += (vx - this.vel.x) * k;
    this.vel.y += (vy - this.vel.y) * k;
    if (Math.hypot(e.clientX - this.last.x, e.clientY - this.last.y) > 1.5) this.stillSince = t;
    this.last = { x: e.clientX, y: e.clientY, t };
    this.aim = { x: e.clientX, y: e.clientY };
    this.present = true;
    this.keyboard = false;
    if (this.press) this.drag(e.clientX, e.clientY, t);
  }

  private down(e: PointerEvent): void {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('.help')) return;
    // no emulated mouse follows, so nothing moves the keyboard off the text field behind our back
    e.preventDefault();
    const touch = e.pointerType === 'touch';
    this.touchLast = touch;
    if (touch) {
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.touches.size >= 2) {
        // a second finger turns whatever the first was doing into a pinch
        if (this.press) this.finish(this.aim.x, this.aim.y, true);
        this.startPinch();
        return;
      }
    } else this.focus();
    try {
      this.stage.setPointerCapture(e.pointerId);
    } catch {
      // a pointer the browser does not track (synthetic or already gone); the gesture still works
    }
    this.aim = { x: e.clientX, y: e.clientY };
    this.present = true;
    this.keyboard = false;
    this.pressing = true;
    const [wx, wy] = this.world();
    const zoom = this.app.camera.zoom;
    const food = this.colony.foodAt(wx, wy, 8 / zoom);
    const slots = food ? [] : this.colony.within(wx, wy, REACH / zoom, 80);
    this.press = {
      samples: [{ x: e.clientX, y: e.clientY, t: now() }],
      target: food ? 'food' : slots.length ? 'agents' : 'empty',
      food,
      slots,
      t0: now(),
      wx,
      wy,
      from: null,
      enrichTotal: 0,
      nextEnrichAt: 0,
      stroke: [[wx, wy]],
      screenStroke: [[e.clientX, e.clientY]],
      prev: new Map(),
      touch,
    };
    this.gesture = null;
  }

  private pinchShape(): { d: number; mx: number; my: number } {
    const [a, b] = [...this.touches.values()];
    return { d: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
  }

  private startPinch(): void {
    this.pinch = this.pinchShape();
    this.pressing = false;
  }

  // two fingers: spreading magnifies about their midpoint, moving together pans
  private stepPinch(): void {
    const prev = this.pinch!;
    const next = this.pinchShape();
    this.app.camera.pan(next.mx - prev.mx, next.my - prev.my);
    this.app.camera.zoomAt(next.mx, next.my, next.d / prev.d);
    this.aim = { x: next.mx, y: next.my };
    this.pinch = next;
  }

  private drag(x: number, y: number, t: number): void {
    const P = this.press!;
    const prev = P.samples[P.samples.length - 1];
    P.samples.push({ x, y, t });
    if (!this.gesture) {
      const kind = classifyDrag(P.samples, P.target, this.app.camera.zoom > 1.02, t);
      if (kind !== 'pending') this.begin(kind);
    }
    const [wx, wy] = this.world(x, y);
    // the whole path is kept, so a cut judged late still knows where the hand went
    P.stroke.push([wx, wy]);
    P.screenStroke.push([x, y]);
    switch (this.gesture) {
      case 'lead':
        this.colony.extendLead(wx, wy);
        break;
      case 'move': {
        const f = P.food!;
        f.tx = wx;
        f.ty = wy;
        this.measureEdge(x, y);
        break;
      }
      case 'pan':
        this.app.camera.pan(x - prev.x, y - prev.y);
        break;
      case 'doodle': {
        const [px, py] = this.world(prev.x, prev.y);
        this.colony.layScent(px, py, wx, wy);
        break;
      }
    }
  }

  private measureEdge(x: number, y: number): void {
    const { w, h } = this.app;
    const d = { left: x, right: w - x, top: y, bottom: h - y };
    let side: keyof typeof d = 'left';
    for (const k of Object.keys(d) as (keyof typeof d)[]) if (d[k] < d[side]) side = k;
    this.edgeSide = side;
    this.edge = Math.max(0, Math.min(1, 1 - (d[side] - EDGE) / 90));
  }

  private begin(kind: DragKind): void {
    const P = this.press!;
    // while time stands still, hands can look and pan but not change anyone's work
    if (this.app.frozen && kind !== 'pan') kind = 'doodle';
    this.gesture = kind;
    if (kind === 'lead') {
      for (const s of P.slots) P.prev.set(this.colony.agents.id[s]!, this.foodIdOf(s));
      this.colony.startLead(P.slots, P.wx, P.wy);
    } else if (kind === 'move') {
      const f = P.food!;
      P.from = this.place(f.tx, f.ty);
      f.dragged = true;
    } else if (kind === 'enrich') {
      this.enriching = P.food;
      P.food!.enriching = 1;
      P.nextEnrichAt = 0;
    }
  }

  private up(e: PointerEvent, cancelled: boolean): void {
    if (e.pointerType === 'touch') {
      this.touches.delete(e.pointerId);
      if (this.pinch) {
        // the pinch ends when a finger lifts; the other finger starts nothing
        if (this.touches.size < 2) this.pinch = null;
        if (!this.touches.size) this.present = false;
        return;
      }
    }
    this.finish(e.clientX, e.clientY, cancelled);
  }

  private finish(x: number, y: number, cancelled: boolean): void {
    const P = this.press;
    this.pressing = false;
    if (!P) return;
    this.press = null;
    // a flick can be over before it could be timed: judge it on what there is
    if (!this.gesture && !cancelled && P.target !== 'food' && P.samples.length > 1) {
      if (classifyDrag(P.samples, P.target, this.app.camera.zoom > 1.02, now(), true) === 'cut') this.begin('cut');
    }
    const kind = this.gesture;
    this.gesture = null;
    this.edge = 0;
    // a lifted finger no longer hovers
    if (P.touch) this.present = false;
    if (!kind) {
      if (cancelled) return;
      // a click picks food out and never changes work
      if (P.target === 'food' && now() - P.t0 < HOLD) this.selected = P.food;
      else {
        this.selected = null;
        // on a touch screen, a tap on open ground is where the words will go
        if (P.touch) {
          this.aim = { x, y };
          this.focus();
        }
      }
      return;
    }
    const [wx, wy] = this.world(x, y);
    if (kind === 'lead') this.endLead(wx, wy, P.prev, cancelled);
    else if (kind === 'cut' && !cancelled) this.cut(P.stroke, P.screenStroke);
    else if (kind === 'move') {
      if (cancelled) this.putBack(P.food!, P.from!);
      else this.putDown(P.food!, P.from!, this.nearEdge(x, y));
    } else if (kind === 'enrich') this.stopEnrich(P.food!, P.enrichTotal);
  }

  private nearEdge(x: number, y: number): boolean {
    return x < EDGE || y < EDGE || x > this.app.w - EDGE || y > this.app.h - EDGE;
  }

  private wheel(e: WheelEvent): void {
    e.preventDefault();
    this.aim = { x: e.clientX, y: e.clientY };
    // some mice report lines or pages instead of pixels
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.app.h : 1;
    const factor = Math.exp(-e.deltaY * unit * (e.ctrlKey ? 0.01 : 0.0016));
    this.app.camera.zoomAt(e.clientX, e.clientY, factor);
  }

  // ---------- what gestures do ----------

  private endLead(wx: number, wy: number, prev: Map<string, string | null>, cancelled = false): void {
    const C = this.colony;
    if (cancelled) {
      C.endLead({ kind: 'none' });
      return;
    }
    const slots = C.lead?.slots ?? [];
    const ids = this.agentIds(slots);
    const food = C.foodAt(wx, wy, 22);
    if (food && ids.length) {
      C.endLead({ kind: 'food', food: food.index });
      this.send({ type: 'agents.reassign', agents: ids, objective: food.id });
      this.remember(`Sent ${ids.length} agents back`, prev);
      this.glass.announce(`Led ${ids.length} ${ids.length === 1 ? 'agent' : 'agents'} to ${food.text}.`);
    } else if (C.inNest(wx, wy) && ids.length) {
      C.endLead({ kind: 'nest' });
      this.send({ type: 'agents.release', agents: ids });
      this.remember(`Sent ${ids.length} agents back to work`, prev);
      this.glass.announce(`Sent ${ids.length} ${ids.length === 1 ? 'agent' : 'agents'} to rest.`);
    } else {
      C.endLead({ kind: 'none' });
    }
  }

  // undo puts each agent back on the objective it had
  private remember(label: string, prev: Map<string, string | null>): void {
    this.undo.push({
      label,
      undo: () => {
        const back = new Map<string | null, string[]>();
        for (const [agent, obj] of prev) back.set(obj, [...(back.get(obj) ?? []), agent]);
        for (const [obj, agents] of back) {
          if (obj) this.send({ type: 'agents.reassign', agents, objective: obj });
          else this.send({ type: 'agents.release', agents });
        }
      },
    });
  }

  private cut(stroke: [number, number][], screen: [number, number][]): void {
    const C = this.colony;
    const A = C.agents;
    this.cuts.push({ points: screen, t0: this.app.clock });
    if (this.cuts.length > 6) this.cuts.shift();
    if (stroke.length < 2) return;
    const freed: number[] = [];
    for (let s = 0; s < A.count; s++) {
      if (!A.alive[s] || A.food[s] < 0 || !WORKING.has(A.mode[s])) continue;
      const f = C.foods[A.food[s]];
      if (cutFrees([A.x[s], A.y[s]], [f.x, f.y], stroke)) freed.push(s);
    }
    if (!freed.length) return;
    const prev = new Map<string, string | null>();
    const [ax, ay] = stroke[0];
    const [bx, by] = stroke[stroke.length - 1];
    const nx = -(by - ay);
    const ny = bx - ax;
    for (const s of freed) {
      prev.set(A.id[s]!, this.foodIdOf(s));
      const side = Math.sign((A.x[s] - ax) * nx + (A.y[s] - ay) * ny) || 1;
      C.scatter(s, nx * side, ny * side, 90);
    }
    this.send({ type: 'agents.release', agents: [...prev.keys()] });
    this.remember(`Put ${freed.length} agents back on their work`, prev);
    this.glass.announce(`Cut ${freed.length} ${freed.length === 1 ? 'agent' : 'agents'} loose.`);
  }

  private putDown(f: Food, from: Place, abandon: boolean): void {
    f.dragged = false;
    if (abandon) {
      this.send({ type: 'objective.abandon', objective: f.id });
      this.undo.push({
        label: `Restored ${f.text}`,
        undo: () => {
          const [x, y] = this.at(from);
          this.send({ type: 'objective.restore', objective: f.id });
          this.send({ type: 'objective.move', objective: f.id, x, y });
        },
      });
      this.glass.announce(`Abandoned ${f.text}. Command Z brings it back.`);
      if (this.selected === f) this.selected = null;
      return;
    }
    const x = Math.min(this.app.w - 20, Math.max(20, f.tx));
    const y = Math.min(this.app.h - 20, Math.max(20, f.ty));
    f.tx = x;
    f.ty = y;
    this.send({ type: 'objective.move', objective: f.id, x, y });
    this.undo.push({
      label: `Moved ${f.text} back`,
      undo: () => {
        const [bx, by] = this.at(from);
        this.send({ type: 'objective.move', objective: f.id, x: bx, y: by });
      },
    });
  }

  // a drag that was interrupted puts the food back where it was; nothing was asked of the colony
  private putBack(f: Food, from: Place): void {
    f.dragged = false;
    [f.tx, f.ty] = this.at(from);
  }

  private stopEnrich(f: Food, total: number): void {
    f.enriching = 0;
    this.enriching = null;
    if (total <= 0) return;
    this.undo.push({ label: `Took the enrichment off ${f.text}`, undo: () => this.send({ type: 'objective.enrich', objective: f.id, amount: -total }) });
    this.glass.announce(`Enriched ${f.text}.`);
  }

  private drop(): void {
    const text = this.draft.trim();
    this.setDraft('');
    if (!text) return;
    const { app } = this;
    let [x, y] = this.world();
    x = Math.min(app.w - 40, Math.max(40, x));
    y = Math.min(app.h - 40, Math.max(40, y));
    // beside an existing food rather than on top of it: close enough to be related
    for (const f of this.colony.foods) {
      if (f.status !== 'active') continue;
      const d = Math.hypot(x - f.x, y - f.y);
      const min = f.r + 46;
      if (d < min) {
        const a = d > 0.5 ? Math.atan2(y - f.y, x - f.x) : -Math.PI / 4;
        x = f.x + Math.cos(a) * min;
        y = f.y + Math.sin(a) * min;
      }
    }
    this.send({ type: 'objective.create', text, x, y });
    const [sx, sy] = app.camera.toScreen(x, y);
    this.glass.dissolve(text, this.glass.draftAt.x, this.glass.draftAt.y, sx, sy);
    this.droppedOnce = true;
    // a live colony's droplet arrives a moment after the drop, so the undo finds it when it is used
    this.undo.push({
      label: `Took back ${text}`,
      undo: () => {
        const created = this.colony.foods.findLast(f => f.text === text && f.status === 'active');
        if (created) this.send({ type: 'objective.abandon', objective: created.id });
      },
    });
    this.glass.announce(`Dropped ${text}. The colony is coming.`);
    // on a touch screen, put the keyboard away so the colony can be seen
    if (this.touchLast) this.field.blur();
  }

  // ---------- keys ----------

  private keydown(e: KeyboardEvent): void {
    const { app } = this;
    // an input method is composing: its keys belong to it, including the Enter that confirms
    if (e.isComposing || e.keyCode === 229) return;
    // type anywhere: a printable key moves the keyboard into the text field, which then takes it
    const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
    if (printable && !(e.key === ' ' && !this.draft)) this.focus();
    if (e.metaKey || e.ctrlKey) {
      if (e.key.toLowerCase() === 'z' && !e.shiftKey) {
        if (this.draft) return; // the text field undoes its own typing
        e.preventDefault();
        const label = this.undo.undo();
        if (label) this.glass.announce(`${label}.`);
      }
      return;
    }
    if (e.altKey) {
      const step = 1.3;
      if (e.code === 'ArrowUp') app.camera.zoomAt(this.aim.x, this.aim.y, step);
      else if (e.code === 'ArrowDown') app.camera.zoomAt(this.aim.x, this.aim.y, 1 / step);
      else if (e.code === 'Digit0') app.camera.zoomAt(this.aim.x, this.aim.y, 1 / 99);
      else if (e.code === 'KeyH') this.glass.setLegend(!this.glass.legendOpen);
      else return;
      e.preventDefault();
      return;
    }
    if (e.key === 'F1') {
      e.preventDefault();
      this.glass.setLegend(!this.glass.legendOpen);
      return;
    }
    if (e.key.startsWith('Arrow')) {
      e.preventDefault();
      const d = e.shiftKey ? 64 : 16;
      const dx = e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0;
      const dy = e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0;
      this.aim = { x: Math.min(app.w - 4, Math.max(4, this.aim.x + dx)), y: Math.min(app.h - 4, Math.max(4, this.aim.y + dy)) };
      this.keyboard = true;
      this.present = false;
      this.stillSince = now();
      const [wx, wy] = this.world();
      if (this.grab?.kind === 'food') {
        this.grab.food.tx = wx;
        this.grab.food.ty = wy;
        this.measureEdge(this.aim.x, this.aim.y);
      } else if (this.grab?.kind === 'lead') this.colony.extendLead(wx, wy);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      if (this.draft) this.setDraft('');
      else if (this.grab) this.cancelGrab();
      else if (this.glass.legendOpen) this.glass.setLegend(false);
      else app.camera.zoomAt(this.aim.x, this.aim.y, 1 / 99);
      return;
    }
    if (e.key === 'Enter') {
      if (this.draft) {
        // the form submits it, unless something else took the keyboard since
        if (document.activeElement !== this.field) {
          e.preventDefault();
          if (!app.frozen) this.drop();
        }
        return;
      }
      e.preventDefault();
      if (app.frozen) return;
      // held with Shift, Enter enriches the food under the crosshair
      if (e.shiftKey) {
        if (!e.repeat) this.startKeyEnrich();
      } else this.keyPick();
      return;
    }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      // keys that edit words reach the world only when there are no words, and none were just edited:
      // a held key running past the last letter, or a second press right after, stays with the text
      if (this.draft || e.repeat || now() - this.lastEdit < 1) {
        if (this.draft) this.focus();
        return;
      }
      if (!app.frozen) {
        e.preventDefault();
        this.keyCut();
      }
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      this.cycle(e.shiftKey ? -1 : 1);
      return;
    }
    if (e.key === ' ' && !this.draft) {
      e.preventDefault();
      if (!e.repeat) app.freeze(true);
      return;
    }
    // printable keys fall through to the text field
  }

  private keyup(e: KeyboardEvent): void {
    if (e.key === ' ') this.app.freeze(false);
    if (e.key === 'Enter' || e.key === 'Shift') this.stopKeyEnrich();
  }

  // the food the crosshair is on: the picked one first, judged by where it is or where it is heading
  private foodUnderAim(): Food | null {
    const [wx, wy] = this.world();
    const f = this.selected;
    if (f && f.status === 'active') {
      const pad = f.r + 30 / this.app.camera.zoom;
      if (Math.hypot(wx - f.x, wy - f.y) < pad || Math.hypot(wx - f.tx, wy - f.ty) < pad) return f;
    }
    return this.colony.foodAt(wx, wy, 14);
  }

  private cycle(dir: number): void {
    const foods = this.colony.foods.filter(f => f.status === 'active').sort((a, b) => a.x - b.x || a.y - b.y);
    if (!foods.length) return;
    const i = this.selected ? foods.indexOf(this.selected) : -1;
    const f = foods[(i + dir + foods.length) % foods.length];
    this.selected = f;
    const [sx, sy] = this.app.camera.toScreen(f.x, f.y);
    this.aim = { x: sx, y: sy };
    this.keyboard = true;
    this.present = false;
    this.glass.announce(`${f.text}: ${f.workers} at work, ${Math.round(f.progress * 100)}% done.`);
  }

  // Enter with nothing typed picks up what is under the crosshair, or puts it down
  private keyPick(): void {
    const C = this.colony;
    if (this.grab) {
      const [wx, wy] = this.world();
      if (this.grab.kind === 'food') {
        const g = this.grab;
        this.grab = null;
        this.putDown(g.food, g.from, this.nearEdge(this.aim.x, this.aim.y));
        this.edge = 0;
      } else {
        const prev = this.grab.prev;
        this.grab = null;
        this.endLead(wx, wy, prev);
      }
      return;
    }
    const [wx, wy] = this.world();
    const food = this.foodUnderAim();
    if (food) {
      food.dragged = true;
      this.grab = { kind: 'food', food, from: this.place(food.tx, food.ty) };
      this.glass.announce(`Picked up ${food.text}. Arrows carry it, Enter puts it down.`);
      return;
    }
    const slots = C.within(wx, wy, REACH / this.app.camera.zoom, 80);
    if (!slots.length) return;
    const prev = new Map<string, string | null>();
    for (const s of slots) prev.set(C.agents.id[s]!, this.foodIdOf(s));
    C.startLead(slots, wx, wy);
    this.grab = { kind: 'lead', prev };
    this.glass.announce(`Leading ${slots.length} agents. Arrows lay the trail, Enter lets them go.`);
  }

  private cancelGrab(): void {
    const g = this.grab;
    this.grab = null;
    this.edge = 0;
    if (!g) return;
    if (g.kind === 'food') this.putBack(g.food, g.from);
    else this.colony.endLead({ kind: 'none' });
  }

  // Delete with nothing typed: abandon the food under the crosshair, or cut loose the agents there
  private keyCut(): void {
    const C = this.colony;
    const A = C.agents;
    const [wx, wy] = this.world();
    const food = this.foodUnderAim();
    if (food) {
      this.putDown(food, this.place(food.tx, food.ty), true);
      return;
    }
    const freed = C.within(wx, wy, REACH / this.app.camera.zoom, 80).filter(s => {
      if (A.food[s] < 0 || !WORKING.has(A.mode[s])) return false;
      const f = C.foods[A.food[s]];
      return Math.hypot(A.x[s] - f.x, A.y[s] - f.y) > f.r + 40;
    });
    if (!freed.length) return;
    const prev = new Map<string, string | null>();
    for (const s of freed) {
      prev.set(A.id[s]!, this.foodIdOf(s));
      C.scatter(s, A.x[s] - wx, A.y[s] - wy, 90);
    }
    this.send({ type: 'agents.release', agents: [...prev.keys()] });
    this.remember(`Put ${freed.length} agents back on their work`, prev);
    this.glass.announce(`Cut ${freed.length} ${freed.length === 1 ? 'agent' : 'agents'} loose.`);
  }

  private startKeyEnrich(): void {
    const food = this.foodUnderAim();
    if (!food) return;
    this.keyEnrich = { food, total: 0, next: 0 };
    this.enriching = food;
    food.enriching = 1;
  }

  private stopKeyEnrich(): void {
    const k = this.keyEnrich;
    if (!k || k.staged) return;
    this.keyEnrich = null;
    this.stopEnrich(k.food, k.total);
  }

  // ---------- every frame ----------

  update(dt: number): void {
    const { app } = this;
    const C = this.colony;
    const cam = app.camera;
    const t = now();
    const P = this.press;

    // a press on food that stays still becomes enrichment without any movement event
    if (P && !this.gesture && P.target === 'food' && t - P.t0 >= HOLD) {
      if (classifyDrag(P.samples, 'food', false, t) === 'enrich') this.begin('enrich');
    }
    // enrichment flows while pressed
    const enrichTick = (f: Food, add: (n: number) => void, due: number, setDue: (n: number) => void) => {
      if (t < due || f.status !== 'active') return;
      setDue(t + 0.4);
      this.send({ type: 'objective.enrich', objective: f.id, amount: 0.3 });
      add(0.3);
    };
    // the simulation's priority tops out, so a hold stops adding there; real agents keep coming while it is held
    const most = app.runtime.simulated ? 3 : Infinity;
    if (P && this.gesture === 'enrich' && P.food && P.enrichTotal < most) {
      enrichTick(P.food, n => (P.enrichTotal += n), P.nextEnrichAt, n => (P.nextEnrichAt = n));
    }
    const K = this.keyEnrich;
    if (K && K.total < most) enrichTick(K.food, n => (K.total += n), K.next, n => (K.next = n));

    // stillness: the colony feels a hand that rests
    const speed = Math.hypot(this.vel.x, this.vel.y);
    if (t - this.last.t > 0.05) {
      this.vel.x *= Math.exp(-dt / 0.05);
      this.vel.y *= Math.exp(-dt / 0.05);
    }
    const still = (this.present || this.keyboard) && t - this.stillSince > 0.22 && !this.press ? 1 : 0;
    this.still += (still - this.still) * (1 - Math.exp(-dt / 0.15));
    this.reachPx = REACH;

    const [wx, wy] = this.world();
    const zoom = cam.zoom;
    C.pointer = {
      present: this.present,
      x: wx,
      y: wy,
      vx: this.vel.x / zoom,
      vy: this.vel.y / zoom,
      still: this.still > 0.5,
      reach: REACH / zoom,
    };
    if (speed < 1) C.pointer.vx = C.pointer.vy = 0;

    this.hover = this.findHover(wx, wy);
    app.hoverFood = this.hover.kind === 'food' && this.hover.food ? this.hover.food.index : -1;
    const pressure = this.pressing ? 1 : 0;
    app.hand.x = wx;
    app.hand.y = wy;
    app.hand.reach = 30 / zoom;
    app.hand.pressure += (pressure - app.hand.pressure) * (1 - Math.exp(-dt / 0.12));
    if (this.selected && this.selected.status !== 'active') this.selected = null;
    this.cuts = this.cuts.filter(k => app.clock - k.t0 < 1);
  }

  private findHover(wx: number, wy: number): Hover {
    const C = this.colony;
    if (!this.present && !this.keyboard) return { kind: 'none' };
    const P = this.press;
    if (this.gesture === 'move' || this.gesture === 'enrich') return { kind: 'food', food: P?.food ?? undefined };
    if (this.grab?.kind === 'food') return { kind: 'food', food: this.grab.food };
    if (this.gesture) return { kind: 'none' };
    const zoom = this.app.camera.zoom;
    const food = C.foodAt(wx, wy, 12 / zoom);
    // a droplet still forming belongs to the words dissolving into it; label it once it has formed
    if (food) return food.appear < 0.9 ? { kind: 'none' } : { kind: 'food', food };
    if (C.nest.idle > 0 && C.inNest(wx, wy)) return { kind: 'nest' };
    if (C.midden.husks.length && Math.hypot((wx - C.midden.x) * 0.7, wy - C.midden.y) < C.midden.r + 26) return { kind: 'midden' };
    for (const f of C.findings) {
      if (depthAlpha(f, C.time) < 0.2 || !f.w) continue;
      const [cx, cy] = depthCenter(f);
      if (Math.abs(wx - cx) < f.w / 2 && Math.abs(wy - cy) < f.h / 2) return { kind: 'depth', finding: f };
    }
    const vein = C.veinAt(wx, wy);
    return vein ? { kind: 'vein', vein } : { kind: 'none' };
  }
}
