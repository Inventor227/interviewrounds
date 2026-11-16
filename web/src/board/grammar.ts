// The instant voice grammar for labels.
// - Commands ("call that X", "name it X", "label this X", "rename it to X") label the focus
//   card at once: an explicit naming verb, a short noun phrase, and a fresh focus.
// - Statements ("that's the X", "this is our X", "it's the X") never change the board: they
//   suggest the label as a ghost on the focus card (pinch to accept, settles in 4 s).
// Anything looser goes to the Scribe, which shows ghosts too.
import type { Board, ComponentType } from '../shared/types';
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

/** A command whose tail is an idiom, not a name: "call it a day", "call that out", "call it even". */
const IDIOM_TAIL = new RegExp(
  String.raw`^(?:(?:out|up|off|later|done|quits|whatever|one|back|in|on|over|for|it|that|this|again|now|even|good|fine|fair|great|bad|ok|okay|square|right|wrong|enough|lucky|close)\b` +
    String.raw`|(?:a|an)\s+(?:day|night|win|wrap|draw|deal|mistake|loss|tie|few|lot|bit|fail|success|bust|wash|toss[- ]?up|stretch|guess|fluke|miss|break|truce|steal)\b` +
    String.raw`|(?:fair|good)\s+enough\b|(?:a\s+)?(?:few|couple)\b)`,
  'i',
);

/** How long a touched or created card stays the target of an instant voice label. */
export const VOICE_FOCUS_MS = 8000;

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

/** A label from the command form only ("call that X"), or null. */
export function parseLabelCommand(text: string): { label: string } | null {
  const t = text.trim().replace(/\s+/g, ' ');
  if (!t) return null;
  const cmd = COMMAND.exec(t);
  if (!cmd?.[1] || IDIOM_TAIL.test(cmd[1].trim())) return null;
  const l = nounPhrase(cmd[1], MAX_COMMAND_WORDS, false);
  return l ? { label: l } : null;
}

/** A label from the statement form ("that's the X", "this is our X", "it's the X"), or null. Only ever a suggestion. */
export function parseLabelStatement(text: string): { label: string } | null {
  const t = text.trim().replace(/\s+/g, ' ');
  if (!t || COMMAND.test(t)) return null;
  const st = STATEMENT.exec(t);
  if (!st?.[1]) return null;
  const l = nounPhrase(st[1], MAX_STATEMENT_WORDS, true);
  return l ? { label: l } : null;
}

const NAMEABLE = new Set(['component', 'class', 'group', 'metric', 'sticky']);

export interface VoiceLabel {
  id: string;
  label: string;
  /** commit: apply item.label now (command form). suggest: show it as a ghost (statement form). */
  mode: 'commit' | 'suggest';
}

/**
 * What a speech segment does to the board: label the focus card now, suggest a label as a
 * ghost, or nothing. `focus` must be the fresh focus (BoardStore.freshFocus(now,
 * VOICE_FOCUS_MS)); null means nothing was touched recently, and nothing happens.
 */
export function voiceLabel(board: Board, text: string, focus: string | null): VoiceLabel | null {
  const it = findItem(board, focus);
  if (!it || !NAMEABLE.has(it.kind)) return null;
  const cmd = parseLabelCommand(text);
  if (cmd) return { id: it.id, label: cmd.label, mode: 'commit' };
  const st = parseLabelStatement(text);
  return st ? { id: it.id, label: st.label, mode: 'suggest' } : null;
}

/**
 * The component type a spoken card name implies, for a box drawn by hand (which starts as a service): "call that the
 * seat table" is a database, "the Redis cache" a cache. First match wins, most specific first; null when the name says
 * nothing about the type (it stays a service). Whole words only, so "app server" is not a client and "restore" not a store.
 */
const TYPE_WORDS: [ComponentType, RegExp][] = [
  ['lb', /\b(?:load\s*balancers?|lb|elb|alb|nlb)\b/],
  ['api_gateway', /\bgateways?\b/],
  ['cdn', /\bcdns?\b/],
  ['cache', /\b(?:caches?|caching|redis|memcached?)\b/],
  ['queue', /\b(?:queues?|kafka|streams?|topics?|sqs|pub\s*sub|message\s*bus|event\s*bus)\b/],
  ['object_store', /\b(?:object\s*stores?|object\s*storage|buckets?|blobs?|blob\s*storage|s3)\b/],
  ['search', /\b(?:search|index|indexes|indices|elastic(?:search)?)\b/],
  ['worker', /\b(?:workers?|jobs?|sweepers?|crons?|cron\s*jobs?|schedulers?)\b/],
  ['kv', /\b(?:key\s*value|kv|nosql|dynamo(?:db)?|cassandra)\b/],
  ['db', /\b(?:tables?|databases?|db|dbs|postgres(?:ql)?|sql|mysql|stores?|ledger)\b/],
];
const CLIENT_WORDS = /\b(?:clients?|apps?|browsers?|phones?|mobile|users?|frontend|front\s*end)\b/;
const SERVER_WORDS = /\b(?:servers?|services?|backend|back\s*end|api|apis)\b/;

export function inferComponentType(label: string): ComponentType | null {
  const s = label.toLowerCase();
  for (const [type, re] of TYPE_WORDS) if (re.test(s)) return type;
  if (CLIENT_WORDS.test(s) && !SERVER_WORDS.test(s)) return 'client';
  return null;
}
