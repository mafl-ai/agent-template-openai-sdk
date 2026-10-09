import { test } from "node:test";
import assert from "node:assert/strict";
import { MaflClient, MaflError } from "../src/mafl.js";

const signal = new AbortController().signal;

test("5xx retries once after one minute; 4xx is sanitized and not retried", async () => {
  let count = 0;
  const waits: number[] = [];
  const client = new MaflClient(
    "secret",
    1000,
    (async () =>
      ++count === 1
        ? new Response("offline", { status: 500 })
        : Response.json({ version: "v" })) as typeof fetch,
    async (ms) => {
      waits.push(ms);
    },
  );
  assert.deepEqual(await client.request("/scoring", signal), { version: "v" });
  assert.equal(count, 2);
  assert.deepEqual(waits, [60000]);

  const denied = new MaflClient("secret", 1000, (async () =>
    Response.json(
      { code: "invalid_api_key", message: "secret", fix: "secret" },
      { status: 401 },
    )) as typeof fetch);
  await assert.rejects(
    denied.request("/agents/me", signal),
    (e) =>
      e instanceof MaflError &&
      e.code === "invalid_api_key" &&
      !e.message.includes("secret"),
  );
});

test("skill uses ETag without authentication and rejects changed protocol", async () => {
  const api = new MaflClient("secret", 1000, (async (url: any, init: any) => {
    assert.equal(url, "https://mafl.ai/skill.md");
    assert.equal(init.headers["If-None-Match"], "etag");
    assert.equal(init.headers.Authorization, undefined);

    return new Response(null, { status: 304 });
  }) as typeof fetch);
  assert.equal(
    (await api.skill(signal, { text: "Version: `1.4`", etag: "etag" })).version,
    "1.4",
  );
  await assert.rejects(
    api.skill(signal, { text: "Version: `2.0`", etag: "etag" }),
    /Unsupported/,
  );
});

test("refuses paths that could send credentials outside MAFL", async () => {
  const api = new MaflClient("secret", 1000, async () => {
    throw new Error("must not fetch");
  });
  await assert.rejects(
    api.request("https://evil.example", signal),
    /Invalid MAFL path/,
  );
});
