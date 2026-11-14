//! The board in plain words, for people (the report) and for the scorer. Unlike the live summary
//! ([`super::summary`]) it has no header, no item ids and no counts the interviewer needs to point at things:
//! items are named by their labels, in reading order (top to bottom, left to right), links by the items they join.
//! One line per part of the board; the same limits as the live summary (40 items, 40 links, 12 notes or members
//! per item, 80 characters per field), and candidate text is made inert the same way.

use std::collections::HashMap;
use std::fmt::Write;

use super::summary::{
    MAX_APPROACH_CHARS, MAX_CODE_CHARS, MAX_CODE_LINES, MAX_FIELD_CHARS, MAX_LISTED_EDGES,
    MAX_LISTED_ITEMS, MAX_PARTS, natural_cmp, untrusted,
};
use super::{Board, BoardKit, ComponentType, Edge, Item, Lane, MetricRole, Quad, Rel};

/// Items whose tops are within one band of this height are read as one row, left to right.
const ROW_CM: f64 = 8.0;

/// What the reader text says for a board with nothing on it.
pub const EMPTY_BOARD: &str = "Nothing was put on the board.";

/// The board in plain sentences, one per line.
pub fn reader_text(board: &Board) -> String {
    let mut items: Vec<&Item> = board
        .items
        .iter()
        .filter(|i| !matches!(i, Item::Ink(_) | Item::InterviewerCard(_)))
        .collect();
    // In reading order: rows from the top (8 cm bands), left to right in a row, then by id.
    let row = |i: &Item| (i.rect().1 / ROW_CM).floor() as i64;
    items.sort_by(|a, b| {
        row(a)
            .cmp(&row(b))
            .then(a.rect().0.total_cmp(&b.rect().0))
            .then(natural_cmp(a.id(), b.id()))
    });
    let names: HashMap<&str, String> = board.items.iter().map(|i| (i.id(), name(i))).collect();
    let listed: Vec<&Item> = items.iter().take(MAX_LISTED_ITEMS).copied().collect();
    let hidden = items.len().saturating_sub(MAX_LISTED_ITEMS);

    let mut lines: Vec<String> = Vec::new();
    let mut line = |title: &str, parts: Vec<String>, sep: &str| {
        if !parts.is_empty() {
            lines.push(format!("{title}: {}", close(parts.join(sep))));
        }
    };
    let pick = |f: &dyn Fn(&Item) -> Option<String>| -> Vec<String> {
        listed.iter().filter_map(|i| f(i)).collect()
    };

    line(
        "Components",
        pick(&|i| match i {
            Item::Component(_) => Some(component(i)),
            _ => None,
        }),
        ", ",
    );
    line(
        "Classes",
        pick(&|i| match i {
            Item::Class(_) => Some(class(i)),
            _ => None,
        }),
        "; ",
    );
    for (lane, title) in [
        (Some(Lane::User), "Users"),
        (Some(Lane::Pain), "Pain points"),
        (Some(Lane::Idea), "Ideas"),
        (Some(Lane::Metric), "Metric ideas"),
        (None, "Notes"),
    ] {
        line(
            title,
            pick(&|i| match i {
                Item::Sticky(s) if s.lane == lane => Some(sticky(s)),
                _ => None,
            }),
            "; ",
        );
    }
    line(
        "Metrics",
        pick(&|i| match i {
            Item::Metric(m) => Some(match label(&m.label) {
                Some(l) => format!("{l} ({})", role_words(m.role)),
                None => format!("an unnamed {} metric", role_words(m.role)),
            }),
            _ => None,
        }),
        "; ",
    );
    line(
        "Groups",
        pick(&|i| match i {
            Item::Group(g) => {
                let mut members: Vec<&Item> = board
                    .items
                    .iter()
                    .filter(|m| m.group() == Some(g.id.as_str()))
                    .collect();
                members.sort_by(|a, b| natural_cmp(a.id(), b.id()));
                let title = label(&g.label).unwrap_or_else(|| "Unnamed group".into());
                Some(if members.is_empty() {
                    format!("{title} (empty)")
                } else {
                    let inner = capped(members.iter().map(|m| name(m)).collect());
                    format!("{title} ({})", inner.join(", "))
                })
            }
            _ => None,
        }),
        "; ",
    );
    edge_lines(board, &names, &mut lines);
    pm_lines(board, &mut lines);
    code_lines(board, &mut lines);
    meeting_lines(board, &mut lines);
    if hidden > 0 {
        lines.push(format!(
            "And {hidden} more {}.",
            if hidden == 1 { "item" } else { "items" }
        ));
    }
    let strokes = board
        .items
        .iter()
        .filter(|i| matches!(i, Item::Ink(_)))
        .count();
    if strokes > 0 {
        lines.push(format!(
            "Freehand drawing: {strokes} {}.",
            if strokes == 1 { "stroke" } else { "strokes" }
        ));
    }
    if lines.is_empty() {
        return EMPTY_BOARD.to_string();
    }
    lines.join("\n")
}

