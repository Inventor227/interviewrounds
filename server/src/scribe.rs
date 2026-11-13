//! The Scribe: after each final user utterance in a board round, a fast model call turns what the candidate just
//! said into at most three suggested board ops ("ghosts") the candidate accepts with a pinch or dismisses.
//!
//! The prompt is `content/prompts/scribe.md`, filled as written. The reply is structured output limited to the
//! ops the Scribe may suggest. Every op is then checked here: it must apply cleanly to the board (unknown ids,
//! bad args and reused ids are dropped, in order, so an edge to an item created in the same answer is fine), and
//! its text must be something the candidate said (type and relationship words aside). Errors, timeouts and
//! refusals give no ghosts. The caller runs this off the hot path and pushes the result as `board.ghosts`.

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{Value, json};

use crate::board::{self, Board, BoardKit, BoardOp, GhostOp, Item, Src};
use crate::claude::{Message, MessagesRequest, OutputConfig, SystemBlock, thinking_for};
use crate::content::Catalog;
use crate::orchestrator::LlmApi;
use crate::orchestrator::prompt::fill;

/// No ghosts after this long: the moment has passed.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(4);
/// At most this many ops per utterance.
pub const MAX_OPS: usize = 3;
/// Replies the model itself rates below this give no ghosts.
pub const MIN_CONFIDENCE: f64 = 0.3;
/// Free positions offered to the model.
const FREE_SLOTS: usize = 6;

/// Every op the Scribe may suggest (the op shapes in `scribe.md`, plus the coding Approach card).
pub const SCRIBE_OPS: &[&str] = &[
    "item.create",
    "item.label",
    "item.set_type",
    "item.note.add",
    "edge.create",
    "edge.label",
    "edge.set_dir",
    "edge.set_rel",
    "member.add",
    "code.insert",
    "code.edit",
    "code.complexity",
    "code.approach",
    "sticky.set_quad",
    "park.add",
    "agenda.check",
];

/// The ops the Scribe may suggest on a board of this kit (the prompt's "By kit" section). Keeping each kit's
/// reply schema to its own ops also keeps it under the API's limit of 16 union-typed parameters.
pub fn kit_ops(kit: BoardKit) -> &'static [&'static str] {
    match kit {
        BoardKit::Hld => &[
            "item.create",
            "item.label",
            "item.set_type",
            "item.note.add",
            "edge.create",
            "edge.label",
            "edge.set_dir",
        ],
        BoardKit::Lld => &[
            "item.create",
            "item.label",
            "item.set_type",
            "edge.create",
            "edge.label",
            "edge.set_dir",
            "edge.set_rel",
            "member.add",
        ],
        BoardKit::Coding => &[
            "code.insert",
            "code.edit",
            "code.complexity",
            "code.approach",
        ],
        BoardKit::Pm => &[
            "item.create",
            "item.label",
            "item.set_type",
            "edge.create",
            "edge.label",
            "sticky.set_quad",
        ],
        BoardKit::Meeting => &["park.add", "agenda.check"],
    }
}

/// The item kinds `item.create` may make on a board of this kit.
fn kit_kinds(kit: BoardKit) -> &'static [&'static str] {
    match kit {
        BoardKit::Hld => &["component"],
        BoardKit::Lld => &["class"],
        BoardKit::Pm => &["sticky", "metric"],
        BoardKit::Coding | BoardKit::Meeting => &[],
    }
}

/// The heading in `scribe.md` after which every line changes per session or per call.
const SESSION_MARKER: &str = "\nThis session\n";

/// The prompt as two system blocks: the rules (the same on every call, so they are cached) and this call's
/// session values, board and utterances. Joined, they are the whole prompt.
fn system_blocks(prompt: &str) -> Vec<SystemBlock> {
    match prompt.find(SESSION_MARKER) {
        Some(i) => vec![
            SystemBlock::cached(&prompt[..=i]),
            SystemBlock::text(&prompt[i + 1..]),
        ],
        None => vec![SystemBlock::text(prompt)],
    }
}

#[derive(Clone, Debug)]
pub struct Scribe {
    pub model: String,
    /// `scribe.md` with comments stripped.
    pub template: String,
    pub timeout: Duration,
}

/// One Scribe call.
#[derive(Clone, Copy, Debug)]
pub struct ScribeInput<'a> {
    /// The round's `round_type`, e.g. `pm_execution` (the prompt branches on it within a kit).
    pub round_type: &'a str,
    pub board: &'a Board,
    /// The item "that", "this" and "it" refer to: `BoardSession::scribe_focus()` (the client's focus while fresh).
    pub focus: Option<&'a str>,
    /// The last one to three final user segments, oldest first; the last one is new.
    pub utterances: &'a [String],
    /// From `BoardSession::next_scribe_call`: new ids start with `x<n>_`, ghost op ids are `sc<n>.<i>`.
    pub call_no: u64,
}

