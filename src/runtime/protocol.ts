// The contract between an agent runtime and the terrarium.
// The simulated runtime speaks it today; a real runtime only needs an adapter that speaks it too.

export type Role = 'scout' | 'builder' | 'critic';
export type FrictionKind = 'contradiction' | 'retry' | 'tool-error';

// Runtime to world. Positions are in world units (CSS pixels of the unzoomed view).
export type RuntimeEvent =
  // an agent exists; with a parent it buds from that agent, without one it comes out of the nest
  | { type: 'agent.spawned'; agent: string; role: Role; parent?: string }
  // working on an objective: drawn to its food
  | { type: 'agent.assigned'; agent: string; objective: string }
  // no work: returns to the nest and dims
  | { type: 'agent.released'; agent: string }
  // how hard it is thinking, 0 to 1: faster and brighter; cost is what it spends, in dollars an hour,
  // when the runtime knows (the readout shows spend only once some runtime reports it)
  | { type: 'agent.effort'; agent: string; effort: number; cost?: number }
  // one line of what it is doing now; shown only when you zoom in
  | { type: 'agent.activity'; agent: string; text: string }
  // writing shared context lays pheromone back to the nest; reading from another objective
  // carries it there and back
  | { type: 'agent.context'; agent: string; op: 'write' | 'read'; objective: string; from?: string; summary: string }
  // a spark passes from one agent to another
  | { type: 'agent.handoff'; from: string; to: string; summary: string }
  // the agent's current proposal on a 0 to 1 line; close stances flicker in unison
  | { type: 'agent.stance'; agent: string; stance: number }
  // contradicting, retrying or failing a tool: boils until calm
  | { type: 'agent.friction'; agent: string; kind: FrictionKind; detail: string }
  | { type: 'agent.calm'; agent: string }
  // cannot choose between two objectives: zigzags between their food
  | { type: 'agent.undecided'; agent: string; between: [string, string] }
  | { type: 'agent.decided'; agent: string }
  // gone dark: sinks to the midden; past means it happened before anyone was looking
  | { type: 'agent.failed'; agent: string; error: string; past?: boolean }
  | { type: 'agent.stopped'; agent: string; reason: string }
  // a helper finished and folds back into its parent (or into the nest when it has none)
  | { type: 'agent.merged'; agent: string; into?: string }
  | { type: 'objective.created'; objective: string; text: string; x: number; y: number; size: number }
  // fraction of the work done, 0 to 1: the food is eaten in bites
  | { type: 'objective.progress'; objective: string; progress: number }
  | { type: 'objective.related'; a: string; b: string; related: boolean }
  | { type: 'objective.priority'; objective: string; priority: number }
  | { type: 'objective.moved'; objective: string; x: number; y: number }
  | { type: 'objective.completed'; objective: string; finding: string; past?: boolean }
  | { type: 'objective.abandoned'; objective: string }
  | { type: 'objective.restored'; objective: string };

// World to runtime: what a person asked for, by gesture.
export type Command =
  | { type: 'world.resize'; w: number; h: number }
  | { type: 'objective.create'; text: string; x: number; y: number }
  | { type: 'objective.move'; objective: string; x: number; y: number }
  | { type: 'objective.enrich'; objective: string; amount: number }
  | { type: 'objective.abandon'; objective: string }
  | { type: 'objective.restore'; objective: string }
  | { type: 'agents.reassign'; agents: string[]; objective: string }
  | { type: 'agents.release'; agents: string[] };

export interface Runtime {
  // true while the swarm is the simulation; the readout says so
  readonly simulated: boolean;
  send(command: Command): void;
  on(listener: (event: RuntimeEvent) => void): () => void;
  // advance simulated time; adapters for real agents ignore it
  tick(dt: number): void;
}
