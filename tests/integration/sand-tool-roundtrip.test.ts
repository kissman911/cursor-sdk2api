import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { SystemClock } from "../../src/clock.js";
import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/log.js";
import { createApp, type App } from "../../src/server/app.js";
import type { SdkRuntime } from "../../src/sdk/port.js";
import { CONNECT_END_STREAM_FLAG, encodeConnectEnvelope } from "../../src/sdk/sand-inference-codec.js";
import { SandInferenceRuntime } from "../../src/sdk/sand-inference-runtime.js";
import { parseSse } from "../helpers/app.js";

/**
 * End-to-end: Claude-Code-shaped /v1/messages traffic against the sand profile.
 * The upstream InferenceService is faked at the fetch layer; everything else
 * (SandInferenceRuntime, RunCoordinator, EventPump, Anthropic writer) is real.
 */

const enc = new TextEncoder();
const textFrame = (text: string) => {
  const body = enc.encode(text);
  const part = Uint8Array.from([0x0a, ...lengthPrefix(body.length), ...body]);
  return encodeConnectEnvelope(Uint8Array.from([0x0a, ...lengthPrefix(part.length), ...part]));
};
const thinkingFrame = (text: string) => {
  const body = enc.encode(text);
  const part = Uint8Array.from([0x0a, ...lengthPrefix(body.length), ...body]);
  return encodeConnectEnvelope(Uint8Array.from([0x4a, ...lengthPrefix(part.length), ...part]));
};
const endFrame = () => encodeConnectEnvelope(enc.encode("{}"), CONNECT_END_STREAM_FLAG);

function lengthPrefix(value: number): number[] {
  const out: number[] = [];
  let n = value;
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return out;
}

function protoResponse(frames: Uint8Array[]): Response {
  return new Response(
    new ReadableStream({
      async start(controller) {
        for (const frame of frames) {
          controller.enqueue(frame);
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "application/connect+proto" } },
  );
}

const toolCall = (name: string, input: Record<string, unknown>) =>
  `<sand:tool_call>\n${JSON.stringify({ name, input })}\n</sand:tool_call>`;

const TOOLS = [
  {
    name: "Bash",
    description: "Executes a bash command",
    input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  },
  {
    name: "Read",
    description: "Reads a file",
    input_schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] },
  },
];

interface Harness {
  app: App;
  server: Server;
  url: string;
  upstreamBodies: string[];
}

let harness: Harness | undefined;

afterEach(async () => {
  if (!harness) return;
  harness.app.beginShutdown();
  harness.app.close();
  await new Promise<void>((resolve) => harness!.server.close(() => resolve()));
  harness = undefined;
});

async function start(script: (index: number) => Uint8Array[]): Promise<Harness> {
  const upstreamBodies: string[] = [];
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = init?.body instanceof Uint8Array ? init.body : new Uint8Array(0);
    upstreamBodies.push(new TextDecoder().decode(body));
    return protoResponse(script(upstreamBodies.length - 1));
  }) as typeof fetch;
  const sand = new SandInferenceRuntime({ fetch: fetchImpl, exchange: async () => "token", baseUrl: "https://sand.test" });
  const sdk: SdkRuntime = {
    sdkVersion: "1.0.30",
    createAgent: async (input) => sand.createAgent(input),
    resumeAgent: async (input) => sand.resumeAgent(input),
    listModels: async () => ({ ok: true, models: [{ id: "grok-4.6" }] }),
    getAccount: async () => ({ ok: true, identity: { apiKeyName: "t" } }),
    probeCredential: async () => "valid",
  };
  const config = loadConfig({
    host: "127.0.0.1",
    port: 0,
    toolBatchSettleMs: 0,
    firstEventTimeoutMs: 2000,
    stateDir: mkdtempSync(join(tmpdir(), "cursor-sdk2api-sand-e2e-")),
    runtimePolicy: { defaultProfile: "sand", allowRequestOverride: false, hostedSearchMode: "off" },
  });
  const app = createApp({
    config,
    sdk,
    clock: new SystemClock(),
    logger: createLogger("error"),
    workspaceDir: mkdtempSync(join(tmpdir(), "cursor-sdk2api-sand-e2e-ws-")),
    assertSandAccess: async () => undefined,
  });
  const server = createServer((req, res) => void app.handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("bind failed");
  harness = { app, server, url: `http://127.0.0.1:${address.port}`, upstreamBodies };
  return harness;
}

