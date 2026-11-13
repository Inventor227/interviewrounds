# Protocol

The contract between the web app and the server. Shapes of the board, the report and the content files live in
`content/schema/` (JSON Schema draft 2020-12); the types in `web/src/shared/types.ts` and the Rust structs mirror them and
this file exactly.

## REST

JSON; cookie `ir_id` identifies the device/user; all under same origin.

- `GET /api/content/catalog` → `{roles, rounds:[RoundPublic], meeting_templates, personas:[PersonaPublic]}`
- `POST /api/sessions` `{mode:"interview"|"meeting", round_id?, meeting_plan_id?, length:"short"|"full",
  level:"junior"|"mid"|"senior"|"staff", style:"warm"|"neutral"|"tough", voice:"fish"|"fake", parent_session_id?}` →
  `CreateSessionRes {session_id, client_token, ws_url, round:RoundPublic, panel:[Panelist], floor, panel_mode:"swap"|"joined", limits}`
  where `Panelist {panelist_id, persona_id, display_name, title, avatar_id, seat:0|1|2, voice:{transport:"fish", fish:{session_token, livekit_url}}|{transport:"fake"}|{transport:"fish_pending"}}`
- `POST /api/sessions/{id}/panelists/{pid}/join` `{opening_line?}` → `{voice}` (swap mode hand-over)
- `POST /api/sessions/{id}/resume` → `CreateSessionRes` (same `session_id`, new tokens)
- `POST /api/sessions/{id}/end` `{reason:"completed"|"user_ended"|"time_limit"|"disconnected"|"headset_removed"}` → 202
- `GET /api/sessions/{id}` → `{status:"created"|"live"|"paused"|"scoring"|"scored"|"failed"|"abandoned", report_ready}`
- `GET /api/sessions/{id}/report` → `Report` (404 until ready)
- `POST /api/sessions/{id}/board-image` (body `image/png`, ≤ 2 MB) → 204
- `POST /api/sessions/{id}/retry` → `CreateSessionRes` (2-minute re-ask of the weakest moment)
- `GET /api/me` → `{identity:{kind:"guest"|"user", name?, email?}, sign_in_available, settings, onboarding_done,
  streak:{current, best, today_done}, daily:{round_id, title}, limits, entitlements}`
- `GET /api/me/history?role=` → `[{session_id, round_id, title, started_at, headline}]`
- `GET /api/me/skills?role=` → `{competencies:[{id, name, points:[{session_id, at, score}]}]}`
- `PUT /api/me/settings` `Settings`; `POST /api/me/onboarding-done`; `DELETE /api/me`
- `POST /api/meetings/prepare` `MeetingSetup` → `{meeting_plan_id, plan:MeetingPlan}`
- `POST /api/shares` `{session_id, include_transcript}` → `{slug, url}`; `DELETE /api/shares/{slug}`
- `GET /s/{slug}` server-rendered scorecard; `GET /auth/google/start`, `/auth/google/callback`, `POST /auth/logout`
- `POST /v1/chat/completions` Fish custom LLM (bearer `FISH_LLM_SECRET`, or the session `client_token` when the session's
  voice is `fake`); OpenAI chat format in, SSE `chat.completion.chunk` out
- `GET /healthz`

## WebSocket

`/ws/session/{id}`: envelope `{"t": type, "seq": n, "d": {...}}`, server acks with `seq`; ping every 20 s.

- Client → server: `hello {client_token, last_seq}` (first frame), `board.op {op_id, rev_base, src, op, args, at_ms}`,
  `transcript.mark {segment_id, panelist_id, first_at_ms, final_at_ms, text}`, `head.samples {samples:[{t_ms, yaw, pitch,
  speaking, target}]}`, `voice.state {panelist_id, mode:"listening"|"thinking"|"speaking", at_ms}`,
  `ui.event {kind:"pause"|"resume"|"end"|"hint"|"skip_onboarding", reason?}`, `board.ghost_reject {op_id}` (dismiss a
  Scribe suggestion), `ping`
- Server → client: `round.state {status, phase_id, phase_index, phases, elapsed_s, remaining_s, phase_remaining_s, brief:{question, lines}, floor}`,
  `panel.hand_over {from, to, opening_line}`, `board.ack {op_id, rev}`, `board.ghosts {ghosts:[GhostOp]}`,
  `board.apply {op_id, rev, src, op, args}` (server-originated ops), `avatar.point_at {panelist_id, item_id}`,
  `round.ending {closing_line}`, `round.ended {reason}`, `report.progress {stage:"metrics"|"scoring"|"done", pct}`,
  `report.ready {session_id}`, `error {code, message}`, `pong`
- Marker texts the browser sends into the voice session as a typed user turn: `[event: start]`, `[event: time_check]`,
  `[event: handover]`, `[event: resume]`, `[event: silence_check]`, `[event: ending]`.

## Types

Defined by schema (mirror them field for field):

