import { afterEach, expect, test } from "vitest";
import { ATTACHED_CONTINUATION_TEXT_MARKER } from "../../src/protocols/anthropic/parse.js";
import { api, closeTestApp, startTestApp, weatherTool, type TestContext } from "../helpers/app.js";

let ctx: TestContext;

afterEach(async () => {
  if (ctx) await closeTestApp(ctx);
});

const tools = [
  weatherTool(),
  {
    name: "beta",
    description: "Second tool",
    input_schema: { type: "object", properties: { n: { type: "number" } } },
  },
];

test("single tool round-trip uses the same in-process run", async () => {
  ctx = await startTestApp({
    sdk: {
      scripts: [
        [
          { type: "tools", calls: [{ name: "lookup", input: { q: "weather" } }] },
          { type: "text", chunks: ["sunny"] },
        ],
      ],
    },
  });
  const first = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 32,
      messages: [{ role: "user", content: "weather?" }],
      tools: [weatherTool()],
    }),
  });
  const toolTurn = (await first.json()) as {
    stop_reason: string;
    content: Array<{ type: string; id?: string; name?: string }>;
    usage: { input_tokens: number; output_tokens: number };
    usage_deferred?: boolean;
    cursor_session_id: string;
  };
  expect(first.status).toBe(200);
  expect(toolTurn.stop_reason).toBe("tool_use");
  const tool = toolTurn.content.find((block) => block.type === "tool_use");
  expect(tool?.name).toBe("lookup");
  expect(ctx.sdk.lastAllowlist).toEqual(["mcp"]);
  expect(ctx.sdk.agents[0]?.runs[0]?.waitCalls ?? 0).toBe(0);

  const second = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 32,
      messages: [
        { role: "user", content: "weather?" },
        { role: "assistant", content: toolTurn.content },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: tool?.id, content: "72F" }],
        },
      ],
      tools: [weatherTool()],
    }),
  });
  const final = (await second.json()) as { content: Array<{ text?: string }>; stop_reason: string };
  expect(second.status).toBe(200);
  expect(final.stop_reason).toBe("end_turn");
  expect(final.content.some((block) => block.text === "sunny")).toBe(true);
  expect(ctx.sdk.agents.length).toBe(1);
  expect(ctx.sdk.agents[0]?.runs.length).toBe(1);
  expect(ctx.sdk.agents[0]?.runs[0]?.waitCalls).toBe(1);
});

test("parallel tools return one assistant batch before any result resolves", async () => {
  ctx = await startTestApp({
    sdk: {
      scripts: [
        [
          {
            type: "tools",
            calls: [
              { name: "lookup", input: { q: "a" } },
              { name: "beta", input: { n: 2 } },
            ],
          },
          { type: "text", chunks: ["both"] },
        ],
      ],
    },
  });
  const first = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 32,
      messages: [{ role: "user", content: "do both" }],
      tools,
    }),
  });
  const toolTurn = (await first.json()) as {
    content: Array<{ type: string; id?: string; name?: string }>;
  };
  const calls = toolTurn.content.filter((block) => block.type === "tool_use");
  expect(calls).toHaveLength(2);
  expect(calls.map((call) => call.name).sort()).toEqual(["beta", "lookup"]);
  expect(ctx.app.registry.sessions.size).toBe(1);
  expect(ctx.sdk.agents[0]?.runs[0]?.waitCalls ?? 0).toBe(0);

  const second = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 32,
      messages: [
        { role: "user", content: "do both" },
        { role: "assistant", content: toolTurn.content },
        {
          role: "user",
          content: calls.map((call) => ({
            type: "tool_result",
            tool_use_id: call.id,
            content: "ok",
          })),
        },
      ],
      tools,
    }),
  });
  const final = (await second.json()) as { content: Array<{ text?: string }> };
  expect(second.status).toBe(200);
  expect(final.content.some((block) => block.text === "both")).toBe(true);
});

test("staggered same-turn callbacks still settle into one parallel batch", async () => {
  ctx = await startTestApp({
    config: { toolBatchSettleMs: 100 },
    sdk: {
      scripts: [
        [
          {
            type: "tools",
            calls: [
              { name: "lookup", input: { q: "a" } },
              { name: "beta", input: { n: 2 }, delayMs: 50 },
            ],
          },
          { type: "text", chunks: ["both"] },
        ],
      ],
    },
  });
  const first = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 32,
      messages: [{ role: "user", content: "do both" }],
      tools,
    }),
  });
  const turn = (await first.json()) as { content: Array<{ type: string; name?: string }> };
  expect(first.status).toBe(200);
  expect(turn.content.filter((block) => block.type === "tool_use").map((block) => block.name).sort()).toEqual([
    "beta",
    "lookup",
  ]);
});

