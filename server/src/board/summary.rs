//! The board as text for the live interviewer (and the Scribe). Deterministic: the same board always gives the
//! same bytes (items and edges in natural id order, fixed formatting), so it never defeats prompt caching.
//! Ids stay in the text so the interviewer can `point_at` an item. At most 40 items are listed; the rest are
//! counted by type.

use std::cmp::Ordering;
use std::collections::{BTreeMap, HashSet};
use std::fmt::Write;

use super::{
    Board, BoardKit, ComponentType, Edge, Item, Lane, MetricRole, Quad, Recognized, ShownKind,
    ShownRef,
};

/// Items listed by id before the rest are only counted.
pub const MAX_LISTED_ITEMS: usize = 40;
/// Links listed before the rest are only counted.
pub const MAX_LISTED_EDGES: usize = 40;
/// Code lines printed before the rest are only counted.
pub const MAX_CODE_LINES: usize = 60;
/// Entries in the "Changed since" line before the rest are only counted.
pub const MAX_CHANGES: usize = 20;

/// The summary of `board`; with `since = Some((rev, board_at_rev))`, adds what changed since then.
pub fn summary(board: &Board, since: Option<(u64, &Board)>) -> String {
    let mut out = String::new();
    let kit = board.round.kit;
    let _ = writeln!(out, "[Board update r{}, do not read aloud]", board.rev);
    let _ = writeln!(
        out,
        "{} {}. {}",
        kit_name(kit),
        q(&board.brief.question),
        counts(board)
    );
    if !board.brief.lines.is_empty() {
        let _ = writeln!(
            out,
            "Brief: {}",
            sentence(board.brief.lines.iter().map(|l| clean(l)))
        );
    }
    code_block(board, &mut out);
    meeting_block(board, &mut out);

    let mut items: Vec<&Item> = board
        .items
        .iter()
        .filter(|i| !matches!(i, Item::Ink(_)))
        .collect();
    items.sort_by(|a, b| natural_cmp(a.id(), b.id()));
    let listed: Vec<&Item> = items.iter().take(MAX_LISTED_ITEMS).copied().collect();
    let hidden: Vec<&Item> = items.iter().skip(MAX_LISTED_ITEMS).copied().collect();
    item_lines(board, &listed, &mut out);
    edge_line(board, &mut out);
    if !hidden.is_empty() {
        let mut by_type: BTreeMap<&str, usize> = BTreeMap::new();
        for it in &hidden {
            *by_type.entry(type_name(it)).or_default() += 1;
        }
        let mut counts: Vec<(&str, usize)> = by_type.into_iter().collect();
        counts.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
        let parts: Vec<String> = counts.iter().map(|(t, n)| format!("{n} {t}")).collect();
        let _ = writeln!(
            out,
            "Not listed: {} more {} ({}).",
            hidden.len(),
            if hidden.len() == 1 { "item" } else { "items" },
            parts.join(", ")
        );
    }
    pm_lines(board, &mut out);
    if let Some((rev, prev)) = since {
        let changes = diff(prev, board);
        let text = if changes.is_empty() {
            "none.".to_string()
        } else {
            let more = changes.len().saturating_sub(MAX_CHANGES);
            let mut shown: Vec<String> = changes.into_iter().take(MAX_CHANGES).collect();
            if more > 0 {
                shown.push(format!("and {more} more"));
            }
            format!("{}.", shown.join(", "))
        };
        let _ = writeln!(out, "Changed since r{rev}: {text}");
    }
    let _ = write!(out, "Unlabelled: {} Ink: {}", unlabelled(board), ink(board));
    out
}

fn kit_name(kit: BoardKit) -> &'static str {
    match kit {
        BoardKit::Hld => "HLD",
        BoardKit::Lld => "LLD",
        BoardKit::Coding => "Coding",
        BoardKit::Pm => "PM",
        BoardKit::Meeting => "Meeting",
    }
}

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

fn links_word(board: &Board) -> (&'static str, &'static str) {
    if board.round.kit == BoardKit::Lld {
        ("relation", "relations")
    } else {
        ("link", "links")
    }
}

