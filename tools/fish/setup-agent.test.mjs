import { test } from "node:test";
import assert from "node:assert/strict";
import { buildConfig, buildAgentSettings, mask, main, HANGUP_AFTER_MAX_SECONDS } from "./setup-agent.mjs";

const input = { appOrigin: "https://rounds.dijmo.com/", llmSecret: "llm-secret-value" };

test("config points the agent at our server as a custom LLM", () => {
  const cfg = buildConfig(input);
  assert.deepEqual(cfg.llm, {
    custom: { base_url: "https://rounds.dijmo.com/v1", model: "interview-rounds", api_key: "llm-secret-value" },
  });
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
});

test("origin must be https", () => {
  assert.throws(() => buildConfig({ ...input, appOrigin: "http://rounds.dijmo.com" }), /https/);
  assert.throws(() => buildConfig({ ...input, llmSecret: "" }), /FISH_LLM_SECRET/);
});

test("agent stays private and allows the overrides the server uses", () => {
  const s = buildAgentSettings();
  assert.equal(s.public_enabled, false);
  for (const o of ["system_prompt", "voice_id", "first_message"]) assert.ok(s.overrides_allowed.includes(o));
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
