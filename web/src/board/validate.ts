// Hand-written checks equal to board.v1.schema.json for ops (board_op + op_args), so the
// client rejects exactly what the server rejects without shipping a JSON Schema engine.
// Returns null when valid, else a short reason.

type Obj = Record<string, unknown>;

const ID = /^[A-Za-z0-9_.:-]+$/;
const SRC = ['hand', 'voice_grammar', 'scribe', 'interviewer'];
const COMPONENT_TYPES = ['client', 'lb', 'api_gateway', 'service', 'db', 'kv', 'cache', 'queue', 'cdn', 'object_store', 'search', 'worker', 'external', 'note', 'blank'];
const CLASS_KINDS = ['class', 'interface', 'abstract', 'enum'];
const METRIC_ROLES = ['north_star', 'input', 'guardrail'];
const LANES = ['user', 'pain', 'idea', 'metric'];
const QUADS = ['tl', 'tr', 'bl', 'br'];
const DIRS = ['->', '<->', '--'];
const RELS = ['uses', 'has_a', 'is_a', 'implements'];
const VIS = ['+', '-', '#', '~'];
export const OP_NAMES = [
  'item.create', 'item.move', 'item.delete', 'item.label', 'item.set_type', 'item.note.add',
  'edge.create', 'edge.delete', 'edge.set_dir', 'edge.set_rel', 'edge.label',
  'group.create', 'member.add', 'member.move', 'member.remove',
  'sticky.vote', 'sticky.set_quad',
  'code.insert', 'code.edit', 'code.move', 'code.indent', 'code.delete', 'code.complexity', 'code.trace', 'code.approach',
  'agenda.check', 'present.show', 'park.add', 'undo',
];

class Invalid extends Error {}

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const fail = (msg: string): never => {
  throw new Invalid(msg);
};

function shape(v: unknown, required: string[], optional: string[] = [], where = 'args'): Obj {
  if (!isObj(v)) fail(`${where} must be an object`);
  const o = v as Obj;
  for (const k of required) if (!(k in o)) fail(`${where}.${k} is required`);
  for (const k of Object.keys(o)) if (!required.includes(k) && !optional.includes(k)) fail(`${where}.${k} is not allowed`);
  return o;
}

const id = (v: unknown, where: string) => (typeof v === 'string' && v.length > 0 && ID.test(v) ? v : fail(`${where} must be an id`));
const num = (v: unknown, where: string) => (typeof v === 'number' && Number.isFinite(v) ? v : fail(`${where} must be a number`));
const int = (v: unknown, where: string) => (typeof v === 'number' && Number.isInteger(v) ? v : fail(`${where} must be an integer`));
const str = (v: unknown, where: string) => (typeof v === 'string' ? v : fail(`${where} must be a string`));
const bool = (v: unknown, where: string) => (typeof v === 'boolean' ? v : fail(`${where} must be a boolean`));
const strOrNull = (v: unknown, where: string) => (v === null || typeof v === 'string' ? v : fail(`${where} must be a string or null`));
const oneOf = (v: unknown, list: readonly unknown[], where: string) => (list.includes(v) ? v : fail(`${where} is not one of ${list.join(', ')}`));
const oneOfOrNull = (v: unknown, list: readonly unknown[], where: string) => (v === null ? v : oneOf(v, list, where));
const arr = (v: unknown, where: string) => (Array.isArray(v) ? (v as unknown[]) : fail(`${where} must be an array`));
const opt = (o: Obj, k: string, check: (v: unknown, where: string) => unknown, where: string) => {
  if (k in o) check(o[k], `${where}.${k}`);
};

function member(v: unknown, where: string): void {
  const m = shape(v, ['id', 'vis', 'name'], ['type', 'params', 'returns'], where);
  id(m.id, `${where}.id`);
  oneOf(m.vis, VIS, `${where}.vis`);
  if (str(m.name, `${where}.name`).length < 1) fail(`${where}.name is empty`);
  opt(m, 'type', strOrNull, where);
  opt(m, 'returns', strOrNull, where);
  if ('params' in m) {
    arr(m.params, `${where}.params`).forEach((p, i) => {
      const pp = shape(p, ['name'], ['type'], `${where}.params[${i}]`);
      str(pp.name, `${where}.params[${i}].name`);
      opt(pp, 'type', strOrNull, `${where}.params[${i}]`);
    });
  }
}