fn counts(board: &Board) -> String {
    let count = |f: fn(&Item) -> bool| board.items.iter().filter(|i| f(i)).count();
    let mut parts = Vec::new();
    for (n, one, many) in [
        (
            count(|i| matches!(i, Item::Component(_))),
            "component",
            "components",
        ),
        (count(|i| matches!(i, Item::Class(_))), "class", "classes"),
        (
            count(|i| matches!(i, Item::Sticky(_))),
            "sticky",
            "stickies",
        ),
        (count(|i| matches!(i, Item::Metric(_))), "metric", "metrics"),
        (count(|i| matches!(i, Item::Group(_))), "group", "groups"),
        (
            count(|i| matches!(i, Item::InterviewerCard(_))),
            "interviewer card",
            "interviewer cards",
        ),
    ] {
        if n > 0 {
            parts.push(plural(n, one, many));
        }
    }
    if !board.edges.is_empty() {
        let (one, many) = links_word(board);
        parts.push(plural(board.edges.len(), one, many));
    }
    if let Some(code) = &board.code {
        parts.push(plural(code.lines.len(), "code line", "code lines"));
    }
    if let Some(m) = board.meeting.as_ref().filter(|m| !m.agenda.is_empty()) {
        let done = m.agenda.iter().filter(|a| a.done).count();
        parts.push(format!("agenda {done} of {} done", m.agenda.len()));
    }
    if parts.is_empty() {
        return "Nothing on the board yet.".into();
    }
    let joined = parts.join(", ");
    let mut chars = joined.chars();
    let first = chars
        .next()
        .map(|c| c.to_uppercase().to_string())
        .unwrap_or_default();
    format!("{first}{}.", chars.as_str())
}

/// One line of text without quotes or line breaks.
fn clean(s: &str) -> String {
    s.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .replace('"', "'")
}

fn q(s: &str) -> String {
    format!("\"{}\"", clean(s))
}

/// Items joined with "; " and closed with a full stop.
fn sentence(items: impl IntoIterator<Item = String>) -> String {
    let items: Vec<String> = items.into_iter().collect();
    let mut s = items.join("; ");
    if !s.ends_with('.') {
        s.push('.');
    }
    s
}

fn label(l: &Option<String>) -> Option<&str> {
    l.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

fn mmss(t: f64) -> String {
    let s = t.max(0.0).floor() as u64;
    format!("{}:{:02}", s / 60, s % 60)
}

fn role_words(r: MetricRole) -> &'static str {
    match r {
        MetricRole::NorthStar => "north star",
        MetricRole::Input => "input",
        MetricRole::Guardrail => "guardrail",
    }
}

fn type_name(it: &Item) -> &'static str {
    match it {
        Item::Component(c) => c.ty.display(),
        Item::Class(_) => "Class",
        Item::Sticky(_) => "Sticky",
        Item::Group(_) => "Group",
        Item::Metric(_) => "Metric",
        Item::Ink(_) => "Ink",
        Item::InterviewerCard(_) => "Card",
    }
}

fn member_sig(m: &super::Member, method: bool) -> String {
    let mut s = format!("{}{}", m.vis.as_str(), clean(&m.name));
    if method {
        let params: Vec<String> = m
            .params
            .iter()
            .flatten()
            .map(|p| match p.ty.as_deref() {
                Some(t) => format!("{}:{}", clean(&p.name), clean(t)),
                None => clean(&p.name),
            })
            .collect();
        let _ = write!(s, "({})", params.join(", "));
        if let Some(r) = &m.returns {
            let _ = write!(s, ":{}", clean(r));
        }
    } else if let Some(t) = &m.ty {
        let _ = write!(s, ":{}", clean(t));
    }
    s
}

