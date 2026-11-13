// Shared types for the web app. They mirror docs/protocol.md (REST and WebSocket)
// and content/schema/*.json (board, report, round, persona, attendee, meeting template).
// When one of those files changes, change this file in the same commit.

// ---------- Small enums ----------

export type Role = 'sde' | 'pm';
export type Mode = 'interview' | 'meeting';
export type Length = 'short' | 'full';
export type Level = 'junior' | 'mid' | 'senior' | 'staff';
export type Style = 'warm' | 'neutral' | 'tough';
export type VoiceChoice = 'fish' | 'fake';
export type PanelMode = 'swap' | 'joined';
export type Seat = 0 | 1 | 2;

export type RoundType =
  | 'coding'
  | 'system_design'
  | 'object_design'
  | 'behavioral'
  | 'recruiter_screen'
  | 'pm_product_sense'
  | 'pm_execution'
  | 'pm_estimation'
  | 'pm_strategy'
  | 'pm_leadership'
  | 'meeting';

export type EndReason = 'completed' | 'user_ended' | 'time_limit' | 'disconnected' | 'headset_removed';

export type SessionStatus = 'created' | 'live' | 'paused' | 'scoring' | 'scored' | 'failed' | 'abandoned';

/** Open bag for values the contract leaves to the server (caps, minutes, flags). */
export type Bag = Record<string, string | number | boolean | null>;

// ---------- Board (content/schema/board.v1.schema.json) ----------

export type BoardSrc = 'hand' | 'voice_grammar' | 'scribe' | 'interviewer';

export type BoardOpName =
  | 'item.create'
  | 'item.move'
  | 'item.delete'
  | 'item.label'
  | 'item.set_type'
  | 'item.note.add'
  | 'edge.create'
  | 'edge.delete'
  | 'edge.set_dir'
  | 'edge.set_rel'
  | 'edge.label'
  | 'group.create'
  | 'member.add'
  | 'member.move'
  | 'member.remove'
  | 'sticky.vote'
  | 'sticky.set_quad'
  | 'code.insert'
  | 'code.edit'
  | 'code.move'
  | 'code.indent'
  | 'code.delete'
  | 'code.complexity'
  | 'code.trace'
  | 'agenda.check'
  | 'present.show'
  | 'park.add'
  | 'undo';

export type OpArgs = Record<string, unknown>;

interface ItemBase {
  id: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  group?: string | null;
}

export interface ComponentItem extends ItemBase {
  kind: 'component';
  type: string;
  label: string;
  notes?: string[];
}

export interface ClassMember {
  vis: '+' | '-' | '#' | '~';
  name: string;
  type?: string;
}

export interface ClassMethod {
  vis: '+' | '-' | '#' | '~';
  name: string;
  params: { name: string; type: string }[];
  returns: string | null;
}

export interface ClassItem extends ItemBase {
  kind: 'class';
  label: string;
  class_kind: 'class' | 'interface' | 'abstract' | 'enum';
  fields: ClassMember[];
  methods: ClassMethod[];
}

export interface StickyItem extends ItemBase {
  kind: 'sticky';
  lane: string;
  text: string;
  votes?: number;
  quad?: string | null;
}

export interface GroupItem extends ItemBase {
  kind: 'group';
  label: string;
}

export interface MetricItem extends ItemBase {
  kind: 'metric';
  role: string;
  label: string;
}

export interface InkItem extends ItemBase {
  kind: 'ink';
  points: [number, number][];
  recognized: string | null;
}

export interface InterviewerCardItem extends ItemBase {
  kind: 'interviewer_card';
  title: string;
  body: string;
}

export type BoardItem =
  | ComponentItem
  | ClassItem
  | StickyItem
  | GroupItem
  | MetricItem
  | InkItem
  | InterviewerCardItem;

export type EdgeDir = '->' | '<-' | '<->' | '--';
export type EdgeRel = 'uses' | 'has_a' | 'is_a' | 'implements';

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
  trace: { line: string; t: number }[];
}

export interface BoardMeeting {
  agenda: { id: string; text: string; done: boolean; t: number | null }[];
  shown: { kind: string; ref: number | string; t: number }[];
  parked: string[];
}

