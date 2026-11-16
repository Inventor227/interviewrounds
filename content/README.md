# Content

Everything the interviewers say and judge lives here as data and prompt text. The server loads it at start and serves the
public parts read only. Adding a round is content work: a round config per length, a rubric, a question bank and a round
script.

Check it with `node tools/content-check.mjs` (add `--schemas <dir>` or `CONTENT_SCHEMA_DIR` when the schemas live
elsewhere) and `node --test tools/content-check.test.mjs`.

## Layout

| Path | What | Format |
|---|---|---|
| `rounds/<id>.json` | One file per round and length, e.g. `sde.system_design.full`. Phases, timings, panel, rubric, bank, board kit. | `schema/round.schema.json` |
| `personas/<name>.json` | The eight interviewers and the meeting chair. | `schema/persona.schema.json` |
| `meeting-templates/<id>.json` | The six meeting templates with default attendees. | `schema/meeting-template.schema.json` |
| `rubrics/<name>.json` | Four competencies per round type, descriptors for scores 1 to 4, the bar per level. | `schema/rubric.schema.json` |
| `banks/<name>.json` | Question cards per round type, at least four each. | `schema/bank.schema.json` |
| `voices.json` | The voice for each persona, keyed by `voice_id`, with two alternates each. | `schema/voices.schema.json` |
| `prompts/*.md` | Prompt templates with `{placeholders}`. | see below |

## Rounds

| Round | Short | Full | Panel (full) | Hands | Board kit |
|---|---|---|---|---|---|
| `sde.coding` | 8 min, Maya | 30 min, Maya | none | `code_panel` | `coding` |
| `sde.system_design` | 8 min, Daniel | 30 min | Daniel, then Ana from `deep_dive` | `whiteboard` | `hld` |
| `sde.object_design` | 7 min, Maya | 30 min, Maya | none | `class_cards` | `lld` |
| `sde.behavioral` | 6 min, Sam | 25 min, Sam | none | `none` | none |
| `pm.product_sense` | 7 min, Priya | 30 min, Priya | none | `stickies` | `pm` |
| `pm.execution` | 6 min, Priya | 25 min | Priya, then Leo from `diagnosis` | `stickies` | `pm` |
| `pm.leadership` | 6 min, Sam | 25 min | Sam, then Viktor from `story_3` | `none` | none |
| `meeting` | 8 min | 20 min | people come from the meeting plan; Grace is the default chair | `meeting_cards` | `meeting` |

Quick rounds are always one to one. Meeting full is 20 minutes, as in the design; the interview fulls are 25 to 30.

`silence_wait_seconds` and `interrupt_after_seconds` are the values for a mid level session. The level scales the silence
wait the way `prompts/levels.md` describes: junior about 0.75x, mid 1x, senior and staff about 1.5x. A persona's
`interrupts_after_seconds` overrides the round's `interrupt_after_seconds` when set.

Short coding rounds use ordered lines instead of dictation: the `dry_run` phase shows the card's `reference_solution.lines`
shuffled with its `distractors`.

## Personas, avatars and voices

Eight people share six avatars. Two pairs share an avatar, and neither pair ever sits together in a panel or a meeting
template default. `tools/content-check.mjs` enforces this for panels and templates.

| Persona | Role played | Style | Avatar | Voice (`voices.json`) | Appears with |
|---|---|---|---|---|---|
| Maya | Senior Software Engineer | warm | f01 | `maya`, Harper | alone (coding, object design); designer Mei in project kickoff |
| Ana | Site Reliability Engineer | neutral | f01 | `ana`, Wren | Daniel; partner Rhea in investor pitch; Nadia in exec update |
| Priya | Group Product Manager | warm | f02 | `priya`, Priya | Leo; Dana in client proposal; Helen in project kickoff |
| Grace | Chief of Staff, meeting chair | neutral | f03 | `grace`, Amara | any meeting she chairs |
| Daniel | Staff Software Engineer | neutral | m02 | `daniel`, Mason | Ana; Ravi in performance review; Tomas in project kickoff |
| Leo | Data Scientist | neutral | m02 | `leo`, Gregory | Priya; Tom in investor pitch |
| Sam | Engineering Manager | warm | m04 | `sam`, Sawyer | alone, or Viktor in PM leadership |
| Viktor | Director of Product | tough | m05 | `viktor`, Oliver | Sam; Marcus in client proposal; Martin in exec update |

Shared avatars: Maya and Ana (f01), Daniel and Leo (m02). When the meeting prepare step adds Grace or assigns a persona to a
custom attendee, it must keep avatars and voices distinct inside the meeting (`prompts/meeting-prepare.md`).

Voices are Fish Official voices, picked by ear from one shared test line and by median pitch so that no interviewer
sounds heavy. Each has a reason and two official alternates. The server sends the persona's voice id with every voice
session, so changing a voice is a content change and needs no agent republish.

## Prompts

Every prompt file starts with an HTML comment that lists its placeholders. The loader strips that comment before sending
anything. The check fails if a prompt uses a placeholder its header does not declare.

| File | Used by | Notes |
|---|---|---|
| `house-rules.md` | every live interview turn | Above the `turn-note` marker line: the stable, cached system prefix. Below it: the per turn system note. |
| `levels.md` | `{level_rules}` | Sections split on `## junior`, `## mid`, `## senior`, `## staff`. |
| `styles.md` | `{style_rules}` | Sections `## warm`, `## neutral`, `## tough`. |
| `round-<round_type with dashes>.md` | `{round_script}` | e.g. `round-pm-execution.md`. Behavioral and leadership get several question cards in `{questions}`. |
| `hand-over.md` | `{panel_rules}` | `## lead` for the lead, `## second` for the second panelist; empty for one to one rounds. |
| `round-meeting.md` | every meeting attendee | Replaces the stable part of `house-rules.md` for meetings, plus `## chair` or `## attendee`, plus `## user_chairs` for everyone when the plan has `user_chairs: true`; reuses the turn note. |
| `meeting-prepare.md` | `POST /api/meetings/prepare` | Output is `schema/meeting-plan.schema.json`. |
| `meeting-state.md` | background update after each user turn in meetings | Output feeds `{notes}` of the next turn. |
| `scribe.md` | voice to board ghosts | Op names and args as in `schema/board.v1.schema.json`. |
| `scorer.md` | the scorecard | Writes the model owned parts of `report.v1`; the server fills session, delivery, verdict and confidence. |

Live speech is spoken word for word, so live prompts ask for one to three short sentences with no markdown, lists,
brackets or symbols, and numbers in words. The server's speech filter is the second line of defence.

App markers the live prompts handle: `[event: start]`, `[event: time_check]`, `[event: silence_check]`,
`[event: long_answer]` (one answer ran past `interrupt_after_seconds`; models never time answers themselves),
`[event: handover]`, `[event: resume]`, `[event: ending]`.

Meetings: the meeting plan's `opening_line` is spoken by the server as the session's first message (the chair's, or the
decision maker's when the user chairs), so no prompt repeats it. Performance review and project kickoff set
`user_chairs: true`: the user runs the meeting, no AI attendee chairs or asks for the decision, and the meeting ends on
the user's close.

Live tools: `show_question`, `next_phase`, `hand_over`, `point_at`, `give_hint`, `end_round`. `house-rules.md` says when to
use each; `hand_over.line` is always the exact first line the next speaker says, and the server speaks it word for word
on `[event: handover]` without a model call.

## Copy

User facing strings (round titles and summaries, phase titles, template copy, tips, competency names) are short and plain,
with no em or en dashes and as few hyphens as grammar allows. The check rejects em and en dashes in every content file and
prompt.