/// The item as listed (and as named in the diff, for the kinds that are not groups, cards or ink).
fn describe(it: &Item) -> String {
    match it {
        Item::Component(c) => {
            let mut s = format!("{} {}", c.id, c.ty.display());
            if let Some(l) = label(&c.label) {
                let _ = write!(s, " {}", q(l));
            }
            if let Some(notes) = c.notes.as_ref().filter(|n| !n.is_empty()) {
                let notes: Vec<String> = notes.iter().map(|n| clean(n)).collect();
                let _ = write!(s, " ({})", notes.join(", "));
            }
            s
        }
        Item::Class(c) => {
            let kind = match c.class_kind {
                super::ClassKind::Class => "",
                super::ClassKind::Interface => "interface ",
                super::ClassKind::Abstract => "abstract ",
                super::ClassKind::Enum => "enum ",
            };
            let name = label(&c.label)
                .map(clean)
                .unwrap_or_else(|| "(unnamed)".into());
            let members: Vec<String> = c
                .fields
                .iter()
                .map(|m| member_sig(m, false))
                .chain(c.methods.iter().map(|m| member_sig(m, true)))
                .collect();
            format!("{} {kind}{name}{{{}}}", c.id, members.join("; "))
        }
        Item::Sticky(s) => {
            let mut out = format!("{} {}", s.id, q(&s.text));
            if s.votes > 0 {
                let _ = write!(out, " ({})", plural(s.votes as usize, "vote", "votes"));
            }
            out
        }
        Item::Metric(m) => {
            let mut s = format!("{} {}", m.id, role_words(m.role));
            if let Some(l) = label(&m.label) {
                let _ = write!(s, " {}", q(l));
            }
            s
        }
        Item::Group(g) => match label(&g.label) {
            Some(l) => format!("{} group {}", g.id, q(l)),
            None => format!("{} group", g.id),
        },
        Item::InterviewerCard(c) => format!("{} card {}", c.id, q(&c.title)),
        Item::Ink(i) => format!("{} ink stroke", i.id),
    }
}

fn describe_edge(e: &Edge) -> String {
    let mut s = match e.rel {
        Some(rel) => {
            let rel = serde_json::to_value(rel)
                .ok()
                .and_then(|v| v.as_str().map(str::to_string))
                .unwrap_or_default();
            format!("{} {} {rel} {}", e.id, e.from, e.to)
        }
        None => format!("{} {}{}{}", e.id, e.from, e.dir.as_str(), e.to),
    };
    if let Some(l) = label(&e.label) {
        let _ = write!(s, " {}", q(l));
    }
    s
}

fn item_lines(board: &Board, listed: &[&Item], out: &mut String) {
    let mut line = |name: &str, entries: Vec<String>| {
        if !entries.is_empty() {
            let _ = writeln!(out, "{name}: {}", sentence(entries));
        }
    };
    let pick = |f: &dyn Fn(&Item) -> Option<String>| -> Vec<String> {
        listed.iter().filter_map(|i| f(i)).collect()
    };

    line(
        "Components",
        pick(&|i| matches!(i, Item::Component(_)).then(|| describe(i))),
    );
    line(
        "Classes",
        pick(&|i| matches!(i, Item::Class(_)).then(|| describe(i))),
    );
    for (lane, name) in [
        (Some(Lane::User), "Users"),
        (Some(Lane::Pain), "Pain points"),
        (Some(Lane::Idea), "Ideas"),
        (Some(Lane::Metric), "Metrics lane"),
        (None, "Other stickies"),
    ] {
        line(
            name,
            pick(&|i| match i {
                Item::Sticky(s) if s.lane == lane => Some(describe(i)),
                _ => None,
            }),
        );
    }
    line(
        "Metrics",
        pick(&|i| matches!(i, Item::Metric(_)).then(|| describe(i))),
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
                let votes: u64 = members
                    .iter()
                    .map(|m| match m {
                        Item::Sticky(s) => s.votes,
                        _ => 0,
                    })
                    .sum();
                let mut inner = if members.is_empty() {
                    "empty".to_string()
                } else {
                    members
                        .iter()
                        .map(|m| m.id())
                        .collect::<Vec<_>>()
                        .join(", ")
                };
                if votes > 0 {
                    let _ = write!(inner, "; {}", plural(votes as usize, "vote", "votes"));
                }
                Some(match label(&g.label) {
                    Some(l) => format!("{} {} ({inner})", g.id, q(l)),
                    None => format!("{} ({inner})", g.id),
                })
            }
            _ => None,
        }),
    );
    line(
        "Interviewer cards",
        pick(&|i| match i {
            Item::InterviewerCard(c) => {
                Some(format!("{} {} ({})", c.id, q(&c.title), clean(&c.body)))
            }
            _ => None,
        }),
    );
}

fn edge_line(board: &Board, out: &mut String) {
    if board.edges.is_empty() {
        return;
    }
    let mut edges: Vec<&Edge> = board.edges.iter().collect();
    edges.sort_by(|a, b| natural_cmp(&a.id, &b.id));
    let mut entries: Vec<String> = edges
        .iter()
        .take(MAX_LISTED_EDGES)
        .map(|e| describe_edge(e))
        .collect();
    let more = edges.len().saturating_sub(MAX_LISTED_EDGES);
    if more > 0 {
        entries.push(format!("and {more} more"));
    }
    let name = if board.round.kit == BoardKit::Lld {
        "Relations"
    } else {
        "Links"
    };
    let _ = writeln!(out, "{name}: {}", sentence(entries));
}