#[derive(Deserialize)]
struct Reply {
    #[serde(default)]
    ops: Vec<RawOp>,
    /// Missing confidence fails closed.
    #[serde(default)]
    confidence: f64,
}

#[derive(Deserialize)]
struct RawOp {
    op: String,
    #[serde(default)]
    args: Value,
}

impl Scribe {
    pub fn new(model: impl Into<String>, template: impl Into<String>) -> Self {
        Scribe {
            model: model.into(),
            template: template.into(),
            timeout: DEFAULT_TIMEOUT,
        }
    }

    /// The Scribe with the `scribe` prompt from the content catalog; `None` when the prompt is missing.
    pub fn from_catalog(cat: &Catalog, model: &str) -> Option<Self> {
        cat.prompt("scribe").map(|t| Scribe::new(model, t))
    }

    pub fn with_timeout(&self, timeout: Duration) -> Scribe {
        Scribe {
            timeout,
            ..self.clone()
        }
    }

    /// The filled prompt.
    pub fn prompt(&self, input: &ScribeInput) -> String {
        let b = input.board;
        let language = b
            .code
            .as_ref()
            .map(|c| c.language.clone())
            .or_else(|| b.round.language.clone())
            .filter(|l| !l.trim().is_empty())
            .unwrap_or_else(|| "none".into());
        let focus = input.focus.filter(|f| b.items.iter().any(|i| i.id() == *f));
        let slots = free_slots(b, focus, FREE_SLOTS);
        let slots = if slots.is_empty() {
            "none".to_string()
        } else {
            slots
                .iter()
                .map(|(x, y)| format!("{x},{y}"))
                .collect::<Vec<_>>()
                .join("; ")
        };
        let vars: HashMap<&str, String> = HashMap::from([
            ("kit", b.round.kit.as_str().to_string()),
            ("round_type", input.round_type.to_string()),
            ("question", b.brief.question.clone()),
            ("board_text", board::summary(&with_focus(b, focus), None)),
            ("focus", focus.unwrap_or("none").to_string()),
            ("language", language),
            ("new_id_prefix", format!("x{}_", input.call_no)),
            ("free_slots", slots),
            (
                "utterances",
                input
                    .utterances
                    .iter()
                    .map(|u| u.trim())
                    .collect::<Vec<_>>()
                    .join("\n"),
            ),
        ]);
        fill(&self.template, &vars)
    }

    /// The model request: fast model, low effort, structured output limited to the Scribe's ops.
    pub fn build_request(&self, input: &ScribeInput) -> MessagesRequest {
        MessagesRequest {
            model: self.model.clone(),
            max_tokens: 2048,
            system: system_blocks(&self.prompt(input)),
            messages: vec![Message::user_text(
                "Return the board edits for the last line, as JSON.",
            )],
            thinking: thinking_for(&self.model),
            output_config: Some(OutputConfig {
                effort: Some("low".into()),
                format: Some(
                    json!({"type": "json_schema", "schema": output_schema(input.board.round.kit)}),
                ),
            }),
            ..MessagesRequest::default()
        }
    }

    /// Suggested ops for the last utterance; empty on timeout, error, refusal or anything unusable.
    pub async fn suggest(&self, llm: &dyn LlmApi, input: &ScribeInput<'_>) -> Vec<GhostOp> {
        if input.utterances.last().is_none_or(|u| u.trim().is_empty()) {
            return Vec::new();
        }
        let req = self.build_request(input);
        let started = Instant::now();
        let res = tokio::time::timeout(self.timeout, llm.create(&req)).await;
        let ms = started.elapsed().as_millis() as u64;
        let resp = match res {
            Err(_) => {
                tracing::warn!(ms, "scribe timed out");
                return Vec::new();
            }
            Ok(Err(e)) => {
                tracing::warn!(ms, error = %e, "scribe call failed");
                return Vec::new();
            }
            Ok(Ok(r)) => r,
        };
        if resp.stop_reason.as_deref() == Some("refusal") {
            tracing::warn!(ms, "scribe refused");
            return Vec::new();
        }
        let ghosts = self.ghosts_from_reply(input, &resp.text());
        tracing::info!(ms, ghosts = ghosts.len(), model = %resp.model, "scribe");
        ghosts
    }

