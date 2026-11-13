import { h, render } from 'preact';
import { App } from './app/App';
import { isFake } from './app/fake/mode';
import { defaultRuntime, registerRuntime } from './app/launch';
import './app/theme.css';

// The real room (XR app, avatars, board) for every round, loaded on demand in the mic tap.
// Fixture mode keeps the placeholder, so page screenshots never start the 3D world.
registerRuntime(async (opts) => (isFake() ? defaultRuntime(opts) : (await import('./session/runtime')).createRoundRuntime(opts)));

const root = document.getElementById('app');
if (root) render(h(App, null), root);

// Let the managed emulator browser drive 2D pages in dev (see xr/devtools.ts).
// Pages that start their own world (/session/..., /dev/sheet) need no tooling world.
if (import.meta.env.DEV && navigator.webdriver && !/^\/(session\/|dev\/sheet)/.test(location.pathname)) {
  void import('./xr/devtools').then((m) => m.startToolingWorld());
}
