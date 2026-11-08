// The landing page: the simulated colony, the chapters down the right edge, and a label pinned with a hairline
// to whatever the chapter is about while the colony acts it out. The label only ever sits on empty glass: it
// takes the empty place nearest its subject, clear of the colony and of what the scene is about to do, stays
// there, and moves as soon as anything comes near. The last chapter hands the colony over, and its label steps
// aside after a while.
import type { App } from '../app';
import type { Engrave } from '../glass/lines';
import type { Glass } from '../glass/glass';
import type { Input } from '../input/input';
import { LAUNCH, LIVE } from '../launch';
import type { RemoteRuntime } from '../runtime/remote';
import { CENTERED } from '../world/colony';
import { CHAPTERS, PLATES, type Chapter } from './chapters';
import { Clearance, type Box } from './clearance';
import { Director, type Pin } from './director';

const MARGIN = 16; // a label keeps this far inside the glass
const CLEAR = 26; // px a label keeps from anything when it picks its place
const STAY = 6; // px anything may come before the label moves
const STEP = 8; // px between the places a label tries
const CHECK = 0.25; // seconds between looks at what is around the label
const REST = 1.5; // seconds a label that has moved waits before it moves again
const SEEK = 1; // seconds a crowded label with nowhere emptier to go waits before it looks again
const ASIDE = 15; // seconds the last chapter's label stays before it steps aside
// small screens dock the label along the bottom, keep the colony above it, and list the chapters across the top
const DOCKED = matchMedia('(max-width: 720px)');

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: HTMLElement, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  parent.append(e);
  return e;
}

function code(text: string): HTMLElement {
  const c = document.createElement('code');
  c.textContent = text;
  return c;
}

// the way to the live colony: its light shows when the colony is running
function liveLink(parent: HTMLElement): HTMLAnchorElement {
  const a = el('a', 'go-live', parent);
  a.href = '/live';
  el('i', '', a);
  el('span', '', a, 'Go live');
  return a;
}

// until the live colony opens, its place on the page says when; its light comes on then
function launchNote(parent: HTMLElement): HTMLElement {
  const p = el('p', 'go-live launch', parent);
  el('i', '', p);
  el('span', 'long', p, LAUNCH.long);
  el('span', 'short', p, LAUNCH.short);
  return p;
}

const rectOf = (e: Element): Box => {
  const r = e.getBoundingClientRect();
  return [r.left, r.top, r.width, r.height];
};

const ease = (u: number) => 1 - Math.pow(1 - u, 3);

export class Landing {
  private director: Director;
  private clear = new Clearance();
  private entries: HTMLButtonElement[] = [];
  private links: HTMLAnchorElement[] = [];
  private nav: HTMLElement;
  private label: HTMLElement;
  private heading: HTMLElement;
  private title: HTMLElement;
  private biology: HTMLElement;
  private swarm: HTMLElement;
  private turn: HTMLElement;
  private status: HTMLElement;
  private next: HTMLButtonElement;
  private resume: HTMLButtonElement;
  private furniture: Element[];
  private current = -1;
  private shown = -1; // the chapter whose words the label carries
  private vis = 0; // how far into focus the label has come, 0 to 1
  private alpha = 0;
  private box: Box | null = null; // where the label sits on the glass
  private size = { w: 0, h: 0 };
  private moving = false; // it is leaving its place for emptier glass
  private settledAt = -Infinity;
  private checkedAt = -Infinity;
  private soughtAt = -Infinity; // when a crowded label last looked for emptier glass
  private aside = false; // the last chapter's label has stepped aside
  private awake = 0; // seconds it has been in full view in the last chapter
  private closedFrom: number | null = null; // the chapter the tour was closed on, until it is picked up again
  // the hairline: from the subject's mark to where it meets the label's rule, and the rule itself (x0, x1, y)
  private leader: { pin: Pin; start: [number, number]; elbow: [number, number] | null; end: [number, number]; rule: [number, number, number] } | null = null;

