//! Board model, op apply, undo and the interviewer summary. The fixtures in `content/fixtures/board-ops` and
//! `content/fixtures/board-undo` are shared with the web app and must pass unchanged.

use std::path::PathBuf;

use ir_server::board::{
    self, ApplyOutcome, Board, BoardError, BoardOp, BoardSession, GhostOp, OpLogEntry, Src,
};
use serde::Deserialize;
use serde_json::{Value, json};

fn fixtures(dir: &str) -> Vec<(String, Value)> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../content/fixtures")
        .join(dir);
    let mut files: Vec<_> = std::fs::read_dir(&root)
        .unwrap_or_else(|e| panic!("reading {}: {e}", root.display()))
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .collect();
    files.sort();
    files
        .into_iter()
        .map(|p| {
            let raw = std::fs::read_to_string(&p).unwrap();
            (
                p.file_name().unwrap().to_string_lossy().into_owned(),
                serde_json::from_str(&raw).unwrap(),
            )
        })
        .collect()
}

#[derive(Deserialize)]
struct OpsFixture {
    name: String,
    start: Board,
    ops: Vec<Value>,
    expected: Board,
}

#[derive(Deserialize)]
struct UndoFixture {
    name: String,
    start: Board,
    log: Vec<OpLogEntry>,
    undo: BoardOp,
    expected: Board,
}

#[test]
fn applies_fixture_sequences() {
    let all = fixtures("board-ops");
    assert_eq!(all.len(), 16, "expected the 16 shared op fixtures");
    for (file, raw) in all {
        let fx: OpsFixture = serde_json::from_value(raw).unwrap_or_else(|e| panic!("{file}: {e}"));
        let mut session = BoardSession::new(fx.start);
        for op in &fx.ops {
            session.apply_client_value_at(op, 1.0);
        }
        assert_eq!(session.board, fx.expected, "{file}: {}", fx.name);
    }
}

#[test]
fn applies_undo_fixtures() {
    let all = fixtures("board-undo");
    assert_eq!(all.len(), 6, "expected the 6 shared undo fixtures");
    for (file, raw) in all {
        let fx: UndoFixture = serde_json::from_value(raw).unwrap_or_else(|e| panic!("{file}: {e}"));
        let mut session = BoardSession::new(fx.start);
        for entry in &fx.log {
            if entry.accepted {
                let out = session.apply_client_op_at(entry.to_op(), entry.t);
                assert!(
                    matches!(out, ApplyOutcome::Accepted { rev } if rev == entry.rev),
                    "{file}: log entry {} gave {out:?}",
                    entry.op_id
                );
            } else {
                session.record_rejected(&entry.to_op(), entry.t);
            }
        }
        session.apply_client_op_at(fx.undo.clone(), 99.0);
        assert_eq!(session.board, fx.expected, "{file}: {}", fx.name);
    }
}

fn hld_board(rev: u64) -> Board {
    serde_json::from_value(json!({
        "schema": "ir.board.v1",
        "round": {"id": "s1", "type": "hld", "question_id": null, "language": null},
        "rev": rev,
        "size": {"w": 64, "h": 40},
        "brief": {"question": "Design a URL shortener", "lines": []},
        "items": [
            {"id": "n1", "kind": "component", "type": "client", "label": "Mobile app", "x": 2, "y": 2, "w": 8, "h": 5},
            {"id": "n2", "kind": "component", "type": "lb", "label": null, "x": 14, "y": 2, "w": 8, "h": 5},
            {"id": "n3", "kind": "component", "type": "service", "label": "Shortener", "x": 26, "y": 2, "w": 8, "h": 5,
             "notes": ["stateless", "base62"]},
            {"id": "n5", "kind": "component", "type": "kv", "label": "URL store", "x": 38, "y": 2, "w": 8, "h": 5},
            {"id": "i1", "kind": "ink", "points": [[1, 30], [6, 33]], "recognized": null}
        ],
        "edges": [
            {"id": "e1", "from": "n1", "to": "n2", "dir": "->", "label": null, "rel": null},
            {"id": "e2", "from": "n2", "to": "n3", "dir": "->", "label": null, "rel": null},
            {"id": "e4", "from": "n3", "to": "n5", "dir": "->", "label": null, "rel": null}
        ],
        "code": null, "meeting": null, "focus": null, "ghosts": [], "op_ids": []
    }))
    .unwrap()
}

