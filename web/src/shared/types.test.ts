import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AVATAR_IDS,
  BOARD_KITS,
  BOARD_OP_NAMES,
  BOARD_SRCS,
  CLASS_KINDS,
  COMPONENT_TYPES,
  EDGE_DIRS,
  EDGE_RELS,
  END_REASONS,
  HANDS,
  LANES,
  LEVELS,
  LIMIT_REASONS,
  MEETING_TEMPLATE_IDS,
  METRIC_ROLES,
  PERSONALITIES,
  QUADS,
  ROUND_TYPES,
  STYLES,
  VERDICT_LABELS,
  VIS,
  VOICE_MARKERS,
} from './types';
import type {
  Attendee,
  AttendeeHidden,
  Board,
  BoardCode,
  BoardEdge,
  BoardMeeting,
  BoardOp,
  BoardOpName,
  BoardOpsFixture,
  ClassItem,
  ClassMember,
  ClientMsgType,
  CodeLine,
  Competency,
  ComponentItem,
  Delivery,
  Entitlements,
  Evidence,
  GhostOp,
  GroupItem,
  Headline,
  InkItem,
  InterviewerCardItem,
  Limits,
  Me,
  MeetingDetails,
  MeetingPlan,
  MeetingSetup,
  MeetingTemplate,
  MetricItem,
  NextDrill,
  OpLogEntry,
  Persona,
  Report,
  ReportPoint,
  ReportSession,
  RetryResult,
  RoundConfig,
  RoundPhase,
  ServerMsgType,
  Settings,
  StickyItem,
  UndoFixture,
  Verdict,
  WeakestMoment,
} from './types';

// ---------- Shape specs ----------
// A spec lists every property of a type with its flag: 'req' or 'opt', plus '|null' when null
// is allowed. `spec<T>()({...})` only compiles when the spec matches T exactly (no missing or
// extra keys, right flags), and the tests compare each spec with its schema: same property
// names, same required list, same nullable set. So a field added, dropped, made optional or
// made nullable on either side fails here.

type Flag<T, K extends keyof T> = `${object extends Pick<T, K> ? 'opt' : 'req'}${null extends T[K] ? '|null' : ''}`;
type Spec<T> = { [K in keyof T]-?: Flag<T, K> };
type SpecMap = Readonly<Record<string, string>>;
const spec =
  <T,>() =>
  (s: Spec<T>): SpecMap =>
    s as SpecMap;

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const assertSame = <A, B>(ok: Same<A, B>) => ok;

// Every op name and every message type is listed (compile time).
assertSame<(typeof BOARD_OP_NAMES)[number], BoardOpName>(true);
const CLIENT_TYPES = ['hello', 'board.op', 'transcript.mark', 'head.samples', 'voice.state', 'voice.spoken', 'ui.event', 'board.ghost_reject', 'board.focus', 'ping'] as const;
const SERVER_TYPES = [
  'round.state',
  'panel.hand_over',
  'board.ack',
  'board.ghosts',
  'board.apply',
  'avatar.point_at',
  'round.ending',
  'round.ended',
  'report.progress',
  'report.ready',
  'error',
  'pong',
] as const;
assertSame<(typeof CLIENT_TYPES)[number], ClientMsgType>(true);
assertSame<(typeof SERVER_TYPES)[number], ServerMsgType>(true);

