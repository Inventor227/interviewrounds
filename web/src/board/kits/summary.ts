// The parts of the interviewer's board summary that come from the LLD and PM kits, written
// exactly as the server prints them (server/src/board/summary.rs: member_sig, describe,
// item_lines, pm_lines). A test mirror only: the tests pin that what the kits make reads the
// way the server prints it. It leaves out the server's caps (40 items), its stripping of
// untrusted text and its section order; the server's own tests cover those.
import type { Board, ClassItem, ClassMember, StickyItem } from '../../shared/types';

/** Longest candidate field the server prints (MAX_FIELD_CHARS). */
const MAX_FIELD = 80;
/** Most parts listed before "+k more" (MAX_PARTS). */
const MAX_PARTS = 12;

/** One line, inert, capped, double quotes turned into single ones (summary.rs `clean`). */
function clean(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return [...one].slice(0, MAX_FIELD).join('').replace(/"/g, "'");
}

const q = (s: string) => `"${clean(s)}"`;

/** "a; b; c." (summary.rs `sentence`). */
function sentence(items: string[]): string {
  const s = items.join('; ');
  return s.endsWith('.') ? s : `${s}.`;
}

function capped(parts: string[]): string[] {
  if (parts.length <= MAX_PARTS) return parts;
  return [...parts.slice(0, MAX_PARTS), `+${parts.length - MAX_PARTS} more`];
}

/** `-levels:List<Level>`, `+park(v:Vehicle):Ticket` (summary.rs `member_sig`). */
export function memberSig(m: ClassMember, method: boolean): string {
  let s = `${m.vis}${clean(m.name)}`;
  if (method) {
    s += `(${(m.params ?? []).map((p) => (p.type ? `${clean(p.name)}:${clean(p.type)}` : clean(p.name))).join(', ')})`;
    if (m.returns) s += `:${clean(m.returns)}`;
  } else if (m.type) {
    s += `:${clean(m.type)}`;
  }
  return s;
}

/** `ParkingLot{-levels:List<Level>; +park(v:Vehicle):Ticket}`. */
export function classSignature(c: ClassItem): string {
  const name = c.label?.trim() ? clean(c.label) : '(unnamed)';
  const members = capped([...c.fields.map((m) => memberSig(m, false)), ...c.methods.map((m) => memberSig(m, true))]);
  return `${name}{${members.join('; ')}}`;
}

/** A class as listed under "Classes:": `c1 abstract "Level{}"`. */
export function describeClass(c: ClassItem): string {
  const kind = c.class_kind === 'class' ? '' : `${c.class_kind} `;
  return `${c.id} ${kind}"${classSignature(c)}"`;
}

function describeSticky(s: StickyItem): string {
  return `${s.id} ${q(s.text)}${s.votes > 0 ? ` (${s.votes} ${s.votes === 1 ? 'vote' : 'votes'})` : ''}`;
}

/** Natural order for ids (s2 before s10), as the server sorts them. */
function natural(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true });
}

/** The PM lines: lanes, other stickies, then the ladder (summary.rs item_lines and pm_lines). */
export function pmLines(board: Board): string[] {
  const stickies = board.items.filter((i): i is StickyItem => i.kind === 'sticky').sort((a, b) => natural(a.id, b.id));
  const out: string[] = [];
  for (const [lane, name] of [
    ['user', 'Users'],
    ['pain', 'Pain points'],
    ['idea', 'Ideas'],
    ['metric', 'Metrics lane'],
    [null, 'Other stickies'],
  ] as const) {
    const entries = stickies.filter((s) => s.lane === lane).map(describeSticky);
    if (entries.length) out.push(`${name}: ${sentence(entries)}`);
  }
  const ranked = stickies.filter((s) => s.rank != null).sort((a, b) => a.rank! - b.rank! || natural(a.id, b.id));
  if (ranked.length) out.push(`Ladder: ${sentence(ranked.map((s) => `${s.rank} ${s.id}`))}`);
  return out;
}
