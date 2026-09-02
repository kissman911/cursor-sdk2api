/**
 * Wire codec for `aiserver.v1.InferenceService/Stream`, the transport Cursor
 * bills against Grok Bot (Sand) quota.
 *
 * The schema is not published. The field numbers below were confirmed against
 * live responses (2026-09-02) and match the desktop-client rewrite shipped by
 * SandClaimer's `sand_rpc.js`. Only the fields the gateway needs are decoded;
 * everything else is skipped by wire type so unknown additions do not break us.
 *
 * InferenceStreamRequest
 *   1  repeated Message { 1: role (1 user, 2 assistant, 4 system), 2: text }
 *   7  RequestedModel { 1: modelId, 2: maxMode, 3: repeated Param { 1: id, 2: value } }
 *   8  conversationId
 *
 * InferenceStreamResponse (one per Connect frame)
 *   1  TextPart     { 1: text, 2: final }
 *   3  Usage        { 1: inputTokens, 2: outputTokens, 3: totalTokens }
 *   5  Usage/limits { 1: inputTokens, 2: outputTokens, 5: contextWindow }
 *   8  Error        { 1: message }
 *   9  ThinkingPart { 1: text (opaque/encrypted when 2 is set), 2: redactedPayload }
 */

export const SAND_ROLE_USER = 1;
export const SAND_ROLE_ASSISTANT = 2;
export const SAND_ROLE_SYSTEM = 4;

export type SandRole = typeof SAND_ROLE_USER | typeof SAND_ROLE_ASSISTANT | typeof SAND_ROLE_SYSTEM;

export interface SandMessage {
  role: SandRole;
  text: string;
}

export interface SandInferenceRequest {
  messages: SandMessage[];
  modelId: string;
  maxMode: boolean;
  params: Array<{ id: string; value: string }>;
  conversationId?: string;
}

export interface SandInferenceUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface SandInferenceFrame {
  text?: string;
  thinking?: string;
  final?: boolean;
  error?: string;
  usage?: SandInferenceUsage;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");

function varint(value: number): Uint8Array {
  const out: number[] = [];
  let n = value >>> 0;
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return Uint8Array.from(out);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let size = 0;
  for (const chunk of chunks) size += chunk.length;
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function tag(field: number, wireType: number): Uint8Array {
  return varint((field << 3) | wireType);
}

function stringField(field: number, value: string): Uint8Array {
  const bytes = encoder.encode(value);
  return concat([tag(field, 2), varint(bytes.length), bytes]);
}

function messageField(field: number, inner: Uint8Array): Uint8Array {
  return concat([tag(field, 2), varint(inner.length), inner]);
}

function varintField(field: number, value: number): Uint8Array {
  if (!value) return new Uint8Array(0);
  return concat([tag(field, 0), varint(value)]);
}

function boolField(field: number, value: boolean): Uint8Array {
  return value ? concat([tag(field, 0), Uint8Array.from([1])]) : new Uint8Array(0);
}

export function encodeInferenceStreamRequest(request: SandInferenceRequest): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const message of request.messages) {
    parts.push(messageField(1, concat([varintField(1, message.role), stringField(2, message.text)])));
  }
  const model: Uint8Array[] = [stringField(1, request.modelId), boolField(2, request.maxMode)];
  for (const param of request.params) {
    if (!param.id) continue;
    model.push(messageField(3, concat([stringField(1, param.id), stringField(2, String(param.value ?? ""))])));
  }
  parts.push(messageField(7, concat(model)));
  if (request.conversationId) parts.push(stringField(8, request.conversationId));
  return concat(parts);
}

interface Cursor {
  offset: number;
}

function readVarint(bytes: Uint8Array, cursor: Cursor): number {
  let result = 0;
  let shift = 0;
  while (cursor.offset < bytes.length) {
    const byte = bytes[cursor.offset++]!;
    if (shift < 32) result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return result >>> 0;
    shift += 7;
    if (shift > 63) break;
  }
  throw new Error("Truncated protobuf varint");
}

type Field =
  | { field: number; wireType: 0; value: number }
  | { field: number; wireType: 2; bytes: Uint8Array };

function* fields(bytes: Uint8Array): Generator<Field> {
  const cursor: Cursor = { offset: 0 };
  while (cursor.offset < bytes.length) {
    const key = readVarint(bytes, cursor);
    const field = key >>> 3;
    const wireType = key & 0x7;
    switch (wireType) {
      case 0:
        yield { field, wireType: 0, value: readVarint(bytes, cursor) };
        break;
      case 1:
        cursor.offset += 8;
        break;
      case 5:
        cursor.offset += 4;
        break;
      case 2: {
        const length = readVarint(bytes, cursor);
        if (cursor.offset + length > bytes.length) throw new Error("Truncated protobuf length-delimited field");
        yield { field, wireType: 2, bytes: bytes.subarray(cursor.offset, cursor.offset + length) };
        cursor.offset += length;
        break;
      }
      default:
        throw new Error(`Unsupported protobuf wire type ${wireType}`);
    }
  }
}