const S = {
  board: spec<Board>()({
    schema: 'req',
    round: 'req',
    rev: 'req',
    size: 'req',
    brief: 'req',
    items: 'req',
    edges: 'req',
    code: 'req|null',
    meeting: 'req|null',
    focus: 'req|null',
    ghosts: 'req',
    op_ids: 'req',
  }),
  boardRound: spec<Board['round']>()({ id: 'req', type: 'req', question_id: 'req|null', language: 'req|null' }),
  component: spec<ComponentItem>()({
    id: 'req',
    kind: 'req',
    type: 'req',
    label: 'req|null',
    x: 'req',
    y: 'req',
    w: 'req',
    h: 'req',
    group: 'opt|null',
    notes: 'opt',
  }),
  member: spec<ClassMember>()({ id: 'req', vis: 'req', name: 'req', type: 'opt|null', params: 'opt', returns: 'opt|null' }),
  class: spec<ClassItem>()({
    id: 'req',
    kind: 'req',
    label: 'req|null',
    class_kind: 'req',
    fields: 'req',
    methods: 'req',
    x: 'req',
    y: 'req',
    w: 'req',
    h: 'req',
    group: 'opt|null',
  }),
  sticky: spec<StickyItem>()({
    id: 'req',
    kind: 'req',
    lane: 'req|null',
    text: 'req',
    group: 'opt|null',
    votes: 'req',
    quad: 'req|null',
    rank: 'opt|null',
    x: 'req',
    y: 'req',
    w: 'opt',
    h: 'opt',
  }),
  group: spec<GroupItem>()({ id: 'req', kind: 'req', label: 'req|null', x: 'req', y: 'req', w: 'req', h: 'req' }),
  metric: spec<MetricItem>()({
    id: 'req',
    kind: 'req',
    role: 'req',
    label: 'req|null',
    group: 'opt|null',
    x: 'req',
    y: 'req',
    w: 'opt',
    h: 'opt',
  }),
  ink: spec<InkItem>()({ id: 'req', kind: 'req', points: 'req', recognized: 'req|null' }),
  interviewer_card: spec<InterviewerCardItem>()({
    id: 'req',
    kind: 'req',
    title: 'req',
    body: 'req',
    x: 'req',
    y: 'req',
    w: 'opt',
    h: 'opt',
  }),
  edge: spec<BoardEdge>()({ id: 'req', from: 'req', to: 'req', dir: 'req', label: 'req|null', rel: 'req|null' }),
  codeLine: spec<CodeLine>()({ id: 'req', indent: 'req', text: 'req', src: 'req' }),
  code: spec<BoardCode>()({ language: 'req', lines: 'req', approach: 'req', complexity: 'req', trace: 'req' }),
  meeting: spec<BoardMeeting>()({ agenda: 'req', numbers: 'opt', shown: 'req', parked: 'req' }),
  agendaItem: spec<BoardMeeting['agenda'][number]>()({ id: 'req', text: 'req', done: 'req', t: 'req|null' }),
  boardOp: spec<BoardOp>()({ op_id: 'req', src: 'req', op: 'req', args: 'req', rev_base: 'opt', at_ms: 'opt' }),
  ghostOp: spec<GhostOp>()({ op_id: 'req', src: 'req', op: 'req', args: 'req' }),
  opLog: spec<OpLogEntry>()({ op_id: 'req', t: 'req', rev: 'req', src: 'req', op: 'req', args: 'req', accepted: 'req' }),
  opsFixture: spec<BoardOpsFixture>()({ name: 'req', start: 'req', ops: 'req', expected: 'req' }),
  undoFixture: spec<UndoFixture>()({ name: 'req', start: 'req', log: 'req', undo: 'req', expected: 'req' }),

  round: spec<RoundConfig>()({
    id: 'req',
    title: 'req',
    summary: 'opt',
    role: 'req',
    round_type: 'req',
    length: 'req',
    target_minutes: 'req',
    hard_stop_minutes: 'req',
    silence_wait_seconds: 'req',
    interrupt_after_seconds: 'req',
    panel: 'req',
    phases: 'req',
    rubric_id: 'req',
    question_pool: 'req',
    hands: 'req',
    board_kit: 'req|null',
    short_version: 'opt|null',
    full_version: 'opt|null',
  }),
  roundPanel: spec<RoundConfig['panel']>()({ lead: 'req', second: 'opt|null', second_enters_phase: 'opt|null' }),
  phase: spec<RoundPhase>()({ id: 'req', title: 'opt', minutes: 'req', goal: 'req', must_cover: 'opt', uses_whiteboard: 'opt' }),
  persona: spec<Persona>()({
    id: 'req',
    display_name: 'req',
    title: 'req',
    avatar_id: 'req',
    voice_id: 'req',
    style: 'req',
    warmth: 'req',
    pushback: 'req',
    hint_generosity: 'req',
    interrupts_after_seconds: 'opt|null',
    behaviour: 'opt',
    cut_in_keywords: 'opt',
    speech_habits: 'req',
    never: 'req',
  }),
  attendee: spec<Attendee>()({
    name: 'req',
    role: 'req',
    cares_about: 'req',
    personality: 'req',
    likely_objections: 'opt',
    decision_power: 'opt',
    knows: 'opt',
    voice_base: 'opt',
  }),
  template: spec<MeetingTemplate>()({
    id: 'req',
    title: 'req',
    summary: 'req',
    goal: 'req',
    your_role: 'req',
    scenario: 'req',
    attendees: 'req',
    hidden_concerns: 'req',
    success: 'req',
    tips: 'req',
    key_facts: 'opt',
    ask: 'opt',
    walk_away: 'opt|null',
    difficulty: 'opt',
    who_speaks_first: 'opt',
    length: 'opt',
    user_chairs: 'opt',
  }),
  settings: spec<Settings>()({
    default_role: 'req|null',
    default_level: 'req',
    default_style: 'req',
    voice_speed: 'req',
    captions: 'req',
    dominant_hand: 'req',
    sfx_volume: 'req',
    avatar_brightness: 'req',
    practice_mode: 'req',
  }),
  meetingSetup: spec<MeetingSetup>()({
    template_id: 'req|null',
    goal: 'req',
    user_role: 'req',
    attendees: 'req',
    length: 'req',
    key_facts: 'opt',
    ask: 'opt',
    walk_away: 'opt',
    notes: 'opt',
    difficulty: 'req',
  }),
  meetingPlan: spec<MeetingPlan>()({
    chair_attendee: 'req|null',
    user_chairs: 'opt',
    attendees: 'req',
    opening_line: 'req',
    success_criteria: 'req',
    tips: 'req',
  }),
  hidden: spec<AttendeeHidden>()({
    stance: 'req',
    concerns: 'req',
    patience: 'req',
    persona_id: 'req',
    avatar_id: 'req',
    voice_id: 'req',
  }),
  concern: spec<AttendeeHidden['concerns'][number]>()({ id: 'req', text: 'req', status: 'req' }),
  me: spec<Me>()({
    identity: 'req',
    sign_in_available: 'req',
    settings: 'req',
    onboarding_done: 'req',
    streak: 'req',
    daily: 'req|null',
    limits: 'req',
    entitlements: 'req',
    resumable: 'req|null',
  }),
  identity: spec<Me['identity']>()({ kind: 'req', name: 'opt', email: 'opt' }),
  limits: spec<Limits>()({ short_left_today: 'req|null', full_left: 'req|null', resets_at: 'req|null', reason: 'req|null' }),
  entitlements: spec<Entitlements>()({
    plan: 'req',
    free_rounds_left: 'req|null',
    minutes_total: 'req|null',
    minutes_used: 'req|null',
    period_end: 'req|null',
  }),

  report: spec<Report>()({
    schema_version: 'req',
    session: 'req',
    headline: 'req',
    competencies: 'req',
    evidence: 'req',
    strengths: 'req',
    weaknesses: 'req',
    weakest_moment: 'req|null',
    next_drills: 'req',
    delivery: 'req',
    round_details: 'opt',
    share: 'opt',
  }),
  session: spec<ReportSession>()({
    id: 'req',
    mode: 'req',
    role: 'opt',
    round_id: 'opt',
    round_type: 'req',
    length: 'req',
    seniority: 'req',
    difficulty: 'req',
    question_id: 'opt',
    personas: 'opt',
    started_at: 'opt',
    duration_sec: 'req',
    ended_by: 'req',
    coverage: 'req',
  }),
  headline: spec<Headline>()({ summary: 'req', verdict: 'opt|null', overall_score: 'opt|null' }),
  verdict: spec<Verdict>()({ label: 'req', index: 'req', is_provisional: 'req', confidence: 'req', rationale: 'opt' }),
  competency: spec<Competency>()({
    id: 'req',
    name: 'req',
    score: 'req|null',
    level_label: 'opt',
    weight: 'opt',
    rationale: 'req',
    evidence_ids: 'req',
    delta_vs_last: 'opt|null',
  }),
  evidence: spec<Evidence>()({
    id: 'req',
    t_start_sec: 'req',
    t_end_sec: 'opt',
    speaker: 'req',
    quote: 'req',
    polarity: 'req',
    competency_ids: 'opt',
    note: 'opt',
  }),
  point: spec<ReportPoint>()({ title: 'req', detail: 'req', evidence_ids: 'req' }),
  weakest: spec<WeakestMoment>()({
    question: 'req',
    t_start_sec: 'req',
    what_happened: 'req',
    strong_answer_covers: 'req',
    model_answer: 'req',
    retry: 'opt',
    retries: 'opt',
  }),
  retry: spec<RetryResult>()({ session_id: 'req', at: 'req', before_score: 'req|null', after_score: 'req|null', note: 'req' }),
  drill: spec<NextDrill>()({
    title: 'req',
    why: 'req',
    kind: 'req',
    round_type: 'opt',
    round_id: 'opt',
    question_id: 'opt',
    est_minutes: 'req',
  }),
  delivery: spec<Delivery>()({
    wpm: 'opt|null',
    wpm_band: 'opt|null',
    filler_per_min: 'opt|null',
    filler_band: 'opt|null',
    filler_top: 'opt',
    long_pauses: 'opt',
    talk_ratio_user: 'opt|null',
    answers: 'opt',
    gaze_on_speaker_pct: 'opt|null',
    user_interruptions: 'opt|null',
    hints: 'opt',
  }),
  meetingDetails: spec<MeetingDetails>()({
    kind: 'req',
    template: 'opt',
    goal: 'opt',
    outcome: 'opt',
    goal_reached: 'opt',
    decision_quote_id: 'opt',
    ask_made: 'opt',
    stayed_above_walkaway: 'opt|null',
    next_steps: 'opt',
    attendees: 'opt',
    objections: 'opt',
  }),
};

