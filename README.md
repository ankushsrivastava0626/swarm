<div align="center">

<a href="https://swarm.ankushsrivastava.me"><img src="docs/assets/hero.webp" width="100%" alt="The Trails chapter of the tour: two questions glow as droplets of food, streams of agents run between them and the nest, and a label pinned to a vein explains stigmergy."></a>

**A swarm of AI agents, drawn as a living ant colony.<br>Watch it forage, share notes, fail and agree, then feed it a question of your own.**

[Live demo](https://swarm.ankushsrivastava.me) ·
[Quick start](#quick-start) ·
[The tour](#the-tour) ·
[Real agents](#run-real-agents) ·
[Controls](#controls) ·
[Architecture](#architecture) ·
[FAQ](#faq)

<img alt="TypeScript 7" src="https://img.shields.io/badge/TypeScript-7-041012?logo=typescript&logoColor=white">
<img alt="WebGL2" src="https://img.shields.io/badge/WebGL2-renderer-041012?logo=webgl&logoColor=white">
<img alt="Vite 8" src="https://img.shields.io/badge/Vite-8-041012?logo=vite&logoColor=white">
<img alt="Node.js 24.14 or later" src="https://img.shields.io/badge/Node.js-24.14%2B-041012?logo=nodedotjs&logoColor=white">
<img alt="Agents on jcode" src="https://img.shields.io/badge/agents-jcode-0f6e5c">
<img alt="MIT license" src="https://img.shields.io/badge/license-MIT-0f6e5c">
<img alt="Live demo" src="https://img.shields.io/badge/demo-swarm.ankushsrivastava.me-5fe3c2?labelColor=041012">

</div>

---

Put a hundred agents on one question and their logs turn to noise. You can't see which are working, which are
stuck, which are running the same search twice, or when they've agreed. **Swarm terrarium** draws the swarm as a
bioluminescent ant colony under a macro lens, so you read it the way a biologist reads a nest: from its motion.
Agents forage for your questions, lay glowing veins of shared context, boil with ember where they're stuck, and
flicker in step when they agree. One gesture changes their work.

- **A tour that acts itself out.** Seven chapters, each an ant behaviour and the agent design it inspired, staged on a simulated colony while a label explains it.
- **Real agents in the same colony.** `npm run live` swaps the simulation for real agents on [jcode](https://jcode.sh): a lead plans, scouts research the web, builders write, a critic reviews, and the answer opens in a new tab with its sources.
- **A thousand agents, waiting for free.** A resting agent holds no session, so it costs nothing until there's work. Hold a droplet and its team grows for as long as you hold.
- **Agents never message each other.** They write notes into a shared nest and read each other's, the way ants mark the ground. Agents merge the notes eight at a time, so a team of hundreds still ends in one answer.
- **Hands, not dashboards.** Type to drop a question, press and hold to recruit, drag to lead agents, flick to cut them loose, scroll to magnify, and undo.
- **Failure you can see.** Trouble glows ember, and a broken agent sinks to the midden while the colony grows a replacement. Rate limits slow the colony down instead of stopping it.
- **Any swarm can drive it.** The world speaks one small event protocol, so an adapter is all another agent framework needs.

## The tour

The front page is a guided tour. Each chapter pins a label to part of a simulated colony while the colony acts it
out, and tells it twice: once as biology, once as the agent design it inspired.

<table>
<tr><td width="50%" valign="top">

<img src="docs/assets/tour/1-colony.webp" width="100%" alt="A round nest of resting agents, with the chapter's label beside it.">

**I. Colony: every light is an agent**<br>
At any moment much of an ant colony is resting, a reserve for whatever turns up. A resting agent holds no session
and costs nothing, so a thousand can wait in the nest.

</td><td width="50%" valign="top">

<img src="docs/assets/tour/2-forage.webp" width="100%" alt="A question has become a droplet of food, and the first scouts leave the nest for it.">

**II. Forage: a question is food**<br>
Scouts wander out, and one that finds food runs home laying a scent trail. Your question lands as a droplet, a lead
agent splits it into tasks, and scouts take them out to search the web.

</td></tr>
<tr><td valign="top">

<img src="docs/assets/tour/3-trails.webp" width="100%" alt="Veins of light run from the nest to two droplets of food.">

**III. Trails: they talk through the ground**<br>
Ants rarely signal each other directly. They mark the ground, and the marks steer whoever comes next. Agents never
message each other either: they write notes into a shared nest, and each glowing vein is that shared context.

</td><td valign="top">

<img src="docs/assets/tour/4-recruit.webp" width="100%" alt="A crowd of agents gathers around one rich droplet.">

**IV. Recruit: rich food draws a crowd**<br>
A forager back from a rich find lays a stronger trail, so more nestmates follow. Press and hold a droplet to make it
richer, and more agents come for as long as you hold.

</td></tr>
<tr><td valign="top">

<img src="docs/assets/tour/5-midden.webp" width="100%" alt="A knot of agents at a droplet glows ember red.">

**V. Midden: the dead are carried out**<br>
Ants carry their dead to a refuse pile and raise new workers in their place. Trouble glows ember: a contradiction, a
failing tool, a rate limit. An agent that breaks sinks to the midden, and the colony grows a replacement.

</td><td valign="top">

<img src="docs/assets/tour/6-quorum.webp" width="100%" alt="The droplet has crystallized, and its answer is written on the glass above it.">

**VI. Quorum: enough of them agree**<br>
Scouts choosing a new home wait for a quorum, then all commit at once. Critics score the work, and their lights
flicker in step as they agree. Then the lead writes the finding, and the food crystallizes into an answer.

</td></tr>
<tr><td valign="top">

<img src="docs/assets/tour/7-your-turn.webp" width="100%" alt="The last chapter's label invites you to type a question for the colony.">

**VII. Your turn: feed it something**<br>
The colony is yours. Type anywhere to drop a question, press and hold food to enrich it, or drag slowly from agents
to lead them.

</td><td valign="middle" align="center">

**[Take the tour](https://swarm.ankushsrivastava.me)**<br>
<sub>It runs in any browser with WebGL2.<br>Move with ← and →, or press Esc to skip to your turn.</sub>

</td></tr>
</table>

Move with <kbd>←</kbd> <kbd>→</kbd>, the chapter list, or each label's Next. Every chapter has its own address, such
as `/#quorum`, and one visited out of order sets up what its scene needs first. A label only ever sits on empty
glass: it takes the empty place nearest what it describes, clear of what its scene is about to do. The × on any
label, or <kbd>Esc</kbd>, puts the tour away and hands you the colony.

## Quick start

You'll need [Node.js](https://nodejs.org) 24.14 or later and a browser with WebGL2.

```bash
git clone https://github.com/ankushsrivastava0626/swarm.git && cd swarm
```

```bash
npm install
```

```bash
npm run dev
```

Open http://localhost:5199 for the tour. Add `?colony=1000` to the address for a bigger or smaller colony (anything
from 50 to 1,100; the default is 700), or `?basic-gl` to try the fallback for GPUs without half-float render targets.

| Script | What it does |
|---|---|
| `npm run dev` | The tour, and the live colony's page at `/live`, on port 5199 |
| `npm run live` | The live colony of real agents, on port 5198 |
| `npm run build` | A production build in `dist/` |
| `npm test` | The test suite, on Vitest |
| `npm run check` | Type-checks the site and the server |

## Run real agents

The colony on the website is a simulation. On your own machine, the same colony can run real agents.

1. Install [jcode](https://jcode.sh) and log it in to [OpenRouter](https://openrouter.ai) with `jcode login`. Every agent runs `inception/mercury-3` unless you set `LIVE_MODEL`.
2. Give the agents a way to search: `GOOGLE_API_KEY` and `GOOGLE_CSE_ID`, or `SERPER_API_KEY`, for Google results, or [SearXNG](https://github.com/searxng/searxng) running at `http://127.0.0.1:8888` with its JSON format turned on. Without either, agents can still read pages but not search.
3. Start the colony, with `npm run dev` running beside it:

```bash
npm run live
```

4. Open http://localhost:5199/live and drop a question. When the colony finishes, the answer opens in a new tab.

### How a question becomes an answer

| Phase | What the agents do |
|---|---|
| **Plan** | A lead agent splits your question into tasks and plans a team for them. |
| **Research** | Scouts search and read the web, and each writes a note into the question's folder in the shared nest. Extra agents take second looks at the same tasks, each from a different angle. |
| **Write** | Builders write the answer from the scouts' notes. Past eight notes, agents first merge them eight at a time. |
| **Review** | A critic scores the work and can send it back once for fixes. |
| **Decide** | The lead writes the finding. The answer, with its sources, opens in a new tab and is saved in `live/findings/`. |

- **One private jcode server runs the whole colony.** It uses jcode's logins on this machine, can't see your own jcode sessions, and stops with the colony.
- **Agents can only search, read and take notes.** Each is its own jcode session with web search, web fetch and three note tools that write only inside `live/nest/`. jcode's shell, mail, calendar, browser and computer use stay off.
- **Teams have no ceiling.** Holding a droplet adds three agents every 0.4 seconds, for as long as you hold, and every agent you lead to it joins. The only hard limit is the 1,600 agents the world can draw.
- **Gestures act on the real agents.** Cut agents loose and their turns stop, their tasks go back on the list, and the team stays thin for a minute. Abandon a droplet and every turn on it stops; undo starts it again.
- **Failures are handled, not hidden.** A rate limit or a provider hiccup sends work back to wait, longer each time. When the provider turns work away, the colony keeps fewer turns in flight and raises the number again as turns go through. Work the model declines goes back to the nest; anything else sends its agent to the midden, and the colony grows a replacement.
- **Spend is on the readout.** For models reached through OpenRouter, it's the list price times the tokens each agent used in the last minute, in dollars an hour.
- **It's light.** On an M2 MacBook Air the jcode server takes about 40 MB, and each working agent about 4.5 MB. New turns wait while the jcode server uses more than 60% of the machine's memory.

Every answer is listed at http://127.0.0.1:5198/live/findings, the colony's state is at
http://127.0.0.1:5198/live/status, and the agents' working notes, one folder per question, are in `live/nest/`.

## Controls

In the tour's last chapter, and always on `/live`:

| Do this | And |
|---|---|
| Type anywhere, then <kbd>Enter</kbd> | Your words dissolve into a droplet of food where you point, and the colony goes for it |
| Press and hold a droplet | Enriches it, so more of the colony comes |
| Drag slowly from agents | They follow your scent. Let go on food to reassign them, or on the nest to rest them |
| Flick fast through agents | Cuts them loose from their food |
| Drag a droplet | Moves it. Drop it off the edge of the screen to abandon it |
| Scroll | Magnifies under the pointer, and agents say what they're doing |
| Hold <kbd>Space</kbd> | Freezes time into a six-second long exposure |
| <kbd>⌘</kbd> <kbd>Z</kbd> or <kbd>Ctrl</kbd> <kbd>Z</kbd> | Undoes the last change |

Everything works from the keyboard too: arrows aim, <kbd>Tab</kbd> picks food, <kbd>Enter</kbd> picks it up and
puts it down, holding <kbd>Shift</kbd> <kbd>Enter</kbd> enriches it, <kbd>Delete</kbd> cuts or abandons,
<kbd>Alt</kbd> <kbd>↑</kbd> and <kbd>Alt</kbd> <kbd>↓</kbd> magnify, and <kbd>Alt</kbd> <kbd>H</kbd> lists every
key. On a touch screen, tap where you want food and type, and pinch to magnify.

## Architecture

```mermaid
flowchart TB
  subgraph browser["In your browser"]
    direction LR
    you(["You"]) -->|"gestures"| input["input/<br/>pointer, keys, undo"]
    tour["landing/<br/>the tour"] -->|"scenes"| rt["runtime/<br/>simulated or remote"]
    input -->|"commands"| rt
    rt -->|"events"| world["world/<br/>the colony"]
    world --> draw["render/, glass/<br/>WebGL2, labels, readout"]
  end
  subgraph machine["On your machine, with npm run live"]
    direction LR
    live["server/live.ts<br/>port 5198"] --> swarm["server/swarm.ts<br/>plan, research, write,<br/>review, decide"]
    swarm --> jcode["server/jcode.ts<br/>a jcode session<br/>per working agent"]
    jcode <--> nest[("live/nest/<br/>shared notes")]
  end
  browser <-->|"events and commands, over /live/"| machine
  machine -->|"model calls"| model[("OpenRouter")]
  machine -->|"search and fetch"| web[("Google, SearXNG, the web")]
```

- **`src/landing/`** is the tour: its chapters, the director that stages each scene, and the labels that find empty glass.
- **`src/world/`** is the colony: behaviour, physics, the pheromone field and the camera.
- **`src/render/`** draws it in WebGL2: veins, droplets, agents, the long exposure and the lens.
- **`src/glass/`** is everything a person reads: the readout, labels, answers and engraved lines.
- **`src/input/`** turns pointer, keyboard and touch into gestures, and keeps the undo history.
- **`src/runtime/`** holds the protocol, the simulated swarm, and the remote runtime that `/live` uses.
- **`server/`** is the live colony: its phases (`swarm.ts`), the jcode engine and the agents' tools (`jcode.ts`), what each role is told (`briefs.ts`), and the server and answer pages (`live.ts`, `page.ts`).

The design rules the colony keeps, such as one readout always on and fewer than a dozen words on screen at rest, are
in the [design notes](docs/superpowers/specs/2026-10-26-terrarium-design.md).

## Configuration

The live colony reads these from the environment.

| Setting | Default | What it does |
|---|---|---|
| `LIVE_MODEL` | `inception/mercury-3` | The model every agent runs, through jcode's logins |
| `LIVE_COLONY` | `1000` | Agents resting in the nest at the start, up to 1,600 |
| `LIVE_MAX_WORKING` | no limit | Agents at work at once |
| `LIVE_MEMORY_MB` | 60% of memory | New turns wait while the jcode server uses more than this |
| `LIVE_OPEN` | on | `0` stops answers opening in a new tab |
| `LIVE_PORT` | `5198` | The live colony's port |
| `LIVE_DIR` | `live/` | Where the shared notes and the answers go |
| `LIVE_PROXY` | none | A proxy, such as `http://user:pass@host:port`, for every request the colony makes |
| `GOOGLE_API_KEY`, `GOOGLE_CSE_ID` | none | Google's Programmable Search API, for the agents' web search |
| `SERPER_API_KEY` | none | Google results through Serper, instead of the API above |
| `SEARXNG_URL` | `http://127.0.0.1:8888` | The open-source search engine used when Google isn't set up or finds nothing |
| `JCODE_BINARY` | `~/.local/bin/jcode` | The jcode to run |

## Bring your own swarm

The world only listens to the protocol in [`src/runtime/protocol.ts`](src/runtime/protocol.ts): agent and objective
events in, gesture commands out. Write an adapter that implements `Runtime`, construct it in
[`src/app.ts`](src/app.ts) instead of the simulation, and your swarm moves in the colony.

```ts
export interface Runtime {
  // true while the swarm is the simulation; the readout says so
  readonly simulated: boolean;
  send(command: Command): void;
  on(listener: (event: RuntimeEvent) => void): () => void;
  // advance simulated time; adapters for real agents ignore it
  tick(dt: number): void;
}
```

| Event | In the colony |
|---|---|
| `agent.spawned` | A new light comes out of the nest, or buds from its parent |
| `agent.assigned` | It's drawn to its objective's food |
| `agent.context` | Writing or reading shared notes lays a vein back to the nest |
| `agent.stance` | Agents with close stances flicker in unison, so agreement is something you see |
| `agent.friction` | Contradicting, retrying or failing a tool, it boils ember until it calms |
| `agent.failed` | It goes dark and sinks to the midden |
| `objective.progress` | The food is eaten in bites |
| `objective.completed` | The droplet crystallizes into its answer |

Map your agents' lifecycle, effort, shared-context reads and writes, hand-offs, disagreements and failures onto these
events, and carry out the commands. Report `cost`, in dollars an hour, on `agent.effort` and the readout shows spend.
The world never estimates money, so with no cost reported the figure stays hidden.

## FAQ

<details>
<summary><b>Is the colony on the website real?</b></summary>

No. The website runs the tour on a simulated colony, so nothing there costs money or touches the web. Real agents run
on your own machine with `npm run live`; see [Run real agents](#run-real-agents).
</details>

<details>
<summary><b>What does the live colony cost?</b></summary>

The tour is free. Real agents pay your model provider per token, and a resting agent costs nothing. With the default
`inception/mercury-3` on OpenRouter, the readout shows what the colony spends, in dollars an hour, as it works.
</details>

<details>
<summary><b>Can I use another model?</b></summary>

Yes. Set `LIVE_MODEL` to any model jcode can reach with the logins on your machine. Spend shows only for models reached
through OpenRouter, because that's where the colony finds list prices.
</details>

<details>
<summary><b>Can the agents touch my files or run commands?</b></summary>

No. Each agent can search the web, fetch pages, and use three note tools that write only inside `live/nest/`. jcode's
shell, mail, calendar, browser and computer use stay off, and the colony's jcode server can't see your own jcode
sessions. Answer pages carry no scripts, and their links go only to http and https addresses.
</details>

<details>
<summary><b>How big can a team get?</b></summary>

As big as you hold it. Holding a droplet adds three agents every 0.4 seconds, up to the 1,600 the world can draw.
Hundreds of turns at once need enough provider credit to cover them; when the provider turns work away, the colony
slows down, then speeds up again on its own.
</details>

<details>
<summary><b>Does it work on a phone?</b></summary>

Yes, in any browser with WebGL2. The label docks along the bottom, the chapters run across the top, and you tap where
you want food and type. Pinch to magnify.
</details>

<details>
<summary><b>Why an ant colony?</b></summary>

Ants already solved the problems a swarm of agents has: keeping a reserve idle until there's work, finding food
without a map, sharing what they find without talking, sending more help where it pays, clearing away failure, and
deciding together. Each chapter of the tour is one of those, and the agent design it inspired.
</details>

## Contributing

Issues and pull requests are welcome. Before you open a pull request, run `npm run check` and `npm test`, and read the
[design notes](docs/superpowers/specs/2026-10-26-terrarium-design.md) for the rules the colony keeps.

## Thanks

Swarm terrarium stands on [jcode](https://jcode.sh), [OpenRouter](https://openrouter.ai), Inception's
[Mercury](https://www.inceptionlabs.ai), [Vite](https://vite.dev), [Vitest](https://vitest.dev),
[SearXNG](https://github.com/searxng/searxng), and the [Syne](https://fonts.google.com/specimen/Syne) and
[Instrument Sans](https://fonts.google.com/specimen/Instrument+Sans) typefaces through
[Fontsource](https://fontsource.org).

## Star history

<a href="https://star-history.com/#ankushsrivastava0626/swarm&Date">
  <img alt="Star history chart" src="https://api.star-history.com/svg?repos=ankushsrivastava0626/swarm&type=Date" width="600">
</a>

## License

[MIT](LICENSE) © 2026 Ankush Srivastava. Swarm terrarium isn't affiliated with jcode, OpenRouter, Inception or any
of the projects above.
