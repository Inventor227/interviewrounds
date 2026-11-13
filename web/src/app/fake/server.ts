// A small in-page stand-in for the server's REST routes, built from content/ and content/fixtures/.
// Tests use createFakeServer() as their fetch; `?fake=<scenario>` in dev installs it for the page.
//
// Scenarios for GET /api/me: `1` returning guest with a streak, `first` first visit (onboarding),
// `resume` a dropped round to resume, `capped` guest daily limit reached, `user` signed in on Pro,
// `empty` no history yet.
// Report ids: any id gives the system design example; `meeting`, `nosignal`, `scoring` (ready
// after a few polls), `failed` and `abandoned` give those states.

import meFixture from '../../../../content/fixtures/me.example.json';
import planFixture from '../../../../content/fixtures/meeting-plan.example.json';
import reportFixture from '../../../../content/fixtures/report.example.json';
import type {
  Catalog,
  CreateSessionReq,
  CreateSessionRes,
  Length,
  HistoryItem,
  MeetingPlanPublic,
  MeetingSetup,
  MeetingTemplate,
  Me,
  Persona,
  Report,
  Role,
  RoundConfig,
  RoundPublic,
  Settings,
  Skills,
} from '../../shared/types';

const roundFiles = import.meta.glob<RoundConfig>('../../../../content/rounds/*.json', { eager: true, import: 'default' });
const personaFiles = import.meta.glob<Persona>('../../../../content/personas/*.json', { eager: true, import: 'default' });
const templateFiles = import.meta.glob<MeetingTemplate>('../../../../content/meeting-templates/*.json', {
  eager: true,
  import: 'default',
});

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function toPublic(r: RoundConfig): RoundPublic {
  return {
    id: r.id,
    title: r.title,
    summary: r.summary,
    role: r.role,
    round_type: r.round_type,
    length: r.length,
    target_minutes: r.target_minutes,
    phases: r.phases.map((p) => ({ id: p.id, title: p.title, minutes: p.minutes })),
    hands: r.hands,
    board_kit: r.board_kit,
    panel: { lead: r.panel.lead, second: r.panel.second ?? null },
  };
}

export function fakeCatalog(): Catalog {
  const order = ['sde.system_design', 'sde.coding', 'sde.object_design', 'sde.behavioral', 'pm.product_sense', 'pm.execution', 'pm.leadership', 'meeting'];
  const rank = (id: string) => order.findIndex((o) => id.startsWith(o));
  return {
    roles: [
      { id: 'sde', title: 'Software Engineer', summary: 'Coding, system design, object design, behavioral' },
      { id: 'pm', title: 'Product Manager', summary: 'Product sense, execution, leadership' },
    ],
    rounds: Object.values(roundFiles)
      .map(toPublic)
      .sort((a, b) => rank(a.id) - rank(b.id) || a.length.localeCompare(b.length)),
    meeting_templates: Object.values(templateFiles).map(clone),
    personas: Object.values(personaFiles).map((p) => ({
      id: p.id,
      display_name: p.display_name,
      title: p.title,
      avatar_id: p.avatar_id,
      style: p.style,
    })),
  };
}

const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();
const DAY = 86_400_000;

export function fakeMe(scenario: string): Me {
  const me = clone(meFixture) as Me;
  me.resumable = null;
  me.limits.resets_at = nextMidnight();
  if (scenario === 'first') return me;
  me.onboarding_done = true;
  me.streak = { current: 3, best: 5, today_done: false };
  me.daily = { round_id: 'sde.system_design.short', title: 'System design' };
  if (scenario === 'resume') {
    me.resumable = { session_id: 's_resume', round_title: 'System design', expires_at: iso(161_000) };
  }
  if (scenario === 'capped') {
    me.limits = { short_left_today: 0, full_left: 1, resets_at: nextMidnight(), reason: 'guest_daily_limit' };
  }
  if (scenario === 'user') {
    me.identity = { kind: 'user', name: 'Alex Rivera', email: 'alex@example.com' };
    me.entitlements = { plan: 'pro', free_rounds_left: null, minutes_total: 150, minutes_used: 42.5, period_end: iso(19 * DAY) };
    me.settings.default_role = 'sde';
  }
  if (scenario === 'empty') {
    me.streak = { current: 0, best: 0, today_done: false };
  }
  return me;
}