const ITEM_SPECS: Record<string, SpecMap> = {
  component: S.component,
  class: S.class,
  sticky: S.sticky,
  group: S.group,
  metric: S.metric,
  ink: S.ink,
  interviewer_card: S.interviewer_card,
};

// ---------- Content location ----------

const here = dirname(fileURLToPath(import.meta.url));
const contentDir = process.env.IR_CONTENT_DIR ?? resolve(here, '../../../content');
const fixturesDir = join(contentDir, 'fixtures');
const schemaDir = join(contentDir, 'schema');
const protocolPath = join(contentDir, '..', 'docs', 'protocol.md');
const haveFixtures = existsSync(join(fixturesDir, 'board.example.json'));
const haveSchemas = existsSync(join(schemaDir, 'board.v1.schema.json'));

type Json = Record<string, unknown>;
const load = (path: string): Json => JSON.parse(readFileSync(path, 'utf8')) as Json;
const sorted = (xs: Iterable<string>) => [...xs].sort();
const keysWhere = (s: SpecMap, test: (flag: string) => boolean) => Object.keys(s).filter((k) => test(s[k] ?? ''));

// ---------- Fixture checks (values against specs) ----------

function checkObject(obj: unknown, s: SpecMap, where: string): Json {
  expect(typeof obj === 'object' && obj !== null && !Array.isArray(obj), `${where} should be an object`).toBe(true);
  const o = obj as Json;
  expect(sorted(Object.keys(o).filter((k) => !(k in s))), `${where} has keys the type does not know`).toEqual([]);
  expect(keysWhere(s, (f) => f.startsWith('req')).filter((k) => !(k in o)), `${where} is missing required keys`).toEqual([]);
  expect(
    Object.keys(o).filter((k) => o[k] === null && !(s[k] ?? '').endsWith('|null')),
    `${where} has null where the type does not allow it`,
  ).toEqual([]);
  return o;
}