fn pm_lines(board: &Board, out: &mut String) {
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
            (Quad::Tl, "tl"),
            (Quad::Tr, "tr"),
            (Quad::Bl, "bl"),
            (Quad::Br, "br"),
        ]
        .iter()
        .map(|(quad, name)| {
            let ids: Vec<&str> = stickies
                .iter()
                .filter(|s| s.quad == Some(*quad))
                .map(|s| s.id.as_str())
                .collect();
            format!(
                "{name} {}",
                if ids.is_empty() {
                    "none".to_string()
                } else {
                    ids.join(", ")
                }
            )
        })
        .collect();
        let _ = writeln!(
            out,
            "Quadrants (top = high impact, left = low effort): {}",
            sentence(quads)
        );
    }
    let mut ranked: Vec<&&super::Sticky> = stickies.iter().filter(|s| s.rank.is_some()).collect();
    ranked.sort_by(|a, b| a.rank.cmp(&b.rank).then(natural_cmp(&a.id, &b.id)));
    if !ranked.is_empty() {
        let rungs = ranked
            .iter()
            .map(|s| format!("{} {}", s.rank.unwrap_or(0), s.id));
        let _ = writeln!(out, "Ladder: {}", sentence(rungs));
    }
}

fn code_block(board: &Board, out: &mut String) {
    let Some(code) = &board.code else { return };
    let approach: Vec<String> = code
        .approach
        .iter()
        .map(|a| clean(a).trim_end_matches('.').to_string())
        .collect();
    if approach.is_empty() {
        let _ = writeln!(out, "Approach: none yet.");
    } else {
        let _ = writeln!(out, "Approach: {}", sentence(approach));
    }
    let slot = |v: &Option<String>| label(v).map(clean).unwrap_or_else(|| "?".into());
    let _ = writeln!(
        out,
        "Complexity: time {}, space {}.",
        slot(&code.complexity.time),
        slot(&code.complexity.space)
    );
    let lang = clean(&code.language);
    if code.lines.is_empty() {
        let _ = writeln!(out, "Code ({lang}): empty.");
    } else {
        let _ = writeln!(out, "Code ({lang}):");
        for (n, l) in code.lines.iter().take(MAX_CODE_LINES).enumerate() {
            let text = l.text.replace(['\n', '\r'], " ");
            let _ = writeln!(
                out,
                "{} {}: {}{}",
                n + 1,
                l.id,
                "    ".repeat(l.indent as usize),
                text.trim_end()
            );
        }
        let more = code.lines.len().saturating_sub(MAX_CODE_LINES);
        if more > 0 {
            let _ = writeln!(out, "and {} more", plural(more, "line", "lines"));
        }
    }
    if !code.trace.is_empty() {
        let last: Vec<&str> = code
            .trace
            .iter()
            .rev()
            .take(3)
            .rev()
            .map(|t| t.line.as_str())
            .collect();
        let _ = writeln!(
            out,
            "Trace: {}, last {}.",
            plural(code.trace.len(), "step", "steps"),
            last.join(", ")
        );
    }
}

fn number_text(board: &Board, id: &str) -> String {
    board
        .meeting
        .as_ref()
        .and_then(|m| m.numbers.as_ref())
        .and_then(|ns| ns.iter().find(|n| n.id == id))
        .map(|n| format!("{} {} = {}", n.id, clean(&n.label), clean(&n.value)))
        .unwrap_or_else(|| clean(id))
}

fn shown_text(board: &Board, s: &super::Shown) -> String {
    match (&s.kind, &s.reference) {
        (ShownKind::Slide, ShownRef::Page(p)) => format!("slide {p}"),
        (ShownKind::Slide, ShownRef::Id(p)) => format!("slide {}", clean(p)),
        (ShownKind::Number, ShownRef::Id(id)) => format!("number {}", number_text(board, id)),
        (ShownKind::Number, ShownRef::Page(p)) => format!("number {p}"),
    }
}