/** A Scribe or interviewer suggestion that is not committed yet. */
export interface GhostOp {
  op: BoardOpName;
  src: 'scribe' | 'interviewer';
  args?: OpArgs;
  [key: string]: unknown;
}

export interface Board {
  schema: 'ir.board.v1';
  round: { id: string; type: string; question_id: string | null; language: string | null };
  rev: number;
  size: { w: number; h: number };
  brief: { question: string; lines: string[] };
  items: BoardItem[];
  edges: BoardEdge[];
  code?: BoardCode | null;
  meeting?: BoardMeeting | null;
  focus?: string | null;
  ghosts?: GhostOp[];
}

/** A board op as the client emits it (the `board.op` socket payload). */
export interface BoardOp {
  op_id: string;
  rev_base: number;
  src: BoardSrc;
  op: BoardOpName;
  args: OpArgs;
  at_ms: number;
}

/** One entry of the append-only op log stored with the board. */
export interface BoardOpLogEntry {
  t: number;
  rev: number;
  src: BoardSrc;
  op: BoardOpName;
  args: OpArgs;
  accepted: boolean;
}

// ---------- Rounds, personas, meetings (content/schema) ----------

export interface RoundPhase {
  id: string;
  minutes: number;
  goal: string;
  must_cover?: string[];
  uses_whiteboard?: boolean;
}

export interface RoundPanel {
  lead: string;
  second?: string;
  second_enters_phase?: string;
  third?: string;
}

/** A round config file (content/rounds/*.json). Server side only; the client sees RoundPublic. */
export interface RoundConfig {
  id: string;
  role: Role | 'none';
  round_type: RoundType;
  length: Length;
  target_minutes: number;
  hard_stop_minutes: number;
  panel: RoundPanel;
  phases: RoundPhase[];
  rubric_id: string;
  question_pool: string;
  hands: string;
  short_version?: string;
  full_version?: string;
  title?: string;
  summary?: string;
}

/** What the client gets for a round: no prompts, no rubric, no question pool. */
export interface RoundPublic {
  id: string;
  role: Role | 'none';
  round_type: RoundType;
  length: Length;
  title: string;
  summary: string;
  target_minutes: number;
  hard_stop_minutes: number;
  phases: { id: string; minutes: number; uses_whiteboard?: boolean }[];
  hands: string;
}

export interface Persona {
  id: string;
  display_name: string;
  title: string;
  voice_id: string;
  style: Style;
  warmth: number;
  pushback: number;
  hint_generosity: number;
  interrupts_after_seconds: number;
  speech_habits: string[];
  never: string[];
  avatar_id?: string;
}

export interface PersonaPublic {
  id: string;
  display_name: string;
  title: string;
  style: Style;
  avatar_id: string;
}

export type Personality = 'supportive' | 'neutral' | 'skeptical' | 'hostile';
export type DecisionPower = 'approver' | 'influencer' | 'observer';

export interface Attendee {
  name: string;
  role: string;
  cares_about: string[];
  personality: Personality;
  likely_objections: string[];
  decision_power?: DecisionPower;
  knows?: string;
  voice_base?: string;
}

export type MeetingTemplateId =
  | 'investor_pitch'
  | 'client_proposal'
  | 'exec_update'
  | 'salary_negotiation'
  | 'performance_review'
  | 'project_kickoff'
  | 'custom';

export interface MeetingTemplate {
  id: MeetingTemplateId;
  title: string;
  goal: string;
  user_role: string;
  attendees: Attendee[];
  length: Length;
  summary?: string;
}

export type MeetingDifficulty = 'friendly' | 'realistic' | 'tough';

/** The meeting setup form (POST /api/meetings/prepare). */
export interface MeetingSetup {
  template: MeetingTemplateId;
  goal: string;
  user_role: string;
  attendees: Attendee[];
  length: Length;
  key_facts?: string;
  ask?: string;
  walk_away?: string;
  notes?: string;
  difficulty?: MeetingDifficulty;
  first_speaker?: 'user' | 'attendee';
}

