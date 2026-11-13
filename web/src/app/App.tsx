import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { LocationProvider, Route, Router, lazy, useLocation } from 'preact-iso';
import type { ImmersiveHandle } from '../xr/entry';
import { takeLaunch } from './launch';
import { History } from './pages/History';
import { Home } from './pages/Home';
import { MeetingSetup } from './pages/MeetingSetup';
import { NotSupported } from './pages/NotSupported';
import { PickRole } from './pages/PickRole';
import { PickRound } from './pages/PickRound';
import { Pricing } from './pages/Pricing';
import { Report } from './pages/Report';
import { Resume } from './pages/Resume';
import { Settings } from './pages/Settings';
import { Start } from './pages/Start';

// App shell: the top bar and the routes. Pages live in ./pages; the live session page is still a
// placeholder here. Keep the paths and the data-test ids stable.

/**
 * Quest Browser shows 2D pages large and bright in the headset, so it gets a dimmed palette
 * (theme.css, [data-device="quest"]). `?device=quest` previews it elsewhere.
 */
export function isQuestBrowser(ua: string = globalThis.navigator?.userAgent ?? '', search: string = globalThis.location?.search ?? ''): boolean {
  const q = new URLSearchParams(search).get('device');
  if (q) return q === 'quest';
  return /OculusBrowser|Quest/i.test(ua);
}

if (typeof document !== 'undefined' && isQuestBrowser()) document.documentElement.dataset.device = 'quest';

export const ROUTES = {
  home: '/',
  pickRole: '/start',
  pickRound: '/start/:role',
  start: '/round/:roundId',
  meeting: '/meeting/new',
  session: '/session/:id',
  report: '/report/:id',
  history: '/history',
  settings: '/settings',
  pricing: '/pricing',
  notSupported: '/not-supported',
  resume: '/resume/:id',
  devAvatar: '/dev/avatar',
} as const;

// Dev only: the board with a mouse (web/src/board), for development and screenshots.
const DevBoard = import.meta.env.DEV ? lazy(() => import('../board/DevBoard')) : null;
const DevSheet = import.meta.env.DEV ? lazy(() => import('../board/DevSheet')) : null;
// Developer page for the avatar runtime: dev server only. In production builds the condition is false at build time,
// so the page, its chunk and its test voices are left out of dist entirely.
const AvatarDev = import.meta.env.DEV ? lazy(() => import('../xr/avatar/dev/AvatarDev')) : null;

function Page(props: { test: string; title: string; lede: string; children?: ComponentChildren }) {
  return (
    <section class="pg" data-test={`page-${props.test}`} aria-labelledby="page-title">
      <h1 id="page-title">{props.title}</h1>
      <p class="lede">{props.lede}</p>
      {props.children}
    </section>
  );
}

/** Placeholder for the live session page (the session lane replaces it). It takes the round the
 *  Enter tap started (app/launch.ts) and shows its state; without one it offers the bare room. */
function Session(props: { id?: string }) {
  const [launch] = useState(takeLaunch);
  return launch ? <LiveSession launch={launch} /> : <BareRoom id={props.id} />;
}

function LiveSession(props: { launch: NonNullable<ReturnType<typeof takeLaunch>> }) {
  const { controller } = props.launch;
  const [state, setState] = useState(controller.state);
  const [error, setError] = useState<{ code: string } | null>(null);
  useEffect(() => {
    const offs = [controller.on('state', setState), controller.on('error', (e) => setError(e as { code: string }))];
    return () => {
      offs.forEach((o) => o());
      void controller.dispose();
    };
  }, [controller]);
  const retryEnter = error?.code === 'xr_enter_failed' || error?.code === 'placement_failed';
  return (
    <Page test="session" title={props.launch.title ?? 'Live round'} lede="Your round is running in the headset.">
      <p class="meta" data-test="session-state" data-state={state}>
        State <code>{state}</code>
      </p>
      {retryEnter && (
        <div class="row">
          <button
            class="btn btn-primary btn-big"
            data-test="enter-room"
            onClick={() => {
              setError(null);
              controller.enter().catch(() => undefined);
            }}
          >
            Enter the room
          </button>
        </div>
      )}
      {error && !retryEnter && <p class="meta bad">Something went wrong ({error.code}).</p>}
    </Page>
  );
}

