#!/usr/bin/env node
// Copy check: user-facing text must not use em dashes or en dashes.
// Scans string literals, template literals and JSX text in web/src/**/*.{ts,tsx} (everything outside comments),
// and string values in content/**/*.json (identifier fields and content/schema/ are skipped).
// Usage: node tools/check-copy.mjs [rootDir]   exits 1 when it finds a violation.

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DASH = /[\u2013\u2014]/;
const DASH_ESCAPE = /\\u(?:201[34]|\{0*201[34]\})/i;

function walk(dir, accept, out = []) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, accept, out);
    else if (entry.isFile() && accept(path)) out.push(path);
  }
  return out;
}

// Returns the source with comments blanked out (newlines kept, so line numbers stay true).
export function stripComments(src) {
  let out = '';
  let i = 0;
  const braces = []; // for template literals: depth of `${` nesting
  let mode = 'code'; // code | sq | dq | tpl
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (mode === 'code') {
      // `//` right after `:` is a URL (https://...) in JSX text, not a comment.
      if (c === '/' && d === '/' && src[i - 1] !== ':') {
        while (i < n && src[i] !== '\n') {
          out += ' ';
          i++;
        }
        continue;
      }
      if (c === '/' && d === '*') {
        out += '  ';
        i += 2;
        while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
          out += src[i] === '\n' ? '\n' : ' ';
          i++;
        }
        if (i < n) {
          out += '  ';
          i += 2;
        }
        continue;
      }
      if (c === "'") mode = 'sq';
      else if (c === '"') mode = 'dq';
      else if (c === '`') mode = 'tpl';
      else if (c === '{' && braces.length) braces[braces.length - 1]++;
      else if (c === '}' && braces.length) {
        if (braces[braces.length - 1] === 0) {
          braces.pop();
          mode = 'tpl';
        } else braces[braces.length - 1]--;
      }
      out += c;
      i++;
      continue;
    }
    // inside a string or template literal
    if (c === '\\') {
      out += src.slice(i, i + 2);
      i += 2;
      continue;
    }
    if ((mode === 'sq' && c === "'") || (mode === 'dq' && c === '"') || (mode === 'tpl' && c === '`')) {
      mode = 'code';
    } else if ((mode === 'sq' || mode === 'dq') && c === '\n') {
      mode = 'code'; // unterminated string: recover at end of line
    } else if (mode === 'tpl' && c === '$' && d === '{') {
      braces.push(0);
      mode = 'code';
      out += '${';
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function checkSource(path, rootDir) {
  const lines = stripComments(readFileSync(path, 'utf8')).split('\n');
  const found = [];
  lines.forEach((line, idx) => {
    if (DASH.test(line) || DASH_ESCAPE.test(line)) {
      found.push({ file: relative(rootDir, path), line: idx + 1, text: line.trim() });
    }
  });
  return found;
}

function isIdentifierKey(key) {
  return key === 'id' || key === 'schema' || key.startsWith('$') || key.endsWith('_id') || key.endsWith('_ids');
}

// Minimal JSON reader that keeps the line of every string value and the key it sits under.
function jsonStrings(text) {
  const values = [];
  let i = 0;
  let line = 1;
  const ws = () => {
    while (i < text.length && /\s/.test(text[i])) {
      if (text[i] === '\n') line++;
      i++;
    }
  };
  const str = () => {
    const start = i;
    const startLine = line;
    i++;
    while (i < text.length && text[i] !== '"') {
      if (text[i] === '\\') i++;
      else if (text[i] === '\n') line++;
      i++;
    }
    i++;
    return { value: JSON.parse(text.slice(start, i)), line: startLine };
  };
  const value = (key) => {
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      ws();
      if (text[i] === '}') {
        i++;
        return;
      }
      for (;;) {
        ws();
        const k = str().value;
        ws();
        i++; // :
        value(k);
        ws();
        if (text[i++] === '}') return;
      }
    }
    if (c === '[') {
      i++;
      ws();
      if (text[i] === ']') {
        i++;
        return;
      }
      for (;;) {
        value(key);
        ws();
        if (text[i++] === ']') return;
      }
    }
    if (c === '"') {
      const s = str();
      values.push({ key, ...s });
      return;
    }
    while (i < text.length && /[^,\]}\s]/.test(text[i])) i++; // number, true, false, null
  };
  value(null);
  return values;
}

function checkJson(path, rootDir) {
  const text = readFileSync(path, 'utf8');
  try {
    JSON.parse(text);
  } catch (err) {
    return [{ file: relative(rootDir, path), line: 1, text: `invalid JSON: ${err.message}` }];
  }
  return jsonStrings(text)
    .filter((s) => !(s.key && isIdentifierKey(s.key)) && DASH.test(s.value))
    .map((s) => ({ file: relative(rootDir, path), line: s.line, text: s.value }));
}

/** @returns {{file: string, line: number, text: string}[]} */
export function checkCopy(rootDir) {
  const root = resolve(rootDir);
  const violations = [];
  for (const file of walk(join(root, 'web', 'src'), (p) => /\.tsx?$/.test(p) && !p.endsWith('.d.ts'))) {
    violations.push(...checkSource(file, root));
  }
  const schemaDir = join(root, 'content', 'schema') + sep;
  for (const file of walk(join(root, 'content'), (p) => p.endsWith('.json') && !p.startsWith(schemaDir))) {
    violations.push(...checkJson(file, root));
  }
  return violations;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const root = process.argv[2] ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const violations = checkCopy(root);
  for (const v of violations) console.log(`${v.file}:${v.line}: ${v.text}`);
  if (violations.length) {
    console.error(`check-copy: ${violations.length} em or en dash(es) in user-facing copy. Use a comma, a colon or a period.`);
    process.exit(1);
  }
  console.log('check-copy: clean');
}