async function messages(h: Harness, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${h.url}/v1/messages`, {
    method: "POST",
    headers: {
      authorization: "Bearer test-key-a",
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "interleaved-thinking-2025-05-14",
    },
    body: JSON.stringify(body),
  });
}

const firstStep = [
  thinkingFrame("Two kinds of memory to check."),
  textFrame("我来看一下两种可能的“内存”，然后给你结论。\n\n"),
  textFrame(toolCall("Bash", { command: "free -h" })),
  textFrame("\n"),
  textFrame(toolCall("Read", { file_path: "/home/czc/.claude/memory/MEMORY.md" })),
];
const secondStep = [textFrame("内存充足，不需要清理。")];

test("streaming: tool call blocks surface as tool_use with stop_reason tool_use, and tool_result resumes the same run", async () => {
  const h = await start((index) => (index === 0 ? [...firstStep, endFrame()] : [...secondStep, endFrame()]));

  const first = await messages(h, {
    model: "grok-4.6",
    max_tokens: 4096,
    stream: true,
    thinking: { type: "enabled", budget_tokens: 1024 },
    system: [{ type: "text", text: "You are Claude Code." }],
    tools: TOOLS,
    messages: [{ role: "user", content: "系统的内存需要清理吗？" }],
  });
  expect(first.status).toBe(200);
  const events = parseSse(await first.text());
  const names = events.map((event) => event.event);
  expect(names[0]).toBe("message_start");
  expect(names.at(-2)).toBe("message_delta");
  expect(names.at(-1)).toBe("message_stop");

  const starts = events.filter((event) => event.event === "content_block_start").map((event) => event.data as { index: number; content_block: Record<string, unknown> });
  expect(starts.map((start) => start.content_block.type)).toEqual(["thinking", "text", "tool_use", "tool_use"]);
  expect(starts.map((start) => start.index)).toEqual([0, 1, 2, 3]);
  const stops = events.filter((event) => event.event === "content_block_stop").map((event) => (event.data as { index: number }).index);
  expect(stops).toEqual([0, 1, 2, 3]);

  // Visible prose excludes every tag; thinking is intact.
  const textDeltas = events
    .filter((event) => event.event === "content_block_delta" && (event.data as { delta: { type: string } }).delta.type === "text_delta")
    .map((event) => (event.data as { delta: { text: string } }).delta.text)
    .join("");
  expect(textDeltas).toBe("我来看一下两种可能的“内存”，然后给你结论。\n\n");
  expect(textDeltas).not.toContain("sand:tool_call");
  const thinkingDeltas = events
    .filter((event) => event.event === "content_block_delta" && (event.data as { delta: { type: string } }).delta.type === "thinking_delta")
    .map((event) => (event.data as { delta: { thinking: string } }).delta.thinking)
    .join("");
  expect(thinkingDeltas).toBe("Two kinds of memory to check.");

  // tool_use blocks carry ids, declared names, and complete JSON input.
  const toolUses = starts.filter((start) => start.content_block.type === "tool_use").map((start) => start.content_block as { id: string; name: string });
  expect(toolUses.map((block) => block.name)).toEqual(["Bash", "Read"]);
  for (const block of toolUses) expect(block.id).toMatch(/^toolu_/);
  const inputs = events
    .filter((event) => event.event === "content_block_delta" && (event.data as { delta: { type: string } }).delta.type === "input_json_delta")
    .map((event) => JSON.parse((event.data as { delta: { partial_json: string } }).delta.partial_json) as unknown);
  expect(inputs).toEqual([{ command: "free -h" }, { file_path: "/home/czc/.claude/memory/MEMORY.md" }]);

  const delta = events.find((event) => event.event === "message_delta")!.data as { delta: { stop_reason: string } };
  expect(delta.delta.stop_reason).toBe("tool_use");
  expect(h.upstreamBodies).toHaveLength(1);

  // Claude Code executes the tools and posts the results with the full transcript.
  const second = await messages(h, {
    model: "grok-4.6",
    max_tokens: 4096,
    stream: true,
    thinking: { type: "enabled", budget_tokens: 1024 },
    system: [{ type: "text", text: "You are Claude Code." }],
    tools: TOOLS,
    messages: [
      { role: "user", content: "系统的内存需要清理吗？" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: thinkingDeltas },
          { type: "text", text: textDeltas },
          { type: "tool_use", id: toolUses[0]!.id, name: "Bash", input: { command: "free -h" } },
          { type: "tool_use", id: toolUses[1]!.id, name: "Read", input: { file_path: "/home/czc/.claude/memory/MEMORY.md" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: toolUses[0]!.id, content: "Mem: 62Gi total 40Gi free" },
          { type: "tool_result", tool_use_id: toolUses[1]!.id, content: [{ type: "text", text: "# notes" }] },
        ],
      },
    ],
  });
  expect(second.status).toBe(200);
  const secondEvents = parseSse(await second.text());
  const finalText = secondEvents
    .filter((event) => event.event === "content_block_delta" && (event.data as { delta: { type: string } }).delta.type === "text_delta")
    .map((event) => (event.data as { delta: { text: string } }).delta.text)
    .join("");
  expect(finalText).toBe("内存充足，不需要清理。");
  const finalDelta = secondEvents.find((event) => event.event === "message_delta")!.data as { delta: { stop_reason: string } };
  expect(finalDelta.delta.stop_reason).toBe("end_turn");

  // Exactly one more upstream round trip, carrying the protocol, the raw tool call text, and the tagged results.
  expect(h.upstreamBodies).toHaveLength(2);
  const upstream = h.upstreamBodies[1]!;
  expect(upstream).toContain("# Tool calling protocol");
  expect(upstream).toContain("Executes a bash command");
  expect(upstream).toContain(toolCall("Bash", { command: "free -h" }));
  expect(upstream).toContain(`<sand:tool_result id="${toolUses[0]!.id}" name="Bash" is_error="false">\nMem: 62Gi total 40Gi free\n</sand:tool_result>`);
  expect(upstream).toContain(`<sand:tool_result id="${toolUses[1]!.id}" name="Read" is_error="false">\n# notes\n</sand:tool_result>`);
});

