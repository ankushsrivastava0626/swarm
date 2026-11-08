// Runs the live colony: real jcode agents, on whatever jcode is logged in to on this machine, watched through
// the terrarium.
// Start it with `npm run live`, then open the terrarium's /live page; the dev and preview servers pass /live/ through.
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { type IncomingMessage, type ServerResponse, createServer, setGlobalProxyFromEnv } from 'node:http';
import { homedir, totalmem } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command, RuntimeEvent } from '../src/runtime/protocol';
import { JcodeEngine } from './jcode.ts';
import { type Listed, findingPage, indexPage } from './page.ts';
import { type Price, Swarm } from './swarm.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.LIVE_PORT ?? 5198);
// with LIVE_PROXY set, this server's own requests go through the proxy too, as jcode's do
const PROXY = process.env.LIVE_PROXY;
if (PROXY) setGlobalProxyFromEnv({ HTTPS_PROXY: PROXY, HTTP_PROXY: PROXY, NO_PROXY: 'localhost,127.0.0.1,::1' });
// Mercury 3 on OpenRouter unless the colony is given another model; jcode's logins reach it
const MODEL = process.env.LIVE_MODEL || 'inception/mercury-3';
// agents resting in the nest at the start; helpers bud beyond them, up to the world's 1,600
const COLONY = Math.round(Math.max(1, Math.min(1600, Number(process.env.LIVE_COLONY ?? 1000))));
const DIR = process.env.LIVE_DIR ?? join(root, 'live');
const BINARY = process.env.JCODE_BINARY ?? join(homedir(), '.local/bin/jcode');
// no ceiling on agents at work unless one is set; new turns only wait while jcode holds more memory than this
const MAX_WORKING = Number(process.env.LIVE_MAX_WORKING) || Infinity;
const MEMORY_MB = Number(process.env.LIVE_MEMORY_MB) || Math.round((totalmem() / 1048576) * 0.6);
const FINDINGS = join(DIR, 'findings');
// a finished answer opens in a new tab of the person's browser; LIVE_OPEN=0 leaves them to the findings page
const OPEN = process.env.LIVE_OPEN !== '0';
const LOG_LIMIT = 50_000; // events kept so a page that drops off can catch up
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const findingsUrl = `http://127.0.0.1:${PORT}/live/findings`;

const say = (line: string) => console.log(`${new Date().toTimeString().slice(0, 8)} ${line}`);

// OpenRouter's list prices for a model jcode reaches through OpenRouter, in dollars per token; without them
// the readout hides spend
async function priceOf(model: string): Promise<Price | null> {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(15_000) });
    const { data } = (await res.json()) as { data: { id: string; pricing?: Record<string, string> }[] };
    const p = data.find(m => m.id === model)?.pricing;
    const input = Number(p?.prompt);
    const output = Number(p?.completion);
    if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
    const cached = Number(p?.input_cache_read ?? p?.prompt);
    return { input, output, cached: Number.isFinite(cached) ? cached : input };
  } catch {
    return null;
  }
}

// resident memory of a process and everything under it, in MB
function treeMB(pid: number | undefined): number {
  if (!pid) return 0;
  try {
    const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,rss='], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .map(l => l.trim().split(/\s+/).map(Number));
    const tree = new Set([pid]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const [p, parent] of rows) {
        if (!tree.has(parent) || tree.has(p)) continue;
        tree.add(p);
        grew = true;
      }
    }
    return Math.round(rows.filter(([p]) => tree.has(p)).reduce((s, [, , rss]) => s + rss, 0) / 1024);
  } catch {
    return 0;
  }
}

// a new tab in the person's browser, without bringing the browser to the front where the system allows it
function openTab(url: string): void {
  const [cmd, args] = process.platform === 'darwin' ? ['open', ['-g', url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  execFile(cmd, args, err => {
    if (err) say(`could not open a tab for ${url}: ${err.message}`);
  });
}

// every finished answer, the newest first
function listFindings(): Listed[] {
  if (!existsSync(FINDINGS)) return [];
  return readdirSync(FINDINGS)
    .filter(f => f.endsWith('.md'))
    .map(f => ({ f, at: statSync(join(FINDINGS, f)).mtime }))
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .map(({ f, at }) => {
      const text = readFileSync(join(FINDINGS, f), 'utf8');
      return {
        href: `/live/findings/${encodeURIComponent(basename(f, '.md'))}`,
        ask: text.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? basename(f, '.md'),
        finding: text.match(/^\*\*(.+)\*\*$/m)?.[1]?.trim() ?? '',
        when: at.toLocaleString(),
      };
    });
}

function page(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    // no scripts, frames, forms or plugins: a finding is text to read
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
  });
  res.end(html);
}

