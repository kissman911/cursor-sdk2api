import { randomUUID } from "node:crypto";
import { ExchangeError, exchangeApiKey } from "../account/cursor-dashboard.js";
import {
  authenticationError,
  forbiddenError,
  GatewayError,
  rateLimited,
  redactSecrets,
  upstreamError,
} from "../errors.js";
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
  type SandInferenceUsage,
  type SandMessage,
} from "./sand-inference-codec.js";
import type {
  CreateAgentInput,
  ResumeAgentInput,
  SdkAgent,
  SdkRun,
  SdkRunResult,
  SdkSendInput,
  SdkStreamEvent,
  SdkUsage,
} from "./port.js";
import type { SandLoaderHealth } from "./sand-loader.js";
import { SAND_SDK_VERSION as SDK_VERSION } from "./sand-patch-contract.js";

export const SAND_INFERENCE_TRANSPORT = "aiserver.v1.InferenceService/Stream";
export const SAND_DEFAULT_BASE_URL = "https://api2.cursor.sh";
/**
 * Cursor gates `sand` traffic by client version. The SDK-style token is the
 * one the backend currently accepts for API-key-exchanged sessions; bare
 * desktop versions (`3.18.9`) and the desktop rewrite's `0.18.0` both return
 * ERROR_OUTDATED_CLIENT.
 */
export const SAND_CLIENT_VERSION = `sdk-${SDK_VERSION}`;
const SAND_DEFAULT_MAX_MODE = true;
const SAND_DEFAULT_PARAMS: ReadonlyArray<{ id: string; value: string }> = [
  { id: "effort", value: "high" },
  { id: "fast", value: "true" },
];
const FIRST_BYTE_TIMEOUT_MS = 60_000;
const IDLE_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

/**
 * The inference transport has no local preconditions (no SDK clone, no patch
 * hashes); readiness is decided per account by the Grok Bot grant check that
 * runs before every Sand run.
 */
export function inspectSandInference(clientVersion: string = SAND_CLIENT_VERSION): SandLoaderHealth {
  return {
    ready: true,
    sdk_version: SDK_VERSION,
    patch_contract_version: "none",
    transport: SAND_INFERENCE_TRANSPORT,
    client_version: clientVersion,
    capabilities: { text: true, thinking: true, tools: false, images: false, cross_process_resume: false },
  };
}

export interface SandInferenceRuntimeOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  clientVersion?: string;
  /** Test seam: bypass the real API-key exchange. */
  exchange?: (apiKey: string) => Promise<string>;
  now?: () => number;
}

export interface SandTranscriptMessage {
  role: "system" | "user" | "assistant";
  text: string;
}

interface SandAgentState {
  agentId: string;
  apiKey: string;
  modelId: string;
  modelParams: Array<{ id: string; value: string }>;
  conversationId: string;
  history: SandMessage[];
  accessToken?: string;
  closed: boolean;
}

/**
 * Turn the flattened prompt the coordinator already produces into the role
 * sequence InferenceService expects. The gateway sends one user turn per
 * `send()`, so the prompt text becomes the trailing user message; all prior
 * turns of this Agent are replayed from in-memory history.
 */
export function toSandRole(role: SandTranscriptMessage["role"]): SandMessage["role"] {
  if (role === "system") return SAND_ROLE_SYSTEM;
  if (role === "assistant") return SAND_ROLE_ASSISTANT;
  return SAND_ROLE_USER;
}

function mergeParams(
  requested: Array<{ id: string; value: string }> | undefined,
): Array<{ id: string; value: string }> {
  const merged = new Map<string, string>();
  for (const param of SAND_DEFAULT_PARAMS) merged.set(param.id, param.value);
  for (const param of requested ?? []) {
    if (param?.id) merged.set(param.id, String(param.value ?? ""));
  }
  return [...merged.entries()].map(([id, value]) => ({ id, value }));
}