fn op(op_id: &str, name: &str, args: Value) -> BoardOp {
    serde_json::from_value(json!({"op_id": op_id, "src": "hand", "op": name, "args": args}))
        .unwrap()
}

#[test]
fn duplicate_op_id_is_ignored() {
    let mut session = BoardSession::new(hld_board(0));
    let mv = op("o1", "item.move", json!({"id": "n1", "x": 5, "y": 5}));
    assert_eq!(
        session.apply_client_op_at(mv, 1.0),
        ApplyOutcome::Accepted { rev: 1 }
    );
    let again = op("o1", "item.move", json!({"id": "n1", "x": 9, "y": 9}));
    assert_eq!(
        session.apply_client_op_at(again.clone(), 2.0),
        ApplyOutcome::Duplicate
    );
    assert_eq!(session.board.rev, 1);
    assert_eq!(session.op_log.len(), 1, "duplicates are not logged twice");

    // The pure apply is idempotent too: same rev back, nothing changed.
    let mut b = session.board.clone();
    assert_eq!(board::apply(&mut b, &again), Ok(1));
    assert_eq!(b, session.board);
}

#[test]
fn rejected_op_leaves_board_unchanged_and_session_drops_its_ghost() {
    let mut start = hld_board(0);
    start.ghosts = vec![serde_json::from_value::<GhostOp>(json!({
        "op_id": "g1", "src": "scribe", "op": "item.label", "args": {"id": "n9", "text": "Orders"}
    }))
    .unwrap()];
    let bad = op("g1", "item.label", json!({"id": "n9", "text": "Orders"}));

    let mut b = start.clone();
    assert!(matches!(
        board::apply(&mut b, &bad),
        Err(BoardError::Rejected(_))
    ));
    assert_eq!(
        b, start,
        "the pure apply leaves the board exactly as it was"
    );

    let mut session = BoardSession::new(start);
    let out = session.apply_client_op_at(bad, 3.0);
    assert!(
        matches!(&out, ApplyOutcome::Rejected { code, ghost_dropped: true, .. } if code == "op_rejected"),
        "{out:?}"
    );
    assert!(session.board.ghosts.is_empty());
    assert_eq!(session.board.rev, 0);
    let last = session.op_log.last().unwrap();
    assert!(!last.accepted);
    assert_eq!(last.rev, 0);
}

#[test]
fn schema_invalid_args_are_rejected() {
    let mut b = hld_board(0);
    let cases = [
        op("x1", "item.move", json!({"id": "n1", "x": 1})),
        op(
            "x2",
            "item.move",
            json!({"id": "n1", "x": 1, "y": 1, "z": 2}),
        ),
        op(
            "x3",
            "item.create",
            json!({"id": "bad id", "kind": "component", "type": "db", "label": null,
            "x": 1, "y": 1, "w": 8, "h": 5}),
        ),
        op(
            "x4",
            "item.create",
            json!({"id": "n9", "kind": "component", "type": "db",
            "x": 1, "y": 1, "w": 8, "h": 5}),
        ),
        op(
            "x5",
            "item.create",
            json!({"id": "n9", "kind": "component", "type": "db", "label": null,
            "x": 1, "y": 1, "w": 8, "h": 5, "color": "red"}),
        ),
        op(
            "x6",
            "edge.create",
            json!({"id": "e9", "from": "n1", "to": "n3", "dir": null}),
        ),
        op("x7", "sticky.vote", json!({"id": "n1", "delta": 2})),
        op(
            "x8",
            "code.approach",
            json!({"lines": ["a", "b", "c", "d", "e", "f", "g"]}),
        ),
        op("x9", "no.such_op", json!({})),
        op("x10", "item.note.add", json!({"id": "n1", "text": ""})),
        op(
            "x11",
            "item.create",
            json!({"id": "i9", "kind": "ink", "points": [[1, 2]], "recognized": null}),
        ),
    ];
    for c in cases {
        let before = b.clone();
        let res = board::apply(&mut b, &c);
        assert!(
            matches!(res, Err(BoardError::Invalid(_))),
            "{}: {res:?}",
            c.op_id
        );
        assert_eq!(b, before);
    }
}