  constructor(
    root: HTMLElement,
    private app: App,
    private input: Input,
    private glass: Glass,
  ) {
    this.director = new Director(app, app.sim!, input, glass);
    document.body.classList.add('landing');
    const about = document.getElementById('about');
    if (about) about.textContent = 'How a swarm of AI agents works, told through an ant colony in seven chapters while a simulated colony acts each one out. Move between chapters with the chapter list or the left and right arrow keys. In the last chapter the colony is yours to feed.';

    const mark = el('div', 'mark', root);
    el('span', 'mark-name', mark, 'Swarm terrarium');
    el('span', 'mark-line', mark, 'A living observatory for a swarm of AI agents');
    let top: HTMLElement;
    if (LIVE) {
      const a = liveLink(root);
      this.links.push(a);
      top = a;
    } else top = launchNote(root);

    this.nav = el('nav', 'index', root);
    this.nav.setAttribute('aria-label', 'Chapters');
    this.entries = CHAPTERS.map((ch, i) => {
      const b = el('button', '', this.nav);
      b.type = 'button';
      el('span', 'name', b, ch.name);
      el('span', 'plate', b, PLATES[i]);
      b.setAttribute('aria-label', `Chapter ${i + 1}: ${ch.name}`);
      b.addEventListener('click', () => this.go(i));
      return b;
    });

    this.label = el('section', 'specimen', root);
    this.label.setAttribute('aria-label', 'Chapter');
    // anyone may put the tour away: the colony is then theirs, as in the last chapter
    const close = el('button', 'close', this.label, '×');
    close.type = 'button';
    close.title = 'Close the tour';
    close.setAttribute('aria-label', 'Close the tour and feed the colony yourself');
    close.addEventListener('click', () => this.dismiss());
    // the chapter list carries the numerals; the label names the biology
    const head = el('p', 'chapter', this.label);
    this.heading = el('span', 'heading', head);
    this.title = el('h2', 'title', this.label);
    this.biology = el('p', 'biology', this.label);
    this.swarm = el('p', 'swarm', this.label);
    this.turn = el('div', 'turn', this.label);
    if (LIVE) this.links.push(liveLink(this.turn));
    this.status = el('p', 'status', this.turn);
    this.next = el('button', 'next', this.label);
    this.next.type = 'button';
    this.next.addEventListener('click', () => this.go(this.current + 1));
    // a tour closed early waits to be picked up where it was left
    this.resume = el('button', 'resume', root, 'Back to the tour');
    this.resume.type = 'button';
    this.resume.hidden = true;
    this.resume.addEventListener('click', () => this.go(this.closedFrom ?? 0));
    this.furniture = [mark, top, this.nav, this.resume, document.querySelector('.readout')].filter((e): e is Element => !!e);

    glass.lines.overlay = (c, engrave) => this.drawLeader(c, engrave);
    addEventListener('keydown', e => this.key(e));
    addEventListener('resize', () => this.relayout());
    DOCKED.addEventListener('change', () => this.relayout());
    document.fonts.ready.then(() => this.relayout());
    if (LIVE) {
      this.setAwake(undefined);
      this.checkLive();
    } else this.status.textContent = LAUNCH.status;
    // the scenes need to know where they may happen before the first one is staged
    this.measure();
    const start = CHAPTERS.findIndex(c => c.id === location.hash.slice(1));
    this.go(Math.max(0, start));
  }

  go(i: number): void {
    i = Math.max(0, Math.min(CHAPTERS.length - 1, i));
    // choosing any chapter picks a closed tour up again
    this.closedFrom = null;
    this.resume.hidden = true;
    if (i === this.current) {
      // choosing the last chapter again brings back its label
      if (this.aside) {
        this.aside = false;
        this.awake = 0;
        this.moving = true;
      }
      return;
    }
    this.current = i;
    this.aside = false;
    this.awake = 0;
    // its scene starts again: a label already carrying this chapter's words, as after the tour was closed on it,
    // finds its place again before it shows
    if (this.shown === i) this.moving = true;
    const ch = CHAPTERS[i];
    const play = ch.id === 'play';
    this.director.enter(ch.id);
    // the colony plays its scenes untouched; in the last chapter it is the visitor's
    this.input.setEnabled(play);
    document.body.classList.toggle('tour', !play);
    this.entries.forEach((b, k) => (k === i ? b.setAttribute('aria-current', 'step') : b.removeAttribute('aria-current')));
    history.replaceState(null, '', i ? `#${ch.id}` : location.pathname + location.search);
    if (play && LIVE) this.checkLive();
  }

