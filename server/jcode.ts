// Runs the colony's turns on jcode: one private jcode server for the whole colony, on the logins and the
// default model jcode has on this machine, and one session per agent, cleared before each new task. Agents get
// web search, web fetch and the shared notes; jcode's shell, mail, calendar, browser and the rest stay off.
import { type ApiEvent, JcodeClient, type LaunchedInstance, type SdkTool, launchInstance } from '@1jehuang/jcode-sdk';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { Note } from './briefs.ts';
import type { Engine, Job, Signal, TurnResult } from './swarm.ts';

const TURN_MINUTES = 4; // a turn that runs longer is stopped
const NOTE_LIMIT = 24_000; // characters a note may hold, and a read returns
const BRIEF_NOTES = 40_000; // characters of a team's notes put in a critic's or a lead's brief
const OPEN_AT_ONCE = 8; // sessions opened at the same moment: the API bridge drops some of a hundred opened at once
const BUILT_IN = ['websearch', 'webfetch'];
const NOTE_TOOLS = new Set(['write_note', 'read_note', 'list_notes']);
const SEARCH_RESULTS = 8;

export interface JcodeOptions {
  binary: string;
  workingDir: string;
  notesDir: string;
  findingsDir: string;
  model?: string; // a model to run instead of jcode's own default
  log?: (line: string) => void;
  // a finished answer was saved, at this path
  onFinding?: (file: string) => void;
}

// an agent's own connection and session: a connection drives one session at a time
interface Seat {
  client: JcodeClient;
  session: string;
  signal: ((s: Signal) => void) | null;
  // the folder of the objective it is working on: its notes go there, whatever path it gives
  folder: string;
  used: boolean;
}

export class JcodeEngine implements Engine {
  private instance: LaunchedInstance;
  private opts: JcodeOptions;
  private seats = new Map<string, Promise<Seat>>();
  private running = new Map<string, Seat>();
  private cancelled = new Set<string>();
  private keeper: JcodeClient | null = null;
  // settles once a server is up; while one is being restarted, new turns wait on it
  private ready: Promise<void> = Promise.resolve();
  private closing = false;
  private opening = 0;
  private openQueue: (() => void)[] = [];
  // what the colony runs on, as jcode reports it once the server is up
  route: { provider?: string; model?: string } = {};

  private constructor(instance: LaunchedInstance, opts: JcodeOptions) {
    this.instance = instance;
    this.opts = opts;
  }

  static async start(opts: JcodeOptions): Promise<JcodeEngine> {
    mkdirSync(opts.notesDir, { recursive: true });
    mkdirSync(opts.findingsDir, { recursive: true });
    const engine = new JcodeEngine(await JcodeEngine.launch(opts), opts);
    try {
      await engine.keep(true);
    } catch (err) {
      await engine.instance.shutdown().catch(() => {});
      throw err;
    }
    return engine;
  }

  // a private server: it cannot see the jcode sessions the person runs, but it shares the logins jcode has on
  // this machine, so the colony runs on whatever jcode is set up to use
  private static launch(opts: JcodeOptions): Promise<LaunchedInstance> {
    // with LIVE_PROXY set, every request the server makes, to the model and to the web, goes through that proxy
    const proxy = process.env.LIVE_PROXY;
    const via: Record<string, string> = proxy ? { HTTPS_PROXY: proxy, HTTP_PROXY: proxy, ALL_PROXY: proxy, https_proxy: proxy, http_proxy: proxy, all_proxy: proxy, NO_PROXY: 'localhost,127.0.0.1,::1', no_proxy: 'localhost,127.0.0.1,::1' } : {};
    return launchInstance({ workingDir: opts.workingDir, binary: opts.binary, inheritLogins: true, env: { JCODE_NO_TELEMETRY: '1', ...via } });
  }

