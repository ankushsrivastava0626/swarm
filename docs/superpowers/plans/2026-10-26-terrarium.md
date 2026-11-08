# Swarm terrarium implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A full-screen, browser-based terrarium where a simulated agent swarm forages for user objectives, expressed only through flocking, pheromone veins and light.

**Architecture:** A simulated runtime emits protocol events; a CPU colony model maps events to behaviours and runs the physics (typed arrays, spatial hash, coarse pheromone field); a WebGL2 renderer draws a fine pheromone field, droplets, agents, sparks and post effects; a DOM + 2D-canvas glass layer carries all text and engraved marks; an input layer turns pointer and keyboard gestures into runtime commands.

**Tech Stack:** Vite 8, TypeScript 7, Vitest 5, WebGL2, `@fontsource-variable/newsreader`, `@fontsource-variable/archivo`.

**Spec:** `docs/superpowers/specs/2026-10-26-terrarium-design.md`

## Global constraints

- Palette exactly: abyss `#041012`, silt `#10262A`, luciferin `#5FE3C2`, bloom `#E4FFF5`, ember `#FF7442`, bone `#D8D0C0`.
- Ember appears only on agents that are boiling (friction), never alone.
- Fewer than a dozen words on screen at rest; sentence case; no letter-spaced capitals.
- No dialogs, buttons or menus inside the world.
- 60 fps target with ~1,000 agents on a laptop; no per-frame allocations in hot loops.
- Colony pheromone half-life 90 s; user scent half-life 10 s.
- Dissent stays visible (off-beat) for at least 18 s.
- Only the user's hand decides where an instruction lands: drop position is the pointer position at Enter; drifting agents never retarget.
- `prefers-reduced-motion`: long-exposure still refreshed every 4 s.

## Review focus

1. Window resize mid-session: agents, food, trails and the camera must remap, not jump or vanish.
2. Pointer leaving the window mid-drag: the gesture ends cleanly (food dragged out = abandoned; lead/cut = released).
3. Empty colony: all agents busy, or all food completed: nest and readout stay truthful, no division by zero.
4. Typing while a gesture is active, and Space inside a draft: Space types a space, never freezes.
5. Losing the WebGL context or missing float render targets: fall back to RGBA8 targets; on context loss, show a plain message and recover on restore.

---

### Task 1: Scaffold

