//! The pure op apply (docs/protocol.md, Board ops: Apply and Effects). Undo needs the op log and lives in
//! [`super::BoardSession`].

use std::collections::HashSet;

use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use super::{
    Board, ClassKind, CodeLine, ComponentType, Dir, Edge, Group, Item, Lane, MAX_ARRAY_LEN,
    MAX_CARD_BODY_CHARS, MAX_INK_POINTS, MAX_TEXT_CHARS, Member, MetricRole, Quad, Rel, Section,
    Shown, ShownKind, ShownRef, TraceEntry, is_id, parse_enum, present, required, some,
};

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum BoardError {
    /// The op or its args do not match the schema (including unknown op names).
    #[error("invalid op: {0}")]
    Invalid(String),
    /// The args are valid but the rules reject the op on this board.
    #[error("{0}")]
    Rejected(String),
    /// `undo` needs the op log: apply it through a [`super::BoardSession`].
    #[error("undo needs the op log")]
    NeedsLog,
}

/// Applies one op. A duplicate `op_id` changes nothing and returns the current rev. A rejected op returns `Err`
/// and leaves the board exactly as it was (the caller drops a ghost with the same `op_id`). A committed op bumps
/// `rev`, appends its `op_id` and removes the ghost with that `op_id`; returns the new rev.
pub fn apply(board: &mut Board, op: &super::BoardOp) -> Result<u64, BoardError> {
    if board.op_ids.contains(&op.op_id) {
        return Ok(board.rev);
    }
    let parsed = parse(op)?;
    if matches!(parsed, Op::Undo { .. }) {
        return Err(BoardError::NeedsLog);
    }
    effect(board, parsed).map_err(BoardError::Rejected)?;
    board.rev += 1;
    board.op_ids.push(op.op_id.clone());
    board.ghosts.retain(|g| g.op_id != op.op_id);
    Ok(board.rev)
}