function mapUsage(usage: SandInferenceUsage | undefined): SdkUsage | undefined {
  if (!usage) return undefined;
  if (typeof usage.inputTokens !== "number" || typeof usage.outputTokens !== "number") return undefined;
  const mapped: SdkUsage = { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
  if (typeof usage.totalTokens === "number") mapped.totalTokens = usage.totalTokens;
  return mapped;
}

function classifyHttpFailure(status: number, bodyText: string): GatewayError {
  const detail = redactSecrets(bodyText.trim().slice(0, 300));
  if (status === 401) return authenticationError(`Sand inference rejected the access token${detail ? `: ${detail}` : ""}`);
  if (status === 403) return forbiddenError(`Sand inference forbidden${detail ? `: ${detail}` : ""}`);
  if (status === 429) return rateLimited(`Sand inference rate limited${detail ? `: ${detail}` : ""}`);
  return upstreamError(`Sand inference HTTP ${status}${detail ? `: ${detail}` : ""}`, status >= 500 ? 502 : status);
}

function classifyEndStreamFailure(message: string, code: string | undefined): GatewayError {
  const text = redactSecrets(message);
  if (/unauthenticated|invalid.*token|ERROR_NOT_LOGGED_IN/i.test(`${code} ${text}`)) return authenticationError(text);
  if (/resource_exhausted|rate.?limit|ERROR_RATE_LIMITED|ERROR_USAGE_LIMIT|usage limit/i.test(`${code} ${text}`)) return rateLimited(text);
  if (/permission_denied|ERROR_OUTDATED_CLIENT|not allowed|forbidden/i.test(`${code} ${text}`)) return forbiddenError(text);
  return upstreamError(text);
}

type Delta = { type: "text-delta"; text: string } | { type: "thinking-delta"; text: string };

export class SandInferenceRuntime {
  private readonly baseUrl: string;
  private readonly request: typeof globalThis.fetch;
  private readonly clientVersion: string;
  private readonly exchange: (apiKey: string) => Promise<string>;
  private readonly agents = new Map<string, SandAgentState>();

  constructor(options: SandInferenceRuntimeOptions = {}) {
    this.baseUrl = (options.baseUrl ?? SAND_DEFAULT_BASE_URL).replace(/\/$/, "");
    this.request = options.fetch ?? globalThis.fetch;
    this.clientVersion = options.clientVersion ?? SAND_CLIENT_VERSION;
    this.exchange = options.exchange ?? ((apiKey) => exchangeApiKey(apiKey, this.baseUrl, this.request));
  }

  /** Agents are process-local. A missing id means the coordinator must cold-rebuild. */
  hasAgent(agentId: string): boolean {
    return this.agents.has(agentId) && !this.agents.get(agentId)!.closed;
  }

  createAgent(input: CreateAgentInput): SdkAgent {
    const state: SandAgentState = {
      agentId: `sand-${randomUUID()}`,
      apiKey: input.apiKey,
      modelId: input.modelId,
      modelParams: mergeParams(input.modelParams),
      conversationId: randomUUID(),
      history: [],
      closed: false,
    };
    this.agents.set(state.agentId, state);
    return this.bind(state);
  }

  resumeAgent(input: ResumeAgentInput): SdkAgent {
    const state = this.agents.get(input.agentId);
    if (!state || state.closed) {
      throw upstreamError("Sand agent is not resident in this process; a full transcript is required to rebuild it", 409);
    }
    if (state.apiKey !== input.apiKey) {
      throw forbiddenError("Sand agent belongs to a different credential");
    }
    state.modelId = input.modelId;
    state.modelParams = mergeParams(input.modelParams);
    return this.bind(state);
  }

  private bind(state: SandAgentState): SdkAgent {
    return {
      agentId: state.agentId,
      send: (sendInput) => this.send(state, sendInput),
      close: () => {
        state.closed = true;
        this.agents.delete(state.agentId);
      },
    };
  }

  private async token(state: SandAgentState, refresh: boolean): Promise<string> {
    if (!refresh && state.accessToken) return state.accessToken;
    try {
      state.accessToken = await this.exchange(state.apiKey);
    } catch (error) {
      if (error instanceof ExchangeError && (error.status === 401 || error.status === 403)) {
        throw authenticationError("Cursor rejected the User API Key during token exchange");
      }
      throw upstreamError(`Cursor API key exchange failed${error instanceof Error && error.message ? `: ${redactSecrets(error.message)}` : ""}`);
    }
    return state.accessToken;
  }

  private headers(accessToken: string): Record<string, string> {
    return {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/connect+proto",
      "connect-protocol-version": "1",
      "x-cursor-client-type": "sand",
      "x-cursor-client-version": this.clientVersion,
      "x-sand-box-namespace": "prod",
      "x-ghost-mode": "true",
      "x-request-id": randomUUID(),
      "accept-encoding": "identity",
      "user-agent": "connect-es/1.6.1",
    };
  }

  private async open(state: SandAgentState, body: Uint8Array, signal: AbortSignal): Promise<Response> {
    let token = await this.token(state, false);
    let response = await this.request(`${this.baseUrl}/${SAND_INFERENCE_TRANSPORT}`, {
      method: "POST",
      redirect: "error",
      headers: this.headers(token),
      body,
      signal,
    });
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      token = await this.token(state, true);
      response = await this.request(`${this.baseUrl}/${SAND_INFERENCE_TRANSPORT}`, {
        method: "POST",
        redirect: "error",
        headers: this.headers(token),
        body,
        signal,
      });
    }
    return response;
  }

  private async send(state: SandAgentState, sendInput: SdkSendInput): Promise<SdkRun> {
    if (state.closed) throw upstreamError("Sand agent is closed", 409);
    const userText = sendInput.text.trim() || " ";
    const messages: SandMessage[] = [...state.history, { role: SAND_ROLE_USER, text: userText }];
    const payload = encodeInferenceStreamRequest({
      messages,
      modelId: state.modelId,
      maxMode: SAND_DEFAULT_MAX_MODE,
      params: state.modelParams,
      conversationId: state.conversationId,
    });
    const body = encodeConnectEnvelope(payload);
    const controller = new AbortController();
    const runId = `sandrun-${randomUUID()}`;
    const requestId = randomUUID();

    const deltaSink = async (delta: Delta) => {
      await sendInput.onDelta?.(delta);
      await sendInput.onEvent?.(delta);
    };
    const hasDeltaSink = Boolean(sendInput.onDelta || sendInput.onEvent);

    // Fail fast on transport-level rejections so the coordinator can still
    // fail over before any semantic output is committed.
    const firstByteTimer = setTimeout(() => controller.abort(new Error("first byte timeout")), FIRST_BYTE_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.open(state, body, controller.signal);
    } catch (error) {
      clearTimeout(firstByteTimer);
      if (error instanceof GatewayError) throw error;
      throw upstreamError(`Sand inference request failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
    }
    if (!response.ok) {
      clearTimeout(firstByteTimer);
      const text = await response.text().catch(() => "");
      throw classifyHttpFailure(response.status, text);
    }
    if (!response.body) {
      clearTimeout(firstByteTimer);
      throw upstreamError("Sand inference returned no body");
    }

    let text = "";
    let thinking = "";
    let usage: SdkUsage | undefined;
    let failure: GatewayError | undefined;
    let cancelled = false;
    const events: SdkStreamEvent[] = [];
    let eventWaiter: (() => void) | undefined;
    let streamDone = false;
    const wake = () => {
      const waiter = eventWaiter;
      eventWaiter = undefined;
      waiter?.();
    };
    const pushEvent = (event: SdkStreamEvent) => {
      events.push(event);
      wake();
    };
    pushEvent({ type: "status", status: "RUNNING" });

    const consume = (async () => {
      const reader = response.body!.getReader();
      // Abort must unblock a pending read() even when the fetch implementation
      // does not tear down the body on signal abort.
      const onAbort = () => void reader.cancel().catch(() => undefined);
      if (controller.signal.aborted) onAbort();
      else controller.signal.addEventListener("abort", onAbort, { once: true });
      const frames = new ConnectEnvelopeReader();
      let total = 0;
      let sawEndStream = false;
      let idleTimer: NodeJS.Timeout | undefined;
      const armIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => controller.abort(new Error("idle timeout")), IDLE_TIMEOUT_MS);
      };
      try {
        armIdle();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          clearTimeout(firstByteTimer);
          armIdle();
          total += value.byteLength;
          if (total > MAX_RESPONSE_BYTES) {
            throw upstreamError("Sand inference response exceeded the size limit");
          }
          for (const envelope of frames.push(value)) {
            if (envelope.flags & CONNECT_END_STREAM_FLAG) {
              sawEndStream = true;
              const end = decodeConnectEndStream(envelope.payload);
              if (end.error) {
                failure = classifyEndStreamFailure(describeConnectError(end), end.error.code);
              }
              continue;
            }
            const frame = decodeInferenceStreamResponse(envelope.payload);
            if (frame.error && !failure) failure = upstreamError(redactSecrets(frame.error));
            if (frame.usage) usage = mapUsage(frame.usage) ?? usage;
            if (frame.thinking) {
              thinking += frame.thinking;
              if (hasDeltaSink) await deltaSink({ type: "thinking-delta", text: frame.thinking });
              else pushEvent({ type: "thinking", text: frame.thinking });
            }
            if (frame.text) {
              text += frame.text;
              if (hasDeltaSink) await deltaSink({ type: "text-delta", text: frame.text });
              else pushEvent({ type: "assistant", text: frame.text });
            }
          }
        }
        if (cancelled) {
          // reader.cancel() resolves the pending read as done; report through wait()
        } else if (!sawEndStream && !failure && frames.pendingBytes > 0) {
          failure = upstreamError("Sand inference stream ended mid-frame");
        } else if (!sawEndStream && !failure && controller.signal.aborted) {
          failure = upstreamError(`Sand inference stream aborted: ${redactSecrets(String(controller.signal.reason ?? "timeout"))}`, 504);
        }
      } catch (error) {
        if (cancelled) {
          // cancellation is reported through wait()
        } else if (error instanceof GatewayError) {
          failure = error;
        } else if (controller.signal.aborted) {
          failure = upstreamError(`Sand inference stream aborted: ${redactSecrets(String(controller.signal.reason ?? "timeout"))}`, 504);
        } else {
          failure = upstreamError(`Sand inference stream failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
        }
      } finally {
        clearTimeout(firstByteTimer);
        if (idleTimer) clearTimeout(idleTimer);
        controller.signal.removeEventListener("abort", onAbort);
        try {
          reader.releaseLock();
        } catch {
          // a cancelled reader may already be released
        }
      }
      if (!failure && !cancelled) {
        if (usage) pushEvent({ type: "usage", usage });
        pushEvent({ type: "status", status: "FINISHED" });
        state.history.push({ role: SAND_ROLE_USER, text: userText });
        if (text) state.history.push({ role: SAND_ROLE_ASSISTANT, text });
        if (hasDeltaSink) {
          const turnEnded = usage ? ({ type: "turn-ended", usage } as const) : ({ type: "turn-ended" } as const);
          await sendInput.onDelta?.(turnEnded);
          await sendInput.onEvent?.(turnEnded);
        }
      } else if (failure) {
        pushEvent({ type: "status", status: "ERROR" });
      }
      streamDone = true;
      wake();
    })();

    let streamed = false;
    const run: SdkRun = {
      id: runId,
      requestId,
      get usage() {
        return usage;
      },
      stream(): AsyncIterable<SdkStreamEvent> {
        if (streamed) throw new Error("Sand run.stream() is single-consumer");
        streamed = true;
        return (async function* () {
          let index = 0;
          while (true) {
            while (index < events.length) yield events[index++]!;
            if (streamDone) return;
            await new Promise<void>((resolve) => {
              eventWaiter = resolve;
            });
          }
        })();
      },
      async wait(): Promise<SdkRunResult> {
        await consume;
        if (cancelled) return { id: runId, requestId, status: "cancelled", usage };
        if (failure) {
          return {
            id: runId,
            requestId,
            status: "error",
            error: { message: failure.message, code: failure.code },
            usage,
          };
        }
        return { id: runId, requestId, status: "finished", result: text, usage };
      },
      async cancel(): Promise<void> {
        cancelled = true;
        controller.abort(new Error("cancelled"));
        await consume.catch(() => undefined);
      },
    };
    return run;
  }
}
