// The live colony opens with the code. Until then the built site says when, and its /live shows the tour.
// Run here with npm run dev and the live colony is on: /live watches the real agents npm run live starts.
export const LIVE: boolean = import.meta.env.DEV;

export const LAUNCH = {
  long: 'Launching 1 Nov, open source on GitHub',
  short: 'Launching 1 Nov',
  // in the tour's last chapter, where the way to the live colony will be
  status: 'The live colony, with real agents on the real web, launches on 1 November, open source on GitHub.',
};