fn meeting_block(board: &Board, out: &mut String) {
    let Some(m) = &board.meeting else { return };
    if !m.agenda.is_empty() {
        let entries = m.agenda.iter().map(|a| {
            let mut s = format!(
                "[{}] {} {}",
                if a.done { "x" } else { " " },
                a.id,
                q(&a.text)
            );
            if let (true, Some(t)) = (a.done, a.t) {
                let _ = write!(s, " (at {})", mmss(t));
            }
            s
        });
        let _ = writeln!(out, "Agenda: {}", sentence(entries));
    }
    match m.shown.last() {
        Some(s) => {
            let _ = writeln!(
                out,
                "On screen: {} (since {}).",
                shown_text(board, s),
                mmss(s.t)
            );
        }
        None => {
            let _ = writeln!(out, "On screen: nothing.");
        }
    }
    if m.parked.is_empty() {
        let _ = writeln!(out, "Parked: none.");
    } else {
        let _ = writeln!(out, "Parked: {}", sentence(m.parked.iter().map(|p| q(p))));
    }
    if let Some(ns) = m.numbers.as_ref().filter(|n| !n.is_empty()) {
        let _ = writeln!(
            out,
            "Numbers: {}",
            sentence(ns.iter().map(|n| number_text(board, &n.id)))
        );
    }
}

fn unlabelled(board: &Board) -> String {
    let mut ids: Vec<&str> = board
        .items
        .iter()
        .filter(|i| match i {
            Item::Component(c) => c.ty == ComponentType::Blank && label(&c.label).is_none(),
            Item::Class(c) => label(&c.label).is_none(),
            Item::Metric(m) => label(&m.label).is_none(),
            Item::Group(g) => label(&g.label).is_none(),
            Item::Sticky(s) => s.text.trim().is_empty(),
            _ => false,
        })
        .map(Item::id)
        .collect();
    if ids.is_empty() {
        return "none.".into();
    }
    ids.sort_by(|a, b| natural_cmp(a, b));
    let more = ids.len().saturating_sub(10);
    let mut s = ids.iter().take(10).copied().collect::<Vec<_>>().join(", ");
    if more > 0 {
        let _ = write!(s, " and {more} more");
    }
    s.push('.');
    s
}

fn ink(board: &Board) -> String {
    let strokes: Vec<Option<Recognized>> = board
        .items
        .iter()
        .filter_map(|i| match i {
            Item::Ink(k) => Some(k.recognized),
            _ => None,
        })
        .collect();
    if strokes.is_empty() {
        return "none.".into();
    }
    let parts: Vec<String> = [
        (None, "unrecognised"),
        (Some(Recognized::Rect), "box"),
        (Some(Recognized::Line), "line"),
        (Some(Recognized::Arrow), "arrow"),
        (Some(Recognized::Circle), "circle"),
    ]
    .iter()
    .filter_map(|(r, name)| {
        let n = strokes.iter().filter(|s| s == &r).count();
        (n > 0).then(|| {
            if strokes.len() == 1 {
                name.to_string()
            } else {
                format!("{n} {name}")
            }
        })
    })
    .collect();
    format!(
        "{} ({}).",
        plural(strokes.len(), "stroke", "strokes"),
        parts.join(", ")
    )
}

/// What changed from `prev` to `cur`: added, then changed, then removed; items before edges; natural id order.
fn diff(prev: &Board, cur: &Board) -> Vec<String> {
    let find = |b: &Board, id: &str| b.items.iter().find(|i| i.id() == id).cloned();
    let find_edge = |b: &Board, id: &str| b.edges.iter().find(|e| e.id == id).cloned();
    let mut item_ids: Vec<&str> = prev
        .items
        .iter()
        .chain(&cur.items)
        .map(Item::id)
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    item_ids.sort_by(|a, b| natural_cmp(a, b));
    let mut edge_ids: Vec<&str> = prev
        .edges
        .iter()
        .chain(&cur.edges)
        .map(|e| e.id.as_str())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    edge_ids.sort_by(|a, b| natural_cmp(a, b));

    let (mut added, mut changed, mut removed) = (Vec::new(), Vec::new(), Vec::new());
    for id in &item_ids {
        match (find(prev, id), find(cur, id)) {
            (None, Some(n)) => added.push(format!("+{}", describe(&n))),
            (Some(o), None) => removed.push(format!("-{}", describe(&o))),
            (Some(o), Some(n)) if o != n => {
                // Same description: only its place changed (position, size, lane, quadrant, rung or group).
                let nd = describe(&n);
                if describe(&o) != nd {
                    changed.push(format!("~{nd}"));
                } else {
                    changed.push(format!("~{id} moved"));
                }
            }
            _ => {}
        }
    }
    let (mut e_added, mut e_changed, mut e_removed) = (Vec::new(), Vec::new(), Vec::new());
    for id in &edge_ids {
        match (find_edge(prev, id), find_edge(cur, id)) {
            (None, Some(n)) => e_added.push(format!("+{}", describe_edge(&n))),
            (Some(o), None) => e_removed.push(format!("-{}", describe_edge(&o))),
            (Some(o), Some(n)) if o != n => e_changed.push(format!("~{}", describe_edge(&n))),
            _ => {}
        }
    }
    let mut out = Vec::new();
    out.extend(added);
    out.extend(e_added);
    out.extend(changed);
    out.extend(e_changed);
    out.extend(removed);
    out.extend(e_removed);
    code_diff(prev, cur, &mut out);
    meeting_diff(prev, cur, &mut out);
    out
}

