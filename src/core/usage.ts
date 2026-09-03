import type { SdkUsage } from "../sdk/port.js";
import type { UsageView } from "../protocols/anthropic/types.js";
import type { LedgerUsage } from "./runtime-ledger/types.js";

export function deferredUsage(): UsageView {
  return {
    input_tokens: 0,
    output_tokens: 0,
    usage_deferred: true,
    usage_status: "deferred",
  };
}

export function unavailableUsage(): UsageView {
  return {
    input_tokens: 0,
    output_tokens: 0,
    usage_status: "unavailable",
  };
}

export function fromSdkUsage(usage: SdkUsage | undefined): UsageView {
  if (!usage) return unavailableUsage();
  const view: UsageView = {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    usage_status: "sdk",
  };
  if (typeof usage.cacheWriteTokens === "number") {
    view.cache_creation_input_tokens = usage.cacheWriteTokens;
  }
  if (typeof usage.cacheReadTokens === "number") {
    view.cache_read_input_tokens = usage.cacheReadTokens;
  }
  if (typeof usage.reasoningTokens === "number") {
    view.reasoning_tokens = usage.reasoningTokens;
  }
  return view;
}

/**
 * Usage attributable to one response segment: the cumulative run usage minus
 * what earlier segments already reported. Counters never go backwards in
 * either runtime, but clamp at zero so an inconsistent snapshot can never
 * produce negative billing.
 */
export function segmentUsage(cumulative: SdkUsage, reported: SdkUsage | undefined): UsageView {
  const diff = (current: number | undefined, previous: number | undefined): number | undefined => {
    if (typeof current !== "number") return undefined;
    return Math.max(0, current - (previous ?? 0));
  };
  const view: UsageView = {
    input_tokens: diff(cumulative.inputTokens, reported?.inputTokens) ?? 0,
    output_tokens: diff(cumulative.outputTokens, reported?.outputTokens) ?? 0,
    usage_status: "sdk",
  };
  const cacheWrite = diff(cumulative.cacheWriteTokens, reported?.cacheWriteTokens);
  if (cacheWrite !== undefined) view.cache_creation_input_tokens = cacheWrite;
  const cacheRead = diff(cumulative.cacheReadTokens, reported?.cacheReadTokens);
  if (cacheRead !== undefined) view.cache_read_input_tokens = cacheRead;
  const reasoning = diff(cumulative.reasoningTokens, reported?.reasoningTokens);
  if (reasoning !== undefined) view.reasoning_tokens = reasoning;
  return view;
}

/** Map protocol usage to ledger token ints. Deferred usage is omitted, never invented. */
export function toLedgerUsage(usage: UsageView | undefined): LedgerUsage | undefined {
  if (!usage) return undefined;
  if (usage.usage_status === "deferred" || usage.usage_deferred) return undefined;
  const mapped: LedgerUsage = {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
  };
  if (typeof usage.cache_creation_input_tokens === "number") {
    mapped.cacheWriteTokens = usage.cache_creation_input_tokens;
  }
  if (typeof usage.cache_read_input_tokens === "number") {
    mapped.cacheReadTokens = usage.cache_read_input_tokens;
  }
  if (typeof usage.reasoning_tokens === "number") {
    mapped.reasoningTokens = usage.reasoning_tokens;
  }
  return mapped;
}
