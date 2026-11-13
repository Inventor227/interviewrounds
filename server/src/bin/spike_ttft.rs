//! Measures time to first spoken text of the live voice turn against the real model API, for several models, tool
//! setups and prompt sizes, with the prompt cache warm and a realistic 20-turn history. Also checks how well a fast
//! "director" call turns a spoken line into tool actions.
//!
//!   ANTHROPIC_API_KEY=... ANTHROPIC_WORKSPACE_ID=... \
//!     cargo run --release --bin spike_ttft -- --content ../content [--calls 10] [--only haiku] [--director]
//!
//! Each variant replays a live session: one warm-up turn (writes the cache), then `--calls` measured turns. Every
//! turn adds a new candidate line, so like a real session only the last reply, the new user line and the turn note
//! are uncached. Prints one line per call and a p50/p90 table at the end. Costs a few cents of model usage.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use anyhow::{Context, bail};
use futures::StreamExt;
use ir_server::claude::{ClaudeClient, ContentBlock, MessagesRequest, StreamEvent, SystemBlock};
use ir_server::content::Catalog;
use ir_server::orchestrator::director;
use ir_server::orchestrator::markers::{EventKind, UserInput};
use ir_server::orchestrator::prompt::{draft_turn, prepare_live_turn};
use ir_server::orchestrator::tools;
use ir_server::orchestrator::{
    Level, LiveSettings, Mode, NewSession, SessionSettings, SessionState, Style, TurnCommit,
    VoiceKind,
};

const HISTORY: [(&str, &str); 20] = [
    (
        "Hi, yeah, I can hear you fine.",
        "Great to meet you. I'm Daniel. Ana will join us later. Today we'll design a system together, about thirty minutes.",
    ),
    (
        "Sounds good.",
        "Design the ticketing system for a stadium concert: sixty thousand seats, and about three million fans trying to buy the moment sales open at ten.",
    ),
    (
        "Okay, so first, are seats assigned or general admission?",
        "Assigned seating. Fans pick seats, then pay.",
    ),
    (
        "And how long do they get to pay once they pick a seat?",
        "A seat hold lasts eight minutes while the fan pays.",
    ),
    (
        "Got it. And is there a limit per person?",
        "At most four tickets per account.",
    ),
    (
        "So the core flows are browse the seat map, hold seats, pay, and get a confirmation. Non functional, I'd say we can never oversell, and the seat map can be a bit stale.",
        "Okay. What load are you designing for?",
    ),
    (
        "Three million fans in the first couple of minutes, so maybe twenty five thousand requests a second on reads, and writes are bounded by sixty thousand seats.",
        "Mm-hm. Walk me through the main calls.",
    ),
    (
        "Get event, get seat map, post hold with seat ids, post payment with the hold id, and a callback from the payment provider.",
        "Got it. What are the core entities?",
    ),
    (
        "Event, seat, hold, order, and payment. A hold has an expiry.",
        "Okay. Let's move on to the high level design. Go ahead and draw.",
    ),
    (
        "So the client hits a gateway, then a waiting room service that admits people in batches, then the booking service, which talks to a seat store.",
        "Walk me through one hold request end to end.",
    ),
    (
        "The fan picks a seat, the booking service does a conditional write on the seat row, free to held with an expiry, and returns the hold id.",
        "You said conditional write. Where does that run?",
    ),
    (
        "In Postgres, with a single update where status equals free, so only one writer wins.",
        "Okay. And the seat map reads?",
    ),
    (
        "Those come from a Redis cache that the booking service updates after each hold, with a short TTL as a fallback.",
        "You drew the cache next to the seat map. What's in it, exactly?",
    ),
    (
        "Per section, a bitmap of seat status, so the client can render the map fast.",
        "Got it. What does the fan see while they wait to get in?",
    ),
    (
        "A queue position and an estimate, from the waiting room, polled every few seconds.",
        "Okay. How do you decide how many to admit?",
    ),
    (
        "Based on booking service capacity, maybe two thousand holds a second, adjusted by error rates.",
        "Mm-hm. What happens to a hold when payment fails?",
    ),
    (
        "The callback marks the order failed and releases the hold, and a sweeper releases expired holds too.",
        "Right. The payment callback arrives twice. What happens?",
    ),
    (
        "We key it by order id, so the second one is a no op.",
        "Okay. Let's go deeper. Where would you go deeper?",
    ),
    (
        "I'd look at the hot partition, since one event gets all the traffic on one table.",
        "Go on.",
    ),
    (
        "We could shard seats by section, so writes spread over many partitions.",
        "Okay. What happens when one section is far hotter than the rest?",
    ),
];

