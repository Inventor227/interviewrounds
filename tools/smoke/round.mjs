#!/usr/bin/env node
// End-to-end smoke round against a deployed server, with the fake voice (no voice platform session).
//
//   DEV_KEY=... node tools/smoke/round.mjs [--origin https://rounds.dijmo.com] [--out <dir>] [--only interview]
//     [--share-retry]
//
// Creates a short system design round, opens the session socket, plays the browser's part (typed events, four
// answers through the custom LLM endpoint, playback reports, three board ops and a focus), ends the round, waits for
// the headset card and the report, then checks the report against content/schema/report.v1.schema.json.
// With --share-retry it then shares the scorecard (public page, transcript toggle, old link 410) and runs a two
// minute retry of the weakest answer (typed answer, end, the parent report gains a retries entry).
// Writes events.json (every frame and call, timed), report.json and summary.json to --out. Exit 0 on success.
// The model calls are real (live turns, director, Scribe, scoring). DEV_KEY is never printed.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const ORIGIN = opt("--origin", process.env.SMOKE_ORIGIN || "https://rounds.dijmo.com").replace(/\/+$/, "");
const OUT = resolve(opt("--out", join(process.cwd(), "smoke-out")));
const DEV_KEY = process.env.DEV_KEY;
if (!DEV_KEY) {
  console.error("smoke: DEV_KEY is required (the fake voice is dev-only)");
  process.exit(2);
}

const ANSWERS = [
  "Let me scope it first. I'd assume a few million users, mostly reads, and a burst of traffic at peak. " +
    "The key requirements are that nobody loses data, reads stay fast under that burst, and writes are never " +
    "applied twice. I'd target about two hundred milliseconds at the ninety ninth percentile for reads and accept " +
    "a little staleness on screens that only display data.",
  "Clients hit a load balancer in front of a stateless API service. The API service writes to Postgres, which is " +
    "the source of truth, and I'd put a Redis cache in front of it for the hot reads, so most of the read traffic " +
    "never touches the database. Writes use a conditional update so the same row can only change once.",
  "For the burst I'd add a Kafka queue between the API service and the workers that do the slow part, so the API " +
    "can answer quickly and the workers drain the queue at a steady rate. Every message carries an idempotency key, " +
    "so a retry or a duplicate delivery does nothing the second time.",
  "If Redis goes down the reads fall back to Postgres read replicas, slower but still correct, and the load " +
    "balancer sheds the lowest priority traffic first. I'd watch queue depth, cache hit rate and the error rate, " +
    "and page someone when the queue keeps growing for more than a few minutes.",
];