export interface MeetingPlanAttendee extends Attendee {
  persona_id: string;
  avatar_id: string;
  stance: -2 | -1 | 0 | 1 | 2;
  concerns: { text: string; status: 'open' | 'partly' | 'resolved' }[];
  patience: number;
}

/** What prepare returns: the setup with gaps filled, hidden state and the chair. */
export interface MeetingPlan {
  setup: MeetingSetup;
  attendees: MeetingPlanAttendee[];
  chair_persona_id: string;
  opening_line: string;
}

// ---------- Report (content/schema/report.v1.schema.json) ----------

export type VerdictLabel =
  | 'strong_no_hire'
  | 'no_hire'
  | 'leaning_no_hire'
  | 'leaning_hire'
  | 'hire'
  | 'strong_hire';

export type Confidence = 'low' | 'medium' | 'high';

export interface Verdict {
  label: VerdictLabel;
  index: number;
  is_provisional?: boolean;
  confidence?: Confidence;
  rationale?: string;
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
  retry?: {
    prompt?: string;
    max_seconds?: number;
    attempts?: { at?: string; score?: number; what_improved?: string }[];
  };
  retries?: RetryResult[];
}

export interface NextDrill {
  title: string;
  why: string;
  kind: 'retry_answer' | 'short_round' | 'full_round' | 'meeting' | 'concept_review';
  est_minutes: number;
  round_type?: string;
  question_id?: string;
}

export interface Delivery {
  wpm?: number | null;
  wpm_band?: 'slow' | 'good' | 'fast' | null;
  filler_per_min?: number | null;
  filler_top?: { word: string; count: number }[];
  long_pauses?: { t_sec: number; dur_sec: number }[];
  talk_ratio_user?: number | null;
  answers?: { t_start_sec: number; dur_sec: number; flag: 'ok' | 'short' | 'long' }[];
  gaze_on_speaker_pct?: number | null;
  user_interruptions?: number | null;
  hints?: { level: number; t_sec: number; accepted: boolean }[];
}

export interface MeetingDetails {
  kind: 'meeting';
  template?: MeetingTemplateId;
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
    stance_timeline?: { t_sec: number; stance: number; why: string }[];
    concerns?: { concern: string; status: 'resolved' | 'partly' | 'open'; evidence_ids?: string[] }[];
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
  question_id?: string;
  personas?: string[];
  started_at?: string;
}

export interface Report {
  schema_version: '1.0';
  session: ReportSession;
  headline: { summary: string; verdict?: Verdict | null; overall_score?: number | null };
  competencies: Competency[];
  evidence: Evidence[];
  strengths: ReportPoint[];
  weaknesses: ReportPoint[];
  weakest_moment: WeakestMoment;
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
  limits: Bag;
}

export interface JoinPanelistRes {
  voice: PanelistVoice;
}

export interface SessionStatusRes {
  status: SessionStatus;
  report_ready: boolean;
}

export interface Settings {
  default_role: Role;
  default_level: Level;
  style: Style;
  /** Interviewer speaking speed, 1 = normal. */
  voice_speed: number;
  captions: boolean;
  dominant_hand: 'left' | 'right';
  /** 0..1 */
  volume: number;
  /** Interviewer brightness in passthrough, 0..1. */
  brightness: number;
  practice_mode: boolean;
}

export interface Streak {
  current: number;
  best: number;
  today_done: boolean;
}

export interface Me {
  identity: { kind: 'guest' | 'user'; name?: string; email?: string };
  sign_in_available: boolean;
  settings: Settings;
  onboarding_done: boolean;
  streak: Streak;
  daily: { round_id: string; title: string };
  limits: Bag;
  entitlements: Bag;
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
  plan: MeetingPlan;
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
  'board.op': BoardOp;
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
  'board.apply': { op_id: string; rev: number; src: BoardSrc; op: BoardOpName; args: OpArgs };
  'avatar.point_at': { panelist_id: string; item_id: string };
  'round.ending': { closing_line: string };
  'round.ended': { reason: EndReason };
  'report.progress': { stage: 'metrics' | 'scoring' | 'done'; pct: number };
  'report.ready': { session_id: string };
  error: { code: string; message: string };
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
} as const;
