#!/usr/bin/env node
// Content check: every file in content/ is valid against its schema and every reference resolves.
// - rounds, personas, meeting templates: validated against content/schema/*.schema.json
// - rubrics, banks, voices.json: validated against the schemas in this file (they are content-only formats)
// - links: personas, rubrics, banks, voices, avatars, short/full pairs, panel avatars, attendee voice bases
// - copy: no em or en dashes in any content JSON string or prompt
// - prompts: every {placeholder} used in a prompt is declared in its header comment
// Usage: node tools/content-check.mjs [rootDir] [--schemas dir]   exits 1 when it finds a problem.
// No dependencies: a small JSON Schema (draft 2020-12) validator covering the keywords our schemas use. It throws on any
// keyword it does not know, so a schema change can never pass silently.

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, dirname, basename, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ---------- validator ----------

const IGNORED = new Set(['$schema', '$id', '$comment', '$defs', 'title', 'description', 'default', 'examples', 'format', 'deprecated', 'readOnly', 'writeOnly']);
const SUPPORTED = new Set([
  'type', 'enum', 'const', 'required', 'properties', 'patternProperties', 'additionalProperties', 'unevaluatedProperties',
  'propertyNames', 'minProperties', 'maxProperties', 'items', 'prefixItems', 'minItems', 'maxItems', 'uniqueItems',
  'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else', '$ref',
]);

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}
function typeMatches(t, v) {
  const actual = typeOf(v);
  return t === actual || (t === 'number' && actual === 'integer');
}
function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
function pointer(doc, ptr) {
  if (!ptr || ptr === '/') return doc;
  return ptr
    .split('/')
    .slice(1)
    .reduce((node, part) => {
      const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
      if (node === undefined || !(key in node)) throw new Error(`unresolvable $ref pointer ${ptr}`);
      return node[key];
    }, doc);
}

/**
 * Validate data against a JSON Schema.
 * @param {object|boolean} schema
 * @param {unknown} data
 * @param {{docs?: Record<string, object>, doc?: object}} [ctx] docs maps schema file names to schemas for cross-file $refs
 * @returns {string[]} error messages, empty when valid
 */
export function validate(schema, data, ctx = {}) {
  const doc = ctx.doc ?? schema;
  return run(schema, data, '', { docs: ctx.docs ?? {}, doc }).errors;
}

function resolveRef(ref, env) {
  const [file, frag] = ref.split('#');
  let doc = env.doc;
  if (file) {
    doc = env.docs[basename(file)];
    if (!doc) throw new Error(`unresolvable $ref ${ref}`);
  }
  return { schema: pointer(doc, frag ?? ''), env: { ...env, doc } };
}