/// New candidate lines for the measured turns (one per call, never repeated within a variant).
const PROBES: [&str; 14] = [
    "If a whole section's partition goes down, I'd fail those holds fast and show the section as unavailable.",
    "For bots, I'd put a challenge at the waiting room and rate limit per account and per device.",
    "The waiting room itself can be a static page on a CDN with a token, so it scales easily.",
    "I think the cache could be rebuilt from the database in a few seconds if we lose it.",
    "Retries from the client would carry an idempotency key, so a double click doesn't make two holds.",
    "Hmm, let me think about that for a second. I guess the sweeper could run every ten seconds.",
    "We'd monitor hold success rate and queue drain rate, and page on oversell checks.",
    "Payments are the slow part, one to five seconds, so the hold has to outlive that.",
    "If the seat map service times out, the client could fall back to best available instead of picking seats.",
    "I'd keep the order table separate from seats, so reporting doesn't hit the hot rows.",
    "So, um, for a region failure, we'd run active passive with the database replicated.",
    "One thing I'm not sure about is whether the hold should be in Redis or Postgres.",
    "Each section shard would have its own queue of pending holds.",
    "I think that covers the failure side, unless you want me to go into the payment provider.",
];

const BOARD: &str = "[Board update 12]\nItems: n1 Client, n2 API gateway, n3 Waiting room, n4 Booking service, n5 Seat store (Postgres), n6 Seat map cache (Redis), n7 Payment provider, n8 Sweeper.\nLinks: c1 n1->n2, c2 n2->n3, c3 n3->n4, c4 n4->n5 \"conditional write\", c5 n4->n6 \"update\", c6 n4->n7, c7 n7->n4 \"callback\", c8 n8->n5.\nChanged: n8 added, c8 added.";

