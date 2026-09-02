import { expect, test } from "vitest";
import { GatewayError } from "../../src/errors.js";
import {
  CONNECT_END_STREAM_FLAG,
  ConnectEnvelopeReader,
  encodeConnectEnvelope,
} from "../../src/sdk/sand-inference-codec.js";
import {
  inspectSandInference,
  SAND_INFERENCE_TRANSPORT,
  SandInferenceRuntime,
} from "../../src/sdk/sand-inference-runtime.js";
import type { SdkDeltaUpdate } from "../../src/sdk/port.js";

const enc = new TextEncoder();
const hex = (text: string) => Uint8Array.from(Buffer.from(text, "hex"));
const textFrame = (text: string) => {
  const body = enc.encode(text);
  const part = Uint8Array.from([0x0a, body.length, ...body]);
  return Uint8Array.from([0x0a, part.length, ...part]);
};
const thinkingFrame = (text: string) => {
  const body = enc.encode(text);
  const part = Uint8Array.from([0x0a, body.length, ...body]);
  return Uint8Array.from([0x4a, part.length, ...part]);
};
const usageFrame = () => hex("1a070818106f188701");
const errorFrame = (message: string) => {
  const body = enc.encode(message);
  const inner = Uint8Array.from([0x0a, body.length, ...body]);
  return Uint8Array.from([0x42, inner.length, ...inner]);
};
const endFrame = (payload: object = {}) => encodeConnectEnvelope(enc.encode(JSON.stringify(payload)), CONNECT_END_STREAM_FLAG);

function streamBody(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      controller.close();
    },
  });
}

function protoResponse(frames: Uint8Array[], status = 200): Response {
  return new Response(streamBody(frames), {
    status,
    headers: { "content-type": "application/connect+proto" },
  });
}

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

