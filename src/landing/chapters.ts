// The landing page's chapters: how the swarm works, told through the biology it borrows from.
// Each one is a label pinned to what it describes, while the colony acts it out.

// what a chapter's label is pinned to
export type Anchor = 'nest' | 'story' | 'trail' | 'midden' | 'hint';

export interface Chapter {
  id: string;
  name: string; // in the list of chapters
  heading: string; // above the title on the label
  title: string;
  biology: string;
  swarm: string;
  anchor: Anchor;
}

export const PLATES = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

export const CHAPTERS: Chapter[] = [
  {
    id: 'colony',
    name: 'Colony',
    heading: 'The colony',
    title: 'Every light is an agent',
    biology: 'At any moment, much of an ant colony is resting: a reserve of workers waiting in the nest for whatever turns up.',
    swarm: 'Here, each light is an AI agent. A resting one holds no session and costs nothing, so a thousand can wait in the nest.',
    anchor: 'nest',
  },
  {
    id: 'forage',
    name: 'Forage',
    heading: 'Foraging',
    title: 'A question is food',
    biology: 'Scouts wander out at random. One that finds food tastes it, then runs home laying a scent trail.',
    swarm: 'Here, your question lands as a droplet. A lead agent splits it into tasks, and scouts take them out to search the web.',
    anchor: 'story',
  },
  {
    id: 'trails',
    name: 'Trails',
    heading: 'Trails',
    title: 'They talk through the ground',
    biology: 'Ants rarely signal one another directly. They mark the ground, and the marks steer whoever comes next: walked trails brighten, unused ones fade. Biologists call it stigmergy.',
    swarm: 'Here, agents never message each other. They write notes into a shared nest and read each other’s. Each glowing vein is that shared context.',
    anchor: 'trail',
  },
  {
    id: 'recruit',
    name: 'Recruit',
    heading: 'Recruitment',
    title: 'Rich food draws a crowd',
    biology: 'A forager back from a rich find lays a stronger trail, so more nestmates follow. The crowd grows to fit the food.',
    swarm: 'Here, pressing and holding a droplet makes it richer. More agents come for as long as you hold, and the live colony has no ceiling.',
    anchor: 'story',
  },
  {
    id: 'midden',
    name: 'Midden',
    heading: 'The midden',
    title: 'The dead are carried out',
    biology: 'Ants carry their dead to a refuse pile, the midden, well away from the nest, and the colony raises new workers in their place.',
    swarm: 'Here, trouble glows ember: a contradiction, a failing tool, a rate limit. Most of it passes. An agent that breaks sinks to the midden, and the colony grows a replacement.',
    anchor: 'midden',
  },
  {
    id: 'quorum',
    name: 'Quorum',
    heading: 'Quorum',
    title: 'Enough of them agree',
    biology: 'Before a colony moves house, its scouts wait for a quorum: once enough of them are at one site, they all commit at once.',
    swarm: 'Here, critics score the work, and their lights flicker in step as they come to agree. Then the lead writes the finding, and the food crystallizes into an answer.',
    anchor: 'story',
  },
  {
    id: 'play',
    name: 'Your turn',
    heading: 'Your turn',
    title: 'Feed it something',
    biology: 'This colony is a simulation. Type anywhere to drop a question, press and hold food to enrich it, or drag slowly from agents to lead them.',
    swarm: '',
    anchor: 'hint',
  },
];

// the questions the scenes ask, each with the finding it ends on and a related question to ask beside it
export const STORIES = [
  { ask: 'How do ants find the shortest path?', finding: 'the shortest route is walked most, so its scent wins', beside: 'Do bees share routes the same way?' },
  { ask: 'Why do honeybees dance?', finding: 'the waggle’s angle points to food, its length says how far', beside: 'How far will a bee fly for nectar?' },
  { ask: 'How do termites keep their mounds cool?', finding: 'tunnels breathe with the day, drawing cool air up through the mound', beside: 'Do ants build vents too?' },
];
