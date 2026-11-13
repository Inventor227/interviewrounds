import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type {
  Attendee,
  AttendeeHidden,
  Entitlements,
  Limits,
  Me,
  MeetingPlan,
  MeetingSetup,
  Settings,
  Board,
  BoardEdge,
  BoardOp,
  BoardOpsFixture,
  ClassItem,
  ClassMember,
  CodeLine,
  Competency,
  ComponentItem,
  Evidence,
  GhostOp,
  GroupItem,
  InkItem,
  InterviewerCardItem,
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
  StickyItem,
  Verdict,
  WeakestMoment,
} from './types';

// Required keys per type. `keys<T>()([...])` only compiles when the list names exactly
// the required keys of T, so `tsc` catches a type that drifts from its list; the tests
// then check each list against the schema and the fixtures.
type RequiredKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? never : K }[keyof T];
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
function keys<T>() {
  return <const L extends readonly RequiredKeys<T>[]>(
    list: L & (Same<L[number], RequiredKeys<T>> extends true ? unknown : 'list must name every required key'),
  ) => list as readonly string[];
}

const R = {
  board: keys<Board>()(['schema', 'round', 'rev', 'size', 'brief', 'items', 'edges', 'code', 'meeting', 'focus', 'ghosts', 'op_ids']),
  component: keys<ComponentItem>()(['id', 'kind', 'type', 'label', 'x', 'y', 'w', 'h']),
  class: keys<ClassItem>()(['id', 'kind', 'label', 'class_kind', 'fields', 'methods', 'x', 'y', 'w', 'h']),
  sticky: keys<StickyItem>()(['id', 'kind', 'lane', 'text', 'votes', 'quad', 'x', 'y']),
  group: keys<GroupItem>()(['id', 'kind', 'label', 'x', 'y', 'w', 'h']),
  metric: keys<MetricItem>()(['id', 'kind', 'role', 'label', 'x', 'y']),
  ink: keys<InkItem>()(['id', 'kind', 'points', 'recognized']),
  interviewer_card: keys<InterviewerCardItem>()(['id', 'kind', 'title', 'body', 'x', 'y']),
  member: keys<ClassMember>()(['id', 'vis', 'name']),
  edge: keys<BoardEdge>()(['id', 'from', 'to', 'dir', 'label', 'rel']),
  codeLine: keys<CodeLine>()(['id', 'indent', 'text', 'src']),
  boardOp: keys<BoardOp>()(['op_id', 'src', 'op', 'args']),
  ghostOp: keys<GhostOp>()(['op_id', 'src', 'op', 'args']),
  opLog: keys<OpLogEntry>()(['op_id', 't', 'rev', 'src', 'op', 'args', 'accepted']),
  opsFixture: keys<BoardOpsFixture>()(['name', 'start', 'ops', 'expected']),
  round: keys<RoundConfig>()([
    'id',
    'title',
    'role',
    'round_type',
    'length',
    'target_minutes',
    'hard_stop_minutes',
    'silence_wait_seconds',
    'interrupt_after_seconds',
    'panel',
    'phases',
    'rubric_id',
    'question_pool',
    'hands',
    'board_kit',
  ]),
  phase: keys<RoundPhase>()(['id', 'minutes', 'goal']),
  persona: keys<Persona>()([
    'id',
    'display_name',
    'title',
    'avatar_id',
    'voice_id',
    'style',
    'warmth',
    'pushback',
    'hint_generosity',
    'speech_habits',
    'never',
  ]),
  attendee: keys<Attendee>()(['name', 'role', 'cares_about', 'personality']),
  settings: keys<Settings>()([
    'default_role',
    'default_level',
    'default_style',
    'voice_speed',
    'captions',
    'dominant_hand',
    'sfx_volume',
    'avatar_brightness',
    'practice_mode',
  ]),
  meetingSetup: keys<MeetingSetup>()(['template_id', 'goal', 'user_role', 'attendees', 'length', 'difficulty']),
  meetingPlan: keys<MeetingPlan>()(['chair_attendee', 'attendees', 'opening_line', 'success_criteria', 'tips']),
  hidden: keys<AttendeeHidden>()(['stance', 'concerns', 'patience', 'persona_id', 'avatar_id', 'voice_id']),
  me: keys<Me>()(['identity', 'sign_in_available', 'settings', 'onboarding_done', 'streak', 'daily', 'limits', 'entitlements']),
  limits: keys<Limits>()(['short_left_today', 'full_left', 'resets_at', 'reason']),
  entitlements: keys<Entitlements>()(['plan', 'free_rounds_left', 'minutes_total', 'minutes_used', 'period_end']),
  template: keys<MeetingTemplate>()([
    'id',
    'title',
    'summary',
    'goal',
    'your_role',
    'scenario',
    'attendees',
    'hidden_concerns',
    'success',
    'tips',
  ]),
  report: keys<Report>()([
    'schema_version',
    'session',
    'headline',
    'competencies',
    'evidence',
    'strengths',
    'weaknesses',
    'weakest_moment',
    'next_drills',
    'delivery',
  ]),
  session: keys<ReportSession>()([
    'id',
    'mode',
    'round_type',
    'length',
    'seniority',
    'difficulty',
    'duration_sec',
    'ended_by',
    'coverage',
  ]),
  verdict: keys<Verdict>()(['label', 'index', 'is_provisional', 'confidence']),
  competency: keys<Competency>()(['id', 'name', 'score', 'rationale', 'evidence_ids']),
  evidence: keys<Evidence>()(['id', 't_start_sec', 'speaker', 'quote', 'polarity']),
  point: keys<ReportPoint>()(['title', 'detail', 'evidence_ids']),
  weakest: keys<WeakestMoment>()(['question', 't_start_sec', 'what_happened', 'strong_answer_covers', 'model_answer']),
  retry: keys<RetryResult>()(['session_id', 'at', 'before_score', 'after_score', 'note']),
  drill: keys<NextDrill>()(['title', 'why', 'kind', 'est_minutes']),
};