**Files:** `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `src/main.ts`, `src/style.css`, `src/palette.ts`

- [ ] Vite + TS + Vitest, `npm run dev | build | test | check`.
- [ ] Fonts imported from fontsource; palette tokens exported as hex and linear RGB.
- [ ] Verify: `npm run build` succeeds; `npm test` runs.

### Task 2: Protocol and simulated runtime

**Files:** `src/runtime/protocol.ts`, `src/runtime/simulated.ts`, `src/runtime/writing.ts`, `src/runtime/rng.ts`, `tests/simulated.test.ts`

**Interfaces (produces):**
- `type RuntimeEvent`, `type Command`, `interface Runtime { send(c: Command): void; on(l: (e: RuntimeEvent) => void): () => void; tick(dt: number): void }`
- `class SimulatedRuntime implements Runtime` with `constructor(opts: { seed: number; world: { w: number; h: number }; colony: number })` and `seed(scenario: Scenario): void`.

- [ ] Tests: create → `objective.created` then scouts `agent.assigned` within 2 s; progress events are monotonic and end in `objective.completed` with a non-empty finding; abandon releases every assigned agent; restore re-assigns; enrich raises assigned count; reassign/release move agents; two objectives closer than `0.36 × min(w, h)` emit `objective.related`; a dissenter's stance stays > 0.05 from the group mean for ≥ 18 s; `agent.failed` is followed by a replacement `agent.spawned` without parent.
- [ ] Implement until green.

### Task 3: Fields, spatial hash, camera

**Files:** `src/world/field.ts`, `src/world/spatial.ts`, `src/world/camera.ts`, `tests/field.test.ts`, `tests/spatial.test.ts`, `tests/camera.test.ts`

**Interfaces (produces):**
- `class Field { constructor(w: number, h: number, cell: number, channels: ChannelSpec[]); step(dt: number): void; deposit(ch: number, x: number, y: number, amount: number): void; depositSegment(ch, x0, y0, x1, y1, amount): void; sample(ch: number, x: number, y: number): number; resize(w: number, h: number): void }`
- `class SpatialHash { rebuild(xs: Float32Array, ys: Float32Array, alive: Uint8Array, n: number): void; nearestK(i: number, k: number, maxR: number, out: Int32Array): number; queryRadius(x: number, y: number, r: number, out: Int32Array): number }`
- `class Camera { zoom: number; zoomAt(sx: number, sy: number, factor: number): void; toWorld(sx, sy): [number, number]; toScreen(wx, wy): [number, number]; step(dt): void }`

- [ ] Tests: uniform field halves after one half-life (±1%); diffusion without decay conserves mass (±0.5%); bilinear sample of a single deposit integrates to the amount; `nearestK` equals brute force on 500 random points; `zoomAt` keeps the world point under the cursor fixed.
- [ ] Implement until green.

### Task 4: Colony model

**Files:** `src/world/colony.ts`, `src/world/agents.ts`, `src/world/foods.ts`, `src/world/history.ts`, `tests/colony.test.ts`

**Interfaces (consumes):** Task 2 events, Task 3 field/hash. **(produces):** `class Colony { handle(e: RuntimeEvent): void; step(dt: number): void; deposits: DepositList; agents: AgentArrays; foods: Food[]; nest: Nest; midden: Midden }`.

- [ ] Tests: `agent.assigned` agent reaches its food within 12 s; `agent.released` agent ends inside the nest; `agent.failed` agent ends in the midden zone; `agent.friction` raises jitter and ember mix, `agent.calm` clears ember to 0; five agreeing agents phase-lock (order parameter > 0.9 within 15 s) while a dissenter stays unlocked.
- [ ] Implement until green.

### Task 5: Renderer

**Files:** `src/render/gl.ts`, `src/render/shaders.ts`, `src/render/renderer.ts`

- [ ] Field ping-pong (diffuse, decay, deposit), background (medium, depth, veins, scent, plume, heat), droplets (SDF with bites), agents (instanced, role shapes), husks, sparks, exposure trails, bloom chain, composite (DOF, heat haze, vignette, grain, focus pull).
- [ ] Float targets when available, RGBA8 fallback; context loss handling.
- [ ] Verify in browser by screenshot: veins, droplets, flow, boil, pulse all legible.

### Task 6: Glass

**Files:** `src/glass/glass.ts`, `src/glass/lines.ts`, `src/glass/text.ts`

- [ ] Readout (agents at work, spend per hour, "simulated"), magnification, exposure, hover labels (food, vein, nest, midden, depth), zoomed agent words, damped pinning, first-run hint, hands legend, live region.
- [ ] Verify in browser: word count at rest < 12.

### Task 7: Input and gestures

**Files:** `src/input/gestures.ts`, `src/input/input.ts`, `src/input/undo.ts`, `tests/gestures.test.ts`

**Interfaces (produces):** `classifyDrag(samples: PointerSample[], start: PressTarget): 'lead' | 'cut' | 'move' | 'enrich' | 'pan' | 'pending'`, `cutFrees(agent: [x, y], food: [x, y], stroke: [number, number][]): boolean`, `class UndoStack`.

- [ ] Tests: slow drag from agents → lead; > 1,300 px/s within the first 90 ms → cut; still hold on food ≥ 260 ms → enrich; moving food ≥ 6 px before → move; `cutFrees` true only when the segment to the food crosses the stroke; undo of abandon emits restore.
- [ ] Wire pointer, wheel, keyboard (including keyboard alternatives) to colony, camera, runtime.

### Task 8: Dissolve, crystallize, depth, exposure, reduced motion, opening

- [ ] Dissolve letters into a droplet; crystallize findings; findings sink to the depth layer after 24 s; long exposure on Space; reduced-motion still; focus pull on load after a short pre-warm.
- [ ] Verify in browser.

### Task 9: Performance and polish

- [ ] Measure frame time at 1,000 agents; adaptive render scale; check every Review focus item by hand; screenshot review against the spec's tests (glance, screenshot, hands, screensaver).