// a command from a page, checked enough that a bad one cannot put the colony in a strange state
function asCommand(value: unknown): Command | null {
  const c = value as Record<string, unknown> | null;
  if (!c || typeof c.type !== 'string') return null;
  const num = (k: string) => typeof c[k] === 'number' && Number.isFinite(c[k]);
  const str = (k: string) => typeof c[k] === 'string';
  const ids = Array.isArray(c.agents) && c.agents.every(a => typeof a === 'string');
  switch (c.type) {
    case 'world.resize':
      return num('w') && num('h') ? (c as unknown as Command) : null;
    case 'objective.create':
      return str('text') && (c.text as string).length <= 600 && num('x') && num('y') ? (c as unknown as Command) : null;
    case 'objective.move':
      return str('objective') && num('x') && num('y') ? (c as unknown as Command) : null;
    case 'objective.enrich':
      return str('objective') && num('amount') ? (c as unknown as Command) : null;
    case 'objective.abandon':
    case 'objective.restore':
      return str('objective') ? (c as unknown as Command) : null;
    case 'agents.reassign':
      return str('objective') && ids ? (c as unknown as Command) : null;
    case 'agents.release':
      return ids ? (c as unknown as Command) : null;
    default:
      return null;
  }
}

function body(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((done, fail) => {
    let text = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      text += chunk;
      if (text.length > limit) {
        fail(new Error('too large'));
        req.destroy();
      }
    });
    req.on('end', () => done(text));
    req.on('error', fail);
  });
}