function nextMidnight(): string {
  const d = new Date();
  d.setHours(24, 0, 0, 0);
  return d.toISOString();
}

export function fakeHistory(role?: Role): HistoryItem[] {
  const items: (HistoryItem & { role: Role })[] = [
    { session_id: 'demo', round_id: 'sde.system_design.short', title: 'System design', started_at: iso(-2 * 3600_000), headline: reportFixture.headline.summary, role: 'sde' },
    { session_id: 'nosignal', round_id: 'sde.coding.short', title: 'Coding', started_at: iso(-1 * DAY), headline: 'The round ended early, so there is not enough to score.', role: 'sde' },
    { session_id: 'h3', round_id: 'pm.product_sense.short', title: 'Product sense', started_at: iso(-2 * DAY), headline: 'Strong user focus. The metric for success came late.', role: 'pm' },
    { session_id: 'h4', round_id: 'sde.behavioral.short', title: 'Behavioral', started_at: iso(-3 * DAY), headline: 'A clear story with a real result. Say more about your own part.', role: 'sde' },
    { session_id: 'h5', round_id: 'sde.system_design.short', title: 'System design', started_at: iso(-5 * DAY), headline: 'Good scoping. The diagram missed a data store.', role: 'sde' },
  ];
  return items.filter((i) => !role || i.role === role).map(({ role: _r, ...rest }) => rest);
}

export function fakeSkills(): Skills {
  const at = (d: number) => iso(-d * DAY);
  const series = (vals: number[]) => vals.map((score, i) => ({ session_id: `k${i}`, at: at(vals.length - i), score }));
  return {
    competencies: [
      { id: 'requirements', name: 'Requirements and scoping', points: series([2, 2, 3, 3, 3]) },
      { id: 'architecture', name: 'High level architecture', points: series([1, 2, 2, 3, 3]) },
      { id: 'tradeoffs', name: 'Depth and tradeoffs', points: series([1, 1, 2, 2, 2]) },
      { id: 'reliability', name: 'Reliability and operations', points: series([2, 2, 2, 3, 3]) },
    ],
  };
}

export function fakeReport(id: string): Report {
  const r = clone(reportFixture) as Report;
  r.session.id = id;
  r.competencies = r.competencies.map((c, i) => ({ ...c, delta_vs_last: [1, 0, -1, null][i] ?? null }));
  if (id === 'nosignal') {
    r.session.duration_sec = 74;
    r.session.ended_by = 'user_ended';
    r.session.coverage = { phases_planned: ['requirements', 'diagram', 'probe'], phases_completed: [], pct: 0.1 };
    r.headline = { summary: 'The round ended after about a minute, before the first full answer.', verdict: null, overall_score: null };
    r.competencies = r.competencies.map((c) => ({ ...c, score: null, level_label: 'not_observed', rationale: 'Not observed.', evidence_ids: [], delta_vs_last: null }));
    r.strengths = [];
    r.weaknesses = [];
    r.weakest_moment = null;
    r.next_drills = [{ title: 'Short system design: URL shortener', why: 'Same round, from the start.', kind: 'short_round', round_id: 'sde.system_design.short', est_minutes: 8 }];
    r.delivery = { wpm: null, filler_per_min: null, talk_ratio_user: null, gaze_on_speaker_pct: null };
    r.round_details = undefined;
  }
  if (id === 'meeting') return meetingReport(r);
  return r;
}

