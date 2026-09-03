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

test("end-stream errors before any content are thrown from send() as typed gateway failures", async () => {
  const { runtime, calls } = runtimeWith(() =>
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
  await expect(agent.send({ text: "hi", onDelta: () => undefined })).rejects.toMatchObject({
    code: "forbidden",
    message: expect.stringMatching(/ERROR_OUTDATED_CLIENT/),
  });
  // History is untouched: the next send carries only the new user turn.
  expect(calls).toHaveLength(1);
});

test("pre-content in-band errors and quota rejections are thrown from send() so the pool can fail over", async () => {
  const inBand = runtimeWith(() => protoResponse([encodeConnectEnvelope(errorFrame("model exploded")), endFrame()]));
  await expect(inBand.runtime.createAgent(createInput).send({ text: "hi", onDelta: () => undefined })).rejects.toMatchObject({
    code: "cursor_upstream_error",
    message: "model exploded",
  });

  const limited = runtimeWith(() =>
    protoResponse([
      endFrame({
        error: {
          code: "resource_exhausted",
          message: "ERROR_GPT_4_VISION_PREVIEW_RATE_LIMIT: You've reached your Grok Bot usage limit. It resets in 7 days.",
        },
      }),
    ]),
  );
  await expect(limited.runtime.createAgent(createInput).send({ text: "hi", onDelta: () => undefined })).rejects.toMatchObject({
    code: "rate_limited",
    message: expect.stringMatching(/Grok Bot usage limit/),
  });
});

test("errors after content has started are reported through the run, not thrown from send()", async () => {
  const { runtime } = runtimeWith(() =>
    protoResponse([
      encodeConnectEnvelope(textFrame("partial")),
      endFrame({ error: { code: "internal", message: "stream broke" } }),
    ]),
  );
  const deltas: SdkDeltaUpdate[] = [];
  const run = await runtime.createAgent(createInput).send({ text: "hi", onDelta: (update) => void deltas.push(update) });
  const result = await run.wait();
  expect(result.status).toBe("error");
  expect(result.error?.message).toMatch(/stream broke/);
  expect(deltas).toEqual([{ type: "text-delta", text: "partial" }]);
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

function decodeMessages(body: Uint8Array): Array<{ role: number; text: string }> {
  const [envelope] = new ConnectEnvelopeReader().push(body);
  const bytes = envelope!.payload;
  const out: Array<{ role: number; text: string }> = [];
  let offset = 0;
  const varint = () => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = bytes[offset++]!;
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result >>> 0;
      shift += 7;
    }
  };
  while (offset < bytes.length) {
    const key = varint();
    const field = key >>> 3;
    const wire = key & 7;
    if (wire !== 2) {
      if (wire === 0) varint();
      continue;
    }
    const length = varint();
    const inner = bytes.subarray(offset, offset + length);
    offset += length;
    if (field !== 1) continue;
    let role = 0;
    let text = "";
    let cursor = 0;
    while (cursor < inner.length) {
      let k = 0;
      let s = 0;
      let b: number;
      do {
        b = inner[cursor++]!;
        k |= (b & 0x7f) << s;
        s += 7;
      } while (b & 0x80);
      const f = k >>> 3;
      if ((k & 7) === 0) {
        let v = 0;
        let vs = 0;
        do {
          b = inner[cursor++]!;
          v |= (b & 0x7f) << vs;
          vs += 7;
        } while (b & 0x80);
        if (f === 1) role = v;
      } else {
        let l = 0;
        let ls = 0;
        do {
          b = inner[cursor++]!;
          l |= (b & 0x7f) << ls;
          ls += 7;
        } while (b & 0x80);
        if (f === 2) text = new TextDecoder().decode(inner.subarray(cursor, cursor + l));
        cursor += l;
      }
    }
    out.push({ role, text });
  }
  return out;
}

const toolCall = (name: string, input: Record<string, unknown>) =>
  `<sand:tool_call>${JSON.stringify({ name, input })}</sand:tool_call>`;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test("tool call blocks become customTool executions, results flow back, and only prose reaches the client", async () => {
  const { runtime, calls } = runtimeWith((_, index) => {
    if (index === 0) {
      return protoResponse([
        encodeConnectEnvelope(thinkingFrame("plan")),
        encodeConnectEnvelope(textFrame("Checking memory.\n")),
        encodeConnectEnvelope(textFrame("<sand:tool_")),
        encodeConnectEnvelope(textFrame(`call>${JSON.stringify({ name: "Bash", input: { command: "free -h" } })}</sand:tool_call>\n`)),
        encodeConnectEnvelope(textFrame(toolCall("Read", { file_path: "/tmp/MEMORY.md" }))),
        encodeConnectEnvelope(usageFrame()),
        endFrame(),
      ]);
    }
    return protoResponse([encodeConnectEnvelope(textFrame("RAM is fine.")), encodeConnectEnvelope(usageFrame()), endFrame()]);
  });
  const bash = deferred<string>();
  const read = deferred<string>();
  const executed: Array<{ name: string; args: Record<string, unknown>; id?: string }> = [];
  const customTools = {
    Bash: {
      description: "Run a command",
      inputSchema: { type: "object", properties: { command: { type: "string" } } },
      execute: (args: Record<string, unknown>, context: { toolCallId?: string }) => {
        executed.push({ name: "Bash", args, id: context.toolCallId });
        return bash.promise;
      },
    },
    Read: {
      execute: (args: Record<string, unknown>, context: { toolCallId?: string }) => {
        executed.push({ name: "Read", args, id: context.toolCallId });
        return read.promise.then((text) => ({ content: [{ type: "text" as const, text }] }));
      },
    },
  };
  const agent = runtime.createAgent({ ...createInput, customTools });
  const deltas: SdkDeltaUpdate[] = [];
  const run = await agent.send({ text: "Does memory need cleaning?", customTools, onDelta: (update) => void deltas.push(update) });

  // Both calls are handed over together, before any result exists.
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(executed.map((call) => call.name)).toEqual(["Bash", "Read"]);
  expect(executed[0]?.args).toEqual({ command: "free -h" });
  expect(executed[1]?.args).toEqual({ file_path: "/tmp/MEMORY.md" });
  expect(executed[0]?.id).toMatch(/^toolu_/);
  expect(executed[0]?.id).not.toBe(executed[1]?.id);
  expect(calls).toHaveLength(1);
  expect(deltas).toEqual([
    { type: "thinking-delta", text: "plan" },
    { type: "text-delta", text: "Checking memory.\n" },
  ]);

  bash.resolve("Mem: 62Gi total, 40Gi free");
  read.resolve("# memory notes");
  const result = await run.wait();
  expect(result.status).toBe("finished");
  expect(result.result).toBe("RAM is fine.");
  expect(result.usage).toEqual({ inputTokens: 48, outputTokens: 222, totalTokens: 270 });
  expect(deltas.slice(2)).toEqual([
    { type: "text-delta", text: "RAM is fine." },
    { type: "turn-ended", usage: { inputTokens: 48, outputTokens: 222, totalTokens: 270 } },
  ]);

  // Second round trip: protocol system message, the original turn, the raw assistant text, and tagged results.
  expect(calls).toHaveLength(2);
  const second = decodeMessages(calls[1]!.body);
  expect(second[0]?.role).toBe(4);
  expect(second[0]?.text).toContain("# Tool calling protocol");
  expect(second[0]?.text).toContain('"name": "Bash"');
  expect(second[1]).toEqual({ role: 1, text: "Does memory need cleaning?" });
  expect(second[2]?.role).toBe(2);
  expect(second[2]?.text).toContain("Checking memory.");
  expect(second[2]?.text).toContain(toolCall("Bash", { command: "free -h" }));
  expect(second[3]?.role).toBe(1);
  expect(second[3]?.text).toContain(`<sand:tool_result id="${executed[0]!.id}" name="Bash" is_error="false">\nMem: 62Gi total, 40Gi free\n</sand:tool_result>`);
  expect(second[3]?.text).toContain(`<sand:tool_result id="${executed[1]!.id}" name="Read" is_error="false">\n# memory notes\n</sand:tool_result>`);

  // The committed history carries the whole loop so a follow-up send() replays it.
  await (await agent.send({ text: "thanks", customTools, onDelta: () => undefined })).wait();
  const third = decodeMessages(calls[2]!.body);
  expect(third.map((message) => message.role)).toEqual([4, 1, 2, 1, 2, 1]);
  expect(third[4]?.text).toBe("RAM is fine.");
  expect(third[5]?.text).toBe("thanks");
});

test("without tools the request carries no protocol message and tags are ordinary text", async () => {
  const { runtime, calls } = runtimeWith(() =>
    protoResponse([encodeConnectEnvelope(textFrame("<sand:tool_call>literal</sand:tool_call>")), endFrame()]),
  );
  const run = await runtime.createAgent(createInput).send({ text: "hi", onDelta: () => undefined });
  expect((await run.wait()).result).toBe("<sand:tool_call>literal</sand:tool_call>");
  expect(decodeMessages(calls[0]!.body)).toEqual([{ role: 1, text: "hi" }]);
});

test("a step with only malformed calls is re-prompted with feedback, then surfaced as text", async () => {
  const bad = "<sand:tool_call>{not json}</sand:tool_call>";
  const { runtime, calls } = runtimeWith(() => protoResponse([encodeConnectEnvelope(textFrame(bad)), endFrame()]));
  const customTools = { Bash: { execute: () => "never" } };
  const deltas: SdkDeltaUpdate[] = [];
  const run = await runtime.createAgent({ ...createInput, customTools }).send({
    text: "go",
    customTools,
    onDelta: (update) => void deltas.push(update),
  });
  const result = await run.wait();
  expect(result.status).toBe("finished");
  // 1 attempt + 2 retries, each fed the parse error as a tool result.
  expect(calls).toHaveLength(3);
  const retry = decodeMessages(calls[1]!.body);
  expect(retry.at(-1)?.role).toBe(1);
  expect(retry.at(-1)?.text).toContain('id="malformed-1"');
  expect(retry.at(-1)?.text).toContain("not a valid JSON object");
  expect(result.result).toBe(bad);
  expect(deltas).toEqual([{ type: "text-delta", text: bad }, { type: "turn-ended" }]);
});

test("cancelling while a tool result is outstanding ends the run without another round trip", async () => {
  const { runtime, calls } = runtimeWith(() =>
    protoResponse([encodeConnectEnvelope(textFrame(toolCall("Bash", { command: "sleep" }))), endFrame()]),
  );
  const never = new Promise<string>(() => undefined);
  const customTools = { Bash: { execute: () => never } };
  const run = await runtime.createAgent({ ...createInput, customTools }).send({ text: "go", customTools, onDelta: () => undefined });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await run.cancel();
  expect((await run.wait()).status).toBe("cancelled");
  expect(calls).toHaveLength(1);
});

test("a rejected pending tool call fails the run instead of hanging it", async () => {
  const { runtime } = runtimeWith(() =>
    protoResponse([encodeConnectEnvelope(textFrame(toolCall("Bash", { command: "x" }))), endFrame()]),
  );
  const customTools = { Bash: { execute: () => Promise.reject(new Error("session closed")) } };
  const run = await runtime.createAgent({ ...createInput, customTools }).send({ text: "go", customTools, onDelta: () => undefined });
  const result = await run.wait();
  expect(result.status).toBe("error");
  expect(result.error?.message).toMatch(/tool execution was rejected: session closed/);
});

test("health descriptor advertises the transport and its capability envelope", () => {
  expect(inspectSandInference()).toEqual({
    ready: true,
    sdk_version: "1.0.30",
    patch_contract_version: "none",
    transport: "aiserver.v1.InferenceService/Stream",
    client_version: "sdk-1.0.30",
    capabilities: { text: true, thinking: true, tools: true, images: false, cross_process_resume: false },
  });
});