async function main(): Promise<void> {
  say(`starting a private jcode server on jcode's own logins${MODEL ? `, with ${MODEL}` : ''}`);
  const engine = await JcodeEngine.start({
    binary: BINARY,
    workingDir: DIR,
    notesDir: join(DIR, 'nest'),
    findingsDir: FINDINGS,
    model: MODEL,
    log: say,
    onFinding: file => {
      const url = `${findingsUrl}/${encodeURIComponent(basename(file, '.md'))}`;
      say(`answer ready: ${url}`);
      if (OPEN) openTab(url);
    },
  });
  const { provider, model } = engine.route;
  const running = model ?? "jcode's default model";
  say(`the colony runs on ${running}${provider ? ` through ${provider}` : ''}`);
  // only a model reached through OpenRouter has a list price here; a subscription login has none per token
  const price = model && /openrouter/i.test(provider ?? '') ? await priceOf(model) : null;
  if (price) say(`${model}: $${(price.input * 1e6).toFixed(2)} in, $${(price.output * 1e6).toFixed(2)} out per million tokens`);
  else say(`no list price for ${running}: the readout will not show spend`);

  // big teams can outgrow the machine: new turns wait, and nothing is dropped, while jcode is over its memory budget
  let roomy = true;
  const memory = setInterval(() => {
    const mb = treeMB(engine.pid);
    const was = roomy;
    roomy = mb < MEMORY_MB;
    if (roomy !== was) say(roomy ? `jcode back under ${MEMORY_MB} MB: turns start again` : `jcode is using ${mb} MB, over ${MEMORY_MB} MB: new turns wait`);
  }, 2000);
  say(`no limit on the team; new turns wait only if jcode passes ${MEMORY_MB} MB${MAX_WORKING < Infinity ? ` or ${MAX_WORKING} agents are at work` : ''}`);

  const swarm = new Swarm({ engine, colony: COLONY, world: { w: 1280, h: 800 }, price, tag: Date.now().toString(36).slice(-4), log: say, maxWorking: MAX_WORKING, canStart: () => roomy });

  // every event has an id, so a page that drops off and reconnects is sent only what it missed
  const log: { id: number; e: RuntimeEvent }[] = [];
  let lastId = 0;
  let pending: RuntimeEvent[] = [];
  const viewers = new Set<ServerResponse>();
  swarm.on(e => {
    log.push({ id: ++lastId, e });
    if (log.length > LOG_LIMIT) log.splice(0, log.length - LOG_LIMIT);
    pending.push(e);
  });
  const send = (res: ServerResponse, events: RuntimeEvent[]) => res.write(`id: ${lastId}\ndata: ${JSON.stringify(events)}\n\n`);
  const flush = () => {
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    for (const v of viewers) send(v, batch);
  };

  const watch = (req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    // what the existing viewers have not been sent yet goes out first, so the newcomer's picture is not counted twice
    flush();
    const since = Number(req.headers['last-event-id']);
    if (since > 0) {
      if (log.length && since >= log[0].id - 1 && since <= lastId) {
        const missed = log.filter(x => x.id > since).map(x => x.e);
        if (missed.length) send(res, missed);
      } else {
        // too far behind, or this server restarted: the page starts over from a fresh picture
        res.write('event: reset\ndata: {}\n\n');
      }
    } else {
      send(res, swarm.snapshot());
    }
    viewers.add(res);
    // the response closes when the page goes; the request closes as soon as it has been read
    res.on('close', () => viewers.delete(res));
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const origin = req.headers.origin;
    // only pages served from this machine may watch or steer the colony
    if (origin && !LOCAL.test(origin)) return void res.writeHead(403).end();
    if (req.method === 'GET' && url.pathname === '/live/events') return watch(req, res);
    if (req.method === 'GET' && /^\/live\/findings\/?$/.test(url.pathname)) return page(res, indexPage(listFindings()));
    const named = url.pathname.match(/^\/live\/findings\/([\w-]+)$/);
    if (req.method === 'GET' && named) {
      const file = join(FINDINGS, `${named[1]}.md`);
      if (!existsSync(file)) return void res.writeHead(404, { 'content-type': 'text/plain' }).end('There is no finding by that name.');
      return page(res, findingPage(readFileSync(file, 'utf8'), '/live/findings'));
    }
    if (req.method === 'GET' && url.pathname === '/live/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return void res.end(JSON.stringify({ model: engine.route.model ?? null, provider: engine.route.provider ?? null, viewers: viewers.size, jcodeMB: treeMB(engine.pid), ...swarm.status() }, null, 2));
    }
    if (req.method === 'POST' && url.pathname === '/live/command') {
      if (!origin || !String(req.headers['content-type']).startsWith('application/json')) return void res.writeHead(403).end();
      body(req, 64_000)
        .then(text => {
          const cmd = asCommand(JSON.parse(text));
          if (!cmd) return void res.writeHead(400).end();
          swarm.send(cmd);
          res.writeHead(204).end();
        })
        .catch(() => res.writeHead(400).end());
      return;
    }
    res.writeHead(404).end();
  });

  const pulse = setInterval(() => {
    swarm.tick();
    flush();
  }, 100);
  // comments keep idle connections open through proxies
  const keepAlive = setInterval(() => {
    for (const v of viewers) v.write(': still here\n\n');
  }, 15_000);
  const report = setInterval(() => {
    const s = swarm.status();
    say(`${s.working} of ${s.agents} agents working, ${s.failed} failed, $${s.spentUsd.toFixed(4)} spent, jcode ${treeMB(engine.pid)} MB`);
  }, 60_000);

  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    say('stopping the colony');
    clearInterval(pulse);
    clearInterval(keepAlive);
    clearInterval(report);
    clearInterval(memory);
    swarm.halt();
    for (const v of viewers) v.end();
    server.close();
    await engine.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  server.listen(PORT, '127.0.0.1', () => {
    say(`a colony of ${COLONY} agents is ready: watch it at http://localhost:5199/live (with npm run dev), status at http://127.0.0.1:${PORT}/live/status`);
    say(`finished answers ${OPEN ? 'open in a new tab, and ' : ''}are listed at ${findingsUrl}`);
  });
}

main().catch(err => {
  console.error(`live colony did not start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