function eachOf(arr: unknown, s: SpecMap, where: string): Json[] {
  expect(Array.isArray(arr), `${where} should be an array`).toBe(true);
  return (arr as unknown[]).map((x, i) => checkObject(x, s, `${where}[${i}]`));
}

function checkBoard(board: unknown, where: string): void {
  const b = checkObject(board, S.board, where) as unknown as Board;
  checkObject(b.round, S.boardRound, `${where}.round`);
  b.items.forEach((item, i) => {
    const s = ITEM_SPECS[item.kind];
    expect(s, `${where}.items[${i}] has unknown kind ${item.kind}`).toBeDefined();
    checkObject(item, s ?? {}, `${where}.items[${i}]`);
    if (item.kind === 'class') {
      eachOf(item.fields, S.member, `${where}.items[${i}].fields`);
      eachOf(item.methods, S.member, `${where}.items[${i}].methods`);
    }
  });
  eachOf(b.edges, S.edge, `${where}.edges`);
  eachOf(b.ghosts, S.ghostOp, `${where}.ghosts`);
  b.ghosts.forEach((g, i) => expect(BOARD_OP_NAMES, `${where}.ghosts[${i}].op`).toContain(g.op));
  if (b.code) {
    checkObject(b.code, S.code, `${where}.code`);
    eachOf(b.code.lines, S.codeLine, `${where}.code.lines`);
  }
  if (b.meeting) {
    checkObject(b.meeting, S.meeting, `${where}.meeting`);
    eachOf(b.meeting.agenda, S.agendaItem, `${where}.meeting.agenda`);
  }
}

