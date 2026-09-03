import { afterEach, expect, test } from "vitest";
import { api, closeTestApp, startTestApp, weatherTool, type TestContext } from "../helpers/app.js";

let ctx: TestContext;

afterEach(async () => {
  if (ctx) await closeTestApp(ctx);
});

test("each response segment reports its own increment of the cumulative run usage", async () => {
  ctx = await startTestApp({
    sdk: {
      scripts: [
        [
          { type: "tools", calls: [{ name: "lookup", input: { q: "u" } }] },
          { type: "text", chunks: ["answer"] },
        ],
      ],
      // run.usage as observed at the tool boundary (cumulative so far)
      liveUsage: { inputTokens: 99, outputTokens: 99, cacheReadTokens: 7, cacheWriteTokens: 3 },
      // run.wait() usage once the run finishes (cumulative over both model steps)
      finalUsage: { inputTokens: 110, outputTokens: 104, cacheReadTokens: 9, cacheWriteTokens: 7 },
    },
  });
  const first = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [{ role: "user", content: "go" }],
      tools: [weatherTool()],
    }),
  });
  const toolTurn = (await first.json()) as {
    content: Array<{ type: string; id?: string }>;
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
    usage_deferred?: boolean;
    usage_status?: string;
  };
  expect(toolTurn.usage.input_tokens).toBe(99);
  expect(toolTurn.usage.output_tokens).toBe(99);
  expect(toolTurn.usage.cache_creation_input_tokens).toBe(3);
  expect(toolTurn.usage.cache_read_input_tokens).toBe(7);
  expect(toolTurn.usage_deferred).toBeUndefined();
  expect(toolTurn.usage_status).toBe("sdk");
  expect(ctx.sdk.agents[0]?.runs[0]?.waitCalls ?? 0).toBe(0);

  const id = toolTurn.content.find((block) => block.type === "tool_use")?.id;
  const second = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [
        { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
      ],
    }),
  });
  const final = (await second.json()) as {
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  expect(second.status).toBe(200);
  expect(final.usage.input_tokens).toBe(11);
  expect(final.usage.output_tokens).toBe(5);
  expect(final.usage.cache_creation_input_tokens).toBe(4);
  expect(final.usage.cache_read_input_tokens).toBe(2);
  expect(ctx.sdk.agents[0]?.runs[0]?.waitCalls).toBe(1);
});

test("tool turns stay deferred when the runtime has not reported usage yet", async () => {
  ctx = await startTestApp({
    sdk: {
      scripts: [
        [
          { type: "tools", calls: [{ name: "lookup", input: { q: "u" } }] },
          { type: "text", chunks: ["answer"] },
        ],
      ],
      finalUsage: { inputTokens: 11, outputTokens: 5 },
    },
  });
  const first = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [{ role: "user", content: "go" }],
      tools: [weatherTool()],
    }),
  });
  const toolTurn = (await first.json()) as {
    content: Array<{ type: string; id?: string }>;
    usage: { input_tokens: number; output_tokens: number };
    usage_deferred?: boolean;
  };
  expect(toolTurn.usage.input_tokens).toBe(0);
  expect(toolTurn.usage_deferred).toBe(true);

  const id = toolTurn.content.find((block) => block.type === "tool_use")?.id;
  const second = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [
        { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
      ],
    }),
  });
  const final = (await second.json()) as { usage: { input_tokens: number; output_tokens: number } };
  expect(final.usage.input_tokens).toBe(11);
  expect(final.usage.output_tokens).toBe(5);
});

test("usage fields are omitted as unavailable when the SDK does not report them", async () => {
  ctx = await startTestApp({
    sdk: {
      scripts: [[{ type: "text", chunks: ["plain"] }]],
    },
  });
  const res = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  const body = (await res.json()) as {
    usage: { input_tokens: number; cache_creation_input_tokens?: number };
  };
  expect(body.usage.input_tokens).toBe(0);
  expect(body.usage.cache_creation_input_tokens).toBeUndefined();
  expect(JSON.stringify(body)).not.toContain("estimated");
});