function meetingReport(base: Report): Report {
  const r = base;
  r.session = { ...r.session, mode: 'meeting', role: 'none', round_id: 'meeting.short', round_type: 'meeting', seniority: 'n/a', personas: ['persona.ana', 'persona.leo'] };
  r.headline = { summary: 'You opened with the ask and held your numbers. Churn questions caught you once.', verdict: null, overall_score: 2.9 };
  r.competencies = [
    { id: 'clarity', name: 'Clear ask', score: 3, rationale: 'The ask came in the first minute.', evidence_ids: ['ev1'], delta_vs_last: 1 },
    { id: 'evidence', name: 'Backs claims with numbers', score: 3, rationale: 'Growth and price were exact.', evidence_ids: ['ev2'], delta_vs_last: null },
    { id: 'objections', name: 'Handles objections', score: 2, rationale: 'The churn answer was vague at first.', evidence_ids: ['ev3'], delta_vs_last: null },
    { id: 'close', name: 'Gets to a decision', score: 3, rationale: 'Asked for a date and got one.', evidence_ids: ['ev4'], delta_vs_last: null },
  ];
  r.evidence = [
    { id: 'ev1', t_start_sec: 12, speaker: 'user', quote: 'We are raising 1.5 million to reach 200 clinics in 18 months, and I would like a partner meeting next week.', polarity: 'positive' },
    { id: 'ev2', t_start_sec: 95, speaker: 'user', quote: 'We grew 15 percent a month for six months, at 400 dollars per clinic.', polarity: 'positive' },
    { id: 'ev3', t_start_sec: 210, speaker: 'user', quote: 'Churn is low, I think, it is pretty early.', polarity: 'negative' },
    { id: 'ev4', t_start_sec: 440, speaker: 'user', quote: 'Can we put Tuesday on the calendar for the partner meeting?', polarity: 'positive' },
  ];
  r.strengths = [
    { title: 'Ask up front', detail: 'Rhea knew what you wanted before the first question.', evidence_ids: ['ev1'] },
    { title: 'Numbers first', detail: 'Growth and price came as exact figures.', evidence_ids: ['ev2'] },
  ];
  r.weaknesses = [{ title: 'Churn answer', detail: 'You hedged before giving the 2 percent figure.', evidence_ids: ['ev3'] }];
  r.weakest_moment = {
    question: 'What is your monthly churn?',
    t_start_sec: 205,
    what_happened: 'You hedged, then gave the number a minute later.',
    strong_answer_covers: ['The number first', 'How long the cohort is', 'What you do to keep clinics'],
    model_answer: 'Two percent of clinics a month. Our oldest cohort is nine months old, so it is early, and we call every clinic in its first month.',
    retry: { prompt: 'Tom asks again: what is your monthly churn?', max_seconds: 90 },
  };
  r.next_drills = [
    { title: 'Retry the churn question', why: 'Your weakest moment; two minutes.', kind: 'retry_answer', est_minutes: 2 },
    { title: 'Run the pitch again, tough', why: 'Practice the number questions under pressure.', kind: 'meeting', est_minutes: 8 },
  ];
  r.round_details = {
    kind: 'meeting',
    template: 'investor_pitch',
    goal: 'Get a partner meeting next week to discuss terms.',
    outcome: 'approved_with_conditions',
    goal_reached: 'partly',
    ask_made: true,
    stayed_above_walkaway: null,
    next_steps: [{ owner: 'You', action: 'Send the churn cohort table', due: 'Friday' }, { owner: 'Rhea', action: 'Book the partner meeting', due: 'Next Tuesday' }],
    attendees: [
      { name: 'Rhea', role: 'Partner, seed fund', stance_start: -1, stance_end: 1, one_line: 'Sharp on the market. I want to see the churn cohorts.' },
      { name: 'Tom', role: 'Associate', stance_start: 0, stance_end: 0, one_line: 'Numbers hold up so far.' },
    ],
    objections: [
      { by: 'Rhea', t_sec: 140, objection: 'Clinic software is crowded.', handled: 'well' },
      { by: 'Tom', t_sec: 205, objection: 'What is your monthly churn?', handled: 'partly', better_response: 'Say the number first, then the context.' },
    ],
  };
  return r;
}

