import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type {
  Board,
  BoardEdge,
  BoardOpLogEntry,
  Competency,
  Evidence,
  NextDrill,
  Report,
  ReportPoint,
  ReportSession,
  RoundConfig,
  RoundPhase,
  WeakestMoment,
} from './types';

// Required keys per type. The type-level checks below fail `tsc` when a list and
// its type drift apart, and the tests check the lists against fixtures and schemas.
type RequiredKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? never : K }[keyof T];
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
function keys<T>() {
  return <const L extends readonly RequiredKeys<T>[]>(
    list: L & (Same<L[number], RequiredKeys<T>> extends true ? unknown : 'list must name every required key'),
  ) => list as readonly string[];
}

const REQUIRED = {
  board: keys<Board>()(['schema', 'round', 'rev', 'size', 'brief', 'items', 'edges']),
  edge: keys<BoardEdge>()(['id', 'from', 'to', 'dir', 'label', 'rel']),
  opLog: keys<BoardOpLogEntry>()(['t', 'rev', 'src', 'op', 'args', 'accepted']),
  round: keys<RoundConfig>()([
    'id',
    'role',
    'round_type',
    'length',
    'target_minutes',
    'hard_stop_minutes',
    'panel',
    'phases',
    'rubric_id',
    'question_pool',
    'hands',
  ]),
  phase: keys<RoundPhase>()(['id', 'minutes', 'goal']),
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
  competency: keys<Competency>()(['id', 'name', 'score', 'rationale', 'evidence_ids']),
  evidence: keys<Evidence>()(['id', 't_start_sec', 'speaker', 'quote', 'polarity']),
  point: keys<ReportPoint>()(['title', 'detail', 'evidence_ids']),
  weakest: keys<WeakestMoment>()(['question', 't_start_sec', 'what_happened', 'strong_answer_covers', 'model_answer']),
  drill: keys<NextDrill>()(['title', 'why', 'kind', 'est_minutes']),
};

const here = dirname(fileURLToPath(import.meta.url));
const contentDir = process.env.IR_CONTENT_DIR ?? resolve(here, '../../../content');
const fixturesDir = join(contentDir, 'fixtures');
const schemaDir = join(contentDir, 'schema');
const haveFixtures = existsSync(join(fixturesDir, 'board.example.json'));

type Json = Record<string, unknown>;
const load = (path: string): Json => JSON.parse(readFileSync(path, 'utf8')) as Json;

function missing(obj: unknown, required: readonly string[]): string[] {
  if (typeof obj !== 'object' || obj === null) return ['<not an object>'];
  return required.filter((k) => !(k in obj));
}

function expectKeys(obj: unknown, required: readonly string[], where: string): void {
  expect(missing(obj, required), `${where} is missing required keys`).toEqual([]);
}

function eachOf(arr: unknown, required: readonly string[], where: string): void {
  expect(Array.isArray(arr), `${where} should be an array`).toBe(true);
  (arr as unknown[]).forEach((x, i) => expectKeys(x, required, `${where}[${i}]`));
}

function checkBoard(board: unknown, where: string): void {
  expectKeys(board, REQUIRED.board, where);
  const b = board as Board;
  expect(b.schema).toBe('ir.board.v1');
  for (const [i, item] of b.items.entries()) {
    expectKeys(item, ['id', 'kind'], `${where}.items[${i}]`);
  }
  eachOf(b.edges, REQUIRED.edge, `${where}.edges`);
}

describe.skipIf(!haveFixtures)(`fixtures in ${fixturesDir}`, () => {
  it('fixtures_match_types', () => {
    checkBoard(load(join(fixturesDir, 'board.example.json')), 'board.example');

    const round = load(join(fixturesDir, 'round.example.json'));
    expectKeys(round, REQUIRED.round, 'round.example');
    eachOf(round.phases, REQUIRED.phase, 'round.example.phases');

    const report = load(join(fixturesDir, 'report.example.json')) as unknown as Report;
    expectKeys(report, REQUIRED.report, 'report.example');
    expectKeys(report.session, REQUIRED.session, 'report.session');
    expectKeys(report.headline, ['summary'], 'report.headline');
    eachOf(report.competencies, REQUIRED.competency, 'report.competencies');
    eachOf(report.evidence, REQUIRED.evidence, 'report.evidence');
    eachOf(report.strengths, REQUIRED.point, 'report.strengths');
    eachOf(report.weaknesses, REQUIRED.point, 'report.weaknesses');
    expectKeys(report.weakest_moment, REQUIRED.weakest, 'report.weakest_moment');
    eachOf(report.next_drills, REQUIRED.drill, 'report.next_drills');

    const opsDir = join(fixturesDir, 'board-ops');
    const opFiles = existsSync(opsDir) ? readdirSync(opsDir).filter((f) => f.endsWith('.json')) : [];
    expect(opFiles.length, 'board-ops fixtures').toBeGreaterThan(0);
    for (const f of opFiles) {
      const seq = load(join(opsDir, f));
      expect(Array.isArray(seq.ops), `${f}.ops`).toBe(true);
      for (const [i, op] of (seq.ops as unknown[]).entries()) {
        expectKeys(op, ['op_id', 'src', 'op', 'args'], `${f}.ops[${i}]`);
      }
      checkBoard(seq.expected, `${f}.expected`);
    }
  });

  it.skipIf(!existsSync(schemaDir))('types_require_what_schemas_require', () => {
    const cases: [string, readonly string[], (s: Json) => unknown][] = [
      ['board.v1.schema.json', REQUIRED.board, (s) => s],
      ['round.schema.json', REQUIRED.round, (s) => s],
      ['report.v1.schema.json', REQUIRED.report, (s) => s],
      ['report.v1.schema.json', REQUIRED.session, (s) => (s.properties as Json).session],
    ];
    for (const [file, ours, pick] of cases) {
      const schema = pick(load(join(schemaDir, file))) as { required?: string[] };
      expect([...(schema.required ?? [])].sort(), `${file} required`).toEqual([...ours].sort());
    }
  });
});

describe.runIf(!haveFixtures)('fixtures not present', () => {
  it.skip(`fixtures_match_types: no fixtures at ${fixturesDir}; set IR_CONTENT_DIR to a content/ folder`, () => {});
});