#[derive(Clone, Copy, Debug, PartialEq)]
enum Tools {
    Strict,
    Loose,
    None,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Prompt {
    Full,
    Trimmed,
}

#[derive(Clone, Debug)]
struct Variant {
    model: &'static str,
    tools: Tools,
    prompt: Prompt,
}

impl Variant {
    fn name(&self) -> String {
        let short = self
            .model
            .trim_start_matches("claude-")
            .trim_end_matches("-5-5");
        format!(
            "{short}/{}/{}",
            match self.tools {
                Tools::Strict => "tools-strict",
                Tools::Loose => "tools-loose",
                Tools::None => "no-tools",
            },
            match self.prompt {
                Prompt::Full => "full",
                Prompt::Trimmed => "trimmed",
            }
        )
    }
}

#[derive(Clone, Debug)]
struct Sample {
    headers_ms: u64,
    first_text_ms: Option<u64>,
    first_any_ms: Option<u64>,
    total_ms: u64,
    stop: String,
    cache_read: u64,
    cache_write: u64,
    uncached: u64,
    output: u64,
    text: String,
    tool_names: Vec<String>,
}

struct Args {
    content: PathBuf,
    round: String,
    calls: usize,
    only: Vec<String>,
    director: bool,
    ttft: bool,
}

fn parse_args() -> anyhow::Result<Args> {
    let mut args = Args {
        content: PathBuf::from("content"),
        round: "sde.system_design.full".into(),
        calls: 10,
        only: Vec::new(),
        director: false,
        ttft: true,
    };
    let mut it = std::env::args().skip(1);
    while let Some(a) = it.next() {
        match a.as_str() {
            "--content" => args.content = it.next().context("--content needs a path")?.into(),
            "--round" => args.round = it.next().context("--round needs an id")?,
            "--calls" => args.calls = it.next().context("--calls needs a number")?.parse()?,
            "--only" => args.only.push(it.next().context("--only needs a filter")?),
            "--director" => args.director = true,
            "--director-only" => {
                args.director = true;
                args.ttft = false;
            }
            other => bail!("unknown argument {other}"),
        }
    }
    Ok(args)
}

fn new_state(catalog: &Catalog, round: &str, model: &str) -> anyhow::Result<SessionState> {
    let mut state = SessionState::new(
        NewSession {
            id: "spike".into(),
            identity_id: "spike".into(),
            mode: Mode::Interview,
            round_id: round.into(),
            settings: SessionSettings {
                level: Level::Senior,
                style: Style::Neutral,
                voice: VoiceKind::Fish,
            },
            panel: Vec::new(),
            question_id: None,
            meeting: None,
        },
        catalog,
        LiveSettings {
            model: model.into(),
            fast_model: model.into(),
            effort: "low".into(),
            max_tokens: 300,
        },
        Instant::now(),
    )?;
    state.board_text = BOARD.into();
    Ok(state)
}

/// Plays the canned 20 turns into the history, through the same draft and commit path a live session uses.
fn fill_history(state: &mut SessionState) {
    // Pretend the round started 14 minutes ago and we are in the hld/deep dive part.
    state.started_at = Instant::now() - Duration::from_secs(14 * 60);
    state.phase_idx = 3.min(state.round.phases.len() - 1);
    for (user, agent) in HISTORY {
        commit_text(state, &UserInput::Speech(user.into()), agent);
    }
}

fn commit_text(state: &mut SessionState, input: &UserInput, reply: &str) {
    let floor = state.floor.clone();
    let draft = draft_turn(state, &floor, input, Instant::now());
    state.commit_turn(
        TurnCommit {
            draft,
            extra: Vec::new(),
            reply: vec![ContentBlock::text(reply)],
            spoken: reply.to_string(),
            tool_calls: Vec::new(),
            handover_line_used: false,
        },
        Instant::now(),
    );
}

fn trimmed(system: &str) -> String {
    // Keeps the persona and the spoken-words rules plus the round script; drops the long shared rule sections.
    let cut_from = system.find("Silence and pace").unwrap_or(system.len());
    let script_at = system.find("Level\n").unwrap_or(system.len());
    format!("{}\n\n{}", &system[..cut_from], &system[script_at..])
}

fn shape_request(req: &mut MessagesRequest, v: &Variant) {
    match v.tools {
        Tools::Strict => {}
        Tools::Loose => req.tools.iter_mut().for_each(|t| t.strict = None),
        Tools::None => {
            req.tools.clear();
            req.tool_choice = None;
            req.system
                .push(SystemBlock::text(director::SPEAK_ONLY_NOTE));
        }
    }
    if v.prompt == Prompt::Trimmed
        && let Some(first) = req.system.first_mut()
    {
        first.text = trimmed(&first.text);
    }
}

async fn timed_call(client: &ClaudeClient, req: &MessagesRequest) -> anyhow::Result<Sample> {
    let t0 = Instant::now();
    let mut events = client
        .stream(req)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    let headers_ms = t0.elapsed().as_millis() as u64;
    let mut s = Sample {
        headers_ms,
        first_text_ms: None,
        first_any_ms: None,
        total_ms: 0,
        stop: String::new(),
        cache_read: 0,
        cache_write: 0,
        uncached: 0,
        output: 0,
        text: String::new(),
        tool_names: Vec::new(),
    };
    while let Some(ev) = events.next().await {
        let ev = ev.map_err(|e| anyhow::anyhow!("{e}"))?;
        let at = t0.elapsed().as_millis() as u64;
        match ev {
            StreamEvent::TextDelta(t) => {
                if !t.trim().is_empty() {
                    s.first_text_ms.get_or_insert(at);
                    s.first_any_ms.get_or_insert(at);
                }
                s.text.push_str(&t);
            }
            StreamEvent::ToolUse { name, .. } => {
                s.first_any_ms.get_or_insert(at);
                s.tool_names.push(name);
            }
            StreamEvent::Block(_) => {}
            StreamEvent::Stop { reason, usage } => {
                s.stop = reason;
                s.cache_read = usage.cache_read_input_tokens;
                s.cache_write = usage.cache_creation_input_tokens;
                s.uncached = usage.input_tokens;
                s.output = usage.output_tokens;
            }
        }
    }
    s.total_ms = t0.elapsed().as_millis() as u64;
    Ok(s)
}

fn pct(sorted: &[u64], p: f64) -> u64 {
    if sorted.is_empty() {
        return 0;
    }
    let idx = ((sorted.len() as f64 - 1.0) * p).round() as usize;
    sorted[idx.min(sorted.len() - 1)]
}

async fn run_variant(
    client: &ClaudeClient,
    catalog: &Catalog,
    args: &Args,
    v: &Variant,
) -> anyhow::Result<Vec<Sample>> {
    let mut state = new_state(catalog, &args.round, v.model)?;
    fill_history(&mut state);
    let mut out = Vec::new();
    for i in 0..=args.calls {
        let probe = PROBES[i % PROBES.len()];
        let input = UserInput::Speech(probe.into());
        let floor = state.floor.clone();
        let (mut req, _draft) = prepare_live_turn(&state, &floor, &input, Instant::now());
        shape_request(&mut req, v);
        let s = match timed_call(client, &req).await {
            Ok(s) => s,
            Err(e) => {
                eprintln!("{:<32} call {i:>2} ERROR {e}", v.name());
                commit_text(&mut state, &input, "Okay. Go on.");
                continue;
            }
        };
        let label = if i == 0 {
            "warm".to_string()
        } else {
            format!("{i:>4}")
        };
        eprintln!(
            "{:<32} {label} hdr {:>5} text {:>5} any {:>5} total {:>5} | {:<8} cache r{:>5} w{:>5} in{:>5} out{:>4} | tools {:?} | {}",
            v.name(),
            s.headers_ms,
            s.first_text_ms.map(|t| t.to_string()).unwrap_or("-".into()),
            s.first_any_ms.map(|t| t.to_string()).unwrap_or("-".into()),
            s.total_ms,
            s.stop,
            s.cache_read,
            s.cache_write,
            s.uncached,
            s.output,
            s.tool_names,
            s.text
                .replace('\n', " ")
                .chars()
                .take(110)
                .collect::<String>()
        );
        let reply = if s.text.trim().is_empty() {
            "Okay. Go on."
        } else {
            s.text.trim()
        };
        commit_text(&mut state, &input, reply);
        if i > 0 {
            out.push(s);
        }
    }
    Ok(out)
}

fn summarise(name: &str, samples: &[Sample]) -> String {
    let mut text: Vec<u64> = samples.iter().filter_map(|s| s.first_text_ms).collect();
    let mut any: Vec<u64> = samples.iter().filter_map(|s| s.first_any_ms).collect();
    let mut hdr: Vec<u64> = samples.iter().map(|s| s.headers_ms).collect();
    let mut total: Vec<u64> = samples.iter().map(|s| s.total_ms).collect();
    text.sort_unstable();
    any.sort_unstable();
    hdr.sort_unstable();
    total.sort_unstable();
    let tool_first = samples
        .iter()
        .filter(|s| s.first_text_ms.is_none() || s.first_any_ms < s.first_text_ms)
        .count();
    let cache_read: u64 =
        samples.iter().map(|s| s.cache_read).sum::<u64>() / samples.len().max(1) as u64;
    let uncached: u64 = samples
        .iter()
        .map(|s| s.uncached + s.cache_write)
        .sum::<u64>()
        / samples.len().max(1) as u64;
    format!(
        "| {name:<32} | {:>2} | {:>5} | {:>5} | {:>5} | {:>5} | {:>5} | {:>5} | {:>2} | {:>5} | {:>4} |",
        samples.len(),
        pct(&hdr, 0.5),
        pct(&text, 0.5),
        pct(&text, 0.9),
        pct(&any, 0.5),
        pct(&total, 0.5),
        pct(&total, 0.9),
        tool_first,
        cache_read,
        uncached
    )
}

struct Scenario {
    name: &'static str,
    input: UserInput,
    reply: &'static str,
    /// Expected tool names (order ignored); empty = no tool.
    expect: &'static [&'static str],
    /// Extra tools that are acceptable too (point_at and give_hint extras are always tolerated).
    allow: &'static [&'static str],
    setup: fn(&mut SessionState),
}

