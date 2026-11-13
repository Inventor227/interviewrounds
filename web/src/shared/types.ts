// Shared types for the web app. They mirror docs/protocol.md (REST and WebSocket)
// and content/schema/*.json field for field. When one of those files changes, change this
// file with it; types.test.ts checks every property, its nullability and the enums below
// against the schemas. Rubric, QuestionBank and Voices (rubric, bank, voices schemas) are
// server-side content with no web consumer yet, so they are not mirrored here.
//
// Enums that a schema also lists are const arrays, so the test can compare values.

// ---------- Small enums ----------

export type Role = 'sde' | 'pm';
export type Mode = 'interview' | 'meeting';
export type Length = 'short' | 'full';
export const LEVELS = ['junior', 'mid', 'senior', 'staff'] as const;
export type Level = (typeof LEVELS)[number];
export const STYLES = ['warm', 'neutral', 'tough'] as const;
export type Style = (typeof STYLES)[number];
export type VoiceChoice = 'fish' | 'fake';
export type PanelMode = 'swap' | 'joined';
export type Seat = 0 | 1 | 2;

export const ROUND_TYPES = ['coding', 'system_design', 'object_design', 'behavioral', 'recruiter_screen', 'pm_product_sense', 'pm_execution', 'pm_estimation', 'pm_strategy', 'pm_leadership', 'meeting'] as const;
export type RoundType = (typeof ROUND_TYPES)[number];

export const END_REASONS = ['completed', 'user_ended', 'time_limit', 'disconnected', 'headset_removed'] as const;
export type EndReason = (typeof END_REASONS)[number];

export type SessionStatus = 'created' | 'live' | 'paused' | 'scoring' | 'scored' | 'failed' | 'abandoned';

// ---------- Board (content/schema/board.v1.schema.json) ----------

export const BOARD_KITS = ['hld', 'lld', 'coding', 'pm', 'meeting'] as const;
export type BoardKit = (typeof BOARD_KITS)[number];
export const BOARD_SRCS = ['hand', 'voice_grammar', 'scribe', 'interviewer'] as const;
export type BoardSrc = (typeof BOARD_SRCS)[number];
export const COMPONENT_TYPES = ['client', 'lb', 'api_gateway', 'service', 'db', 'kv', 'cache', 'queue', 'cdn', 'object_store', 'search', 'worker', 'external', 'note', 'blank'] as const;
export type ComponentType = (typeof COMPONENT_TYPES)[number];
export const CLASS_KINDS = ['class', 'interface', 'abstract', 'enum'] as const;
export type ClassKind = (typeof CLASS_KINDS)[number];
export const METRIC_ROLES = ['north_star', 'input', 'guardrail'] as const;
export type MetricRole = (typeof METRIC_ROLES)[number];
export const LANES = ['user', 'pain', 'idea', 'metric'] as const;
export type Lane = (typeof LANES)[number];
export const QUADS = ['tl', 'tr', 'bl', 'br'] as const;
/** 2x2 quadrant: t/b = impact high/low, l/r = effort low/high. */
export type Quad = (typeof QUADS)[number];
export const EDGE_DIRS = ['->', '<->', '--'] as const;
export type EdgeDir = (typeof EDGE_DIRS)[number];
export const EDGE_RELS = ['uses', 'has_a', 'is_a', 'implements'] as const;
export type EdgeRel = (typeof EDGE_RELS)[number];
export const VIS = ['+', '-', '#', '~'] as const;
export type Vis = (typeof VIS)[number];

export interface ComponentItem {
  id: string;
  kind: 'component';
  type: ComponentType;
  label: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
  group?: string | null;
  notes?: string[];
}

/** A class field or method. Fields use `type`; methods use `params` and `returns`. */
export interface ClassMember {
  id: string;
  vis: Vis;
  name: string;
  type?: string | null;
  params?: { name: string; type?: string | null }[];
  returns?: string | null;
}

export interface ClassItem {
  id: string;
  kind: 'class';
  label: string | null;
  class_kind: ClassKind;
  fields: ClassMember[];
  methods: ClassMember[];
  x: number;
  y: number;
  w: number;
  h: number;
  group?: string | null;
}