// A tool written out by the model and spoken (identifier, or the spaced form the old filter produced).
const TOOL_WORDS = /\b(show[ _]question|next_phase|end[ _]round|give[ _]hint|point_at|hand_over)\b/i;
const toolSpeech = [];
const t0 = Date.now();
const now = () => Date.now() - t0;
const log = [];
const record = (dir, type, data) => log.push({ t_ms: now(), dir, type, data });
const say = (msg) => console.log(`[${(now() / 1000).toFixed(1)}s] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cookie = "";
async function api(method, path, body, extra = {}) {
  const headers = { Accept: "application/json", ...extra };
  if (cookie) headers.Cookie = cookie;
  if (body) headers["Content-Type"] = "application/json";
  const started = now();
  const res = await fetch(`${ORIGIN}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const set = res.headers.get("set-cookie");
  if (set) {
    const m = set.match(/ir_id=[^;]+/);
    if (m) cookie = m[0];
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  record("http", `${method} ${path.replace(/[0-9a-f-]{36}/g, ":id")}`, { status: res.status, ms: now() - started });
  return { status: res.status, data };
}

// ---------- socket ----------
const frames = [];
const waiters = [];
let ws;
let clientSeq = 0;
let closeCode = null;

let lastState = "";
function onFrame(f) {
  frames.push({ t_ms: now(), f });
  if (f.t === "round.state") {
    // Snapshots arrive every second; only changes of phase, floor, brief or status are logged.
    const sig = JSON.stringify([f.d.status, f.d.phase_index, f.d.floor, f.d.brief]);
    if (sig !== lastState) record("in", f.t, f.d);
    lastState = sig;
  } else if (f.t !== "pong") {
    record("in", f.t, f.d);
  }
  for (const w of [...waiters]) {
    if (w.pred(f)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(f);
    }
  }
}

function waitFrame(pred, ms, what) {
  const seen = frames.find((x) => x.t_ms >= (pred.since ?? 0) && pred(x.f));
  if (seen) return Promise.resolve(seen.f);
  return new Promise((resolveP, reject) => {
    const w = { pred, resolve: (f) => { clearTimeout(timer); resolveP(f); } };
    const timer = setTimeout(() => {
      waiters.splice(waiters.indexOf(w), 1);
      reject(new Error(`timed out after ${ms} ms waiting for ${what}`));
    }, ms);
    waiters.push(w);
  });
}

/** Waits for a frame that arrives from now on. */
function next(pred, ms, what) {
  return new Promise((resolveP, reject) => {
    const w = { pred, resolve: (f) => { clearTimeout(timer); resolveP(f); } };
    const timer = setTimeout(() => {
      waiters.splice(waiters.indexOf(w), 1);
      reject(new Error(`timed out after ${ms} ms waiting for ${what}`));
    }, ms);
    waiters.push(w);
  });
}

function send(t, d) {
  const seq = t === "hello" || t === "ping" ? 0 : ++clientSeq;
  ws.send(JSON.stringify({ t, seq, d }));
  record("out", t, d);
  return seq;
}

// ---------- the voice turn (what the voice platform would send) ----------
// Each panelist has its own voice session, so its own transcript.
const histories = {};
async function turn(sessionId, token, text, label, panelist = "p1") {
  const history = (histories[panelist] ??= []);
  const messages = [...history, { role: "user", content: text }];
  const started = now();
  const res = await fetch(`${ORIGIN}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({
      model: "interview-rounds",
      stream: true,
      messages,
      fishaudio_extra_body: { session_id: sessionId, panelist_id: panelist },
    }),
  });
  if (!res.ok) throw new Error(`turn ${label}: HTTP ${res.status} ${await res.text()}`);
  let reply = "";
  let ttft = null;
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const delta = JSON.parse(payload).choices?.[0]?.delta?.content;
        if (delta) {
          if (ttft === null) ttft = now() - started;
          reply += delta;
        }
      } catch { /* keep-alive or comment */ }
    }
  }
  const total = now() - started;
  history.push({ role: "user", content: text }, { role: "assistant", content: reply });
  record("turn", label, { panelist, user: text, reply, ttft_ms: ttft, total_ms: total });
  say(`${label}: first text ${ttft} ms, ${total} ms: "${reply}"`);
  if (TOOL_WORDS.test(reply)) toolSpeech.push({ label, reply });
  return { reply, ttft, total };
}

function spoken(reply, panelist = "p1") {
  // The browser reports the first words as the voice plays them.
  send("voice.spoken", { panelist_id: panelist, text_prefix: reply.slice(0, 60) });
}

async function openSocket(ws_url, token) {
  frames.length = 0;
  waiters.length = 0;
  clientSeq = 0;
  closeCode = null;
  lastState = "";
  for (const k of Object.keys(histories)) delete histories[k];
  const wsOrigin = ORIGIN.replace(/^http/, "ws");
  ws = new WebSocket(`${wsOrigin}${ws_url}`, { headers: { Origin: ORIGIN } });
  ws.onmessage = (ev) => onFrame(JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString()));
  ws.onclose = (ev) => { closeCode = ev.code; record("in", "close", { code: ev.code, reason: ev.reason }); };
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  send("hello", { client_token: token, last_seq: 0 });
  return setInterval(() => { if (ws.readyState === 1) send("ping", {}); }, 15000);
}

const summary = { origin: ORIGIN, started_at: new Date(t0).toISOString(), checks: {} };
const check = (name, ok, detail) => {
  summary.checks[name] = { ok: !!ok, ...(detail !== undefined ? { detail } : {}) };
  say(`${ok ? "PASS" : "FAIL"} ${name}${detail !== undefined ? `: ${JSON.stringify(detail)}` : ""}`);
};

function validateReport(data) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const schema = JSON.parse(readFileSync(join(REPO, "content/schema/report.v1.schema.json"), "utf8"));
  const ok = ajv.validate(schema, data);
  return { ok, errors: ajv.errors };
}

const MODE = opt("--only", "both");
const SHARE_RETRY = args.includes("--share-retry");

async function diagCheck() {
  // A device check result, stored for the caller (a guest).
  if (!cookie) await api("GET", "/api/me");
  const blob = { kind: "smoke", ua: "smoke-round", checks: { mic: "ok", audio_out: "ok" }, at: new Date().toISOString() };
  const res = await api("POST", "/api/diag", blob);
  check("device check result stored", res.status >= 200 && res.status < 300, { status: res.status, body: res.data });
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  await diagCheck();
  if (MODE !== "meeting") {
    await interviewRound();
    if (SHARE_RETRY) await shareAndRetry(summary.session_id);
  }
  if (MODE !== "interview") {
    try {
      await meetingRound();
    } catch (e) {
      check("meeting round", false, e.message);
    }
  }
  check("no tool names in speech", toolSpeech.length === 0, toolSpeech.length ? toolSpeech : undefined);
  summary.ok = Object.values(summary.checks).every((c) => c.ok);
  summary.total_s = Math.round(now() / 100) / 10;
  writeFileSync(join(OUT, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  say(`${summary.ok ? "SMOKE OK" : "SMOKE FAILED"}; artifacts in ${OUT}`);
  process.exit(summary.ok ? 0 : 1);
}

async function interviewRound() {
  const me = await api("GET", "/api/me");
  check("guest identity", me.status === 200 && cookie, { status: me.status });
  const created = await api(
    "POST",
    "/api/sessions",
    { mode: "interview", round_id: "sde.system_design.short", length: "short", level: "mid", style: "neutral", voice: "fake" },
    { "X-Dev-Key": DEV_KEY },
  );
  if (created.status !== 200) throw new Error(`create: HTTP ${created.status} ${JSON.stringify(created.data)}`);
  const { session_id: id, client_token: token, ws_url } = created.data;
  summary.session_id = id;
  say(`session ${id}`);
  const ping = await openSocket(ws_url, token);

  const state = await waitFrame((f) => f.t === "round.state", 5000, "round.state");
  check("brief card before the opener", state.d.brief?.question && state.d.brief.lines?.length > 0, state.d.brief);

  const opener = await turn(id, token, "[event: start]", "opener");
  spoken(opener.reply);

  const turns = [];
  // Answer 1, then the board.
  let r = await turn(id, token, ANSWERS[0], "answer 1");
  turns.push(r);
  spoken(r.reply);
  const ops = [
    { op_id: "smoke-o1", src: "hand", op: "item.create", args: { id: "n1", kind: "component", type: "service", label: "API service", x: 6, y: 16, w: 8, h: 5 } },
    { op_id: "smoke-o2", src: "hand", op: "item.create", args: { id: "n2", kind: "component", type: "db", label: "Postgres", x: 30, y: 16, w: 8, h: 5 } },
    { op_id: "smoke-o3", src: "hand", op: "edge.create", args: { id: "e1", from: "n1", to: "n2" } },
  ];
  const acks = [];
  for (const op of ops) {
    const ack = next((f) => f.t === "board.ack" && f.d.op_id === op.op_id, 5000, `ack ${op.op_id}`);
    send("board.op", { ...op, rev_base: acks.length, at_ms: Date.now() });
    acks.push((await ack).d);
  }
  check("board ops acked with revs 1..3", acks.map((a) => a.rev).join(",") === "1,2,3", acks);
  send("board.focus", { item_id: "n1" });

  // Answer 2 names components: the Scribe should suggest some after playback.
  r = await turn(id, token, ANSWERS[1], "answer 2");
  turns.push(r);
  const ghostsAfter2 = next((f) => f.t === "board.ghosts" && f.d.ghosts?.length > 0, 15000, "board.ghosts");
  const spokenAt = now();
  spoken(r.reply);
  let ghosts = null;
  try {
    ghosts = await ghostsAfter2;
    check("Scribe ghosts after an answer naming components", true, { ms_after_playback: now() - spokenAt, ghosts: ghosts.d.ghosts.map((g) => `${g.op} ${g.args?.label ?? g.args?.text ?? g.args?.id ?? ""}`) });
  } catch (e) {
    check("Scribe ghosts after an answer naming components", false, e.message);
  }

  for (const [i, text] of ANSWERS.slice(2).entries()) {
    r = await turn(id, token, text, `answer ${i + 3}`);
    turns.push(r);
    spoken(r.reply);
    await sleep(1500);
  }

  // The user ends the round: the interviewer says goodbye, then the round ends.
  send("ui.event", { kind: "end", reason: "user_ended" });
  const ended = next((f) => f.t === "round.ended", 40000, "round.ended");
  const closing = await turn(id, token, "[event: ending]", "closing");
  spoken(closing.reply);
  const endedF = await ended;
  const endedAt = now();
  check("round ended", endedF.d.reason === "user_ended", endedF.d);

  const card = next((f) => f.t === "report.progress" && f.d.stage === "card", 120000, "headset card");
  const ready = next((f) => (f.t === "report.ready") || (f.t === "error" && f.d.code === "report_failed"), 150000, "report.ready");
  try {
    const c = await card;
    check("headset card", !!c.d.card?.one_line, { ms_after_end: now() - endedAt, card: c.d.card });
  } catch (e) {
    check("headset card", false, e.message);
  }
  const done = await ready;
  check("report ready", done.t === "report.ready", { ms_after_end: now() - endedAt, frame: done.t });
  clearInterval(ping);
  await sleep(1500);
  check("socket closed 4409 after the report", closeCode === 4409, { close: closeCode });
  if (ws.readyState === 1) ws.close();

  const rep = await api("GET", `/api/sessions/${id}/report`);
  writeFileSync(join(OUT, "report.json"), JSON.stringify(rep.data, null, 2) + "\n");
  const v = rep.status === 200 ? validateReport(rep.data) : { ok: false, errors: rep.status };
  check("report matches report.v1", v.ok, v.ok ? { verdict: rep.data.headline?.verdict, summary: rep.data.headline?.summary } : v.errors?.slice?.(0, 5) ?? v.errors);

  const ttfts = [opener, ...turns, closing].map((t) => t.ttft).filter((x) => x !== null);
  summary.timings = {
    turn_first_text_ms: ttfts,
    turn_first_text_p50_ms: [...ttfts].sort((a, b) => a - b)[Math.floor(ttfts.length / 2)],
    interview_s: Math.round(now() / 100) / 10,
  };
  writeFileSync(join(OUT, "events.json"), JSON.stringify(log, null, 2) + "\n");
}

// ---------- share the scorecard, then retry the weakest answer ----------
async function page(path) {
  const res = await fetch(`${ORIGIN}${path}`, { headers: { Accept: "text/html" } });
  const html = await res.text();
  record("http", `GET ${path.replace(/\/s\/[^/]+$/, "/s/:slug")}`, { status: res.status });
  return { status: res.status, html, cache: res.headers.get("cache-control") };
}

async function shareAndRetry(id) {
  const plain = await api("POST", "/api/shares", { session_id: id, include_transcript: false });
  check("share link made", plain.status === 200 && plain.data?.slug?.length === 10, { status: plain.status, url: plain.data?.url });
  if (plain.status !== 200) return;
  const slug = plain.data.slug;
  const p1 = await page(`/s/${slug}`);
  writeFileSync(join(OUT, "share.html"), p1.html);
  check("share page public, without transcript", p1.status === 200 && !p1.html.includes('class="transcript"') && !p1.html.includes(ANSWERS[0].slice(0, 60)), { status: p1.status });
  check("share page tags", p1.html.includes('content="noindex"') && p1.html.includes('og:title" content="Interview Rounds scorecard"') && p1.cache === "private, max-age=60", { cache: p1.cache });
  const again = await api("POST", "/api/shares", { session_id: id, include_transcript: false });
  check("same choice keeps the link", again.data?.slug === slug, { slug: again.data?.slug });
  const full = await api("POST", "/api/shares", { session_id: id, include_transcript: true });
  const slug2 = full.data?.slug;
  const old = await page(`/s/${slug}`);
  const p2 = slug2 ? await page(`/s/${slug2}`) : { status: 0, html: "" };
  check("transcript toggle: old link 410, new link shows the transcript", full.status === 200 && slug2 !== slug && old.status === 410 && p2.status === 200 && p2.html.includes('class="transcript"'), { old: old.status, new: p2.status });
  summary.share = { slug: slug2, url: full.data?.url };
  const rep0 = await api("GET", `/api/sessions/${id}/report`);
  check("report share block", rep0.data?.share?.public_slug === slug2 && rep0.data?.share?.include_quotes === true, rep0.data?.share);

  const created = await api("POST", `/api/sessions/${id}/retry`, undefined, { "X-Dev-Key": DEV_KEY });
  const c = created.data ?? {};
  check("retry created", created.status === 200 && c.session_id && c.session_id !== id && c.round?.target_minutes === 2 && c.panel?.length === 1 && c.timing?.hard_stop_minutes === 2.5, { status: created.status, round: c.round?.id, target_minutes: c.round?.target_minutes, panel: c.panel?.map((x) => x.persona_id), timing: c.timing, error: created.status === 200 ? undefined : c });
  if (created.status !== 200) return;
  const child = c.session_id;
  summary.retry_session_id = child;
  const ping = await openSocket(c.ws_url, c.client_token);
  const st = await waitFrame((f) => f.t === "round.state", 5000, "retry round.state");
  check("retry brief card holds the question", !!st.d.brief?.question, st.d.brief);
  const opener = await turn(child, c.client_token, "[event: start]", "retry opener");
  spoken(opener.reply);
  const answer = await turn(child, c.client_token,
    "At ten times the traffic the database write path breaks first, at about twelve thousand writes a second. " +
      "I'd shard it by key so each write touches one shard, accept that resharding later costs us, and watch " +
      "p99 write latency per shard to know it worked. The cache helps reads, not this.",
    "retry answer");
  spoken(answer.reply);
  await sleep(1500);
  send("ui.event", { kind: "end", reason: "user_ended" });
  const ended = next((f) => f.t === "round.ended", 40000, "retry round.ended");
  const closing = await turn(child, c.client_token, "[event: ending]", "retry closing");
  spoken(closing.reply);
  const e = await ended;
  const endedAt = now();
  check("retry ended", !!e.d.reason, e.d);
  const ready = await next((f) => f.t === "report.ready" || (f.t === "error" && f.d.code === "report_failed"), 90000, "retry report.ready");
  check("retry scored", ready.t === "report.ready", { ms_after_end: now() - endedAt });
  clearInterval(ping);
  if (ws.readyState === 1) ws.close();
  const rep = await api("GET", `/api/sessions/${id}/report`);
  writeFileSync(join(OUT, "report-after-retry.json"), JSON.stringify(rep.data, null, 2) + "\n");
  const entry = rep.data?.weakest_moment?.retries?.find((r) => r.session_id === child);
  check("parent report has the retry entry", !!entry, entry);
  const v = validateReport(rep.data);
  check("report with the retry matches report.v1", v.ok, v.ok ? undefined : v.errors?.slice?.(0, 5));
  const viaChild = await api("GET", `/api/sessions/${child}/report`);
  check("the retry answers its parent's report", viaChild.status === 200 && viaChild.data?.session?.id === id, { status: viaChild.status });
}

// ---------- a meeting rehearsal ----------
const MEETING_SETUP = {
  template_id: "exec_update",
  goal: "Get approval to move one engineer from the payments team for six weeks.",
  user_role: "Engineering lead for the mobile launch",
  attendees: [
    { name: "Dana", role: "VP of Engineering", cares_about: ["launch date", "bottom line first"], personality: "skeptical", decision_power: "approver" },
    { name: "Owen", role: "Payments lead", cares_about: ["his team's roadmap"], personality: "neutral", likely_objections: ["Losing an engineer delays the refunds work"] },
  ],
  length: "short",
  key_facts: ["Launch is slipping 3 weeks", "One extra engineer brings it back to 1 week late"],
  ask: "One payments engineer for six weeks",
  notes: "Status: QA found 40 open bugs, 12 of them blockers.",
  difficulty: "realistic",
};
// Long enough together (about 300 words) for the scorer's minimum of 90 seconds of speech.
const MEETING_LINES = [
  "Bottom line first: the mobile launch is slipping three weeks. QA found forty open bugs, and twelve of them are " +
    "blockers in checkout and payments. Most of those twelve sit in code the payments team wrote, which is why my " +
    "team is slow on them. I'm asking for one payments engineer for six weeks. With that person we get back to one " +
    "week late instead of three, and the marketing date only moves by a week. If we do nothing, support takes the " +
    "hit at launch, because every one of those blockers is a failed payment a customer will call us about.",
  "Owen, I know that hits the refunds work, and I don't want to pretend it's free. I'd take the engineer who already " +
    "knows our checkout code, so there's no ramp up. In return I'll give the refunds team two of my people for the " +
    "week right after launch, so the refunds date only moves by one week. I'll also keep you in our daily standup, " +
    "so you can pull your engineer back if a refunds emergency comes up. I've already talked to QA, and they will " +
    "test the refunds changes first after launch, so your release does not wait in their queue.",
  "So the ask is clear: one payments engineer for six weeks, starting Monday. That engineer takes the seven payment " +
    "blockers first, then the five checkout blockers. In return the refunds work gets two of my engineers right " +
    "after launch, and I'll send you both a weekly note on the blocker count. Dana, can we agree on that today, or " +
    "is there something you need from me before you decide?",
];

async function meetingRound() {
  record("round", "meeting", {});
  const t = now();
  const prep = await api("POST", "/api/meetings/prepare", MEETING_SETUP);
  check("meeting prepared", prep.status === 200 && prep.data?.meeting_plan_id, { status: prep.status, ms: now() - t, attendees: prep.data?.plan?.attendees?.map((a) => `${a.name} (${a.role})`), error: prep.status === 200 ? undefined : prep.data });
  if (prep.status !== 200) return;
  const created = await api(
    "POST",
    "/api/sessions",
    { mode: "meeting", meeting_plan_id: prep.data.meeting_plan_id, length: "short", level: "mid", style: "neutral", voice: "fake" },
    { "X-Dev-Key": DEV_KEY },
  );
  if (created.status !== 200) throw new Error(`meeting create: HTTP ${created.status} ${JSON.stringify(created.data)}`);
  const { session_id: id, client_token: token, ws_url } = created.data;
  summary.meeting_session_id = id;
  let floor = created.data.floor;
  say(`meeting session ${id}, floor ${floor}, panel ${created.data.panel.map((p) => `${p.panelist_id}=${p.display_name}`).join(", ")}`);
  const ping = await openSocket(ws_url, token);
  const mstate = await waitFrame((f) => f.t === "round.state", 5000, "round.state");
  // A meeting's card is the user's own meeting: nothing from the question bank appears on it.
  check("meeting starts with an empty brief card", !mstate.d.brief?.question, mstate.d.brief);

  // A hand-over moves the floor: the browser joins the next attendee, whose first line is already spoken.
  const handOver = async (since) => {
    const ho = frames.find((x) => x.t_ms >= since && x.f.t === "panel.hand_over");
    if (!ho) return;
    const { to, opening_line } = ho.f.d;
    const res = await api("POST", `/api/sessions/${id}/panelists/${to}/join`, { opening_line });
    record("http", "join", { to, status: res.status });
    if (res.status === 200) {
      floor = to;
      spoken(opening_line, to);
      say(`hand-over to ${to}: "${opening_line}"`);
    }
  };

  let since = now();
  const opener = await turn(id, token, "[event: start]", "meeting opener", floor);
  spoken(opener.reply, floor);
  await sleep(2500);
  await handOver(since);
  for (const [i, line] of MEETING_LINES.entries()) {
    since = now();
    const r = await turn(id, token, line, `meeting answer ${i + 1}`, floor);
    spoken(r.reply, floor);
    await sleep(3000);
    await handOver(since);
  }
  send("ui.event", { kind: "end", reason: "user_ended" });
  const ended = next((f) => f.t === "round.ended", 40000, "meeting round.ended");
  const closing = await turn(id, token, "[event: ending]", "meeting closing", floor);
  spoken(closing.reply, floor);
  const e = await ended;
  const endedAt = now();
  check("meeting ended", !!e.d.reason, e.d);
  const ready = await next((f) => f.t === "report.ready" || (f.t === "error" && f.d.code === "report_failed"), 150000, "meeting report");
  check("meeting report ready", ready.t === "report.ready", { ms_after_end: now() - endedAt });
  clearInterval(ping);
  if (ws.readyState === 1) ws.close();
  const rep = await api("GET", `/api/sessions/${id}/report`);
  writeFileSync(join(OUT, "meeting-report.json"), JSON.stringify(rep.data, null, 2) + "\n");
  const v = rep.status === 200 ? validateReport(rep.data) : { ok: false, errors: rep.status };
  check("meeting report matches report.v1", v.ok, v.ok ? undefined : v.errors?.slice?.(0, 5) ?? v.errors);
  const details = rep.data?.round_details;
  check("meeting outcome in the report", details?.kind === "meeting" && !!details?.outcome, { kind: details?.kind, outcome: details?.outcome, goal_reached: details?.goal_reached });
  writeFileSync(join(OUT, "events.json"), JSON.stringify(log, null, 2) + "\n");
}

main().catch((err) => {
  try {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, "events.json"), JSON.stringify(log, null, 2) + "\n");
  } catch { /* nothing more to save */ }
  console.error(`smoke: ${err.message}`);
  process.exit(1);
});
