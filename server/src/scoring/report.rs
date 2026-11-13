//! Builds the session report (`report.v1`): one streaming structured-output call to the scoring model for the
//! parts it owns (evidence, competency scores, strengths, weaknesses, weakest moment, drills, round details, red
//! flag), then our code fills the rest (session, delivery, verdict, confidence, overall score, deltas), checks
//! every evidence id and quote against the transcript, and validates the result against the schema.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::Duration;

use anyhow::{Context, anyhow, bail};
use base64::Engine;
use futures::StreamExt;
use serde_json::{Map, Value, json};

use super::metrics::{self, DeliveryMetrics, MetricsContext};
use super::verdict::{self, Length};
use super::{ReportEvents, ScoringInput};
use crate::claude::{
    ContentBlock, Message, MessagesRequest, OutputConfig, Role, StreamEvent, SystemBlock, Thinking,
    Usage, fallbacks_for,
};
use crate::content::{Catalog, RoundConfig};
use crate::orchestrator::LlmApi;

/// Shown instead of a verdict when the candidate said too little.
pub const NOT_ENOUGH_SIGNAL: &str = "Not enough signal yet";
pub const NOT_OBSERVED: &str = "Not observed.";

/// `content/schema/report.v1.schema.json`, compiled.
pub struct ReportSchema {
    pub raw: Value,
    validator: jsonschema::Validator,
}

impl ReportSchema {
    pub fn load(content_dir: &Path) -> anyhow::Result<ReportSchema> {
        let path = content_dir.join("schema").join("report.v1.schema.json");
        let raw = std::fs::read_to_string(&path)
            .with_context(|| format!("reading {}", path.display()))?;
        let v: Value =
            serde_json::from_str(&raw).with_context(|| format!("parsing {}", path.display()))?;
        ReportSchema::from_value(v)
    }

    pub fn from_value(raw: Value) -> anyhow::Result<ReportSchema> {
        let validator = jsonschema::validator_for(&raw)
            .map_err(|e| anyhow!("compiling the report schema: {e}"))?;
        Ok(ReportSchema { raw, validator })
    }

    /// Every way `report` breaks the schema (empty when valid).
    pub fn errors(&self, report: &Value) -> Vec<String> {
        self.validator
            .iter_errors(report)
            .map(|e| e.to_string())
            .collect()
    }
}

/// What scoring needs besides the session records.
pub struct ScoreEnv<'a> {
    pub llm: &'a dyn LlmApi,
    pub catalog: &'a Catalog,
    pub schema: &'a ReportSchema,
    pub model: &'a str,
    pub effort: &'a str,
    pub max_tokens: u32,
    /// Ceiling for the whole model call.
    pub timeout: Duration,
    pub events: &'a dyn ReportEvents,
}

/// A finished report and what the model call cost (None when no call was made).
#[derive(Debug)]
pub struct Scored {
    pub report: Value,
    pub usage: Option<Usage>,
    pub model_called: bool,
}

/// Scores one session: delivery metrics, then the model (unless there is not enough signal), then our fields.
/// The result is valid `report.v1`, or an error.
pub async fn score(env: &ScoreEnv<'_>, input: &ScoringInput) -> anyhow::Result<Scored> {
    let round = env
        .catalog
        .round(&input.round_id)
        .ok_or_else(|| anyhow!("unknown round {}", input.round_id))?;
    let rubric = env
        .catalog
        .rubrics
        .get(&round.rubric_id)
        .ok_or_else(|| anyhow!("unknown rubric {}", round.rubric_id))?;
    env.events.progress(&input.session_id, "metrics", 10).await;

    let delivery = delivery_for(input, round);
    let signal = metrics::signal(&input.turns, &input.marks, input.has_timing());
    let lines = transcript_lines(input);

    if !signal.enough() {
        let report = low_signal_report(input, env.catalog, round, rubric, &delivery);
        let errors = env.schema.errors(&report);
        if !errors.is_empty() {
            bail!("low signal report breaks the schema: {}", errors.join("; "));
        }
        return Ok(Scored {
            report,
            usage: None,
            model_called: false,
        });
    }

    env.events.progress(&input.session_id, "scoring", 20).await;
    let req = build_request(env, input, round, rubric, &lines)?;
    let (text, usage) = run_model(env, &input.session_id, &req).await?;
    let out: Value = serde_json::from_str(text.trim())
        .map_err(|e| anyhow!("the model output is not JSON: {e}"))?;

    let mut report = assemble(input, env.catalog, round, rubric, &lines, &out, &delivery);
    let mut errors = env.schema.errors(&report);
    if !errors.is_empty() && report.get("round_details").is_some() {
        tracing::warn!(session_id = %input.session_id, errors = ?errors, "round details dropped: they break the schema");
        if let Some(obj) = report.as_object_mut() {
            obj.remove("round_details");
        }
        errors = env.schema.errors(&report);
    }
    if !errors.is_empty() {
        bail!("report breaks the schema: {}", errors.join("; "));
    }
    Ok(Scored {
        report,
        usage: Some(usage),
        model_called: true,
    })
}

pub fn delivery_for(input: &ScoringInput, round: &RoundConfig) -> DeliveryMetrics {
    let ctx = MetricsContext {
        timing: input.has_timing(),
        round_type: round.round_type.clone(),
        hints: input.hints.clone(),
    };
    metrics::compute(&input.turns, &input.marks, &input.head, &ctx)
}