// Returns {errors, evaluated} where evaluated is the set of property names this schema (and passing subschemas) evaluated.
function run(schema, data, path, env) {
  const errors = [];
  const evaluated = new Set();
  const at = path || '(root)';
  if (schema === true) return { errors, evaluated };
  if (schema === false) return { errors: [`${at}: not allowed`], evaluated };
  for (const key of Object.keys(schema)) {
    if (!IGNORED.has(key) && !SUPPORTED.has(key)) throw new Error(`unsupported schema keyword "${key}" at ${at}`);
  }
  const merge = (r) => {
    errors.push(...r.errors);
    if (!r.errors.length) r.evaluated.forEach((k) => evaluated.add(k));
  };

  if (schema.$ref) {
    const target = resolveRef(schema.$ref, env);
    merge(run(target.schema, data, path, target.env));
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(t, data))) errors.push(`${at}: expected ${types.join(' or ')}, got ${typeOf(data)}`);
  }
  if (schema.enum && !schema.enum.some((e) => deepEqual(e, data))) errors.push(`${at}: ${JSON.stringify(data)} is not one of ${JSON.stringify(schema.enum)}`);
  if ('const' in schema && !deepEqual(schema.const, data)) errors.push(`${at}: must equal ${JSON.stringify(schema.const)}`);

  if (typeof data === 'string') {
    const len = [...data].length;
    if (schema.minLength !== undefined && len < schema.minLength) errors.push(`${at}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && len > schema.maxLength) errors.push(`${at}: longer than ${schema.maxLength} (${len})`);
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(data)) errors.push(`${at}: "${data}" does not match ${schema.pattern}`);
  }
  if (typeof data === 'number') {
    if (schema.minimum !== undefined && data < schema.minimum) errors.push(`${at}: below ${schema.minimum}`);
    if (schema.maximum !== undefined && data > schema.maximum) errors.push(`${at}: above ${schema.maximum}`);
    if (schema.exclusiveMinimum !== undefined && data <= schema.exclusiveMinimum) errors.push(`${at}: must be above ${schema.exclusiveMinimum}`);
    if (schema.exclusiveMaximum !== undefined && data >= schema.exclusiveMaximum) errors.push(`${at}: must be below ${schema.exclusiveMaximum}`);
    if (schema.multipleOf !== undefined && Math.abs(data / schema.multipleOf - Math.round(data / schema.multipleOf)) > 1e-9) errors.push(`${at}: not a multiple of ${schema.multipleOf}`);
  }
  if (Array.isArray(data)) {
    if (schema.minItems !== undefined && data.length < schema.minItems) errors.push(`${at}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && data.length > schema.maxItems) errors.push(`${at}: more than ${schema.maxItems} items`);
    if (schema.uniqueItems && new Set(data.map((d) => JSON.stringify(d))).size !== data.length) errors.push(`${at}: items not unique`);
    const prefix = schema.prefixItems ?? [];
    prefix.forEach((s, i) => i < data.length && errors.push(...run(s, data[i], `${path}[${i}]`, env).errors));
    if (schema.items !== undefined) {
      for (let i = prefix.length; i < data.length; i++) errors.push(...run(schema.items, data[i], `${path}[${i}]`, env).errors);
    }
  }
  if (typeOf(data) === 'object') {
    const keys = Object.keys(data);
    if (schema.required) for (const k of schema.required) if (!(k in data)) errors.push(`${at}: missing "${k}"`);
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) errors.push(`${at}: too few properties`);
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) errors.push(`${at}: too many properties`);
    const local = new Set();
    if (schema.properties) {
      for (const [k, s] of Object.entries(schema.properties)) {
        if (k in data) {
          local.add(k);
          errors.push(...run(s, data[k], `${path}.${k}`, env).errors);
        }
      }
    }
    if (schema.patternProperties) {
      for (const [p, s] of Object.entries(schema.patternProperties)) {
        for (const k of keys) {
          if (new RegExp(p, 'u').test(k)) {
            local.add(k);
            errors.push(...run(s, data[k], `${path}.${k}`, env).errors);
          }
        }
      }
    }
    if (schema.propertyNames) for (const k of keys) errors.push(...run(schema.propertyNames, k, `${path}{${k}}`, env).errors);
    if (schema.additionalProperties !== undefined) {
      for (const k of keys) {
        if (local.has(k)) continue;
        if (schema.additionalProperties === false) errors.push(`${at}: unexpected property "${k}"`);
        else errors.push(...run(schema.additionalProperties, data[k], `${path}.${k}`, env).errors);
        local.add(k);
      }
    }
    local.forEach((k) => evaluated.add(k));
  }

  if (schema.allOf) schema.allOf.forEach((s) => merge(run(s, data, path, env)));
  if (schema.anyOf) {
    const results = schema.anyOf.map((s) => run(s, data, path, env));
    const passing = results.filter((r) => !r.errors.length);
    if (!passing.length) errors.push(`${at}: matches none of anyOf (${results.map((r) => r.errors[0]).join('; ')})`);
    passing.forEach((r) => r.evaluated.forEach((k) => evaluated.add(k)));
  }
  if (schema.oneOf) {
    const results = schema.oneOf.map((s) => run(s, data, path, env));
    const passing = results.filter((r) => !r.errors.length);
    if (passing.length !== 1) errors.push(`${at}: matches ${passing.length} of oneOf, expected 1 (${results.map((r) => r.errors[0] ?? 'ok').join('; ')})`);
    else passing[0].evaluated.forEach((k) => evaluated.add(k));
  }
  if (schema.not && !run(schema.not, data, path, env).errors.length) errors.push(`${at}: must not match "not" schema`);
  if (schema.if !== undefined) {
    const cond = run(schema.if, data, path, env);
    if (!cond.errors.length) {
      cond.evaluated.forEach((k) => evaluated.add(k));
      if (schema.then !== undefined) merge(run(schema.then, data, path, env));
    } else if (schema.else !== undefined) merge(run(schema.else, data, path, env));
  }
  if (schema.unevaluatedProperties !== undefined && typeOf(data) === 'object') {
    for (const k of Object.keys(data)) {
      if (evaluated.has(k)) continue;
      if (schema.unevaluatedProperties === false) errors.push(`${at}: unexpected property "${k}"`);
      else errors.push(...run(schema.unevaluatedProperties, data[k], `${path}.${k}`, env).errors);
      evaluated.add(k);
    }
  }
  return { errors, evaluated };
}

