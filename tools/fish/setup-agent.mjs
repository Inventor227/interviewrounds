#!/usr/bin/env node
// Creates or updates the one Fish Audio agent the app uses ("interview-rounds"),
// points it at our server as a custom LLM, and publishes it. Prints the agent id.
//
//   FISH_AUDIO_API_KEY=... FISH_LLM_SECRET=... APP_ORIGIN=https://rounds.dijmo.com \
//     node tools/fish/setup-agent.mjs [--dry-run]
//
// --dry-run prints the requests it would send (secrets masked) and changes nothing.
// Creating or publishing an agent starts no voice session and costs nothing.
// Node 22+ (global fetch).

import { pathToFileURL } from "node:url";

export const AGENT_NAME = "interview-rounds";
export const API_BASE = process.env.FISH_API_BASE || "https://api.fish.audio";
// conversation.hangup_after_seconds: the API accepts 10..3600; we want the longest
// silence allowed so whiteboard thinking time never ends a round.
export const HANGUP_AFTER_MAX_SECONDS = 3600;
// Per-session overrides our server sends when it mints a session token
// (asr.model lets one session try another speech recognizer without a republish).
export const OVERRIDES_ALLOWED = ["system_prompt", "first_message", "voice_id", "language", "asr.model"];
// Speech models, picked by the voice latency spike (FISH_ASR_MODEL / FISH_TTS_MODEL override them).
export const ASR_MODEL = "deepgram:nova-3";
export const TTS_MODEL = "s2.1-pro";
// Turn-taking preset (relaxed waits 900 ms after speech, balanced 550, eager 450); FISH_EAGERNESS overrides.
export const EAGERNESS = "relaxed";
const ASR_MODELS = ["deepgram:nova-3", "fish_audio:transcribe-stream-1", "elevenlabs:scribe_v2_realtime"];
const TTS_MODELS = ["s2.1-pro", "drama-3"];

const SYSTEM_PROMPT =
  "You are an interviewer in a practice interview. Our server builds the real instructions " +
  "for every turn, so keep replies short and spoken, one question at a time.";

/** The draft config sent on create and on every update. */
export function buildConfig({
  appOrigin, llmSecret, asrModel = ASR_MODEL, ttsModel = TTS_MODEL, eagerness = EAGERNESS,
}) {
  const origin = String(appOrigin || "").replace(/\/+$/, "");
  if (!/^https:\/\/[^/]+$/.test(origin)) {
    throw new Error("APP_ORIGIN must be an https origin like https://rounds.dijmo.com");
  }
  if (!llmSecret) throw new Error("FISH_LLM_SECRET is required");
  if (!ASR_MODELS.includes(asrModel)) throw new Error(`ASR model must be one of ${ASR_MODELS.join(", ")}`);
  if (!TTS_MODELS.includes(ttsModel)) throw new Error(`TTS model must be one of ${TTS_MODELS.join(", ")}`);
  if (!["relaxed", "balanced", "eager"].includes(eagerness)) throw new Error("eagerness must be relaxed, balanced or eager");
  return {
    prompt: {
      system_prompt: SYSTEM_PROMPT,
      // The browser starts each round with an "[event: start]" turn; no fixed greeting.
      first_message_mode: "off",
    },
    voice: {
      // Cascade TTS so each persona can use its own library voice per session.
      engine: "fish_tts",
      tts_model: ttsModel,
      speaking_language: "en",
    },
    // English only: the multilingual mode is not needed and can only slow recognition down.
    asr: { model: asrModel, multilingual: false },
    llm: {
      custom: {
        base_url: `${origin}/v1`,
        model: AGENT_NAME,
        api_key: llmSecret,
      },
      // Our endpoint is the only model: no platform model ever answers in its place. A failed
      // turn makes Fish speak its own short hold line (our endpoint already says one first).
      fallback: { mode: "off" },
    },
    conversation: {
      max_duration_seconds: 1800,
      hangup_after_seconds: HANGUP_AFTER_MAX_SECONDS,
      eagerness,
      interruption_sensitivity: "low",
      // Fish starts our endpoint before the turn is confirmed; the server handles dropped drafts.
      speculative_response: true,
      echo_guard: { web_voice: true },
      record_audio: true,
    },
  };
}

/** Agent-level settings (not part of the versioned config). */
export function buildAgentSettings() {
  return { public_enabled: false, overrides_allowed: OVERRIDES_ALLOWED };
}

/** Deep copy with secret values replaced, for printing. */
export function mask(value) {
  if (Array.isArray(value)) return value.map(mask);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = /api_key|secret|token|authorization/i.test(k) && typeof v === "string"
        ? `<hidden, ${v.length} chars>`
        : mask(v);
    }
    return out;
  }
  return value;
}

