// The instant voice grammar for labels: "call that X", "name it X", "label this X",
// "that's the X", "this is our X". Strict on purpose: anything looser goes to the Scribe,
// which shows its guesses as ghosts instead of changing the board.

const LEAD = String.raw`(?:(?:ok|okay|so|and|now|right|alright|let's|lets)[,\s]+)*`;
const DET = String.raw`(?:(?:the|a|an|our|my)\s+)?`;

// "call that the order service", "rename it to user DB", "label this one as edge cache"
const COMMAND = new RegExp(
  String.raw`^${LEAD}(?:call|name|label|rename)\s+(?:that|this|it)(?:\s+(?:one|box|card|component|node|thing))?\s+(?:as\s+|to\s+)?${DET}(.+)$`,
  'i',
);

// "that's the URL store", "this is our Kafka cluster": only with "the" or "our", so
// "that's fine" or "this is a tricky one" never label anything.
const STATEMENT = new RegExp(String.raw`^${LEAD}(?:that|this|it)(?:'s|’s|\s+is)\s+(?:the|our)\s+(.+)$`, 'i');

/** Words that follow "that's the" in ordinary talk, not names. */
const NOT_NAMES = new Set([
  'problem', 'point', 'idea', 'question', 'issue', 'thing', 'plan', 'way', 'case', 'part', 'catch', 'answer', 'goal',
  'trade off', 'tradeoff', 'hard part', 'tricky part', 'main concern', 'concern', 'end', 'key', 'best', 'worst', 'same',
  'one', 'reason', 'bottleneck', 'risk', 'idea here', 'gist', 'trick', 'main thing', 'whole point', 'easy part',
]);

const FILLER_TAIL = /(?:\s*,?\s*(?:please|for now|i guess|i think|okay|ok|right))+$/i;
const MAX_LABEL = 40;
const MAX_WORDS = 5;

function clean(raw: string): string {
  let s = raw.trim().replace(/[.!?,;:]+$/g, '').trim();
  s = s.replace(FILLER_TAIL, '').trim();
  s = s.replace(/[.!?,;:]+$/g, '').trim();
  return s;
}

function label(raw: string): string | null {
  const s = clean(raw);
  if (!s || s.length > MAX_LABEL) return null;
  const words = s.split(/\s+/);
  if (words.length > MAX_WORDS) return null;
  if (NOT_NAMES.has(s.toLowerCase())) return null;
  // Lower-case first letters read as a name on a card ("order service" -> "Order service").
  return /^[a-z]/.test(s) ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/**
 * A label for the focus item from one finished speech segment, or null when the
 * segment is not a label command.
 */
export function parseLabelCommand(text: string): { label: string } | null {
  const t = text.trim().replace(/\s+/g, ' ');
  if (!t) return null;
  const m = COMMAND.exec(t) ?? STATEMENT.exec(t);
  if (!m?.[1]) return null;
  const l = label(m[1]);
  return l ? { label: l } : null;
}