| Type | Schema |
|---|---|
| `Board` | `content/schema/board.v1.schema.json` |
| `BoardOp` (payload of `board.op` without `rev_base`/`at_ms`, of `board.apply` without `rev`) | `board.v1.schema.json#/$defs/board_op` |
| `GhostOp` | `board.v1.schema.json#/$defs/ghost_op` |
| `OpLogEntry` | `board.v1.schema.json#/$defs/op_log_entry` |
| `Report` | `content/schema/report.v1.schema.json` |
| `RoundConfig` | `content/schema/round.schema.json` |
| `Persona` | `content/schema/persona.schema.json` |
| `Attendee` | `content/schema/attendee.schema.json` |
| `MeetingTemplate` | `content/schema/meeting-template.schema.json` |
| `Settings` | `content/schema/settings.schema.json` |
| `MeetingSetup` | `content/schema/meeting-setup.schema.json` |
| `MeetingPlan` (server side, with `attendees[].hidden`) | `content/schema/meeting-plan.schema.json` |
| `Me` (response of `GET /api/me`) | `content/schema/me.schema.json` |
| `Limits` (`limits` in `GET /api/me` and `CreateSessionRes`) | `me.schema.json#/$defs/limits` |
| `Entitlements` | `me.schema.json#/$defs/entitlements` |

Derived from the schemas (the server strips prompt-only fields before sending):

- `RoundPublic {id, title, summary?, role, round_type, length, target_minutes, phases:[{id, title?, minutes}], hands,
  board_kit, panel:{lead, second}}`: a `RoundConfig` without phase goals, `must_cover`, `rubric_id`, `question_pool`,
  `silence_wait_seconds` and `interrupt_after_seconds`.
- `PersonaPublic {id, display_name, title, avatar_id, style}`.

- `MeetingPlanPublic`: what `POST /api/meetings/prepare` returns as `plan`. It is the `MeetingPlan` with every
  `attendees[].hidden` block removed (stance, concerns, patience, persona, avatar and voice stay on the server). The
  suggested objections the setup page shows are in each attendee's `likely_objections`, which stays.
- `Limits {short_left_today: int|null, full_left: int|null, resets_at: date-time|null, reason: null|"guest_daily_limit"|
  "guest_full_used"|"judge_budget_reached"|"build_budget_reached"|"free_rounds_used"}`: `null` counts mean no limit;
  a non-null `reason` means a new session is blocked.
- `Entitlements {plan: "guest"|"free"|"sprint"|"pro", free_rounds_left: int|null, minutes_total: int|null,
  minutes_used: number|null, period_end: date-time|null}`.

Validating with Ajv: use draft 2020-12 (`ajv/dist/2020`) with `allowUnionTypes: true`; add `ajv-formats` for `date-time`.
`meeting-template`, `meeting-setup` and `meeting-plan` reference `attendee.schema.json`, and `me` references
`settings.schema.json`, so load those alongside.

## Content mapping

- Persona `style` is one of `warm`, `neutral`, `tough`. Sam (described as warm-neutral) is `warm`.
- Attendee `personality` is one of `supportive`, `neutral`, `skeptical`, `hostile`. Map other words: impatient →
  `skeptical`; defensive → `skeptical`; friendly but firm → `neutral`.

## Board ops

One board per session (`Board`), changed only by ops. The web app (`applyOp`) and the server (`board::apply`) implement
the same rules, pinned by `content/fixtures/board-ops/*.json`.

### Apply

1. **Duplicate**: if `op_id` is already in `board.op_ids`, nothing changes (no rev change, no error). Replays after a
   reconnect are safe.
2. **Reject**: if the args do not match the schema, or the rules below reject the op, nothing changes: `rev` and `op_ids`
   stay as they were. The server logs it with `accepted: false` and answers `error {code: "op_rejected", message, op_id}`.
   The Rust apply returns `Err`; the TypeScript `applyOp` returns the board unchanged.
3. **Commit**: apply the effect, then `rev += 1`, append `op_id` to `op_ids`, and remove the ghost with the same `op_id`
   if there is one. The server answers the sender with `board.ack {op_id, rev}` and sends `board.apply` to other clients.
4. `rev_base` is informational: ops are applied in arrival order whatever their `rev_base`.
5. Ids: item and edge ids are unique together on one board; member ids are unique across all classes; code line ids and
   agenda ids are unique in their lists. An op that would reuse an id still on the board is rejected. Clients never reuse
   an id after a delete (apply does not track deleted ids).
6. `focus` is client state: no op sets it. `item.delete` of the focused item sets it to `null`.
7. Arrays keep insertion order. New items, edges, members, trace entries, `shown` and `parked` entries are appended.

### Effects

