// Drives the real Input class in Node: stand-ins for the page, the glass and the app, real colony and runtime.
import type { RuntimeEvent } from '../src/runtime/protocol';
import { SimulatedRuntime } from '../src/runtime/simulated';
import { Camera } from '../src/world/camera';
import { Colony } from '../src/world/colony';
import { Input } from '../src/input/input';

export const W = 1000;
export const H = 700;

class Field extends EventTarget {
  value = '';
  focus(): void {
    page.activeElement = this;
  }
  blur(): void {
    if (page.activeElement === this) page.activeElement = null;
  }
}

const page: { activeElement: unknown } = { activeElement: null };

export function harness() {
  const field = new Field();
  const form = new EventTarget();
  const stage = Object.assign(new EventTarget(), { setPointerCapture() {} });
  const windowListeners = new Map<string, (e: unknown) => void>();
  page.activeElement = null;
  Object.assign(globalThis, {
    document: {
      get activeElement() {
        return page.activeElement;
      },
      getElementById: (id: string) => (id === 'draft' ? field : id === 'draft-form' ? form : null),
    },
    addEventListener: (type: string, fn: (e: unknown) => void) => windowListeners.set(type, fn),
  });
  const runtime = new SimulatedRuntime({ seed: 3, world: { w: W, h: H }, colony: 60, backlog: false });
  const colony = new Colony({ w: W, h: H, seed: 5 });
  const events: RuntimeEvent[] = [];
  runtime.on(e => {
    colony.handle(e);
    events.push(e);
  });
  const app = { w: W, h: H, camera: new Camera(W, H), colony, runtime, frozen: false, freeze() {}, clock: 0, hand: { x: 0, y: 0, reach: 0, pressure: 0 }, hoverFood: -1 };
  const glass = { announce() {}, hideHint() {}, setLegend() {}, legendOpen: false, dissolve() {}, draftAt: { x: 0, y: 0 } };
  const input = new Input(app as never, stage as never);
  input.attach(glass as never);

  // a key press as the window sees it; returns whether the page kept the key's default action from happening
  const key = (k: string, opts: Record<string, unknown> = {}) => {
    let prevented = false;
    const code = k.length === 1 ? `Key${k.toUpperCase()}` : k;
    windowListeners.get('keydown')!({ key: k, code, repeat: false, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, keyCode: 0, preventDefault: () => (prevented = true), ...opts });
    return prevented;
  };
  // what the text field holds after the person's edit
  const type = (text: string) => {
    field.value = text;
    field.dispatchEvent(new Event('input'));
  };
  const food = (text: string, x: number, y: number) => {
    runtime.send({ type: 'objective.create', text, x, y });
    input.aim = { x, y };
    return colony.foods[colony.foods.length - 1];
  };
  return { input, app, colony, runtime, events, key, type, food, field };
}