  update(dt: number): void {
    this.director.update(dt);
    this.clear.trace(this.app.colony);
    const reduced = this.app.reduced.matches;
    const play = CHAPTERS[this.current].id === 'play';
    // magnified, the last chapter's colony is the visitor's to look at: the label steps out of the way
    const looking = play && this.app.camera.target > 1.02;
    if (looking) this.moving = true;
    const turning = this.shown !== this.current;
    if (turning || this.moving || this.aside || looking) {
      this.vis = Math.max(0, this.vis - dt / (reduced ? 0.12 : 0.22));
      // out of sight it takes the new chapter's words and finds empty glass; after a move it waits a moment,
      // so a busy colony cannot chase it around
      const ready = turning || this.app.clock - this.settledAt > REST;
      if (this.vis === 0 && !this.aside && !looking && ready) {
        if (turning) this.fill(CHAPTERS[this.current]);
        this.settle();
      }
    } else if (this.app.clock > 0.8) {
      // the first label waits for the lens to find its focus
      this.vis = Math.min(1, this.vis + dt / (reduced ? 0.25 : 0.7));
    }
    // the last chapter's label steps aside after a while, so all of the colony is the visitor's
    if (play && this.vis === 1) {
      this.awake += dt;
      if (this.awake >= ASIDE) this.aside = true;
    }
    this.alpha = ease(this.vis);
    const L = this.label;
    L.style.opacity = this.alpha.toFixed(3);
    L.style.filter = reduced || this.alpha > 0.995 ? '' : `blur(${((1 - this.alpha) * 7).toFixed(2)}px)`;
    L.style.visibility = this.alpha < 0.01 ? 'hidden' : 'visible';
    if (this.box && this.vis > 0.05 && !this.moving && !turning) this.watch(play);
    this.leader = this.box && this.shown >= 0 ? this.lead(this.director.pin(CHAPTERS[this.shown].anchor), this.box) : null;
  }

  private fill(ch: Chapter): void {
    const i = CHAPTERS.indexOf(ch);
    this.shown = i;
    this.write(ch);
    // the label changes its words while out of focus, so a screen reader hears them from the announcer
    this.glass.announce(`Chapter ${i + 1} of ${CHAPTERS.length}, ${ch.heading}. ${ch.title}. ${ch.biology} ${ch.swarm}`.trim());
  }

  private write(ch: Chapter): void {
    const i = CHAPTERS.indexOf(ch);
    this.heading.textContent = ch.heading;
    this.title.textContent = ch.title;
    this.biology.textContent = ch.biology;
    this.swarm.textContent = ch.swarm;
    this.swarm.hidden = !ch.swarm;
    this.turn.hidden = ch.id !== 'play';
    this.label.classList.toggle('last', ch.id === 'play');
    // the way on names where it goes; the last chapter has none
    const next = CHAPTERS[i + 1];
    this.next.hidden = !next;
    this.next.textContent = next ? `Next: ${next.name}` : '';
  }

  // the tour put away: the scenes stop and the colony is the visitor's, as in the last chapter, with no label
  // in the way. Closed before its last chapter, it waits in the corner to be picked up where it was left, and
  // choosing any chapter brings it back too
  private dismiss(): void {
    const from = this.current;
    this.go(CHAPTERS.length - 1);
    this.aside = true;
    if (from === CHAPTERS.length - 1) {
      this.glass.announce('The colony is yours. Choose Your turn in the chapter list to bring the label back.');
      return;
    }
    this.closedFrom = from;
    this.resume.hidden = false;
    this.glass.announce('The tour is closed and the colony is yours. Type anywhere to feed it, or choose Back to the tour to pick it up where you left it.');
  }

