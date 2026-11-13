// The instant voice grammar for labels: "call that X", "name it X", "label this X",
// "that's the X", "this is our X". Strict on purpose: it changes the board without a
// ghost step, so it only fires on a naming phrase with a short noun phrase, and only when
// there is a focus card to name. Anything looser goes to the Scribe, which shows ghosts.
import type { Board } from '../shared/types';
import { findItem } from './model';

const LEAD = String.raw`(?:(?:ok|okay|so|and|now|right|alright|let's|lets)[,\s]+)*`;

// "call that the order service", "rename it to user DB", "label this one as edge cache"
const COMMAND = new RegExp(
  String.raw`^${LEAD}(?:call|name|label|rename)\s+(?:that|this|it)(?:\s+(?:one|box|card|component|node|thing))?\s+(?:as\s+|to\s+)?(.+)$`,
  'i',
);

// "that's the URL store", "this is our Kafka cluster": only with "the" or "our", so
// "that's fine" or "this is a tricky one" never label anything.
const STATEMENT = new RegExp(String.raw`^${LEAD}(?:that|this|it)(?:'s|’s|\s+is)\s+(?:the|our)\s+(.+)$`, 'i');

const DET = /^(?:the|a|an|our|my)\s+/i;

/** A command whose tail is an idiom, not a name: "call it a day", "call that out", "name it later". */
const IDIOM_TAIL = /^(?:out|up|off|later|done|quits|whatever|one|a day|back|in|on|over|for|it|that|this|again|now)\b/i;

/** Pronouns, verbs and function words never appear in a short card name. */
const NOT_IN_NAMES = new Set([
  'i', 'we', 'you', 'it', 'they', 'he', 'she', 'is', 'are', 'was', 'were', 'be', 'gets', 'get', 'got', 'where', 'when',
  'why', 'how', 'what', 'which', 'who', 'here', 'there', 'now', 'really', 'just', 'with', 'about', 'because', 'if',
  'that', 'this', 'then', 'so', 'but', 'do', 'does', 'did', 'can', 'could', 'would', 'should', 'will', 'think', 'mean',
]);

/** Words that start ordinary talk after "that's the" ("that's the main bottleneck", "the right call"). */
const EVALUATIVE = new Set([
  'main', 'real', 'big', 'bigger', 'biggest', 'right', 'wrong', 'same', 'only', 'best', 'worst', 'first', 'last', 'next',
  'whole', 'tricky', 'hard', 'hardest', 'easy', 'easiest', 'key', 'obvious', 'other', 'tough', 'interesting', 'important',
]);

/** Whole remainders after "that's the" that are talk, not names. */
const NOT_NAMES = new Set([
  'problem', 'point', 'idea', 'question', 'issue', 'thing', 'plan', 'way', 'case', 'part', 'catch', 'answer', 'goal',
  'trade off', 'tradeoff', 'concern', 'end', 'reason', 'bottleneck', 'risk', 'gist', 'trick', 'idea here', 'one', 'deal',
  'point here', 'catch here', 'question here', 'problem here', 'difference', 'hope', 'goal here', 'call', 'thing here',
]);

const FILLER_TAIL = /(?:\s*,?\s*(?:please|for now|i guess|i think|okay|ok|right))+$/i;
const MAX_LABEL = 40;
const MAX_COMMAND_WORDS = 5;
const MAX_STATEMENT_WORDS = 4;

function clean(raw: string): string {
  let s = raw.trim().replace(/[.!?,;:]+$/g, '').trim();
  s = s.replace(FILLER_TAIL, '').trim();
  s = s.replace(/[.!?,;:]+$/g, '').trim();
  return s;
}

function nounPhrase(raw: string, maxWords: number, statement: boolean): string | null {
  const s = clean(raw).replace(DET, '');
  if (!s || s.length > MAX_LABEL) return null;
  const words = s.toLowerCase().split(/\s+/);
  if (words.length > maxWords) return null;
  if (words.some((w) => NOT_IN_NAMES.has(w.replace(/['’]s$/, '')))) return null;
  if (statement && (EVALUATIVE.has(words[0]!) || NOT_NAMES.has(words.join(' ')))) return null;
  // Lower-case first letters read as a name on a card ("order service" -> "Order service").
  return /^[a-z]/.test(s) ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/**
 * A label from one finished speech segment, or null when the segment is not a label
 * command. Use voiceLabel to also require a focus card.
 */
export function parseLabelCommand(text: string): { label: string } | null {
  const t = text.trim().replace(/\s+/g, ' ');
  if (!t) return null;
  const cmd = COMMAND.exec(t);
  if (cmd?.[1]) {
    if (IDIOM_TAIL.test(cmd[1].trim())) return null;
    const l = nounPhrase(cmd[1], MAX_COMMAND_WORDS, false);
    return l ? { label: l } : null;
  }
  const st = STATEMENT.exec(t);
  if (st?.[1]) {
    const l = nounPhrase(st[1], MAX_STATEMENT_WORDS, true);
    return l ? { label: l } : null;
  }
  return null;
}

const NAMEABLE = new Set(['component', 'class', 'group', 'metric', 'sticky']);

/**
 * The label op target for a speech segment: the focus card (fresh focus when the caller
 * passes one) and the label, or null when there is no card to name or no label command.
 */
export function voiceLabel(board: Board, text: string, focus: string | null = board.focus): { id: string; label: string } | null {
  const it = findItem(board, focus);
  if (!it || !NAMEABLE.has(it.kind)) return null;
  const parsed = parseLabelCommand(text);
  return parsed ? { id: it.id, label: parsed.label } : null;
}