| Op | Args | Effect (reject when) |
|---|---|---|
| `item.create` | the full item | Appended exactly as given (id in use) |
| `item.move` | `{id, x, y, lane?, rank?}` | Sets `x`, `y`; for stickies also `lane` / `rank` when present, absent = unchanged (unknown id; ink; `lane`/`rank` on a non-sticky) |
| `item.delete` | `{id}` | Removes the item and every edge whose `from` or `to` is `id`; deleting a group sets `group: null` on its members; clears `focus` if it was `id` (unknown id) |
| `item.label` | `{id, text}` | Sets `label` (component, class, group, metric) or `text` (sticky) (unknown id; ink or interviewer card; `null` on a sticky) |
| `item.set_type` | `{id, type}` | Sets `type` (component), `class_kind` (class) or `role` (metric) (value not valid for that kind) |
| `item.note.add` | `{id, text}` | Appends to the component's `notes`, creating the array (not a component) |
| `edge.create` | `{id, from, to, dir?, label?, rel?}` | Appends `{id, from, to, dir: dir ?? "->", label: label ?? null, rel: rel ?? null}` (id in use; `from` or `to` not an existing non-ink item; `from == to`) |
| `edge.delete` | `{id}` | Removes the edge (unknown id) |
| `edge.set_dir` / `edge.set_rel` / `edge.label` | `{id, dir}` / `{id, rel}` / `{id, text}` | Sets `dir` / `rel` / `label` (unknown id) |
| `group.create` | `{id, label, x, y, w, h, members}` | Appends a group item; sets `group: id` on each member (id in use; a member that is not a component, class, sticky or metric) |
| `member.add` | `{class_id, section, member}` | Appends to the class's `fields` or `methods` (no such class; member id in use) |
| `member.move` | `{id, to_class_id}` | Moves the member to the end of the same section in the target class (unknown member or class; same class) |
| `member.remove` | `{id}` | Removes the member (unknown member) |
| `sticky.vote` | `{id, delta: 1\|-1}` | `votes = max(0, votes + delta)` (not a sticky) |
| `sticky.set_quad` | `{id, quad}` | Sets `quad` (not a sticky) |
| `code.insert` | `{line, after}` | Inserts after line `after`, or first when `after` is `null` (no `code`; line id in use; unknown `after`) |
| `code.edit` | `{id, text}` | Sets the line's `text` (unknown line) |
| `code.move` | `{id, after}` | Takes the line out and inserts it after `after` (`null` = first) (unknown line; `after == id`) |
| `code.indent` | `{id, delta}` | `indent = clamp(indent + delta, 0, 6)` (unknown line) |
| `code.delete` | `{id}` | Removes the line (unknown line) |
| `code.complexity` | `{slot, value}` | Sets `complexity.time` or `complexity.space` (no `code`) |
| `code.trace` | `{line, t}` | Appends `{line, t}` to `trace` (unknown line) |
| `agenda.check` | `{id, done, t}` | Sets `done`; `t` = args `t` when done, else `null` (no `meeting`; unknown item) |
| `present.show` | `{kind, ref, t}` | Appends to `meeting.shown` (no `meeting`) |
| `park.add` | `{text}` | Appends to `meeting.parked` (no `meeting`) |
| `undo` | `{target_op_id}` | See below |

All ops that touch `code` are rejected when `board.code` is `null`; all meeting ops when `board.meeting` is `null`.

**Undo** needs the op log, so `applyOp(board, op)` alone rejects it; the owner of the log (`BoardStore` on the client,
the session on the server) handles it: rebuild the board by replaying the accepted ops from the round's start board,
skipping the target (ops that then fail, such as an edge to an undone item, are dropped), then set `rev` to the previous
rev + 1 and `op_ids` to the previous `op_ids` plus the undo's `op_id`. Rejected when the target was not accepted, was
already undone, or is itself an undo.

### Ghosts

Ghosts are Scribe suggestions (`src: "scribe"`). `board.ghosts` carries the full list of pending ghosts (it replaces the
previous list).

- **Accept** (pinch, or the 4 s settle): send the ghost's op as a normal `board.op` with the same `op_id`, `src: "scribe"`,
  `op` and `args`. Committing that `op_id` removes the ghost.
- **Reject** (pinch ✕, or "no / scrap that"): send `board.ghost_reject {op_id}`. The server removes the ghost (no rev
  change), logs the ghost's op with `accepted: false`, and sends the new `board.ghosts` list. An unknown `op_id` is
  ignored.

### Op log

Every op the server receives or makes is appended to the session's op log as an `OpLogEntry`
`{op_id, t, rev, src, op, args, accepted}`; `t` is seconds since round start on the transcript clock, `rev` is the board
rev after the op. Duplicates are not logged twice.

### Fixtures

Each `content/fixtures/board-ops/*.json` is `{name, start, ops, expected}`: apply `ops` to `start` in order (rejected ops
change nothing); the result must equal `expected`. TypeScript compares parsed JSON with deep equality (array order
matters, key order does not). Rust compares typed values, where an absent optional field and `null` are both `None`.