fn early(state: &mut SessionState) {
    state.history.clear();
    state.turns.clear();
    state.phase_idx = 0;
    state.started_at = Instant::now();
    state.board_text.clear();
}

fn boundary(state: &mut SessionState) {
    // The api phase ran over: elapsed past its end.
    state.phase_idx = 2;
    state.started_at = Instant::now() - Duration::from_secs(11 * 60);
}

fn mid(_state: &mut SessionState) {}

fn deep_dive(state: &mut SessionState) {
    state.phase_idx = 4.min(state.round.phases.len() - 1);
}

fn ending(state: &mut SessionState) {
    state.phase_idx = state.round.phases.len() - 1;
    state.started_at = Instant::now() - Duration::from_secs(31 * 60);
}

fn scenarios() -> Vec<Scenario> {
    vec![
        Scenario {
            name: "start states problem",
            input: UserInput::Event(EventKind::Start),
            reply: "Hi, I'm Daniel. Ana is joining us and will jump in later. Here's the problem: design the ticketing system for a stadium concert, sixty thousand seats, and about three million fans trying to buy the moment sales open at ten in the morning.",
            expect: &["show_question"],
            allow: &["next_phase"],
            setup: early,
        },
        Scenario {
            name: "phase transition",
            input: UserInput::Speech(
                "And the hold call returns a hold id and an expiry time.".into(),
            ),
            reply: "Okay. Let's move on to the high level design.",
            expect: &["next_phase"],
            allow: &[],
            setup: boundary,
        },
        Scenario {
            name: "plain follow-up",
            input: UserInput::Speech(
                "The booking service writes the hold to Postgres with a conditional update.".into(),
            ),
            reply: "You said conditional update. What happens when two fans hit the same seat at the same moment?",
            expect: &[],
            allow: &[],
            setup: mid,
        },
        Scenario {
            name: "hint",
            input: UserInput::Speech(
                "Hmm, I'm not sure how to stop the sweeper and the payment callback from racing."
                    .into(),
            ),
            reply: "Think about what both of them change on the hold. What would each need to check before writing?",
            expect: &["give_hint"],
            allow: &[],
            setup: mid,
        },
        Scenario {
            name: "point at cache",
            input: UserInput::Speech(
                "Reads go through the cache and writes go to Postgres.".into(),
            ),
            reply: "This seat map cache here. What happens to reads if it loses a node at peak?",
            expect: &["point_at"],
            allow: &[],
            setup: mid,
        },
        Scenario {
            name: "hand over",
            input: UserInput::Speech(
                "I'd shard by section so the writes spread out across partitions.".into(),
            ),
            reply: "Ana, you had some questions here?",
            expect: &["hand_over"],
            allow: &[],
            setup: deep_dive,
        },
        Scenario {
            name: "ending",
            input: UserInput::Event(EventKind::Ending),
            reply: "That's time. Thanks for designing this with us. Your scorecard is coming up.",
            expect: &["end_round"],
            allow: &[],
            setup: ending,
        },
        Scenario {
            name: "fact added to brief",
            input: UserInput::Speech(
                "How long does a fan get to pay once they hold a seat?".into(),
            ),
            reply: "A seat hold lasts eight minutes while the fan pays.",
            expect: &["show_question"],
            allow: &[],
            setup: early_with_problem,
        },
    ]
}