  // one connection stays open for the colony's whole life: the jcode server shuts itself down after five
  // minutes with no client connected, and agents connect only while they have work
  private async keep(first: boolean): Promise<void> {
    const keeper = await this.connect('keeper');
    try {
      // the server takes stateful requests only once a session exists
      const probe = await whenFree(() => keeper.createSession({ workingDir: this.opts.workingDir, tools: { enabled: [] } }));
      if (first) {
        // a model asked for is checked now, not on the first objective; either way the colony learns what it runs on
        const { model } = this.opts;
        if (model) await whenFree(() => keeper.setModel(probe.session_id, model));
        const info = await whenFree(() => keeper.getRuntimeInfo(probe.session_id));
        if (!info.provider && !info.providers.length) throw new Error('jcode has no login on this machine: log it in with `jcode login`');
        this.route = { provider: info.provider, model: info.model };
      }
    } catch (err) {
      await keeper.close().catch(() => {});
      throw err;
    }
    keeper.on('close', () => {
      if (this.closing || this.keeper !== keeper) return;
      this.keeper = null;
      this.ready = this.revive();
    });
    this.keeper = keeper;
  }

  // the server went away anyway: start a new one; the turns it cut off fail as passing errors and try again on it
  private async revive(): Promise<void> {
    this.opts.log?.('the jcode server went away: starting a new one');
    const old = this.instance;
    this.seats.clear();
    await old.shutdown().catch(() => {});
    for (let attempt = 1; !this.closing; attempt++) {
      try {
        this.instance = await JcodeEngine.launch(this.opts);
        await this.keep(false);
        this.opts.log?.('a new jcode server is up');
        return;
      } catch (err) {
        this.opts.log?.(`could not start a new jcode server (${err instanceof Error ? err.message : String(err)}); trying again`);
        await this.instance.shutdown().catch(() => {});
        await new Promise(r => setTimeout(r, Math.min(30_000, 2_000 * attempt)));
      }
    }
  }

  // the process at the root of the private server, for measuring its memory
  get pid(): number | undefined {
    return this.instance.process.pid;
  }

  async turn(job: Job, signal: (s: Signal) => void): Promise<TurnResult> {
    await this.ready;
    const held = this.seat(job);
    const seat = await held;
    this.cancelled.delete(job.agent);
    const calls = new Map<string, { name: string; input: string }>();
    const onEvent = (e: ApiEvent) => translate(e, calls, signal);
    let late = false;
    const timer = setTimeout(() => {
      late = true;
      void seat.client.cancel(seat.session).catch(() => {});
    }, TURN_MINUTES * 60_000);
    try {
      // a fresh task starts from a clean history; the shared notes are the colony's memory
      if (seat.used) await seat.client.clear(seat.session);
      seat.used = true;
      seat.signal = signal;
      seat.folder = job.folder;
      this.running.set(job.agent, seat);
      if (job.schema) {
        const r = await seat.client.runStructured(seat.session, job.prompt, { schema: job.schema, onEvent, autoApprove: true, maxRetries: 2 });
        if (late) throw new Error(`ran out of time after ${TURN_MINUTES} minutes`);
        return { text: r.finalText || r.text, data: r.data };
      }
      const r = await seat.client.run(seat.session, job.prompt, { onEvent, autoApprove: true });
      if (late) throw new Error(`ran out of time after ${TURN_MINUTES} minutes`);
      const text = r.finalText || r.text;
      if (r.stopReason && !text.trim()) throw new Error(r.stopMessage || `stopped (${r.stopReason})`);
      return { text };
    } catch (err) {
      // a turn that failed gives up its seat, so a retry starts on a fresh connection; a cancelled one keeps it.
      // a seat opened since, on a restarted server, is left alone
      if (!this.cancelled.has(job.agent) && this.seats.get(job.agent) === held) this.retire(job.agent);
      throw err;
    } finally {
      clearTimeout(timer);
      seat.signal = null;
      this.running.delete(job.agent);
    }
  }

  cancel(agent: string): void {
    const seat = this.running.get(agent);
    if (!seat) return;
    this.cancelled.add(agent);
    void seat.client.cancel(seat.session).catch(() => {});
  }

