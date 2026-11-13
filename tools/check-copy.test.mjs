import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkCopy } from './check-copy.mjs';

const EM = '\u2014';
const EN = '\u2013';
const CLI = join(dirname(fileURLToPath(import.meta.url)), 'check-copy.mjs');

function makeRoot(files) {
  const root = mkdtempSync(join(tmpdir(), 'check-copy-'));
  for (const [rel, body] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  }
  return root;
}

function withRoot(files, fn) {
  const root = makeRoot(files);
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('em dash in a ts string literal is one violation', () => {
  withRoot({ 'web/src/copy.ts': `export const s = "Let's go ${EM} now";\n` }, (root) => {
    const v = checkCopy(root);
    assert.equal(v.length, 1);
    assert.equal(v[0].file, join('web', 'src', 'copy.ts'));
    assert.equal(v[0].line, 1);
    assert.match(v[0].text, /Let's go/);
  });
});

test('a comma instead of the dash is clean', () => {
  withRoot({ 'web/src/copy.ts': `export const s = "Let's go, now";\n` }, (root) => {
    assert.deepEqual(checkCopy(root), []);
  });
});

test('en dash in tsx template literal and jsx text is caught, with line numbers', () => {
  const src = [
    'export function A() {',
    `  const t = \`from 1 ${EN} 3\`;`,
    `  return <p>Wait ${EM} what</p>;`,
    '}',
    '',
  ].join('\n');
  withRoot({ 'web/src/app/A.tsx': src }, (root) => {
    const v = checkCopy(root);
    assert.deepEqual(v.map((x) => x.line), [2, 3]);
  });
});

test('escaped dashes in a string literal are caught', () => {
  withRoot({ 'web/src/e.ts': 'export const s = "a \\u2014 b";\n' }, (root) => {
    assert.equal(checkCopy(root).length, 1);
  });
});

test('dashes inside comments are ignored, url slashes do not start comments', () => {
  const src = [
    `// note ${EM} fine`,
    `/* block ${EN}`,
    `   still comment ${EM} */`,
    'export const u = "https://example.test/a"; // ok',
    `export const bad = "x ${EM} y";`,
    '',
  ].join('\n');
  withRoot({ 'web/src/c.ts': src }, (root) => {
    const v = checkCopy(root);
    assert.equal(v.length, 1);
    assert.equal(v[0].line, 5);
  });
});

test('a url inside jsx text does not start a comment', () => {
  const src = [
    'export function L() {',
    `  return <a>see https://x.test, then ${EM} go</a>;`,
    '}',
    `const ok = 1; // real comment ${EM} ignored`,
    '',
  ].join('\n');
  withRoot({ 'web/src/L.tsx': src }, (root) => {
    const v = checkCopy(root);
    assert.deepEqual(v.map((x) => x.line), [2]);
  });
});

test('files outside web/src and other extensions are not scanned', () => {
  withRoot(
    {
      'web/vite.config.ts': `export const s = "a ${EM} b";\n`,
      'web/src/readme.md': `a ${EM} b\n`,
      'server/src/x.ts': `export const s = "a ${EM} b";\n`,
    },
    (root) => {
      assert.deepEqual(checkCopy(root), []);
    },
  );
});

test('content json string values are checked; content/schema is ignored', () => {
  const persona = `{\n  "id": "persona.x",\n  "speech_habits": [\n    "Short ${EM} sentences."\n  ]\n}\n`;
  withRoot(
    {
      'content/personas/x.json': persona,
      'content/schema/x.schema.json': `{ "description": "a ${EM} b" }\n`,
      'content/fixtures/ok.json': '{ "title": "Plain words, no dashes" }\n',
    },
    (root) => {
      const v = checkCopy(root);
      assert.equal(v.length, 1);
      assert.equal(v[0].file, join('content', 'personas', 'x.json'));
      assert.equal(v[0].line, 4);
      assert.equal(v[0].text, `Short ${EM} sentences.`);
    },
  );
});

test('identifier fields in content json are not user facing', () => {
  withRoot({ 'content/rounds/r.json': `{ "id": "a${EN}b", "rubric_id": "r${EN}1", "title": "ok" }\n` }, (root) => {
    assert.deepEqual(checkCopy(root), []);
  });
});

test('escaped dash in json is caught', () => {
  withRoot({ 'content/banks/b.json': '{ "prompt": "a \\u2013 b" }\n' }, (root) => {
    assert.equal(checkCopy(root).length, 1);
  });
});

test('missing web/src and content dirs give no violations', () => {
  withRoot({ 'README.md': 'x\n' }, (root) => {
    assert.deepEqual(checkCopy(root), []);
  });
});

test('cli exits 1 and lists violations, exits 0 when clean', () => {
  withRoot({ 'web/src/copy.ts': `export const s = "Let's go ${EM} now";\n` }, (root) => {
    const r = spawnSync(process.execPath, [CLI, root], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stdout + r.stderr, /web[/\\]src[/\\]copy\.ts:1/);
  });
  withRoot({ 'web/src/copy.ts': `export const s = "Let's go, now";\n` }, (root) => {
    const r = spawnSync(process.execPath, [CLI, root], { encoding: 'utf8' });
    assert.equal(r.status, 0);
  });
});
