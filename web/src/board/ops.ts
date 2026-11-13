// Board ops: the same apply rules as the server (docs/protocol.md, Board ops), pinned by
// content/fixtures/board-ops and board-undo. applyOp is pure and shares unchanged items
// between revisions, so a renderer can tell what changed by reference.
import type {
  Board,
  BoardCode,
  BoardEdge,
  BoardItem,
  BoardMeeting,
  BoardOp,
  ClassItem,
  ClassMember,
  CodeLine,
  GhostOp,
  OpArgsMap,
} from '../shared/types';
import { validateOp } from './validate';

class Reject extends Error {}
const reject = (msg: string): never => {
  throw new Reject(msg);
};

export interface ApplyResult {
  board: Board;
  accepted: boolean;
  /** The op_id was already committed: nothing changed and nothing is logged. */
  duplicate?: boolean;
  error?: string;
}

/** JSON copy of op args, so a board never aliases objects the caller still holds. */
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

type Effect = Partial<Pick<Board, 'items' | 'edges' | 'code' | 'meeting' | 'focus'>>;

function idInUse(b: Board, id: string): boolean {
  return b.items.some((i) => i.id === id) || b.edges.some((e) => e.id === id);
}

function itemIndex(b: Board, id: string): number {
  const i = b.items.findIndex((it) => it.id === id);
  return i >= 0 ? i : reject(`unknown item ${id}`);
}

function replaceItem(b: Board, idx: number, next: BoardItem): BoardItem[] {
  const items = b.items.slice();
  items[idx] = next;
  return items;
}

function edgeIndex(b: Board, id: string): number {
  const i = b.edges.findIndex((e) => e.id === id);
  return i >= 0 ? i : reject(`unknown edge ${id}`);
}

function replaceEdge(b: Board, id: string, patch: Partial<BoardEdge>): Effect {
  const idx = edgeIndex(b, id);
  const edges = b.edges.slice();
  edges[idx] = { ...edges[idx]!, ...patch };
  return { edges };
}

function allMemberIds(b: Board): Set<string> {
  const ids = new Set<string>();
  for (const it of b.items) {
    if (it.kind !== 'class') continue;
    for (const m of [...it.fields, ...it.methods]) ids.add(m.id);
  }
  return ids;
}

function findMember(b: Board, id: string): { idx: number; cls: ClassItem; section: 'fields' | 'methods'; pos: number } {
  for (let idx = 0; idx < b.items.length; idx++) {
    const it = b.items[idx]!;
    if (it.kind !== 'class') continue;
    for (const section of ['fields', 'methods'] as const) {
      const pos = it[section].findIndex((m) => m.id === id);
      if (pos >= 0) return { idx, cls: it, section, pos };
    }
  }
  return reject(`unknown member ${id}`);
}

function needCode(b: Board): BoardCode {
  return b.code ?? reject('board has no code');
}

function needMeeting(b: Board): BoardMeeting {
  return b.meeting ?? reject('board has no meeting');
}

function lineIndex(code: BoardCode, id: string): number {
  const i = code.lines.findIndex((l) => l.id === id);
  return i >= 0 ? i : reject(`unknown line ${id}`);
}

function insertAfter(lines: CodeLine[], line: CodeLine, after: string | null): CodeLine[] {
  if (after === null) return [line, ...lines];
  const i = lines.findIndex((l) => l.id === after);
  if (i < 0) reject(`unknown line ${after}`);
  return [...lines.slice(0, i + 1), line, ...lines.slice(i + 1)];
}

type Args<K extends keyof OpArgsMap> = OpArgsMap[K];

