// Fails if a production build carries developer-only pages or assets (run after `npm run build`).
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

const bad = [];
for (const f of files) {
  const rel = path.relative(dist, f);
  if (/(^|\/)voice-[fm][^/]*\.wav$/.test(rel) || /AvatarDev/.test(rel) || /devScene/.test(rel)) bad.push(rel);
  if (/\.(js|mjs|html)$/.test(f) && readFileSync(f, 'utf8').includes('__avatarDev')) bad.push(`${rel} (mentions __avatarDev)`);
}
if (bad.length) {
  console.error(`dev-only files in ${dist}:\n  ${bad.join('\n  ')}`);
  process.exit(1);
}
console.log(`dist ok: ${files.length} files, no dev pages`);