function decodePart(bytes: Uint8Array): { text?: string; final?: boolean; redacted?: boolean } {
  const part: { text?: string; final?: boolean; redacted?: boolean } = {};
  for (const entry of fields(bytes)) {
    if (entry.field === 1 && entry.wireType === 2) part.text = decoder.decode(entry.bytes);
    else if (entry.field === 2 && entry.wireType === 0) part.final = entry.value !== 0;
    else if (entry.field === 2 && entry.wireType === 2) part.redacted = true;
  }
  return part;
}

function decodeUsage(bytes: Uint8Array): SandInferenceUsage {
  const usage: SandInferenceUsage = {};
  for (const entry of fields(bytes)) {
    if (entry.wireType !== 0) continue;
    if (entry.field === 1) usage.inputTokens = entry.value;
    else if (entry.field === 2) usage.outputTokens = entry.value;
    else if (entry.field === 3) usage.totalTokens = entry.value;
  }
  return usage;
}

function decodeErrorMessage(bytes: Uint8Array): string {
  for (const entry of fields(bytes)) {
    if (entry.field === 1 && entry.wireType === 2) return decoder.decode(entry.bytes);
  }
  return "";
}

export function decodeInferenceStreamResponse(bytes: Uint8Array): SandInferenceFrame {
  const frame: SandInferenceFrame = {};
  for (const entry of fields(bytes)) {
    if (entry.wireType !== 2) continue;
    if (entry.field === 1) {
      const part = decodePart(entry.bytes);
      if (part.text) frame.text = (frame.text ?? "") + part.text;
      if (part.final) frame.final = true;
    } else if (entry.field === 9) {
      const part = decodePart(entry.bytes);
      // Field 9 with a redacted payload carries encrypted reasoning state, not
      // human-readable thinking. Only forward plain text deltas.
      if (part.text && !part.redacted) frame.thinking = (frame.thinking ?? "") + part.text;
    } else if (entry.field === 8) {
      frame.error = decodeErrorMessage(entry.bytes) || "inference error";
    } else if (entry.field === 3) {
      frame.usage = { ...frame.usage, ...decodeUsage(entry.bytes) };
    }
  }
  return frame;
}

/** Connect streaming envelope: 1 byte flags + 4 byte big-endian length + payload. */
export const CONNECT_END_STREAM_FLAG = 0x02;

export function encodeConnectEnvelope(payload: Uint8Array, flags = 0): Uint8Array {
  const header = new Uint8Array(5);
  header[0] = flags;
  new DataView(header.buffer).setUint32(1, payload.length, false);
  return concat([header, payload]);
}

export interface ConnectEnvelope {
  flags: number;
  payload: Uint8Array;
}

/**
 * Incremental Connect envelope parser. Feed arbitrary byte chunks; complete
 * envelopes are yielded as soon as they are available.
 */
export class ConnectEnvelopeReader {
  private buffer: Uint8Array = new Uint8Array(0);

  constructor(private readonly maxFrameBytes = 16 * 1024 * 1024) {}

  push(chunk: Uint8Array): ConnectEnvelope[] {
    this.buffer = this.buffer.length === 0 ? chunk : concat([this.buffer, chunk]);
    const out: ConnectEnvelope[] = [];
    let offset = 0;
    while (this.buffer.length - offset >= 5) {
      const flags = this.buffer[offset]!;
      const length = new DataView(this.buffer.buffer, this.buffer.byteOffset + offset + 1, 4).getUint32(0, false);
      if (length > this.maxFrameBytes) throw new Error(`Connect frame of ${length} bytes exceeds the limit`);
      if (this.buffer.length - offset - 5 < length) break;
      out.push({ flags, payload: this.buffer.subarray(offset + 5, offset + 5 + length) });
      offset += 5 + length;
    }
    if (offset > 0) this.buffer = this.buffer.slice(offset);
    return out;
  }

  get pendingBytes(): number {
    return this.buffer.length;
  }
}

export interface ConnectEndStream {
  error?: { code?: string; message?: string; details?: unknown[] };
  metadata?: Record<string, unknown>;
}

export function decodeConnectEndStream(payload: Uint8Array): ConnectEndStream {
  const text = decoder.decode(payload).trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as ConnectEndStream) : {};
  } catch {
    return { error: { code: "unknown", message: text.slice(0, 200) } };
  }
}

/** Surface the human-readable upstream reason for a Connect end-stream error. */
export function describeConnectError(end: ConnectEndStream): string {
  const error = end.error;
  if (!error) return "";
  const code = error.code ?? "unknown";
  const details = Array.isArray(error.details) ? error.details : [];
  for (const detail of details) {
    if (!detail || typeof detail !== "object") continue;
    const debug = (detail as { debug?: { error?: string; details?: { title?: string; detail?: string } } }).debug;
    if (!debug) continue;
    const parts = [debug.error, debug.details?.title, debug.details?.detail].filter(Boolean);
    if (parts.length > 0) return `[${code}] ${parts.join(": ")}`;
  }
  return `[${code}] ${error.message ?? "upstream error"}`;
}