/// Candidate text, inert and on one line.
fn plain(s: &str) -> String {
    untrusted(s, MAX_FIELD_CHARS, false)
}

fn label(l: &Option<String>) -> Option<String> {
    l.as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(plain)
}

/// Ends a line with one full stop.
fn close(mut s: String) -> String {
    let t = s.trim_end().len();
    s.truncate(t);
    if !s.ends_with(['.', '!', '?']) {
        s.push('.');
    }
    s
}

/// At most [`MAX_PARTS`] entries, then "k more".
fn capped(mut parts: Vec<String>) -> Vec<String> {
    let more = parts.len().saturating_sub(MAX_PARTS);
    if more > 0 {
        parts.truncate(MAX_PARTS);
        parts.push(format!("{more} more"));
    }
    parts
}

/// How a reader would call a component type.
fn type_words(t: ComponentType) -> Option<&'static str> {
    Some(match t {
        ComponentType::Client => "client",
        ComponentType::Lb => "load balancer",
        ComponentType::ApiGateway => "API gateway",
        ComponentType::Service => "service",
        ComponentType::Db => "database",
        ComponentType::Kv => "key value store",
        ComponentType::Cache => "cache",
        ComponentType::Queue => "queue",
        ComponentType::Cdn => "CDN",
        ComponentType::ObjectStore => "object store",
        ComponentType::Search => "search",
        ComponentType::Worker => "worker",
        ComponentType::External => "external service",
        ComponentType::Note => "note",
        ComponentType::Blank => return None,
    })
}

fn role_words(r: MetricRole) -> &'static str {
    match r {
        MetricRole::NorthStar => "north star",
        MetricRole::Input => "input",
        MetricRole::Guardrail => "guardrail",
    }
}

fn upper_first(s: &str) -> String {
    let mut c = s.chars();
    c.next()
        .map(|f| f.to_uppercase().collect::<String>() + c.as_str())
        .unwrap_or_default()
}

/// The short name of an item, as links and groups refer to it.
fn name(it: &Item) -> String {
    match it {
        Item::Component(c) => label(&c.label).unwrap_or_else(|| match type_words(c.ty) {
            Some(t) => format!("an unnamed {t}"),
            None => "an empty box".into(),
        }),
        Item::Class(c) => label(&c.label).unwrap_or_else(|| "an unnamed class".into()),
        Item::Sticky(s) => sticky_text(s),
        Item::Metric(m) => label(&m.label).unwrap_or_else(|| "an unnamed metric".into()),
        Item::Group(g) => label(&g.label).unwrap_or_else(|| "an unnamed group".into()),
        Item::InterviewerCard(c) => plain(&c.title),
        Item::Ink(_) => "a freehand stroke".into(),
    }
}

/// "Seat map cache (cache: TTL one second; rebuilt from the seat table)".
fn component(it: &Item) -> String {
    let Item::Component(c) = it else {
        return name(it);
    };
    let mut s = match label(&c.label) {
        Some(l) => l,
        None => match type_words(c.ty) {
            Some(t) => upper_first(&format!("unnamed {t}")),
            None => "Empty box".into(),
        },
    };
    let notes: Vec<String> = c
        .notes
        .iter()
        .flatten()
        .map(|n| plain(n))
        .filter(|n| !n.is_empty())
        .collect();
    let kind = label(&c.label).and(type_words(c.ty));
    match (kind, notes.is_empty()) {
        (Some(k), true) => {
            let _ = write!(s, " ({k})");
        }
        (Some(k), false) => {
            let _ = write!(s, " ({k}: {})", capped(notes).join("; "));
        }
        (None, false) => {
            let _ = write!(s, " ({})", capped(notes).join("; "));
        }
        (None, true) => {}
    }
    s
}