  // the window changed: everything is measured again, and the label finds its place again
  private relayout(): void {
    this.measure();
    if (this.box) this.moving = true;
  }

  private measure(): void {
    const { w, h } = this.app;
    if (DOCKED.matches) {
      // the dock keeps the height of its longest chapter, so the colony above it never has to move
      const top = 96;
      const bottom = Math.max(top + 120, h - 52 - this.tallest() - 16);
      const nest = (top + bottom) / 2;
      const midden = Math.max(top + 60, bottom - 50);
      this.app.colony.rearrange(cw => ({ nest: [cw / 2, nest], midden: [cw - 60, midden] }));
      this.director.stage = { left: 40, top: 120, right: w - 40, bottom: Math.max(150, bottom - 140), textRight: w - 16 };
    } else {
      this.app.colony.rearrange(CENTERED);
      // scenes stay clear of the chapter list, and words typed for them end before it
      this.director.stage = { left: 90, top: 120, right: w - 230, bottom: h - 140, textRight: this.nav.getBoundingClientRect().left - 24 };
    }
    this.size = { w: this.label.offsetWidth, h: this.label.offsetHeight };
  }

  // the height the docked label needs for its longest chapter
  private tallest(): number {
    let most = 0;
    for (const ch of CHAPTERS) {
      this.write(ch);
      most = Math.max(most, this.label.offsetHeight);
    }
    if (this.shown >= 0) this.write(CHAPTERS[this.shown]);
    return most;
  }

  // the label goes where the glass is empty, as near its subject as that allows
  private settle(): void {
    this.moving = false;
    this.settledAt = this.checkedAt = this.app.clock;
    this.measure();
    const L = this.label;
    if (DOCKED.matches) {
      L.style.transform = '';
      this.box = rectOf(L);
      return;
    }
    const { app } = this;
    this.clear.build(app.w, app.h, app.colony, app.camera, this.boxes(true), this.director.footprint());
    const [x, y] = this.choose(this.director.pin(CHAPTERS[this.shown].anchor));
    L.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    this.box = [x, y, this.size.w, this.size.h];
  }

  // the empty place nearest the label's subject; where none is empty, the place that hides the least
  private choose(pin: Pin): [number, number] {
    const { w, h } = this.size;
    const right = Math.max(MARGIN, this.app.w - w - MARGIN);
    const bottom = Math.max(MARGIN, this.app.h - h - MARGIN);
    let best: [number, number] = [MARGIN, MARGIN];
    let bestScore = Infinity;
    for (let y = MARGIN; ; y = Math.min(bottom, y + STEP)) {
      for (let x = MARGIN; ; x = Math.min(right, x + STEP)) {
        const under = this.clear.count(x, y, w, h);
        const near = this.clear.count(x - CLEAR, y - CLEAR, w + 2 * CLEAR, h + 2 * CLEAR);
        // the hairline's length: from the subject to the nearest point of the label
        const reach = Math.hypot(Math.max(x - pin.x, 0, pin.x - x - w), Math.max(y - pin.y, 0, pin.y - y - h));
        const score = under * 1e6 + near * 1e3 + reach;
        if (score < bestScore) {
          bestScore = score;
          best = [x, y];
        }
        if (x === right) break;
      }
      if (y === bottom) break;
    }
    return best;
  }

  // anything that comes where the label is sends it to emptier glass; docked, the label can only step aside.
  // On a crowded glass with nowhere emptier to go it stays where it is, rather than blink from place to place
  private watch(play: boolean): void {
    if (DOCKED.matches && !play) return; // the tour's scenes stay above the dock
    const [x, y, w, h] = this.box!;
    const { app } = this;
    let near = this.agentsIn(x - 10, y - 10, w + 20, h + 20);
    if (!near && app.clock - this.checkedAt > CHECK) {
      this.checkedAt = app.clock;
      this.clear.build(app.w, app.h, app.colony, app.camera, this.boxes(false), []);
      near = this.clear.count(x - STAY, y - STAY, w + 2 * STAY, h + 2 * STAY) > 0;
    }
    if (!near) return;
    if (DOCKED.matches) {
      this.aside = true;
      return;
    }
    if (app.clock - this.soughtAt < SEEK) return;
    this.soughtAt = app.clock;
    if (this.emptier()) this.moving = true;
  }

