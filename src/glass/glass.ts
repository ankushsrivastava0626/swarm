// The glass: everything a person made or reads. Snow-white, matte, still, and on top.
import type { App } from '../app';
import type { Food } from '../world/foods';
import { Mode } from '../world/agents';
import { depthCenter } from '../world/colony';
import type { Input } from '../input/input';
import { ABOUT_LIVE, READOUT, restingHint } from './copy';
import { Lines } from './lines';

const COARSE = matchMedia('(pointer: coarse)').matches;
const RESTING_WORDS = restingHint(COARSE);

interface Pinned {
  el: HTMLElement;
  x: number;
  y: number;
  vx: number;
  vy: number;
  shown: boolean;
  key: string;
}

function el(tag: string, cls: string, parent: HTMLElement, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  parent.append(e);
  return e;
}

// a number set narrow, followed by words at their usual width
function figure(parent: HTMLElement, n: string, words: string): void {
  el('span', 'num', parent, n);
  if (words) el('span', 'words', parent, ` ${words}`);
}

const ago = (s: number): string => (s < 60 ? `${Math.max(1, Math.round(s))} s` : `${Math.round(s / 60)} min`);

// under ten dollars an hour the spend reads in cents: a colony on a cheap model would otherwise show $0
export const money = (usd: number): string => (usd < 10 ? `$${usd.toFixed(2)}` : `$${Math.round(usd)}`);

export class Glass {
  readonly lines: Lines;
  private readout: HTMLElement;
  private working: HTMLElement;
  private spend: HTMLElement;
  private mag: HTMLElement;
  private exposure: HTMLElement;
  private hint: HTMLElement;
  private draft: HTMLElement;
  private draftText: HTMLElement;
  private legend: HTMLElement;
  private help: HTMLElement;
  private label: Pinned;
  private words: Pinned[] = [];
  private findings = new Map<object, Pinned & { born: number }>();
  private announcer: HTMLElement;
  private beat = -1;
  private labelBeat = -1;
  private notice: HTMLElement;
  private magShownAt = -99;
  private lastZoom = 1;
  private hintGone = false;
  legendOpen = false;
  draftAt = { x: 0, y: 0 };
  // a scene on the landing page types its words on the side of the crosshair away from the nest
  draftLeft = false;

  constructor(
    private root: HTMLElement,
    canvas: HTMLCanvasElement,
    private app: App,
  ) {
    this.lines = new Lines(canvas);
    this.announcer = document.getElementById('announcer')!;
    this.readout = el('div', 'readout', root);
    this.working = el('span', 'figure', this.readout);
    this.spend = el('span', 'figure', this.readout);
    if (app.runtime.simulated) el('span', 'tag', this.readout, READOUT.simulated);
    else {
      const about = document.getElementById('about');
      if (about) about.textContent = ABOUT_LIVE;
    }
    this.mag = el('div', 'mag', root);
    this.exposure = el('div', 'exposure', root);
    figure(this.exposure, '6 s', 'exposure');
    this.hint = el('div', 'hint', root, RESTING_WORDS);
    this.draft = el('div', 'draft', root);
    this.draftText = el('span', 'draft-text', this.draft);
    el('span', 'caret', this.draft);
    el('div', 'draft-help', this.draft, COARSE ? 'Go drops it where you tapped' : 'Enter drops it here, Esc lets it go');
    this.help = el('div', 'help', root, '?');
    this.help.setAttribute('aria-hidden', 'true');
    // a mouse shows the legend while it rests on the mark; a finger taps it open and shut
    this.help.addEventListener('pointerenter', e => e.pointerType === 'mouse' && this.setLegend(true));
    this.help.addEventListener('pointerleave', e => e.pointerType === 'mouse' && this.setLegend(false));
    this.help.addEventListener('click', e => (e as PointerEvent).pointerType !== 'mouse' && this.setLegend(!this.legendOpen));
    this.legend = el('div', 'legend', root);
    this.legend.setAttribute('role', 'note');
    this.buildLegend();
    this.label = this.pinned('label');
    this.notice = el('div', 'notice', root, 'The display was interrupted. It comes back on its own.');
  }

  // the browser took the drawing surface away; the colony keeps living underneath
  setLost(on: boolean): void {
    this.notice.classList.toggle('on', on);
    if (on) this.announce('The display was interrupted. It comes back on its own.');
  }

  private pinned(cls: string): Pinned {
    const e = el('div', cls, this.root);
    return { el: e, x: 0, y: 0, vx: 0, vy: 0, shown: false, key: '' };
  }