function checkOps(ops: unknown, s: SpecMap, where: string): void {
  eachOf(ops, s, where).forEach((op, i) => expect(BOARD_OP_NAMES, `${where}[${i}].op`).toContain(op.op));
}

const jsonFiles = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : []);

describe.skipIf(!haveFixtures)(`content fixtures (${fixturesDir})`, () => {
  it('fixtures_match_types', () => {
    checkBoard(load(join(fixturesDir, 'board.example.json')), 'board.example');

    const round = checkObject(load(join(fixturesDir, 'round.example.json')), S.round, 'round.example');
    checkObject(round.panel, S.roundPanel, 'round.example.panel');
    eachOf(round.phases, S.phase, 'round.example.phases');

    const report = checkObject(load(join(fixturesDir, 'report.example.json')), S.report, 'report.example') as unknown as Report;
    checkObject(report.session, S.session, 'report.session');
    const headline = checkObject(report.headline, S.headline, 'report.headline');
    if (headline.verdict) checkObject(headline.verdict, S.verdict, 'report.headline.verdict');
    eachOf(report.competencies, S.competency, 'report.competencies');
    eachOf(report.evidence, S.evidence, 'report.evidence');
    eachOf(report.strengths, S.point, 'report.strengths');
    eachOf(report.weaknesses, S.point, 'report.weaknesses');
    if (report.weakest_moment) {
      checkObject(report.weakest_moment, S.weakest, 'report.weakest_moment');
      eachOf(report.weakest_moment.retries ?? [], S.retry, 'report.weakest_moment.retries');
    }
    eachOf(report.next_drills, S.drill, 'report.next_drills');
    checkObject(report.delivery, S.delivery, 'report.delivery');
    if (report.round_details?.kind === 'meeting') checkObject(report.round_details, S.meetingDetails, 'report.round_details');

    const optional = (name: string) => (existsSync(join(fixturesDir, name)) ? load(join(fixturesDir, name)) : null);
    const settings = optional('settings.example.json');
    if (settings) checkObject(settings, S.settings, 'settings.example');
    const template = optional('meeting-template.example.json');
    if (template) {
      checkObject(template, S.template, 'meeting-template.example');
      eachOf(template.attendees, S.attendee, 'meeting-template.attendees');
    }
    const setup = optional('meeting-setup.example.json');
    if (setup) {
      checkObject(setup, S.meetingSetup, 'meeting-setup.example');
      eachOf(setup.attendees, S.attendee, 'meeting-setup.attendees');
    }
    for (const name of ['meeting-plan.example.json', 'meeting-plan.user-chairs.example.json']) {
      const plan = optional(name);
      if (!plan) continue;
      const p = checkObject(plan, S.meetingPlan, name);
      eachOf(p.attendees, { ...S.attendee, hidden: 'req' }, `${name}.attendees`).forEach((a, i) => {
        const h = checkObject(a.hidden, S.hidden, `${name}.attendees[${i}].hidden`);
        eachOf(h.concerns, S.concern, `${name}.attendees[${i}].hidden.concerns`);
      });
      // chair_attendee is null exactly when the user chairs.
      expect(p.chair_attendee === null, `${name}: chair_attendee null iff user_chairs`).toBe(p.user_chairs === true);
    }
    const me = optional('me.example.json');
    if (me) {
      checkObject(me, S.me, 'me.example');
      checkObject(me.identity, S.identity, 'me.identity');
      checkObject(me.settings, S.settings, 'me.settings');
      checkObject(me.limits, S.limits, 'me.limits');
      checkObject(me.entitlements, S.entitlements, 'me.entitlements');
    }

    const opFiles = jsonFiles(join(fixturesDir, 'board-ops'));
    expect(opFiles.length, 'board-ops fixtures').toBeGreaterThan(0);
    for (const f of opFiles) {
      const fx = checkObject(load(join(fixturesDir, 'board-ops', f)), S.opsFixture, f);
      checkOps(fx.ops, S.boardOp, `${f}.ops`);
      checkBoard(fx.start, `${f}.start`);
      checkBoard(fx.expected, `${f}.expected`);
    }

    for (const f of jsonFiles(join(fixturesDir, 'board-undo'))) {
      const fx = checkObject(load(join(fixturesDir, 'board-undo', f)), S.undoFixture, f);
      checkOps(fx.log, S.opLog, `${f}.log`);
      checkObject(fx.undo, S.boardOp, `${f}.undo`);
      expect((fx.undo as Json).op, `${f}.undo.op`).toBe('undo');
      checkBoard(fx.start, `${f}.start`);
      checkBoard(fx.expected, `${f}.expected`);
    }
  });
});