  retire(agent: string): void {
    const seat = this.seats.get(agent);
    this.seats.delete(agent);
    void seat?.then(s => s.client.close()).catch(() => {});
  }

  // back in the nest: its session closes, and a new one opens when it next has work
  rest(agent: string): void {
    if (!this.running.has(agent)) this.retire(agent);
  }

  save(kind: 'note' | 'finding', path: string, content: string): void {
    const base = kind === 'note' ? this.opts.notesDir : this.opts.findingsDir;
    const file = resolve(base, path);
    if (!file.startsWith(base + sep)) return;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    if (kind === 'finding') this.opts.onFinding?.(file);
  }

  notes(folder: string): Note[] {
    const notes = this.opts.notesDir;
    const dir = resolve(notes, folder);
    if (!dir.startsWith(notes + sep) || !existsSync(dir)) return [];
    // newest first: when a big team wrote more than fits, the digests and drafts go in before the raw notes
    const files = readdirSync(dir, { recursive: true })
      .map(f => join(dir, String(f)))
      .filter(f => f.endsWith('.md') && statSync(f).isFile())
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    const out: Note[] = [];
    let room = BRIEF_NOTES;
    for (const f of files) {
      if (room <= 0) break;
      const content = readFileSync(f, 'utf8').slice(0, Math.min(room, 8_000));
      room -= content.length;
      out.push({ path: relative(notes, f), content });
    }
    // read in the order they were written
    return out.reverse();
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const agent of [...this.seats.keys()]) this.retire(agent);
    await this.keeper?.close().catch(() => {});
    await this.instance.shutdown();
  }

  private connect(name: string): Promise<JcodeClient> {
    return JcodeClient.connect({ socketPath: this.instance.socketPath, clientName: `swarm-terrarium/${name}` });
  }

  private seat(job: Job): Promise<Seat> {
    let seat = this.seats.get(job.agent);
    if (!seat) {
      seat = this.paced(() => this.open(job));
      this.seats.set(job.agent, seat);
      seat.catch(() => this.seats.delete(job.agent));
    }
    return seat;
  }

  // a few sessions open at a time; a team of hundreds still starts within seconds
  private async paced<T>(open: () => Promise<T>): Promise<T> {
    while (this.opening >= OPEN_AT_ONCE) await new Promise<void>(r => this.openQueue.push(r));
    this.opening++;
    try {
      return await open();
    } finally {
      this.opening--;
      this.openQueue.shift()?.();
    }
  }

  private async open(job: Job): Promise<Seat> {
    const client = await this.connect(job.agent);
    const seat: Seat = { client, session: '', signal: null, folder: job.folder, used: false };
    try {
      const s = await whenFree(() => client.createSession({ workingDir: this.opts.workingDir, systemPrompt: job.system, tools: { enabled: BUILT_IN, custom: [...this.noteTools(seat), googleSearch(s => seat.signal?.(s))] } }));
      seat.session = s.session_id;
      // every agent runs on jcode's own default model, unless the colony was given one
      const { model } = this.opts;
      if (model) await whenFree(() => client.setModel(seat.session, model));
      return seat;
    } catch (err) {
      await client.close().catch(() => {});
      throw err;
    }
  }

  // the shared notes: the only part of the disk an agent can touch
  private noteTools(seat: Seat): SdkTool[] {
    const notes = this.opts.notesDir;
    const inside = (p: unknown): string => {
      const full = resolve(notes, String(p ?? ''));
      if (full !== notes && !full.startsWith(notes + sep)) throw new Error('that path is outside the shared notes folder');
      return full;
    };
    // every note lands in the folder of the objective the agent is working on, so its team can find it
    const own = (p: unknown): string => {
      const rel = String(p ?? '').replace(/^\/+/, '');
      return inside(rel.startsWith(`${seat.folder}/`) ? rel : `${seat.folder}/${rel.split('/').pop() || 'note.md'}`);
    };
    const say = (s: Signal) => seat.signal?.(s);
    return [
      {
        name: 'write_note',
        description: "Write a markdown note into your objective's folder in the shared notes, which every agent in the colony can read. Give the path you were told; a note given another folder is kept in your objective's.",
        parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false },
        execute: input => {
          const file = own(input.path);
          if (!file.endsWith('.md')) throw new Error('notes are markdown files: end the path with .md');
          const content = String(input.content ?? '').slice(0, NOTE_LIMIT);
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, content);
          const path = relative(notes, file);
          say({ kind: 'tool', name: 'write_note', detail: `writing ${path}` });
          say({ kind: 'note', op: 'write', path, summary: gist(content) });
          return `saved ${path}`;
        },
      },
      {
        name: 'read_note',
        description: 'Read a note from the shared notes folder.',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
        execute: input => {
          const file = inside(input.path);
          if (!existsSync(file) || !statSync(file).isFile()) return { output: '', error: `there is no note at ${String(input.path)}; list_notes shows what there is` };
          const path = relative(notes, file);
          const content = readFileSync(file, 'utf8');
          say({ kind: 'tool', name: 'read_note', detail: `reading ${path}` });
          say({ kind: 'note', op: 'read', path, summary: gist(content) });
          return content.length > NOTE_LIMIT ? `${content.slice(0, NOTE_LIMIT)}\n(cut here)` : content;
        },
      },
      {
        name: 'list_notes',
        description: 'List the notes in the shared notes folder, or in one folder of it, newest first.',
        parameters: { type: 'object', properties: { folder: { type: 'string' } }, additionalProperties: false },
        execute: input => {
          const dir = input.folder ? inside(input.folder) : notes;
          say({ kind: 'tool', name: 'list_notes', detail: 'looking through the shared notes' });
          if (!existsSync(dir)) return '(no notes there yet)';
          const files = readdirSync(dir, { recursive: true })
            .map(f => join(dir, String(f)))
            .filter(f => statSync(f).isFile())
            .map(f => ({ f, s: statSync(f) }))
            .sort((a, b) => b.s.mtimeMs - a.s.mtimeMs)
            .slice(0, 200);
          return files.map(({ f, s }) => `${relative(notes, f)} (${s.size} bytes)`).join('\n') || '(no notes yet)';
        },
      },
    ];
  }
}