#[test]
fn raw_frames_without_op_id_or_src_are_answered_but_not_logged() {
    let mut session = BoardSession::new(hld_board(0));
    let out = session.apply_client_value_at(
        &json!({"src": "hand", "op": "item.delete", "args": {"id": "n1"}}),
        1.0,
    );
    assert!(matches!(out, ApplyOutcome::Rejected { .. }));
    let out = session.apply_client_value_at(
        &json!({"op_id": "o1", "src": "robot", "op": "item.delete", "args": {"id": "n1"}}),
        1.0,
    );
    assert!(matches!(out, ApplyOutcome::Rejected { .. }));
    assert!(session.op_log.is_empty());
    // A usable op_id and src with a bad op name is logged as not accepted.
    let out = session.apply_client_value_at(
        &json!({"op_id": "o2", "src": "hand", "op": "item.explode", "args": {}}),
        1.0,
    );
    assert!(matches!(out, ApplyOutcome::Rejected { .. }));
    assert_eq!(session.op_log.len(), 1);
    assert_eq!(session.op_log[0].op, "item.explode");
    assert_eq!(session.board.items.len(), 5);
}

#[test]
fn ghosts_are_set_rejected_and_skipped_once_committed() {
    let mut session = BoardSession::new(hld_board(0));
    let g = |id: &str, text: &str| -> GhostOp {
        serde_json::from_value(json!({"op_id": id, "src": "scribe", "op": "item.label", "args": {"id": "n2", "text": text}}))
            .unwrap()
    };
    session.set_ghosts(vec![g("g1", "Edge LB"), g("g2", "Front LB")]);
    assert_eq!(session.ghosts().len(), 2);

    // Accepting g1: the client sends it as a normal op with the same op_id.
    let accept = BoardOp {
        src: Src::Scribe,
        ..op("g1", "item.label", json!({"id": "n2", "text": "Edge LB"}))
    };
    assert_eq!(
        session.apply_client_op_at(accept, 2.0),
        ApplyOutcome::Accepted { rev: 1 }
    );
    assert_eq!(
        session
            .ghosts()
            .iter()
            .map(|g| g.op_id.as_str())
            .collect::<Vec<_>>(),
        ["g2"]
    );

    // A committed op_id never comes back as a ghost.
    session.set_ghosts(vec![g("g1", "Edge LB"), g("g3", "LB")]);
    assert_eq!(
        session
            .ghosts()
            .iter()
            .map(|g| g.op_id.as_str())
            .collect::<Vec<_>>(),
        ["g3"]
    );

    assert!(session.reject_ghost_at("g3", 3.0));
    assert!(session.ghosts().is_empty());
    assert!(
        !session.reject_ghost_at("nope", 3.0),
        "unknown op_id is ignored"
    );
    let last = session.op_log.last().unwrap();
    assert_eq!(
        (last.op_id.as_str(), last.accepted, last.src),
        ("g3", false, Src::Scribe)
    );
    assert_eq!(session.board.rev, 1);
}

#[test]
fn server_ops_get_fresh_ids() {
    let mut session = BoardSession::new(hld_board(0));
    let id = session.fresh_item_id("card");
    let (sent, out) = session.apply_server_op_at(
        Src::Interviewer,
        "item.create",
        json!({"id": id, "kind": "interviewer_card", "title": "Example", "body": "[2, 7, 11]", "x": 40, "y": 30}),
        5.0,
    );
    assert_eq!(out, ApplyOutcome::Accepted { rev: 1 });
    assert_eq!(sent.src, Src::Interviewer);
    assert!(session.board.op_ids.contains(&sent.op_id));
    let (second, _) =
        session.apply_server_op_at(Src::Interviewer, "item.delete", json!({"id": id}), 6.0);
    assert_ne!(second.op_id, sent.op_id);
    assert_ne!(session.fresh_item_id("card"), id);
}

const EXAMPLE: &str = r#"[Board update r37, do not read aloud]
HLD "Design a URL shortener". 5 components, 4 links.
Components: n1 Client "Mobile app"; n2 LB; n3 Service "Shortener" (stateless, base62); n4 Cache "Redis"; n5 KV "URL store".
Links: e1 n1->n2; e2 n2->n3; e3 n3->n4 "read-through"; e4 n3->n5.
Changed since r35: +n4 Cache "Redis", +e3 n3->n4 "read-through".
Unlabelled: none. Ink: 1 stroke (unrecognised)."#;

