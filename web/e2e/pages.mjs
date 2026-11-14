// Screenshots of every 2D page and state, against the fixture API (?fake=<scenario>), at the
// Quest Browser size with its dim palette and at phone width.
//   Emulator run (see README.md): viewport 1280x720; 2 CPU cores are enough.
// Each batch runs inside the managed browser (Playwright page and the app frame).
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { iwsdk, sleep, waitReady } from './emu-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// act: source of an async function body run before the capture, with frame and page in scope.
const micOn = `await frame.evaluate(() => {
  const ctx = new AudioContext();
  navigator.mediaDevices.getUserMedia = async () => ctx.createMediaStreamDestination().stream;
});`;
const micFails = (name) => `await frame.evaluate((n) => {
  navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('blocked', n));
}, ${JSON.stringify(name)});`;
const tap = (test) => `await frame.click('[data-test="${test}"]'); await page.waitForTimeout(700);`;
const launch = (status) => `await frame.waitForSelector('[data-launch="${status}"]', { timeout: 15000 });`;

const SHOTS = [
  { name: 'home', path: '/' },
  { name: 'home-first-visit', path: '/', fake: 'first', act: tap('how-toggle') },
  { name: 'home-resume', path: '/', fake: 'resume' },
  { name: 'home-capped', path: '/', fake: 'capped' },
  { name: 'pick-role', path: '/start' },
  { name: 'pick-round', path: '/start/sde' },
  { name: 'start', path: '/round/sde.system_design.short' },
  { name: 'start-ready', path: '/round/sde.system_design.short', act: micOn + tap('mic-allow') + launch('ready') },
  {
    name: 'start-prepare-failed',
    path: '/round/sde.system_design.short',
    act:
      micOn +
      `await frame.evaluate(() => {
        const real = window.fetch;
        window.__realFetch = real;
        window.fetch = (u, i) => (String(u).endsWith('/api/sessions') ? Promise.resolve(new Response('', { status: 503 })) : real(u, i));
      });` +
      tap('mic-allow') +
      launch('failed'),
  },
  { name: 'resume', path: '/resume/s_resume', fake: 'resume' },
  { name: 'start-mic-denied', path: '/round/sde.system_design.short', act: micFails('NotAllowedError') + tap('mic-allow') },
  { name: 'start-no-mic', path: '/round/sde.system_design.short', act: micFails('NotFoundError') + tap('mic-allow') },
  { name: 'start-adjust', path: '/round/sde.system_design.short', act: `await frame.click('[data-test="adjust"] summary'); await page.waitForTimeout(400);` },
  { name: 'start-preview-qr', path: '/round/sde.system_design.short', query: 'preview=1', act: micOn + tap('mic-allow') },
  { name: 'start-retry', path: '/round/sde.system_design.short', query: 'retry=demo' },
  { name: 'start-capped', path: '/round/sde.system_design.short', fake: 'capped' },
  { name: 'meeting-setup', path: '/meeting/new' },
  { name: 'meeting-edit', path: '/meeting/new', act: `await frame.click('[data-test="edit-people"] summary'); await page.waitForTimeout(400);` },
  { name: 'meeting-errors', path: '/meeting/new', act: tap('template-custom') + tap('prepare') },
  { name: 'meeting-prepared', path: '/meeting/new', act: tap('prepare') + `await frame.waitForSelector('[data-test="prepared"]');` },
  {
    name: 'meeting-ready',
    path: '/meeting/new',
    act: tap('prepare') + `await frame.waitForSelector('[data-test="prepared"]');` + micOn + tap('mic-allow') + launch('ready'),
  },
  { name: 'report', path: '/report/demo' },
  { name: 'report-explainer', path: '/report/demo', act: tap('verdict-explain-toggle') },
  { name: 'report-share-on', path: '/report/demo', act: tap('share-toggle') },
  { name: 'report-meeting', path: '/report/meeting' },
  { name: 'report-not-enough-signal', path: '/report/nosignal' },
  { name: 'report-meeting-no-decision', path: '/report/meeting-bare' },
  { name: 'report-broken', path: '/report/broken' },
  { name: 'report-share-transcript', path: '/report/demo', act: tap('share-toggle') + tap('share-transcript') },
  { name: 'report-scoring', path: '/report/scoring', wait: 3000, noIdle: true },
  { name: 'report-failed', path: '/report/failed' },
  { name: 'history', path: '/history' },
  { name: 'history-empty', path: '/history', fake: 'empty' },
  { name: 'settings', path: '/settings' },
  { name: 'settings-delete-confirm', path: '/settings', act: tap('delete-data') },
  { name: 'pricing', path: '/pricing' },
  { name: 'pricing-pro', path: '/pricing', fake: 'user' },
  { name: 'not-supported', path: '/not-supported' },
  { name: 'not-found', path: '/nope' },
];