function effect(b: Board, op: BoardOp): Effect {
  switch (op.op) {
    case 'item.create': {
      const a = op.args;
      if (idInUse(b, a.id)) reject(`id ${a.id} in use`);
      if (a.kind === 'class') {
        const taken = allMemberIds(b);
        for (const m of [...a.fields, ...a.methods]) {
          if (taken.has(m.id)) reject(`member id ${m.id} in use`);
          taken.add(m.id);
        }
      }
      return { items: [...b.items, copy(a)] };
    }
    case 'item.move': {
      const a: Args<'item.move'> = op.args;
      const idx = itemIndex(b, a.id);
      const it = b.items[idx]!;
      if (it.kind === 'ink') reject('ink cannot move');
      const hasLane = 'lane' in a;
      const hasRank = 'rank' in a;
      if ((hasLane || hasRank) && it.kind !== 'sticky') reject('lane and rank are for stickies');
      const next = { ...it, x: a.x, y: a.y } as BoardItem;
      if (next.kind === 'sticky') {
        if (hasLane) next.lane = a.lane ?? null;
        if (hasRank) next.rank = a.rank ?? null;
      }
      return { items: replaceItem(b, idx, next) };
    }
    case 'item.delete': {
      const { id } = op.args;
      const idx = itemIndex(b, id);
      const wasGroup = b.items[idx]!.kind === 'group';
      let items = b.items.filter((_, i) => i !== idx);
      if (wasGroup) {
        items = items.map((it) => ('group' in it && it.group === id ? ({ ...it, group: null } as BoardItem) : it));
      }
      const edges = b.edges.filter((e) => e.from !== id && e.to !== id);
      const out: Effect = { items };
      if (edges.length !== b.edges.length) out.edges = edges;
      if (b.focus === id) out.focus = null;
      return out;
    }
    case 'item.label': {
      const { id, text } = op.args;
      const idx = itemIndex(b, id);
      const it = b.items[idx]!;
      switch (it.kind) {
        case 'component':
        case 'class':
        case 'group':
        case 'metric':
          return { items: replaceItem(b, idx, { ...it, label: text }) };
        case 'sticky':
          if (text === null) reject('a sticky needs text');
          return { items: replaceItem(b, idx, { ...it, text: text as string }) };
        default:
          return reject(`${it.kind} has no label`);
      }
    }
    case 'item.set_type': {
      const { id, type } = op.args;
      const idx = itemIndex(b, id);
      const it = b.items[idx]!;
      const ok = (list: string[]) => list.includes(type) || reject(`${type} is not valid for a ${it.kind}`);
      if (it.kind === 'component') {
        ok(['client', 'lb', 'api_gateway', 'service', 'db', 'kv', 'cache', 'queue', 'cdn', 'object_store', 'search', 'worker', 'external', 'note', 'blank']);
        return { items: replaceItem(b, idx, { ...it, type: type as typeof it.type }) };
      }
      if (it.kind === 'class') {
        ok(['class', 'interface', 'abstract', 'enum']);
        return { items: replaceItem(b, idx, { ...it, class_kind: type as typeof it.class_kind }) };
      }
      if (it.kind === 'metric') {
        ok(['north_star', 'input', 'guardrail']);
        return { items: replaceItem(b, idx, { ...it, role: type as typeof it.role }) };
      }
      return reject(`${it.kind} has no type`);
    }
    case 'item.note.add': {
      const { id, text } = op.args;
      const idx = itemIndex(b, id);
      const it = b.items[idx]!;
      if (it.kind !== 'component') reject('notes are for components');
      const c = it as Extract<BoardItem, { kind: 'component' }>;
      return { items: replaceItem(b, idx, { ...c, notes: [...(c.notes ?? []), text] }) };
    }
    case 'edge.create': {
      const a = op.args;
      if (idInUse(b, a.id)) reject(`id ${a.id} in use`);
      if (a.from === a.to) reject('an edge needs two items');
      for (const end of [a.from, a.to]) {
        const it = b.items.find((i) => i.id === end);
        if (!it || it.kind === 'ink') reject(`no item ${end} to connect`);
      }
      const edge: BoardEdge = { id: a.id, from: a.from, to: a.to, dir: a.dir ?? '->', label: a.label ?? null, rel: a.rel ?? null };
      return { edges: [...b.edges, edge] };
    }
    case 'edge.delete': {
      const idx = edgeIndex(b, op.args.id);
      return { edges: b.edges.filter((_, i) => i !== idx) };
    }
    case 'edge.set_dir':
      return replaceEdge(b, op.args.id, { dir: op.args.dir });
    case 'edge.set_rel':
      return replaceEdge(b, op.args.id, { rel: op.args.rel });
    case 'edge.label':
      return replaceEdge(b, op.args.id, { label: op.args.text });
    case 'group.create': {
      const a = op.args;
      if (idInUse(b, a.id)) reject(`id ${a.id} in use`);
      const members = new Set(a.members);
      for (const m of members) {
        const it = b.items.find((i) => i.id === m);
        if (!it || !['component', 'class', 'sticky', 'metric'].includes(it.kind)) reject(`${m} cannot join a group`);
      }
      const items = b.items.map((it) => (members.has(it.id) ? ({ ...it, group: a.id } as BoardItem) : it));
      items.push({ id: a.id, kind: 'group', label: a.label, x: a.x, y: a.y, w: a.w, h: a.h });
      return { items };
    }
    case 'member.add': {
      const { class_id, section, member } = op.args;
      const idx = itemIndex(b, class_id);
      const cls = b.items[idx]!;
      if (cls.kind !== 'class') return reject(`${class_id} is not a class`);
      if (allMemberIds(b).has(member.id)) reject(`member id ${member.id} in use`);
      return { items: replaceItem(b, idx, { ...cls, [section]: [...cls[section], copy(member)] }) };
    }
    case 'member.move': {
      const { id, to_class_id } = op.args;
      const from = findMember(b, id);
      const toIdx = itemIndex(b, to_class_id);
      const to = b.items[toIdx]!;
      if (to.kind !== 'class') return reject(`${to_class_id} is not a class`);
      if (toIdx === from.idx) reject('member is already in that class');
      const m: ClassMember = from.cls[from.section][from.pos]!;
      let items = replaceItem(b, from.idx, { ...from.cls, [from.section]: from.cls[from.section].filter((_, i) => i !== from.pos) });
      items = items.slice();
      items[toIdx] = { ...to, [from.section]: [...to[from.section], m] };
      return { items };
    }
    case 'member.remove': {
      const from = findMember(b, op.args.id);
      return { items: replaceItem(b, from.idx, { ...from.cls, [from.section]: from.cls[from.section].filter((_, i) => i !== from.pos) }) };
    }
    case 'sticky.vote': {
      const idx = itemIndex(b, op.args.id);
      const it = b.items[idx]!;
      if (it.kind !== 'sticky') return reject('votes are for stickies');
      return { items: replaceItem(b, idx, { ...it, votes: Math.max(0, it.votes + op.args.delta) }) };
    }
    case 'sticky.set_quad': {
      const idx = itemIndex(b, op.args.id);
      const it = b.items[idx]!;
      if (it.kind !== 'sticky') return reject('quadrants are for stickies');
      return { items: replaceItem(b, idx, { ...it, quad: op.args.quad }) };
    }
    case 'code.insert': {
      const code = needCode(b);
      const { line, after } = op.args;
      if (code.lines.some((l) => l.id === line.id)) reject(`line id ${line.id} in use`);
      return { code: { ...code, lines: insertAfter(code.lines, copy(line), after) } };
    }
    case 'code.edit': {
      const code = needCode(b);
      const i = lineIndex(code, op.args.id);
      const lines = code.lines.slice();
      lines[i] = { ...lines[i]!, text: op.args.text };
      return { code: { ...code, lines } };
    }
    case 'code.move': {
      const code = needCode(b);
      const { id, after } = op.args;
      if (after === id) reject('a line cannot go after itself');
      const i = lineIndex(code, id);
      const line = code.lines[i]!;
      const rest = code.lines.filter((_, k) => k !== i);
      return { code: { ...code, lines: insertAfter(rest, line, after) } };
    }
    case 'code.indent': {
      const code = needCode(b);
      const i = lineIndex(code, op.args.id);
      const lines = code.lines.slice();
      const l = lines[i]!;
      lines[i] = { ...l, indent: Math.min(6, Math.max(0, l.indent + op.args.delta)) };
      return { code: { ...code, lines } };
    }
    case 'code.delete': {
      const code = needCode(b);
      const i = lineIndex(code, op.args.id);
      return { code: { ...code, lines: code.lines.filter((_, k) => k !== i) } };
    }
    case 'code.complexity': {
      const code = needCode(b);
      return { code: { ...code, complexity: { ...code.complexity, [op.args.slot]: op.args.value } } };
    }
    case 'code.trace': {
      const code = needCode(b);
      lineIndex(code, op.args.line);
      return { code: { ...code, trace: [...code.trace, { line: op.args.line, t: op.args.t }] } };
    }
    case 'code.approach': {
      const code = needCode(b);
      return { code: { ...code, approach: [...op.args.lines] } };
    }
    case 'agenda.check': {
      const m = needMeeting(b);
      const { id, done, t } = op.args;
      const i = m.agenda.findIndex((a) => a.id === id);
      if (i < 0) reject(`unknown agenda item ${id}`);
      const agenda = m.agenda.slice();
      agenda[i] = { ...agenda[i]!, done, t: done ? t : null };
      return { meeting: { ...m, agenda } };
    }
    case 'present.show': {
      const m = needMeeting(b);
      const { kind, ref, t } = op.args;
      return { meeting: { ...m, shown: [...m.shown, { kind, ref, t }] } };
    }
    case 'park.add': {
      const m = needMeeting(b);
      return { meeting: { ...m, parked: [...m.parked, op.args.text] } };
    }
    case 'undo':
      return reject('undo needs the op log (BoardStore)');
  }
}

