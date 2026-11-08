// The live colony runs on your own machine: the built site links to its open source code, and its /live shows the tour.
// Run here with npm run dev and the live colony is on: /live watches the real agents npm run live starts.
export const LIVE: boolean = import.meta.env.DEV;

export const LAUNCH = {
  long: 'Open source on GitHub',
  short: 'GitHub',
  repo: 'https://github.com/ankushsrivastava0626/swarm',
  // in the tour's last chapter, where the way to the live colony is
  status: 'The live colony, with real agents on the real web, runs on your own machine: the code is open source on GitHub.',
};
