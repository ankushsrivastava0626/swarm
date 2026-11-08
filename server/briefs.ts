// What each real agent is told, and how its structured replies are read.
// An agent sees only its own brief and the shared notes, so every brief stands on its own.
import type { Role } from '../src/runtime/protocol';

export interface Nearby {
  text: string;
  folder: string;
}

export interface PlannedTask {
  role: Role;
  title: string;
  brief: string;
}

export interface Verdict {
  verdict: 'accept' | 'revise';
  score: number;
  issues: string[];
}

export interface Decision {
  finding: string;
  report: string;
}

const ROLE: Record<Role, string> = {
  scout: 'You are a scout: you find things out. Search the web, open the pages that matter, and note what you learn with the address of each source.',
  builder: 'You are a builder: you make what the brief asks for, such as a comparison, a draft, a plan or a list, from what the scouts noted and what you can check yourself.',
  critic: 'You are a critic: you check the team’s notes against the objective and say exactly what is missing, wrong or unsupported.',
};

// the system prompt is fixed for an agent's whole life, so leading an objective is said in the brief instead
export function systemPrompt(role: Role, today: string): string {
  return [
    `You are one agent in a colony of AI agents working on objectives a person drops into a shared world. Today is ${today}.`,
    'The colony keeps shared notes in one folder. Use list_notes, read_note and write_note on it; paths are relative to that folder. Other agents read what you write, so keep notes short, factual and sourced.',
    'You cannot ask the person anything. Work with what you have, and say plainly what you could not find.',
    ROLE[role],
  ].join('\n\n');
}

const nearbyLine = (nearby: Nearby[]): string =>
  nearby.length ? `Related work nearby, whose notes you can read: ${nearby.map(n => `"${n.text}" in ${n.folder}/`).join('; ')}.` : '';

export function planBrief(objective: string, max: number, nearby: Nearby[]): string {
  return [
    `You lead this objective, from the person watching: "${objective}"`,
    `Plan the work for a team of at most ${max} agents. Each task goes to one agent who sees only its brief and the shared notes, so make every brief complete on its own: say exactly what to find out or make. Do not name files or folders: each agent is told where to write.`,
    'Scouts find things out first. Builders then make the answer from what the scouts noted; use builders only when something has to be made, like a comparison, a draft or a plan.',
    nearbyLine(nearby),
    `Split the work into as many distinct tasks as it really has, from 2 up to ${max}.`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

const ANGLES = [
  'official and primary sources',
  'recent news coverage',
  'community discussion, forums and reviews',
  'numbers, data and benchmarks',
  'critical or dissenting views',
  'what changed most recently',
  'local and regional sources',
  'expert analysis and long-form writing',
];

// another agent on the same task, sent a different way so the second look finds what the first missed
export function secondLook(brief: string, n: number): string {
  return `${brief}\n\nOther agents are on this same task. Work on your own, and come at it through ${ANGLES[n % ANGLES.length]}. Say where what you find disagrees with what the others are likely to find.`;
}

export function mergeBrief(paths: string[]): string {
  return `Read these notes with read_note: ${paths.join(', ')}.\nMerge them into one digest: what they agree on, where they disagree, and the strongest sources, keeping the address of every source. Keep it under 500 words.`;
}

export const planSchema = (max: number) => ({
  type: 'object',
  properties: {
    tasks: {
      type: 'array',
      minItems: 1,
      maxItems: max,
      items: {
        type: 'object',
        properties: {
          role: { type: 'string', enum: ['scout', 'builder'] },
          title: { type: 'string', minLength: 1, maxLength: 80 },
          brief: { type: 'string', minLength: 1 },
        },
        required: ['role', 'title', 'brief'],
        additionalProperties: false,
      },
    },
  },
  required: ['tasks'],
  additionalProperties: false,
});

// a plan the model got wrong still becomes work: a scout to look into it and a builder to answer it
export function readPlan(data: unknown, objective: string, max: number): PlannedTask[] {
  const raw = (data as { tasks?: unknown } | null)?.tasks;
  const tasks = Array.isArray(raw)
    ? raw
        .map(t => t as Partial<PlannedTask>)
        .filter(t => (t.role === 'scout' || t.role === 'builder') && typeof t.title === 'string' && typeof t.brief === 'string' && t.title.trim() && t.brief.trim())
        .map(t => ({ role: t.role as Role, title: clip(t.title as string, 60), brief: (t.brief as string).trim() }))
    : [];
  if (tasks.length) return tasks.slice(0, max);
  return [
    { role: 'scout', title: 'look into it', brief: `Find out what is known about this, with sources: ${objective}` },
    { role: 'builder', title: 'write the answer', brief: `From the scout's notes, write a direct answer to: ${objective}` },
  ];
}

export function taskBrief(objective: string, title: string, brief: string, note: string, folder: string, nearby: Nearby[], inputs: string[] = []): string {
  return [
    `The person's objective: "${objective}"`,
    `Your task: ${title}\n${brief}`,
    `Write what you find or make to "${note}" with write_note, in markdown, with the address of every source.`,
    inputs.length ? `Start from these notes, which merge what the scouts found: ${inputs.join(', ')}.` : '',
    `Your teammates' notes are in ${folder}/; read them with list_notes and read_note when they help.`,
    nearbyLine(nearby),
    'When you are done, reply with a report of at most 60 words: what you found or made, and anything you could not find.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export interface Note {
  path: string;
  content: string;
}

// the team's notes, put in the brief itself: a reply asked for as JSON alone may not stop to read them
const notesBlock = (notes: Note[]): string =>
  notes.length ? `The team's notes:\n\n${notes.map(n => `--- ${n.path}\n${n.content.trim()}`).join('\n\n')}` : 'The team wrote no notes.';

export function reviewBrief(objective: string, notes: Note[]): string {
  return [
    `The person's objective: "${objective}"`,
    notesBlock(notes),
    'Judge how well these notes, together, answer the objective. Score from 0 to 1. Say "revise" only for problems a builder could fix in one more pass, and list at most three, each as a fix.',
  ].join('\n\n');
}

export const reviewSchema = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['accept', 'revise'] },
    score: { type: 'number', minimum: 0, maximum: 1 },
    issues: { type: 'array', maxItems: 3, items: { type: 'string', minLength: 1 } },
  },
  required: ['verdict', 'score', 'issues'],
  additionalProperties: false,
};