    /// Checks a reply and turns it into ghosts (at most [`MAX_OPS`], in the order the model gave them).
    pub fn ghosts_from_reply(&self, input: &ScribeInput, text: &str) -> Vec<GhostOp> {
        tracing::debug!(reply = %text, "scribe reply");
        let Some(reply) = parse_reply(text) else {
            tracing::warn!("scribe reply is not the expected JSON");
            return Vec::new();
        };
        if reply.confidence < MIN_CONFIDENCE {
            tracing::debug!(
                confidence = reply.confidence,
                "scribe reply below the confidence floor"
            );
            return Vec::new();
        }
        let Some(last) = input.utterances.last() else {
            return Vec::new();
        };
        let heard_last = heard(std::slice::from_ref(last));
        let heard_all = heard(input.utterances);
        let mut scratch = input.board.clone();
        let mut out = Vec::new();
        for (i, raw) in reply.ops.into_iter().enumerate() {
            if out.len() == MAX_OPS {
                break;
            }
            let Some(args) = allowed(&raw, input.board.round.kit, input.call_no) else {
                tracing::debug!(op = %raw.op, "scribe op dropped: not a Scribe op for this kit");
                continue;
            };
            let heard = if raw.op == "park.add" {
                &heard_all
            } else {
                &heard_last
            };
            let said_it = match raw.op.as_str() {
                "code.complexity" => match args.get("value").and_then(Value::as_str) {
                    Some(v) => complexity_said(v, heard),
                    None => clear_said(heard),
                },
                "sticky.set_quad" => quadrant_said(heard),
                _ => texts(&raw.op, &args, input.board.round.kit)
                    .iter()
                    .all(|t| said(t, heard)),
            };
            if !said_it {
                tracing::debug!(op = %raw.op, args = %args, "scribe op dropped: text not said");
                continue;
            }
            let op = BoardOp {
                op_id: format!("sc{}.{}", input.call_no, i + 1),
                src: Src::Scribe,
                op: raw.op,
                args,
                rev_base: None,
                at_ms: None,
            };
            if let Err(e) = board::apply(&mut scratch, &op) {
                tracing::debug!(op = %op.op, args = %op.args, error = %e, "scribe op dropped: does not apply");
                continue;
            }
            out.push(GhostOp {
                op_id: op.op_id,
                src: Src::Scribe,
                op: op.op,
                args: op.args,
            });
        }
        out
    }
}

/// `suggest` without keeping a [`Scribe`] around.
pub async fn suggest(
    llm: &dyn LlmApi,
    model: &str,
    template: &str,
    input: &ScribeInput<'_>,
) -> Vec<GhostOp> {
    Scribe::new(model, template).suggest(llm, input).await
}

fn parse_reply(text: &str) -> Option<Reply> {
    let text = text.trim();
    serde_json::from_str(text).ok().or_else(|| {
        let (a, b) = (text.find('{')?, text.rfind('}')?);
        serde_json::from_str(text.get(a..=b)?).ok()
    })
}

/// The op's args when the Scribe may make it on this kit, or `None`. Every id it creates must start with this
/// call's `x<n>_` prefix (so two calls, or a call and the candidate's own ids, never collide). What the candidate
/// cannot have said by voice is fixed: new stickies have no votes and no quadrant (`sticky.set_quad` places them),
/// new items join no group, and code lines are marked `src: scribe`.
fn allowed(raw: &RawOp, kit: BoardKit, call_no: u64) -> Option<Value> {
    if !kit_ops(kit).contains(&raw.op.as_str()) || !raw.args.is_object() {
        return None;
    }
    let prefix = format!("x{call_no}_");
    let mut args = raw.args.clone();
    let mut created: Vec<Option<&str>> = Vec::new();
    match raw.op.as_str() {
        "item.create" => {
            let kind = args.get("kind").and_then(Value::as_str)?.to_string();
            if !kit_kinds(kit).contains(&kind.as_str()) {
                return None;
            }
            let obj = args.as_object_mut()?;
            obj.remove("group");
            if kind == "sticky" {
                obj.insert("votes".into(), json!(0));
                obj.insert("quad".into(), Value::Null);
                obj.remove("rank");
            }
        }
        "code.insert" => {
            if let Some(line) = args.get_mut("line").and_then(Value::as_object_mut) {
                line.insert("src".into(), json!("scribe"));
            }
        }
        _ => {}
    }
    match raw.op.as_str() {
        "item.create" => {
            created.push(args.get("id").and_then(Value::as_str));
            for sec in ["fields", "methods"] {
                for m in args
                    .get(sec)
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    created.push(m.get("id").and_then(Value::as_str));
                }
            }
        }
        "edge.create" => created.push(args.get("id").and_then(Value::as_str)),
        "member.add" => created.push(
            args.get("member")
                .and_then(|m| m.get("id"))
                .and_then(Value::as_str),
        ),
        "code.insert" => created.push(
            args.get("line")
                .and_then(|l| l.get("id"))
                .and_then(Value::as_str),
        ),
        _ => {}
    }
    if created
        .iter()
        .any(|id| !id.is_some_and(|id| id.starts_with(&prefix)))
    {
        return None;
    }
    Some(args)
}