export function fakePlan(setup: MeetingSetup): MeetingPlanPublic {
  const base = clone(planFixture) as unknown as MeetingPlanPublic & { attendees: { hidden?: unknown }[] };
  const suggest = ['What is that number based on?', 'What happens if you are wrong by half?', 'Who owns this after launch?'];
  const attendees = setup.attendees.map((a) => ({
    ...a,
    likely_objections: a.likely_objections?.length ? a.likely_objections : suggest.map((s) => s),
  }));
  const approver = attendees.find((a) => a.decision_power === 'approver') ?? attendees[0];
  return {
    chair_attendee: approver?.name ?? null,
    attendees,
    opening_line: base.opening_line,
    success_criteria: base.success_criteria,
    tips: base.tips,
  };
}

// ---------- sessions ----------

function capFor(me: Me, length: Length): Response | null {
  const l = me.limits;
  const reason = l.reason && !(l.reason === 'guest_full_used' && length === 'short') ? l.reason : null;
  return reason ? fail(429, reason, 'Limit reached', { resets_at: l.resets_at }) : null;
}

export function sessionResFor(id: string, roundId: string, me: Me): CreateSessionRes {
  const catalog = fakeCatalog();
  const round = catalog.rounds.find((r) => r.id === roundId) ?? catalog.rounds[0]!;
  const lead = catalog.personas.find((p) => p.id === round.panel.lead) ?? catalog.personas[0]!;
  return {
    session_id: id,
    client_token: `tok_${id}`,
    ws_url: `/ws/session/${id}`,
    round,
    panel: [
      {
        panelist_id: 'p1',
        persona_id: lead.id,
        display_name: lead.display_name,
        title: lead.title,
        avatar_id: lead.avatar_id,
        seat: 1,
        voice: { transport: 'fake' },
      },
    ],
    floor: 'p1',
    panel_mode: 'swap',
    limits: me.limits,
  };
}

// ---------- fetch ----------

export interface FakeCall {
  method: string;
  path: string;
  body: unknown;
}

type Handler = (req: { method: string; url: URL; body: unknown }) => unknown | Response | Promise<unknown | Response>;

export interface FakeServerOptions {
  scenario?: string;
  me?: Me;
  /** Extra or replacement routes, keyed "METHOD /path" (exact path) and tried first. */
  routes?: Record<string, Handler>;
  /** Delay for every response, in ms. */
  delayMs?: number;
}

export interface FakeServer {
  fetch: typeof fetch;
  calls: FakeCall[];
  state: { me: Me; reportPolls: Record<string, number> };
}

const json = (status: number, body: unknown) =>
  status === 204
    ? new Response(null, { status })
    : new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fail = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) =>
  json(status, { code, message, ...extra });