fn member(m: &super::Member, method: bool) -> String {
    let mut s = plain(&m.name);
    if method {
        let params: Vec<String> = m
            .params
            .iter()
            .flatten()
            .map(|p| match p.ty.as_deref() {
                Some(t) => format!("{}: {}", plain(&p.name), plain(t)),
                None => plain(&p.name),
            })
            .collect();
        let _ = write!(s, "({})", params.join(", "));
        if let Some(r) = &m.returns {
            let _ = write!(s, ": {}", plain(r));
        }
    } else if let Some(t) = &m.ty {
        let _ = write!(s, ": {}", plain(t));
    }
    s
}

/// "ParkingLot (fields levels: List<Level>; methods park(vehicle: Vehicle): Ticket)".
fn class(it: &Item) -> String {
    let Item::Class(c) = it else {
        return name(it);
    };
    let kind = match c.class_kind {
        super::ClassKind::Class => None,
        super::ClassKind::Interface => Some("interface"),
        super::ClassKind::Abstract => Some("abstract"),
        super::ClassKind::Enum => Some("enum"),
    };
    let mut parts: Vec<String> = Vec::new();
    if let Some(k) = kind {
        parts.push(k.to_string());
    }
    let fields = capped(c.fields.iter().map(|m| member(m, false)).collect());
    if !fields.is_empty() {
        parts.push(format!("fields {}", fields.join(", ")));
    }
    let methods = capped(c.methods.iter().map(|m| member(m, true)).collect());
    if !methods.is_empty() {
        parts.push(format!("methods {}", methods.join(", ")));
    }
    let title = label(&c.label).unwrap_or_else(|| "Unnamed class".into());
    if parts.is_empty() {
        title
    } else {
        format!("{title} ({})", parts.join("; "))
    }
}

fn sticky_text(s: &super::Sticky) -> String {
    let t = plain(&s.text);
    if t.is_empty() {
        "an empty sticky".into()
    } else {
        t
    }
}

fn sticky(s: &super::Sticky) -> String {
    let mut out = sticky_text(s);
    if s.votes > 0 {
        let _ = write!(
            out,
            " ({} {})",
            s.votes,
            if s.votes == 1 { "vote" } else { "votes" }
        );
    }
    out
}

fn edge_text(e: &Edge, names: &HashMap<&str, String>) -> String {
    let end = |id: &str| {
        names
            .get(id)
            .cloned()
            .unwrap_or_else(|| "a removed item".into())
    };
    let (from, to) = (end(&e.from), end(&e.to));
    let mut s = match e.rel {
        Some(Rel::Uses) => format!("{from} uses {to}"),
        Some(Rel::HasA) => format!("{from} has {to}"),
        Some(Rel::IsA) => format!("{from} is a {to}"),
        Some(Rel::Implements) => format!("{from} implements {to}"),
        None => match e.dir {
            super::Dir::Forward => format!("{from} → {to}"),
            super::Dir::Both => format!("{from} ↔ {to}"),
            super::Dir::Plain => format!("{from} linked with {to}"),
        },
    };
    if let Some(l) = label(&e.label) {
        let _ = write!(s, " ({l})");
    }
    s
}

fn edge_lines(board: &Board, names: &HashMap<&str, String>, lines: &mut Vec<String>) {
    if board.edges.is_empty() {
        return;
    }
    let mut edges: Vec<&Edge> = board.edges.iter().collect();
    edges.sort_by(|a, b| natural_cmp(&a.id, &b.id));
    let mut parts: Vec<String> = edges
        .iter()
        .take(MAX_LISTED_EDGES)
        .map(|e| edge_text(e, names))
        .collect();
    let more = edges.len().saturating_sub(MAX_LISTED_EDGES);
    if more > 0 {
        parts.push(format!("and {more} more"));
    }
    let title = if board.round.kit == BoardKit::Lld {
        "Relations"
    } else {
        "Links"
    };
    lines.push(format!("{title}: {}", close(parts.join(", "))));
}