async function call(method, path, apiKey, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = data && typeof data === "object" ? (data.message || data.reason || "") : "";
    throw new Error(`${method} ${path} -> HTTP ${res.status} ${msg}`.trim());
  }
  return data;
}

async function findAgents(apiKey) {
  const q = new URLSearchParams({ search: AGENT_NAME, page_size: "100" });
  const data = await call("GET", `/v1/agent/agents?${q}`, apiKey);
  return (data?.agents || []).filter((a) => a.name === AGENT_NAME && a.status !== "archived");
}

function log(msg) { process.stderr.write(`setup-agent: ${msg}\n`); }

export async function main(argv = process.argv.slice(2), env = process.env) {
  const dryRun = argv.includes("--dry-run");
  const unknown = argv.filter((a) => a !== "--dry-run");
  if (unknown.length) throw new Error(`unknown argument(s): ${unknown.join(" ")}`);

  const apiKey = env.FISH_AUDIO_API_KEY;
  const config = buildConfig({
    appOrigin: env.APP_ORIGIN,
    llmSecret: env.FISH_LLM_SECRET,
    asrModel: env.FISH_ASR_MODEL || ASR_MODEL,
    ttsModel: env.FISH_TTS_MODEL || TTS_MODEL,
    eagerness: env.FISH_EAGERNESS || EAGERNESS,
  });
  const settings = buildAgentSettings();

  if (dryRun) {
    let existing = null;
    if (apiKey) {
      const found = await findAgents(apiKey); // read only
      if (found.length > 1) log(`warning: ${found.length} agents named ${AGENT_NAME}`);
      existing = found[0] || null;
    } else {
      log("FISH_AUDIO_API_KEY not set: not looking up existing agents");
    }
    const id = existing ? existing.agent_id : "<new agent id>";
    const plan = existing
      ? [
          { method: "PATCH", path: `/v1/agent/agents/${id}`, body: settings },
          { method: "POST", path: `/v1/agent/agents/${id}/publish`, body: { version_title: "setup-agent", config } },
        ]
      : [
          { method: "POST", path: "/v1/agent/agents", body: { name: AGENT_NAME, description: "Interview Rounds interviewer (custom LLM)", config } },
          { method: "PATCH", path: `/v1/agent/agents/${id}`, body: settings },
          { method: "POST", path: `/v1/agent/agents/${id}/publish`, body: { version_title: "setup-agent" } },
        ];
    log(`dry run: would ${existing ? `update agent ${id}` : "create a new agent"}; nothing sent`);
    process.stdout.write(JSON.stringify(mask(plan), null, 2) + "\n");
    return null;
  }

  if (!apiKey) throw new Error("FISH_AUDIO_API_KEY is required");
  const found = await findAgents(apiKey);
  if (found.length > 1) {
    throw new Error(`${found.length} agents named ${AGENT_NAME}: ${found.map((a) => a.agent_id).join(", ")}; archive the extras first`);
  }
  let agentId;
  if (found.length === 1) {
    agentId = found[0].agent_id;
    log(`updating agent ${agentId}`);
    await call("PATCH", `/v1/agent/agents/${agentId}`, apiKey, settings);
    // Applying the config and publishing in one call keeps the live version consistent.
    await call("POST", `/v1/agent/agents/${agentId}/publish`, apiKey, { version_title: "setup-agent", config });
  } else {
    log("creating agent");
    const created = await call("POST", "/v1/agent/agents", apiKey, {
      name: AGENT_NAME,
      description: "Interview Rounds interviewer (custom LLM)",
      config,
    });
    agentId = created.agent_id;
    await call("PATCH", `/v1/agent/agents/${agentId}`, apiKey, settings);
    await call("POST", `/v1/agent/agents/${agentId}/publish`, apiKey, { version_title: "setup-agent" });
  }
  // Read the published config back: our endpoint must be the only model.
  const live = await call("GET", `/v1/agent/agents/${agentId}/config`, apiKey);
  const fallbackMode = live?.llm?.fallback?.mode;
  if (fallbackMode !== "off") {
    throw new Error(`published agent ${agentId} has llm.fallback.mode=${fallbackMode}, expected off`);
  }
  log(`published (fallback off, asr ${live?.asr?.model}, tts ${live?.voice?.tts_model}); set FISH_AGENT_ID=${agentId}`);
  process.stdout.write(`${agentId}\n`);
  return agentId;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    log(`error: ${err.message}`);
    process.exit(1);
  });
}