/// The free-text args of an op: what must have been said.
fn texts(op: &str, args: &Value, kit: BoardKit) -> Vec<String> {
    let notation = |l: &String| kit == BoardKit::Lld && is_multiplicity(l);
    let s = |v: Option<&Value>| v.and_then(Value::as_str).map(str::to_string);
    let mut out = Vec::new();
    let member = |m: &Value, out: &mut Vec<String>| {
        out.extend(s(m.get("name")));
        out.extend(s(m.get("type")));
        out.extend(s(m.get("returns")));
        for p in m
            .get("params")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            out.extend(s(p.get("name")));
            out.extend(s(p.get("type")));
        }
    };
    match op {
        "item.create" => {
            out.extend(s(args.get("label")));
            out.extend(s(args.get("text")));
            for sec in ["fields", "methods"] {
                for m in args
                    .get(sec)
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    member(m, &mut out);
                }
            }
        }
        "edge.label" => out.extend(s(args.get("text")).filter(|l| !notation(l))),
        "item.label" | "item.note.add" | "code.edit" | "park.add" => {
            out.extend(s(args.get("text")))
        }
        "edge.create" => out.extend(s(args.get("label")).filter(|l| !notation(l))),
        "member.add" => {
            if let Some(m) = args.get("member") {
                member(m, &mut out);
            }
        }
        "code.insert" => out.extend(s(args.get("line").and_then(|l| l.get("text")))),
        "code.approach" => {
            for l in args
                .get("lines")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                out.extend(s(Some(l)));
            }
        }
        _ => {}
    }
    out
}

/// Words that never need to have been said: type and relationship words, glue words, code keywords.
const EXEMPT: &[&str] = &[
    // glue
    "a",
    "an",
    "the",
    "of",
    "to",
    "and",
    "or",
    "for",
    "in",
    "on",
    "with",
    "by",
    "at",
    "from",
    "is",
    "it",
    "this",
    "that",
    "as",
    "be",
    "per",
    "via",
    "each",
    "all",
    "its",
    "our",
    "my",
    "we",
    "no",
    "not",
    // component and class types, relationships, roles, lanes
    "service",
    "services",
    "server",
    "svc",
    "db",
    "database",
    "databases",
    "kv",
    "store",
    "storage",
    "cache",
    "queue",
    "lb",
    "load",
    "balancer",
    "api",
    "gateway",
    "cdn",
    "object",
    "search",
    "worker",
    "workers",
    "external",
    "client",
    "clients",
    "app",
    "note",
    "component",
    "class",
    "interface",
    "abstract",
    "enum",
    "uses",
    "use",
    "has",
    "have",
    "extends",
    "implements",
    "inherits",
    "many",
    "north",
    "star",
    "input",
    "guardrail",
    "metric",
    "metrics",
    "user",
    "users",
    "pain",
    "idea",
    "ideas",
    // common types
    "list",
    "map",
    "set",
    "dict",
    "array",
    "string",
    "str",
    "int",
    "integer",
    "long",
    "bool",
    "boolean",
    "void",
    "float",
    "double",
    "char",
    "optional",
    // code keywords
    "true",
    "false",
    "null",
    "none",
    "nil",
    "self",
    "return",
    "returns",
    "def",
    "if",
    "else",
    "elif",
    "while",
    "do",
    "new",
    "let",
    "const",
    "var",
    "fn",
    "func",
    "function",
    "public",
    "private",
    "static",
    "print",
    "len",
    "range",
    "break",
    "continue",
    "pass",
    "import",
    "val",
    "auto",
    "end",
    "then",
];

fn num_word(w: &str) -> Option<u64> {
    const SMALL: [&str; 20] = [
        "zero",
        "one",
        "two",
        "three",
        "four",
        "five",
        "six",
        "seven",
        "eight",
        "nine",
        "ten",
        "eleven",
        "twelve",
        "thirteen",
        "fourteen",
        "fifteen",
        "sixteen",
        "seventeen",
        "eighteen",
        "nineteen",
    ];
    const TENS: [&str; 8] = [
        "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety",
    ];
    if let Some(i) = SMALL.iter().position(|s| *s == w) {
        return Some(i as u64);
    }
    if let Some(i) = TENS.iter().position(|s| *s == w) {
        return Some(20 + 10 * i as u64);
    }
    match w {
        "hundred" => Some(100),
        "thousand" => Some(1000),
        "million" => Some(1_000_000),
        "billion" => Some(1_000_000_000),
        _ => None,
    }
}