// ---------- Schema checks (specs and enums against the schemas) ----------

function resolveRef(ref: string, root: Json): Json | null {
  if (!ref.startsWith('#/')) return null; // another file: never a bare null in our schemas
  let node: unknown = root;
  for (const part of ref.slice(2).split('/')) node = (node as Json | undefined)?.[part];
  return (node as Json) ?? null;
}

function allowsNull(prop: Json | undefined, root: Json, depth = 0): boolean {
  if (!prop || depth > 8) return false;
  const type = prop.type;
  if (type === 'null' || (Array.isArray(type) && type.includes('null'))) return true;
  if (Array.isArray(prop.enum) && prop.enum.includes(null)) return true;
  if ('const' in prop && prop.const === null) return true;
  for (const key of ['oneOf', 'anyOf'] as const) {
    const alts = prop[key];
    if (Array.isArray(alts) && alts.some((a) => allowsNull(a as Json, root, depth + 1))) return true;
  }
  if (typeof prop.$ref === 'string' && !prop.type) return allowsNull(resolveRef(prop.$ref, root) ?? undefined, root, depth + 1);
  return false;
}

function compareShape(where: string, node: unknown, root: Json, s: SpecMap): void {
  const n = node as Json;
  expect(n, `${where} not found in schema`).toBeTruthy();
  const props = (n.properties ?? {}) as Record<string, Json>;
  expect(sorted(Object.keys(props)), `${where} property names`).toEqual(sorted(Object.keys(s)));
  expect(sorted((n.required as string[] | undefined) ?? []), `${where} required`).toEqual(
    sorted(keysWhere(s, (f) => f.startsWith('req'))),
  );
  expect(sorted(Object.keys(props).filter((k) => allowsNull(props[k], root))), `${where} nullable`).toEqual(
    sorted(keysWhere(s, (f) => f.endsWith('|null'))),
  );
}