function codeLine(v: unknown, where: string): void {
  const l = shape(v, ['id', 'indent', 'text', 'src'], [], where);
  id(l.id, `${where}.id`);
  const ind = int(l.indent, `${where}.indent`);
  if (ind < 0 || ind > 6) fail(`${where}.indent out of range`);
  str(l.text, `${where}.text`);
  oneOf(l.src, SRC, `${where}.src`);
}

function xy(o: Obj, where: string, keys = ['x', 'y']): void {
  for (const k of keys) num(o[k], `${where}.${k}`);
}

export function item(v: unknown, where = 'args'): void {
  if (!isObj(v)) fail(`${where} must be an object`);
  const o = v as Obj;
  switch (o.kind) {
    case 'component': {
      shape(o, ['id', 'kind', 'type', 'label', 'x', 'y', 'w', 'h'], ['group', 'notes'], where);
      id(o.id, `${where}.id`);
      oneOf(o.type, COMPONENT_TYPES, `${where}.type`);
      strOrNull(o.label, `${where}.label`);
      xy(o, where, ['x', 'y', 'w', 'h']);
      opt(o, 'group', strOrNull, where);
      if ('notes' in o) arr(o.notes, `${where}.notes`).forEach((n, i) => str(n, `${where}.notes[${i}]`));
      return;
    }
    case 'class': {
      shape(o, ['id', 'kind', 'label', 'class_kind', 'fields', 'methods', 'x', 'y', 'w', 'h'], ['group'], where);
      id(o.id, `${where}.id`);
      strOrNull(o.label, `${where}.label`);
      oneOf(o.class_kind, CLASS_KINDS, `${where}.class_kind`);
      arr(o.fields, `${where}.fields`).forEach((m, i) => member(m, `${where}.fields[${i}]`));
      arr(o.methods, `${where}.methods`).forEach((m, i) => member(m, `${where}.methods[${i}]`));
      xy(o, where, ['x', 'y', 'w', 'h']);
      opt(o, 'group', strOrNull, where);
      return;
    }
    case 'sticky': {
      shape(o, ['id', 'kind', 'lane', 'text', 'votes', 'quad', 'x', 'y'], ['group', 'rank', 'w', 'h'], where);
      id(o.id, `${where}.id`);
      oneOfOrNull(o.lane, LANES, `${where}.lane`);
      str(o.text, `${where}.text`);
      if (int(o.votes, `${where}.votes`) < 0) fail(`${where}.votes is negative`);
      oneOfOrNull(o.quad, QUADS, `${where}.quad`);
      xy(o, where);
      opt(o, 'group', strOrNull, where);
      opt(o, 'rank', rank, where);
      opt(o, 'w', num, where);
      opt(o, 'h', num, where);
      return;
    }
    case 'group': {
      shape(o, ['id', 'kind', 'label', 'x', 'y', 'w', 'h'], [], where);
      id(o.id, `${where}.id`);
      strOrNull(o.label, `${where}.label`);
      xy(o, where, ['x', 'y', 'w', 'h']);
      return;
    }
    case 'metric': {
      shape(o, ['id', 'kind', 'role', 'label', 'x', 'y'], ['group', 'w', 'h'], where);
      id(o.id, `${where}.id`);
      oneOf(o.role, METRIC_ROLES, `${where}.role`);
      strOrNull(o.label, `${where}.label`);
      xy(o, where);
      opt(o, 'group', strOrNull, where);
      opt(o, 'w', num, where);
      opt(o, 'h', num, where);
      return;
    }
    case 'ink': {
      shape(o, ['id', 'kind', 'points', 'recognized'], [], where);
      id(o.id, `${where}.id`);
      const pts = arr(o.points, `${where}.points`);
      if (pts.length < 2) fail(`${where}.points needs 2 points`);
      pts.forEach((p, i) => {
        const pp = arr(p, `${where}.points[${i}]`);
        if (pp.length !== 2) fail(`${where}.points[${i}] must be [x, y]`);
        num(pp[0], `${where}.points[${i}][0]`);
        num(pp[1], `${where}.points[${i}][1]`);
      });
      oneOf(o.recognized, [null, 'rect', 'line', 'arrow', 'circle'], `${where}.recognized`);
      return;
    }
    case 'interviewer_card': {
      shape(o, ['id', 'kind', 'title', 'body', 'x', 'y'], ['w', 'h'], where);
      id(o.id, `${where}.id`);
      str(o.title, `${where}.title`);
      str(o.body, `${where}.body`);
      xy(o, where);
      opt(o, 'w', num, where);
      opt(o, 'h', num, where);
      return;
    }
    default:
      fail(`${where}.kind is unknown`);
  }
}