/// An op with typed, schema-checked args.
#[derive(Clone, Debug)]
pub(crate) enum Op {
    ItemCreate(Item),
    ItemMove(MoveArgs),
    ItemDelete {
        id: String,
    },
    ItemLabel {
        id: String,
        text: Option<String>,
    },
    ItemSetType {
        id: String,
        ty: String,
    },
    ItemNoteAdd {
        id: String,
        text: String,
    },
    EdgeCreate(EdgeCreateArgs),
    EdgeDelete {
        id: String,
    },
    EdgeSetDir {
        id: String,
        dir: Dir,
    },
    EdgeSetRel {
        id: String,
        rel: Option<Rel>,
    },
    EdgeLabel {
        id: String,
        text: Option<String>,
    },
    GroupCreate(GroupCreateArgs),
    MemberAdd {
        class_id: String,
        section: Section,
        member: Member,
    },
    MemberMove {
        id: String,
        to_class_id: String,
    },
    MemberRemove {
        id: String,
    },
    StickyVote {
        id: String,
        delta: i64,
    },
    StickySetQuad {
        id: String,
        quad: Option<Quad>,
    },
    CodeInsert {
        line: CodeLine,
        after: Option<String>,
    },
    CodeEdit {
        id: String,
        text: String,
    },
    CodeMove {
        id: String,
        after: Option<String>,
    },
    CodeIndent {
        id: String,
        delta: i64,
    },
    CodeDelete {
        id: String,
    },
    CodeComplexity {
        slot: Slot,
        value: Option<String>,
    },
    CodeTrace {
        line: String,
        t: f64,
    },
    CodeApproach {
        lines: Vec<String>,
    },
    AgendaCheck {
        id: String,
        done: bool,
        t: Option<f64>,
    },
    PresentShow {
        kind: ShownKind,
        reference: ShownRef,
        t: f64,
    },
    ParkAdd {
        text: String,
    },
    Undo {
        target_op_id: String,
    },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct MoveArgs {
    id: String,
    x: f64,
    y: f64,
    #[serde(default, deserialize_with = "present")]
    lane: Option<Option<Lane>>,
    #[serde(default, deserialize_with = "present")]
    rank: Option<Option<u64>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct EdgeCreateArgs {
    id: String,
    from: String,
    to: String,
    #[serde(default, deserialize_with = "some")]
    dir: Option<Dir>,
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    rel: Option<Rel>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct GroupCreateArgs {
    id: String,
    #[serde(deserialize_with = "required")]
    label: Option<String>,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    members: Vec<String>,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Slot {
    Time,
    Space,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct IdArgs {
    id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct IdText {
    id: String,
    #[serde(deserialize_with = "required")]
    text: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct IdString {
    id: String,
    text: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SetTypeArgs {
    id: String,
    #[serde(rename = "type")]
    ty: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SetDirArgs {
    id: String,
    dir: Dir,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SetRelArgs {
    id: String,
    #[serde(deserialize_with = "required")]
    rel: Option<Rel>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MemberAddArgs {
    class_id: String,
    section: Section,
    member: Member,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MemberMoveArgs {
    id: String,
    to_class_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DeltaArgs {
    id: String,
    delta: i64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct QuadArgs {
    id: String,
    #[serde(deserialize_with = "required")]
    quad: Option<Quad>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CodeInsertArgs {
    line: CodeLine,
    #[serde(deserialize_with = "required")]
    after: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CodeMoveArgs {
    id: String,
    #[serde(deserialize_with = "required")]
    after: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ComplexityArgs {
    slot: Slot,
    #[serde(deserialize_with = "required")]
    value: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TraceArgs {
    line: String,
    t: f64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ApproachArgs {
    lines: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AgendaArgs {
    id: String,
    done: bool,
    #[serde(deserialize_with = "required")]
    t: Option<f64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ShowArgs {
    kind: ShownKind,
    #[serde(rename = "ref")]
    reference: ShownRef,
    t: f64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TextArgs {
    text: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UndoArgs {
    target_op_id: String,
}

fn args<T: DeserializeOwned>(v: &Value) -> Result<T, String> {
    serde_json::from_value(v.clone()).map_err(|e| e.to_string())
}

fn id(s: &str, what: &str) -> Result<(), String> {
    if is_id(s) {
        Ok(())
    } else {
        Err(format!("{what} must be an id"))
    }
}

fn non_empty(s: &str, what: &str) -> Result<(), String> {
    if s.is_empty() {
        Err(format!("{what} is empty"))
    } else {
        Ok(())
    }
}

fn check_member(m: &Member) -> Result<(), String> {
    id(&m.id, "member.id")?;
    non_empty(&m.name, "member.name")
}

fn check_line(l: &CodeLine) -> Result<(), String> {
    id(&l.id, "line.id")?;
    if l.indent > 6 {
        return Err("line.indent out of range".into());
    }
    Ok(())
}

/// The schema checks serde cannot express (id pattern, ranges, lengths).
pub(crate) fn check_item(item: &Item) -> Result<(), String> {
    id(item.id(), "id")?;
    match item {
        Item::Class(c) => c.fields.iter().chain(&c.methods).try_for_each(check_member),
        Item::Sticky(s) if s.rank == Some(0) => Err("rank must be at least 1".into()),
        Item::Ink(i) if i.points.len() < 2 => Err("ink needs 2 points".into()),
        _ => Ok(()),
    }
}

/// Server size limits on op args, so a stored board never holds huge texts: every string at most
/// [`MAX_TEXT_CHARS`] (a card `body` [`MAX_CARD_BODY_CHARS`]), every array at most [`MAX_ARRAY_LEN`] entries
/// (ink `points` [`MAX_INK_POINTS`]).
fn check_sizes(v: &Value, key: &str) -> Result<(), String> {
    match v {
        Value::String(s) => {
            let max = if key == "body" {
                MAX_CARD_BODY_CHARS
            } else {
                MAX_TEXT_CHARS
            };
            if s.chars().count() > max {
                return Err(format!("{key} is longer than {max} characters"));
            }
        }
        Value::Array(a) => {
            let max = if key == "points" {
                MAX_INK_POINTS
            } else {
                MAX_ARRAY_LEN
            };
            if a.len() > max {
                return Err(format!("{key} has more than {max} entries"));
            }
            a.iter().try_for_each(|x| check_sizes(x, key))?;
        }
        Value::Object(m) => m.iter().try_for_each(|(k, x)| check_sizes(x, k))?,
        _ => {}
    }
    Ok(())
}

/// Parses and schema-checks an op's args.
pub(crate) fn parse(op: &super::BoardOp) -> Result<Op, BoardError> {
    if op.op_id.is_empty() {
        return Err(BoardError::Invalid("op_id is required".into()));
    }
    if !op.args.is_object() {
        return Err(BoardError::Invalid("args must be an object".into()));
    }
    check_sizes(&op.args, "args").map_err(|e| BoardError::Invalid(format!("{}: {e}", op.op)))?;
    parse_args(&op.op, &op.args).map_err(|e| BoardError::Invalid(format!("{}: {e}", op.op)))
}

fn parse_args(name: &str, a: &Value) -> Result<Op, String> {
    Ok(match name {
        "item.create" => {
            let item: Item = args(a)?;
            check_item(&item)?;
            Op::ItemCreate(item)
        }
        "item.move" => {
            let m: MoveArgs = args(a)?;
            id(&m.id, "id")?;
            if m.rank == Some(Some(0)) {
                return Err("rank must be at least 1".into());
            }
            Op::ItemMove(m)
        }
        "item.delete" | "edge.delete" | "member.remove" | "code.delete" => {
            let IdArgs { id: i } = args(a)?;
            id(&i, "id")?;
            match name {
                "item.delete" => Op::ItemDelete { id: i },
                "edge.delete" => Op::EdgeDelete { id: i },
                "member.remove" => Op::MemberRemove { id: i },
                _ => Op::CodeDelete { id: i },
            }
        }
        "item.label" | "edge.label" => {
            let IdText { id: i, text } = args(a)?;
            id(&i, "id")?;
            if name == "item.label" {
                Op::ItemLabel { id: i, text }
            } else {
                Op::EdgeLabel { id: i, text }
            }
        }
        "item.set_type" => {
            let SetTypeArgs { id: i, ty } = args(a)?;
            id(&i, "id")?;
            if parse_enum::<ComponentType>(&ty).is_none()
                && parse_enum::<ClassKind>(&ty).is_none()
                && parse_enum::<MetricRole>(&ty).is_none()
            {
                return Err(format!("type {ty} is unknown"));
            }
            Op::ItemSetType { id: i, ty }
        }
        "item.note.add" => {
            let IdString { id: i, text } = args(a)?;
            id(&i, "id")?;
            non_empty(&text, "text")?;
            Op::ItemNoteAdd { id: i, text }
        }
        "edge.create" => {
            let e: EdgeCreateArgs = args(a)?;
            id(&e.id, "id")?;
            id(&e.from, "from")?;
            id(&e.to, "to")?;
            Op::EdgeCreate(e)
        }
        "edge.set_dir" => {
            let SetDirArgs { id: i, dir } = args(a)?;
            id(&i, "id")?;
            Op::EdgeSetDir { id: i, dir }
        }
        "edge.set_rel" => {
            let SetRelArgs { id: i, rel } = args(a)?;
            id(&i, "id")?;
            Op::EdgeSetRel { id: i, rel }
        }
        "group.create" => {
            let g: GroupCreateArgs = args(a)?;
            id(&g.id, "id")?;
            g.members.iter().try_for_each(|m| id(m, "members[]"))?;
            Op::GroupCreate(g)
        }
        "member.add" => {
            let m: MemberAddArgs = args(a)?;
            id(&m.class_id, "class_id")?;
            check_member(&m.member)?;
            Op::MemberAdd {
                class_id: m.class_id,
                section: m.section,
                member: m.member,
            }
        }
        "member.move" => {
            let m: MemberMoveArgs = args(a)?;
            id(&m.id, "id")?;
            id(&m.to_class_id, "to_class_id")?;
            Op::MemberMove {
                id: m.id,
                to_class_id: m.to_class_id,
            }
        }
        "sticky.vote" => {
            let DeltaArgs { id: i, delta } = args(a)?;
            id(&i, "id")?;
            if delta != 1 && delta != -1 {
                return Err("delta must be 1 or -1".into());
            }
            Op::StickyVote { id: i, delta }
        }
        "sticky.set_quad" => {
            let QuadArgs { id: i, quad } = args(a)?;
            id(&i, "id")?;
            Op::StickySetQuad { id: i, quad }
        }
        "code.insert" => {
            let c: CodeInsertArgs = args(a)?;
            check_line(&c.line)?;
            Op::CodeInsert {
                line: c.line,
                after: c.after,
            }
        }
        "code.edit" => {
            let IdString { id: i, text } = args(a)?;
            id(&i, "id")?;
            Op::CodeEdit { id: i, text }
        }
        "code.move" => {
            let c: CodeMoveArgs = args(a)?;
            id(&c.id, "id")?;
            Op::CodeMove {
                id: c.id,
                after: c.after,
            }
        }
        "code.indent" => {
            let DeltaArgs { id: i, delta } = args(a)?;
            id(&i, "id")?;
            Op::CodeIndent { id: i, delta }
        }
        "code.complexity" => {
            let c: ComplexityArgs = args(a)?;
            Op::CodeComplexity {
                slot: c.slot,
                value: c.value,
            }
        }
        "code.trace" => {
            let c: TraceArgs = args(a)?;
            id(&c.line, "line")?;
            Op::CodeTrace {
                line: c.line,
                t: c.t,
            }
        }
        "code.approach" => {
            let c: ApproachArgs = args(a)?;
            if c.lines.len() > 6 {
                return Err("lines has more than 6 lines".into());
            }
            if c.lines.iter().any(|l| l.chars().count() > 120) {
                return Err("a line is longer than 120 characters".into());
            }
            Op::CodeApproach { lines: c.lines }
        }
        "agenda.check" => {
            let c: AgendaArgs = args(a)?;
            id(&c.id, "id")?;
            Op::AgendaCheck {
                id: c.id,
                done: c.done,
                t: c.t,
            }
        }
        "present.show" => {
            let c: ShowArgs = args(a)?;
            Op::PresentShow {
                kind: c.kind,
                reference: c.reference,
                t: c.t,
            }
        }
        "park.add" => {
            let TextArgs { text } = args(a)?;
            non_empty(&text, "text")?;
            Op::ParkAdd { text }
        }
        "undo" => {
            let UndoArgs { target_op_id } = args(a)?;
            non_empty(&target_op_id, "target_op_id")?;
            Op::Undo { target_op_id }
        }
        other => return Err(format!("unknown op {other}")),
    })
}

fn id_in_use(b: &Board, id: &str) -> bool {
    b.items.iter().any(|i| i.id() == id) || b.edges.iter().any(|e| e.id == id)
}

fn item_idx(b: &Board, id: &str) -> Result<usize, String> {
    b.items
        .iter()
        .position(|i| i.id() == id)
        .ok_or_else(|| format!("unknown item {id}"))
}

fn edge_mut<'a>(b: &'a mut Board, id: &str) -> Result<&'a mut Edge, String> {
    b.edges
        .iter_mut()
        .find(|e| e.id == id)
        .ok_or_else(|| format!("unknown edge {id}"))
}

fn member_ids(b: &Board) -> HashSet<&str> {
    b.items
        .iter()
        .filter_map(|i| match i {
            Item::Class(c) => Some(c),
            _ => None,
        })
        .flat_map(|c| c.fields.iter().chain(&c.methods))
        .map(|m| m.id.as_str())
        .collect()
}

/// `(item index, section, position)` of a member.
fn find_member(b: &Board, id: &str) -> Result<(usize, Section, usize), String> {
    for (idx, item) in b.items.iter().enumerate() {
        if let Item::Class(c) = item {
            for s in [Section::Fields, Section::Methods] {
                if let Some(pos) = c.section(s).iter().position(|m| m.id == id) {
                    return Ok((idx, s, pos));
                }
            }
        }
    }
    Err(format!("unknown member {id}"))
}

fn class_mut(b: &mut Board, idx: usize) -> &mut super::Class {
    match &mut b.items[idx] {
        Item::Class(c) => c,
        _ => unreachable!("checked to be a class"),
    }
}

fn code_mut(b: &mut Board) -> Result<&mut super::Code, String> {
    b.code
        .as_mut()
        .ok_or_else(|| "board has no code".to_string())
}

fn meeting_mut(b: &mut Board) -> Result<&mut super::Meeting, String> {
    b.meeting
        .as_mut()
        .ok_or_else(|| "board has no meeting".to_string())
}

fn line_idx(lines: &[CodeLine], id: &str) -> Result<usize, String> {
    lines
        .iter()
        .position(|l| l.id == id)
        .ok_or_else(|| format!("unknown line {id}"))
}

/// Position to insert at for "after `after`" (`None` = first).
fn insert_at(lines: &[CodeLine], after: Option<&str>) -> Result<usize, String> {
    match after {
        None => Ok(0),
        Some(a) => line_idx(lines, a).map(|i| i + 1),
    }
}

/// Applies the effect. Every check runs before the first change, so an `Err` leaves the board untouched.
pub(crate) fn effect(b: &mut Board, op: Op) -> Result<(), String> {
    match op {
        Op::ItemCreate(item) => {
            if id_in_use(b, item.id()) {
                return Err(format!("id {} in use", item.id()));
            }
            if let Item::Class(c) = &item {
                let mut taken = member_ids(b);
                for m in c.fields.iter().chain(&c.methods) {
                    if !taken.insert(m.id.as_str()) {
                        return Err(format!("member id {} in use", m.id));
                    }
                }
            }
            b.items.push(item);
        }
        Op::ItemMove(a) => {
            let idx = item_idx(b, &a.id)?;
            let item = &mut b.items[idx];
            if matches!(item, Item::Ink(_)) {
                return Err("ink cannot move".into());
            }
            if (a.lane.is_some() || a.rank.is_some()) && !matches!(item, Item::Sticky(_)) {
                return Err("lane and rank are for stickies".into());
            }
            match item {
                Item::Component(i) => (i.x, i.y) = (a.x, a.y),
                Item::Class(i) => (i.x, i.y) = (a.x, a.y),
                Item::Group(i) => (i.x, i.y) = (a.x, a.y),
                Item::Metric(i) => (i.x, i.y) = (a.x, a.y),
                Item::InterviewerCard(i) => (i.x, i.y) = (a.x, a.y),
                Item::Sticky(s) => {
                    (s.x, s.y) = (a.x, a.y);
                    if let Some(lane) = a.lane {
                        s.lane = lane;
                    }
                    if let Some(rank) = a.rank {
                        s.rank = rank;
                    }
                }
                Item::Ink(_) => unreachable!(),
            }
        }
        Op::ItemDelete { id } => {
            let idx = item_idx(b, &id)?;
            let removed = b.items.remove(idx);
            if matches!(removed, Item::Group(_)) {
                for it in &mut b.items {
                    if it.group() == Some(id.as_str()) {
                        it.set_group(None);
                    }
                }
            }
            b.edges.retain(|e| e.from != id && e.to != id);
            if b.focus.as_deref() == Some(id.as_str()) {
                b.focus = None;
            }
        }
        Op::ItemLabel { id, text } => {
            let idx = item_idx(b, &id)?;
            match &mut b.items[idx] {
                Item::Component(i) => i.label = text,
                Item::Class(i) => i.label = text,
                Item::Group(i) => i.label = text,
                Item::Metric(i) => i.label = text,
                Item::Sticky(s) => s.text = text.ok_or("a sticky needs text")?,
                other => return Err(format!("{} has no label", other.kind())),
            }
        }
        Op::ItemSetType { id, ty } => {
            let idx = item_idx(b, &id)?;
            let item = &mut b.items[idx];
            let bad = |kind: &str| format!("{ty} is not valid for a {kind}");
            match item {
                Item::Component(i) => i.ty = parse_enum(&ty).ok_or_else(|| bad("component"))?,
                Item::Class(i) => i.class_kind = parse_enum(&ty).ok_or_else(|| bad("class"))?,
                Item::Metric(i) => i.role = parse_enum(&ty).ok_or_else(|| bad("metric"))?,
                other => return Err(format!("{} has no type", other.kind())),
            }
        }
        Op::ItemNoteAdd { id, text } => {
            let idx = item_idx(b, &id)?;
            match &mut b.items[idx] {
                Item::Component(c) => c.notes.get_or_insert_with(Vec::new).push(text),
                _ => return Err("notes are for components".into()),
            }
        }
        Op::EdgeCreate(a) => {
            if id_in_use(b, &a.id) {
                return Err(format!("id {} in use", a.id));
            }
            if a.from == a.to {
                return Err("an edge needs two items".into());
            }
            for end in [&a.from, &a.to] {
                match b.items.iter().find(|i| i.id() == end.as_str()) {
                    Some(Item::Ink(_)) | None => return Err(format!("no item {end} to connect")),
                    Some(_) => {}
                }
            }
            b.edges.push(Edge {
                id: a.id,
                from: a.from,
                to: a.to,
                dir: a.dir.unwrap_or(Dir::Forward),
                label: a.label,
                rel: a.rel,
            });
        }
        Op::EdgeDelete { id } => {
            let idx = b
                .edges
                .iter()
                .position(|e| e.id == id)
                .ok_or_else(|| format!("unknown edge {id}"))?;
            b.edges.remove(idx);
        }
        Op::EdgeSetDir { id, dir } => edge_mut(b, &id)?.dir = dir,
        Op::EdgeSetRel { id, rel } => edge_mut(b, &id)?.rel = rel,
        Op::EdgeLabel { id, text } => edge_mut(b, &id)?.label = text,
        Op::GroupCreate(a) => {
            if id_in_use(b, &a.id) {
                return Err(format!("id {} in use", a.id));
            }
            let members: HashSet<&str> = a.members.iter().map(String::as_str).collect();
            for m in &members {
                match b.items.iter().find(|i| i.id() == *m) {
                    Some(
                        Item::Component(_) | Item::Class(_) | Item::Sticky(_) | Item::Metric(_),
                    ) => {}
                    _ => return Err(format!("{m} cannot join a group")),
                }
            }
            for it in &mut b.items {
                if members.contains(it.id()) {
                    it.set_group(Some(a.id.clone()));
                }
            }
            b.items.push(Item::Group(Group {
                id: a.id,
                label: a.label,
                x: a.x,
                y: a.y,
                w: a.w,
                h: a.h,
            }));
        }
        Op::MemberAdd {
            class_id,
            section,
            member,
        } => {
            let idx = item_idx(b, &class_id)?;
            if !matches!(b.items[idx], Item::Class(_)) {
                return Err(format!("{class_id} is not a class"));
            }
            if member_ids(b).contains(member.id.as_str()) {
                return Err(format!("member id {} in use", member.id));
            }
            class_mut(b, idx).section_mut(section).push(member);
        }
        Op::MemberMove { id, to_class_id } => {
            let (from, section, pos) = find_member(b, &id)?;
            let to = item_idx(b, &to_class_id)?;
            if !matches!(b.items[to], Item::Class(_)) {
                return Err(format!("{to_class_id} is not a class"));
            }
            if to == from {
                return Err("member is already in that class".into());
            }
            let m = class_mut(b, from).section_mut(section).remove(pos);
            class_mut(b, to).section_mut(section).push(m);
        }
        Op::MemberRemove { id } => {
            let (idx, section, pos) = find_member(b, &id)?;
            class_mut(b, idx).section_mut(section).remove(pos);
        }
        Op::StickyVote { id, delta } => {
            let idx = item_idx(b, &id)?;
            match &mut b.items[idx] {
                Item::Sticky(s) => s.votes = s.votes.saturating_add_signed(delta),
                _ => return Err("votes are for stickies".into()),
            }
        }
        Op::StickySetQuad { id, quad } => {
            let idx = item_idx(b, &id)?;
            match &mut b.items[idx] {
                Item::Sticky(s) => s.quad = quad,
                _ => return Err("quadrants are for stickies".into()),
            }
        }
        Op::CodeInsert { line, after } => {
            let code = code_mut(b)?;
            if code.lines.iter().any(|l| l.id == line.id) {
                return Err(format!("line id {} in use", line.id));
            }
            let at = insert_at(&code.lines, after.as_deref())?;
            code.lines.insert(at, line);
        }
        Op::CodeEdit { id, text } => {
            let code = code_mut(b)?;
            let i = line_idx(&code.lines, &id)?;
            code.lines[i].text = text;
        }
        Op::CodeMove { id, after } => {
            let code = code_mut(b)?;
            if after.as_deref() == Some(id.as_str()) {
                return Err("a line cannot go after itself".into());
            }
            let i = line_idx(&code.lines, &id)?;
            let mut rest = code.lines.clone();
            let line = rest.remove(i);
            let at = insert_at(&rest, after.as_deref())?;
            rest.insert(at, line);
            code.lines = rest;
        }
        Op::CodeIndent { id, delta } => {
            let code = code_mut(b)?;
            let i = line_idx(&code.lines, &id)?;
            let l = &mut code.lines[i];
            l.indent = (l.indent as i64).saturating_add(delta).clamp(0, 6) as u64;
        }
        Op::CodeDelete { id } => {
            let code = code_mut(b)?;
            let i = line_idx(&code.lines, &id)?;
            code.lines.remove(i);
        }
        Op::CodeComplexity { slot, value } => {
            let code = code_mut(b)?;
            match slot {
                Slot::Time => code.complexity.time = value,
                Slot::Space => code.complexity.space = value,
            }
        }
        Op::CodeTrace { line, t } => {
            let code = code_mut(b)?;
            line_idx(&code.lines, &line)?;
            code.trace.push(TraceEntry { line, t });
        }
        Op::CodeApproach { lines } => code_mut(b)?.approach = lines,
        Op::AgendaCheck { id, done, t } => {
            let m = meeting_mut(b)?;
            let item = m
                .agenda
                .iter_mut()
                .find(|a| a.id == id)
                .ok_or_else(|| format!("unknown agenda item {id}"))?;
            item.done = done;
            item.t = if done { t } else { None };
        }
        Op::PresentShow { kind, reference, t } => {
            meeting_mut(b)?.shown.push(Shown { kind, reference, t });
        }
        Op::ParkAdd { text } => meeting_mut(b)?.parked.push(text),
        Op::Undo { .. } => return Err("undo needs the op log".into()),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_type_and_move_reject_wrong_kinds() {
        let mut b: Board = serde_json::from_value(serde_json::json!({
            "schema": "ir.board.v1",
            "round": {"id": "s", "type": "hld", "question_id": null, "language": null},
            "rev": 0, "size": {"w": 64, "h": 40}, "brief": {"question": "q", "lines": []},
            "items": [
                {"id": "n1", "kind": "component", "type": "service", "label": null, "x": 1, "y": 1, "w": 8, "h": 5},
                {"id": "i1", "kind": "ink", "points": [[0, 0], [1, 1]], "recognized": "line"}
            ],
            "edges": [], "code": null, "meeting": null, "focus": null, "ghosts": [], "op_ids": []
        }))
        .unwrap();
        let before = b.clone();
        assert!(
            effect(
                &mut b,
                Op::ItemSetType {
                    id: "n1".into(),
                    ty: "interface".into()
                }
            )
            .is_err()
        );
        let mv: MoveArgs =
            args(&serde_json::json!({"id": "n1", "x": 1, "y": 1, "lane": null})).unwrap();
        assert!(
            effect(&mut b, Op::ItemMove(mv)).is_err(),
            "lane on a non-sticky, even null"
        );
        let mv: MoveArgs = args(&serde_json::json!({"id": "i1", "x": 1, "y": 1})).unwrap();
        assert!(
            effect(&mut b, Op::ItemMove(mv)).is_err(),
            "ink does not move"
        );
        assert!(
            effect(
                &mut b,
                Op::ItemLabel {
                    id: "i1".into(),
                    text: Some("x".into())
                }
            )
            .is_err()
        );
        assert_eq!(b, before);
        assert!(
            effect(
                &mut b,
                Op::ItemSetType {
                    id: "n1".into(),
                    ty: "db".into()
                }
            )
            .is_ok()
        );
    }
}