// ---------- content-only schemas ----------

const str = { type: 'string', minLength: 1 };
const strs = { type: 'array', items: str };
const LEVEL = { enum: ['junior', 'mid', 'senior', 'staff', 'n/a'] };
const ROUND_TYPE = { enum: ['coding', 'system_design', 'object_design', 'behavioral', 'recruiter_screen', 'pm_product_sense', 'pm_execution', 'pm_estimation', 'pm_strategy', 'pm_leadership', 'meeting'] };
const codeLine = { type: 'object', additionalProperties: false, required: ['indent', 'text'], properties: { indent: { type: 'integer', minimum: 0, maximum: 6 }, text: str } };

export const RUBRIC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'round_types', 'title', 'scale', 'level_bar', 'competencies', 'scoring_notes', 'red_flags'],
  properties: {
    id: { type: 'string', pattern: '^rubric\\.[a-z_]+$' },
    round_types: { type: 'array', minItems: 1, items: ROUND_TYPE },
    title: str,
    scale: {
      type: 'object',
      additionalProperties: false,
      required: ['1', '2', '3', '4'],
      patternProperties: {
        '^[1-4]$': { type: 'object', additionalProperties: false, required: ['label', 'name', 'meaning'], properties: { label: { enum: ['below', 'developing', 'meets_bar', 'above_bar'] }, name: str, meaning: str } },
      },
    },
    level_bar: { type: 'object', additionalProperties: false, required: ['junior', 'mid', 'senior', 'staff'], properties: { junior: str, mid: str, senior: str, staff: str } },
    competencies: {
      type: 'array',
      minItems: 3,
      maxItems: 5,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'name', 'weight', 'looks_for', 'descriptors'],
        properties: {
          id: { type: 'string', pattern: '^[a-z][a-z0-9_]*$' },
          name: { type: 'string', minLength: 1, maxLength: 40 },
          weight: { type: 'number', exclusiveMinimum: 0 },
          looks_for: str,
          descriptors: { type: 'object', additionalProperties: false, required: ['1', '2', '3', '4'], properties: { 1: str, 2: str, 3: str, 4: str } },
        },
      },
    },
    scoring_notes: strs,
    red_flags: strs,
  },
};

