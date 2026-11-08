// A runtime for real agents: what they do streams in from the live colony's server (npm run live),
// and gestures go back to it as commands.
import type { Command, Runtime, RuntimeEvent } from './protocol';

// the part of EventSource this runtime uses, so tests can stand in for it
export interface EventStream {
  addEventListener(type: string, listener: (e: MessageEvent<string>) => void): void;
  readonly readyState?: number;
}

// EventSource's state once it has stopped trying: the server answered with something other than a stream
const CLOSED = 2;

export interface RemoteOptions {
  base?: string;
  open?: (url: string) => EventStream;
  post?: (url: string, body: string) => void;
  // the server lost track of what this page has seen
  reset?: () => void;
}

export class RemoteRuntime implements Runtime {
  readonly simulated = false;
  // whether the stream from the live colony is up; closed means its server could not be reached
  state: 'connecting' | 'open' | 'closed' = 'connecting';
  private listeners = new Set<(e: RuntimeEvent) => void>();
  private queue: RuntimeEvent[] = [];
  private base: string;
  private post: (url: string, body: string) => void;

  constructor(opts: RemoteOptions = {}) {
    this.base = opts.base ?? '/live';
    this.post = opts.post ?? ((url, body) => void fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body }).catch(() => {}));
    const stream = (opts.open ?? (url => new EventSource(url)))(`${this.base}/events`);
    stream.addEventListener('open', () => (this.state = 'open'));
    // EventSource tries again by itself after a dropped stream, and gives up when no stream answers at all
    stream.addEventListener('error', () => (this.state = stream.readyState === CLOSED ? 'closed' : 'connecting'));
    stream.addEventListener('message', m => {
      for (const e of JSON.parse(m.data) as RuntimeEvent[]) this.queue.push(e);
    });
    // start over from a fresh picture rather than show a colony that has drifted from the real one
    const reset = opts.reset ?? (() => location.reload());
    stream.addEventListener('reset', () => reset());
  }

  send(command: Command): void {
    this.post(`${this.base}/command`, JSON.stringify(command));
  }

  on(listener: (e: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // events reach the world on the frame clock, as the simulation's do
  tick(): void {
    if (!this.queue.length) return;
    const batch = this.queue;
    this.queue = [];
    for (const e of batch) for (const l of this.listeners) l(e);
  }
}
