// Headless voice latency call against /dev/voice-spike (Fish sessions: this costs money, about $0.07 per
// session-minute). Run it in a Playwright container on a server, never on a laptop:
//
//   docker run --rm --cpus 2 --memory 2g -v "$PWD:/w" -w /w --env-file spike.env \
//     -e MODE=single -e LABEL=call1 mcr.microsoft.com/playwright:v1.65.0-noble node driver.mjs
//
// spike.env: ORIGIN=https://rounds.dijmo.com and DEV_KEY=... . WAV is the fake microphone: candidate answers at
// 17 s, 28 s (a barge-in), 48 s (a long answer) and 92 s from the start of the microphone, silence between.
// MODE=single: one session, about 105 s; ASR=<model> overrides the speech recognizer; EMPTY=1 makes one reply
// empty at 75 s. MODE=joined: two panelists in one page for about 60 s, the second muted until a typed hand-over.
// Writes <LABEL>.json: the page's event log (ms since page load) and audio levels every 20 ms.
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const { ORIGIN, DEV_KEY, MODE = "single", ASR, LABEL = "call", WAV = "/w/call.wav" } = process.env;
const HARD_STOP_MS = MODE === "joined" ? 75_000 : 116_000; // from mic start; Fish bills per second
const out = `/w/${LABEL}.json`;
const consoleLines = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!DEV_KEY) throw new Error("DEV_KEY is required");
const redact = (text) => String(text).split(encodeURIComponent(DEV_KEY)).join("<dev key>").split(DEV_KEY).join("<dev key>");

const browser = await chromium.launch({
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${WAV}`,
    "--autoplay-policy=no-user-gesture-required",
  ],
});
let page;
let result = { label: LABEL, mode: MODE, asr: ASR || null };
const save = async () => {
  try {
    result.log = await page.evaluate(() => window.spikeLog);
    result.levels = await page.evaluate(() => window.spikeLevels);
  } catch (e) { result.save_error = String(e); }
  result.console = consoleLines.map(redact);
  writeFileSync(out, JSON.stringify(result));
};
const watchdog = setTimeout(async () => {
  console.error("watchdog: hard stop");
  try { await page.evaluate(() => window.spike.end()); } catch {}
  await save();
  await browser.close();
  process.exit(3);
}, HARD_STOP_MS + 40_000);

try {
  const ctx = await browser.newContext({ permissions: ["microphone"] });
  page = await ctx.newPage();
  page.on("console", (m) => consoleLines.push(`${m.type()}: ${m.text()}`.slice(0, 500)));
  page.on("pageerror", (e) => consoleLines.push(`pageerror: ${e.message}`));
  await page.goto(`${ORIGIN}/dev/voice-spike?key=${encodeURIComponent(DEV_KEY)}`);
  await page.waitForFunction(() => window.spike, null, { timeout: 30_000 });

  const panel = MODE === "joined" ? 2 : 1;
  const created = await page.evaluate((b) => window.spike.create(b), {
    round_id: MODE === "joined" ? "sde.system_design.full" : "sde.system_design.short",
    panel,
    asr_model: ASR || null,
  });
  result.session_id = created.session_id;
  result.fish_sessions = [];
  const t = () => page.evaluate(() => window.spikeLog.at(-1)?.t ?? 0);

  // start() resolves once connected; the fake mic file starts when the first session opens the microphone.
  let micStart = 0;
  for (let i = 0; i < panel; i++) {
    const id = await page.evaluate(
      ([i, tok]) => window.spike.start(i, tok, { longAnswerMs: i === 0 ? 8000 : 0 }),
      [i, created.panelists[i].token],
    );
    if (i === 0) { micStart = Date.now(); result.mic_start = await t(); }
    result.fish_sessions.push(id);
  }
  if (panel === 2) await page.evaluate(() => window.spike.mute(1, true));
  await page.evaluate(() => window.spike.send(0, "[event: start]"));

  const at = async (sec) => { const wait = micStart + sec * 1000 - Date.now(); if (wait > 0) await sleep(wait); };
  if (MODE === "single") {
    if (process.env.EMPTY) {
      await at(75);
      await page.evaluate(() => window.spike.emptyNext());
      await page.evaluate(() => window.spike.send(0, "[event: time_check]"));
    }
    await at(104);
    result.state = await page.evaluate(() => window.spike.state());
  } else {
    await at(36);
    // The second panelist gets the floor by a typed event (no prepared line, so the server asks the model).
    await page.evaluate(() => window.spike.send(1, "[event: handover]"));
    await at(58);
    result.state = await page.evaluate(() => window.spike.state());
  }
  await page.evaluate(() => window.spike.end());
  await sleep(1500);
} catch (e) {
  // Errors can quote the page address; the key never leaves this process.
  result.error = redact((e && e.stack) || e);
  try { await page.evaluate(() => window.spike.end()); } catch {}
} finally {
  clearTimeout(watchdog);
  await save();
  await browser.close();
}
console.log(JSON.stringify({ label: LABEL, session_id: result.session_id, fish: result.fish_sessions, error: result.error || null }));