export interface StickyItem {
  id: string;
  kind: 'sticky';
  lane: Lane | null;
  text: string;
  votes: number;
  quad: Quad | null;
  x: number;
  y: number;
  group?: string | null;
  /** Rung on the ranked ladder, 1 = top. */
  rank?: number | null;
  w?: number;
  h?: number;
}

export interface GroupItem {
  id: string;
  kind: 'group';
  label: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MetricItem {
  id: string;
  kind: 'metric';
  role: MetricRole;
  label: string | null;
  x: number;
  y: number;
  group?: string | null;
  w?: number;
  h?: number;
}

export interface InkItem {
  id: string;
  kind: 'ink';
  /** [x, y] in board cm, 1 decimal. */
  points: [number, number][];
  recognized: 'rect' | 'line' | 'arrow' | 'circle' | null;
}

export interface InterviewerCardItem {
  id: string;
  kind: 'interviewer_card';
  title: string;
  body: string;
  x: number;
  y: number;
  w?: number;
  h?: number;
}

export type BoardItem =
  | ComponentItem
  | ClassItem
  | StickyItem
  | GroupItem
  | MetricItem
  | InkItem
  | InterviewerCardItem;

export type ItemKind = BoardItem['kind'];

export interface BoardEdge {
  id: string;
  from: string;
  to: string;
  dir: EdgeDir;
  label: string | null;
  rel: EdgeRel | null;
}

export interface CodeLine {
  id: string;
  indent: number;
  text: string;
  src: BoardSrc;
}

export interface BoardCode {
  language: string;
  lines: CodeLine[];
  approach: string[];
  complexity: { time: string | null; space: string | null };
  /** Seconds since round start. */
  trace: { line: string; t: number }[];
}

export interface BoardMeeting {
  agenda: { id: string; text: string; done: boolean; t: number | null }[];
  /** Key number cards from the meeting setup. */
  numbers?: { id: string; label: string; value: string }[];
  shown: { kind: 'slide' | 'number'; ref: number | string; t: number }[];
  parked: string[];
}

export interface Board {
  schema: 'ir.board.v1';
  round: { id: string; type: BoardKit; question_id: string | null; language: string | null };
  rev: number;
  size: { w: number; h: number };
  brief: { question: string; lines: string[] };
  items: BoardItem[];
  edges: BoardEdge[];
  code: BoardCode | null;
  meeting: BoardMeeting | null;
  /** Client state: what "that / this / it" refers to. Ops only clear it. */
  focus: string | null;
  ghosts: GhostOp[];
  /** op_id of every committed op, in commit order. */
  op_ids: string[];
}

/** args per op name (board.v1.schema.json#/$defs/op_args). Apply rules: docs/protocol.md. */
export interface OpArgsMap {
  'item.create': BoardItem;
  'item.move': { id: string; x: number; y: number; lane?: Lane | null; rank?: number | null };
  'item.delete': { id: string };
  'item.label': { id: string; text: string | null };
  'item.set_type': { id: string; type: ComponentType | ClassKind | MetricRole };
  'item.note.add': { id: string; text: string };
  'edge.create': { id: string; from: string; to: string; dir?: EdgeDir; label?: string | null; rel?: EdgeRel | null };
  'edge.delete': { id: string };
  'edge.set_dir': { id: string; dir: EdgeDir };
  'edge.set_rel': { id: string; rel: EdgeRel | null };
  'edge.label': { id: string; text: string | null };
  'group.create': { id: string; label: string | null; x: number; y: number; w: number; h: number; members: string[] };
  'member.add': { class_id: string; section: 'fields' | 'methods'; member: ClassMember };
  'member.move': { id: string; to_class_id: string };
  'member.remove': { id: string };
  'sticky.vote': { id: string; delta: 1 | -1 };
  'sticky.set_quad': { id: string; quad: Quad | null };
  'code.insert': { line: CodeLine; after: string | null };
  'code.edit': { id: string; text: string };
  'code.move': { id: string; after: string | null };
  'code.indent': { id: string; delta: number };
  'code.delete': { id: string };
  'code.complexity': { slot: 'time' | 'space'; value: string | null };
  'code.trace': { line: string; t: number };
  /** Replaces code.approach (at most 6 lines). */
  'code.approach': { lines: string[] };
  'agenda.check': { id: string; done: boolean; t: number | null };
  'present.show': { kind: 'slide' | 'number'; ref: number | string; t: number };
  'park.add': { text: string };
  undo: { target_op_id: string };
}

export type BoardOpName = keyof OpArgsMap;

/** Every op name, in schema order (board.v1.schema.json#/$defs/op_name). */
export const BOARD_OP_NAMES = [
  'item.create',
  'item.move',
  'item.delete',
  'item.label',
  'item.set_type',
  'item.note.add',
  'edge.create',
  'edge.delete',
  'edge.set_dir',
  'edge.set_rel',
  'edge.label',
  'group.create',
  'member.add',
  'member.move',
  'member.remove',
  'sticky.vote',
  'sticky.set_quad',
  'code.insert',
  'code.edit',
  'code.move',
  'code.indent',
  'code.delete',
  'code.complexity',
  'code.trace',
  'code.approach',
  'agenda.check',
  'present.show',
  'park.add',
  'undo',
] as const satisfies readonly BoardOpName[];
export type OpArgs<K extends BoardOpName = BoardOpName> = OpArgsMap[K];

type PerOp<F> = { [K in BoardOpName]: F & { op: K; args: OpArgsMap[K] } }[BoardOpName];

/** An op as applied (board.v1.schema.json#/$defs/board_op). */
export type BoardOp = PerOp<{ op_id: string; src: BoardSrc; rev_base?: number; at_ms?: number }>;

/** A Scribe suggestion shown faded. Accept: send it as a board.op with the same op_id.
 *  Dismiss: board.ghost_reject {op_id}. */
export type GhostOp = PerOp<{ op_id: string; src: 'scribe' }>;

/** One entry of the session op log. `t` is seconds since round start; `rev` is the rev after the op. */
export type OpLogEntry = PerOp<{ op_id: string; t: number; rev: number; src: BoardSrc; accepted: boolean }>;

/** content/fixtures/board-ops/*.json: apply `ops` to `start` in order; the result equals `expected`. */
export interface BoardOpsFixture {
  name: string;
  start: Board;
  ops: BoardOp[];
  expected: Board;
}

/** content/fixtures/board-undo/*.json: the current board is `start` with the accepted `log`
 *  applied; applying `undo` to it gives `expected`. */
export interface UndoFixture {
  name: string;
  start: Board;
  log: OpLogEntry[];
  undo: Extract<BoardOp, { op: 'undo' }>;
  expected: Board;
}

// ---------- Rounds, personas, meetings (content/schema) ----------

export const HANDS = ['whiteboard', 'code_panel', 'class_cards', 'stickies', 'meeting_cards', 'none'] as const;
export type Hands = (typeof HANDS)[number];
export const AVATAR_IDS = ['f01', 'f02', 'f03', 'm02', 'm04', 'm05'] as const;
export type AvatarId = (typeof AVATAR_IDS)[number];

export interface RoundPhase {
  id: string;
  minutes: number;
  /** Prompt text for the interviewer. */
  goal: string;
  title?: string;
  must_cover?: string[];
  uses_whiteboard?: boolean;
}

/** content/rounds/*.json (round.schema.json). Server side; the client gets RoundPublic. */
export interface RoundConfig {
  id: string;
  title: string;
  role: Role | 'none';
  round_type: RoundType;
  length: Length;
  target_minutes: number;
  hard_stop_minutes: number;
  silence_wait_seconds: number;
  interrupt_after_seconds: number;
  panel: { lead: string; second?: string | null; second_enters_phase?: string | null };
  phases: RoundPhase[];
  rubric_id: string;
  question_pool: string;
  hands: Hands;
  board_kit: BoardKit | null;
  summary?: string;
  short_version?: string | null;
  full_version?: string | null;
}

/** A RoundConfig without prompt-only fields (docs/protocol.md, Types). */
export interface RoundPublic {
  id: string;
  title: string;
  summary?: string;
  role: Role | 'none';
  round_type: RoundType;
  length: Length;
  target_minutes: number;
  phases: { id: string; title?: string; minutes: number }[];
  hands: Hands;
  board_kit: BoardKit | null;
  panel: { lead: string; second: string | null };
}

/** content/personas/*.json (persona.schema.json). */
export interface Persona {
  id: string;
  display_name: string;
  title: string;
  avatar_id: AvatarId;
  voice_id: string;
  style: Style;
  warmth: number;
  pushback: number;
  hint_generosity: number;
  speech_habits: string[];
  never: string[];
  interrupts_after_seconds?: number | null;
  behaviour?: string;
  cut_in_keywords?: string[];
}

export interface PersonaPublic {
  id: string;
  display_name: string;
  title: string;
  avatar_id: AvatarId;
  style: Style;
}

export const PERSONALITIES = ['supportive', 'neutral', 'skeptical', 'hostile'] as const;
export type Personality = (typeof PERSONALITIES)[number];
export type DecisionPower = 'approver' | 'influencer' | 'observer';

/** attendee.schema.json */
export interface Attendee {
  name: string;
  role: string;
  cares_about: string[];
  personality: Personality;
  /** Absent or empty = generated before the session. */
  likely_objections?: string[];
  decision_power?: DecisionPower;
  knows?: string;
  voice_base?: string;
}

export const MEETING_TEMPLATE_IDS = ['investor_pitch', 'client_proposal', 'exec_update', 'salary_negotiation', 'performance_review', 'project_kickoff'] as const;
export type MeetingTemplateId = (typeof MEETING_TEMPLATE_IDS)[number];

export type MeetingDifficulty = 'friendly' | 'realistic' | 'tough';
export interface KeyFact {
  label: string;
  value: string;
}

/** content/meeting-templates/*.json (meeting-template.schema.json). */
export interface MeetingTemplate {
  id: MeetingTemplateId;
  title: string;
  summary: string;
  goal: string;
  your_role: string;
  scenario: string;
  attendees: Attendee[];
  hidden_concerns: string[];
  success: string;
  tips: string[];
  key_facts?: KeyFact[];
  ask?: string;
  walk_away?: string | null;
  difficulty?: MeetingDifficulty;
  who_speaks_first?: 'user' | 'chair';
  length?: Length;
  /** True = the user runs the meeting (e.g. a performance review); no AI attendee chairs. */
  user_chairs?: boolean;
}

/** What the user submits to POST /api/meetings/prepare (meeting-setup.schema.json). */
export interface MeetingSetup {
  /** null = custom meeting. */
  template_id: MeetingTemplateId | null;
  goal: string;
  user_role: string;
  attendees: Attendee[];
  length: Length;
  difficulty: MeetingDifficulty;
  key_facts?: string[];
  ask?: string;
  walk_away?: string;
  notes?: string;
}

/** Server only: never sent to the browser. */
export interface AttendeeHidden {
  /** -2 hostile to +2 champion. */
  stance: number;
  concerns: { id: string; text: string; status: 'open' | 'partly' | 'resolved' }[];
  /** User turns before this attendee pushes harder. */
  patience: number;
  persona_id: string;
  avatar_id: AvatarId;
  voice_id: string;
}

/** What the server prepares from a MeetingSetup (meeting-plan.schema.json). */
export interface MeetingPlan {
  /** Name of the attendee who chairs; null exactly when user_chairs is true. */
  chair_attendee: string | null;
  /** True = the user runs the meeting and no AI attendee chairs. */
  user_chairs?: boolean;
  attendees: (Attendee & { hidden: AttendeeHidden })[];
  opening_line: string;
  success_criteria: string[];
  tips: string[];
}

/** MeetingPlan as the browser gets it: every attendees[].hidden removed. */
export interface MeetingPlanPublic extends Omit<MeetingPlan, 'attendees'> {
  attendees: Attendee[];
}

// ---------- Report (content/schema/report.v1.schema.json) ----------

export const VERDICT_LABELS = ['strong_no_hire', 'no_hire', 'leaning_no_hire', 'leaning_hire', 'hire', 'strong_hire'] as const;
export type VerdictLabel = (typeof VERDICT_LABELS)[number];

export type Confidence = 'low' | 'medium' | 'high';

export interface Verdict {
  label: VerdictLabel;
  /** 1..6 */
  index: number;
  /** Short rounds: shown as "Signal so far". */
  is_provisional: boolean;
  confidence: Confidence;
  rationale?: string;
}

export interface Headline {
  summary: string;
  /** Null in meeting mode and when there is not enough signal. */
  verdict?: Verdict | null;
  overall_score?: number | null;
}

export interface Competency {
  id: string;
  name: string;
  score: number | null;
  rationale: string;
  evidence_ids: string[];
  level_label?: 'below' | 'developing' | 'meets_bar' | 'above_bar' | 'not_observed';
  weight?: number;
  delta_vs_last?: number | null;
}

export interface Evidence {
  id: string;
  t_start_sec: number;
  /** 'user' or a persona id. */
  speaker: string;
  quote: string;
  polarity: 'positive' | 'negative' | 'neutral';
  t_end_sec?: number;
  competency_ids?: string[];
  note?: string;
}

export interface ReportPoint {
  title: string;
  detail: string;
  evidence_ids: string[];
}

export interface RetryResult {
  session_id: string;
  at: string;
  before_score: number | null;
  after_score: number | null;
  note: string;
}

export interface WeakestMoment {
  question: string;
  t_start_sec: number;
  what_happened: string;
  strong_answer_covers: string[];
  model_answer: string;
  retry?: { prompt?: string; max_seconds?: number };
  retries?: RetryResult[];
}

export interface NextDrill {
  title: string;
  why: string;
  kind: 'retry_answer' | 'short_round' | 'full_round' | 'meeting' | 'concept_review';
  est_minutes: number;
  round_type?: string;
  round_id?: string;
  question_id?: string;
}

/** Computed by the server; fields are null when the transport gave no timing. */
export interface Delivery {
  wpm?: number | null;
  wpm_band?: 'slow' | 'good' | 'fast' | null;
  filler_per_min?: number | null;
  filler_band?: 'good' | 'okay' | 'work_on_it' | null;
  filler_top?: { word?: string; count?: number }[];
  long_pauses?: { t_sec?: number; dur_sec?: number }[];
  talk_ratio_user?: number | null;
  answers?: { t_start_sec?: number; dur_sec?: number; flag?: 'ok' | 'short' | 'long' }[];
  gaze_on_speaker_pct?: number | null;
  user_interruptions?: number | null;
  hints?: { level?: number; t_sec?: number; accepted?: boolean }[];
}

export interface MeetingDetails {
  kind: 'meeting';
  template?: MeetingTemplateId | 'custom';
  goal?: string;
  outcome?: 'approved' | 'approved_with_conditions' | 'need_more_info' | 'not_now';
  goal_reached?: 'yes' | 'partly' | 'no';
  decision_quote_id?: string;
  ask_made?: boolean;
  stayed_above_walkaway?: boolean | null;
  next_steps?: { owner?: string; action?: string; due?: string }[];
  attendees?: {
    name?: string;
    role?: string;
    stance_start?: number;
    stance_end?: number;
    stance_timeline?: { t_sec?: number; stance?: number; why?: string }[];
    concerns?: { concern?: string; status?: 'resolved' | 'partly' | 'open'; evidence_ids?: string[] }[];
    /** What this person will say about you after the meeting. */
    one_line?: string;
  }[];
  objections?: {
    by?: string;
    t_sec?: number;
    objection?: string;
    handled?: 'well' | 'partly' | 'poorly' | 'not_addressed';
    better_response?: string;
  }[];
}

export type RoundDetails =
  | {
      kind: 'coding';
      time_complexity?: string;
      space_complexity?: string;
      optimal_reached?: boolean;
      blocks_correct_pct?: number;
      edge_cases_named?: string[];
      found_own_bug?: boolean;
    }
  | {
      kind: 'system_design' | 'object_design';
      board_image_url?: string;
      board_as_text?: string;
      requirements_captured?: string[];
      tradeoffs_discussed?: string[];
      missing_components?: string[];
    }
  | {
      kind: 'behavioral';
      stories?: {
        title?: string;
        situation?: boolean;
        action?: boolean;
        result?: boolean;
        quantified?: boolean;
        scope?: 'task' | 'team' | 'multi_team' | 'org';
      }[];
    }
  | { kind: 'pm'; frameworks_used?: string[]; metrics_proposed?: string[]; final_estimate?: string }
  | MeetingDetails;

export interface ReportSession {
  id: string;
  mode: Mode;
  round_type: RoundType;
  length: Length;
  seniority: Level | 'n/a';
  difficulty: 'easy' | 'standard' | 'hard';
  duration_sec: number;
  ended_by: EndReason;
  coverage: { phases_planned?: string[]; phases_completed?: string[]; pct?: number };
  role?: Role | 'none';
  round_id?: string;
  question_id?: string;
  personas?: string[];
  started_at?: string;
}

export interface Report {
  schema_version: '1.0';
  session: ReportSession;
  headline: Headline;
  competencies: Competency[];
  evidence: Evidence[];
  strengths: ReportPoint[];
  weaknesses: ReportPoint[];
  /** Null when there was no answer worth retrying. */
  weakest_moment: WeakestMoment | null;
  next_drills: NextDrill[];
  delivery: Delivery;
  round_details?: RoundDetails;
  share?: { public_slug?: string | null; include_quotes?: boolean };
}

// ---------- REST (docs/protocol.md) ----------

export interface Catalog {
  roles: { id: Role; title: string; summary?: string }[];
  rounds: RoundPublic[];
  meeting_templates: MeetingTemplate[];
  personas: PersonaPublic[];
}

export interface CreateSessionReq {
  mode: Mode;
  round_id?: string;
  meeting_plan_id?: string;
  length: Length;
  level: Level;
  style: Style;
  voice: VoiceChoice;
  parent_session_id?: string;
}

export type PanelistVoice =
  | { transport: 'fish'; fish: { session_token: string; livekit_url: string } }
  | { transport: 'fake' }
  | { transport: 'fish_pending' };

export interface Panelist {
  panelist_id: string;
  persona_id: string;
  display_name: string;
  title: string;
  avatar_id: string;
  seat: Seat;
  voice: PanelistVoice;
}

export interface CreateSessionRes {
  session_id: string;
  client_token: string;
  ws_url: string;
  round: RoundPublic;
  panel: Panelist[];
  /** panelist_id of the panelist who holds the floor. */
  floor: string;
  panel_mode: PanelMode;
  limits: Limits;
}

export interface JoinPanelistRes {
  voice: PanelistVoice;
}

export interface SessionStatusRes {
  status: SessionStatus;
  report_ready: boolean;
}

/** settings.schema.json. PUT /api/me/settings sends the whole object. */
export interface Settings {
  default_role: Role | null;
  default_level: Level;
  default_style: Style;
  /** 0.8 to 1.25, 1 = normal. */
  voice_speed: number;
  captions: boolean;
  dominant_hand: 'right' | 'left';
  /** 0 to 1. */
  sfx_volume: number;
  /** Interviewer brightness in passthrough, 0.6 to 1.2. */
  avatar_brightness: number;
  /** True = hints allowed. */
  practice_mode: boolean;
}

export const LIMIT_REASONS = ['guest_daily_limit', 'guest_full_used', 'judge_budget_reached', 'build_budget_reached', 'free_rounds_used'] as const;
export type LimitReason = (typeof LIMIT_REASONS)[number];

/** me.schema.json#/$defs/limits; also `limits` in CreateSessionRes. null counts mean no limit. */
export interface Limits {
  short_left_today: number | null;
  full_left: number | null;
  resets_at: string | null;
  /** Why a new session is blocked; null = not blocked. */
  reason: LimitReason | null;
}

/** me.schema.json#/$defs/entitlements */
export interface Entitlements {
  plan: 'guest' | 'free' | 'sprint' | 'pro';
  free_rounds_left: number | null;
  minutes_total: number | null;
  minutes_used: number | null;
  period_end: string | null;
}

export interface Streak {
  current: number;
  best: number;
  today_done: boolean;
}

/** GET /api/me (me.schema.json). */
export interface Me {
  identity: { kind: 'guest' | 'user'; name?: string; email?: string };
  sign_in_available: boolean;
  settings: Settings;
  onboarding_done: boolean;
  streak: Streak;
  /** Today's suggested short round; null when there is none. */
  daily: { round_id: string; title: string } | null;
  limits: Limits;
  entitlements: Entitlements;
}

export interface HistoryItem {
  session_id: string;
  round_id: string;
  title: string;
  started_at: string;
  headline: string;
}

export interface Skills {
  competencies: { id: string; name: string; points: { session_id: string; at: string; score: number }[] }[];
}

export interface PrepareMeetingRes {
  meeting_plan_id: string;
  plan: MeetingPlanPublic;
}

export interface ShareRes {
  slug: string;
  url: string;
}

/** Error body the server sends with any 4xx or 5xx. Cap errors add `resets_at`. */
export interface ErrorBody {
  code: string;
  message: string;
  resets_at?: string;
  [key: string]: unknown;
}

// ---------- WebSocket (docs/protocol.md) ----------

export interface HeadSample {
  t_ms: number;
  yaw: number;
  pitch: number;
  speaking: boolean;
  target: string | null;
}

export type VoiceMode = 'listening' | 'thinking' | 'speaking';

/** Client to server payloads, keyed by message type. */
export interface ClientMsgMap {
  hello: { client_token: string; last_seq: number };
  'board.op': BoardOp & { rev_base: number; at_ms: number };
  /** The user dismissed a ghost. */
  'board.ghost_reject': { op_id: string };
  'transcript.mark': {
    segment_id: string;
    panelist_id: string;
    first_at_ms: number;
    final_at_ms: number;
    text: string;
  };
  'head.samples': { samples: HeadSample[] };
  'voice.state': { panelist_id: string; mode: VoiceMode; at_ms: number };
  'ui.event': { kind: 'pause' | 'resume' | 'end' | 'hint' | 'skip_onboarding'; reason?: string };
  ping: Record<string, never>;
}

export interface RoundStatePayload {
  status: SessionStatus;
  phase_id: string;
  phase_index: number;
  phases: { id: string; minutes: number; uses_whiteboard?: boolean }[];
  elapsed_s: number;
  remaining_s: number;
  phase_remaining_s: number;
  brief: { question: string; lines: string[] };
  /** panelist_id holding the floor. */
  floor: string;
}

/** Server to client payloads, keyed by message type. */
export interface ServerMsgMap {
  'round.state': RoundStatePayload;
  'panel.hand_over': { from: string; to: string; opening_line: string };
  'board.ack': { op_id: string; rev: number };
  'board.ghosts': { ghosts: GhostOp[] };
  'board.apply': PerOp<{ op_id: string; rev: number; src: BoardSrc }>;
  'avatar.point_at': { panelist_id: string; item_id: string };
  'round.ending': { closing_line: string };
  'round.ended': { reason: EndReason };
  'report.progress': { stage: 'metrics' | 'scoring' | 'done'; pct: number };
  'report.ready': { session_id: string };
  /** `op_rejected` carries the op_id. */
  error: { code: string; message: string; op_id?: string };
  pong: Record<string, never>;
}

export type ClientMsgType = keyof ClientMsgMap;
export type ServerMsgType = keyof ServerMsgMap;

/** Wire envelope: {"t": type, "seq": n, "d": {...}}. */
export interface Envelope<T extends string = string, D = unknown> {
  t: T;
  seq: number;
  d: D;
  /** Highest client seq the server has processed, when present. */
  ack?: number;
}

export type ClientMsg = { [K in ClientMsgType]: Envelope<K, ClientMsgMap[K]> }[ClientMsgType];
export type ServerMsg = { [K in ServerMsgType]: Envelope<K, ServerMsgMap[K]> }[ServerMsgType];

/** Marker texts the browser sends into the voice session as a typed user turn. */
export const VOICE_MARKERS = {
  start: '[event: start]',
  timeCheck: '[event: time_check]',
  handover: '[event: handover]',
  resume: '[event: resume]',
  silenceCheck: '[event: silence_check]',
  ending: '[event: ending]',
  /** One candidate turn ran past the round's interrupt_after_seconds. */
  longAnswer: '[event: long_answer]',
} as const;
