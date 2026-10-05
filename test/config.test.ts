import { test } from "node:test";
import assert from "node:assert/strict";
import { readConfig } from "../src/config.js";

const env = { OPENAI_API_KEY: "test-key", OPENAI_MODEL: "test-model" };

test("defaults and explicit configuration", () => {
  assert.equal(readConfig(env).schedule, "0 14 * * 2");

  const config = readConfig({
    ...env,
    AGENT_TIMEZONE: "America/Los_Angeles",
    AGENT_MAX_OUTPUT_TOKENS: "500",
  });
  assert.equal(config.timezone, "America/Los_Angeles");
  assert.equal(config.maxOutputTokens, 500);
});

test("reject invalid configuration without exposing values", () => {
  for (const invalid of [
    { OPENAI_API_KEY: "" },
    { OPENAI_MODEL: "" },
    { AGENT_SCHEDULE: "invalid" },
    { AGENT_TIMEZONE: "invalid" },
    { AGENT_TIMEOUT_MS: "0" },
    { AGENT_TIMEOUT_MS: "NaN" },
    { AGENT_MAX_OUTPUT_TOKENS: "1.5" },
    { AGENT_MAX_OUTPUT_TOKENS: "100001" },
  ])
    assert.throws(() => readConfig({ ...env, ...invalid }));
});