fn code_diff(prev: &Board, cur: &Board, out: &mut Vec<String>) {
    let (Some(o), Some(n)) = (&prev.code, &cur.code) else {
        return;
    };
    for l in &n.lines {
        match o.lines.iter().find(|x| x.id == l.id) {
            None => out.push(format!("+line {} {}", l.id, q(&l.text))),
            Some(x) if x.text != l.text || x.indent != l.indent => {
                out.push(format!("~line {} {}", l.id, q(&l.text)))
            }
            _ => {}
        }
    }
    let order = |c: &super::Code| c.lines.iter().map(|l| l.id.clone()).collect::<Vec<_>>();
    let kept: Vec<String> = order(o)
        .into_iter()
        .filter(|id| n.lines.iter().any(|l| l.id == *id))
        .collect();
    let new_kept: Vec<String> = order(n)
        .into_iter()
        .filter(|id| o.lines.iter().any(|l| l.id == *id))
        .collect();
    if kept != new_kept {
        out.push("~line order".into());
    }
    for l in &o.lines {
        if !n.lines.iter().any(|x| x.id == l.id) {
            out.push(format!("-line {}", l.id));
        }
    }
    if o.approach != n.approach {
        out.push("~approach".into());
    }
    if o.complexity != n.complexity {
        out.push("~complexity".into());
    }
}

fn meeting_diff(prev: &Board, cur: &Board, out: &mut Vec<String>) {
    let (Some(o), Some(n)) = (&prev.meeting, &cur.meeting) else {
        return;
    };
    for a in &n.agenda {
        if let Some(x) = o.agenda.iter().find(|x| x.id == a.id)
            && x.done != a.done
        {
            out.push(format!(
                "~agenda {} {}",
                a.id,
                if a.done { "done" } else { "not done" }
            ));
        }
    }
    for s in n.shown.iter().skip(o.shown.len()) {
        out.push(format!("+on screen {}", shown_text(cur, s)));
    }
    for p in n.parked.iter().skip(o.parked.len()) {
        out.push(format!("+parked {}", q(p)));
    }
}

/// Orders ids the way people read them: `n2` before `n10`. A total order (ties fall back to byte order).
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    fn chunks(s: &str) -> Vec<(bool, &str)> {
        let mut out = Vec::new();
        let mut start = 0;
        let bytes = s.as_bytes();
        for i in 1..=bytes.len() {
            if i == bytes.len() || bytes[i].is_ascii_digit() != bytes[start].is_ascii_digit() {
                out.push((bytes[start].is_ascii_digit(), &s[start..i]));
                start = i;
            }
        }
        out
    }
    if a.is_empty() || b.is_empty() {
        return a.cmp(b);
    }
    let (ca, cb) = (chunks(a), chunks(b));
    for ((da, sa), (db, sb)) in ca.iter().zip(&cb) {
        let ord = if *da && *db {
            let (ta, tb) = (sa.trim_start_matches('0'), sb.trim_start_matches('0'));
            ta.len().cmp(&tb.len()).then(ta.cmp(tb))
        } else {
            sa.cmp(sb)
        };
        if ord != Ordering::Equal {
            return ord;
        }
    }
    ca.len().cmp(&cb.len()).then(a.cmp(b))
}

#[cfg(test)]
mod tests {
    use super::natural_cmp;

    #[test]
    fn natural_order() {
        let mut ids = vec!["n10", "n2", "e1", "n1", "x7_10", "x7_9", "n02"];
        ids.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(ids, ["e1", "n1", "n02", "n2", "n10", "x7_9", "x7_10"]);
    }
}