const enumOf = (node: unknown) => sorted(((node as Json | undefined)?.enum as unknown[] | undefined ?? []).filter((v) => v !== null) as string[]);

describe.skipIf(!haveSchemas)(`content schemas (${schemaDir})`, () => {
  const schema = (name: string) => load(join(schemaDir, name));
  const props = (n: unknown) => (n as Json).properties as Record<string, Json>;
  const items = (n: unknown) => (n as Json).items as Json;

  it('types_mirror_schemas', () => {
    const board = schema('board.v1.schema.json');
    const bd = board.$defs as Record<string, Json>;
    const round = schema('round.schema.json');
    const persona = schema('persona.schema.json');
    const attendee = schema('attendee.schema.json');
    const template = schema('meeting-template.schema.json');
    const settings = schema('settings.schema.json');
    const setup = schema('meeting-setup.schema.json');
    const plan = schema('meeting-plan.schema.json');
    const me = schema('me.schema.json');
    const report = schema('report.v1.schema.json');
    const rp = props(report);
    const meeting = bd.meeting as Json;

    const cases: [string, unknown, Json, SpecMap][] = [
      ['board', board, board, S.board],
      ['board.round', props(board).round, board, S.boardRound],
      ...Object.entries(ITEM_SPECS).map(([k, v]): [string, unknown, Json, SpecMap] => [`board.$defs.${k}`, bd[k], board, v]),
      ['board.$defs.member', bd.member, board, S.member],
      ['board.$defs.edge', bd.edge, board, S.edge],
      ['board.$defs.code_line', bd.code_line, board, S.codeLine],
      ['board.$defs.code', bd.code, board, S.code],
      ['board.$defs.meeting', meeting, board, S.meeting],
      ['board.$defs.meeting.agenda[]', items(props(meeting).agenda), board, S.agendaItem],
      ['board.$defs.board_op', bd.board_op, board, S.boardOp],
      ['board.$defs.ghost_op', bd.ghost_op, board, S.ghostOp],
      ['board.$defs.op_log_entry', bd.op_log_entry, board, S.opLog],
      ['board.$defs.ops_fixture', bd.ops_fixture, board, S.opsFixture],
      ['board.$defs.undo_fixture', bd.undo_fixture, board, S.undoFixture],
      ['round', round, round, S.round],
      ['round.panel', props(round).panel, round, S.roundPanel],
      ['round.phases[]', items(props(round).phases), round, S.phase],
      ['persona', persona, persona, S.persona],
      ['attendee', (attendee.$defs as Json).base, attendee, S.attendee],
      ['meeting-template', template, template, S.template],
      ['settings', settings, settings, S.settings],
      ['meeting-setup', setup, setup, S.meetingSetup],
      ['meeting-plan', plan, plan, S.meetingPlan],
      ['meeting-plan.$defs.hidden', (plan.$defs as Json).hidden, plan, S.hidden],
      ['meeting-plan.hidden.concerns[]', items(props((plan.$defs as Json).hidden).concerns), plan, S.concern],
      ['me', me, me, S.me],
      ['me.identity', props(me).identity, me, S.identity],
      ['me.$defs.limits', (me.$defs as Json).limits, me, S.limits],
      ['me.$defs.entitlements', (me.$defs as Json).entitlements, me, S.entitlements],
      ['report', report, report, S.report],
      ['report.session', rp.session, report, S.session],
      ['report.headline', rp.headline, report, S.headline],
      ['report.headline.verdict', props(rp.headline).verdict, report, S.verdict],
      ['report.competencies[]', items(rp.competencies), report, S.competency],
      ['report.evidence[]', items(rp.evidence), report, S.evidence],
      ['report.$defs.points[]', items((report.$defs as Json).points), report, S.point],
      ['report.weakest_moment', rp.weakest_moment, report, S.weakest],
      ['report.weakest_moment.retries[]', items(props(rp.weakest_moment).retries), report, S.retry],
      ['report.next_drills[]', items(rp.next_drills), report, S.drill],
      ['report.delivery', rp.delivery, report, S.delivery],
      ['report.$defs.meeting', (report.$defs as Json).meeting, report, S.meetingDetails],
    ];
    for (const [where, node, root, s] of cases) compareShape(where, node, root, s);
  });

  it('enums_match_schemas', () => {
    const board = schema('board.v1.schema.json');
    const bd = board.$defs as Record<string, Json>;
    const round = props(schema('round.schema.json'));
    const persona = props(schema('persona.schema.json'));
    const attendee = props((schema('attendee.schema.json').$defs as Json).base);
    const report = props(schema('report.v1.schema.json'));
    const limits = props((schema('me.schema.json').$defs as Json).limits);

    const cases: [string, readonly string[], unknown][] = [
      ['op_name', BOARD_OP_NAMES, bd.op_name],
      ['board_kit', BOARD_KITS, bd.board_kit],
      ['src', BOARD_SRCS, bd.src],
      ['component_type', COMPONENT_TYPES, bd.component_type],
      ['class_kind', CLASS_KINDS, bd.class_kind],
      ['metric_role', METRIC_ROLES, bd.metric_role],
      ['lane', LANES, bd.lane],
      ['quad', QUADS, bd.quad],
      ['dir', EDGE_DIRS, bd.dir],
      ['rel', EDGE_RELS, bd.rel],
      ['vis', VIS, bd.vis],
      ['round.round_type', ROUND_TYPES, round.round_type],
      ['round.hands', HANDS, round.hands],
      ['round.board_kit', BOARD_KITS, round.board_kit],
      ['settings.default_level', LEVELS, props(schema('settings.schema.json')).default_level],
      ['persona.style', STYLES, persona.style],
      ['persona.avatar_id', AVATAR_IDS, persona.avatar_id],
      ['attendee.personality', PERSONALITIES, attendee.personality],
      ['meeting-template.id', MEETING_TEMPLATE_IDS, props(schema('meeting-template.schema.json')).id],
      ['meeting-setup.template_id', MEETING_TEMPLATE_IDS, props(schema('meeting-setup.schema.json')).template_id],
      ['limits.reason', LIMIT_REASONS, limits.reason],
      ['report.verdict.label', VERDICT_LABELS, props(props(report.headline).verdict).label],
      ['report.session.ended_by', END_REASONS, props(report.session).ended_by],
      ['report.session.round_type', ROUND_TYPES, props(report.session).round_type],
    ];
    for (const [where, ours, node] of cases) expect(sorted(ours), `${where} enum`).toEqual(enumOf(node));
  });
});