fn early_with_problem(state: &mut SessionState) {
    early(state);
    state.phase_idx = 1;
    commit_text(
        state,
        &UserInput::Event(EventKind::Start),
        "Hi, I'm Daniel. Here's the problem: design the ticketing system for a stadium concert, sixty thousand seats, and about three million fans trying to buy the moment sales open at ten in the morning.",
    );
    state.brief = Some(ir_server::orchestrator::Brief {
        question: "Ticketing for a stadium concert".into(),
        lines: vec![
            "60,000 seats, assigned seating".into(),
            "About 3 million fans at 10:00".into(),
            "Fans pick seats, then pay".into(),
        ],
    });
}

async fn run_director(
    client: &ClaudeClient,
    catalog: &Catalog,
    args: &Args,
    model: &str,
    repeats: usize,
) -> anyhow::Result<(usize, usize, Vec<u64>)> {
    let mut ok = 0;
    let mut n = 0;
    let mut times = Vec::new();
    for sc in scenarios() {
        for r in 0..repeats {
            let mut state = new_state(catalog, &args.round, model)?;
            fill_history(&mut state);
            (sc.setup)(&mut state);
            let floor = state.floor.clone();
            let (_live_req, draft) = prepare_live_turn(&state, &floor, &sc.input, Instant::now());
            let req = director::build_request(&state, &floor, &draft, sc.reply, model);
            let t0 = Instant::now();
            let res = client.create(&req).await;
            let ms = t0.elapsed().as_millis() as u64;
            let (names, detail) = match res {
                Ok(resp) => {
                    let calls: Vec<(String, serde_json::Value)> = resp
                        .content
                        .iter()
                        .filter_map(|b| match b {
                            ContentBlock::ToolUse { name, input, .. } => {
                                Some((name.clone(), input.clone()))
                            }
                            _ => None,
                        })
                        .collect();
                    let names: Vec<String> = calls.iter().map(|c| c.0.clone()).collect();
                    let detail = format!(
                        "{} | cache r{} w{} in{} out{} | text {:?}",
                        serde_json::to_string(&calls).unwrap_or_default(),
                        resp.usage.cache_read_input_tokens,
                        resp.usage.cache_creation_input_tokens,
                        resp.usage.input_tokens,
                        resp.usage.output_tokens,
                        resp.text().chars().take(80).collect::<String>()
                    );
                    (names, detail)
                }
                Err(e) => (vec!["<error>".into()], e.to_string()),
            };
            let pass = sc.expect.iter().all(|e| names.iter().any(|n| n == e))
                && names.iter().all(|n| {
                    sc.expect.contains(&n.as_str())
                        || sc.allow.contains(&n.as_str())
                        || matches!(n.as_str(), "point_at" | "give_hint")
                });
            n += 1;
            if pass {
                ok += 1;
            }
            if r > 0 || repeats == 1 {
                times.push(ms);
            }
            eprintln!(
                "director {model:<18} {:<22} #{r} {:>5} ms {} {}",
                sc.name,
                ms,
                if pass { "PASS" } else { "FAIL" },
                detail.chars().take(400).collect::<String>()
            );
        }
    }
    Ok((ok, n, times))
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = parse_args()?;
    let key = std::env::var("ANTHROPIC_API_KEY").context("ANTHROPIC_API_KEY")?;
    let ws = std::env::var("ANTHROPIC_WORKSPACE_ID").context("ANTHROPIC_WORKSPACE_ID")?;
    let client = ClaudeClient::with_base_url(&key, &ws, ir_server::claude::DEFAULT_BASE_URL);
    let catalog = Catalog::load(&args.content)?;
    {
        let state = new_state(&catalog, &args.round, "claude-haiku-5-5")?;
        let sys = &state.panel[0].system[0].text;
        eprintln!(
            "content: round {} | system prompt {} chars (trimmed {} chars) | tools {}",
            args.round,
            sys.len(),
            trimmed(sys).len(),
            tools::definitions().len()
        );
    }

    if args.ttft {
        let mut variants = Vec::new();
        for model in ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"] {
            for tools in [Tools::Strict, Tools::Loose, Tools::None] {
                variants.push(Variant {
                    model,
                    tools,
                    prompt: Prompt::Full,
                });
            }
            for tools in [Tools::Strict, Tools::None] {
                variants.push(Variant {
                    model,
                    tools,
                    prompt: Prompt::Trimmed,
                });
            }
        }
        variants.retain(|v| {
            args.only.is_empty() || args.only.iter().any(|f| v.name().contains(f.as_str()))
        });
        let mut rows = Vec::new();
        for v in &variants {
            let samples = run_variant(&client, &catalog, &args, v).await?;
            let row = summarise(&v.name(), &samples);
            eprintln!("{row}");
            rows.push(row);
        }
        println!(
            "\n| variant | n | hdr p50 | text p50 | text p90 | any p50 | total p50 | total p90 | tool-first | cache read | uncached |"
        );
        println!("|---|---|---|---|---|---|---|---|---|---|---|");
        for r in rows {
            println!("{r}");
        }
    }

    if args.director {
        let mut rows = Vec::new();
        for model in ["claude-haiku-5-5", "claude-sonnet-5-5"] {
            if !args.only.is_empty() && !args.only.iter().any(|f| model.contains(f.as_str())) {
                continue;
            }
            let (ok, n, mut times) = run_director(&client, &catalog, &args, model, 2).await?;
            times.sort_unstable();
            rows.push(format!(
                "| director {model} | {ok}/{n} | {} | {} |",
                pct(&times, 0.5),
                pct(&times, 0.9)
            ));
        }
        println!("\n| director | correct | total p50 ms | total p90 ms |\n|---|---|---|---|");
        for r in rows {
            println!("{r}");
        }
    }
    Ok(())
}