export function readVerdict(data: unknown): Verdict {
  const v = (data ?? {}) as Partial<Verdict>;
  const score = typeof v.score === 'number' && Number.isFinite(v.score) ? Math.min(1, Math.max(0, v.score)) : 0.5;
  const issues = Array.isArray(v.issues) ? v.issues.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map(s => s.trim()).slice(0, 3) : [];
  return { verdict: v.verdict === 'revise' && issues.length ? 'revise' : 'accept', score, issues };
}

// what the critics said: each one when there are few, a summary when a big team had many
function criticsLine(verdicts: Verdict[]): string {
  if (!verdicts.length) return '';
  if (verdicts.length <= 3) return `The critics ${verdicts.map(v => `scored it ${v.score.toFixed(2)}${v.issues.length ? `, and asked for: ${v.issues.join('; ')}` : ''}`).join('. Another ')}.`;
  const scores = verdicts.map(v => v.score);
  const mean = scores.reduce((s, x) => s + x, 0) / scores.length;
  const asks = [...new Set(verdicts.flatMap(v => v.issues))].slice(0, 6);
  return `${verdicts.length} critics scored it from ${Math.min(...scores).toFixed(2)} to ${Math.max(...scores).toFixed(2)}, ${mean.toFixed(2)} on average${asks.length ? `, and asked for: ${asks.join('; ')}` : ''}.`;
}

export function decideBrief(objective: string, notes: Note[], verdicts: Verdict[]): string {
  return [
    `You lead this objective, from the person watching: "${objective}"`,
    notesBlock(notes),
    "From these notes, write the team's answer.",
    criticsLine(verdicts),
    // a whole report inside JSON is hard for a small model to escape, so the answer is plain markdown
    'Begin your reply with one line, "Finding: " and then the answer in at most 12 plain words. It reads as the second half of the person\'s question, so begin it in lowercase unless the first word is a name, and end it without a full stop. Then leave a blank line and write the full answer in markdown, with its sources at the end.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

// the finding is short and has no full stop; its case is left as the model wrote it, so names keep theirs
export function readDecision(text: string): Decision {
  const line = text.match(/^[\s*_#>]*finding[*_\s]*:[*_\s]*(.+)$/im);
  const report = (line ? text.replace(line[0], '') : text).trim();
  const finding = (line?.[1] ?? firstSentence(report))
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 12)
    .join(' ')
    .replace(/[.;:,…]+$/, '');
  return { finding, report: report || text.trim() };
}

export function firstSentence(text: string): string {
  const flat = text.replace(/[#>*_`]/g, '').replace(/\s+/g, ' ').trim();
  const end = flat.search(/[.!?](\s|$)/);
  return clip(end > 0 ? flat.slice(0, end) : flat, 90);
}

export function clip(text: string, n: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= n ? flat : `${flat.slice(0, n - 1).trimEnd()}…`;
}

export function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32)
      .replace(/-+$/, '') || 'objective'
  );
}