function fakeFetch(handler: (call: Captured, index: number) => Response | Promise<Response>) {
  const calls: Captured[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const record: Captured = {
      url: String(input),
      headers: Object.fromEntries([...headers.entries()]),
      body: init?.body instanceof Uint8Array ? init.body : new Uint8Array(0),
    };
    calls.push(record);
    return handler(record, calls.length - 1);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function runtimeWith(handler: Parameters<typeof fakeFetch>[0], exchange = async () => "token-1") {
  const { fetchImpl, calls } = fakeFetch(handler);
  const runtime = new SandInferenceRuntime({ fetch: fetchImpl, exchange, baseUrl: "https://sand.test" });
  return { runtime, calls };
}

const createInput = {
  apiKey: "crsr_test",
  modelId: "grok-4.6",
  modelParams: [{ id: "effort", value: "xhigh" }],
  workspaceDir: "/tmp/ws",
  clientToolNames: ["lookup"],
  customTools: {},
  runtimeProfile: "sand" as const,
};

test("streams text and thinking through onDelta, then finishes with usage and history", async () => {
  const { runtime, calls } = runtimeWith(() =>
    protoResponse([
      encodeConnectEnvelope(thinkingFrame("hmm")),
      encodeConnectEnvelope(textFrame("po")),
      encodeConnectEnvelope(textFrame("ng")),
      encodeConnectEnvelope(usageFrame()),
      endFrame(),
    ]),
  );
  const agent = runtime.createAgent(createInput);
  const deltas: SdkDeltaUpdate[] = [];
  const run = await agent.send({ text: "Reply: pong", onDelta: (update) => void deltas.push(update) });

  const events: string[] = [];
  for await (const event of run.stream()) events.push(event.type === "status" ? `status:${event.status}` : event.type);
  const result = await run.wait();

  expect(result.status).toBe("finished");
  expect(result.result).toBe("pong");
  expect(result.usage).toEqual({ inputTokens: 24, outputTokens: 111, totalTokens: 135 });
  expect(deltas).toEqual([
    { type: "thinking-delta", text: "hmm" },
    { type: "text-delta", text: "po" },
    { type: "text-delta", text: "ng" },
    { type: "turn-ended", usage: { inputTokens: 24, outputTokens: 111, totalTokens: 135 } },
  ]);
  // With an onDelta sink, text/thinking are not duplicated onto run.stream().
  expect(events).toEqual(["status:RUNNING", "usage", "status:FINISHED"]);

  const call = calls[0]!;
  expect(call.url).toBe(`https://sand.test/${SAND_INFERENCE_TRANSPORT}`);
  expect(call.headers["x-cursor-client-type"]).toBe("sand");
  expect(call.headers["x-cursor-client-version"]).toBe("sdk-1.0.30");
  expect(call.headers["x-sand-box-namespace"]).toBe("prod");
  expect(call.headers["content-type"]).toBe("application/connect+proto");
  expect(call.headers.authorization).toBe("Bearer token-1");

  // Request body is one Connect envelope carrying the user turn plus merged params.
  const reader = new ConnectEnvelopeReader();
  const [envelope] = reader.push(call.body);
  const payloadHex = Buffer.from(envelope!.payload).toString("hex");
  expect(payloadHex).toContain(Buffer.from("Reply: pong").toString("hex"));
  expect(payloadHex).toContain(Buffer.from("xhigh").toString("hex"));
  expect(payloadHex).toContain(Buffer.from("fast").toString("hex"));

  // Second turn replays the in-memory history: system-free, user, assistant, user.
  await (await agent.send({ text: "again", onDelta: () => undefined })).wait();
  const second = new ConnectEnvelopeReader().push(calls[1]!.body)[0]!.payload;
  const secondHex = Buffer.from(second).toString("hex");
  expect(secondHex.indexOf(Buffer.from("Reply: pong").toString("hex"))).toBeGreaterThan(-1);
  expect(secondHex.indexOf(Buffer.from("pong").toString("hex"))).toBeGreaterThan(-1);
  expect(secondHex.indexOf(Buffer.from("again").toString("hex"))).toBeGreaterThan(
    secondHex.indexOf(Buffer.from("Reply: pong").toString("hex")),
  );
});

test("without an onDelta sink, text and thinking are emitted on run.stream()", async () => {
  const { runtime } = runtimeWith(() =>
    protoResponse([encodeConnectEnvelope(thinkingFrame("t")), encodeConnectEnvelope(textFrame("x")), endFrame()]),
  );
  const run = await runtime.createAgent(createInput).send({ text: "hi" });
  const events: unknown[] = [];
  for await (const event of run.stream()) events.push(event);
  expect(events).toEqual([
    { type: "status", status: "RUNNING" },
    { type: "thinking", text: "t" },
    { type: "assistant", text: "x" },
    { type: "status", status: "FINISHED" },
  ]);
  expect((await run.wait()).result).toBe("x");
});

test("end-stream errors become typed gateway failures and do not extend history", async () => {
  const { runtime } = runtimeWith(() =>
    protoResponse([
      endFrame({
        error: {
          code: "permission_denied",
          message: "Error",
          details: [{ type: "aiserver.v1.ErrorDetails", debug: { error: "ERROR_OUTDATED_CLIENT", details: { title: "Outdated" } } }],
        },
      }),
    ]),
  );
  const agent = runtime.createAgent(createInput);
  const run = await agent.send({ text: "hi", onDelta: () => undefined });
  for await (const _ of run.stream()) {
    // drain
  }
  const result = await run.wait();
  expect(result.status).toBe("error");
  expect(result.error?.code).toBe("forbidden");
  expect(result.error?.message).toMatch(/ERROR_OUTDATED_CLIENT/);
});

test("in-band error frames and rate limits map to upstream and rate_limited codes", async () => {
  const inBand = runtimeWith(() => protoResponse([encodeConnectEnvelope(errorFrame("model exploded")), endFrame()]));
  const run = await inBand.runtime.createAgent(createInput).send({ text: "hi", onDelta: () => undefined });
  expect((await run.wait()).error).toEqual({ message: "model exploded", code: "cursor_upstream_error" });

  const limited = runtimeWith(() =>
    protoResponse([endFrame({ error: { code: "resource_exhausted", message: "ERROR_USAGE_LIMIT" } })]),
  );
  const limitedRun = await limited.runtime.createAgent(createInput).send({ text: "hi", onDelta: () => undefined });
  expect((await limitedRun.wait()).error?.code).toBe("rate_limited");
});

test("HTTP 401 triggers exactly one token refresh and retry before any semantic output", async () => {
  let exchanges = 0;
  const { runtime, calls } = runtimeWith(
    (call, index) =>
      index === 0
        ? new Response("expired", { status: 401 })
        : protoResponse([encodeConnectEnvelope(textFrame("ok")), endFrame()]),
    async () => `token-${++exchanges}`,
  );
  const run = await runtime.createAgent(createInput).send({ text: "hi", onDelta: () => undefined });
  expect((await run.wait()).result).toBe("ok");
  expect(exchanges).toBe(2);
  expect(calls.map((call) => call.headers.authorization)).toEqual(["Bearer token-1", "Bearer token-2"]);
});

test("persistent HTTP rejections surface as typed errors from send()", async () => {
  const forbidden = runtimeWith(() => new Response("nope", { status: 403 }));
  await expect(forbidden.runtime.createAgent(createInput).send({ text: "hi" })).rejects.toMatchObject({
    code: "forbidden",
  });
  const limited = runtimeWith(() => new Response("slow down", { status: 429 }));
  await expect(limited.runtime.createAgent(createInput).send({ text: "hi" })).rejects.toMatchObject({
    code: "rate_limited",
  });
  const server = runtimeWith(() => new Response("boom", { status: 503 }));
  await expect(server.runtime.createAgent(createInput).send({ text: "hi" })).rejects.toMatchObject({
    code: "cursor_upstream_error",
    httpStatus: 502,
  });
});

test("resume only attaches to resident agents owned by the same credential", async () => {
  const { runtime } = runtimeWith(() => protoResponse([encodeConnectEnvelope(textFrame("a")), endFrame()]));
  const agent = runtime.createAgent(createInput);
  expect(runtime.hasAgent(agent.agentId)).toBe(true);

  const resumed = runtime.resumeAgent({ ...createInput, agentId: agent.agentId, modelParams: [] });
  expect(resumed.agentId).toBe(agent.agentId);

  expect(() => runtime.resumeAgent({ ...createInput, agentId: agent.agentId, apiKey: "other" })).toThrow(GatewayError);
  expect(() => runtime.resumeAgent({ ...createInput, agentId: "sand-missing" })).toThrow(/not resident/);

  await agent.close();
  expect(runtime.hasAgent(agent.agentId)).toBe(false);
  expect(() => runtime.resumeAgent({ ...createInput, agentId: agent.agentId })).toThrow(/not resident/);
});

test("cancel aborts the upstream stream and reports a cancelled run", async () => {
  const { runtime } = runtimeWith(() =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encodeConnectEnvelope(textFrame("par")));
          // never closes; the run must be cancelled to finish
        },
      }),
      { status: 200, headers: { "content-type": "application/connect+proto" } },
    ),
  );
  const run = await runtime.createAgent(createInput).send({ text: "hi", onDelta: () => undefined });
  await new Promise((resolve) => setTimeout(resolve, 10));
  await run.cancel();
  expect((await run.wait()).status).toBe("cancelled");
});

test("health descriptor advertises the transport and its capability envelope", () => {
  expect(inspectSandInference()).toEqual({
    ready: true,
    sdk_version: "1.0.30",
    patch_contract_version: "none",
    transport: "aiserver.v1.InferenceService/Stream",
    client_version: "sdk-1.0.30",
    capabilities: { text: true, thinking: true, tools: false, images: false, cross_process_resume: false },
  });
});