export function createFakeServer(opts: FakeServerOptions = {}): FakeServer {
  const scenario = opts.scenario ?? '1';
  const state = { me: opts.me ?? fakeMe(scenario), reportPolls: {} as Record<string, number> };
  const calls: FakeCall[] = [];
  let shareSlug: string | null = null;
  let lastScoringPoll = 0;
  let created = 0;

  const route = async (method: string, url: URL, body: unknown): Promise<Response> => {
    const key = `${method} ${url.pathname}`;
    const custom = opts.routes?.[key];
    if (custom) {
      const out = await custom({ method, url, body });
      return out instanceof Response ? out : json(200, out);
    }
    const p = url.pathname;
    const role = (url.searchParams.get('role') as Role | null) ?? undefined;
    let m: RegExpMatchArray | null;

    if (key === 'GET /api/content/catalog') return json(200, fakeCatalog());
    if (key === 'GET /api/me') return json(200, state.me);
    if (key === 'PUT /api/me/settings') {
      state.me = { ...state.me, settings: body as Settings };
      return json(204, undefined);
    }
    if (key === 'POST /api/me/onboarding-done') {
      state.me = { ...state.me, onboarding_done: true };
      return json(204, undefined);
    }
    if (key === 'DELETE /api/me') {
      state.me = fakeMe('first');
      return json(204, undefined);
    }
    if (key === 'GET /api/me/history') return json(200, scenario === 'empty' ? [] : fakeHistory(role));
    if (key === 'GET /api/me/skills') return json(200, scenario === 'empty' ? { competencies: [] } : fakeSkills());
    if (key === 'POST /api/sessions') {
      const req = body as CreateSessionReq;
      const capped = capFor(state.me, req.length);
      if (capped) return capped;
      return json(200, sessionResFor(`s_new_${++created}`, req.mode === 'meeting' ? 'meeting.short' : req.round_id ?? 'sde.system_design.short', state.me));
    }
    if (method === 'POST' && (m = p.match(/^\/api\/sessions\/([^/]+)\/(retry|resume)$/))) {
      const id = decodeURIComponent(m[1]!);
      if (m[2] === 'retry') {
        const capped = capFor(state.me, 'short');
        if (capped) return capped;
        return json(200, sessionResFor(`s_retry_${++created}`, 'sde.system_design.short', state.me));
      }
      return json(200, sessionResFor(id, 'sde.system_design.short', state.me));
    }
    if (key === 'POST /api/meetings/prepare') {
      const setup = body as MeetingSetup;
      if (!setup?.goal || !setup.attendees?.length) return fail(422, 'invalid', 'A goal and one attendee are needed');
      return json(200, { meeting_plan_id: 'mp_demo', plan: fakePlan(setup) });
    }
    if (key === 'POST /api/shares') {
      shareSlug = 'k7m2q9';
      return json(200, { slug: shareSlug, url: `${url.origin}/s/${shareSlug}` });
    }
    if (method === 'DELETE' && p.startsWith('/api/shares/')) {
      shareSlug = null;
      return json(204, undefined);
    }
    if (method === 'GET' && (m = p.match(/^\/api\/sessions\/([^/]+)\/report$/))) {
      const id = decodeURIComponent(m[1]!);
      if (id === 'failed' || id === 'abandoned') return fail(404, 'not_ready', 'Report not ready');
      if (id === 'scoring') {
        // Ready on the fourth poll; a page opened later (after a quiet gap) starts over.
        const now = Date.now();
        if (now - lastScoringPoll > 10_000) state.reportPolls[id] = 0;
        lastScoringPoll = now;
        const n = (state.reportPolls[id] = (state.reportPolls[id] ?? 0) + 1);
        if (n < 4) return fail(404, 'not_ready', 'Report not ready');
      }
      if (id === 'missing') return fail(404, 'not_found', 'No such session');
      return json(200, fakeReport(id));
    }
    if (method === 'GET' && (m = p.match(/^\/api\/sessions\/([^/]+)$/))) {
      const id = decodeURIComponent(m[1]!);
      const status = id === 'failed' ? 'failed' : id === 'abandoned' ? 'abandoned' : id === 'scoring' ? 'scoring' : 'scored';
      return json(200, { status, report_ready: status === 'scored' && (state.reportPolls[id] ?? 4) >= 3 });
    }
    return fail(404, 'not_found', `No fake route for ${key}`);
  };

  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, globalThis.location?.origin ?? 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: unknown = undefined;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ method, path: url.pathname + url.search, body });
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    return route(method, url, body);
  };

  return { fetch: fakeFetch as typeof fetch, calls, state };
}

/**
 * Dev only: answers /api/* from a fake server, everything else from the network. The scenario
 * is read again on every request (a client side move to `?fake=<other>` switches it), and each
 * scenario keeps its own state.
 */
export function installFake(scenario: string, current: () => string | null = () => scenario): void {
  const servers = new Map<string, FakeServer>();
  const serverFor = (sc: string) => {
    let s = servers.get(sc);
    if (!s) servers.set(sc, (s = createFakeServer({ scenario: sc, delayMs: 250 })));
    return s;
  };
  const real = globalThis.fetch.bind(globalThis);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(href, location.origin).pathname;
    return path.startsWith('/api/') ? serverFor(current() ?? scenario).fetch(input, init) : real(input, init);
  }) as typeof fetch;
}
