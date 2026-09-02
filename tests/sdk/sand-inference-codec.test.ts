import { expect, test } from "vitest";
import {
  CONNECT_END_STREAM_FLAG,
  ConnectEnvelopeReader,
  decodeConnectEndStream,
  decodeInferenceStreamResponse,
  describeConnectError,
  encodeConnectEnvelope,
  encodeInferenceStreamRequest,
  SAND_ROLE_ASSISTANT,
  SAND_ROLE_SYSTEM,
  SAND_ROLE_USER,
} from "../../src/sdk/sand-inference-codec.js";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const fromHex = (text: string) => Uint8Array.from(Buffer.from(text, "hex"));

// Reference bytes produced by SandClaimer's desktop rewrite (`sand_rpc.js`
// `__sandTest.enc`) for the same logical request. Byte-for-byte parity keeps
// the gateway on the wire shape Cursor's backend already accepts.
const REFERENCE_REQUEST_HEX =
  "0a0d0804120942652074657273652e0a060801120268690a090802120568656c6c6f0a0f0801120b5265706c793a20706f6e67" +
  "3a2a0a0867726f6b2d342e3610011a0e0a066566666f72741204686967681a0c0a0466617374120474727565" +
  "4208636f6e762d313233";

test("request encoding matches the desktop rewrite byte-for-byte", () => {
  const bytes = encodeInferenceStreamRequest({
    messages: [
      { role: SAND_ROLE_SYSTEM, text: "Be terse." },
      { role: SAND_ROLE_USER, text: "hi" },
      { role: SAND_ROLE_ASSISTANT, text: "hello" },
      { role: SAND_ROLE_USER, text: "Reply: pong" },
    ],
    modelId: "grok-4.6",
    maxMode: true,
    params: [
      { id: "effort", value: "high" },
      { id: "fast", value: "true" },
    ],
    conversationId: "conv-123",
  });
  expect(hex(bytes)).toBe(REFERENCE_REQUEST_HEX);
});

test("request encoding omits maxMode=false, empty conversation ids, and params without ids", () => {
  const bytes = encodeInferenceStreamRequest({
    messages: [{ role: SAND_ROLE_USER, text: "x" }],
    modelId: "m",
    maxMode: false,
    params: [{ id: "", value: "ignored" }],
  });
  // 0a05 { 0801 1201 78 } | 3a03 { 0a01 6d }
  expect(hex(bytes)).toBe("0a0508011201783a030a016d");
});

test("response decoding extracts text, thinking, error, and usage frames", () => {
  // field 1 { field 1 "pong" } -> 0a 06 0a 04 70 6f 6e 67
  expect(decodeInferenceStreamResponse(fromHex("0a060a04706f6e67"))).toEqual({ text: "pong" });
  // final marker: field 1 { field 2 = 1 }
  expect(decodeInferenceStreamResponse(fromHex("0a021001"))).toEqual({ final: true });
  // thinking: field 9 { field 1 "hmm" } -> 4a 05 0a 03 68 6d 6d
  expect(decodeInferenceStreamResponse(fromHex("4a050a03686d6d"))).toEqual({ thinking: "hmm" });
  // redacted thinking (field 9 with an opaque field 2 payload) is not forwarded as text
  expect(decodeInferenceStreamResponse(fromHex("4a0a0a036f70611203616263"))).toEqual({});
  // error: field 8 { field 1 "boom" } -> 42 06 0a 04 62 6f 6f 6d
  expect(decodeInferenceStreamResponse(fromHex("42060a04626f6f6d"))).toEqual({ error: "boom" });
  // usage: field 3 { 1:24, 2:111, 3:135 } -> 1a 07 08 18 10 6f 18 87 01
  expect(decodeInferenceStreamResponse(fromHex("1a070818106f188701"))).toEqual({
    usage: { inputTokens: 24, outputTokens: 111, totalTokens: 135 },
  });
});

test("response decoding skips unknown fields and wire types without throwing", () => {
  // field 4 (unknown message), fixed64 field 20, fixed32 field 21, then a real text part
  const bytes = fromHex("2203" + "0a0131" + "a1010000000000000000" + "ad0100000000" + "0a060a04706f6e67");
  expect(decodeInferenceStreamResponse(bytes)).toEqual({ text: "pong" });
});

test("connect envelopes round-trip through the incremental reader across chunk boundaries", () => {
  const first = encodeConnectEnvelope(fromHex("0a060a04706f6e67"));
  const end = encodeConnectEnvelope(new TextEncoder().encode('{"metadata":{}}'), CONNECT_END_STREAM_FLAG);
  const stream = new Uint8Array(first.length + end.length);
  stream.set(first, 0);
  stream.set(end, first.length);

  const reader = new ConnectEnvelopeReader();
  const decoded: Array<{ flags: number; text?: string; end?: boolean }> = [];
  for (let offset = 0; offset < stream.length; offset += 3) {
    for (const envelope of reader.push(stream.subarray(offset, Math.min(offset + 3, stream.length)))) {
      if (envelope.flags & CONNECT_END_STREAM_FLAG) decoded.push({ flags: envelope.flags, end: true });
      else decoded.push({ flags: envelope.flags, text: decodeInferenceStreamResponse(envelope.payload).text });
    }
  }
  expect(decoded).toEqual([
    { flags: 0, text: "pong" },
    { flags: CONNECT_END_STREAM_FLAG, end: true },
  ]);
  expect(reader.pendingBytes).toBe(0);
});

test("connect envelope reader refuses oversized frames", () => {
  const reader = new ConnectEnvelopeReader(16);
  const header = new Uint8Array(5);
  new DataView(header.buffer).setUint32(1, 1024, false);
  expect(() => reader.push(header)).toThrow(/exceeds the limit/);
});

test("end-stream errors surface the Cursor debug reason", () => {
  const payload = new TextEncoder().encode(
    JSON.stringify({
      error: {
        code: "permission_denied",
        message: "Error",
        details: [
          {
            type: "aiserver.v1.ErrorDetails",
            debug: {
              error: "ERROR_OUTDATED_CLIENT",
              details: { title: "Outdated Client Error", detail: "Please update." },
            },
          },
        ],
      },
    }),
  );
  const end = decodeConnectEndStream(payload);
  expect(describeConnectError(end)).toBe(
    "[permission_denied] ERROR_OUTDATED_CLIENT: Outdated Client Error: Please update.",
  );
  expect(describeConnectError(decodeConnectEndStream(new TextEncoder().encode("{}")))).toBe("");
  expect(describeConnectError(decodeConnectEndStream(new TextEncoder().encode("not json")))).toMatch(/^\[unknown\] not json/);
});
