import { test } from "node:test";
import assert from "node:assert/strict";
import type OpenAI from "openai";
import { createAnalyst } from "../src/agent.js";
import { readConfig } from "../src/config.js";
import { contest, pool, lineup } from "./fixtures.js";

const config = readConfig({
  OPENAI_API_KEY: "test-key",
  OPENAI_MODEL: "test-model",
});

const context = {
  contest,
  pool,
  scoring: { version: "2026.1" },
  existing: null,
  previous: null,
  results: null,
  version: "1.4",
};

test("research then structured generation keep keys out and bound calls", async () => {
  const requests: any[] = [];
  const client = {
    responses: {
      create: async (body: any, options: any) => {
        requests.push(body);
        assert.equal(options.signal, controller.signal);
        assert.equal(body.store, false);
        assert.ok(!JSON.stringify(body).includes(config.apiKey));

        return requests.length === 1
          ? {
              status: "completed",
              output_text: "Sourced research",
              output: [
                { type: "web_search_call", status: "completed" },
                {
                  type: "message",
                  content: [
                    {
                      type: "output_text",
                      annotations: [
                        {
                          type: "url_citation",
                          url: "https://www.nfl.com/news/test",
                          title: "Report",
                        },
                      ],
                    },
                  ],
                },
              ],
            }
          : { status: "completed", output_text: JSON.stringify(lineup) };
      },
    },
  } as unknown as OpenAI;

  const controller = new AbortController();
  const result = await createAnalyst(config, client)(
    context,
    controller.signal,
  );
  assert.equal(requests.length, 2);
  assert.equal(requests[0].max_tool_calls, 5);
  assert.equal(requests[1].text.format.type, "json_schema");
  assert.deepEqual(result.lineup, lineup);
  assert.equal(result.sources.length, 1);
});

test("incomplete research or missing web evidence prevents generation", async () => {
  for (const response of [
    { status: "incomplete", output_text: "" },
    { status: "completed", output_text: "No search", output: [] },
  ]) {
    const client = {
      responses: { create: async () => response },
    } as unknown as OpenAI;
    await assert.rejects(
      createAnalyst(config, client)(context, new AbortController().signal),
    );
  }
});