  // whether the glass has a place for the label that is empty, or hides clearly less than where it is
  private emptier(): boolean {
    const [x, y, w, h] = this.box!;
    const { app } = this;
    this.clear.build(app.w, app.h, app.colony, app.camera, this.boxes(true), this.director.footprint());
    const here = this.clear.count(x - STAY, y - STAY, w + 2 * STAY, h + 2 * STAY);
    const [bx, by] = this.choose(this.director.pin(CHAPTERS[this.shown].anchor));
    const there = this.clear.count(bx - STAY, by - STAY, w + 2 * STAY, h + 2 * STAY);
    return there === 0 || there < here * 0.6;
  }

  private agentsIn(x: number, y: number, w: number, h: number): boolean {
    const A = this.app.colony.agents;
    const cam = this.app.camera;
    const z = cam.zoom;
    const ox = cam.viewW / 2 - cam.cx * z;
    const oy = cam.viewH / 2 - cam.cy * z;
    for (let s = 0; s < A.count; s++) {
      if (!A.alive[s]) continue;
      const sx = A.x[s] * z + ox;
      const sy = A.y[s] * z + oy;
      if (sx > x && sx < x + w && sy > y && sy < y + h) return true;
    }
    return false;
  }

  // what is on the glass besides the colony: the page's own furniture, and the words the glass is showing
  private boxes(choosing: boolean): Box[] {
    const out = this.furniture.map(rectOf);
    const shown = ['.finding', '.draft.on', '.label.on', '.word.on', '.legend.on', '.mag.on', '.exposure.on', '.notice.on'];
    if (!document.body.classList.contains('tour')) shown.push('.hint:not(.gone)', '.help');
    // words dissolving into their droplet are gone in a moment: only a label choosing its place minds them
    if (choosing) shown.push('.dissolve');
    for (const e of document.querySelectorAll(shown.map(s => `#glass ${s}`).join(', '))) out.push(rectOf(e));
    return out;
  }

  // the hairline from the subject to its words: it leaves the subject's mark and becomes the label's own rule,
  // above the words or, when the subject is below them, under them. From beside the label it comes in level
  // to the rule's near end; from above or below it drops straight onto the rule
  private lead(pin: Pin, [bx, by, w, h]: Box): Landing['leader'] {
    if (pin.x > bx && pin.x < bx + w && pin.y > by && pin.y < by + h) return null;
    // half a pixel down keeps the level line crisp
    const y = Math.round(pin.y < by + h / 2 ? by : by + h) + 0.5;
    const beside = pin.x < bx || pin.x > bx + w;
    let end: [number, number];
    let elbow: [number, number] | null = null;
    if (beside) {
      const left = pin.x < bx;
      end = [left ? bx : bx + w, y];
      elbow = [end[0] + (left ? -18 : 18), y];
      if (Math.hypot(elbow[0] - pin.x, elbow[1] - pin.y) < pin.r + 12) elbow = null;
    } else end = [Math.min(bx + w - 12, Math.max(bx + 12, pin.x)), y];
    const toward = elbow ?? end;
    const a = Math.atan2(toward[1] - pin.y, toward[0] - pin.x);
    const start: [number, number] = [pin.x + Math.cos(a) * (pin.r + 5), pin.y + Math.sin(a) * (pin.r + 5)];
    return { pin, start, elbow, end, rule: [bx, bx + w, y] };
  }