function dropGhost(board: Board, opId: string): Board {
  if (!board.ghosts.some((g) => g.op_id === opId)) return board;
  return { ...board, ghosts: board.ghosts.filter((g) => g.op_id !== opId) };
}

/**
 * Applies one op. Duplicate op_ids change nothing; rejected ops change nothing except
 * dropping a pending ghost with the same op_id; committed ops bump rev and op_ids.
 */
export function tryApplyOp(board: Board, op: BoardOp): ApplyResult {
  const opId = (op as { op_id?: unknown })?.op_id;
  if (typeof opId === 'string' && board.op_ids.includes(opId)) return { board, accepted: false, duplicate: true };
  const invalid = validateOp(op);
  const rejected = (error: string): ApplyResult => ({
    board: typeof opId === 'string' && opId ? dropGhost(board, opId) : board,
    accepted: false,
    error,
  });
  if (invalid) return rejected(invalid);
  let eff: Effect;
  try {
    eff = effect(board, op);
  } catch (e) {
    if (e instanceof Reject) return rejected(e.message);
    throw e;
  }
  const next: Board = {
    ...board,
    ...eff,
    rev: board.rev + 1,
    op_ids: [...board.op_ids, op.op_id],
  };
  return { board: dropGhost(next, op.op_id), accepted: true };
}