// the agents' web search, always Google: it takes the place of jcode's own websearch, which scrapes DuckDuckGo.
// It asks Google's search API with GOOGLE_API_KEY and GOOGLE_CSE_ID, or Serper's Google results with SERPER_API_KEY,
// and falls back to SearXNG, an open-source search engine
function googleSearch(say: (s: Signal) => void): SdkTool {
  return {
    name: 'websearch',
    description: 'Search the web with Google. Returns the top results, each with its title, address and a snippet.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
    timeoutMs: 30_000,
    execute: async input => {
      const query = String(input.query ?? '').trim();
      if (!query) return { output: '', error: 'give a query' };
      say({ kind: 'tool', name: 'websearch', detail: `searching Google for ${query}` });
      const { GOOGLE_API_KEY: key, GOOGLE_CSE_ID: cx, SERPER_API_KEY: serper } = process.env;
      let results: { title: string; link: string; snippet: string }[];
      if (key && cx) {
        const url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(key)}&cx=${encodeURIComponent(cx)}&num=${SEARCH_RESULTS}&q=${encodeURIComponent(query)}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
        if (!res.ok) return { output: '', error: `Google search failed: ${res.status}` };
        const body = (await res.json()) as { items?: { title: string; link: string; snippet?: string }[] };
        results = (body.items ?? []).map(i => ({ title: i.title, link: i.link, snippet: i.snippet ?? '' }));
      } else if (serper) {
        const res = await fetch('https://google.serper.dev/search', {
          method: 'POST',
          headers: { 'X-API-KEY': serper, 'content-type': 'application/json' },
          body: JSON.stringify({ q: query, num: SEARCH_RESULTS }),
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) return { output: '', error: `Google search failed: ${res.status}` };
        const body = (await res.json()) as { organic?: { title: string; link: string; snippet?: string }[] };
        results = (body.organic ?? []).map(i => ({ title: i.title, link: i.link, snippet: i.snippet ?? '' }));
      } else results = [];
      // no Google key, or Google found nothing: the open-source SearXNG at SEARXNG_URL answers instead
      if (!results.length) {
        const base = (process.env.SEARXNG_URL || 'http://127.0.0.1:8888').replace(/\/+$/, '');
        try {
          const res = await fetch(`${base}/search?format=json&q=${encodeURIComponent(query)}`, { signal: AbortSignal.timeout(20_000) });
          if (!res.ok) return { output: '', error: `SearXNG search failed: ${res.status}` };
          const body = (await res.json()) as { results?: { title: string; url: string; content?: string }[] };
          results = (body.results ?? []).map(i => ({ title: i.title, link: i.url, snippet: i.content ?? '' }));
        } catch {
          return { output: '', error: `web search is not set up: give the colony GOOGLE_API_KEY and GOOGLE_CSE_ID, or SERPER_API_KEY, or run SearXNG at ${base}` };
        }
      }
      if (!results.length) return 'The search found nothing for that query.';
      return results.slice(0, SEARCH_RESULTS).map((r, i) => `${i + 1}. ${r.title}\n${r.link}\n${r.snippet}`).join('\n\n');
    },
  };
}