export const BANK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'round_type', 'title', 'cards'],
  properties: {
    id: { type: 'string', pattern: '^bank\\.[a-z_]+$' },
    round_type: ROUND_TYPE,
    title: str,
    cards: {
      type: 'array',
      minItems: 4,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'round_type', 'title', 'levels', 'lengths', 'prompt', 'strong_answer_covers', 'red_flags'],
        properties: {
          id: { type: 'string', pattern: '^[a-z_]+\\.[a-z0-9_]+$' },
          round_type: ROUND_TYPE,
          title: { type: 'string', minLength: 1, maxLength: 48 },
          levels: { type: 'array', minItems: 1, items: LEVEL },
          lengths: { type: 'array', minItems: 1, items: { enum: ['short', 'full'] } },
          tags: strs,
          prompt: str,
          brief_lines: strs,
          facts_if_asked: strs,
          follow_ups: strs,
          twist: str,
          hints: { type: 'array', minItems: 4, maxItems: 4, items: str, description: 'Hint ladder levels 1 to 4.' },
          targets: strs,
          success_prompt: str,
          diagnosis_prompt: str,
          template_id: str,
          strong_answer_covers: { type: 'array', minItems: 2, items: str },
          red_flags: strs,
          reference_solution: {
            type: 'object',
            additionalProperties: false,
            required: ['language', 'time', 'space', 'lines', 'distractors'],
            properties: {
              language: str,
              time: str,
              space: str,
              lines: { type: 'array', minItems: 3, items: codeLine },
              distractors: { type: 'array', minItems: 1, maxItems: 2, items: codeLine },
            },
          },
        },
      },
    },
  },
};

const voicePick = {
  type: 'object',
  additionalProperties: false,
  required: ['fish_id', 'fish_title', 'accent', 'task_count', 'tags', 'reason'],
  properties: { fish_id: { type: 'string', pattern: '^[0-9a-f]{32}$' }, fish_title: str, accent: str, task_count: { type: 'integer', minimum: 0 }, tags: strs, reason: str },
};
export const VOICES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['provider', 'listed_at', 'how_chosen', 'sample_model', 'voices'],
  properties: {
    provider: { const: 'fish' },
    listed_at: str,
    how_chosen: str,
    sample_model: str,
    voices: {
      type: 'object',
      minProperties: 1,
      additionalProperties: {
        allOf: [{ $ref: '#/$defs/pick' }],
        required: ['persona_id', 'gender', 'sample_text', 'sample_file', 'alternates'],
        properties: {
          persona_id: { type: 'string', pattern: '^persona\\.[a-z]+$' },
          gender: { enum: ['female', 'male'] },
          sample_text: str,
          sample_file: str,
          alternates: { type: 'array', minItems: 2, maxItems: 2, items: voicePick },
        },
        unevaluatedProperties: false,
      },
    },
  },
  $defs: { pick: { ...voicePick, additionalProperties: true } },
};

// ---------- content checks ----------

const DASH = /[\u2013\u2014]/;
const PLACEHOLDER = /\{([a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)*)\}/g;
const HOUSE_RULES_PLACEHOLDERS = [
  'persona.display_name', 'persona.title', 'seniority', 'role', 'round_name', 'phase.id', 'phase.minutes_left', 'phase.goal',
  'silence_wait_seconds', 'interrupt_after_seconds',
];
const REQUIRED_PROMPTS = ['house-rules.md', 'levels.md', 'styles.md', 'hand-over.md', 'scribe.md', 'scorer.md', 'meeting-prepare.md', 'meeting-state.md'];
const AVATARS = ['f01', 'f02', 'f03', 'm02', 'm04', 'm05'];

/** Placeholders like {persona.title} in text; JSON-looking braces are ignored. */
export function placeholdersIn(text) {
  return [...text.matchAll(PLACEHOLDER)].map((m) => m[1]);
}

/** The prompt file a round type uses, e.g. pm_execution -> round-pm-execution.md */
export function roundPromptFile(roundType) {
  return `round-${roundType.replaceAll('_', '-')}.md`;
}

