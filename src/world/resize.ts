// The world follows the window. A window squeezed below a usable size (a hidden frame, a collapsed pane)
// is ignored, so the world stays whole until there is room again.
import type { Runtime } from '../runtime/protocol';
import type { Camera } from './camera';
import type { Colony } from './colony';

export const MIN_WORLD = 64;

export interface World {
  w: number;
  h: number;
  readonly colony: Colony;
  readonly camera: Camera;
  readonly runtime: Runtime;
}

// returns whether the world changed size
export function resizeWorld(world: World, w: number, h: number): boolean {
  if (!(w >= MIN_WORLD && h >= MIN_WORLD) || (w === world.w && h === world.h)) return false;
  world.colony.resize(w, h);
  world.camera.resize(w, h);
  world.runtime.send({ type: 'world.resize', w, h });
  // the runtime's objectives move with the world
  for (const f of world.colony.foods) {
    if (f.status !== 'completed') world.runtime.send({ type: 'objective.move', objective: f.id, x: f.tx, y: f.ty });
  }
  world.w = w;
  world.h = h;
  return true;
}