const ITEM_KEYS: Record<string, readonly string[]> = {
  component: R.component,
  class: R.class,
  sticky: R.sticky,
  group: R.group,
  metric: R.metric,
  ink: R.ink,
  interviewer_card: R.interviewer_card,
};

const here = dirname(fileURLToPath(import.meta.url));
const contentDir = process.env.IR_CONTENT_DIR ?? resolve(here, '../../../content');
const fixturesDir = join(contentDir, 'fixtures');
const schemaDir = join(contentDir, 'schema');
const haveFixtures = existsSync(join(fixturesDir, 'board.example.json'));
const haveSchemas = existsSync(join(schemaDir, 'board.v1.schema.json'));

type Json = Record<string, unknown>;
const load = (path: string): Json => JSON.parse(readFileSync(path, 'utf8')) as Json;

function expectKeys(obj: unknown, required: readonly string[], where: string): void {
  const missing =
    typeof obj === 'object' && obj !== null ? required.filter((k) => !(k in obj)) : ['<not an object>'];
  expect(missing, `${where} is missing required keys`).toEqual([]);
}

function eachOf(arr: unknown, required: readonly string[], where: string): void {
  expect(Array.isArray(arr), `${where} should be an array`).toBe(true);
  (arr as unknown[]).forEach((x, i) => expectKeys(x, required, `${where}[${i}]`));
}

function checkBoard(board: unknown, where: string): void {
  expectKeys(board, R.board, where);
  const b = board as Board;
  expect(b.schema).toBe('ir.board.v1');
  b.items.forEach((item, i) => {
    const req = ITEM_KEYS[item.kind];
    expect(req, `${where}.items[${i}] has unknown kind ${item.kind}`).toBeDefined();
    expectKeys(item, req ?? [], `${where}.items[${i}]`);
    if (item.kind === 'class') {
      eachOf(item.fields, R.member, `${where}.items[${i}].fields`);
      eachOf(item.methods, R.member, `${where}.items[${i}].methods`);
    }
  });
  eachOf(b.edges, R.edge, `${where}.edges`);
  eachOf(b.ghosts, R.ghostOp, `${where}.ghosts`);
  if (b.code) eachOf(b.code.lines, R.codeLine, `${where}.code.lines`);
}

describe.skipIf(!haveFixtures)(`content fixtures (${fixturesDir})`, () => {
  it('fixtures_match_types', () => {
    checkBoard(load(join(fixturesDir, 'board.example.json')), 'board.example');

    const round = load(join(fixturesDir, 'round.example.json'));
    expectKeys(round, R.round, 'round.example');
    eachOf(round.phases, R.phase, 'round.example.phases');

    const report = load(join(fixturesDir, 'report.example.json')) as unknown as Report;
    expectKeys(report, R.report, 'report.example');
    expectKeys(report.session, R.session, 'report.session');
    expectKeys(report.headline, ['summary'], 'report.headline');
    if (report.headline.verdict) expectKeys(report.headline.verdict, R.verdict, 'report.headline.verdict');
    eachOf(report.competencies, R.competency, 'report.competencies');
    eachOf(report.evidence, R.evidence, 'report.evidence');
    eachOf(report.strengths, R.point, 'report.strengths');
    eachOf(report.weaknesses, R.point, 'report.weaknesses');
    if (report.weakest_moment) {
      expectKeys(report.weakest_moment, R.weakest, 'report.weakest_moment');
      eachOf(report.weakest_moment.retries ?? [], R.retry, 'report.weakest_moment.retries');
    }
    eachOf(report.next_drills, R.drill, 'report.next_drills');

    const optional = (name: string) => {
      const path = join(fixturesDir, name);
      return existsSync(path) ? load(path) : null;
    };
    const settings = optional('settings.example.json');
    if (settings) expectKeys(settings, R.settings, 'settings.example');
    const setup = optional('meeting-setup.example.json');
    if (setup) {
      expectKeys(setup, R.meetingSetup, 'meeting-setup.example');
      eachOf(setup.attendees, R.attendee, 'meeting-setup.attendees');
    }
    const plan = optional('meeting-plan.example.json');
    if (plan) {
      expectKeys(plan, R.meetingPlan, 'meeting-plan.example');
      eachOf(plan.attendees, [...R.attendee, 'hidden'], 'meeting-plan.attendees');
      (plan.attendees as { hidden: unknown }[]).forEach((a, i) =>
        expectKeys(a.hidden, R.hidden, `meeting-plan.attendees[${i}].hidden`),
      );
    }
    const me = optional('me.example.json');
    if (me) {
      expectKeys(me, R.me, 'me.example');
      expectKeys(me.settings, R.settings, 'me.settings');
      expectKeys(me.limits, R.limits, 'me.limits');
      expectKeys(me.entitlements, R.entitlements, 'me.entitlements');
    }

    const opsDir = join(fixturesDir, 'board-ops');
    const files = existsSync(opsDir) ? readdirSync(opsDir).filter((f) => f.endsWith('.json')) : [];
    expect(files.length, 'board-ops fixtures').toBeGreaterThan(0);
    for (const f of files) {
      const fx = load(join(opsDir, f));
      expectKeys(fx, R.opsFixture, f);
      eachOf(fx.ops, R.boardOp, `${f}.ops`);
      checkBoard(fx.start, `${f}.start`);
      checkBoard(fx.expected, `${f}.expected`);
    }
  });
});

