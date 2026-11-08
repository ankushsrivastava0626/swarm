# Swarm terrarium: design

Approved in conversation on 2026-10-26. This records the vision as approved, plus the build calls made afterwards.

## Intent

A living observatory for a swarm of AI agents. Opening it should feel like looking through a macro lens at a bioluminescent ant colony: you read the swarm's state from motion in one second, and you change its work with one gesture.

## Principles

- **Motion is the data.** Nothing moves without a reason you could name. An idle colony settles and dims, so calm means healthy.
- **You garden; you don't command.** Every action changes the environment (food, scent, a cut) and the agents' own rules respond. The simulation never pauses to take input.
- **Space is the only structure.** Things near each other are related. Connections exist only where work flowed recently.

## Anti-goals

No node-and-wire graphs, no cards or columns, no chat bubbles, no avatars, no dialogs, no configuration panels, no status badges, no motion for its own sake.

## Layers

| Layer | Contents | Character |
|---|---|---|
| Glass | crosshair, engraved marks, the words you type, labels, readouts | bone, matte, crisp, still |
| Focal plane | agents, food droplets, sparks | glowing, alive |
| Substrate | pheromone veins (colony memory), your scent trails | glowing (veins), matte (your scent) |
| Depth | finished findings and abandoned work | out of focus, dim |

Glass rules: the colony fills the screen; readouts sit at the edges like viewfinder numbers; one readout is always on (agents at work, spend per hour); fewer than a dozen words on screen at rest; labels pin to what they describe but move with damping; the first second is a focus pull onto a colony already in motion.

## Palette

| Token | Hex | Use |
|---|---|---|
| Abyss | `#041012` | the medium |
| Silt | `#10262A` | old, faint pheromone |
| Luciferin | `#5FE3C2` | the colony's light |
| Bloom | `#E4FFF5` | luciferin at full strength |
| Ember | `#FF7442` | friction only, always with boiling motion |
| Bone | `#D8D0C0` | everything a person made; never glows (in the world: a person's scent, and droplets) |
| Snow | `#F3F1EC` | the glass's words and engraved lines, since the landing page; matte, never glows |

## Type

- Instrument Sans. Italic is the user's words. Roman is the colony's words. Syne sets the landing page's chapter titles and the name. (Newsreader, then IM Fell English, before the landing page settled on gallery wall text.)
- Instrument Sans narrowed to 78%, tabular digits. Numbers only.
- Sentence case, small, no letter-spaced capitals, no headings, buttons or menus inside the world.

## Touch

The glass responds within a frame. The world starts responding immediately but takes about a second to finish, with weight. Nothing snaps or teleports.

| Gesture | Effect |
|---|---|
| Hover, still | agents within reach turn toward the cursor (no change to their work) |
| Hover, moving through | agents part like water |
| Hover, quick pass | one turn ripples through the flock along 7 topological neighbours |
| Type anywhere, Enter | words form at the cursor, then dissolve into a food droplet there |
| Drag slowly from agents | lays a bone scent trail; those agents follow; released on food = reassigned, on the nest = released |
| Flick fast through agents | cuts: agents whose path to their food crosses the stroke are freed |
| Drag food | moves it; off the screen edge abandons it (sinks out of focus); Cmd/Ctrl+Z restores |
| Press and hold food | enriches it: scent spreads farther, more of the colony is drawn in |
| Hold Space | freezes time; the view becomes a long exposure of the last 6 seconds |
| Scroll | magnifies under the cursor; everything outside focus blurs; words appear on agents |

## Signature behaviours

1. **Veins.** Agents deposit pheromone as they carry context; others follow it. The ground diffuses it and forgets it (half-life 90 s). Veins thicken with traffic and wither when abandoned. Hovering a vein names what moves through it.
2. **Flow, boil, pulse.** Flow is progress (smooth streams, calm feeding). Boil is friction (jitter, collision, heat haze, ember at the centre, no net motion). Pulse is agreement (firefly flicker that locks into unison; a dissenter stays off the beat for at least 18 s).
3. **Dissolve, forage, crystallize.** Typed words dissolve into a droplet; idle agents find it, taste it and return laying trail; recruitment snowballs; the droplet is eaten in bites; on completion the glow condenses into upright type (the finding), which later sinks into the depth layer.

## Contract

| Agent is | You see |
|---|---|
| working on an objective | drawn to its food; the food shrinks in bites |
| thinking hard | faster and brighter |
| writing / reading shared context | lays / follows pheromone |
| handing off | a spark passes between two agents |
| agreeing | flicker locks to the group |
| contradicting, failing, retrying | boils; retry draws loops; indecision zigzags between two foods |
| spawning helpers | buds new agents; helpers merge back when done |
| idle | returns to the nest and dims; nest size = spare capacity |
| failed or stopped | goes dark, sinks to the midden in the corner (hover for the error log) |
| holding a role | scout, builder, critic differ in body and gait, never colour |

## Build calls (made after approval)

- **Platform:** browser, Vite + TypeScript, no UI framework. WebGL2 for the world, DOM for glass text, a 2D canvas for engraved glass lines.
- **Data:** a simulated runtime emits the same events a real agent runtime would (`src/runtime/protocol.ts`). Swapping in real agents means writing an adapter for that interface.
- **Pheromone:** two fields fed by the same deposits: a fine GPU field for looks, a coarse CPU field for agents to smell. Your scent decays faster (half-life 10 s) so it reads as a gesture, not clutter.
- **Abandon edge:** releasing a dragged food within 14 px of the window edge (or outside it) abandons it, at any zoom.
- **Nest** sits at the centre; the **midden** in the bottom-right corner.
- **Keyboard:** arrows aim, typing drafts, Enter drops or picks up and puts down, Tab cycles food, Delete cuts or abandons, hold Shift+Enter to enrich, Alt+↑ and Alt+↓ magnify, Space freezes, Cmd/Ctrl+Z undoes, Alt+H shows the full list. Keys that edit words (Backspace, Delete, Cmd/Ctrl+Z) belong to the draft while there is one, and for a second after it was last edited.
- **Touch:** tap open ground to type there; two fingers pinch to magnify and pan; drags never open the keyboard.
- **Cutting:** a cut thins a team for 60 s (as long as the freed agents stay away) but never below the few hands its phase needs; leading agents back, or undoing the cut, lifts the limit.
- **Depth layer:** the eight newest findings stay in view, fainter with age, each moved aside so none covers another.
- **Midden:** the pile keeps 48 husks; the oldest crumbles as a new one lands. The hover log keeps the last 30 failures.
- **Window size:** the world follows the window; sizes under 64 px (a hidden frame, a collapsed pane) are ignored. Undo remembers places as fractions of the world, so it survives a resize.
- **Reduced motion:** no opening focus pull; the colony is shown as a long-exposure still that refreshes every 4 s; teams that agree share a steady halo.
- **Honesty:** the readout carries the word "simulated" while the runtime is the simulation. Spend comes from the cost the runtime reports with each agent's effort; the world never estimates money, and the figure hides when no cost is reported.
- **Stress test:** `?colony=N` (50 to 1,100) runs a bigger or smaller simulated colony.