const VIEWS = [
  // Quest Browser 2D window, with the dim palette it gets there.
  { tag: 'quest', width: 1280, height: 720, device: 'quest' },
  // A phone, light palette.
  { tag: 'phone', width: 390, height: 844, device: 'other' },
];

const only = process.env.SHOTS_ONLY ? new RegExp(process.env.SHOTS_ONLY) : null;

let n = 0;
async function batch(view, shots) {
  n += 1;
  const file = path.join(HERE, `pages-batch-${n}.mjs`);
  const body = shots
    .map(
      (s) => `  await shot(${JSON.stringify(s)}, async () => { ${s.act ?? ''} });`,
    )
    .join('\n');
  writeFileSync(
    file,
    `export default async function ({ page, frame }) {
  const VIEW = ${JSON.stringify(view)};
  const out = [];
  const origin = new URL(frame.url()).origin;
  // One real page load per batch; every shot after that is a client side move, so the
  // renderer is not rebuilt (and the tooling world not restarted) for each one.
  if (!/[?&]fake=/.test(frame.url())) {
    await frame.goto(origin + '/?fake=1', { waitUntil: 'domcontentloaded' });
    await frame.waitForSelector('[data-test^="page-"]', { timeout: 30000 });
  }
  const go = (url) =>
    frame.evaluate((u) => {
      window.__irFakeReset && window.__irFakeReset();
      history.pushState(null, '', u);
      dispatchEvent(new PopStateEvent('popstate'));
    }, url);
  const shot = async (s, act) => {
    try {
      await page.setViewportSize({ width: VIEW.width, height: VIEW.height });
      // Undo a fetch patch an earlier shot made (client side moves keep the page's globals).
      await frame.evaluate(() => {
        if (window.__realFetch) {
          window.fetch = window.__realFetch;
          delete window.__realFetch;
        }
      });
      await frame.evaluate((d) => {
        if (d === 'quest') document.documentElement.dataset.device = 'quest';
        else delete document.documentElement.dataset.device;
      }, VIEW.device);
      const q = new URLSearchParams(s.query || '');
      q.set('fake', s.fake || '1');
      // A blank route first, so the target page mounts fresh.
      await go('/_blank?fake=' + (s.fake || '1'));
      await frame.waitForSelector('[data-test="page-not-found"]', { timeout: 10000 });
      await go(s.path + '?' + q.toString());
      if (s.path !== '/nope') await frame.waitForSelector('[data-test^="page-"]:not([data-test="page-not-found"])', { timeout: 20000 });
      await frame.waitForFunction(() => !document.querySelector('[data-test="loading"]'), null, { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(s.wait || 900);
      await act();
      await frame.evaluate(() => { window.scrollTo(0, 0); document.activeElement && document.activeElement.blur && document.activeElement.blur(); });
      const h = await frame.evaluate(() => document.documentElement.scrollHeight);
      await page.setViewportSize({ width: VIEW.width, height: Math.min(Math.max(h, VIEW.height), 6000) });
      await page.waitForTimeout(300);
      const file = process.env.EMU_SHOTS + '/' + s.name + '-' + VIEW.tag + '.png';
      await page.screenshot({ path: file });
      out.push(s.name + ':ok:' + h);
    } catch (e) {
      out.push(s.name + ':ERR:' + String(e && e.message).slice(0, 200));
    }
  };
${body}
  await page.setViewportSize({ width: VIEW.width, height: VIEW.height });
  return out;
}
`,
  );
  const res = await iwsdk('browser', 'run', path.relative(process.cwd(), file), '--timeout', '100000');
  const result = res?.data?.result ?? res?.result ?? res;
  console.log(`${view.tag} batch ${n}: ${JSON.stringify(result)}`);
  return result;
}

await waitReady();
await sleep(2000);

let failed = 0;
for (const view of VIEWS) {
  const list = SHOTS.filter((s) => !only || only.test(s.name));
  for (let i = 0; i < list.length; i += 5) {
    const r = await batch(view, list.slice(i, i + 5)).catch((e) => {
      console.error(`batch failed: ${e.message.slice(0, 600)}`);
      return null;
    });
    const items = Array.isArray(r) ? r : [];
    failed += items.filter((x) => String(x).includes(':ERR:')).length + (Array.isArray(r) ? 0 : 1);
    await sleep(300);
  }
}
console.log(failed ? `pages: ${failed} problems` : 'pages ok');
process.exit(failed ? 1 : 0);