// a server that has just started, or is reloading its providers, can answer "busy" for a moment
async function whenFree<T>(request: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await request();
    } catch (err) {
      if (attempt >= 20 || !/busy/i.test(err instanceof Error ? err.message : String(err))) throw err;
      await new Promise(r => setTimeout(r, 250));
    }
  }
}

// jcode's stream of events, as the colony needs it: what each tool was doing, how it went, and what it cost
function translate(e: ApiEvent, calls: Map<string, { name: string; input: string }>, signal: (s: Signal) => void): void {
  switch (e.ev) {
    case 'tool_start':
      calls.set(e.call_id, { name: e.name, input: '' });
      break;
    case 'tool_input_delta': {
      const call = calls.get(e.call_id);
      if (call) call.input += e.delta;
      break;
    }
    case 'tool_exec':
      // the note tools report themselves, with the path they touched
      if (!NOTE_TOOLS.has(e.name)) signal({ kind: 'tool', name: e.name, detail: describe(e.name, calls.get(e.call_id)?.input ?? '') });
      break;
    case 'tool_done':
      if (e.error || !NOTE_TOOLS.has(e.name)) signal({ kind: 'tool-done', name: e.name, error: e.error ? firstLine(e.error) : undefined });
      calls.delete(e.call_id);
      break;
    case 'token_usage':
      signal({ kind: 'tokens', input: e.input, output: e.output, cached: e.cache_read_input ?? 0 });
      break;
    case 'connection_phase':
      if (/retry/i.test(e.phase)) signal({ kind: 'retry', detail: e.phase });
      break;
  }
}

function describe(name: string, input: string): string {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(input) as Record<string, unknown>;
  } catch {
    // input still streaming or not JSON: name the tool alone
  }
  if (name === 'websearch' && typeof args.query === 'string') return `searching “${args.query}”`;
  if (name === 'webfetch' && typeof args.url === 'string') {
    try {
      return `reading ${new URL(args.url).hostname.replace(/^www\./, '')}`;
    } catch {
      return 'reading a page';
    }
  }
  return name;
}

// the first line that says something, without its markdown
function gist(text: string): string {
  const line = text.split('\n').map(l => l.replace(/^[#>*\-\s]+/, '').trim()).find(l => l.length > 2) ?? '';
  return line.length > 70 ? `${line.slice(0, 69).trimEnd()}…` : line;
}

function firstLine(text: string): string {
  const line = text.split('\n')[0].replace(/^Error:\s*/, '').trim();
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}