fn pm_lines(board: &Board, lines: &mut Vec<String>) {
    let mut stickies: Vec<&super::Sticky> = board
        .items
        .iter()
        .filter_map(|i| match i {
            Item::Sticky(s) => Some(s),
            _ => None,
        })
        .collect();
    stickies.sort_by(|a, b| natural_cmp(&a.id, &b.id));
    if stickies.iter().any(|s| s.quad.is_some()) {
        let quads: Vec<String> = [
            (Quad::Tl, "high impact, low effort"),
            (Quad::Tr, "high impact, high effort"),
            (Quad::Bl, "low impact, low effort"),
            (Quad::Br, "low impact, high effort"),
        ]
        .iter()
        .filter_map(|(quad, title)| {
            let inside = capped(
                stickies
                    .iter()
                    .filter(|s| s.quad == Some(*quad))
                    .map(|s| sticky_text(s))
                    .collect(),
            );
            (!inside.is_empty()).then(|| format!("{title}: {}", inside.join(", ")))
        })
        .collect();
        lines.push(format!("Impact and effort: {}", close(quads.join("; "))));
    }
    let mut ranked: Vec<&&super::Sticky> = stickies.iter().filter(|s| s.rank.is_some()).collect();
    ranked.sort_by(|a, b| a.rank.cmp(&b.rank).then(natural_cmp(&a.id, &b.id)));
    if !ranked.is_empty() {
        let rungs: Vec<String> = ranked
            .iter()
            .take(MAX_LISTED_ITEMS)
            .map(|s| format!("{}. {}", s.rank.unwrap_or(0), sticky_text(s)))
            .collect();
        lines.push(format!("Ranked: {}", close(rungs.join("; "))));
    }
}

fn code_lines(board: &Board, lines: &mut Vec<String>) {
    let Some(code) = &board.code else { return };
    let approach: Vec<String> = code
        .approach
        .iter()
        .map(|a| untrusted(a.trim().trim_end_matches('.'), MAX_APPROACH_CHARS, false))
        .filter(|a| !a.is_empty())
        .collect();
    if !approach.is_empty() {
        lines.push(format!("Approach: {}", close(approach.join("; "))));
    }
    let slot = |v: &Option<String>| label(v).unwrap_or_else(|| "not given".into());
    if code.complexity.time.is_some() || code.complexity.space.is_some() {
        lines.push(format!(
            "Complexity: time {}, space {}.",
            slot(&code.complexity.time),
            slot(&code.complexity.space)
        ));
    }
    if code.lines.is_empty() {
        return;
    }
    let lang = plain(&code.language);
    let mut block = format!("Code ({lang}):");
    for l in code.lines.iter().take(MAX_CODE_LINES) {
        let _ = write!(
            block,
            "\n{}{}",
            "    ".repeat(l.indent.min(12) as usize),
            untrusted(&l.text, MAX_CODE_CHARS, true)
        );
    }
    let more = code.lines.len().saturating_sub(MAX_CODE_LINES);
    if more > 0 {
        let _ = write!(
            block,
            "\nand {more} more {}",
            if more == 1 { "line" } else { "lines" }
        );
    }
    lines.push(block);
}

fn meeting_lines(board: &Board, lines: &mut Vec<String>) {
    let Some(m) = &board.meeting else { return };
    if !m.agenda.is_empty() {
        let entries: Vec<String> = m
            .agenda
            .iter()
            .map(|a| {
                let t = plain(&a.text);
                if a.done { format!("{t} (done)") } else { t }
            })
            .collect();
        lines.push(format!("Agenda: {}", close(entries.join("; "))));
    }
    if !m.parked.is_empty() {
        let parked: Vec<String> = m.parked.iter().map(|p| plain(p)).collect();
        lines.push(format!("Parked: {}", close(parked.join("; "))));
    }
    if let Some(ns) = m.numbers.as_ref().filter(|n| !n.is_empty()) {
        let numbers: Vec<String> = ns
            .iter()
            .map(|n| format!("{} {}", plain(&n.label), plain(&n.value)))
            .collect();
        lines.push(format!("Numbers: {}", close(numbers.join("; "))));
    }
}
