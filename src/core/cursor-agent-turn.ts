import { digestJson, sha256Hex, stableStringify } from "../digest.js";
import { invalidRequest } from "../errors.js";
import {
  asBlocks,
  collectImages,
  TRAILING_SYSTEM_TEXT_MARKER,
  trailingSystemText,
} from "../protocols/anthropic/parse.js";
import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicTool,
  ParsedMessages,
} from "../protocols/anthropic/types.js";
import type { ToolChoicePolicy } from "../protocols/tool-choice.js";
import {
  normalizeModelParams,
  sessionPolicyFingerprintFromParsed,
} from "./session-policy.js";
import { DEFAULT_RUNTIME_PROFILE, type RuntimeProfile } from "./runtime-profile.js";

export const CURSOR_AGENT_TURN_VERSION = 1;
export const CURSOR_AGENT_ROUTE = "cursor-agent";

export interface CursorAgentTurn {
  version: number;
  sourceProtocol: string;
  stream: boolean;
  tenantScope: string;
  channelId: number;
  route: string;
  originalModel: string;
  effectiveModel: string;
  system: string;
  conversation: AnthropicMessage[];
  tools: AnthropicTool[];
  toolChoice: ToolChoicePolicy | null;
  currentTurn: {
    text: string;
    images: Array<{ data: string; mimeType: string }>;
  };
  continuationToolIds: string[];
  lineage: {
    requestDigest: string;
    parentAssistantAnchor: string;
    historyDigest: string;
    turnIndex: number;
    toolCatalogDigest: string;
    sessionPolicyFingerprint: string;
  };
}

export function effectiveCursorModel(
  model: string,
  modelParams: Array<{ id: string; value: string }>,
): string {
  return `${model}|${stableStringify(normalizeModelParams(modelParams))}`;
}

export function serializedContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const item = block as AnthropicContentBlock;
    if (item.type === "text" && typeof item.text === "string") {
      parts.push(item.text);
    } else if (item.type === "thinking" && typeof item.thinking === "string") {
      parts.push(item.thinking);
    } else if (item.type === "tool_use" && item.id && item.name) {
      parts.push(`TOOL_USE id=${item.id} name=${item.name} input=${JSON.stringify(item.input ?? {})}`);
    } else if (item.type === "tool_result" && item.tool_use_id) {
      parts.push(
        `TOOL_RESULT tool_use_id=${item.tool_use_id} is_error=${Boolean(item.is_error)} content=${JSON.stringify(stringifyUnknown(item.content))}`,
      );
    } else if (item.type === "image") {
      parts.push("IMAGE_ATTACHMENT");
    }
  }
  return parts.join("\n");
}

export function digestAssistantAnchor(content: unknown): string {
  return digestJson(canonicalContent(content));
}

function canonicalContent(content: unknown): unknown[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.map((value) => {
    if (!value || typeof value !== "object") return { type: "unknown" };
    const block = value as AnthropicContentBlock;
    if (block.type === "text") return { type: "text", text: block.text };
    if (block.type === "thinking") {
      return {
        type: "thinking",
        thinking: block.thinking,
        signature: block.signature ?? "",
      };
    }
    if (block.type === "tool_use") {
      return {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input ?? null,
        toolKind: block.tool_kind ?? "function",
        namespace: block.namespace ?? "",
      };
    }
    if (block.type === "tool_result") {
      return {
        type: "tool_result",
        toolUseId: block.tool_use_id,
        content: block.content ?? null,
        isError: Boolean(block.is_error),
      };
    }
    if (block.type === "image") {
      const source = block.source;
      return source.type === "base64"
        ? {
            type: "image",
            sourceType: "base64",
            mediaType: source.media_type,
            digest: sha256Hex(source.data),
          }
        : { type: "image", sourceType: "url", digest: sha256Hex(source.url) };
    }
    return { type: "unknown" };
  });
}

function advanceHistoryDigest(
  previous: string,
  role: AnthropicMessage["role"],
  contentDigest: string,
): string {
  return digestJson({ previous, role, contentDigest });
}

function historyDigestBeforeCurrentUser(
  system: string,
  conversation: AnthropicMessage[],
  userIndex: number,
): string {
  let digest = digestJson({ system });
  for (let index = 0; index < userIndex; index += 1) {
    const message = conversation[index];
    if (!message) continue;
    digest = advanceHistoryDigest(digest, message.role, digestAssistantAnchor(message.content));
  }
  return digest;
}

export function normalizeTools(tools: AnthropicTool[] | undefined): AnthropicTool[] {
  if (!Array.isArray(tools)) return [];
  const normalized: AnthropicTool[] = [];
  for (const tool of tools) {
    const name = String(tool?.name || "").trim();
    if (!name) continue;
    normalized.push({
      name,
      description: typeof tool.description === "string" ? tool.description : "",
      input_schema:
        tool.input_schema && typeof tool.input_schema === "object"
          ? tool.input_schema
          : { type: "object", properties: {} },
    });
  }
  return normalized;
}

