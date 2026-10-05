import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent } from "../src/workflow.js";
import { readConfig } from "../src/config.js";
import { loadState, saveState, acquireLock } from "../src/state.js";
import { contest, pool, lineup, recorded } from "./fixtures.js";

async function setup(t: any, mode = "") {
  const dir = await mkdtemp(join(tmpdir(), "mafl-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const config = readConfig({
    OPENAI_API_KEY: "openai-test-key",
    OPENAI_MODEL: "test-model",
    MAFL_API_KEY: `mafl_live_${"a".repeat(32)}`,
    AGENT_STATE_DIR: dir,
  });

  const calls: { path: string; body: any; key: string | null }[] = [];
  let submitted = false,
    analyses = 0;

  const fetcher = (async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);

    if (url === "https://mafl.ai/skill.md") {
      assert.equal(headers.has("Authorization"), false);

      return new Response("Version: `1.4`", { headers: { ETag: "test-etag" } });
    }
    assert.equal(headers.get("Authorization"), `Bearer ${config.maflKey}`);
    assert.equal(init.redirect, "error");

    const path = url.replace("https://api.mafl.ai/v1", "");
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body, key: headers.get("Idempotency-Key") });

    if (path === "/contests/current" && mode === "closed")
      return Response.json(
        { code: "no_open_contest", message: "none", fix: "later" },
        { status: 404 },
      );

    if (path === "/contests/current") return Response.json(contest);

    if (path.endsWith("/players")) return Response.json(pool);

    if (path === "/scoring") return Response.json({ version: "2026.1" });

    if (path === "/agents/me") return Response.json({ model: "test-model" });

    if (path.endsWith("/lineups/me"))
      return Response.json({
        contest_id: contest.id,
        lineup: submitted || mode === "unchanged" ? recorded : null,
      });

    if (path.endsWith("?dry_run=true"))
      return Response.json({ contest_id: contest.id, dry_run: true });

    if (path.endsWith("/lineups")) {
      submitted = true;

      if (mode === "ambiguous") throw new Error("Connection lost");

      return Response.json({ dry_run: false }, { status: 201 });
    }
    throw new Error(`Unexpected test route ${path}`);
  }) as typeof fetch;

  const analyst = async () => {
    analyses++;

    return {
      lineup,
      research: "Research",
      sources: [{ url: "https://www.nfl.com", title: "Report" }],
      usage: { research: null, lineup: null },
    };
  };

  return {
    config,
    calls,
    agent: createAgent(config, { fetcher, analyst: analyst as any }),
    analyses: () => analyses,
  };
}

test("dry-run then identical submission/read-back persist confirmation", async (t) => {
  const s = await setup(t);
  const result = await s.agent(new AbortController().signal);
  assert.equal(result.status, "submitted");

  const writes = s.calls.filter((c) => c.body);
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[0]!.body, writes[1]!.body);
  assert.equal(writes[0]!.key, writes[1]!.key);

  const state = await loadState(s.config.stateDir);
  assert.equal(state.pending, undefined);
  assert.equal(state.last?.contestId, contest.id);
});

test("dry-run never submits or stores pending write", async (t) => {
  const s = await setup(t);
  assert.equal(
    (await s.agent(new AbortController().signal, true)).status,
    "dry_run",
  );
  assert.equal(s.calls.filter((c) => c.body).length, 1);
  assert.equal((await loadState(s.config.stateDir)).pending, undefined);
});

test("no open contest and unchanged selections do not submit", async (t) => {
  const closed = await setup(t, "closed");
  assert.equal(
    (await closed.agent(new AbortController().signal)).status,
    "no_open_contest",
  );
  assert.equal(closed.analyses(), 0);

  const same = await setup(t, "unchanged");
  assert.equal(
    (await same.agent(new AbortController().signal)).status,
    "unchanged",
  );
  assert.equal(same.calls.filter((c) => c.body).length, 0);
});

test("ambiguous failure retains exact pending body for next-run replay without another model call", async (t) => {
  const s = await setup(t, "ambiguous");
  await assert.rejects(s.agent(new AbortController().signal));

  const state = await loadState(s.config.stateDir);
  assert.ok(state.pending);

  const next = await setup(t);
  await saveState(next.config.stateDir, state);
  assert.equal(
    (await next.agent(new AbortController().signal)).status,
    "submitted",
  );
  assert.equal(next.analyses(), 0);

  const writes = next.calls.filter((c) => c.body);
  assert.equal(writes.length, 1);
  assert.equal(writes[0]!.key, state.pending.key);
  assert.deepEqual(writes[0]!.body, state.pending.body);
});

test("cross-process lock blocks overlapping invocations", async (t) => {
  const s = await setup(t);
  const release = await acquireLock(s.config.stateDir);
  await assert.rejects(s.agent(new AbortController().signal), /Another agent/);
  await release();
});

test("previously successful pending submission recovers after lock without another write", async (t) => {
  const s = await setup(t, "unchanged");
  await saveState(s.config.stateDir, {
    pending: { contestId: contest.id, key: "original-key", body: lineup },
  });
  assert.equal(
    (await s.agent(new AbortController().signal)).status,
    "submission_recovered",
  );
  assert.equal(s.calls.filter((c) => c.body).length, 0);
  assert.equal(s.analyses(), 0);
  assert.equal((await loadState(s.config.stateDir)).pending, undefined);
});
