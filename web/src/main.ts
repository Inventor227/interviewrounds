import { h, render } from 'preact';
import { App } from './app/App';
import './app/theme.css';

const root = document.getElementById('app');
if (root) render(h(App, null), root);

// Let the managed emulator browser drive 2D pages in dev (see xr/devtools.ts).
if (import.meta.env.DEV && navigator.webdriver && !location.pathname.startsWith('/session/')) {
  void import('./xr/devtools').then((m) => m.startToolingWorld());
}