  private buildLegend(): void {
    const rows: [string, string][] = [
      ['Type anywhere, then Enter', 'drop food where you point'],
      ['Drag slowly from agents', 'lead them along your scent'],
      ['Flick fast through agents', 'cut them loose from their food'],
      ['Drag food', 'move it; off the edge to abandon'],
      ['Press and hold food', 'enrich it, so more of the colony comes'],
      ['Hold Space', 'freeze time as a long exposure'],
      ['Scroll', 'magnify; words appear on agents'],
      ['⌘Z or Ctrl+Z', 'undo'],
    ];
    const list = el('dl', 'legend-list', this.legend);
    for (const [k, v] of rows) {
      el('dt', '', list, k);
      el('dd', '', list, v);
    }
    el(
      'p',
      'legend-keys',
      this.legend,
      'Keyboard: arrows aim, Tab picks food, Enter picks up and puts down, hold Shift+Enter to enrich, Delete cuts or abandons, Alt+↑ and Alt+↓ magnify.',
    );
  }

  setLegend(on: boolean): void {
    this.legendOpen = on;
    this.legend.classList.toggle('on', on);
  }

  announce(text: string): void {
    this.announcer.textContent = '';
    requestAnimationFrame(() => (this.announcer.textContent = text));
  }

  hideHint(): void {
    if (this.hintGone) return;
    this.hintGone = true;
    this.hint.classList.add('gone');
  }

  // the words you typed soften, sink and dissolve into the droplet forming where you pointed
  dissolve(text: string, fromX: number, fromY: number, toX: number, toY: number): void {
    const box = el('div', 'dissolve', this.root);
    box.style.transform = `translate(${fromX}px, ${fromY}px)`;
    const letters = [...text].map(ch => el('span', 'letter', box, ch));
    const reduced = this.app.reduced.matches;
    requestAnimationFrame(() => {
      const r0 = box.getBoundingClientRect();
      letters.forEach((l, i) => {
        const r = l.getBoundingClientRect();
        const dx = toX - (r.left + r.width / 2);
        const dy = toY - (r.top + r.height / 2);
        const delay = reduced ? 0 : i * 16;
        l.animate(
          reduced
            ? [{ opacity: 1 }, { opacity: 0 }]
            : [
                { transform: 'translate(0, 0) scale(1)', filter: 'blur(0px)', opacity: 1 },
                { transform: `translate(${dx * 0.35}px, ${dy * 0.35 + 6}px) scale(0.9)`, filter: 'blur(1.5px)', opacity: 0.9, offset: 0.35 },
                { transform: `translate(${dx}px, ${dy}px) scale(0.3)`, filter: 'blur(5px)', opacity: 0 },
              ],
          { duration: reduced ? 300 : 820, delay, easing: 'cubic-bezier(.55,0,.8,.45)', fill: 'forwards' },
        );
      });
      void r0;
      setTimeout(() => box.remove(), (reduced ? 300 : 820) + letters.length * 16 + 60);
    });
  }

  // the colony's glow condenses into upright type, pinned where the food was
  crystallize(food: Food, finding: string, key: object): void {
    const p = this.pinned('finding');
    p.el.replaceChildren();
    el('div', 'finding-ask', p.el, food.text);
    el('div', 'finding-answer', p.el, finding);
    const [sx, sy] = this.app.camera.toScreen(food.x, food.y);
    p.x = sx;
    p.y = sy;
    p.shown = true;
    this.place(p);
    const reduced = this.app.reduced.matches;
    p.el.animate(
      reduced
        ? [{ opacity: 0 }, { opacity: 1 }]
        : [
            { opacity: 0, filter: 'blur(9px)', letterSpacing: '0.12em' },
            { opacity: 0.85, filter: 'blur(2px)', letterSpacing: '0.02em', offset: 0.55 },
            { opacity: 1, filter: 'blur(0px)', letterSpacing: '0em' },
          ],
      { duration: reduced ? 300 : 1100, easing: 'cubic-bezier(.2,.7,.2,1)', fill: 'forwards' },
    );
    this.findings.set(key, { ...p, born: this.app.clock });
    this.announce(`Finished: ${food.text}. ${finding}.`);
  }

  private place(p: Pinned): void {
    p.el.style.transform = `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0)`;
  }

