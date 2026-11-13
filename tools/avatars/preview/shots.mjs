// Render screenshots of converted avatars with headless Chromium.
//   node shots.mjs <avatars_dir> <manifest.json> <out_dir> [ids...]
// Run inside the Playwright image (Chromium with SwiftShader WebGL).
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const [avatarsDir, manifestPath, outDir, ...only] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.wasm': 'application/wasm' };
const roots = [
  ['/avatars/', avatarsDir],
  ['/three/', join(here, 'node_modules/three')],
  ['/', here],
];
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path === '/avatars/manifest.json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(readFileSync(manifestPath));
    return;
  }
  for (const [prefix, dir] of roots) {
    if (!path.startsWith(prefix)) continue;
    const file = normalize(join(dir, path.slice(prefix.length) || 'index.html'));
    if (!file.startsWith(normalize(dir)) || !existsSync(file)) continue;
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const ids = only.length ? only : manifest.avatars.map((a) => a.id);
const shots = [];
for (const id of ids) {
  shots.push({ name: `${id}-seated`, q: { id, clip: 'sit_table_breathe_01', t: 2, view: 'seated' } });
  shots.push({ name: `${id}-face-aa`, q: { id, clip: 'sit_table_breathe_01', t: 2, view: 'face', morphs: 'viseme_aa:1' } });
  shots.push({ name: `${id}-face-blink`, q: { id, clip: 'sit_table_breathe_01', t: 2, view: 'face', morphs: 'eyeBlinkLeft:1,eyeBlinkRight:1,mouthSmileLeft:0.6,mouthSmileRight:0.6' } });
}
// Every clip once per sex, on the first avatar of that sex, near the middle of the clip.
const MID = { sit_table_breathe_01: 6, idle_neutral_01: 10, idle_neutral_02: 10, gestic_thoughtful: 6, gestic_listen_accept_01: 1, gestic_listen_accept_02: 1, gestic_listen_accept_03: 2, idle_touch_face: 2 };
for (const sex of ['f', 'm']) {
  const first = manifest.avatars.find((a) => a.sex === sex && ids.includes(a.id));
  const lib = manifest.anim_libraries.find((l) => l.sex === sex);
  if (!first || !lib) continue;
  for (const clip of lib.clips) {
    shots.push({ name: `${first.id}-clip-${clip}`, q: { id: first.id, clip, t: MID[clip] ?? 1, view: 'seated' } });
  }
}

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 960, height: 1080 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
const results = [];
for (const shot of shots) {
  errors.length = 0;
  const url = `${base}/index.html?${new URLSearchParams(shot.q)}`;
  await page.goto(url);
  try {
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 120000 });
  } catch (e) {
    console.log('SHOT_FAIL', shot.name, errors.join(' | ') || e.message);
    results.push({ name: shot.name, error: errors.join(' | ') || e.message });
    continue;
  }
  await page.screenshot({ path: join(outDir, `${shot.name}.png`) });
  const r = await page.evaluate(() => window.__result);
  results.push({ name: shot.name, ...r, errors: [...errors] });
  console.log('SHOT_OK', shot.name, JSON.stringify(r), errors.length ? `errors: ${errors.join(' | ')}` : '');
}
writeFileSync(join(outDir, 'shots.json'), `${JSON.stringify(results, null, 2)}\n`);
await browser.close();
server.close();
process.exit(results.some((r) => r.error) ? 1 : 0);
