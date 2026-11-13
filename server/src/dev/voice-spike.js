// Voice spike driver page. Exposes window.spike for a headless browser; everything is logged with a
// millisecond clock (since page load) into window.spikeLog, and audio levels into window.spikeLevels.
import { AgentSession } from "https://esm.sh/@fishaudio/agent-client@1.0.0";

const key = new URLSearchParams(location.search).get("key") || "";
const t0 = performance.now();
const now = () => Math.round(performance.now() - t0);
const out = document.getElementById("out");

window.spikeLog = [];
window.spikeLevels = [];
function log(ev, data = {}) {
  const entry = { t: now(), ev, ...data };
  window.spikeLog.push(entry);
  out.textContent += JSON.stringify(entry) + "\n";
}

async function api(path, body) {
  const url = `/dev/voice-spike${path}${path.includes("?") ? "&" : "?"}key=${encodeURIComponent(key)}`;
  const res = await fetch(url, body === undefined ? {} : {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

const sessions = [];
const panelistIds = [];
let spikeSessionId = null;

function watch(i, s, opts) {
  const tag = { s: i };
  s.on("statusChange", (status) => log("status", { ...tag, status }));
  s.on("modeChange", (mode) => log("mode", { ...tag, mode }));
  s.on("userTranscript", (e) => log("user_transcript", { ...tag, final: e.final, text: e.text }));
  // The first words of each reply confirm it to the server (the app's socket will do the same).
  const confirmed = new Set();
  s.on("agentResponseDelta", (e) => {
    log("agent_delta", { ...tag, delta: e.delta });
    if (!confirmed.has(e.segmentId) && e.text.trim()) {
      confirmed.add(e.segmentId);
      api(`/confirm?session_id=${spikeSessionId}`, { panelist_id: panelistIds[i], text: e.text })
        .then((r) => log("confirm", { ...tag, ok: r.confirmed }))
        .catch((err) => log("confirm_failed", { ...tag, message: String(err) }));
    }
  });
  s.on("agentResponse", (e) => log("agent_response", { ...tag, text: e.text }));
  s.on("message", (m) => log("message", { ...tag, role: m.role, text: m.text }));
  s.on("toolCallStarted", (e) => log("tool_started", { ...tag, name: e.toolName }));
  s.on("error", (e) => log("error", { ...tag, code: e.code, message: e.message }));
  s.on("disconnect", (e) => log("disconnect", { ...tag, reason: e.reason }));

  // Audio levels every 20 ms, plus a long-answer trigger: after `longAnswerMs` of continuous
  // candidate speech, send [event: long_answer] once, as the app will.
  let speakingSince = null;
  let lastLoud = 0;
  let longSent = false;
  const timer = setInterval(() => {
    if (s.status === "ended") { clearInterval(timer); return; }
    const t = now();
    const input = s.getInputVolume();
    const output = s.getOutputVolume();
    window.spikeLevels.push([i, t, Math.round(input * 1000) / 1000, Math.round(output * 1000) / 1000]);
    if (input > (opts.inputThreshold ?? 0.02)) {
      if (speakingSince === null || t - lastLoud > 700) speakingSince = t;
      lastLoud = t;
      if (opts.longAnswerMs && !longSent && t - speakingSince > opts.longAnswerMs) {
        longSent = true;
        // The voice platform does not answer while the candidate is talking, so the mic closes for the cut-in:
        // that ends the candidate's turn, and the reply is spoken over them. It opens again once the reply ends.
        log("send", { ...tag, text: "[event: long_answer]", auto: true, mute: true });
        s.setMicMuted(true).then(() => {
          s.sendUserMessage("[event: long_answer]", { audio: true });
          let spoke = false;
          const reopen = setInterval(() => {
            if (s.mode === "speaking") spoke = true;
            if ((spoke && s.mode === "listening") || now() - t > 15000) {
              clearInterval(reopen);
              s.setMicMuted(false).then(() => log("mute", { ...tag, muted: false }));
            }
          }, 100);
        });
      }
    }
  }, 20);
}

window.spike = {
  log,
  async create(body) {
    const r = await api("/session", body);
    spikeSessionId = r.session_id;
    r.panelists.forEach((p, i) => { panelistIds[i] = p.panelist_id; });
    log("created", { session_id: r.session_id, panelists: r.panelists.map((p) => p.panelist_id) });
    return r;
  },
  async start(i, token, opts = {}) {
    log("starting", { s: i });
    const s = await AgentSession.start({ sessionToken: token, microphone: opts.microphone ?? true });
    sessions[i] = s;
    watch(i, s, opts);
    log("started", { s: i, fish_session_id: s.sessionId, status: s.status });
    try { await s.startAudio(); } catch (e) { log("start_audio_failed", { s: i, message: String(e) }); }
    return s.sessionId;
  },
  send(i, text, audio = true) {
    log("send", { s: i, text });
    sessions[i].sendUserMessage(text, { audio });
  },
  async mute(i, muted) {
    await sessions[i].setMicMuted(muted);
    log("mute", { s: i, muted });
  },
  interrupt(i) {
    log("interrupt", { s: i });
    sessions[i].interrupt();
  },
  async emptyNext() {
    await api(`/empty-next?session_id=${spikeSessionId}`, {});
    log("empty_next");
  },
  async state() {
    return api(`/state?session_id=${spikeSessionId}`);
  },
  status(i) {
    const s = sessions[i];
    return s ? { status: s.status, mode: s.mode, transcript: s.getTranscript() } : null;
  },
  async end() {
    for (const s of sessions) if (s && s.status !== "ended") await s.end();
    log("ended");
  },
};
log("ready");

document.getElementById("go").addEventListener("click", async () => {
  const r = await window.spike.create({ panel: 1 });
  await window.spike.start(0, r.panelists[0].token);
  window.spike.send(0, "[event: start]");
});
document.getElementById("stop").addEventListener("click", () => window.spike.end());
