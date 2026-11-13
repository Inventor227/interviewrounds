# Protocol

The contract between the web app and the server. Shapes of the board, the report and the content files live in
`content/schema/` (JSON Schema draft 2020-12); the types in `web/src/shared/types.ts` and the Rust structs mirror them and
this file exactly.

## REST

JSON; cookie `ir_id` identifies the device/user; all under same origin. A new guest (and its cookie) is made only by
`GET /api/me` and `POST /api/sessions`; the other identity routes answer `401` without a known cookie.

- `GET /api/content/catalog` → `{roles, rounds:[RoundPublic], meeting_templates, personas:[PersonaPublic]}`
- `POST /api/sessions` `{mode:"interview"|"meeting", round_id?, meeting_plan_id?, length:"short"|"full",
  level:"junior"|"mid"|"senior"|"staff", style:"warm"|"neutral"|"tough", voice:"fish"|"fake", parent_session_id?}` →
  `CreateSessionRes {session_id, client_token, ws_url, round:RoundPublic, panel:[Panelist], floor, panel_mode:"swap"|"joined", limits,
  timing:{silence_wait_seconds, interrupt_after_seconds, target_minutes, hard_stop_minutes}}`
  where `Panelist {panelist_id, persona_id, display_name, title, avatar_id, seat:0|1|2, voice:{transport:"fish", fish:{session_id, token,
  livekit_url, expires_at, max_duration_seconds, ...}}|{transport:"fake"}|{transport:"fish_pending"}}`. `fish` is Fish's session
  response passed through unchanged (give all of it to the Fish SDK). `ws_url` is a path (`/ws/session/{id}`). `timing` comes from
  the round (`RoundPublic` strips it): `silence_wait_seconds` is already scaled by level (junior 0.75x, mid 1x, senior and staff
  1.5x) and `interrupt_after_seconds` is the floor persona's own value when it has one. `client_token` is 64 hex characters.
  Swap mode mints a Fish token for the floor panelist only (`fish_pending` for the others); joined mode mints one for everyone.
  A cap refusal is `429 {status, code, message, resets_at}` where `code` is a `Limits.reason` value and `resets_at` is a
  date-time or `null`. `voice:"fake"` (browser speech, no Fish) is a development path: it needs the header
  `X-Dev-Key: <DEV_KEY>`, else `403 {code: "dev_only"}`. Only rounds that started (the first socket `hello`) count
  toward limits. A new session replaces the caller's earlier sessions that never started (they end as `abandoned`), and
  a session with no `hello` within 10 minutes ends as `abandoned`.
- `POST /api/sessions/{id}/panelists/{pid}/join` `{opening_line?}` → `{voice}` (swap mode hand-over; `voice` as in `Panelist`).
  The server adds the opening line to the shared history as that panelist's turn, gives it to the new Fish session as
  `first_message`, moves the floor, and ends the previous panelist's Fish session. Joining a panelist that already has a
  live voice returns that voice again (nothing new is minted or said). `409` in joined mode, when the round ended
  meanwhile, and while the round is paused with its voices released (resume it first).
- `POST /api/sessions/{id}/resume` → `CreateSessionRes` (same `session_id`, new tokens). Allowed while the round is open
  and either a socket is still connected or the last one dropped less than 3 minutes ago, at most 3 times per session.
  Otherwise `409 {code}`: `session_ended` (also when the round ends while the new voice is being made), `resume_expired`
  (past the 3 minutes) or `resume_limit`. The new voices are made first: if that fails (`503`) the old token and voices
  keep working and the try does not count. Then earlier tokens stop working and their sockets close with `4401`; the
  interviewer's next turn knows the candidate is back (it welcomes them back briefly and restates where they were in
  one sentence). A **paused** round can be resumed whether or not its socket dropped, for as long as its pause budget
  lasts (`resume_expired` with under 30 s of it left: the time until the user is back in the room still counts as
  pause), and such a resume does not use up one of the 3; neither does the first resume after a voice release
  (`round.state.voices_released`), even if the round went live meanwhile. After 10 such uncounted resumes a resume
  uses up one of the 3 instead. This is how the browser gets new voices after they were released (see Pause). Two
  resumes at once run one after the other: the later one wins (the earlier page's token closes with `4401` and its
  voice ends), and since the first already took the round out of its pause, the later one counts against the 3. A
  resume that fails after making new voices ends them at once. Every resume gives the page a fresh 3-minute window to connect, and a resume from a
  pause keeps the round clock stopped until the user is back (see `round.state`).