function rank(v: unknown, where: string): void {
  if (v === null) return;
  if (int(v, where) < 1) fail(`${where} must be at least 1`);
}

function args(op: string, a: unknown): void {
  switch (op) {
    case 'item.create':
      return item(a);
    case 'item.move': {
      const o = shape(a, ['id', 'x', 'y'], ['lane', 'rank']);
      id(o.id, 'args.id');
      xy(o, 'args');
      opt(o, 'lane', (v, w) => oneOfOrNull(v, LANES, w), 'args');
      opt(o, 'rank', rank, 'args');
      return;
    }
    case 'item.delete':
    case 'edge.delete':
    case 'member.remove':
    case 'code.delete':
      id(shape(a, ['id']).id, 'args.id');
      return;
    case 'item.label':
    case 'edge.label': {
      const o = shape(a, ['id', 'text']);
      id(o.id, 'args.id');
      strOrNull(o.text, 'args.text');
      return;
    }
    case 'item.set_type': {
      const o = shape(a, ['id', 'type']);
      id(o.id, 'args.id');
      oneOf(o.type, [...COMPONENT_TYPES, ...CLASS_KINDS, ...METRIC_ROLES], 'args.type');
      return;
    }
    case 'item.note.add': {
      const o = shape(a, ['id', 'text']);
      id(o.id, 'args.id');
      if (str(o.text, 'args.text').length < 1) fail('args.text is empty');
      return;
    }
    case 'edge.create': {
      const o = shape(a, ['id', 'from', 'to'], ['dir', 'label', 'rel']);
      id(o.id, 'args.id');
      id(o.from, 'args.from');
      id(o.to, 'args.to');
      opt(o, 'dir', (v, w) => oneOf(v, DIRS, w), 'args');
      opt(o, 'label', strOrNull, 'args');
      opt(o, 'rel', (v, w) => oneOfOrNull(v, RELS, w), 'args');
      return;
    }
    case 'edge.set_dir': {
      const o = shape(a, ['id', 'dir']);
      id(o.id, 'args.id');
      oneOf(o.dir, DIRS, 'args.dir');
      return;
    }
    case 'edge.set_rel': {
      const o = shape(a, ['id', 'rel']);
      id(o.id, 'args.id');
      oneOfOrNull(o.rel, RELS, 'args.rel');
      return;
    }
    case 'group.create': {
      const o = shape(a, ['id', 'label', 'x', 'y', 'w', 'h', 'members']);
      id(o.id, 'args.id');
      strOrNull(o.label, 'args.label');
      xy(o, 'args', ['x', 'y', 'w', 'h']);
      arr(o.members, 'args.members').forEach((m, i) => id(m, `args.members[${i}]`));
      return;
    }
    case 'member.add': {
      const o = shape(a, ['class_id', 'section', 'member']);
      id(o.class_id, 'args.class_id');
      oneOf(o.section, ['fields', 'methods'], 'args.section');
      member(o.member, 'args.member');
      return;
    }
    case 'member.move': {
      const o = shape(a, ['id', 'to_class_id']);
      id(o.id, 'args.id');
      id(o.to_class_id, 'args.to_class_id');
      return;
    }
    case 'sticky.vote': {
      const o = shape(a, ['id', 'delta']);
      id(o.id, 'args.id');
      oneOf(o.delta, [1, -1], 'args.delta');
      return;
    }
    case 'sticky.set_quad': {
      const o = shape(a, ['id', 'quad']);
      id(o.id, 'args.id');
      oneOfOrNull(o.quad, QUADS, 'args.quad');
      return;
    }
    case 'code.insert': {
      const o = shape(a, ['line', 'after']);
      codeLine(o.line, 'args.line');
      strOrNull(o.after, 'args.after');
      return;
    }
    case 'code.edit': {
      const o = shape(a, ['id', 'text']);
      id(o.id, 'args.id');
      str(o.text, 'args.text');
      return;
    }
    case 'code.move': {
      const o = shape(a, ['id', 'after']);
      id(o.id, 'args.id');
      strOrNull(o.after, 'args.after');
      return;
    }
    case 'code.indent': {
      const o = shape(a, ['id', 'delta']);
      id(o.id, 'args.id');
      int(o.delta, 'args.delta');
      return;
    }
    case 'code.complexity': {
      const o = shape(a, ['slot', 'value']);
      oneOf(o.slot, ['time', 'space'], 'args.slot');
      strOrNull(o.value, 'args.value');
      return;
    }
    case 'code.trace': {
      const o = shape(a, ['line', 't']);
      id(o.line, 'args.line');
      num(o.t, 'args.t');
      return;
    }
    case 'code.approach': {
      const o = shape(a, ['lines']);
      const lines = arr(o.lines, 'args.lines');
      if (lines.length > 6) fail('args.lines has more than 6 lines');
      lines.forEach((l, i) => {
        if (str(l, `args.lines[${i}]`).length > 120) fail(`args.lines[${i}] is longer than 120 characters`);
      });
      return;
    }
    case 'agenda.check': {
      const o = shape(a, ['id', 'done', 't']);
      id(o.id, 'args.id');
      bool(o.done, 'args.done');
      if (o.t !== null) num(o.t, 'args.t');
      return;
    }
    case 'present.show': {
      const o = shape(a, ['kind', 'ref', 't']);
      oneOf(o.kind, ['slide', 'number'], 'args.kind');
      if (!(typeof o.ref === 'string' || (typeof o.ref === 'number' && Number.isInteger(o.ref)))) fail('args.ref must be an integer or a string');
      num(o.t, 'args.t');
      return;
    }
    case 'park.add': {
      const o = shape(a, ['text']);
      if (str(o.text, 'args.text').length < 1) fail('args.text is empty');
      return;
    }
    case 'undo': {
      const o = shape(a, ['target_op_id']);
      if (str(o.target_op_id, 'args.target_op_id').length < 1) fail('args.target_op_id is empty');
      return;
    }
    default:
      fail(`unknown op ${op}`);
  }
}

/** Checks an op envelope and its args. Null when valid. */
export function validateOp(op: unknown): string | null {
  try {
    if (!isObj(op)) fail('op must be an object');
    const o = op as Obj;
    if (typeof o.op_id !== 'string' || o.op_id.length < 1) fail('op_id is required');
    oneOf(o.src, SRC, 'src');
    oneOf(o.op, OP_NAMES, 'op');
    if (!isObj(o.args)) fail('args must be an object');
    if ('rev_base' in o && o.rev_base !== undefined && (int(o.rev_base, 'rev_base') as number) < 0) fail('rev_base is negative');
    if ('at_ms' in o && o.at_ms !== undefined) num(o.at_ms, 'at_ms');
    args(o.op as string, o.args);
    return null;
  } catch (e) {
    if (e instanceof Invalid) return e.message;
    throw e;
  }
}