describe.skipIf(!existsSync(protocolPath))(`protocol (${protocolPath})`, () => {
  const text = existsSync(protocolPath) ? readFileSync(protocolPath, 'utf8') : '';
  const bullet = (label: string) => {
    const start = text.indexOf(`- ${label}`);
    const end = text.indexOf('\n- ', start + 2);
    return text.slice(start, end);
  };
  const names = (s: string) => sorted(new Set([...s.matchAll(/`([a-z]+(?:\.[a-z_]+)*)(?: \{|`)/g)].map((m) => m[1] ?? '')));

  it('message_types_match_protocol', () => {
    expect(names(bullet('Client → server:')), 'client to server').toEqual(sorted(CLIENT_TYPES));
    expect(names(bullet('Server → client:')), 'server to client').toEqual(sorted(SERVER_TYPES));
  });

  it('voice_markers_match_protocol', () => {
    const inDoc = sorted(new Set([...text.matchAll(/`(\[event: [a-z_]+\])`/g)].map((m) => m[1] ?? '')));
    expect(inDoc).toEqual(sorted(Object.values(VOICE_MARKERS)));
  });
});

describe.runIf(!haveFixtures)('content folder not found', () => {
  it.skip(`fixtures_match_types: no fixtures at ${fixturesDir}; set IR_CONTENT_DIR to a content/ folder`, () => {});
});