  private drawLeader(c: CanvasRenderingContext2D, engrave: Engrave): void {
    const L = this.leader;
    if (!L || this.alpha < 0.02) return;
    const a = 0.42 * this.alpha;
    // one stroke, so where the line meets its rule it is no brighter than either
    engrave(() => {
      c.moveTo(L.start[0], L.start[1]);
      if (L.elbow) c.lineTo(L.elbow[0], L.elbow[1]);
      c.lineTo(L.end[0], L.end[1]);
      c.moveTo(L.rule[0], L.rule[2]);
      c.lineTo(L.rule[1], L.rule[2]);
    }, a);
    const p = L.pin;
    if (p.ring === 'dot') engrave(() => c.arc(p.x, p.y, p.r, 0, Math.PI * 2), a * 1.3);
    if (p.ring !== 'circle' && p.ring !== 'pile') return;
    c.setLineDash([3, 4]);
    if (p.ring === 'circle') engrave(() => c.arc(p.x, p.y, p.r, 0, Math.PI * 2), a * 0.8);
    else engrave(() => c.ellipse(p.x, p.y, p.r * 1.7, p.r * 0.85, 0, 0, Math.PI * 2), a * 0.8);
    c.setLineDash([]);
  }

  private key(e: KeyboardEvent): void {
    if (e.altKey || e.ctrlKey || e.metaKey || e.isComposing) return;
    // in the last chapter the arrows aim for the colony; Page Up and Page Down turn the chapters anywhere
    const play = CHAPTERS[this.current].id === 'play';
    // during the tour Esc closes it, as the label's cross does; in the last chapter Esc is the colony's
    if (e.key === 'Escape' && !play) {
      e.preventDefault();
      this.dismiss();
      return;
    }
    const back = e.key === 'PageUp' || (!play && e.key === 'ArrowLeft');
    const on = e.key === 'PageDown' || (!play && e.key === 'ArrowRight');
    if (!back && !on) return;
    e.preventDefault();
    this.go(this.current + (on ? 1 : -1));
  }

  // asks the live colony's server whether it is up, so the way to it says what will be found there
  private checkLive(): void {
    fetch('/live/status', { cache: 'no-store' })
      .then(r => (r.ok ? (r.json() as Promise<{ agents?: number }>) : null))
      .then(s => this.setAwake(s ? s.agents ?? 0 : null))
      .catch(() => this.setAwake(null));
  }

  private setAwake(agents: number | null | undefined): void {
    for (const a of this.links) {
      a.classList.toggle('awake', typeof agents === 'number');
      a.title = typeof agents === 'number' ? 'The live colony is running: real agents on the real web' : 'Real agents on the real web, once the live colony is running';
    }
    if (typeof agents === 'number') this.status.textContent = `Real agents on the real web: the live colony is running, with ${agents.toLocaleString('en-US')} agents.`;
    else this.status.replaceChildren('Real agents on the real web run in the live colony. Start it with ', code('npm run live'), '.');
    // a longer or shorter line changes the label's size: it settles again if it is showing that chapter
    if (this.box && this.shown >= 0 && CHAPTERS[this.shown].id === 'play' && Math.abs(this.label.offsetHeight - this.box[3]) > 1) this.moving = true;
  }
}

// The live colony's own page: a way back to the tour, and word when the live colony cannot be reached
export function liveChrome(root: HTMLElement, runtime: RemoteRuntime): void {
  const mark = el('a', 'mark', root);
  mark.href = '/';
  el('span', 'mark-name', mark, 'Swarm terrarium');
  const note = el('p', 'asleep', root);
  note.append('The live colony is not running. Start it with ', code('npm run live'), ', and this page connects once it is up.');
  let seen = performance.now();
  let waiting = false;
  setInterval(() => {
    if (runtime.state === 'open') seen = performance.now();
    note.classList.toggle('on', runtime.state !== 'open' && performance.now() - seen > 1500);
    // a stream that has given up does not come back by itself: wait for the colony, then start fresh
    if (runtime.state !== 'closed' || waiting) return;
    waiting = true;
    const poll = () =>
      fetch('/live/status', { cache: 'no-store' })
        .then(r => (r.ok ? location.reload() : setTimeout(poll, 4000)))
        .catch(() => setTimeout(poll, 4000));
    setTimeout(poll, 4000);
  }, 500);
}