- `POST /api/sessions/{id}/end` `{reason:"completed"|"user_ended"|"time_limit"|"disconnected"|"headset_removed"}` → 202. Ends
  the round at once with this reason (also during the goodbye after `ui.event {kind: "end"}`).
- `GET /api/sessions/{id}` → `{status:"created"|"live"|"paused"|"scoring"|"scored"|"failed"|"abandoned", report_ready}`
- `GET /api/sessions/{id}/report` → `Report` (404 until ready, and for a session that is not the caller's). Its
  `share` block is the session's live public link: `{public_slug, include_quotes}` (`include_quotes` is the link's
  `include_transcript`), `public_slug: null` when there is none. A retry session has no report of its own: it answers
  its parent's report (with the retry's entry in `weakest_moment.retries`) once the retry is scored, and 404 before.
  `GET /api/sessions/{id}` gives a retry `report_ready: true` once it is `scored`. The web app shows a retry's report
  at its parent's address (`/report/{parent}`).
- `POST /api/sessions/{id}/report` → 202 `{status:"scoring"}`: score a `failed` session again ("Try again"). Scoring
  makes at most 2 attempts per session; this gives 2 fresh ones. At most 2 per session per day (429
  `rescore_limit`); 409 when the session is scored or has not ended; 202 no-op when already `scoring`.
- `POST /api/sessions/{id}/board-image` (body `image/png`, ≤ 2 MB, ≤ 4096 px a side) → 204. One image per session:
  a new one replaces the old. Only while the session is `live`, `paused` or `scoring` (409 after).
