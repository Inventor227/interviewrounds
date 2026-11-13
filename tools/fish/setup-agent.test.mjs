import { test } from "node:test";
import assert from "node:assert/strict";
import { buildConfig, buildAgentSettings, mask, main, HANGUP_AFTER_MAX_SECONDS, ASR_MODEL, TTS_MODEL } from "./setup-agent.mjs";

const input = { appOrigin: "https://rounds.dijmo.com/", llmSecret: "llm-secret-value" };

test("config points the agent at our server as a custom LLM", () => {
  const cfg = buildConfig(input);
  assert.deepEqual(cfg.llm, {
    custom: { base_url: "https://rounds.dijmo.com/v1", model: "interview-rounds", api_key: "llm-secret-value" },
    fallback: { mode: "off" },
  });
});

test("speech models come from the spike and can be overridden", () => {
  const cfg = buildConfig(input);
  assert.equal(cfg.asr.model, ASR_MODEL);
  assert.equal(cfg.voice.tts_model, TTS_MODEL);
  const other = buildConfig({ ...input, asrModel: "fish_audio:transcribe-stream-1", ttsModel: "drama-3" });
  assert.equal(other.asr.model, "fish_audio:transcribe-stream-1");
  assert.equal(other.voice.tts_model, "drama-3");
  assert.throws(() => buildConfig({ ...input, ttsModel: "s2.1-pro-free" }), /TTS model/);
});

test("conversation settings match the brief", () => {
  const c = buildConfig(input).conversation;
  assert.equal(c.max_duration_seconds, 1800);
  assert.equal(c.hangup_after_seconds, HANGUP_AFTER_MAX_SECONDS);
  assert.ok(c.hangup_after_seconds >= 600);
  assert.equal(c.eagerness, "relaxed");
  assert.equal(c.interruption_sensitivity, "low");
  assert.deepEqual(c.echo_guard, { web_voice: true });
  assert.equal(c.record_audio, true);
  assert.equal(c.speculative_response, true);
});

test("the voice platform never hangs up on its own", () => {
  assert.deepEqual(buildConfig(input).tools, { system_tools: { hang_up_call: false } });
});

test("origin must be https", () => {
  assert.throws(() => buildConfig({ ...input, appOrigin: "http://rounds.dijmo.com" }), /https/);
  assert.throws(() => buildConfig({ ...input, llmSecret: "" }), /FISH_LLM_SECRET/);
});

test("agent stays private and allows the overrides the server uses", () => {
  const s = buildAgentSettings();
  assert.equal(s.public_enabled, false);
  for (const o of ["system_prompt", "voice_id", "first_message", "asr.model"]) assert.ok(s.overrides_allowed.includes(o));
});

test("mask hides secrets at any depth", () => {
  const shown = JSON.stringify(mask({ config: buildConfig(input) }));
  assert.ok(!shown.includes("llm-secret-value"));
  assert.ok(shown.includes("<hidden, 16 chars>"));
});

test("dry run without an API key sends nothing and prints a masked plan", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("network used in dry run"); };
  const chunks = [];
  const realWrite = process.stdout.write;
  process.stdout.write = (c) => { chunks.push(String(c)); return true; };
  try {
    const id = await main(["--dry-run"], { APP_ORIGIN: "https://rounds.dijmo.com", FISH_LLM_SECRET: "llm-secret-value" });
    assert.equal(id, null);
  } finally {
    process.stdout.write = realWrite;
    globalThis.fetch = realFetch;
  }
  const out = chunks.join("");
  assert.ok(!out.includes("llm-secret-value"));
  const plan = JSON.parse(out);
  assert.equal(plan[0].method, "POST");
  assert.equal(plan[0].path, "/v1/agent/agents");
  assert.equal(plan.at(-1).path.endsWith("/publish"), true);
});
