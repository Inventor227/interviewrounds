// Tests for tools/content-check.mjs. Run: node --test tools/
// Schemas come from content/schema/ (or CONTENT_SCHEMA_DIR when the schemas live in another checkout).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkContent, validate, placeholdersIn } from './content-check.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const schemaDir = process.env.CONTENT_SCHEMA_DIR ?? join(root, 'content', 'schema');

function scratchCopy() {
  const dir = mkdtempSync(join(tmpdir(), 'content-check-'));
  cpSync(join(root, 'content'), join(dir, 'content'), { recursive: true });
  return dir;
}
function editJson(path, fn) {
  const data = JSON.parse(readFileSync(path, 'utf8'));
  fn(data);
  writeFileSync(path, JSON.stringify(data, null, 2));
}

test('content_is_valid_and_linked', () => {
  const errors = checkContent(root, { schemaDir });
  assert.deepEqual(errors, []);
});

test('validator rejects wrong types, missing fields and extra fields', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'n'],
    properties: { id: { type: 'string', pattern: '^a' }, n: { type: 'integer', minimum: 1 } },
  };
  assert.deepEqual(validate(schema, { id: 'ab', n: 2 }), []);
  assert.equal(validate(schema, { id: 'b', n: 2 }).length, 1);
  assert.equal(validate(schema, { id: 'a' }).length, 1);
  assert.equal(validate(schema, { id: 'a', n: 1.5 }).length, 1);
  assert.equal(validate(schema, { id: 'a', n: 1, x: 1 }).length, 1);
});

test('validator fails loudly on keywords it does not support', () => {
  assert.throws(() => validate({ dependentSchemas: {} }, {}), /unsupported/);
});

test('a broken persona reference is reported', () => {
  const dir = scratchCopy();
  try {
    editJson(join(dir, 'content/rounds/sde.coding.short.json'), (r) => (r.panel.lead = 'persona.nobody'));
    const errors = checkContent(dir, { schemaDir });
    assert.ok(errors.some((e) => e.includes('persona.nobody')), errors.join('\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a round without its other length is reported', () => {
  const dir = scratchCopy();
  try {
    rmSync(join(dir, 'content/rounds/pm.execution.full.json'));
    const errors = checkContent(dir, { schemaDir });
    assert.ok(errors.some((e) => e.includes('pm.execution.full')), errors.join('\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an em dash in user-facing copy is reported', () => {
  const dir = scratchCopy();
  try {
    editJson(join(dir, 'content/meeting-templates/investor_pitch.json'), (t) => (t.tips[0] = 'Lead with the ask \u2014 then traction.'));
    const errors = checkContent(dir, { schemaDir });
    assert.ok(errors.some((e) => e.includes('investor_pitch.json') && e.includes('dash')), errors.join('\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('two people sharing an avatar in one meeting template is reported', () => {
  const dir = scratchCopy();
  try {
    editJson(join(dir, 'content/meeting-templates/project_kickoff.json'), (t) => (t.attendees[1].voice_base = 'persona.leo'));
    const errors = checkContent(dir, { schemaDir });
    assert.ok(errors.some((e) => e.includes('project_kickoff') && e.includes('avatar')), errors.join('\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an undeclared prompt placeholder is reported', () => {
  const dir = scratchCopy();
  try {
    const p = join(dir, 'content/prompts/scribe.md');
    writeFileSync(p, readFileSync(p, 'utf8') + '\nAlso {mystery.value}.\n');
    const errors = checkContent(dir, { schemaDir });
    assert.ok(errors.some((e) => e.includes('{mystery.value}')), errors.join('\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('placeholdersIn finds dotted names and ignores JSON braces', () => {
  assert.deepEqual(placeholdersIn('Hi {persona.display_name}, {"id","kind"} {x}'), ['persona.display_name', 'x']);
});

test('a live prompt that ignores an app marker is reported', () => {
  const dir = scratchCopy();
  try {
    const p = join(dir, 'content/prompts/round-meeting.md');
    writeFileSync(p, readFileSync(p, 'utf8').replaceAll('[event: long_answer]', 'a long answer'));
    const errors = checkContent(dir, { schemaDir });
    assert.ok(errors.some((e) => e.includes('round-meeting.md') && e.includes('long_answer')), errors.join('\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