fn example_session() -> BoardSession {
    let mut session = BoardSession::new(hld_board(35));
    session.apply_client_op_at(
        op(
            "o36",
            "item.create",
            json!({"id": "n4", "kind": "component", "type": "cache", "label": "Redis",
            "x": 26, "y": 12, "w": 8, "h": 5}),
        ),
        60.0,
    );
    session.apply_client_op_at(
        op(
            "o37",
            "edge.create",
            json!({"id": "e3", "from": "n3", "to": "n4", "label": "read-through"}),
        ),
        61.0,
    );
    session
}

#[test]
fn summary_matches_example() {
    let session = example_session();
    assert_eq!(session.summary(Some(35)), EXAMPLE);
    // Without a previous rev there is no diff line.
    let plain = session.summary(None);
    assert!(!plain.contains("Changed since"));
    assert!(plain.starts_with("[Board update r37, do not read aloud]\nHLD \"Design a URL shortener\". 5 components, 4 links.\n"));
    // Nothing changed since the current rev.
    assert!(
        session
            .summary(Some(37))
            .contains("\nChanged since r37: none.\n")
    );
}

#[test]
fn summary_diff_lists_changes_and_removals() {
    let mut session = example_session();
    session.apply_client_op_at(op("o38", "item.delete", json!({"id": "n2"})), 70.0);
    session.apply_client_op_at(
        op(
            "o39",
            "item.label",
            json!({"id": "n3", "text": "Shortener v2"}),
        ),
        71.0,
    );
    session.apply_client_op_at(
        op("o40", "item.move", json!({"id": "n5", "x": 40, "y": 20})),
        72.0,
    );
    let text = session.summary(Some(37));
    assert!(
        text.contains(
            "\nChanged since r37: ~n3 Service \"Shortener v2\" (stateless, base62), ~n5 moved, -n2 LB, -e1 n1->n2, -e2 n2->n3.\n"
        ),
        "{text}"
    );
}

#[test]
fn summary_diff_survives_undo() {
    let mut session = example_session();
    session.apply_client_op_at(op("u1", "undo", json!({"target_op_id": "o36"})), 80.0);
    // The undo removed n4 and, on replay, the edge that needed it.
    let text = session.summary(Some(37));
    assert!(
        text.contains("\nChanged since r37: -n4 Cache \"Redis\", -e3 n3->n4 \"read-through\".\n"),
        "{text}"
    );
    assert!(
        session
            .summary(Some(35))
            .contains("\nChanged since r35: none.\n")
    );
}

#[test]
fn summary_is_byte_deterministic_whatever_the_item_order() {
    let session = example_session();
    let mut shuffled = session.board.clone();
    shuffled.items.reverse();
    shuffled.edges.reverse();
    assert_eq!(
        board::summary(&session.board, None),
        board::summary(&shuffled, None)
    );
}

#[test]
fn summary_caps_at_40_items() {
    let mut b = hld_board(0);
    b.items.clear();
    b.edges.clear();
    for i in 1..=45 {
        let item = json!({"id": format!("n{i}"), "kind": "component", "type": if i > 42 { "db" } else { "service" },
            "label": format!("S{i}"), "x": 1, "y": 1, "w": 8, "h": 5});
        b.items.push(serde_json::from_value(item).unwrap());
    }
    for i in 1..=44 {
        let e = json!({"id": format!("e{i}"), "from": format!("n{i}"), "to": format!("n{}", i + 1), "dir": "->",
            "label": null, "rel": null});
        b.edges.push(serde_json::from_value(e).unwrap());
    }
    let text = board::summary(&b, None);
    assert!(
        text.contains("HLD \"Design a URL shortener\". 45 components, 44 links.\n"),
        "{text}"
    );
    let components = text
        .lines()
        .find(|l| l.starts_with("Components: "))
        .unwrap();
    assert_eq!(components.matches("; ").count() + 1, 40);
    assert!(
        components.contains("n9 Service \"S9\"; n10 Service \"S10\""),
        "natural id order: {components}"
    );
    assert!(components.ends_with("n40 Service \"S40\"."));
    assert!(
        text.contains("\nNot listed: 5 more items (3 DB, 2 Service).\n"),
        "{text}"
    );
    let links = text.lines().find(|l| l.starts_with("Links: ")).unwrap();
    assert!(links.ends_with("e40 n40->n41; and 4 more."), "{links}");
}