export function digestToolCatalog(tools: AnthropicTool[] | undefined): string {
  return digestJson(normalizeTools(tools));
}

export function imageDigests(images: Array<{ data: string; mimeType: string }>): string[] {
  return images.map((image) => sha256Hex(`data:${image.mimeType}:${image.data}`));
}

export function textFromContent(content: string | AnthropicContentBlock[] | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is Extract<AnthropicContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export function currentTurnFromMessage(message: AnthropicMessage | undefined): {
  text: string;
  images: Array<{ data: string; mimeType: string }>;
} {
  if (!message) return { text: "", images: [] };
  const text =
    typeof message.content === "string"
      ? message.content.trim()
      : textFromContent(asBlocks(message.content)).trim();
  return {
    text,
    images: collectImages([message]),
  };
}

/**
 * The turn that is sent to the Agent: the last user message plus any
 * in-conversation `system` / `developer` messages that trail it, delivered
 * under a marker because the SDK has no mid-conversation system slot.
 */
function currentTurnFromConversation(
  conversation: AnthropicMessage[],
  userIndex: number,
): { text: string; images: Array<{ data: string; mimeType: string }> } {
  const current = currentTurnFromMessage(userIndex >= 0 ? conversation[userIndex] : undefined);
  if (userIndex < 0) return current;
  const trailing = trailingSystemText(conversation, userIndex);
  if (!trailing) return current;
  const attached = `${TRAILING_SYSTEM_TEXT_MARKER}\n${trailing}`;
  return {
    text: current.text ? `${current.text}\n\n${attached}` : attached,
    images: current.images,
  };
}

function lastUserIndex(conversation: AnthropicMessage[]): number {
  for (let index = conversation.length - 1; index >= 0; index -= 1) {
    if (conversation[index]?.role === "user") return index;
  }
  return -1;
}

function parentAssistantMessage(
  conversation: AnthropicMessage[],
  userIndex: number,
): AnthropicMessage | null {
  for (let index = userIndex - 1; index >= 0; index -= 1) {
    if (conversation[index]?.role === "assistant") return conversation[index] ?? null;
  }
  return null;
}

export function digestCursorAgentTurnRequest(turn: CursorAgentTurn): string {
  return digestJson({
    effectiveModel: turn.effectiveModel,
    currentTurnText: turn.currentTurn.text,
    currentTurnImages: imageDigests(turn.currentTurn.images),
    toolCatalogDigest: turn.lineage.toolCatalogDigest,
    toolChoice: turn.toolChoice,
    parentAssistantAnchor: turn.lineage.parentAssistantAnchor,
    historyDigest: turn.lineage.historyDigest,
    sessionPolicyFingerprint: turn.lineage.sessionPolicyFingerprint,
    turnIndex: turn.lineage.turnIndex,
  });
}

export function cursorAgentTurnLineageKey(turn: CursorAgentTurn): string {
  return digestJson({
    tenantScope: turn.tenantScope,
    route: turn.route,
    channelId: turn.channelId,
    effectiveModel: turn.effectiveModel,
    parentAssistantAnchor: turn.lineage.parentAssistantAnchor,
    historyDigest: turn.lineage.historyDigest,
    turnIndex: turn.lineage.turnIndex,
    toolCatalogDigest: turn.lineage.toolCatalogDigest,
    sessionPolicyFingerprint: turn.lineage.sessionPolicyFingerprint,
  });
}

export function nextCursorAgentTurnLineageKey(turn: CursorAgentTurn, assistantAnchor: string): string {
  // Fold the current user turn and every message the client sent after it
  // (in-conversation system reminders) so the successor request, whose history
  // contains those same messages, still hashes to this key.
  const userIndex = lastUserIndex(turn.conversation);
  let historyAfterUser = turn.lineage.historyDigest;
  if (userIndex < 0) {
    historyAfterUser = advanceHistoryDigest(historyAfterUser, "user", digestAssistantAnchor(undefined));
  }
  for (let index = userIndex; userIndex >= 0 && index < turn.conversation.length; index += 1) {
    const message = turn.conversation[index]!;
    historyAfterUser = advanceHistoryDigest(
      historyAfterUser,
      message.role,
      digestAssistantAnchor(message.content),
    );
  }
  const historyAfterAssistant = advanceHistoryDigest(historyAfterUser, "assistant", assistantAnchor);
  return digestJson({
    tenantScope: turn.tenantScope,
    route: turn.route,
    channelId: turn.channelId,
    effectiveModel: turn.effectiveModel,
    parentAssistantAnchor: assistantAnchor,
    historyDigest: historyAfterAssistant,
    turnIndex: turn.lineage.turnIndex + 1,
    toolCatalogDigest: turn.lineage.toolCatalogDigest,
    sessionPolicyFingerprint: turn.lineage.sessionPolicyFingerprint,
  });
}

export function cursorAgentTurnFromParsed(
  parsed: ParsedMessages,
  extras: { tenantScope: string; sourceProtocol?: string; runtimeProfile?: RuntimeProfile } = { tenantScope: "" },
): CursorAgentTurn {
  const conversation = parsed.messages;
  const userIndex = lastUserIndex(conversation);
  const parent = userIndex >= 0 ? parentAssistantMessage(conversation, userIndex) : null;
  const tools = normalizeTools(parsed.tools);
  const currentTurn = currentTurnFromConversation(conversation, userIndex);
  const turnIndex = conversation.filter((message) => message.role === "user").length;
  const toolCatalogDigest = digestToolCatalog(tools);
  const turn: CursorAgentTurn = {
    version: CURSOR_AGENT_TURN_VERSION,
    sourceProtocol: extras.sourceProtocol || "messages",
    stream: parsed.stream,
    tenantScope: extras.tenantScope,
    channelId: 0,
    route: CURSOR_AGENT_ROUTE,
    originalModel: parsed.model,
    effectiveModel: effectiveCursorModel(parsed.model, parsed.modelParams),
    system: parsed.systemText,
    conversation,
    tools,
    toolChoice: parsed.toolChoice ?? null,
    currentTurn,
    continuationToolIds: (parsed.continuation ?? []).map((result) => result.toolUseId),
    lineage: {
      requestDigest: "",
      parentAssistantAnchor: parent ? digestAssistantAnchor(parent.content) : "",
      historyDigest: historyDigestBeforeCurrentUser(parsed.systemText, conversation, userIndex),
      turnIndex,
      toolCatalogDigest,
      sessionPolicyFingerprint: sessionPolicyFingerprintFromParsed(
        parsed,
        parsed.modelParams,
        extras.runtimeProfile ?? DEFAULT_RUNTIME_PROFILE,
      ),
    },
  };
  turn.lineage.requestDigest = digestCursorAgentTurnRequest(turn);
  return turn;
}

/**
 * Reject an ordinary (non tool_result) turn that cannot be delivered to a
 * Cursor Agent as a new user message. The turn being judged is the last user
 * message; in-conversation `system` / `developer` messages may trail it.
 *
 * - A transcript that ends on an assistant message asks for prefill
 *   continuation, which the SDK cannot do. Sending the previous user turn
 *   again would fork or duplicate the Agent's run, so it fails closed.
 * - An empty current user turn would reach the model as a blank message, which
 *   it sees as an "(omitted)" user turn and answers instead of continuing.
 * - A user turn that skips the assistant's open tool_use batch has no legal
 *   place to deliver results to; the pending batch must be answered with
 *   tool_result blocks, exactly as the upstream Anthropic API demands.
 */
export function assertOrdinaryTurnDeliverable(turn: CursorAgentTurn): void {
  const conversation = turn.conversation;
  const terminal = conversation.at(-1);
  if (!terminal) return;
  if (terminal.role === "assistant") {
    throw invalidRequest(
      "the conversation must end with a user turn; assistant prefill continuation is not supported",
    );
  }
  const userIndex = lastUserIndex(conversation);
  if (userIndex < 0) return;
  const userTurn = currentTurnFromMessage(conversation[userIndex]);
  if (!userTurn.text && userTurn.images.length === 0) {
    throw invalidRequest("the latest user turn is empty; it must carry text, an image, or tool_result blocks");
  }
  for (let index = userIndex - 1; index >= 0; index -= 1) {
    const message = conversation[index]!;
    if (message.role === "tool" || message.role === "function") return;
    const blocks = asBlocks(message.content);
    if (message.role === "user" && blocks.some((block) => block.type === "tool_result")) return;
    if (message.role === "assistant" && blocks.some((block) => block.type === "tool_use")) {
      throw invalidRequest(
        "assistant tool_use blocks must be answered with tool_result blocks before a new user turn",
      );
    }
  }
}

export function currentTurnSendPayload(turn: CursorAgentTurn): {
  text: string;
  images: Array<{ data: string; mimeType: string }>;
} {
  const images = turn.currentTurn.images;
  const text = turn.currentTurn.text.trim();
  // Never hand the SDK a blank user message: the model sees it as an "(omitted)"
  // user turn and answers that instead of continuing the conversation.
  if (!text && images.length === 0) {
    throw invalidRequest("the current user turn must carry text or an image to be sent to the Cursor Agent");
  }
  // An image-only turn keeps the SDK's non-empty text requirement satisfied.
  return { text: text || " ", images };
}

export function ordinaryReplayKey(turn: CursorAgentTurn): string {
  return `${cursorAgentTurnLineageKey(turn)}:${turn.lineage.requestDigest}`;
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
