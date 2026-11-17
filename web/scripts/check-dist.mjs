// Fails if a production build carries developer-only pages or assets, or leaves out the room's UI font (run after
// `npm run build`).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const dist = path.resolve(process.argv[2] ?? 'dist');
const files = [];
const walk = (d) => {
  for (const f of readdirSync(d)) {
    const p = path.join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else files.push(p);
  }
};
walk(dist);

/** Development hooks that must never reach a production bundle (each one sits behind `import.meta.env.DEV`). */
const DEV_HOOKS = ['__avatarDev', '__irNoRender', '__recorder', 'ir_record', '__emu_voice'];

/**
 * IWSDK's build drops the bundled UIKit fonts it is not told about and exports a stub that throws in their place (from
 * a `*disabled-bundled-fonts*` chunk). The room's panels use UIKit's default font, Inter: stubbed, every label,
 * caption and card in the room is blank, and each panel's wait for the font keeps its whole room in memory after the
 * round.
 */
const UI_FONT_STUBBED = /\bas inter\b/;

const bad = [];
for (const f of files) {
  const rel = path.relative(dist, f);
  if (/(^|\/)voice-[fm][^/]*\.wav$/.test(rel) || /AvatarDev/.test(rel) || /devScene/.test(rel) || /(^|\/)__emu_voice(\/|$)/.test(rel)) bad.push(rel);
  if (/\.(js|mjs|html)$/.test(f)) {
    const text = readFileSync(f, 'utf8');
    for (const hook of DEV_HOOKS) if (text.includes(hook)) bad.push(`${rel} (mentions ${hook})`);
    if (/disabled-bundled-fonts/.test(rel) && UI_FONT_STUBBED.test(text)) bad.push(`${rel} (the room's UI font, Inter, is left out: add it to iwsdkDev bundle.fonts)`);
  }
}
if (bad.length) {
  console.error(`not fit for production, ${dist}:\n  ${bad.join('\n  ')}`);
  process.exit(1);
}
console.log(`dist ok: ${files.length} files, no dev pages or hooks, UI font included`);
