//! The board: one per round, changed only by ops (`content/schema/board.v1.schema.json`, rules in docs/protocol.md,
//! Board ops). The web app implements the same rules; both are pinned by `content/fixtures/board-ops` and
//! `content/fixtures/board-undo`.
//!
//! - [`apply`]: the pure op apply (no undo, no log).
//! - [`BoardSession`]: the board plus its op log; handles undo, ghosts and rejected ops the way the server answers them.
//! - [`summary`]: the deterministic text the live interviewer gets about the board.
//! - [`reader`]: the board in plain words for the report and the scorer (no header, no ids).

pub mod apply;
pub mod reader;
mod session;
pub mod summary;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

pub use apply::{BoardError, apply};
pub use reader::reader_text;
pub use session::{ApplyOutcome, BoardSession, FOCUS_TTL};
pub use summary::summary;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BoardKit {
    Hld,
    Lld,
    Coding,
    Pm,
    Meeting,
}

impl BoardKit {
    pub fn as_str(self) -> &'static str {
        match self {
            BoardKit::Hld => "hld",
            BoardKit::Lld => "lld",
            BoardKit::Coding => "coding",
            BoardKit::Pm => "pm",
            BoardKit::Meeting => "meeting",
        }
    }
}

/// Who made an op.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Src {
    Hand,
    VoiceGrammar,
    Scribe,
    Interviewer,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ComponentType {
    Client,
    Lb,
    ApiGateway,
    Service,
    Db,
    Kv,
    Cache,
    Queue,
    Cdn,
    ObjectStore,
    Search,
    Worker,
    External,
    Note,
    Blank,
}