- `POST /api/sessions/{id}/retry` (no body) → `CreateSessionRes`: a 2-minute re-ask of the weakest moment of the
  caller's scored interview round. Only when its report has `weakest_moment.retry.prompt`; else `409 {code:
  "no_retry"}` (also for a meeting, a round not yet `scored`, or a retry); 404 for a session that is not the
  caller's. The retry is a new session with `parent_session_id` = the round, stored with length `retry`, on the same
  round id, level, style and voice (`voice: "fake"` needs `X-Dev-Key` as on create). Its `round` is a `RoundPublic`
  of the parent round with `length: "short"`, `target_minutes: 2`, `hands: "none"`, `board_kit: null`, two phases
  (`retry` 1.5 min, then `close` 0.5 min; the time check at 90 s) and one panelist: the persona who asked the weakest
  question. `timing`: `silence_wait_seconds` at most 20 (then scaled by level), `interrupt_after_seconds` at most 90,
  `hard_stop_minutes` 2.5. The opening line on `[event: start]` is `retry.prompt` (its first two sentences), spoken
  word for word with no model call; the brief card holds the same line. At 120 s the server moves to the `close`
  phase, `round.state` asks for a time check, and the next app event (`[event: time_check]`, or any other marker)
  gets the fixed closing line "Thanks, that's time. Your before and after is on your report." word for word with no
  model call; then `round.ending` and the round ends (`completed`) after the usual grace. If no app event comes
  within 5 s of round time, the server sends `round.ending` itself and the browser's `[event: ending]` gets the line.
  Nothing waits on the model's tools; the 150 s hard stop is only a backstop. Caps and guest limits are those of a quick round (a retry
  counts as one). Scoring is one `FAST_MODEL` call that scores the new answer 1 to 4 on the parent's weakest-moment
  competency, then appends `{session_id, at, before_score, after_score, note}` to the parent report's
  `weakest_moment.retries` (once per retry); the socket gets `report.progress` and `report.ready` as for a round (no
  headset card). At most 2 calls per retry, each ledgered as a `retry_scoring` row; `POST
  /api/sessions/{id}/report` on a failed retry gives 2 fresh ones, as for rounds.
- `GET /api/me` → `{identity:{kind:"guest"|"user", name?, email?}, sign_in_available, settings, onboarding_done,
  streak:{current, best, today_done}, daily:{round_id, title}|null, resumable:{session_id, round_title, expires_at}|null,
  limits, entitlements}`. `resumable` is a dropped live session the user can still resume (`POST /api/sessions/{id}/resume`)
  until `expires_at` (3 minutes after the drop, or the end of the pause budget when that comes first; for a paused
  round, the end of the pause budget); `null` when there is none
- `GET /api/me/history?role=` → `[{session_id, round_id, title, started_at, headline}]` where `started_at` is a date-time
  and `headline: string` is the session report's `headline.summary`
- `GET /api/me/skills?role=` → `{competencies:[{id, name, points:[{session_id, at, score}]}]}`
- `PUT /api/me/settings` `Settings`; `POST /api/me/onboarding-done`; `DELETE /api/me`
- `POST /api/meetings/prepare` `MeetingSetup` → `{meeting_plan_id, plan:MeetingPlan}`
- `POST /api/shares` `{session_id, include_transcript}` → `{slug, url}`; `DELETE /api/shares/{slug}` → 204
  Only the owner of a `scored` session with a report (else 404 for a session that is not the caller's, 409
  `{code: "not_scored"}` before the report). `slug` is 10 random URL-safe characters (`A-Z a-z 0-9 - _`), never
  derived from ids; `url` is `{PUBLIC_BASE_URL}/s/{slug}` (`PUBLIC_BASE_URL` defaults to `APP_ORIGIN`). DELETE sets
  the link's `revoked_at` (idempotent: 204 again for a revoked link) and answers 404 for a link that is not the
  caller's.
  `POST /api/shares` is an upsert per session: a session has at most one live public link. A POST with the same
  `include_transcript` as the live link returns that link; one with a different value revokes it and makes a new one.
  The web app still deletes the old slug before posting a change, so either side alone keeps a single live link.
  With the `X-Dev-Key` header, DELETE takes down any link (operator clean-up after smoke runs).
- `GET /s/{slug}` server-rendered scorecard, public (no cookie needed), no script: round title, date, verdict and
  confidence (meetings: the outcome), competency bars (score of 4 and a one-line rationale), top 3 strengths, top 3
  things to work on, the weakest moment's question, next drills, and the transcript (with evidence quotes) only when
  the link has `include_transcript`. Never a name or an id. Open Graph and Twitter tags (title "Interview Rounds
  scorecard", the headline summary as description), `<meta name="robots" content="noindex">`, `Cache-Control:
  private, max-age=60`. A revoked link answers `410` and an unknown one `404`, both as small pages in the same style
  (`Cache-Control: no-store`). Every report value is escaped.
- `GET /auth/google/start`, `/auth/google/callback`, `POST /auth/logout`: not mounted in this build (no sign-in:
  everyone is a guest on their device, `sign_in_available` is always `false`).
- `POST /v1/chat/completions` Fish custom LLM (bearer `FISH_LLM_SECRET`, or the session `client_token` when the session's
  voice is `fake`); OpenAI chat format in, SSE `chat.completion.chunk` out. Turns are served only while the round is `live`
  (or ending, for the goodbye): else `409 {code: "session_not_live"}`. With the `client_token` a turn is at most 2,000
  characters (`413 {code: "turn_too_long"}`) and a session at most 150 turns (`429 {code: "turn_limit"}`).
- `GET /healthz`

## WebSocket

`/ws/session/{id}`: envelope `{"t": type, "seq": n, "d": {...}}`, server acks with an `ack` field (rules below); ping every 20 s.

Sequencing and acks:

- `hello` and `ping` frames use `seq: 0`. Every other client frame carries its own `seq`, increasing from 1.
- Client `seq` and the server's record of processed client frames are kept **per `client_token`**, not per session. A
  reconnect with the same token continues the count. `POST /api/sessions/{id}/resume` issues a new `client_token`, and
  a reloaded page opens a new socket under it that counts from 1 again; the server starts a fresh record for that token,
  so those frames are never mistaken for duplicates.
- Any server frame may carry `ack: n`: the highest client `seq` the server has processed for this connection's
  `client_token`. The client drops every queued frame with `seq <= n`.
- Server frames with `seq > 0` are numbered from 1 per session and buffered on the server. `hello {client_token,
  last_seq}` gives the highest server `seq` the client has seen; the server replays every buffered frame after it.
  Server frames with `seq: 0` (such as `pong`) are not buffered or replayed. Server `seq` stays per session across
  tokens: a client that kept its state sends the highest `seq` it saw; a reloaded page has none, sends `last_seq: 0`, and
  gets the whole buffer replayed, which is intended (it rebuilds its view from the replay).
- Only reliable frames are queued for replay: `board.op`, `board.ghost_reject`, `transcript.mark`, `ui.event`. After a
  reconnect the client sends `hello` first, then replays its unacked reliable frames with their original `seq`. It keeps
  at most 1000; if it has to evict one, it reports it to the app instead of dropping it silently.
- `head.samples`, `voice.state`, `voice.spoken` and `board.focus` are telemetry: sent only while the socket is open, never queued or
  replayed. They still take the next `seq`, so `seq` only grows in send order.
- The server acks only frames it has saved. When a frame cannot be saved it answers `error {code: "server_error"}`,
  processes nothing after it, and closes with `1011`; the client reconnects and replays it. A client that sends nothing
  (not even a ping) for 45 s is closed with `1001` (frames the server sends do not count). Beyond a burst of 1,000 frames
  (the replay after `hello`), more than 60 frames a second close the socket with `1008`; replayed frames the server
  already processed do not count. Messages are at most 256 KB.
- Close codes. A server close with `1000` or `4001`-`4999` is final and the client does not reconnect: `4401` the
  `client_token` is unknown or expired, `4404` no such session, `4409` the session has ended (sent once the report is
  done, see below). Any other close (`1001`, `1006`, `1011`, `1012`, ...) is transient: the client reconnects with backoff
  0.5, 1, 2, 4 s (then every 4 s), and resets the backoff only after a frame arrives on the new connection. `4000` is the
  client's own close when no frame arrived for a whole ping interval (20 s).
- Duplicates are ignored by `seq`: the server skips a client frame whose `seq` it already processed for that
  `client_token`, and the client skips a server frame with `seq > 0` whose `seq` is not above the highest it has seen
  (frames with `seq: 0` are never treated as duplicates).

- Client → server: `hello {client_token, last_seq}` (first frame), `board.op {op_id, rev_base, src, op, args, at_ms}`,
  `transcript.mark {segment_id, panelist_id, first_at_ms, final_at_ms, text}`, `head.samples {samples:[{t_ms, yaw, pitch,
  speaking, target}]}`, `voice.state {panelist_id, mode:"listening"|"thinking"|"speaking", at_ms, latency?:{user_final_at_ms, thinking_at_ms,
  first_text_at_ms}}` (the latency split once per turn, stored for the latency log), `voice.spoken {panelist_id,
  text_prefix}` (the first words of a reply as the voice actually played them, about 60 characters, from the SDK's
  playback-paced `agentResponseDelta`, once per reply: replies are kept in the interviewer's memory only once played),
  `ui.event {kind:"pause"|"resume"|"end"|"hint"|"skip_onboarding", reason?}`, `board.ghost_reject {op_id}` (dismiss a
  Scribe suggestion), `board.focus {item_id}` (`item_id` a string or null: the item the user last touched or created,
  sent debounced; the latest wins and the Scribe uses it to resolve "that"), `ping`
- Server → client: `round.state {status, phase_id, phase_index, phases:[{id, title?, minutes, uses_whiteboard}], elapsed_s,
  remaining_s, phase_remaining_s, brief:{question, lines}, floor, time_check_due, voices_released, degraded}`,
  `panel.hand_over {from, to, opening_line}`, `board.ack {op_id, rev}`, `board.ghosts {ghosts:[GhostOp]}`,
  `board.apply {op_id, rev, src, op, args}` (server-originated ops), `avatar.point_at {panelist_id, item_id}`,
  `round.ending {closing_line}`, `round.ended {reason}`,
  `report.progress {stage:"metrics"|"scoring"|"card"|"done", pct, card?:HeadsetCard}`, `report.ready {session_id}`,
  `error {code, message, op_id?}` (`op_id` set for `op_rejected`; `code: "report_failed"` when scoring gave up, then
  `POST /api/sessions/{id}/report` tries again), `pong`
- `round.state` is a full snapshot and always has `seq: 0` (never buffered or replayed). The server sends one right after
  `hello`, one on every change (status, phase, floor, brief), and one every second while the round is `live` or `paused`.
  `elapsed_s` is round time without pauses; the clock also stops while no socket is connected and starts at the first
  `hello` (status `created` until then). After a drop (or a server restart) a reconnect alone does not restart it: the
  next live turn (the resume flow's `[event: resume]`) or `ui.event {kind: "resume"}` does. The same holds after
  `POST /resume` from a pause: the clock waits for the user, and the report counts the pause until then. Nothing is
  spoken on a reconnect. `degraded: true` means the interviewer's model has failed 3 live turns in a row, even after
  its fallback model (each of those turns said the hold line "Sorry, give me a second."). The round clock is then
  held, as in a pause, until a turn gets a real reply, and that snapshot carries `degraded: false`. The browser shows
  "Your interviewer is reconnecting…" while it is true. Held time counts toward the 10-minute pause budget.
  (Each live turn first retries once on a different model: the fallback, `LIVE_FALLBACK_MODEL`, when the model was
  overloaded, rate limited, failed with a 5xx or gave no text in time.) `time_check_due: true` is sent once per phase boundary, on the snapshot when the
  current phase runs out of time, and again on the snapshot after a `hello` while that time check is still owed (no
  `[event: time_check]` has reached the server since the boundary); it is `false` otherwise. On `true` the browser sends
  `[event: time_check]`. In an interview `brief` holds the question card's title and brief lines from the first snapshot,
  before the interviewer speaks; the interviewer's show_question replaces it.
- Playback. A reply to the candidate's speech is kept in the interviewer's memory, and its actions (brief card, phase,
  pointing, hand-over, end) run, only once it is known to have played: on `voice.spoken` for it, or when that panelist's
  next Fish request shows it. A reply never played is dropped with its actions; so are replies still unplayed when the
  user pauses. Replies to typed app events count at once. `voice.spoken` should be sent as soon as the first words play,
  so the actions land while the line is spoken.
- Ending. `ui.event {kind: "end", reason?}` starts the goodbye: the browser sends `[event: ending]`, and the round ends
  3 s after the interviewer's closing line, or 20 s after the request, whichever comes first, with that `reason` (default
  `user_ended`); `POST /end` ends it at once. The interviewer's `end_round` (`round.ending`) ends it the same way.
  Once a closing line has been said (`end_round`'s, or a retry's own line), any later app event, such as the
  `[event: ending]` the browser sends on `round.ending`, gets an empty reply: no second goodbye, no model call,
  nothing recorded.
  A live round with no socket for 3 minutes ends with `round.ended {reason: "disconnected"}`; one past its
  `hard_stop_minutes`, or with more than 10 minutes of pauses in total (user pauses and time offline), ends with
  `time_limit`.
- Pause. `ui.event {kind: "pause", reason?}` pauses the round; `reason` is `user` (the Pause button), `hidden` (the page
  went to the background), `blurred` (the headset left the session or focus) or `headset_removed`. Any reason, or
  none, pauses the same way; it is only logged. While paused:
  - **Hold.** A paused round whose socket drops is held: it does not end after the 3-minute offline window. It ends
    only when its pause budget (10 minutes of pauses in total) runs out, with `time_limit` (scored when the candidate
    spoke). A round that drops while live keeps the 3-minute rule. `GET /api/me` `resumable.expires_at` is that
    deadline: the end of the pause budget for a paused round, the end of the offline window for a live one.
  - **Voice release.** After 45 s in one pause (a new pause starts the 45 s again) the server ends every voice
    session of the round (they bill per minute while idle) and sets `round.state.voices_released: true`; the browser
    also sees its voice sessions end. It survives a restart: a reloaded round keeps the time its pause began, and the
    janitor ends the voices of a paused round nobody reloaded. A voice end that fails is tried again (backing off
    to once a minute) while the pause lasts; after that, the next resume or the round's settlement ends it.
  - **Back.** If `voices_released` is true, the browser calls `POST /resume` (new voices, not counted) and, once the
    user is back in place, sends `[event: resume]` (or `ui.event {kind: "resume"}`): the clock runs again from then.
    Otherwise (under 45 s) it sends `ui.event {kind: "resume"}`, unmutes, keeps the same voices, and sends
    `[event: resume]` so the interviewer welcomes them back. If the flag turns true after the round went live (a
    resume at the 45 s mark), the browser recovers the same way, with an uncounted `POST /resume`.
- After `round.ended` the socket stays open while the report is made: `report.progress`, then `report.ready` (or
  `error {code: "report_failed"}`), then close `4409`; with no report within 120 s it closes `4409` anyway. A round with
  nothing to score (`abandoned`) closes `4409` right after `round.ended`. Frames sent after the end are acked but not
  stored. A reconnect
  in that time is let in and replayed. On a server restart sockets close with `1012`.
- `HeadsetCard` (sent once, with `stage: "card"`, a few seconds after the round ends and before `report.ready`):
  `{one_line, top_strength: CardPick|null, top_fix: CardPick|null}` where `CardPick {title, evidence_id, quote,
  t_start_sec}`. `one_line` ≤ 140 characters, `title` ≤ 60; `evidence_id` (`c1` for the strength, `c2` for the fix)
  is an item of the final report's `evidence`, and `quote` is the candidate's own words at `t_start_sec`.
- Report times (`t_start_sec`, `t_sec`) are round time: seconds since the round started on the server clock, pauses
  left out (the same clock as the board op log).
- Marker texts the browser sends into the voice session as a typed user turn: `[event: start]`, `[event: time_check]`,
  `[event: handover]`, `[event: resume]`, `[event: silence_check]`, `[event: ending]`, `[event: long_answer]` (sent when
  one candidate turn runs past the round's `interrupt_after_seconds`).

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
| `Rubric` | `content/schema/rubric.schema.json` |
| `QuestionBank` | `content/schema/bank.schema.json` |
| `Voices` (`content/voices.json`) | `content/schema/voices.schema.json` |
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

- Meetings the user chairs (`user_chairs: true` on the template and the plan, e.g. a performance review where the user is
  the manager): `chair_attendee` is `null` and no AI attendee chairs; otherwise `chair_attendee` names the chair.
- `MeetingPlanPublic`: what `POST /api/meetings/prepare` returns as `plan`. It is the `MeetingPlan` with every
  `attendees[].hidden` block removed (stance, concerns, patience, persona, avatar and voice stay on the server). The
  suggested objections the setup page shows are in each attendee's `likely_objections`, which stays.
- `Limits {short_left_today: int|null, full_left: int|null, resets_at: date-time|null, reason: null|"guest_daily_limit"|
  "guest_full_used"|"judge_budget_reached"|"build_budget_reached"|"free_rounds_used"|"model_budget_reached"}`: `null` counts mean no limit;
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
- Report `session.difficulty` (easy, standard, hard) comes from the session's `style`: warm → `easy`, neutral →
  `standard`, tough → `hard`. Meeting sessions map their `MeetingSetup.difficulty`: friendly → `easy`, realistic →
  `standard`, tough → `hard`.
- Report `session.seniority` is the session's `level` (junior, mid, senior, staff); meeting sessions use `n/a`.
- Report `session.role` is the round's `role` (`none` for meetings).
- Report `round_details.template` is `MeetingSetup.template_id`, with `null` → `"custom"`.

## Board ops

One board per session (`Board`), changed only by ops. The web app (`applyOp`) and the server (`board::apply`) implement
the same rules, pinned by `content/fixtures/board-ops/*.json`.

### Apply

1. **Duplicate**: if `op_id` is already in `board.op_ids`, nothing changes (no rev change, no error). Replays after a
   reconnect are safe.
2. **Reject**: if the args do not match the schema, or the rules below reject the op, `rev`, `op_ids`, items, edges,
   `code`, `meeting` and `focus` stay as they were. One thing does change: a pending ghost with the same `op_id` is
   removed, so a ghost that cannot be applied is never retried.
   - TypeScript: `applyOp` returns the board unchanged except that the ghost with that `op_id` (if any) is removed.
   - Rust: `board::apply` returns `Err` and leaves the board unchanged; the session then removes the ghost with that
     `op_id` itself.
   - Server: logs the op with `accepted: false` (schema-invalid args and unknown op names included; an op without a
     usable `op_id` or `src` is answered but not logged), answers `error {code: "op_rejected", message, op_id}`, and,
     if a ghost was removed, sends the new `board.ghosts` list, so no client re-sends that ghost.
3. **Commit**: apply the effect, then `rev += 1`, append `op_id` to `op_ids`, and remove the ghost with the same `op_id`
   if there is one. The server answers the sender with `board.ack {op_id, rev}` and sends `board.apply` to other clients.
   (One browser per session today, so `board.apply` carries only server-originated ops.) A repeat of a committed
   `op_id` is not acked again; its first ack is replayed by seq. After each committed op the interviewer's next note
   carries the new board summary, with what changed since the interviewer last replied.
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
| `code.delete` | `{id}` | Removes the line; `trace` entries that name it stay (unknown line) |
| `code.complexity` | `{slot, value}` | Sets `complexity.time` or `complexity.space` (no `code`) |
| `code.trace` | `{line, t}` | Appends `{line, t}` to `trace` (unknown line) |
| `code.approach` | `{lines}` (≤ 6, each ≤ 120 chars) | Replaces `code.approach` with `lines` (no `code`) |
| `agenda.check` | `{id, done, t}` | Sets `done`; `t` = args `t` when done, else `null` (no `meeting`; unknown item) |
| `present.show` | `{kind, ref, t}` | Appends to `meeting.shown` (no `meeting`) |
| `park.add` | `{text}` | Appends to `meeting.parked` (no `meeting`) |
| `undo` | `{target_op_id}` | See below |

All ops that touch `code` are rejected when `board.code` is `null`; all meeting ops when `board.meeting` is `null`.

**Undo** needs the op log, so `applyOp(board, op)` alone rejects it; the owner of the log (`BoardStore` on the client,
the session on the server) handles it:

1. Reject (board unchanged) when the target is not an accepted entry of the log, is itself an undo, or is already the
   target of an accepted undo.
2. Rebuild the board from the round's start board by replaying, in log order, every accepted op **except undo ops and
   every op targeted by an accepted undo (including this one)**. Ops that now fail (for example an edge to an undone
   item) are dropped from the result.
3. Keep the current `ghosts`, minus any whose `op_id` is now in `op_ids`. Keep the current `focus` unless its item no
   longer exists, then `null`.
4. Set `rev` to the current rev + 1 and `op_ids` to the current `op_ids` plus the undo's `op_id` (undone and dropped op
   ids stay, so their replays are still ignored).

Pinned by `content/fixtures/board-undo/*.json`.

### Ghosts

Ghosts are Scribe suggestions (`src: "scribe"`). `board.ghosts` carries the full list of pending ghosts (it replaces the
previous list). In a round with a board the server runs the Scribe once after each candidate answer is final (the reply
to it played), with the last one to three answers and the latest `board.focus` (fresh for 20 s), one call at a time per
session; a suggestion that no longer applies when it returns is dropped. It takes about 2 s.

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

Each `content/fixtures/board-undo/*.json` is `{name, start, log, undo, expected}` (`$defs/undo_fixture`). The current
board is `start` with the `log` replayed in order: accepted entries are applied (undo entries by the undo rule above);
an entry with `accepted: false` changes nothing except dropping a pending ghost with the same `op_id` (that is how a
dismissed ghost appears in the log). Apply `undo` to the current board; the result must equal `expected`.