function BareRoom(props: { id?: string }) {
  const stage = useRef<HTMLDivElement>(null);
  const [handle, setHandle] = useState<ImmersiveHandle | null>(null);
  const [note, setNote] = useState('');

  useEffect(() => {
    if (!stage.current) return;
    let live = true;
    let h: ImmersiveHandle | null = null;
    import('../xr/entry')
      .then((m) => m.createImmersive(stage.current as HTMLElement))
      .then((created) => {
        h = created;
        if (live) setHandle(created);
        else created.destroy();
      })
      .catch(() => live && setNote('The room could not load on this device.'));
    return () => {
      live = false;
      h?.destroy();
    };
  }, []);

  return (
    <Page test="session" title="Live round" lede="Put on your headset and enter the room.">
      <p class="meta">
        Session <code>{props.id}</code>
      </p>
      {handle?.mode !== 'preview' && (
        <div class="row">
          <button class="btn btn-primary" data-test="enter-room" disabled={!handle} onClick={() => {
              setNote('');
              handle?.enter().catch((e: Error) => setNote(e.message));
            }}>
            Enter the room
          </button>
        </div>
      )}
      {handle?.mode === 'preview' && <p class="meta" data-test="preview-note">No headset here, so this is a preview of the room.</p>}
      {note && <p class="meta bad">{note}</p>}
      <div class="xr-stage" ref={stage} />
    </Page>
  );
}

function NotFound() {
  return (
    <Page test="not-found" title="Page not found" lede="That link does not go anywhere.">
      <a class="btn" href="/">
        Go home
      </a>
    </Page>
  );
}

function TopBar() {
  const { path } = useLocation();
  const link = (href: string, label: string) => (
    <a href={href} aria-current={path === href ? 'page' : undefined}>
      {label}
    </a>
  );
  return (
    <header class="topbar">
      <a class="skip" href="#main">
        Skip to content
      </a>
      <a class="wordmark" href="/" aria-label="Interview Rounds, home">
        <svg class="wordmark-mark" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
          <rect x="2" y="13" width="20" height="3" rx="1.5" fill="currentColor" />
          <circle cx="7" cy="7.5" r="3" fill="none" stroke="currentColor" stroke-width="2" />
          <circle cx="17" cy="7.5" r="3" fill="currentColor" />
        </svg>
        <span>Interview Rounds</span>
      </a>
      <nav class="nav" aria-label="Main">
        {link('/history', 'History')}
        {link('/settings', 'Settings')}
        {link('/pricing', 'Plans')}
      </nav>
    </header>
  );
}

export function App() {
  return (
    <LocationProvider>
      <div class="shell">
        <TopBar />
        <main class="page" id="main">
          <Router>
            <Route path={ROUTES.home} component={Home} />
            <Route path={ROUTES.pickRole} component={PickRole} />
            <Route path={ROUTES.pickRound} component={PickRound} />
            <Route path={ROUTES.start} component={Start} />
            <Route path={ROUTES.meeting} component={MeetingSetup} />
            <Route path={ROUTES.session} component={Session} />
            <Route path={ROUTES.report} component={Report} />
            <Route path={ROUTES.history} component={History} />
            <Route path={ROUTES.settings} component={Settings} />
            <Route path={ROUTES.pricing} component={Pricing} />
            <Route path={ROUTES.notSupported} component={NotSupported} />
            <Route path={ROUTES.resume} component={Resume} />
            {DevBoard ? [<Route key="dev-board" path="/dev/board" component={DevBoard} />] : []}
            {DevSheet ? [<Route key="dev-sheet" path="/dev/sheet" component={DevSheet} />] : []}
            {AvatarDev ? [<Route key="dev-avatar" path={ROUTES.devAvatar} component={AvatarDev} />] : []}
            <Route default component={NotFound} />
          </Router>
        </main>
      </div>
    </LocationProvider>
  );
}