// ---------- transcript ----------

/// One transcript line as the model sees it: `[s3] 01:05-01:32 user: text`.
#[derive(Clone, Debug, PartialEq)]
pub struct Line {
    pub id: String,
    /// `user` or a persona id.
    pub speaker: String,
    pub text: String,
    pub start_ms: i64,
    pub end_ms: i64,
}

impl Line {
    pub fn render(&self) -> String {
        format!(
            "[{}] {}-{} {}: {}",
            self.id,
            mmss(self.start_ms),
            mmss(self.end_ms),
            self.speaker,
            self.text.replace('\n', " ")
        )
    }
}

/// Speech lines in order, with times: a user line spans the transcript marks that led up to it (when the session
/// had audio timing), else it ends at the stored turn time and starts one estimated speaking time earlier; an
/// agent line starts at its turn time.
pub fn transcript_lines(input: &ScoringInput) -> Vec<Line> {
    let timing = input.has_timing();
    let mut marks = input.marks.clone();
    marks.sort_by_key(|m| (m.end_ms, m.start_ms));
    let mut next_mark = 0usize;
    let mut turns: Vec<&metrics::TurnRec> = input.turns.iter().collect();
    turns.sort_by_key(|t| t.seq);

    let mut lines: Vec<Line> = Vec::new();
    let mut prev_end = 0i64;
    for t in turns {
        let user = t.is_user_speech();
        if !user && !t.is_agent_speech() {
            continue;
        }
        let text = t.speech();
        let est = (metrics::word_count(&text) as f64 * 60_000.0 / metrics::ESTIMATE_WPM) as i64;
        let (start, end) = if user {
            let anchor = t.started_ms.unwrap_or(prev_end + est).max(0);
            let first = next_mark;
            while next_mark < marks.len() && marks[next_mark].end_ms <= anchor + 3_000 {
                next_mark += 1;
            }
            let group = &marks[first..next_mark];
            if timing && !group.is_empty() {
                let s = group.iter().map(|m| m.start_ms).min().unwrap_or(anchor);
                let e = group.iter().map(|m| m.end_ms).max().unwrap_or(anchor);
                (s, e.max(s))
            } else {
                ((anchor - est).max(prev_end.min(anchor)), anchor)
            }
        } else {
            let s = t.started_ms.unwrap_or(prev_end).max(0);
            (s, s + est)
        };
        let speaker = if user {
            "user".to_string()
        } else {
            input.persona_of(t.panelist_id.as_deref())
        };
        lines.push(Line {
            id: format!("s{}", lines.len() + 1),
            speaker,
            text,
            start_ms: start.max(0),
            end_ms: end.max(start).max(0),
        });
        prev_end = end;
    }
    lines
}

pub fn mmss(ms: i64) -> String {
    let s = ms.max(0) / 1000;
    format!("{:02}:{:02}", s / 60, s % 60)
}

// ---------- prompt ----------

/// The scorer prompt split for caching: `intro` and `rules` are the same for every session, `head` holds the
/// session data (the rubric goes to its own cached block, so its place in `head` is removed).
#[derive(Clone, Debug, PartialEq)]
pub struct ScorerPrompt {
    pub intro: String,
    pub head: String,
    pub rules: String,
}

pub fn split_scorer_prompt(template: &str) -> Option<ScorerPrompt> {
    let session_at = template.find("\nSession\n")?;
    let rules_at = template.find("Everything inside Transcript")?;
    if rules_at < session_at {
        return None;
    }
    let head = template[session_at..rules_at]
        .replace("Rubric\n{rubric_json}\n\n", "")
        .trim()
        .to_string();
    Some(ScorerPrompt {
        intro: template[..session_at].trim().to_string(),
        head,
        rules: template[rules_at..].trim().to_string(),
    })
}