test("a callback arriving after the published batch fails closed instead of becoming hidden pending state", async () => {
  ctx = await startTestApp({
    config: { toolBatchSettleMs: 10 },
    sdk: {
      scripts: [
        [
          {
            type: "tools",
            calls: [
              { name: "lookup", input: { q: "a" } },
              { name: "beta", input: { n: 2 }, delayMs: 40 },
            ],
          },
          { type: "text", chunks: ["must-not-complete"] },
        ],
      ],
    },
  });
  const first = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 32,
      messages: [{ role: "user", content: "do both" }],
      tools,
    }),
  });
  const turn = (await first.json()) as { content: Array<{ type: string; id?: string }> };
  const visible = turn.content.find((block) => block.type === "tool_use")?.id;
  expect(first.status).toBe(200);
  expect(visible).toBeTruthy();
  await new Promise((resolve) => setTimeout(resolve, 80));

  const continued = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 32,
      messages: [
        { role: "user", content: [{ type: "tool_result", tool_use_id: visible, content: "ok" }] },
      ],
      tools,
    }),
  });
  expect(continued.status).toBe(409);
  expect(((await continued.json()) as { error: { type: string } }).error.type).toBe("cursor_session_lost");
});

test("multi-round tools stay on the same SDK run", async () => {
  ctx = await startTestApp({
    sdk: {
      scripts: [
        [
          { type: "tools", calls: [{ name: "lookup", input: { q: "1" } }] },
          { type: "tools", calls: [{ name: "lookup", input: { q: "2" } }] },
          { type: "text", chunks: ["done-2"] },
        ],
      ],
    },
  });
  const first = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 32,
      messages: [{ role: "user", content: "round" }],
      tools: [weatherTool()],
    }),
  });
  const turn1 = (await first.json()) as { content: Array<{ type: string; id?: string }> };
  const id1 = turn1.content.find((block) => block.type === "tool_use")?.id;
  const second = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 32,
      messages: [
        { role: "user", content: "round" },
        { role: "assistant", content: turn1.content },
        { role: "user", content: [{ type: "tool_result", tool_use_id: id1, content: "r1" }] },
      ],
      tools: [weatherTool()],
    }),
  });
  const turn2 = (await second.json()) as { content: Array<{ type: string; id?: string }>; stop_reason: string };
  expect(turn2.stop_reason).toBe("tool_use");
  const id2 = turn2.content.find((block) => block.type === "tool_use")?.id;
  const third = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 32,
      messages: [
        { role: "user", content: "round" },
        { role: "user", content: [{ type: "tool_result", tool_use_id: id2, content: "r2" }] },
      ],
      tools: [weatherTool()],
    }),
  });
  const final = (await third.json()) as { content: Array<{ text?: string }> };
  expect(third.status).toBe(200);
  expect(final.content.some((block) => block.text === "done-2")).toBe(true);
  expect(ctx.sdk.agents[0]?.runs.length).toBe(1);
});

test("tool_result is_error resolves as native SDKCustomToolResult", async () => {
  ctx = await startTestApp({
    sdk: {
      scripts: [
        [
          { type: "tools", calls: [{ name: "lookup", input: { q: "boom" } }] },
          { type: "text", chunks: ["handled"] },
        ],
      ],
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
  const turn = (await first.json()) as { content: Array<{ type: string; id?: string }> };
  const id = turn.content.find((block) => block.type === "tool_use")?.id;
  const second = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: id, content: "lookup failed", is_error: true }],
        },
      ],
    }),
  });
  expect(second.status).toBe(200);
  expect(ctx.sdk.agents[0]?.runs[0]?.capturedToolResults).toEqual([
    { content: [{ type: "text", text: "lookup failed" }], isError: true },
  ]);
});

test("successful tool_result still resolves as a plain string", async () => {
  ctx = await startTestApp({
    sdk: {
      scripts: [
        [
          { type: "tools", calls: [{ name: "lookup", input: { q: "ok" } }] },
          { type: "text", chunks: ["done"] },
        ],
      ],
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
  const turn = (await first.json()) as { content: Array<{ type: string; id?: string }> };
  const id = turn.content.find((block) => block.type === "tool_use")?.id;
  await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "72F" }] }],
    }),
  });
  expect(ctx.sdk.agents[0]?.runs[0]?.capturedToolResults).toEqual(["72F"]);
});

test("text sharing a user turn with tool_result rides along with the last result", async () => {
  ctx = await startTestApp({
    sdk: {
      scripts: [
        [
          { type: "tools", calls: [{ name: "lookup", input: { q: "ok" } }] },
          { type: "text", chunks: ["done"] },
        ],
      ],
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
  const turn = (await first.json()) as { content: Array<{ type: string; id?: string }> };
  const id = turn.content.find((block) => block.type === "tool_use")?.id;
  const second = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: id, content: "72F" },
            { type: "text", text: "<system-reminder>also do this</system-reminder>" },
          ],
        },
      ],
    }),
  });
  expect(second.status).toBe(200);
  const delivered = ctx.sdk.agents[0]?.runs[0]?.capturedToolResults as string[];
  expect(delivered).toHaveLength(1);
  expect(delivered[0]).toContain("72F");
  expect(delivered[0]).toContain(ATTACHED_CONTINUATION_TEXT_MARKER);
  expect(delivered[0]).toContain("<system-reminder>also do this</system-reminder>");
});

test("non-text blocks other than images cannot share a user turn with tool_result", async () => {
  ctx = await startTestApp();
  const res = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_use", id: "toolu_y", name: "lookup", input: {} },
            { type: "tool_result", tool_use_id: "toolu_x", content: "1" },
          ],
        },
      ],
    }),
  });
  const body = (await res.json()) as { error: { type: string } };
  expect(res.status).toBe(422);
  expect(body.error.type).toBe("invalid_request");
});
