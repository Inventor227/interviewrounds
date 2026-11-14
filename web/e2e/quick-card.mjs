// Emulator shot of the quick card (the one line, the top strength and the top fix) in the preview room, with a
// sample card of full length, to check the wrapping. No server needed.
//   Emulator run (see README.md): viewport 1280x720.
import { copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitReady } from './emu-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
copyFileSync(path.join(process.env.EMU_APP_DIR, 'e2e', 'round-lib.mjs'), path.join(here, 'round-lib.mjs'));
const { go, page, screenshot, sleep, until } = await import('./round-lib.mjs');

const CARD = {
  one_line: 'You laid out a solid, resilient architecture, but never walked one seat pick end to end or said what breaks first.',
  top_strength: { title: 'Idempotency and failure handling built in', evidence_id: 'c1', quote: 'Every message carries a key, so a retry after a timeout never books the same seat twice for the same fan.', t_start_sec: 212 },
  top_fix: { title: 'Answer the question that was asked first', evidence_id: 'c2', quote: 'Let me go back to the cache for a second before I get to that.', t_start_sec: 301 },
};

await waitReady();
await go('/session/emu?view=preview');
await until('the preview room', () => !!globalThis.__xrApp, null, 90000);
await sleep(4000);
// The status card with progress, as the controller shows it while the scorecard is written (in live runs the
// scorecard of a short typed round is done before a capture can catch this card).
await page(() => globalThis.__xrApp.ui.showStatusText('Writing your scorecard', 0.4));
await page(() => document.querySelector('.xr-stage')?.scrollIntoView({ block: 'start' }));
await sleep(2000);
await screenshot('status-progress');
await page((c) => globalThis.__xrApp.ui.showQuickCard(c), CARD);
await page(() => document.querySelector('.xr-stage')?.scrollIntoView({ block: 'start' }));
await sleep(2500);
await screenshot('quick-card');
await page(() => globalThis.__xrApp.ui.showQuickCard({ one_line: 'Your scorecard is taking longer than usual. Open the full report to see it.', top_strength: null, top_fix: null }));
await sleep(2000);
await screenshot('quick-card-fallback');
console.log('quick card ok');
