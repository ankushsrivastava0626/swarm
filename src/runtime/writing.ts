// The simulated colony's words: what agents say they are doing, what goes wrong, what they found.
// Real agents bring their own words; nothing outside the simulation uses this file.
import type { FrictionKind, Role } from './protocol';
import type { Rng } from './rng';

export type Kind = 'investigate' | 'build' | 'review' | 'write' | 'compare' | 'research';

const KINDS: [Kind, RegExp][] = [
  ['investigate', /^(why|find|debug|diagnose|investigate|figure|trace|track|root|what|how come|where)\b/i],
  ['review', /^(audit|review|check|test|verify|validate|inspect|proofread)\b/i],
  ['write', /^(draft|write|document|summari[sz]e|outline|announce|explain|describe)\b/i],
  ['compare', /^(compare|evaluate|choose|pick|benchmark|weigh|decide|rank)\b/i],
  ['research', /^(research|learn|map|explore|survey|read|study|understand|gather|collect|scan)\b/i],
];

export function kindOf(text: string): Kind {
  const t = text.trim();
  for (const [kind, re] of KINDS) if (re.test(t)) return kind;
  return t.endsWith('?') ? 'investigate' : 'build';
}

// How much work a request is, from 1 (small) to 3 (large), judged from its wording.
export function sizeOf(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  let size = 1 + Math.min(1, Math.max(0, (words - 4) / 8));
  if (/\b(all|every|entire|whole|each|across)\b/i.test(text)) size += 0.8;
  if (kindOf(text) === 'build') size += 0.3;
  return Math.min(3, Math.round(size * 10) / 10);
}

const LEAD = /^(why\s+(do|does|did|is|are|was|were|can't|won't|doesn't|don't)|find\s+(out\s+)?(why|how|where|what)|figure\s+out\s+(why|how)?|how\s+come|track\s+down|root\s+cause|\w+)\s+/i;
const PREP = /\s(onto|into|to|for|from|with|in|on|at|by|across|before|after|so|and)\s/i;

const DETERMINER = /^(which|what|whether|the|a|an|our|my|all|every|each)\s+/i;
const QUESTION = /^(why|how|what|which|where|when|who|find|figure|track|root)\b/i;

// A short noun phrase for activity lines: "Move billing onto the new ledger" becomes "billing",
// and a question is about its subject: "Why do refunds post twice?" becomes "refunds".
export function topicOf(text: string): string {
  let t = text.trim().replace(/[.?!]+$/, '');
  const question = QUESTION.test(t);
  t = t.replace(LEAD, '');
  while (DETERMINER.test(t)) t = t.replace(DETERMINER, '');
  const cut = t.search(PREP);
  if (cut > 0 && t.split(/\s+/).length > 3) t = t.slice(0, cut);
  if (question) t = t.split(/\s+/)[0];
  if (t.length > 26) t = t.slice(0, 25).replace(/\s+\S*$/, '') + '…';
  return t.charAt(0).toLowerCase() + t.slice(1);
}

const TOOLS = [
  'the test runner',
  'the search index',
  'the payments sandbox',
  'the browser',
  'the linter',
  'the staging deploy',
  'the docs crawler',
  'the database replica',
  'the package registry',
];

const fill = (rng: Rng, template: string, topic: string) =>
  template
    .replace('{t}', topic)
    .replace('{tool}', rng.pick(TOOLS))
    .replace('{n}', String(rng.int(2, 9)))
    .replace('{m}', String(rng.int(1, 2)))
    .replace('{w}', String(rng.int(4, 14) * 60));

const ACTIVITY: Record<Role, string[]> = {
  scout: ['reading up on {t}', 'searching past work on {t}', 'mapping {t}', 'collecting examples of {t}', 'skimming logs about {t}'],
  builder: ['drafting changes for {t}', 'writing code for {t}', 'running tests on {t}', 'editing {n} files for {t}', 'rebuilding {t}'],
  critic: ['checking {t}', 'reviewing a draft of {t}', 'looking for edge cases in {t}', 're-running a failing test', 'comparing two drafts of {t}'],
};
const ACTIVITY_BY_KIND: Partial<Record<Kind, Partial<Record<Role, string[]>>>> = {
  investigate: { builder: ['writing a failing test for {t}', 'adding logging around {t}'], scout: ['reading logs about {t}', 'replaying a bad request'] },
  write: { builder: ['drafting {t}', 'rewriting a paragraph on {t}', 'trimming {t}'] },
  compare: { scout: ['pricing an option for {t}', 'reading reviews of {t}'], critic: ['scoring option {n}'] },
  review: { critic: ['stepping through {t}', 'filing an issue on {t}'] },
};

export function activity(rng: Rng, role: Role, kind: Kind, topic: string): string {
  const extra = ACTIVITY_BY_KIND[kind]?.[role] ?? [];
  return fill(rng, rng.pick([...ACTIVITY[role], ...extra, ...extra]), topic);
}

const FRICTION: Record<FrictionKind, string[]> = {
  contradiction: ['two drafts disagree on {t}', 'conflicting answers about {t}', 'the tests disagree with the spec'],
  retry: ['retrying {tool}, attempt {n}', '{tool} flaked, trying again'],
  'tool-error': ['{tool} timed out', '{tool} returned an error', '{tool} refused the request'],
};

export function frictionDetail(rng: Rng, kind: FrictionKind, topic: string): string {
  return fill(rng, rng.pick(FRICTION[kind]), topic);
}

const ERRORS = ['{tool} timed out three times', 'ran out of context reading {t}', 'lost its connection to {tool}', 'crashed while running {tool}'];

export function failure(rng: Rng, topic: string): string {
  return fill(rng, rng.pick(ERRORS), topic);
}

export function contextSummary(rng: Rng, topic: string): string {
  return fill(rng, rng.pick(['notes on {t}', 'a draft of {t}', 'test results for {t}', 'open questions on {t}', 'a summary of {t}']), topic);
}

// The colony's half of a finding. The world sets it after the person's own words.
const FINDINGS: Record<Kind, string[]> = {
  investigate: ['narrowed to one cause, confirmed with a failing test', 'two causes ruled out, one confirmed', 'traced to a single retry path; the fix is small'],
  build: ['done; {n} files changed, tests pass', 'shipped behind a flag; {n} files changed', 'done, with one follow-up filed'],
  review: ['{n} issues found, {m} serious', 'passes, with {n} small fixes', '{n} issues, all minor'],
  write: ['draft ready, {w} words', 'two drafts; the shorter one recommended', 'draft ready, {n} open questions'],
  compare: ['{n} options compared; one clear winner', 'a close call between two; notes on both'],
  research: ['{n} sources read, summary written', 'mapped, with {n} open questions'],
};

export function finding(rng: Rng, kind: Kind, topic: string): string {
  return fill(rng, rng.pick(FINDINGS[kind]), topic);
}
