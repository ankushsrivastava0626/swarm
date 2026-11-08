# Swarm terrarium

A living observatory for a swarm of AI agents. The swarm is drawn as a bioluminescent ant colony under a macro lens: agents forage for your objectives, lay glowing veins of shared context, boil with ember where they are stuck, and flicker in unison when they agree. You read the colony from its motion and change its work with one gesture.

The front page is a tour: seven chapters, each a label pinned to part of a simulated colony while the colony acts it out, explaining how the swarm works through the biology it borrows from. The last chapter hands that colony to you, and `/live` watches real agents. Everything runs on your own machine: clone this repo and see [Run real agents with jcode](#run-real-agents-with-jcode).

## Run it

```bash
npm install
```

```bash
npm run dev
```

Then open http://localhost:5199. Other scripts: `npm test` (Vitest), `npm run check` (TypeScript), `npm run build` (production build in `dist/`).

It needs a browser with WebGL2. Where half-float render targets are missing it falls back to 8-bit targets; add `?basic-gl` to the address to see that path. Add `?colony=1000` (anything from 50 to 1,100) to run a bigger or smaller colony; the default is 700.

## The tour

| Chapter | The label | What the colony does |
|---|---|---|
| I · Colony | Every light is an agent, and most rest in the nest | Nothing yet: it rests |
| II · Forage | A question is food; scouts find it | A question types itself, dissolves into a droplet, and scouts leave for it |
| III · Trails | Stigmergy: agents talk through shared notes, not to each other | Builders stream out, veins thicken, and a related question lands nearby |
| IV · Recruit | Rich food draws a crowd | A held press enriches the droplet, and more agents come |
| V · Midden | The dead are carried out | A knot of agents boils ember; one goes dark, sinks to the midden, and is replaced |
| VI · Quorum | Enough of them agree | The critics' lights fall into step, one dissenter last, and the droplet crystallizes into its answer |
| VII · Your turn | This colony is yours | Your keys and pointer reach it; the label says whether the live colony is running |

Move with ← and →, the chapter list on the right, or each label's Next; Page Up and Page Down work in every chapter, including the last, where the arrow keys aim for the colony instead. Each chapter has an address, such as `#quorum`. A chapter visited out of order sets up what its scene needs first.

A label is words on the glass with no box: the hairline from what it describes turns level and runs on as its rule, above the words or, when the subject is below them, under them. It only ever sits on empty glass, never over agents, trails, food, answers or the page's own controls. It takes the empty place nearest what it describes, keeping clear of what that chapter's scene is about to do, stays there, and moves to emptier glass if anything comes near; where no glass is emptier, as on a colony you have fed, it stays where it is rather than hop around. In Your turn the label steps aside after 15 seconds, or while you magnify; choose Your turn in the chapter list to bring it back. Every label has a cross: it puts the tour away and hands you the colony as Your turn does, with no label in the way, and Esc does the same during the tour. Back to the tour, in the bottom right corner, then picks it up where you left it, as does choosing any chapter. On a small screen the label docks along the bottom, the nest and the midden move up so the colony stays clear of it, and the chapters run across the top.

The glass reads like wall text in a gallery: Instrument Sans for every word, narrowed for numbers, and Syne for the chapter titles and the name, all in snow white (`#F3F1EC`).

## Hands

On the front page these work in the tour's last chapter, Your turn; on `/live` they always do.

| Gesture | What happens |
|---|---|
| Type anywhere, then Enter | Your words dissolve into a droplet of food where you point; the colony finds it |
| Drag slowly from agents | They follow your scent; let go on food to reassign them, on the nest to rest them |
| Flick fast through agents | Cuts them loose from their food |
| Drag food | Moves it; drop it off the edge of the screen to abandon it |
| Press and hold food | Enriches it, so more of the colony comes |
| Hold Space | Freezes time into a 6-second long exposure |
| Scroll | Magnifies under the cursor; agents say what they are doing |
| Cmd+Z or Ctrl+Z | Undoes the last change |

Keyboard: arrows aim, Tab picks food, Enter picks up and puts down, hold Shift+Enter to enrich, Delete cuts or abandons, Alt+↑ and Alt+↓ magnify, Alt+H shows the full list. On a touch screen, tap where you want food and type; pinch to magnify.

## Connect real agents

The world only listens to the protocol in `src/runtime/protocol.ts`: agent and objective events in, gesture commands out. `SimulatedRuntime` in `src/runtime/simulated.ts` speaks it today. To watch a real swarm, write an adapter that implements `Runtime` (map your agents' lifecycle, effort, shared-context reads and writes, hand-offs, disagreements and failures onto those events, and carry out the commands), then construct it in `src/app.ts` instead of the simulation. Set `simulated` to false and the readout drops the word.

The spend figure is whatever your adapter reports as `cost` (dollars an hour) on each `agent.effort` event. The world never estimates money: if no cost is reported, the figure stays hidden.

## Run real agents with jcode

```bash
npm run live
```

This starts the live colony: real agents on [jcode](https://jcode.sh), on whatever jcode is logged in to on this machine (`jcode login`) and the model it uses by default, whether that is a Claude login, an OpenRouter key or anything else jcode has. With `npm run dev` running too, open http://localhost:5199/live (or the tour's Go live link, whose light shows when the live colony is running) and drop objectives as usual. The old `?live` address lands there too. If the live colony isn't running, the page says so and connects once it is up. Stop the colony with Ctrl+C.

- **One private jcode server runs the whole colony.** It shares jcode's logins on this machine and nothing else of your jcode: it can't see your own jcode sessions, and it stops with the colony. Its agents spend those logins' quota, and on a subscription login a big team reaches the plan's usage limits quickly.
- **Each agent is a jcode session** with web search, web fetch and three note tools. jcode's shell, mail, calendar, browser and computer use stay off, and the note tools write only inside `live/nest/`, each objective in its own folder.
- **The simulation's phases, done for real.** A lead plans the tasks. Scouts research, then builders make the answer from their notes. A critic scores the notes and can send them back once for fixes. The lead writes the finding. The full answer, with sources, opens in a new tab of your browser and is saved in `live/findings/`; nothing is left written on the world, and a restarted colony starts with an empty one.
- **Teams have no ceiling.** The lead plans a team for the work; holding the droplet grows it by three agents every 0.4 s held, for as long as you hold, and each agent you lead to it joins too. The agents you ask for leave the nest at once and stand by at the droplet until there is work for them, as while the lead is still planning. While the scouts are out, new agents take second looks at their tasks, each from a different angle; after that, they join the critics. Once there are more than eight scout notes, agents merge them eight at a time, so even a team of hundreds ends in one answer. Undo gives the agents back. The only hard limit is the world's 1,600 agents.
- **Gestures act on the real agents.** Cut agents loose and their turns stop, their tasks go back on the list, and the team stays thin for a minute. Abandon a droplet and every turn on it stops; undo starts it again.
- **Failures.** A rate limit or a provider hiccup sends work back to wait, longer each time, and the agent keeps going. When the provider turns work away, for a rate limit, a usage limit, or because the requests in flight would exceed your credit, the colony keeps fewer turns in flight and raises the number again as turns go through; hundreds at once need enough credit to cover them. Work the model declines is dropped, and its agent goes back to the nest. Anything else sends the agent to the midden, and the colony grows a replacement.
- **What the readout shows.** Every dot is an agent; resting dots cost nothing until they start a task. Where jcode reaches the model through OpenRouter, spend is OpenRouter's list price times the tokens each agent used in the last minute, as dollars an hour; on any other login, such as a subscription, the readout shows no spend.
- **Memory**, measured on an M2 MacBook Air: about 40 MB for the jcode server and 4.5 MB for each working agent. A resting agent holds no jcode session, so the nest of a thousand costs nothing until they work. New turns wait, and nothing is dropped, while the jcode server uses more than 60% of the machine's memory.
- **Output.** Each finished answer opens in a new tab, as a page of its own, and every one is listed at http://127.0.0.1:5198/live/findings. Each is also a markdown file in `live/findings/`. The agents' working notes are in `live/nest/`, one folder per objective, with the plan, every scout's and builder's note, the digests and the fixes.

Settings: `LIVE_MODEL` (default `inception/mercury-3`, on OpenRouter), `LIVE_COLONY` (agents in the nest at the start, default 1,000, at most 1,600), `LIVE_MAX_WORKING` (agents at work at once; no limit unless set), `LIVE_MEMORY_MB` (the memory budget above), `LIVE_OPEN` (`0` stops answers opening in a new tab), `LIVE_PORT` (5198), `GOOGLE_API_KEY` and `GOOGLE_CSE_ID` (Google's Programmable Search API), or `SERPER_API_KEY` (Google results from Serper): the agents search with Google, in place of jcode's own search, which scrapes DuckDuckGo, and fall back to the open-source SearXNG at `SEARXNG_URL` (default `http://127.0.0.1:8888`, with its JSON format turned on) when Google is not set up or finds nothing, `LIVE_PROXY` (a proxy, such as `http://user:pass@host:port`, that every request the colony makes goes through: to the model, to the web, and for prices), `LIVE_DIR` (`live/`) and `JCODE_BINARY` (default `~/.local/bin/jcode`). The colony's state is at http://127.0.0.1:5198/live/status.

## Where things are

- `src/landing/` the tour: its chapters, the director that stages each scene on the simulation, and the labels
- `src/runtime/` the protocol, the simulated swarm, and the live runtime the `/live` page uses
- `server/` the live colony: real jcode agents, and the server that streams them to the page
- `src/world/` the colony: behaviour, physics, pheromone field, camera
- `src/render/` WebGL2 drawing: veins, droplets, agents, long exposure, lens
- `src/glass/` everything a person reads: readout, labels, findings
- `src/input/` pointer, keyboard and touch gestures, and undo
- `docs/superpowers/` the approved design and the build plan
