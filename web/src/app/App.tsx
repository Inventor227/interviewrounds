import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { LocationProvider, Route, Router, lazy, useLocation } from 'preact-iso';
import type { ImmersiveHandle } from '../xr/entry';

// App shell: routes and a themed placeholder per page. Real pages replace the
// placeholders one by one; keep the paths and the data-test ids stable.

export const ROUTES = {
  home: '/',
  pickRound: '/start/:role',
  start: '/round/:roundId',
  meeting: '/meeting/new',
  session: '/session/:id',
  report: '/report/:id',
  history: '/history',
  settings: '/settings',
  pricing: '/pricing',
  devAvatar: '/dev/avatar',
} as const;

// Developer page for the avatar runtime: dev server only. In production builds the condition is false at build time,
// so the page, its chunk and its test voices are left out of dist entirely.
const AvatarDev = import.meta.env.DEV ? lazy(() => import('../xr/avatar/dev/AvatarDev')) : null;

const ROLE_NAMES: Record<string, string> = { sde: 'Software Engineer', pm: 'Product Manager' };

function Page(props: { test: string; title: string; lede: string; children?: ComponentChildren }) {
  return (
    <section data-test={`page-${props.test}`} aria-labelledby="page-title">
      <h1 id="page-title">{props.title}</h1>
      <p class="lede">{props.lede}</p>
      {props.children}
    </section>
  );
}

function Soon(props: { children?: ComponentChildren }) {
  return (
    <div class="card placeholder" data-test="placeholder">
      {props.children ?? 'This page is being built.'}
    </div>
  );
}

function Home() {
  return (
    <Page test="home" title="Practice with people across your desk" lede="Real interview rounds and meetings in your own room, with a clear scorecard after.">
      <div class="tiles">
        <a class="tile" href="/start/sde" data-test="tile-sde">
          <strong>Software Engineer</strong>
          <span>Coding, system design, object design, behavioral</span>
        </a>
        <a class="tile" href="/start/pm" data-test="tile-pm">
          <strong>Product Manager</strong>
          <span>Product sense, execution, strategy, leadership</span>
        </a>
        <a class="tile" href="/meeting/new" data-test="tile-meeting">
          <strong>A real meeting</strong>
          <span>Rehearse a pitch, a review or a negotiation</span>
        </a>
      </div>
    </Page>
  );
}

function PickRound(props: { role?: string }) {
  const name = ROLE_NAMES[props.role ?? ''] ?? 'this role';
  return (
    <Page test="pick-round" title="Pick a round" lede={`Rounds for ${name}. Each one starts in about a minute.`}>
      <Soon />
    </Page>
  );
}

function Start(props: { roundId?: string }) {
  return (
    <Page test="start" title="Get ready" lede="Check your mic and headset, then start.">
      <p class="meta">
        Round <code>{props.roundId}</code>
      </p>
      <Soon />
    </Page>
  );
}

function MeetingNew() {
  return (
    <Page test="meeting" title="Set up a meeting" lede="Who is in the room, what they care about, and what you want from them.">
      <Soon />
    </Page>
  );
}

function Session(props: { id?: string }) {
  const stage = useRef<HTMLDivElement>(null);
  const [handle, setHandle] = useState<ImmersiveHandle | null>(null);
  const [note, setNote] = useState('');
  const supported = typeof navigator !== 'undefined' && 'xr' in navigator;

  useEffect(() => {
    if (!supported || !stage.current) return;
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
  }, [supported]);

  return (
    <Page test="session" title="Live round" lede="Put on your headset and enter the room.">
      <p class="meta">
        Session <code>{props.id}</code>
      </p>
      <div class="row">
        <button class="btn btn-primary" data-test="enter-room" disabled={!handle} onClick={() => handle?.enter()}>
          Enter the room
        </button>
      </div>
      {!supported && <p class="meta">This browser has no WebXR. A 2D preview comes later.</p>}
      {note && <p class="meta bad">{note}</p>}
      <div class="xr-stage" ref={stage} />
    </Page>
  );
}

function ReportPage(props: { id?: string }) {
  return (
    <Page test="report" title="Your report" lede="How it went, what to keep and what to practice next.">
      <p class="meta">
        Session <code>{props.id}</code>
      </p>
      <Soon />
    </Page>
  );
}

function History() {
  return (
    <Page test="history" title="History" lede="Every round you have done, newest first.">
      <Soon />
    </Page>
  );
}

function SettingsPage() {
  return (
    <Page test="settings" title="Settings" lede="Your defaults for rounds, voice and the room.">
      <Soon />
    </Page>
  );
}

function Pricing() {
  return (
    <Page test="pricing" title="Plans" lede="Try it free. Pay only for live practice minutes.">
      <Soon />
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
      <a class="wordmark" href="/">
        Interview Rounds
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
        <main class="page">
          <Router>
            <Route path={ROUTES.home} component={Home} />
            <Route path={ROUTES.pickRound} component={PickRound} />
            <Route path={ROUTES.start} component={Start} />
            <Route path={ROUTES.meeting} component={MeetingNew} />
            <Route path={ROUTES.session} component={Session} />
            <Route path={ROUTES.report} component={ReportPage} />
            <Route path={ROUTES.history} component={History} />
            <Route path={ROUTES.settings} component={SettingsPage} />
            <Route path={ROUTES.pricing} component={Pricing} />
            {AvatarDev ? [<Route key="dev-avatar" path={ROUTES.devAvatar} component={AvatarDev} />] : []}
            <Route default component={NotFound} />
          </Router>
        </main>
      </div>
    </LocationProvider>
  );
}