function listJson(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => join(dir, f));
}
function strings(value, path, out) {
  if (typeof value === 'string') out.push([path, value]);
  else if (Array.isArray(value)) value.forEach((v, i) => strings(v, `${path}[${i}]`, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) strings(v, `${path}.${k}`, out);
  return out;
}

/**
 * Check everything under <rootDir>/content.
 * @param {string} rootDir repo root
 * @param {{schemaDir?: string}} [opts] where round/persona/attendee/meeting-template schemas live (default content/schema)
 * @returns {string[]} problems, empty when all good
 */
export function checkContent(rootDir, opts = {}) {
  const root = resolve(rootDir);
  const content = join(root, 'content');
  const schemaDir = resolve(opts.schemaDir ?? join(content, 'schema'));
  const errors = [];
  const rel = (p) => relative(root, p);
  const load = (p) => {
    try {
      return JSON.parse(readFileSync(p, 'utf8'));
    } catch (err) {
      errors.push(`${rel(p)}: invalid JSON: ${err.message}`);
      return null;
    }
  };

  const docs = {};
  for (const name of ['round', 'persona', 'attendee', 'meeting-template']) {
    const p = join(schemaDir, `${name}.schema.json`);
    if (!existsSync(p)) {
      errors.push(`schema missing: ${p} (set CONTENT_SCHEMA_DIR or pass --schemas)`);
      continue;
    }
    docs[`${name}.schema.json`] = JSON.parse(readFileSync(p, 'utf8'));
  }
  if (errors.length) return errors;
  const check = (schema, data, file, doc) => validate(schema, data, { docs, doc: doc ?? schema }).forEach((e) => errors.push(`${rel(file)}: ${e}`));

  // Load and validate every file.
  const byId = (dir, schema) => {
    const map = new Map();
    for (const file of listJson(join(content, dir))) {
      const data = load(file);
      if (!data) continue;
      check(schema, data, file);
      const id = data.id;
      if (map.has(id)) errors.push(`${rel(file)}: duplicate id ${id}`);
      map.set(id, { data, file });
    }
    return map;
  };
  const rounds = byId('rounds', docs['round.schema.json']);
  const personas = byId('personas', docs['persona.schema.json']);
  const templates = byId('meeting-templates', docs['meeting-template.schema.json']);
  const rubrics = byId('rubrics', RUBRIC_SCHEMA);
  const banks = byId('banks', BANK_SCHEMA);
  const voicesFile = join(content, 'voices.json');
  const voices = existsSync(voicesFile) ? load(voicesFile) : null;
  if (!voices) errors.push('content/voices.json: missing');
  else check(VOICES_SCHEMA, voices, voicesFile);

  // File names follow ids.
  for (const [id, { file }] of rounds) if (basename(file) !== `${id}.json`) errors.push(`${rel(file)}: file name must be ${id}.json`);
  for (const [id, { file }] of personas) if (basename(file) !== `${id.replace('persona.', '')}.json`) errors.push(`${rel(file)}: file name must match ${id}`);
  for (const [id, { file }] of templates) if (basename(file) !== `${id}.json`) errors.push(`${rel(file)}: file name must be ${id}.json`);
  for (const [id, { file }] of rubrics) if (basename(file) !== `${id.replace('rubric.', '')}.json`) errors.push(`${rel(file)}: file name must match ${id}`);
  for (const [id, { file }] of banks) if (basename(file) !== `${id.replace('bank.', '')}.json`) errors.push(`${rel(file)}: file name must match ${id}`);

  const persona = (pid, where) => {
    const p = personas.get(pid);
    if (!p) errors.push(`${where}: unknown persona ${pid}`);
    return p?.data;
  };

  // Personas: voices and avatars.
  for (const [id, { data, file }] of personas) {
    if (!AVATARS.includes(data.avatar_id)) errors.push(`${rel(file)}: unknown avatar ${data.avatar_id}`);
    const v = voices?.voices?.[data.voice_id];
    if (!v) errors.push(`${rel(file)}: voice_id ${data.voice_id} not in voices.json`);
    else if (v.persona_id !== id) errors.push(`content/voices.json: voice ${data.voice_id} belongs to ${v.persona_id}, used by ${id}`);
  }
  for (const [key, v] of Object.entries(voices?.voices ?? {})) {
    if (!personas.has(v.persona_id)) errors.push(`content/voices.json: voice ${key} names unknown persona ${v.persona_id}`);
  }

  // Rounds: links and lengths.
  const bases = new Map();
  for (const [id, { data, file }] of rounds) {
    const where = rel(file);
    const base = id.replace(/\.(short|full)$/, '');
    if (!bases.has(base)) bases.set(base, new Set());
    bases.get(base).add(data.length);
    if (!id.endsWith(`.${data.length}`)) errors.push(`${where}: id ${id} does not end with its length ${data.length}`);
    const lead = persona(data.panel.lead, where);
    const second = data.panel.second ? persona(data.panel.second, where) : null;
    if (lead && second) {
      if (lead.avatar_id === second.avatar_id) errors.push(`${where}: panel shares avatar ${lead.avatar_id}`);
      if (lead.voice_id === second.voice_id) errors.push(`${where}: panel shares voice ${lead.voice_id}`);
    }
    if (data.panel.second && !data.phases.some((p) => p.id === data.panel.second_enters_phase)) errors.push(`${where}: second_enters_phase ${data.panel.second_enters_phase} is not a phase`);
    if (data.panel.second && data.length === 'short') errors.push(`${where}: short rounds are one to one`);
    const rubric = rubrics.get(data.rubric_id);
    if (!rubric) errors.push(`${where}: unknown rubric ${data.rubric_id}`);
    else if (!rubric.data.round_types.includes(data.round_type)) errors.push(`${where}: rubric ${data.rubric_id} does not cover ${data.round_type}`);
    const bank = banks.get(data.question_pool);
    if (!bank) errors.push(`${where}: unknown question_pool ${data.question_pool}`);
    else {
      if (bank.data.round_type !== data.round_type) errors.push(`${where}: bank ${data.question_pool} is for ${bank.data.round_type}`);
      if (!bank.data.cards.some((c) => c.lengths.includes(data.length))) errors.push(`${where}: no ${data.length} cards in ${data.question_pool}`);
    }
    const other = data.length === 'short' ? data.full_version : data.short_version;
    const want = `${base}.${data.length === 'short' ? 'full' : 'short'}`;
    if (other !== want) errors.push(`${where}: ${data.length === 'short' ? 'full_version' : 'short_version'} should be ${want}`);
    const minutes = data.phases.reduce((s, p) => s + p.minutes, 0);
    if (Math.abs(minutes - data.target_minutes) > 1e-6) errors.push(`${where}: phases add up to ${minutes}, target is ${data.target_minutes}`);
    if (data.hard_stop_minutes < data.target_minutes) errors.push(`${where}: hard stop before target`);
    const [lo, hi] = data.length === 'short' ? [6, 8] : [20, 30];
    if (data.target_minutes < lo || data.target_minutes > hi) errors.push(`${where}: ${data.length} round should be ${lo} to ${hi} minutes`);
    const ids = data.phases.map((p) => p.id);
    if (new Set(ids).size !== ids.length) errors.push(`${where}: duplicate phase ids`);
    if (!existsSync(join(content, 'prompts', roundPromptFile(data.round_type)))) errors.push(`${where}: missing prompt ${roundPromptFile(data.round_type)}`);
  }
  for (const [base, lengths] of bases) {
    for (const len of ['short', 'full']) if (!lengths.has(len)) errors.push(`content/rounds: ${base}.${len} is missing`);
  }

  // Banks: card ids and per type fields.
  for (const [id, { data, file }] of banks) {
    const where = rel(file);
    const seen = new Set();
    const rubric = [...rubrics.values()].find((r) => r.data.round_types.includes(data.round_type));
    const comps = new Set(rubric?.data.competencies.map((c) => c.id) ?? []);
    for (const card of data.cards) {
      if (seen.has(card.id)) errors.push(`${where}: duplicate card ${card.id}`);
      seen.add(card.id);
      if (card.round_type !== data.round_type || !card.id.startsWith(`${data.round_type}.`)) errors.push(`${where}: card ${card.id} does not belong to ${data.round_type}`);
      if (data.round_type === 'coding' && (!card.reference_solution || !card.hints)) errors.push(`${where}: coding card ${card.id} needs reference_solution and hints`);
      if (data.round_type === 'object_design' && !card.hints) errors.push(`${where}: card ${card.id} needs hints`);
      if (data.round_type === 'pm_execution' && (!card.success_prompt || !card.diagnosis_prompt || !card.twist)) errors.push(`${where}: card ${card.id} needs success_prompt, diagnosis_prompt and twist`);
      if (data.round_type === 'meeting' && !templates.has(card.template_id)) errors.push(`${where}: card ${card.id} names unknown template ${card.template_id}`);
      for (const t of card.targets ?? []) if (!comps.has(t)) errors.push(`${where}: card ${card.id} targets unknown competency ${t}`);
    }
  }

  // Meeting templates: attendee voices and avatars are distinct.
  for (const [id, { data, file }] of templates) {
    const where = rel(file);
    const avatars = new Map();
    const voiceIds = new Map();
    for (const a of data.attendees) {
      if (!a.voice_base) continue;
      const p = persona(a.voice_base, where);
      if (!p) continue;
      if (avatars.has(p.avatar_id)) errors.push(`${where}: ${id} attendees ${avatars.get(p.avatar_id)} and ${a.name} share avatar ${p.avatar_id}`);
      if (voiceIds.has(p.voice_id)) errors.push(`${where}: ${id} attendees ${voiceIds.get(p.voice_id)} and ${a.name} share voice ${p.voice_id}`);
      avatars.set(p.avatar_id, a.name);
      voiceIds.set(p.voice_id, a.name);
    }
    if (!data.attendees.some((a) => a.decision_power === 'approver')) errors.push(`${where}: no approver`);
  }

  // Copy: no em or en dashes anywhere in content JSON (schemas excluded) or prompts.
  const jsonFiles = [voicesFile, ...['rounds', 'personas', 'meeting-templates', 'rubrics', 'banks'].flatMap((d) => listJson(join(content, d)))];
  for (const file of jsonFiles) {
    if (!existsSync(file)) continue;
    const data = load(file);
    if (!data) continue;
    for (const [path, text] of strings(data, '', [])) if (DASH.test(text)) errors.push(`${rel(file)}: em or en dash at ${path}: ${text}`);
  }

  // Prompts: present, no dashes, placeholders declared.
  const promptDir = join(content, 'prompts');
  for (const name of REQUIRED_PROMPTS) if (!existsSync(join(promptDir, name))) errors.push(`content/prompts/${name}: missing`);
  for (const name of existsSync(promptDir) ? readdirSync(promptDir).filter((f) => f.endsWith('.md')).sort() : []) {
    const text = readFileSync(join(promptDir, name), 'utf8');
    const header = text.match(/^<!--([\s\S]*?)-->/);
    if (!header) {
      errors.push(`content/prompts/${name}: missing header comment listing placeholders`);
      continue;
    }
    const declared = new Set(placeholdersIn(header[1]));
    const body = text.slice(header[0].length);
    for (const p of new Set(placeholdersIn(body))) if (!declared.has(p)) errors.push(`content/prompts/${name}: placeholder {${p}} is not declared in the header`);
    text.split('\n').forEach((line, i) => DASH.test(line) && errors.push(`content/prompts/${name}:${i + 1}: em or en dash`));
    if (name === 'house-rules.md') {
      for (const p of HOUSE_RULES_PLACEHOLDERS) if (!placeholdersIn(body).includes(p)) errors.push(`content/prompts/house-rules.md: must use {${p}}`);
      if (!body.includes('<!-- turn-note -->')) errors.push('content/prompts/house-rules.md: missing <!-- turn-note --> split');
    }
  }
  return errors;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--schemas');
  const schemaDir = i >= 0 ? args[i + 1] : process.env.CONTENT_SCHEMA_DIR;
  const positional = args.filter((_, j) => i < 0 || (j !== i && j !== i + 1));
  const root = positional[0] ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const errors = checkContent(root, { schemaDir });
  for (const e of errors) console.log(e);
  if (errors.length) {
    console.error(`content-check: ${errors.length} problem(s)`);
    process.exit(1);
  }
  console.log('content-check: clean');
}