/// Lowercase words, split at non-alphanumerics, camelCase humps and letter/digit borders.
fn words(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut prev: Option<char> = None;
    for c in s.chars() {
        if !c.is_alphanumeric() {
            if !cur.is_empty() {
                out.push(std::mem::take(&mut cur));
            }
            prev = None;
            continue;
        }
        if let Some(p) = prev {
            let hump = p.is_lowercase() && c.is_uppercase();
            let border = p.is_ascii_digit() != c.is_ascii_digit();
            if (hump || border) && !cur.is_empty() {
                out.push(std::mem::take(&mut cur));
            }
        }
        cur.extend(c.to_lowercase());
        prev = Some(c);
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// The words of the utterances, with spoken numbers as digits and common speech recognition slips fixed.
fn heard(utterances: &[String]) -> HashSet<String> {
    let mut out = HashSet::new();
    for u in utterances {
        let ws = words(u);
        for (i, w) in ws.iter().enumerate() {
            out.insert(w.clone());
            match w.as_str() {
                "cash" => _ = out.insert("cache".into()),
                "q" | "cue" | "queues" => _ = out.insert("queue".into()),
                "sequel" => {
                    out.insert("sql".into());
                    if i > 0 && ws[i - 1] == "no" {
                        out.insert("nosql".into());
                    }
                }
                _ => {}
            }
            if let Some(n) = num_word(w) {
                out.insert(n.to_string());
                // "sixty two" -> 62, "five hundred" -> 500
                if let Some(next) = ws.get(i + 1).and_then(|x| num_word(x)) {
                    if (20..100).contains(&n) && n % 10 == 0 && next < 10 {
                        out.insert((n + next).to_string());
                    }
                    if n < 100 && next >= 100 {
                        out.insert((n * next).to_string());
                    }
                }
            }
        }
    }
    out
}

fn common_prefix(a: &str, b: &str) -> usize {
    a.chars().zip(b.chars()).take_while(|(x, y)| x == y).count()
}

fn within_one_edit(a: &str, b: &str) -> bool {
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    if a.len().abs_diff(b.len()) > 1 {
        return false;
    }
    let (mut i, mut j, mut edits) = (0, 0, 0);
    while i < a.len() && j < b.len() {
        if a[i] == b[j] {
            i += 1;
            j += 1;
            continue;
        }
        edits += 1;
        if edits > 1 {
            return false;
        }
        match a.len().cmp(&b.len()) {
            std::cmp::Ordering::Greater => i += 1,
            std::cmp::Ordering::Less => j += 1,
            std::cmp::Ordering::Equal => {
                i += 1;
                j += 1;
            }
        }
    }
    edits + (a.len() - i) + (b.len() - j) <= 1
}

/// Close enough to count as the same word: plurals, short forms ("dict"/"dictionary"), one-letter slips.
fn close(w: &str, h: &str) -> bool {
    if w == h {
        return true;
    }
    if is_number(w) || is_number(h) {
        return false;
    }
    let (lw, lh) = (w.chars().count(), h.chars().count());
    (lw >= 3 && lh >= 3 && (h.starts_with(w) || w.starts_with(h)))
        || (lw >= 4 && lh >= 4 && common_prefix(w, h) >= 3)
        || (lw >= 5 && lh >= 5 && within_one_edit(w, h))
}

/// Whether the candidate said `text`: every number in it was said (exactly), and every other content word of a
/// short text (up to three), three quarters of a longer one, matches a word they said.
fn said(text: &str, heard: &HashSet<String>) -> bool {
    let content: Vec<String> = words(text)
        .into_iter()
        .filter(|w| (w.chars().count() >= 2 || is_number(w)) && !EXEMPT.contains(&w.as_str()))
        .collect();
    // Numbers are a hard rule: every one must have been said, however long the text.
    let (numbers, content): (Vec<String>, Vec<String>) =
        content.into_iter().partition(|w| is_number(w));
    if numbers.iter().any(|n| !heard.contains(n)) {
        return false;
    }
    if content.is_empty() {
        return true;
    }
    let hits = content
        .iter()
        .filter(|w| heard.iter().any(|h| close(w, h)))
        .count();
    if content.len() <= 3 {
        hits == content.len()
    } else {
        hits * 4 >= content.len() * 3
    }
}

/// UML multiplicity on a class diagram (`1..*`, `0..1`, `*`, `1`, `n`): relationship notation, not content.
fn is_multiplicity(label: &str) -> bool {
    let l = label.trim();
    !l.is_empty()
        && l.split("..").count() <= 2
        && l.split("..").all(|p| matches!(p, "*" | "n" | "0" | "1"))
}

fn is_number(w: &str) -> bool {
    !w.is_empty() && w.bytes().all(|b| b.is_ascii_digit())
}

/// Whether a complexity value such as `O(n log n)` was said: each of its terms (`n`, `log`, `2` ...; the `o` aside)
/// must be heard, where cue words count as their terms ("linear" is `n`, "squared" is `2`, "constant" is `1`).
fn complexity_said(value: &str, heard: &HashSet<String>) -> bool {
    let mut terms_heard: HashSet<&str> = heard.iter().map(String::as_str).collect();
    for w in heard {
        let cue: &[&str] = match w.as_str() {
            "linear" => &["n"],
            "constant" => &["1"],
            "logarithmic" | "logn" => &["log", "n"],
            "linearithmic" => &["n", "log"],
            "quadratic" | "squared" => &["n", "2"],
            "cubic" | "cubed" => &["n", "3"],
            "exponential" => &["2", "n"],
            _ => &[],
        };
        terms_heard.extend(cue);
    }
    let terms: Vec<String> = words(value).into_iter().filter(|w| w != "o").collect();
    !terms.is_empty() && terms.iter().all(|t| terms_heard.contains(t.as_str()))
}

/// The board as the Scribe should see it: with the caller's fresh focus (which the summary lists first on big
/// boards) instead of the stored one.
fn with_focus(b: &Board, focus: Option<&str>) -> Board {
    let mut view = b.clone();
    view.focus = focus.map(str::to_string);
    view
}

/// Clearing a filled slot needs the candidate to ask for it.
fn clear_said(heard: &HashSet<String>) -> bool {
    [
        "clear", "remove", "reset", "unset", "erase", "delete", "empty",
    ]
    .iter()
    .any(|w| heard.contains(*w))
}

/// Placing a sticky in the 2x2 needs a quadrant cue in what was said.
fn quadrant_said(heard: &HashSet<String>) -> bool {
    const CUES: &[&str] = &[
        "impact",
        "effort",
        "quick",
        "quadrant",
        "high",
        "low",
        "easy",
        "hard",
        "top",
        "bottom",
        "left",
        "right",
        "urgent",
        "priorit",
        "cheap",
        "expensive",
        "costly",
        "win",
    ];
    heard.iter().any(|w| CUES.iter().any(|c| w.starts_with(c)))
}

/// Free board positions for a new card of this kit's usual size, best first (nearest the focus item when there
/// is one, else top-left first), as whole centimetres.
pub fn free_slots(board: &Board, focus: Option<&str>, n: usize) -> Vec<(i64, i64)> {
    let (sw, sh) = match board.round.kit {
        BoardKit::Hld | BoardKit::Coding => (8, 5),
        BoardKit::Lld => (14, 10),
        BoardKit::Pm => (10, 7),
        BoardKit::Meeting => (7, 7),
    };
    let rects: Vec<(f64, f64, f64, f64)> = board.items.iter().map(Item::rect).collect();
    let (w, h) = (board.size.w.floor() as i64, board.size.h.floor() as i64);
    let mut slots = Vec::new();
    let mut y = 2;
    while y + sh < h {
        let mut x = 2;
        while x + sw < w {
            let (x0, y0, x1, y1) = (
                (x - 1) as f64,
                (y - 1) as f64,
                (x + sw + 1) as f64,
                (y + sh + 1) as f64,
            );
            let free = rects
                .iter()
                .all(|(rx, ry, rw, rh)| rx + rw <= x0 || *rx >= x1 || ry + rh <= y0 || *ry >= y1);
            if free {
                slots.push((x, y));
            }
            x += sw + 2;
        }
        y += sh + 2;
    }
    let focus = focus
        .and_then(|f| board.items.iter().find(|i| i.id() == f))
        .map(Item::rect);
    if let Some((fx, fy, fw, fh)) = focus {
        let (cx, cy) = (fx + fw / 2.0, fy + fh / 2.0);
        let d = |(x, y): &(i64, i64)| {
            let (dx, dy) = (
                *x as f64 + sw as f64 / 2.0 - cx,
                *y as f64 + sh as f64 / 2.0 - cy,
            );
            dx * dx + dy * dy
        };
        slots.sort_by(|a, b| d(a).partial_cmp(&d(b)).unwrap_or(std::cmp::Ordering::Equal));
    }
    slots.truncate(n);
    slots
}

fn obj(props: &[(&str, Value)]) -> Value {
    let mut p = serde_json::Map::new();
    for (k, v) in props {
        p.insert((*k).to_string(), v.clone());
    }
    let required: Vec<&str> = props.iter().map(|(k, _)| *k).collect();
    json!({"type": "object", "properties": p, "required": required, "additionalProperties": false})
}

fn nullable(v: Value) -> Value {
    json!({"anyOf": [v, {"type": "null"}]})
}

/// The reply schema for a kit: `{ops: [{op, args}], confidence}`, one `anyOf` branch per op of the kit with its
/// exact args (all objects closed, all properties required, as structured output wants).
pub fn output_schema(kit: BoardKit) -> Value {
    let s = json!({"type": "string"});
    let ns = nullable(s.clone());
    let num = json!({"type": "number"});
    let int = json!({"type": "integer"});
    let component_types = json!({"enum": ["client", "lb", "api_gateway", "service", "db", "kv", "cache", "queue",
        "cdn", "object_store", "search", "worker", "external", "note"]});
    let class_kinds = json!({"enum": ["class", "interface", "abstract", "enum"]});
    let roles = json!({"enum": ["north_star", "input", "guardrail"]});
    let rel = nullable(json!({"enum": ["uses", "has_a", "is_a", "implements"]}));
    let dir = json!({"enum": ["->", "<->", "--"]});
    let quad = nullable(json!({"enum": ["tl", "tr", "bl", "br"]}));
    let member = obj(&[
        ("id", s.clone()),
        ("vis", json!({"enum": ["+", "-", "#", "~"]})),
        ("name", s.clone()),
        ("type", ns.clone()),
        (
            "params",
            json!({"type": "array", "items": obj(&[("name", s.clone()), ("type", ns.clone())])}),
        ),
        ("returns", ns.clone()),
    ]);
    let members = json!({"type": "array", "items": member.clone()});
    let mut kinds: Vec<Value> = Vec::new();
    for kind in kit_kinds(kit) {
        kinds.push(match *kind {
            "component" => obj(&[
                ("id", s.clone()),
                ("kind", json!({"const": "component"})),
                ("type", component_types.clone()),
                ("label", ns.clone()),
                ("x", num.clone()),
                ("y", num.clone()),
                ("w", num.clone()),
                ("h", num.clone()),
            ]),
            "class" => obj(&[
                ("id", s.clone()),
                ("kind", json!({"const": "class"})),
                ("label", ns.clone()),
                ("class_kind", class_kinds.clone()),
                ("fields", members.clone()),
                ("methods", members.clone()),
                ("x", num.clone()),
                ("y", num.clone()),
                ("w", num.clone()),
                ("h", num.clone()),
            ]),
            "sticky" => obj(&[
                ("id", s.clone()),
                ("kind", json!({"const": "sticky"})),
                (
                    "lane",
                    nullable(json!({"enum": ["user", "pain", "idea", "metric"]})),
                ),
                ("text", s.clone()),
                ("votes", int.clone()),
                ("quad", quad.clone()),
                ("x", num.clone()),
                ("y", num.clone()),
            ]),
            _ => obj(&[
                ("id", s.clone()),
                ("kind", json!({"const": "metric"})),
                ("role", roles.clone()),
                ("label", ns.clone()),
                ("x", num.clone()),
                ("y", num.clone()),
            ]),
        });
    }
    let item = if kinds.len() == 1 {
        kinds.remove(0)
    } else {
        json!({"anyOf": kinds})
    };
    let id_text = obj(&[("id", s.clone()), ("text", s.clone())]);
    let types: Vec<Value> = match kit {
        BoardKit::Lld => &class_kinds,
        BoardKit::Pm => &roles,
        _ => &component_types,
    }["enum"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    // Class diagrams name the relationship; other kits leave `rel` out (it defaults to null).
    let mut edge = vec![
        ("id", s.clone()),
        ("from", s.clone()),
        ("to", s.clone()),
        ("dir", dir.clone()),
        ("label", ns.clone()),
    ];
    if kit == BoardKit::Lld {
        edge.push(("rel", rel.clone()));
    }
    let schema_for = |name: &str| -> Value {
        match name {
            "item.create" => item.clone(),
            "item.set_type" => obj(&[("id", s.clone()), ("type", json!({"enum": types.clone()}))]),
            "edge.create" => obj(&edge),
            "edge.set_dir" => obj(&[("id", s.clone()), ("dir", dir.clone())]),
            "edge.set_rel" => obj(&[("id", s.clone()), ("rel", rel.clone())]),
            "member.add" => obj(&[
                ("class_id", s.clone()),
                ("section", json!({"enum": ["fields", "methods"]})),
                ("member", member.clone()),
            ]),
            "code.insert" => obj(&[
                (
                    "line",
                    obj(&[
                        ("id", s.clone()),
                        ("indent", int.clone()),
                        ("text", s.clone()),
                        ("src", json!({"const": "scribe"})),
                    ]),
                ),
                ("after", ns.clone()),
            ]),
            "code.complexity" => obj(&[
                ("slot", json!({"enum": ["time", "space"]})),
                ("value", ns.clone()),
            ]),
            "code.approach" => obj(&[("lines", json!({"type": "array", "items": s.clone()}))]),
            "sticky.set_quad" => obj(&[("id", s.clone()), ("quad", quad.clone())]),
            "park.add" => obj(&[("text", s.clone())]),
            "agenda.check" => obj(&[
                ("id", s.clone()),
                ("done", json!({"type": "boolean"})),
                ("t", nullable(num.clone())),
            ]),
            // item.label, item.note.add, edge.label, code.edit
            _ => id_text.clone(),
        }
    };
    let branches: Vec<Value> = kit_ops(kit)
        .iter()
        .map(|name| obj(&[("op", json!({"const": name})), ("args", schema_for(name))]))
        .collect();
    obj(&[
        (
            "ops",
            json!({"type": "array", "items": {"anyOf": branches}}),
        ),
        ("confidence", num),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(s: &str) -> HashSet<String> {
        heard(&[s.to_string()])
    }

    #[test]
    fn words_split_humps_digits_and_punctuation() {
        assert_eq!(
            words("ParkingLot.park(v: Vehicle) base62"),
            ["parking", "lot", "park", "v", "vehicle", "base", "62"]
        );
        assert_eq!(words("two_sum"), ["two", "sum"]);
    }

    #[test]
    fn said_is_fuzzy_but_not_inventive() {
        assert!(said("Order service", &h("this is our orders service")));
        assert!(said("List<Level>", &h("it has a list of levels")));
        assert!(said("seen = {}", &h("seen equals empty dict")));
        assert!(said(
            "for i, n in enumerate(nums):",
            &h("for i comma n in enumerate numbers")
        ));
        assert!(said("base62", &h("ids are base sixty two")));
        assert!(said("NoSQL store", &h("a no sequel store")));
        assert!(said("Kafka?", &h("then cafka")));
        assert!(!said("Kafka", &h("then a queue")));
        assert!(!said(
            "idempotent retries",
            &h("that one is the booking service")
        ));
        assert!(!said("Payments", &h("the orders service")));
    }

    /// Nodes the API counts as union-typed: `anyOf` or a list of types.
    fn unions(v: &Value) -> usize {
        match v {
            Value::Object(m) => {
                let here = usize::from(
                    m.contains_key("anyOf") || m.get("type").is_some_and(Value::is_array),
                );
                here + m.values().map(unions).sum::<usize>()
            }
            Value::Array(a) => a.iter().map(unions).sum(),
            _ => 0,
        }
    }

    fn closed(v: &Value) -> bool {
        match v {
            Value::Object(m) => {
                (m.get("type") != Some(&json!("object"))
                    || m.get("additionalProperties") == Some(&json!(false)))
                    && m.values().all(closed)
            }
            Value::Array(a) => a.iter().all(closed),
            _ => true,
        }
    }

    #[test]
    fn each_kit_schema_lists_its_ops_closed_and_under_the_union_limit() {
        let mut every = HashSet::new();
        for kit in [
            BoardKit::Hld,
            BoardKit::Lld,
            BoardKit::Coding,
            BoardKit::Pm,
            BoardKit::Meeting,
        ] {
            let schema = output_schema(kit);
            let branches = schema["properties"]["ops"]["items"]["anyOf"]
                .as_array()
                .unwrap();
            let names: Vec<&str> = branches
                .iter()
                .map(|b| b["properties"]["op"]["const"].as_str().unwrap())
                .collect();
            assert_eq!(names, kit_ops(kit), "{kit:?}");
            every.extend(names.iter().map(|n| n.to_string()));
            assert!(
                closed(&schema),
                "{kit:?}: additionalProperties must be false on every object"
            );
            assert!(
                unions(&schema) <= 16,
                "{kit:?}: {} union-typed parameters",
                unions(&schema)
            );
        }
        let mut all: Vec<String> = every.into_iter().collect();
        all.sort();
        let mut want: Vec<String> = SCRIBE_OPS.iter().map(|s| s.to_string()).collect();
        want.sort();
        assert_eq!(all, want, "every Scribe op is offered on some kit");
    }
}