impl ComponentType {
    /// How the summary names the type.
    pub fn display(self) -> &'static str {
        match self {
            ComponentType::Client => "Client",
            ComponentType::Lb => "LB",
            ComponentType::ApiGateway => "API gateway",
            ComponentType::Service => "Service",
            ComponentType::Db => "DB",
            ComponentType::Kv => "KV",
            ComponentType::Cache => "Cache",
            ComponentType::Queue => "Queue",
            ComponentType::Cdn => "CDN",
            ComponentType::ObjectStore => "Object store",
            ComponentType::Search => "Search",
            ComponentType::Worker => "Worker",
            ComponentType::External => "External",
            ComponentType::Note => "Note",
            ComponentType::Blank => "Box",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClassKind {
    Class,
    Interface,
    Abstract,
    Enum,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MetricRole {
    NorthStar,
    Input,
    Guardrail,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Lane {
    User,
    Pain,
    Idea,
    Metric,
}

/// 2x2 quadrant: t/b = impact high/low, l/r = effort low/high.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Quad {
    Tl,
    Tr,
    Bl,
    Br,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Dir {
    #[serde(rename = "->")]
    Forward,
    #[serde(rename = "<->")]
    Both,
    #[serde(rename = "--")]
    Plain,
}

impl Dir {
    pub fn as_str(self) -> &'static str {
        match self {
            Dir::Forward => "->",
            Dir::Both => "<->",
            Dir::Plain => "--",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Rel {
    Uses,
    HasA,
    IsA,
    Implements,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Vis {
    #[serde(rename = "+")]
    Public,
    #[serde(rename = "-")]
    Private,
    #[serde(rename = "#")]
    Protected,
    #[serde(rename = "~")]
    Package,
}

impl Vis {
    pub fn as_str(self) -> &'static str {
        match self {
            Vis::Public => "+",
            Vis::Private => "-",
            Vis::Protected => "#",
            Vis::Package => "~",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Recognized {
    Rect,
    Line,
    Arrow,
    Circle,
}

/// `fields` or `methods` of a class.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Section {
    Fields,
    Methods,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Board {
    pub schema: String,
    pub round: RoundInfo,
    pub rev: u64,
    pub size: Size,
    pub brief: Brief,
    pub items: Vec<Item>,
    pub edges: Vec<Edge>,
    pub code: Option<Code>,
    pub meeting: Option<Meeting>,
    pub focus: Option<String>,
    pub ghosts: Vec<GhostOp>,
    pub op_ids: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RoundInfo {
    pub id: String,
    #[serde(rename = "type")]
    pub kit: BoardKit,
    pub question_id: Option<String>,
    pub language: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Size {
    pub w: f64,
    pub h: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Brief {
    pub question: String,
    pub lines: Vec<String>,
}

/// A board item, tagged by `kind`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Item {
    Component(Component),
    Class(Class),
    Sticky(Sticky),
    Group(Group),
    Metric(Metric),
    Ink(Ink),
    InterviewerCard(InterviewerCard),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Component {
    pub id: String,
    #[serde(rename = "type")]
    pub ty: ComponentType,
    #[serde(deserialize_with = "required")]
    pub label: Option<String>,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    #[serde(
        default,
        deserialize_with = "some",
        skip_serializing_if = "Option::is_none"
    )]
    pub notes: Option<Vec<String>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Member {
    pub id: String,
    pub vis: Vis,
    pub name: String,
    #[serde(rename = "type", default, skip_serializing_if = "Option::is_none")]
    pub ty: Option<String>,
    #[serde(
        default,
        deserialize_with = "some",
        skip_serializing_if = "Option::is_none"
    )]
    pub params: Option<Vec<Param>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub returns: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Param {
    pub name: String,
    #[serde(rename = "type", default, skip_serializing_if = "Option::is_none")]
    pub ty: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Class {
    pub id: String,
    #[serde(deserialize_with = "required")]
    pub label: Option<String>,
    pub class_kind: ClassKind,
    pub fields: Vec<Member>,
    pub methods: Vec<Member>,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
}

impl Class {
    pub fn section(&self, s: Section) -> &Vec<Member> {
        match s {
            Section::Fields => &self.fields,
            Section::Methods => &self.methods,
        }
    }

    pub fn section_mut(&mut self, s: Section) -> &mut Vec<Member> {
        match s {
            Section::Fields => &mut self.fields,
            Section::Methods => &mut self.methods,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Sticky {
    pub id: String,
    #[serde(deserialize_with = "required")]
    pub lane: Option<Lane>,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    pub votes: u64,
    #[serde(deserialize_with = "required")]
    pub quad: Option<Quad>,
    /// Rung on the ranked ladder, 1 = top.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rank: Option<u64>,
    pub x: f64,
    pub y: f64,
    #[serde(
        default,
        deserialize_with = "some",
        skip_serializing_if = "Option::is_none"
    )]
    pub w: Option<f64>,
    #[serde(
        default,
        deserialize_with = "some",
        skip_serializing_if = "Option::is_none"
    )]
    pub h: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Group {
    pub id: String,
    #[serde(deserialize_with = "required")]
    pub label: Option<String>,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Metric {
    pub id: String,
    pub role: MetricRole,
    #[serde(deserialize_with = "required")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    pub x: f64,
    pub y: f64,
    #[serde(
        default,
        deserialize_with = "some",
        skip_serializing_if = "Option::is_none"
    )]
    pub w: Option<f64>,
    #[serde(
        default,
        deserialize_with = "some",
        skip_serializing_if = "Option::is_none"
    )]
    pub h: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Ink {
    pub id: String,
    /// `[x, y]` in board cm.
    pub points: Vec<[f64; 2]>,
    #[serde(deserialize_with = "required")]
    pub recognized: Option<Recognized>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InterviewerCard {
    pub id: String,
    pub title: String,
    pub body: String,
    pub x: f64,
    pub y: f64,
    #[serde(
        default,
        deserialize_with = "some",
        skip_serializing_if = "Option::is_none"
    )]
    pub w: Option<f64>,
    #[serde(
        default,
        deserialize_with = "some",
        skip_serializing_if = "Option::is_none"
    )]
    pub h: Option<f64>,
}

impl Item {
    pub fn id(&self) -> &str {
        match self {
            Item::Component(i) => &i.id,
            Item::Class(i) => &i.id,
            Item::Sticky(i) => &i.id,
            Item::Group(i) => &i.id,
            Item::Metric(i) => &i.id,
            Item::Ink(i) => &i.id,
            Item::InterviewerCard(i) => &i.id,
        }
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Item::Component(_) => "component",
            Item::Class(_) => "class",
            Item::Sticky(_) => "sticky",
            Item::Group(_) => "group",
            Item::Metric(_) => "metric",
            Item::Ink(_) => "ink",
            Item::InterviewerCard(_) => "interviewer_card",
        }
    }

    /// The group this item belongs to (components, classes, stickies and metrics only).
    pub fn group(&self) -> Option<&str> {
        match self {
            Item::Component(i) => i.group.as_deref(),
            Item::Class(i) => i.group.as_deref(),
            Item::Sticky(i) => i.group.as_deref(),
            Item::Metric(i) => i.group.as_deref(),
            _ => None,
        }
    }

    /// Sets the group; false for kinds that cannot be in a group.
    pub fn set_group(&mut self, group: Option<String>) -> bool {
        match self {
            Item::Component(i) => i.group = group,
            Item::Class(i) => i.group = group,
            Item::Sticky(i) => i.group = group,
            Item::Metric(i) => i.group = group,
            _ => return false,
        }
        true
    }

    /// Bounding box `(x, y, w, h)` in board cm, with the schema's default sizes.
    pub fn rect(&self) -> (f64, f64, f64, f64) {
        match self {
            Item::Component(i) => (i.x, i.y, i.w, i.h),
            Item::Class(i) => (i.x, i.y, i.w, i.h),
            Item::Group(i) => (i.x, i.y, i.w, i.h),
            Item::Sticky(i) => (i.x, i.y, i.w.unwrap_or(7.0), i.h.unwrap_or(7.0)),
            Item::Metric(i) => (i.x, i.y, i.w.unwrap_or(10.0), i.h.unwrap_or(4.0)),
            Item::InterviewerCard(i) => (i.x, i.y, i.w.unwrap_or(14.0), i.h.unwrap_or(8.0)),
            Item::Ink(i) => {
                let (mut x0, mut y0) = (f64::INFINITY, f64::INFINITY);
                let (mut x1, mut y1) = (f64::NEG_INFINITY, f64::NEG_INFINITY);
                for [x, y] in &i.points {
                    x0 = x0.min(*x);
                    y0 = y0.min(*y);
                    x1 = x1.max(*x);
                    y1 = y1.max(*y);
                }
                if x0.is_finite() {
                    (x0, y0, x1 - x0, y1 - y0)
                } else {
                    (0.0, 0.0, 0.0, 0.0)
                }
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Edge {
    pub id: String,
    pub from: String,
    pub to: String,
    pub dir: Dir,
    #[serde(deserialize_with = "required")]
    pub label: Option<String>,
    #[serde(deserialize_with = "required")]
    pub rel: Option<Rel>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CodeLine {
    pub id: String,
    pub indent: u64,
    pub text: String,
    pub src: Src,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Code {
    pub language: String,
    pub lines: Vec<CodeLine>,
    pub approach: Vec<String>,
    pub complexity: Complexity,
    pub trace: Vec<TraceEntry>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Complexity {
    #[serde(deserialize_with = "required")]
    pub time: Option<String>,
    #[serde(deserialize_with = "required")]
    pub space: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TraceEntry {
    pub line: String,
    pub t: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Meeting {
    pub agenda: Vec<AgendaItem>,
    #[serde(
        default,
        deserialize_with = "some",
        skip_serializing_if = "Option::is_none"
    )]
    pub numbers: Option<Vec<NumberCard>>,
    pub shown: Vec<Shown>,
    pub parked: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgendaItem {
    pub id: String,
    pub text: String,
    pub done: bool,
    #[serde(deserialize_with = "required")]
    pub t: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NumberCard {
    pub id: String,
    pub label: String,
    pub value: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ShownKind {
    Slide,
    Number,
}

/// Slide: 1-based page. Number: the number card id.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ShownRef {
    Page(i64),
    Id(String),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Shown {
    pub kind: ShownKind,
    #[serde(rename = "ref")]
    pub reference: ShownRef,
    pub t: f64,
}

/// An op as applied: the `board.op` / `board.apply` payload. `op` and `args` are checked when applied, so an op
/// with an unknown name or bad args still parses (and is logged as rejected).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BoardOp {
    pub op_id: String,
    pub src: Src,
    pub op: String,
    pub args: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rev_base: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at_ms: Option<f64>,
}

impl BoardOp {
    /// The op a client sends to accept a ghost: same `op_id`, `src`, `op` and `args`.
    pub fn from_ghost(g: &GhostOp) -> BoardOp {
        BoardOp {
            op_id: g.op_id.clone(),
            src: g.src,
            op: g.op.clone(),
            args: g.args.clone(),
            rev_base: None,
            at_ms: None,
        }
    }
}

/// A Scribe suggestion not yet committed (`src` is always `scribe`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GhostOp {
    pub op_id: String,
    pub src: Src,
    pub op: String,
    pub args: Value,
}

/// One entry of the session's op log; `t` is seconds since round start, `rev` the board rev after the op.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OpLogEntry {
    pub op_id: String,
    pub t: f64,
    pub rev: u64,
    pub src: Src,
    pub op: String,
    pub args: Value,
    pub accepted: bool,
}

impl OpLogEntry {
    pub fn to_op(&self) -> BoardOp {
        BoardOp {
            op_id: self.op_id.clone(),
            src: self.src,
            op: self.op.clone(),
            args: self.args.clone(),
            rev_base: None,
            at_ms: None,
        }
    }
}

/// Longest id the server accepts (a server limit on top of the schema pattern).
pub const MAX_ID_CHARS: usize = 64;
/// Longest text field in op args (labels, notes, sticky text, member parts, code lines, parked questions).
pub const MAX_TEXT_CHARS: usize = 200;
/// Longest interviewer card body.
pub const MAX_CARD_BODY_CHARS: usize = 2000;
/// Most entries in one array in op args (members, notes, group members, params).
pub const MAX_ARRAY_LEN: usize = 200;
/// Most points in one ink stroke.
pub const MAX_INK_POINTS: usize = 5000;

/// Item and edge ids: `^[A-Za-z0-9_.:-]+$`, at most [`MAX_ID_CHARS`] long.
pub fn is_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= MAX_ID_CHARS
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'-'))
}

/// A string as one of the serde enums above (`"db"` as [`ComponentType::Db`]).
pub fn parse_enum<T: DeserializeOwned>(s: &str) -> Option<T> {
    serde_json::from_value(Value::String(s.to_string())).ok()
}

/// A required field that may be `null` (serde would otherwise accept it missing).
fn required<'de, D: Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<T, D::Error> {
    T::deserialize(d)
}

/// An optional field that must not be `null` when present.
fn some<'de, D: Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<T>, D::Error> {
    T::deserialize(d).map(Some)
}

/// An optional field where present-and-null differs from absent: `None` absent, `Some(None)` null.
fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    d: D,
) -> Result<Option<Option<T>>, D::Error> {
    Option::<T>::deserialize(d).map(Some)
}