test("non-streaming: the JSON message lists thinking, text, and both tool_use blocks with stop_reason tool_use", async () => {
  const h = await start(() => [...firstStep, endFrame()]);
  const res = await messages(h, {
    model: "grok-4.6",
    max_tokens: 4096,
    tools: TOOLS,
    messages: [{ role: "user", content: "系统的内存需要清理吗？" }],
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { stop_reason: string; content: Array<Record<string, unknown>> };
  expect(body.stop_reason).toBe("tool_use");
  expect(body.content.map((block) => block.type)).toEqual(["thinking", "text", "tool_use", "tool_use"]);
  expect(body.content[1]?.text).toBe("我来看一下两种可能的“内存”，然后给你结论。\n\n");
  expect(body.content[2]).toMatchObject({ name: "Bash", input: { command: "free -h" } });
  expect(body.content[3]).toMatchObject({ name: "Read", input: { file_path: "/home/czc/.claude/memory/MEMORY.md" } });
});

test("a request without tools never receives the protocol prompt", async () => {
  const h = await start(() => [textFrame("hello"), endFrame()]);
  const res = await messages(h, { model: "grok-4.6", max_tokens: 64, messages: [{ role: "user", content: "hi" }] });
  expect(res.status).toBe(200);
  expect(h.upstreamBodies[0]).not.toContain("Tool calling protocol");
});