/** Pure apply: the board after `op` (the same board when the op is a duplicate or rejected). */
export function applyOp(board: Board, op: BoardOp): Board {
  return tryApplyOp(board, op).board;
}

export interface LogEntry {
  op: BoardOp;
  accepted: boolean;
  /** Made on this client (optimistic) rather than received from the server. */
  local?: boolean;
  /** For local ops: the server acknowledged it (board.ack). */
  confirmed?: boolean;
}

const usableId = (op: unknown): op is BoardOp => typeof (op as { op_id?: unknown } | null)?.op_id === 'string' && (op as { op_id: string }).op_id.length > 0;

/**
 * Owns the board on the client: applies ops, keeps the op log (the undo stack), and
 * holds client state (focus, ghosts). Undo follows the replay rule in docs/protocol.md.
 *
 * Local ops are applied optimistically (`apply(op, {local: true})`) and stay pending
 * until `confirm(op_id)` (board.ack). When the server rejects one, `rollback(op_id)`
 * re-derives the board from the confirmed ops plus the still-pending ones.
 */
export class BoardStore {
  readonly start: Board;
  board: Board;
  readonly log: LogEntry[] = [];
  /** When focus was last set (ms, performance clock), for the 20 s "that" window. */
  focusAt = 0;
  /** Accepted ops whose effect fell away in the last rebuild (undo or rollback). */
  private dropped = new Set<string>();
  private listeners = new Set<(b: Board) => void>();