/// Replaces `{name}` placeholders in one pass, so text inserted for one placeholder is never expanded again.
pub fn render(template: &str, vars: &[(&str, String)]) -> String {
    let mut out = String::with_capacity(template.len() + 1024);
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        let name_end = after
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
            .unwrap_or(after.len());
        let name = &after[..name_end];
        match (
            after[name_end..].starts_with('}'),
            vars.iter().find(|(k, _)| *k == name),
        ) {
            (true, Some((_, v))) if !name.is_empty() => {
                out.push_str(v);
                rest = &after[name_end + 1..];
            }
            _ => {
                out.push('{');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// The round details variant for a round type.
pub fn details_kind(round_type: &str) -> &'static str {
    match round_type {
        "coding" => "coding",
        "system_design" => "system_design",
        "object_design" => "object_design",
        "behavioral" | "pm_leadership" | "recruiter_screen" => "behavioral",
        "meeting" => "meeting",
        _ => "pm",
    }
}

pub fn build_request(
    env: &ScoreEnv<'_>,
    input: &ScoringInput,
    round: &RoundConfig,
    rubric: &Value,
    lines: &[Line],
) -> anyhow::Result<MessagesRequest> {
    let template = env
        .catalog
        .prompt("scorer")
        .ok_or_else(|| anyhow!("prompt scorer.md is missing"))?;
    let prompt = split_scorer_prompt(template)
        .ok_or_else(|| anyhow!("scorer.md does not have the Session and rules sections"))?;
    let round_ids = env
        .catalog
        .rounds
        .keys()
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    let rules = format!(
        "{}\n\n{}\n\n{OUTPUT_NOTE}",
        prompt.intro,
        render(&prompt.rules, &[("round_ids", round_ids)])
    );
    let rubric_block = format!(
        "Rubric\n{}",
        serde_json::to_string_pretty(rubric).unwrap_or_default()
    );

    let head = render(
        &prompt.head,
        &session_vars(env.catalog, input, round, lines),
    );
    let mut content = Vec::new();
    if let Some(png) = &input.board_png {
        content.push(ContentBlock::Other(json!({
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": "image/png",
                "data": base64::engine::general_purpose::STANDARD.encode(png),
            }
        })));
        content.push(ContentBlock::text(
            "The image above is the final board, the same board as Final board below.",
        ));
    }
    content.push(ContentBlock::text(head));

    let schema = llm_schema(&env.schema.raw, details_kind(&round.round_type));
    Ok(MessagesRequest {
        model: env.model.to_string(),
        max_tokens: env.max_tokens,
        system: vec![
            SystemBlock::cached(rules),
            SystemBlock::cached(rubric_block),
        ],
        messages: vec![Message {
            role: Role::User,
            content,
        }],
        thinking: Some(Thinking::Adaptive),
        output_config: Some(OutputConfig {
            effort: Some(env.effort.to_string()),
            format: Some(json!({ "type": "json_schema", "schema": schema })),
        }),
        fallbacks: fallbacks_for(env.model),
        stream: true,
        ..MessagesRequest::default()
    })
}

fn session_vars(
    catalog: &Catalog,
    input: &ScoringInput,
    round: &RoundConfig,
    lines: &[Line],
) -> Vec<(&'static str, String)> {
    let pretty = |v: &Value| serde_json::to_string_pretty(v).unwrap_or_default();
    let planned: Vec<String> = round.phases.iter().map(|p| p.id.clone()).collect();
    let coverage = format!(
        "Phases planned: {}. Completed: {} ({:.0}%).",
        planned.join(", "),
        if input.phases_completed.is_empty() {
            "none".to_string()
        } else {
            input.phases_completed.join(", ")
        },
        coverage_pct(input, round) * 100.0
    );
    let question = input
        .question_id
        .as_deref()
        .and_then(|q| catalog.bank_card(&round.question_pool, Some(q)))
        .map(pretty)
        .unwrap_or_else(|| "Not recorded.".to_string());
    let transcript = if lines.is_empty() {
        "Nothing was said.".to_string()
    } else {
        lines
            .iter()
            .map(Line::render)
            .collect::<Vec<_>>()
            .join("\n")
    };
    let board_text = input
        .board_text
        .clone()
        .filter(|t| !t.trim().is_empty())
        .unwrap_or_else(|| "No board in this round.".to_string());
    let hints = if !input.hints.is_empty() {
        input
            .hints
            .iter()
            .map(|h| {
                format!(
                    "{} level {}, {}",
                    mmss(h.t_ms),
                    h.level,
                    if h.accepted { "taken" } else { "not taken" }
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    } else if input.hints_given > 0 {
        format!(
            "{} hints given, highest level {}.",
            input.hints_given, input.hint_max_level
        )
    } else {
        "No hints given.".to_string()
    };
    let meeting = input
        .meeting_plan
        .as_ref()
        .map(pretty)
        .unwrap_or_else(|| "none".to_string());
    let mut round_json = serde_json::to_value(round).unwrap_or(Value::Null);
    if let Some(obj) = round_json.as_object_mut() {
        for k in [
            "silence_wait_seconds",
            "interrupt_after_seconds",
            "short_version",
            "full_version",
        ] {
            obj.remove(k);
        }
    }
    vec![
        ("mode", input.mode.clone()),
        ("seniority", input.seniority().to_string()),
        ("length", input.length.clone()),
        ("coverage", coverage),
        ("round_json", pretty(&round_json)),
        ("question_json", question),
        ("transcript", transcript),
        ("board_text", board_text),
        ("board_ops", board_ops_summary(input)),
        ("hints", hints),
        ("meeting_json", meeting),
    ]
}

/// What happened on the board, by whom: placed by hand, accepted from the Scribe, dismissed.
fn board_ops_summary(input: &ScoringInput) -> String {
    let mut out = Vec::new();
    for op in &input.board_ops {
        let label = ["label", "text"]
            .iter()
            .find_map(|k| op.args.get(*k).and_then(Value::as_str))
            .or_else(|| op.args.pointer("/line/text").and_then(Value::as_str))
            .unwrap_or("");
        let who = match (op.src.as_str(), op.accepted) {
            ("scribe", Some(true)) => "accepted from the Scribe",
            ("scribe", Some(false)) => "dismissed a Scribe suggestion",
            (_, Some(false)) => continue,
            ("user", _) => "candidate",
            (other, _) => other,
        };
        let t = op.t_ms.map(mmss).unwrap_or_else(|| "--:--".into());
        out.push(format!("{t} {who}: {} {}", op.op, label).trim().to_string());
    }
    if out.is_empty() {
        return "No board activity.".to_string();
    }
    if out.len() > 80 {
        let skipped = out.len() - 80;
        out.drain(..skipped);
        out.insert(0, format!("({skipped} earlier ops left out)"));
    }
    out.join("\n")
}

pub fn coverage_pct(input: &ScoringInput, round: &RoundConfig) -> f32 {
    if round.phases.is_empty() {
        return 0.0;
    }
    let done = round
        .phases
        .iter()
        .filter(|p| input.phases_completed.iter().any(|c| c == &p.id))
        .count();
    done as f32 / round.phases.len() as f32
}

// ---------- the model's schema ----------

/// The JSON schema the model fills: the parts of `report.v1` only the model can write, plus `segment_id` (the
/// transcript line an evidence item quotes, or where the weakest moment's question was asked) and `red_flag`.
///
/// Everything our code can work out is left out, because the whole schema compiles into one grammar and the API
/// refuses one that is too large: evidence times and speakers come from the quoted line, competency names and
/// levels from the rubric and the score, round types from the round id, the retry length is 120 s. Constraints
/// structured outputs do not take (lengths, item counts, number ranges) are enforced after the call.
pub fn llm_schema(report_schema: &Value, details_kind: &str) -> Value {
    let props = &report_schema["properties"];
    let defs = &report_schema["$defs"];
    let pick = |from: &Value, keep: &[&str]| -> Value {
        let mut v = from.clone();
        if let Some(p) = v.get_mut("properties").and_then(Value::as_object_mut) {
            p.retain(|k, _| keep.contains(&k.as_str()));
        }
        v
    };
    let segment_id = |what: &str| json!({ "type": "string", "description": what });

    let competency = pick(
        &props["competencies"]["items"],
        &["id", "score", "rationale", "evidence_ids"],
    );
    let mut evidence = pick(
        &props["evidence"]["items"],
        &["id", "quote", "polarity", "competency_ids", "note"],
    );
    evidence["properties"]["segment_id"] = segment_id(
        "Id of the transcript line quoted, e.g. s12; \"board\" for a quote from the final board.",
    );

    let mut weakest = pick(
        &props["weakest_moment"],
        &[
            "question",
            "what_happened",
            "strong_answer_covers",
            "model_answer",
            "retry",
        ],
    );
    weakest["properties"]["segment_id"] =
        segment_id("Id of the transcript line where the question was asked.");
    weakest["properties"]["retry"] = pick(&weakest["properties"]["retry"], &["prompt"]);

    let drills = json!({
        "type": "array",
        "items": pick(&props["next_drills"]["items"], &["title", "why", "kind", "round_id", "est_minutes"]),
    });

    let mut details = details_variant(report_schema, details_kind);
    remove_props(&mut details, &["board_image_url", "board_as_text"]);
    details["properties"]["kind"] = json!({ "const": details_kind });
    if details_kind == "meeting" {
        // The full meeting block makes the grammar too large for the API: the model fills the outcome fields
        // only; the template comes from the plan. Attendees, objections and next steps are not asked for.
        let keep = [
            "kind",
            "goal",
            "outcome",
            "goal_reached",
            "decision_quote_id",
            "ask_made",
        ];
        if let Some(p) = details["properties"].as_object_mut() {
            p.retain(|k, _| keep.contains(&k.as_str()));
        }
    }

    let schema = json!({
        "type": "object",
        "properties": {
            "headline": {
                "type": "object",
                "properties": { "summary": props["headline"]["properties"]["summary"].clone() }
            },
            "competencies": { "type": "array", "items": competency },
            "evidence": { "type": "array", "items": evidence },
            "strengths": defs["points"].clone(),
            "weaknesses": defs["points"].clone(),
            "weakest_moment": weakest,
            "next_drills": drills,
            "round_details": details,
            "red_flag": {
                "type": "object",
                "properties": {
                    "present": { "type": "boolean" },
                    "reason": { "type": "string" },
                    "evidence_ids": { "type": "array", "items": { "type": "string" } }
                }
            }
        }
    });
    sanitize(&schema)
}

/// Field notes for the model, appended to the rules: the output schema is smaller than the field list above.
pub const OUTPUT_NOTE: &str = "Output fields, exactly as the output schema names them: evidence items carry the segment_id of the line they quote (or \"board\") instead of times and speaker; competencies carry id, score, rationale and evidence_ids; the weakest moment carries the segment_id of the line where the question was asked instead of a time, and retry only its prompt. Fill every field; use an empty string or an empty list when there is nothing to say.";

fn remove_props(schema: &mut Value, names: &[&str]) {
    if let Some(p) = schema.get_mut("properties").and_then(Value::as_object_mut) {
        for n in names {
            p.remove(*n);
        }
    }
}

fn details_variant(report_schema: &Value, kind: &str) -> Value {
    let variants = report_schema["properties"]["round_details"]["oneOf"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    for v in variants {
        let v = match v.get("$ref").and_then(Value::as_str) {
            Some(r) => r
                .strip_prefix("#/")
                .map(|p| {
                    report_schema
                        .pointer(&format!("/{p}"))
                        .cloned()
                        .unwrap_or(Value::Null)
                })
                .unwrap_or(Value::Null),
            None => v,
        };
        let k = &v["properties"]["kind"];
        let matches = k.get("const").and_then(Value::as_str) == Some(kind)
            || k.get("enum")
                .and_then(Value::as_array)
                .is_some_and(|e| e.iter().any(|x| x.as_str() == Some(kind)));
        if matches {
            return v;
        }
    }
    json!({ "type": "object", "additionalProperties": false, "required": ["kind"], "properties": {} })
}

/// Keeps only what structured outputs accept: no length, count or range limits, no defaults or formats,
/// `oneOf` as `anyOf`, `type: [x, "null"]` as `anyOf`, and `additionalProperties: false` on every object.
/// Every property is required: optional properties multiply the size of the compiled grammar (the API refuses
/// it), so the model fills every field and leaves the ones it has nothing for empty.
pub fn sanitize(node: &Value) -> Value {
    let Value::Object(m) = node else {
        return match node {
            Value::Array(a) => Value::Array(a.iter().map(sanitize).collect()),
            other => other.clone(),
        };
    };
    let mut out = Map::new();
    for (k, v) in m {
        match k.as_str() {
            "minItems" | "maxItems" | "maxLength" | "minLength" | "minimum" | "maximum"
            | "exclusiveMinimum" | "exclusiveMaximum" | "default" | "format" | "$schema"
            | "$id" | "title" | "uniqueItems" | "multipleOf" => {}
            "properties" => {
                let props = v
                    .as_object()
                    .map(|p| {
                        p.iter()
                            .map(|(name, s)| (name.clone(), sanitize(s)))
                            .collect()
                    })
                    .unwrap_or_default();
                out.insert(k.clone(), Value::Object(props));
            }
            "oneOf" | "anyOf" | "allOf" => {
                let key = if k == "oneOf" { "anyOf" } else { k.as_str() };
                out.insert(key.to_string(), sanitize(v));
            }
            _ => {
                out.insert(k.clone(), sanitize(v));
            }
        }
    }
    let is_object =
        out.get("type").and_then(Value::as_str) == Some("object") || out.contains_key("properties");
    if is_object && !out.contains_key("additionalProperties") {
        out.insert("additionalProperties".into(), Value::Bool(false));
    }
    if let Some(Value::Object(props)) = out.get("properties") {
        let all: Vec<Value> = props.keys().map(|k| Value::String(k.clone())).collect();
        out.insert("required".into(), Value::Array(all));
    }
    if let Some(Value::Array(types)) = out.get("type").cloned() {
        out.remove("type");
        let description = out.remove("description");
        let branches: Vec<Value> = types
            .iter()
            .map(|t| {
                if t.as_str() == Some("null") {
                    json!({ "type": "null" })
                } else {
                    let mut b = out.clone();
                    b.insert("type".into(), t.clone());
                    if t.as_str() != Some("object") {
                        b.remove("properties");
                        b.remove("required");
                        b.remove("additionalProperties");
                    }
                    Value::Object(b)
                }
            })
            .collect();
        let mut wrapped = Map::new();
        if let Some(d) = description {
            wrapped.insert("description".into(), d);
        }
        wrapped.insert("anyOf".into(), Value::Array(branches));
        return Value::Object(wrapped);
    }
    Value::Object(out)
}

// ---------- the model call ----------

/// Rough size of a full answer, for the progress bar.
const EXPECTED_CHARS: usize = 12_000;

async fn run_model(
    env: &ScoreEnv<'_>,
    session_id: &str,
    req: &MessagesRequest,
) -> anyhow::Result<(String, Usage)> {
    let call = async {
        let mut stream = env
            .llm
            .stream(req)
            .await
            .map_err(|e| anyhow!("scoring call failed: {e}"))?;
        let mut text = String::new();
        let mut last_pct = 20u8;
        while let Some(ev) = stream.next().await {
            match ev.map_err(|e| anyhow!("scoring stream failed: {e}"))? {
                StreamEvent::TextDelta(t) => {
                    text.push_str(&t);
                    let pct = 20 + (text.len().min(EXPECTED_CHARS) * 70 / EXPECTED_CHARS) as u8;
                    if pct >= last_pct + 10 {
                        last_pct = pct;
                        env.events.progress(session_id, "scoring", pct).await;
                    }
                }
                StreamEvent::Stop { reason, usage } => {
                    return match reason.as_str() {
                        "end_turn" | "stop_sequence" => Ok((text, usage)),
                        other => Err(anyhow!("scoring stopped early: {other}")),
                    };
                }
                _ => {}
            }
        }
        Err(anyhow!("scoring stream ended without a stop"))
    };
    tokio::time::timeout(env.timeout, call)
        .await
        .map_err(|_| anyhow!("scoring took longer than {} s", env.timeout.as_secs()))?
}

// ---------- assembling the report ----------

fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}

/// Cuts to at most `max` characters (the schema counts characters), on a word boundary when one is near.
pub fn clip(text: &str, max: usize) -> String {
    let text = text.trim();
    if text.chars().count() <= max {
        return text.to_string();
    }
    let cut: String = text.chars().take(max).collect();
    match cut.rfind(' ') {
        Some(i) if i > max / 2 => cut[..i].trim_end().to_string(),
        _ => cut,
    }
}

/// Lowercase letters and digits only, single spaces.
fn normalize(text: &str) -> String {
    text.to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// True when every piece of the quote (split at ellipses) appears in the text.
fn quote_in(quote: &str, text: &str) -> bool {
    let hay = normalize(text);
    let pieces: Vec<String> = quote
        .split("...")
        .flat_map(|p| p.split('…'))
        .map(normalize)
        .filter(|p| !p.is_empty())
        .collect();
    !pieces.is_empty() && pieces.iter().all(|p| hay.contains(p.as_str()))
}

fn level_label(score: Option<i64>) -> &'static str {
    match score {
        Some(1) => "below",
        Some(2) => "developing",
        Some(3) => "meets_bar",
        Some(4) => "above_bar",
        _ => "not_observed",
    }
}

fn ids_in(v: &Value, key: &str, valid: &HashSet<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    v.get(key)
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .filter(|id| valid.contains(*id) && seen.insert(id.to_string()))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn rubric_competencies(rubric: &Value) -> Vec<(String, String, f64)> {
    rubric["competencies"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|c| {
                    (
                        s(c, "id").to_string(),
                        s(c, "name").to_string(),
                        c.get("weight").and_then(Value::as_f64).unwrap_or(1.0),
                    )
                })
                .take(5)
                .collect()
        })
        .unwrap_or_default()
}

/// The full report from the model's part and our own: every evidence item checked against the transcript (its
/// quote must be there; its times come from the line), every score without valid evidence set to not observed,
/// and the verdict worked out by the fixed rule.
pub fn assemble(
    input: &ScoringInput,
    catalog: &Catalog,
    round: &RoundConfig,
    rubric: &Value,
    lines: &[Line],
    out: &Value,
    delivery: &DeliveryMetrics,
) -> Value {
    let comps = rubric_competencies(rubric);
    let comp_ids: HashSet<String> = comps.iter().map(|c| c.0.clone()).collect();
    let duration_ms = input.duration_sec.max(0) * 1000;

    // Evidence: keep only quotes we can find, with the times of the line they come from.
    let mut evidence = Vec::new();
    let mut valid: HashSet<String> = HashSet::new();
    for e in out["evidence"].as_array().cloned().unwrap_or_default() {
        let id = s(&e, "id").trim().to_string();
        let quote = s(&e, "quote");
        if id.is_empty() || quote.trim().is_empty() || valid.contains(&id) {
            continue;
        }
        let seg = s(&e, "segment_id");
        let line = lines
            .iter()
            .find(|l| l.id == seg && quote_in(quote, &l.text))
            .or_else(|| lines.iter().find(|l| quote_in(quote, &l.text)));
        let (start, end, speaker) = match line {
            Some(l) => (l.start_ms, l.end_ms, l.speaker.clone()),
            None => match &input.board_text {
                Some(board) if quote_in(quote, board) => {
                    // A board quote: the time of the last board op that wrote text the quote contains.
                    let t = input
                        .board_ops
                        .iter()
                        .rev()
                        .filter(|op| op.accepted != Some(false))
                        .find(|op| {
                            ["label", "text"].iter().any(|k| {
                                op.args
                                    .get(*k)
                                    .and_then(Value::as_str)
                                    .is_some_and(|l| !l.trim().is_empty() && quote_in(l, quote))
                            })
                        })
                        .and_then(|op| op.t_ms)
                        .unwrap_or(0)
                        .clamp(0, duration_ms.max(0));
                    (t, t, "user".to_string())
                }
                _ => {
                    tracing::warn!(session_id = %input.session_id, evidence = %id, "evidence quote not found in the transcript; dropped");
                    continue;
                }
            },
        };
        let polarity = match s(&e, "polarity") {
            p @ ("positive" | "negative" | "neutral") => p,
            _ => "neutral",
        };
        let competency_ids: Vec<String> = ids_in(&e, "competency_ids", &comp_ids);
        let mut item = json!({
            "id": id,
            "t_start_sec": round1(start as f64 / 1000.0),
            "t_end_sec": round1(end as f64 / 1000.0),
            "speaker": speaker,
            "quote": clip(quote, 400),
            "polarity": polarity,
            "competency_ids": competency_ids,
        });
        let note = s(&e, "note");
        if !note.trim().is_empty() {
            item["note"] = json!(clip(note, 200));
        }
        valid.insert(id);
        evidence.push(item);
    }

    // Competencies, in rubric order, each score backed by evidence or null.
    let model_comps = out["competencies"].as_array().cloned().unwrap_or_default();
    let mut competencies = Vec::new();
    let mut scores: Vec<Option<f32>> = Vec::new();
    let mut min_evidence = usize::MAX;
    for (id, name, weight) in &comps {
        let mc = model_comps.iter().find(|c| s(c, "id") == id);
        let evidence_ids = mc
            .map(|c| ids_in(c, "evidence_ids", &valid))
            .unwrap_or_default();
        let score = mc
            .and_then(|c| c.get("score"))
            .and_then(Value::as_f64)
            .map(|x| x.round().clamp(1.0, 4.0) as i64)
            .filter(|_| !evidence_ids.is_empty());
        let rationale = match (score, mc) {
            (Some(_), Some(c)) if !s(c, "rationale").trim().is_empty() => {
                clip(s(c, "rationale"), 300)
            }
            (Some(_), _) => String::new(),
            (None, _) => NOT_OBSERVED.to_string(),
        };
        let backing = evidence
            .iter()
            .filter(|e| {
                let eid = s(e, "id");
                evidence_ids.iter().any(|x| x == eid)
                    || e["competency_ids"]
                        .as_array()
                        .is_some_and(|a| a.iter().any(|c| c.as_str() == Some(id)))
            })
            .count();
        min_evidence = min_evidence.min(backing);
        let delta = score.and_then(|sc| {
            input
                .last_scores
                .get(id)
                .map(|last| round2(sc as f64 - last))
        });
        competencies.push(json!({
            "id": id,
            "name": name,
            "score": score,
            "level_label": level_label(score),
            "weight": weight,
            "rationale": rationale,
            "evidence_ids": if score.is_some() { evidence_ids } else { Vec::new() },
            "delta_vs_last": delta,
        }));
        scores.push(score.map(|x| x as f32));
    }
    if comps.is_empty() {
        min_evidence = 0;
    }

    let points = |key: &str| -> Vec<Value> {
        out[key]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .filter_map(|p| {
                let ids = ids_in(p, "evidence_ids", &valid);
                let title = clip(s(p, "title"), 60);
                if ids.is_empty() || title.is_empty() {
                    return None;
                }
                Some(json!({ "title": title, "detail": clip(s(p, "detail"), 240), "evidence_ids": ids }))
            })
            .take(3)
            .collect()
    };
    let strengths = points("strengths");
    let weaknesses = points("weaknesses");

    let red_flag = out["red_flag"]["present"].as_bool().unwrap_or(false)
        && !ids_in(&out["red_flag"], "evidence_ids", &valid).is_empty();
    if red_flag {
        tracing::info!(session_id = %input.session_id, reason = s(&out["red_flag"], "reason"), "red flag");
    }

    let mode = input.mode_enum();
    let length = Length::parse(&input.length);
    let (verdict, confidence) = verdict::decide(
        &scores,
        red_flag,
        coverage_pct(input, round),
        length,
        mode,
        min_evidence,
    );
    let verdict_json = verdict.map(|v| {
        json!({
            "label": v.label(),
            "index": v.index(),
            "is_provisional": length == Length::Short,
            "confidence": confidence.as_str(),
        })
    });
    let mut summary = clip(s(&out["headline"], "summary"), 140);
    if summary.is_empty() {
        summary = "Your scorecard is ready.".to_string();
    }

    let mut report = json!({
        "schema_version": "1.0",
        "session": session_json(input, round),
        "headline": {
            "summary": summary,
            "verdict": verdict_json,
            "overall_score": verdict::overall(&scores),
        },
        "competencies": competencies,
        "evidence": evidence,
        "strengths": strengths,
        "weaknesses": weaknesses,
        "weakest_moment": weakest_moment(&out["weakest_moment"], lines),
        "next_drills": next_drills(&out["next_drills"], catalog, round),
        "delivery": delivery,
    });
    if let Some(details) = round_details(input, round, &out["round_details"], &valid) {
        report["round_details"] = details;
    }
    report
}

fn weakest_moment(w: &Value, lines: &[Line]) -> Value {
    if !w.is_object() {
        return Value::Null;
    }
    let covers: Vec<String> = w["strong_answer_covers"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|x| !x.is_empty())
                .map(str::to_string)
                .take(6)
                .collect()
        })
        .unwrap_or_default();
    let question = s(w, "question").trim();
    let answer = s(w, "model_answer").trim();
    if covers.len() < 2 || question.is_empty() || answer.is_empty() {
        return Value::Null;
    }
    // When the question was asked: the cited line, else the line that contains the question.
    let seg = s(w, "segment_id");
    let t_ms = lines
        .iter()
        .find(|l| l.id == seg)
        .or_else(|| lines.iter().find(|l| quote_in(question, &l.text)))
        .map(|l| l.start_ms)
        .unwrap_or(0);
    let mut out = json!({
        "question": question,
        "t_start_sec": round1(t_ms as f64 / 1000.0),
        "what_happened": clip(s(w, "what_happened"), 300),
        "strong_answer_covers": covers,
        "model_answer": clip(answer, 900),
    });
    let prompt = s(&w["retry"], "prompt").trim();
    if !prompt.is_empty() {
        out["retry"] = json!({ "prompt": prompt, "max_seconds": 120 });
    }
    out
}

/// The short version of a round (itself when it is short).
fn short_round<'a>(catalog: &'a Catalog, round: &'a RoundConfig) -> &'a RoundConfig {
    if round.length == "short" {
        return round;
    }
    round
        .short_version
        .as_deref()
        .and_then(|id| catalog.round(id))
        .unwrap_or(round)
}

fn default_drill(catalog: &Catalog, round: &RoundConfig) -> Value {
    let short = short_round(catalog, round);
    json!({
        "title": "Run the short round again",
        "why": "Give two or three full answers so there is enough to score.",
        "kind": "short_round",
        "round_type": short.round_type,
        "round_id": short.id,
        "est_minutes": short.target_minutes.round().max(1.0) as i64,
    })
}

fn next_drills(v: &Value, catalog: &Catalog, round: &RoundConfig) -> Vec<Value> {
    let mut drills: Vec<Value> = v
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(|d| {
            let kind = s(d, "kind");
            if !matches!(
                kind,
                "retry_answer" | "short_round" | "full_round" | "meeting" | "concept_review"
            ) {
                return None;
            }
            let title = clip(s(d, "title"), 80);
            if title.is_empty() {
                return None;
            }
            let mut out = json!({
                "title": title,
                "why": clip(s(d, "why"), 200),
                "kind": kind,
                "est_minutes": d["est_minutes"].as_i64().filter(|n| *n > 0).unwrap_or(5),
            });
            let rid = s(d, "round_id");
            let chosen = match catalog.round(rid) {
                Some(r) => Some(r),
                None if kind == "short_round" => Some(short_round(catalog, round)),
                None if kind == "full_round" => round
                    .full_version
                    .as_deref()
                    .and_then(|id| catalog.round(id))
                    .or(if round.length == "full" {
                        Some(round)
                    } else {
                        None
                    }),
                None => None,
            };
            if let Some(r) = chosen {
                out["round_id"] = json!(r.id);
                out["round_type"] = json!(r.round_type);
            } else if !s(d, "round_type").is_empty() {
                out["round_type"] = json!(s(d, "round_type"));
            }
            let qid = s(d, "question_id");
            if !qid.is_empty() {
                out["question_id"] = json!(qid);
            }
            Some(out)
        })
        .take(3)
        .collect();
    if drills.is_empty() {
        drills.push(default_drill(catalog, round));
    }
    drills
}

fn round_details(
    input: &ScoringInput,
    round: &RoundConfig,
    v: &Value,
    valid: &HashSet<String>,
) -> Option<Value> {
    let kind = details_kind(&round.round_type);
    let mut d = v.as_object().cloned().unwrap_or_default();
    // The model fills every field; drop the ones it left empty.
    d.retain(|_, x| !matches!(x, Value::String(s) if s.trim().is_empty()));
    d.insert("kind".into(), json!(kind));
    match kind {
        "system_design" | "object_design" => {
            d.remove("board_image_url");
            if let Some(t) = input.board_text.as_ref().filter(|t| !t.trim().is_empty()) {
                d.insert("board_as_text".into(), json!(t));
            }
        }
        "meeting" => {
            let template = input
                .meeting_template
                .clone()
                .unwrap_or_else(|| "custom".into());
            d.insert("template".into(), json!(template));
            let quote_id = d
                .get("decision_quote_id")
                .and_then(Value::as_str)
                .map(str::to_string);
            if quote_id.is_some_and(|q| !valid.contains(&q)) {
                d.remove("decision_quote_id");
            }
            if let Some(attendees) = d.get_mut("attendees").and_then(Value::as_array_mut) {
                for a in attendees {
                    if let Some(concerns) = a.get_mut("concerns").and_then(Value::as_array_mut) {
                        for c in concerns {
                            let ids = ids_in(c, "evidence_ids", valid);
                            c["evidence_ids"] = json!(ids);
                        }
                    }
                }
            }
            if let Some(objections) = d.get_mut("objections").and_then(Value::as_array_mut) {
                for o in objections {
                    if let Some(b) = o.get("better_response").and_then(Value::as_str) {
                        let b = clip(b, 400);
                        o["better_response"] = json!(b);
                    }
                }
            }
        }
        _ => {}
    }
    Some(Value::Object(d))
}

pub fn session_json(input: &ScoringInput, round: &RoundConfig) -> Value {
    let planned: Vec<String> = round.phases.iter().map(|p| p.id.clone()).collect();
    let completed: Vec<String> = planned
        .iter()
        .filter(|p| input.phases_completed.iter().any(|c| c == *p))
        .cloned()
        .collect();
    let mut session = json!({
        "id": input.session_id,
        "mode": input.mode,
        "role": match round.role.as_str() { r @ ("sde" | "pm") => r, _ => "none" },
        "round_id": round.id,
        "round_type": round.round_type,
        "length": if input.length == "full" { "full" } else { "short" },
        "seniority": input.seniority(),
        "difficulty": input.difficulty(),
        "personas": input.panel.iter().map(|p| p.persona_id.clone()).collect::<Vec<_>>(),
        "duration_sec": input.duration_sec.max(0),
        "ended_by": input.ended_by(),
        "coverage": {
            "phases_planned": planned,
            "phases_completed": completed,
            "pct": round2(coverage_pct(input, round) as f64),
        },
    });
    if let Some(q) = &input.question_id {
        session["question_id"] = json!(q);
    }
    if let Some(t) = input.started_at {
        session["started_at"] = json!(t.to_rfc3339_opts(chrono::SecondsFormat::Secs, true));
    }
    session
}

/// The report when the candidate said too little: delivery stats, every competency not observed, no verdict, and
/// one drill to try again. No model call.
pub fn low_signal_report(
    input: &ScoringInput,
    catalog: &Catalog,
    round: &RoundConfig,
    rubric: &Value,
    delivery: &DeliveryMetrics,
) -> Value {
    let competencies: Vec<Value> = rubric_competencies(rubric)
        .into_iter()
        .map(|(id, name, weight)| {
            json!({
                "id": id,
                "name": name,
                "score": null,
                "level_label": "not_observed",
                "weight": weight,
                "rationale": NOT_OBSERVED,
                "evidence_ids": [],
                "delta_vs_last": null,
            })
        })
        .collect();
    json!({
        "schema_version": "1.0",
        "session": session_json(input, round),
        "headline": { "summary": NOT_ENOUGH_SIGNAL, "verdict": null, "overall_score": null },
        "competencies": competencies,
        "evidence": [],
        "strengths": [],
        "weaknesses": [],
        "weakest_moment": null,
        "next_drills": [default_drill(catalog, round)],
        "delivery": delivery,
    })
}

/// Previous scores by competency id, from an earlier report.
pub fn scores_of(report: &Value) -> HashMap<String, f64> {
    report["competencies"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|c| Some((s(c, "id").to_string(), c.get("score")?.as_f64()?)))
                .collect()
        })
        .unwrap_or_default()
}

fn round1(x: f64) -> f64 {
    (x * 10.0).round() / 10.0
}

fn round2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}