#[test]
fn summary_prints_lld_classes_with_signatures() {
    let b: Board = serde_json::from_value(json!({
        "schema": "ir.board.v1",
        "round": {"id": "s1", "type": "lld", "question_id": null, "language": null},
        "rev": 5, "size": {"w": 64, "h": 40},
        "brief": {"question": "Design a parking lot", "lines": ["Cars and motorbikes", "Three levels"]},
        "items": [
            {"id": "c1", "kind": "class", "label": "ParkingLot", "class_kind": "class", "x": 2, "y": 2, "w": 14, "h": 10,
             "fields": [{"id": "m1", "vis": "-", "name": "levels", "type": "List<Level>"}],
             "methods": [{"id": "m2", "vis": "+", "name": "park", "params": [{"name": "vehicle", "type": "Vehicle"}], "returns": "Ticket"}]},
            {"id": "c2", "kind": "class", "label": "Level", "class_kind": "class", "fields": [], "methods": [], "x": 20, "y": 2, "w": 14, "h": 10},
            {"id": "c3", "kind": "class", "label": "Vehicle", "class_kind": "interface", "fields": [], "methods": [], "x": 2, "y": 20, "w": 14, "h": 10},
            {"id": "c4", "kind": "class", "label": "Car", "class_kind": "class", "fields": [], "methods": [], "x": 20, "y": 20, "w": 14, "h": 10}
        ],
        "edges": [
            {"id": "e1", "from": "c1", "to": "c2", "dir": "->", "label": "1..*", "rel": "has_a"},
            {"id": "e2", "from": "c4", "to": "c3", "dir": "->", "label": null, "rel": "implements"}
        ],
        "code": null, "meeting": null, "focus": null, "ghosts": [], "op_ids": []
    }))
    .unwrap();
    assert_eq!(
        board::summary(&b, None),
        "[Board update r5, do not read aloud]\n\
         LLD \"Design a parking lot\". 4 classes, 2 relations.\n\
         Brief: Cars and motorbikes; Three levels.\n\
         Classes: c1 ParkingLot{-levels:List<Level>; +park(vehicle:Vehicle):Ticket}; c2 Level{}; c3 interface Vehicle{}; c4 Car{}.\n\
         Relations: e1 c1 has_a c2 \"1..*\"; e2 c4 implements c3.\n\
         Unlabelled: none. Ink: none."
    );
}

#[test]
fn summary_prints_numbered_code_approach_and_complexity() {
    let b: Board = serde_json::from_value(json!({
        "schema": "ir.board.v1",
        "round": {"id": "s1", "type": "coding", "question_id": "two_sum", "language": "python"},
        "rev": 3, "size": {"w": 64, "h": 40},
        "brief": {"question": "Two sum", "lines": []},
        "items": [], "edges": [],
        "code": {"language": "python",
            "lines": [
                {"id": "l1", "indent": 0, "text": "def two_sum(nums, target):", "src": "scribe"},
                {"id": "l2", "indent": 1, "text": "seen = {}", "src": "scribe"},
                {"id": "l3", "indent": 1, "text": "for i, n in enumerate(nums):", "src": "hand"}
            ],
            "approach": ["hash map of seen values", "one pass"],
            "complexity": {"time": "O(n)", "space": null},
            "trace": [{"line": "l3", "t": 30}, {"line": "l2", "t": 35}]},
        "meeting": null, "focus": null, "ghosts": [], "op_ids": []
    }))
    .unwrap();
    assert_eq!(
        board::summary(&b, None),
        "[Board update r3, do not read aloud]\n\
         Coding \"Two sum\". 3 code lines.\n\
         Approach: hash map of seen values; one pass.\n\
         Complexity: time O(n), space ?.\n\
         Code (python):\n\
         1 l1: def two_sum(nums, target):\n\
         2 l2:     seen = {}\n\
         3 l3:     for i, n in enumerate(nums):\n\
         Trace: 2 steps, last l3, l2.\n\
         Unlabelled: none. Ink: none."
    );
}

