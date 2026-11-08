import '@fontsource-variable/instrument-sans/wdth.css';
import '@fontsource-variable/instrument-sans/wdth-italic.css';
import '@fontsource-variable/syne/wght.css';
import './style.css';
import { App, isLive } from './app';
import { Glass } from './glass/glass';
import { Input } from './input/input';
import { Landing, liveChrome } from './landing/landing';
import { LIVE } from './launch';
import type { RemoteRuntime } from './runtime/remote';
import { LANDING } from './scenario';

// the live colony has a page of its own at /live, and the older ?live address lands there too;
// until the live colony opens, both show the tour
const asked = isLive(location.search, location.pathname);
const live = LIVE && asked;
if (asked) {
  const params = new URLSearchParams(location.search);
  params.delete('live');
  const rest = params.toString();
  history.replaceState(null, '', `${live ? '/live' : '/'}${rest ? `?${rest}` : ''}${location.hash}`);
}

const stage = document.getElementById('stage')!;
const glassRoot = document.getElementById('glass')!;
// everywhere else is the landing page: a simulated colony that acts out how the swarm works, then is yours;
// a small screen gets a smaller colony, to fit above the label docked along its bottom
const narrow = matchMedia('(max-width: 720px)').matches;
const app = new App(
  document.getElementById('world') as HTMLCanvasElement,
  live ? { live: true } : { live: false, opening: LANDING, backlog: false, colony: narrow ? 300 : undefined },
);

if (!app.renderer.ok) {
  glassRoot.classList.add('failed');
  glassRoot.textContent = app.renderer.error || 'This browser cannot draw the colony.';
} else {
  const input = new Input(app, stage);
  const glass = new Glass(glassRoot, document.getElementById('lines') as HTMLCanvasElement, app);
  input.attach(glass);
  const root = document.getElementById('landing')!;
  const landing = live ? null : new Landing(root, app, input, glass);
  if (live) liveChrome(root, app.runtime as RemoteRuntime);
  // a live colony's answer opens in a new tab rather than on the glass; a screen reader still hears it is done
  app.colony.hooks.crystallize = (food, finding) =>
    app.colony.keepFindings ? glass.crystallize(food, finding, app.colony.findings[app.colony.findings.length - 1]) : glass.announce(`Finished: ${food.text}. Its answer opens in a new tab.`);
  app.focusPoint = () => [input.aim.x, input.aim.y];
  app.every(dt => input.update(dt));
  // the landing page's label moves before the glass draws its hairline
  if (landing) app.every(dt => landing.update(dt));
  app.every(dt => glass.update(dt, input));
  // a lost display shows as a blank canvas; hide it so the medium's colour and the notice show instead
  app.renderer.canvas.addEventListener('webglcontextlost', () => {
    stage.classList.add('lost');
    glass.setLost(true);
  });
  app.renderer.canvas.addEventListener('webglcontextrestored', () => {
    stage.classList.remove('lost');
    glass.setLost(false);
  });

  // the colony lives a few seconds before anyone looks; the type must be ready when they do
  app.prewarm();
  const fonts = Promise.all([
    document.fonts.load('400 15px "Instrument Sans Variable"'),
    document.fonts.load('italic 400 15px "Instrument Sans Variable"'),
    document.fonts.load('500 26px "Syne Variable"'),
  ]);
  Promise.race([fonts, new Promise(r => setTimeout(r, 1500))]).finally(() => app.start());
  (window as unknown as { swarm: object }).swarm = { app, input, glass, landing };
}

(window as unknown as { app: App }).app = app;