  constructor(start: Board) {
    this.start = start;
    this.board = start;
  }

  onChange(cb: (b: Board) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private set(next: Board): void {
    if (next === this.board) return;
    this.board = next;
    for (const cb of [...this.listeners]) cb(next);
  }

  /**
   * Applies an op. `local` marks an optimistic op made here (pending until confirmed);
   * ops from the server (board.apply, replays) are confirmed as they come.
   */
  apply(op: BoardOp, opts: { local?: boolean } = {}): ApplyResult {
    if (op?.op === 'undo') return this.undo(op, opts.local === true);
    const r = tryApplyOp(this.board, op);
    // Ops without a usable op_id are answered but never logged (protocol rule 2).
    if (!r.duplicate && usableId(op)) this.log.push(this.entry(op, r.accepted, opts.local === true));
    this.set(r.board);
    return r;
  }

  private entry(op: BoardOp, accepted: boolean, local: boolean): LogEntry {
    return local ? { op, accepted, local: true, confirmed: false } : { op, accepted };
  }

  /** The server acknowledged a local op (board.ack). */
  confirm(opId: string): void {
    const e = this.log.find((x) => x.accepted && x.op.op_id === opId);
    if (e?.local) e.confirmed = true;
  }

  /**
   * Records an op the server rejected, or a dismissed ghost. If it was applied here
   * optimistically it is rolled back; otherwise it is logged as rejected and its ghost dropped.
   */
  logRejected(op: BoardOp): void {
    if (!usableId(op)) return;
    if (this.log.some((e) => e.accepted && e.op.op_id === op.op_id)) {
      this.rollback(op.op_id);
      return;
    }
    this.log.push({ op, accepted: false });
    this.set(dropGhost(this.board, op.op_id));
  }

  /**
   * Takes back an op that was applied here but rejected by the server: the board becomes
   * the confirmed ops plus the still-pending ones, without it. Its op_id leaves op_ids and
   * rev goes back by one (the server never counted it); ghosts and focus follow the undo rules.
   */
  rollback(opId: string): boolean {
    const e = this.log.find((x) => x.accepted && x.op.op_id === opId);
    if (!e) return false;
    e.accepted = false;
    const cur = this.board;
    const b = this.rebuild();
    const opIds = cur.op_ids.filter((id) => id !== opId);
    this.set({
      ...b,
      ghosts: cur.ghosts.filter((g) => g.op_id !== opId && !opIds.includes(g.op_id)),
      focus: cur.focus && b.items.some((i) => i.id === cur.focus) ? cur.focus : null,
      rev: opIds.length < cur.op_ids.length ? cur.rev - 1 : cur.rev,
      op_ids: opIds,
    });
    return true;
  }

  /** Dismisses a pending ghost locally (the caller sends board.ghost_reject). */
  rejectGhost(opId: string): void {
    const g = this.board.ghosts.find((x) => x.op_id === opId);
    if (!g) return;
    this.log.push({ op: g as BoardOp, accepted: false });
    this.set(dropGhost(this.board, opId));
  }

  /** Replaces the pending ghost list (board.ghosts), minus any already committed. */
  setGhosts(ghosts: GhostOp[]): void {
    const committed = new Set(this.board.op_ids);
    this.set({ ...this.board, ghosts: ghosts.filter((g) => !committed.has(g.op_id)) });
  }

  setFocus(id: string | null, nowMs = typeof performance !== 'undefined' ? performance.now() : 0): void {
    this.focusAt = nowMs;
    if (id !== null && !this.board.items.some((i) => i.id === id)) id = null;
    if (this.board.focus === id) return;
    this.set({ ...this.board, focus: id });
  }

  /** The focus item while it is fresh (set within `ttlMs`), else null. */
  freshFocus(nowMs: number, ttlMs = 20000): string | null {
    return this.board.focus && nowMs - this.focusAt <= ttlMs ? this.board.focus : null;
  }

  private undone(): Set<string> {
    const s = new Set<string>();
    for (const e of this.log) if (e.accepted && e.op.op === 'undo') s.add(e.op.args.target_op_id);
    return s;
  }

  /**
   * The board effects from `start`: every accepted op except undos and their targets,
   * confirmed ops first (server order), then pending local ones. Ops that now fail are
   * dropped and remembered in `dropped`.
   */
  private rebuild(undone = this.undone()): Board {
    const live = this.log.filter((e) => e.accepted && e.op.op !== 'undo' && !undone.has(e.op.op_id));
    const ordered = [...live.filter((e) => !e.local || e.confirmed), ...live.filter((e) => e.local && !e.confirmed)];
    this.dropped = new Set();
    let b = this.start;
    for (const e of ordered) {
      const r = tryApplyOp(b, e.op);
      if (r.accepted) b = r.board;
      else this.dropped.add(e.op.op_id);
    }
    return b;
  }

  /**
   * The op the Undo button would undo: the last op this client made by hand or voice
   * that is accepted, not an undo, not undone, and still has an effect on the board.
   */
  undoTarget(): string | null {
    const undone = this.undone();
    for (let i = this.log.length - 1; i >= 0; i--) {
      const e = this.log[i]!;
      if (!e.accepted || !e.local || e.op.op === 'undo' || undone.has(e.op.op_id) || this.dropped.has(e.op.op_id)) continue;
      if (e.op.src === 'hand' || e.op.src === 'voice_grammar') return e.op.op_id;
    }
    return null;
  }

  private undo(op: Extract<BoardOp, { op: 'undo' }>, local: boolean): ApplyResult {
    const cur = this.board;
    if (typeof op.op_id === 'string' && cur.op_ids.includes(op.op_id)) return { board: cur, accepted: false, duplicate: true };
    const fail = (error: string): ApplyResult => {
      if (usableId(op)) {
        this.log.push({ op, accepted: false });
        this.set(dropGhost(this.board, op.op_id));
      }
      return { board: this.board, accepted: false, error };
    };
    const invalid = validateOp(op);
    if (invalid) return fail(invalid);
    const target = op.args.target_op_id;
    const entry = this.log.find((e) => e.accepted && e.op.op_id === target);
    if (!entry) return fail(`${target} is not an accepted op`);
    if (entry.op.op === 'undo') return fail('an undo cannot be undone');
    const undone = this.undone();
    if (undone.has(target)) return fail(`${target} is already undone`);
    undone.add(target);

    const b = this.rebuild(undone);
    const opIds = [...cur.op_ids, op.op_id];
    const next: Board = {
      ...b,
      ghosts: cur.ghosts.filter((g) => !opIds.includes(g.op_id)),
      focus: cur.focus && b.items.some((i) => i.id === cur.focus) ? cur.focus : null,
      rev: cur.rev + 1,
      op_ids: opIds,
    };
    this.log.push(this.entry(op, true, local));
    this.set(next);
    return { board: next, accepted: true };
  }
}