describe.skipIf(!haveSchemas)(`content schemas (${schemaDir})`, () => {
  it('types_require_what_schemas_require', () => {
    const board = load(join(schemaDir, 'board.v1.schema.json'));
    const report = load(join(schemaDir, 'report.v1.schema.json'));
    const bd = board.$defs as Record<string, Json>;
    const rp = report.properties as Record<string, Json>;
    const items = (j: Json) => j.items as Json;
    const props = (j: Json) => j.properties as Record<string, Json>;

    const cases: [string, unknown, readonly string[]][] = [
      ['board', board, R.board],
      ...Object.entries(ITEM_KEYS).map(([k, v]): [string, unknown, readonly string[]] => [`board.$defs.${k}`, bd[k], v]),
      ['board.$defs.member', bd.member, R.member],
      ['board.$defs.edge', bd.edge, R.edge],
      ['board.$defs.code_line', bd.code_line, R.codeLine],
      ['board.$defs.board_op', bd.board_op, R.boardOp],
      ['board.$defs.ghost_op', bd.ghost_op, R.ghostOp],
      ['board.$defs.op_log_entry', bd.op_log_entry, R.opLog],
      ['board.$defs.ops_fixture', bd.ops_fixture, R.opsFixture],
      ['round', load(join(schemaDir, 'round.schema.json')), R.round],
      ['round.phases[]', items(props(load(join(schemaDir, 'round.schema.json'))).phases as Json), R.phase],
      ['persona', load(join(schemaDir, 'persona.schema.json')), R.persona],
      ['attendee', (load(join(schemaDir, 'attendee.schema.json')).$defs as Record<string, Json>).base, R.attendee],
      ['meeting-template', load(join(schemaDir, 'meeting-template.schema.json')), R.template],
      ['report', report, R.report],
      ['report.session', rp.session, R.session],
      ['report.headline.verdict', props(rp.headline as Json).verdict, R.verdict],
      ['report.competencies[]', items(rp.competencies as Json), R.competency],
      ['report.evidence[]', items(rp.evidence as Json), R.evidence],
      ['report.$defs.points[]', items((report.$defs as Record<string, Json>).points as Json), R.point],
      ['report.weakest_moment', rp.weakest_moment, R.weakest],
      ['report.weakest_moment.retries[]', items(props(rp.weakest_moment as Json).retries as Json), R.retry],
      ['report.next_drills[]', items(rp.next_drills as Json), R.drill],
    ];
    const optionalSchema = (name: string) => {
      const path = join(schemaDir, name);
      return existsSync(path) ? load(path) : null;
    };
    const settings = optionalSchema('settings.schema.json');
    if (settings) cases.push(['settings', settings, R.settings]);
    const setup = optionalSchema('meeting-setup.schema.json');
    if (setup) cases.push(['meeting-setup', setup, R.meetingSetup]);
    const plan = optionalSchema('meeting-plan.schema.json');
    if (plan) {
      cases.push(['meeting-plan', plan, R.meetingPlan]);
      cases.push(['meeting-plan.$defs.hidden', (plan.$defs as Record<string, Json>).hidden, R.hidden]);
    }
    const me = optionalSchema('me.schema.json');
    if (me) {
      const defs = me.$defs as Record<string, Json>;
      cases.push(['me', me, R.me], ['me.$defs.limits', defs.limits, R.limits], ['me.$defs.entitlements', defs.entitlements, R.entitlements]);
    }
    for (const [where, schema, ours] of cases) {
      const required = ((schema as { required?: string[] } | undefined)?.required ?? []).slice().sort();
      expect(required, `${where} required keys`).toEqual([...ours].sort());
    }
  });
});

describe.runIf(!haveFixtures)('content folder not found', () => {
  it.skip(`fixtures_match_types: no fixtures at ${fixturesDir}; set IR_CONTENT_DIR to a content/ folder`, () => {});
});
