import { h, render } from 'preact';
import { App } from './app/App';
import './app/theme.css';

const root = document.getElementById('app');
if (root) render(h(App, null), root);

// Let the managed emulator browser drive 2D pages in dev (see xr/devtools.ts).
// Pages that start their own world (/session/..., /dev/sheet) need no tooling world.
if (import.meta.env.DEV && navigator.webdriver && !/^\/(session\/|dev\/sheet)/.test(location.pathname)) {
  void import('./xr/devtools').then((m) => m.startToolingWorld());
}
