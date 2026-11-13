// Emulator smoke test for the app shell: the home page renders, and a tile routes
// client side to its page. Run with plan tooling: emu.sh <worktree> web/e2e/shell.mjs
import { call, iwsdk, screenshot, sleep, waitReady } from './emu-lib.mjs';

await waitReady();
await sleep(2000);
await screenshot('home');

const snap = await iwsdk('browser', 'snapshot');
const text = JSON.stringify(snap);
if (!text.includes('Software Engineer')) {
  console.error('home page did not render its tiles:', text.slice(0, 2000));
  process.exit(1);
}

await call('browser', 'interact', { steps: [{ action: 'click', locator: { text: 'Software Engineer' } }] });
await sleep(1000);
await screenshot('pick-round');
const after = JSON.stringify(await iwsdk('browser', 'snapshot'));
if (!after.includes('Pick a round')) {
  console.error('tile did not route to the pick round page:', after.slice(0, 2000));
  process.exit(1);
}
console.log('shell ok');