#[test]
fn summary_prints_pm_lanes_groups_votes_and_quadrants() {
    let b: Board = serde_json::from_value(json!({
        "schema": "ir.board.v1",
        "round": {"id": "s1", "type": "pm", "question_id": null, "language": null},
        "rev": 2, "size": {"w": 64, "h": 40},
        "brief": {"question": "Improve rentals for students", "lines": []},
        "items": [
            {"id": "s1", "kind": "sticky", "lane": "user", "text": "Students", "votes": 2, "quad": null, "x": 1, "y": 1},
            {"id": "s2", "kind": "sticky", "lane": "pain", "text": "Deposits get lost", "votes": 0, "quad": "tl", "group": "g1", "x": 1, "y": 9},
            {"id": "s3", "kind": "sticky", "lane": "pain", "text": "Scams", "votes": 1, "quad": null, "group": "g1", "x": 9, "y": 9},
            {"id": "s4", "kind": "sticky", "lane": "idea", "text": "Verified listings", "votes": 0, "quad": "tl", "rank": 1, "x": 1, "y": 17},
            {"id": "s5", "kind": "sticky", "lane": null, "text": "Android share link broke", "votes": 0, "quad": null, "x": 30, "y": 1},
            {"id": "m1", "kind": "metric", "role": "north_star", "label": "Leases signed", "x": 40, "y": 30},
            {"id": "g1", "kind": "group", "label": "Trust", "x": 0, "y": 8, "w": 18, "h": 9}
        ],
        "edges": [],
        "code": null, "meeting": null, "focus": null, "ghosts": [], "op_ids": []
    }))
    .unwrap();
    assert_eq!(
        board::summary(&b, None),
        "[Board update r2, do not read aloud]\n\
         PM \"Improve rentals for students\". 5 stickies, 1 metric, 1 group.\n\
         Users: s1 \"Students\" (2 votes).\n\
         Pain points: s2 \"Deposits get lost\"; s3 \"Scams\" (1 vote).\n\
         Ideas: s4 \"Verified listings\".\n\
         Other stickies: s5 \"Android share link broke\".\n\
         Metrics: m1 north star \"Leases signed\".\n\
         Groups: g1 \"Trust\" (s2, s3; 1 vote).\n\
         Quadrants (top = high impact, left = low effort): tl s2, s4; tr none; bl none; br none.\n\
         Ladder: 1 s4.\n\
         Unlabelled: none. Ink: none."
    );
}

#[test]
fn summary_prints_meeting_agenda_screen_and_parking_lot() {
    let b: Board = serde_json::from_value(json!({
        "schema": "ir.board.v1",
        "round": {"id": "s1", "type": "meeting", "question_id": null, "language": null},
        "rev": 4, "size": {"w": 64, "h": 40},
        "brief": {"question": "Pitch a 4 day week", "lines": []},
        "items": [], "edges": [], "code": null,
        "meeting": {
            "agenda": [{"id": "a1", "text": "Pricing", "done": true, "t": 200}, {"id": "a2", "text": "Rollout", "done": false, "t": null}],
            "numbers": [{"id": "k1", "label": "ARR", "value": "$2.1M"}],
            "shown": [{"kind": "slide", "ref": 1, "t": 10}, {"kind": "number", "ref": "k1", "t": 220}],
            "parked": ["What about churn?"]
        },
        "focus": null, "ghosts": [], "op_ids": []
    }))
    .unwrap();
    assert_eq!(
        board::summary(&b, None),
        "[Board update r4, do not read aloud]\n\
         Meeting \"Pitch a 4 day week\". Agenda 1 of 2 done.\n\
         Agenda: [x] a1 \"Pricing\" (at 3:20); [ ] a2 \"Rollout\".\n\
         On screen: number k1 ARR = $2.1M (since 3:40).\n\
         Parked: \"What about churn?\".\n\
         Numbers: k1 ARR = $2.1M.\n\
         Unlabelled: none. Ink: none."
    );
}

#[test]
fn board_round_trips_through_json() {
    for (file, raw) in fixtures("board-ops") {
        let fx: OpsFixture = serde_json::from_value(raw.clone()).unwrap();
        let back: Value = serde_json::to_value(&fx.expected).unwrap();
        let again: Board = serde_json::from_value(back.clone()).unwrap();
        assert_eq!(again, fx.expected, "{file}");
        // Required nullable fields stay present as null.
        assert!(
            back.get("focus").is_some() && back.get("code").is_some(),
            "{file}"
        );
    }
}