  // labels follow what they describe, but on a damped spring, so type never shakes
  private follow(p: Pinned, tx: number, ty: number, dt: number, key: string): void {
    if (!p.shown || p.key !== key || Math.hypot(tx - p.x, ty - p.y) > 220) {
      p.x = tx;
      p.y = ty;
      p.vx = p.vy = 0;
    } else {
      const w = 16;
      p.vx += (w * w * (tx - p.x) - 2 * w * p.vx) * dt;
      p.vy += (w * w * (ty - p.y) - 2 * w * p.vy) * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
    p.key = key;
    this.place(p);
  }

  private show(p: Pinned, on: boolean): void {
    if (p.shown === on) return;
    p.shown = on;
    p.el.classList.toggle('on', on);
  }

  update(dt: number, input: Input): void {
    const { app } = this;
    const C = app.colony;
    const cam = app.camera;

    // the one readout that is always on: the colony's metabolism, changing on the beat
    const beat = Math.floor(app.clock * 2);
    if (beat !== this.beat) {
      this.beat = beat;
      this.working.replaceChildren();
      figure(this.working, String(C.working), READOUT.working);
      // spend shows only when the runtime reports what agents cost
      this.spend.hidden = !C.spendKnown;
      this.spend.replaceChildren();
      figure(this.spend, money(C.spend), READOUT.spend);
    }

    // magnification shows while it changes and while magnified
    if (Math.abs(cam.zoom - this.lastZoom) > 0.002) this.magShownAt = app.clock;
    this.lastZoom = cam.zoom;
    const magOn = cam.zoom > 1.02 || app.clock - this.magShownAt < 1.2;
    this.mag.classList.toggle('on', magOn);
    if (magOn) this.mag.textContent = `${cam.zoom.toFixed(1)}×`;
    this.exposure.classList.toggle('on', app.frozen);
    this.hint.classList.toggle('held', app.frozen);

    // the draft
    const typing = input.draft.length > 0;
    this.draft.classList.toggle('on', typing);
    this.draft.classList.toggle('first', typing && !input.droppedOnce);
    if (typing) {
      this.draftText.textContent = input.draft;
      // the words sit beside the crosshair, on whichever side has room
      const w = this.draft.offsetWidth;
      const h = this.draft.offsetHeight;
      let x = input.aim.x + 18;
      let y = input.aim.y + 14;
      if (this.draftLeft || x + w > app.w - 16) x = input.aim.x - 18 - w;
      if (y + h > app.h - 16) y = input.aim.y - 14 - h;
      this.draftAt = { x, y };
      this.draft.style.transform = `translate3d(${Math.max(16, x).toFixed(1)}px, ${Math.max(16, y).toFixed(1)}px, 0)`;
    }

    this.updateLabel(dt, input);
    this.updateWords(dt, input);

    // findings stay on the glass a while, then sink into the depth layer
    for (const [key, p] of this.findings) {
      const f = C.findings.find(x => x === key);
      if (!f) continue;
      const [sx, sy] = cam.toScreen(f.x, f.y);
      this.follow(p, sx, sy, dt, 'finding');
      if (f.deep > 0) {
        p.el.style.opacity = String(1 - f.deep);
        p.el.style.filter = `blur(${(f.deep * 6).toFixed(1)}px)`;
      }
      if (f.deep >= 1) {
        p.el.remove();
        this.findings.delete(key);
      }
    }

    this.lines.draw(app, input);
  }

  private updateLabel(dt: number, input: Input): void {
    const { app } = this;
    const C = app.colony;
    const cam = app.camera;
    const h = input.hover;
    const p = this.label;
    let key = '';
    let tx = 0;
    let ty = 0;
    // contents change on the beat, never every frame; position follows every frame
    const refresh = (k: string) => p.key !== k || this.beat !== this.labelBeat;
    if (h.kind === 'food' && h.food) {
      const f = h.food;
      key = `food:${f.index}`;
      if (refresh(key)) {
        p.el.replaceChildren();
        el('div', 'ask', p.el, f.text);
        const line = el('div', 'detail', p.el);
        figure(line, String(f.workers), 'at work, ');
        figure(line, `${Math.round(f.progress * 100)}%`, f.status === 'abandoned' ? 'done, abandoned' : 'done');
      }
      [tx, ty] = cam.toScreen(f.x, f.y);
      const off = f.r * cam.zoom + 16;
      // beside the droplet, on whichever side has room
      tx += tx + off + p.el.offsetWidth > app.w - 12 ? -off - p.el.offsetWidth : off;
      ty -= 10;
    } else if (h.kind === 'nest') {
      key = 'nest';
      if (refresh(key)) {
        p.el.replaceChildren();
        const line = el('div', 'detail', p.el);
        figure(line, String(C.nest.idle), C.nest.idle === 1 ? 'agent resting' : 'resting, ready for work');
      }
      [tx, ty] = cam.toScreen(C.nest.x + C.nest.r * 0.7, C.nest.y - C.nest.r * 0.7);
    } else if (h.kind === 'midden') {
      key = 'midden';
      if (refresh(key)) {
        p.el.replaceChildren();
        const head = el('div', 'detail', p.el);
        figure(head, String(C.midden.husks.length), 'gone dark');
        const log = el('ol', 'log', p.el);
        for (const m of C.midden.log.slice(0, 5)) {
          const li = el('li', '', log);
          el('span', 'log-text', li, m.text);
          el('span', 'num', li, ` ${ago(C.time - m.time)}`);
        }
      }
      [tx, ty] = cam.toScreen(C.midden.x - C.midden.r - 12, C.midden.y - C.midden.r - 8);
      tx -= p.el.offsetWidth;
      ty -= p.el.offsetHeight;
    } else if (h.kind === 'vein' && h.vein) {
      // what moved along the vein, then between where; the nest is the colony's shared memory
      const v = h.vein;
      key = `vein:${v.from}:${v.to}:${v.what}`;
      if (p.key !== key) {
        p.el.replaceChildren();
        if (v.what) el('div', 'what', p.el, v.what);
        const line = el('div', 'detail', p.el);
        const end = (name: string) => (name ? el('span', 'ask-inline', line, name) : el('span', 'words', line, 'shared memory'));
        el('span', 'words', line, 'from ');
        end(v.from);
        el('span', 'words', line, ' to ');
        end(v.to);
      }
      tx = input.aim.x + 18;
      ty = input.aim.y + 16;
    } else if (h.kind === 'depth' && h.finding) {
      const f = h.finding;
      key = `depth:${C.findings.indexOf(f)}`;
      if (p.key !== key) {
        p.el.replaceChildren();
        el('div', 'ask', p.el, f.text);
        el('div', 'detail', p.el, f.finding);
      }
      // centred on the out-of-focus type it brings into focus
      const [cx, cy] = cam.toScreen(...depthCenter(f));
      tx = cx - p.el.offsetWidth / 2;
      ty = cy - p.el.offsetHeight / 2;
    }
    if (key) this.labelBeat = this.beat;
    p.el.classList.toggle('deep', h.kind === 'depth');
    if (!key) {
      this.show(p, false);
      p.key = '';
      return;
    }
    // keep the label on the glass
    const w = p.el.offsetWidth;
    const hh = p.el.offsetHeight;
    tx = Math.min(app.w - w - 12, Math.max(12, tx));
    ty = Math.min(app.h - hh - 12, Math.max(12, ty));
    this.follow(p, tx, ty, dt, key);
    this.show(p, true);
  }

  // words wait until you magnify: then the agents near your focus say what they are doing
  private updateWords(dt: number, input: Input): void {
    const { app } = this;
    const C = app.colony;
    const A = C.agents;
    const cam = app.camera;
    const want: number[] = [];
    if (cam.zoom >= 2.2 && input.present && !input.gesture && !app.frozen) {
      const [wx, wy] = cam.toWorld(input.aim.x, input.aim.y);
      const near = C.within(wx, wy, 220 / cam.zoom, 40);
      // the agents already speaking keep the floor, so words do not hop from body to body
      const speaking = new Set(this.words.filter(p => p.shown).map(p => p.key));
      near.sort((a, b) => Number(speaking.has(`agent:${A.id[b]}`)) - Number(speaking.has(`agent:${A.id[a]}`)));
      // words never cover each other or the label, and the same words are not said twice nearby
      const taken: { x: number; y: number; w: number; h: number; text: string }[] = [];
      if (this.label.shown) taken.push({ x: this.label.x, y: this.label.y, w: this.label.el.offsetWidth, h: this.label.el.offsetHeight, text: '' });
      for (const s of near) {
        if (want.length >= 6) break;
        const m = A.mode[s];
        const text = A.activity[s];
        if (m === Mode.Idle || m === Mode.Dying || !text) continue;
        const [sx, sy] = cam.toScreen(A.x[s], A.y[s]);
        const box = { x: sx + 12, y: sy - 8, w: text.length * 6.3 + 6, h: 18, text };
        const clash = taken.some(
          b => (b.text === text && Math.hypot(b.x - box.x, b.y - box.y) < 220) || (box.x < b.x + b.w && b.x < box.x + box.w && box.y < b.y + b.h && b.y < box.y + box.h),
        );
        if (clash) continue;
        taken.push(box);
        want.push(s);
      }
    }
    while (this.words.length < want.length) this.words.push(this.pinned('word'));
    this.words.forEach((p, i) => {
      const s = want[i];
      if (s === undefined) {
        this.show(p, false);
        p.key = '';
        return;
      }
      const key = `agent:${A.id[s]}`;
      if (p.key !== key) p.el.textContent = A.activity[s];
      const [sx, sy] = cam.toScreen(A.x[s], A.y[s]);
      this.follow(p, sx + 12, sy - 8, dt, key);
      this.show(p, true);
    });
  }
}
