import { GatewayError } from "../errors.js";

/** Fallback cooldown when Cursor's message does not say when the quota resets. */
export const DEFAULT_QUOTA_COOLDOWN_MS = 60 * 60_000;
/** Cursor quotas are weekly/monthly; anything longer than this is a parsing mistake. */
export const MAX_QUOTA_COOLDOWN_MS = 35 * 24 * 60 * 60_000;

const QUOTA_EXHAUSTED_PATTERNS = [
  /usage limit/i,
  /ERROR_USAGE_LIMIT/i,
  /ERROR_GPT_4_VISION_PREVIEW_RATE_LIMIT/,
  /quota[^.]{0,40}\b(exhausted|reached|exceeded|used up)/i,
  /\b(reached|exceeded|hit)\b[^.]{0,60}\b(limit|quota)\b/i,
  /upgrade to get more usage/i,
  /out of (credits|quota|usage)/i,
];

/** Gateway-local or burst limits: fail over, but do not rest the account. */
const TRANSIENT_PATTERNS = [
  /active run capacity/i,
  /too many concurrent/i,
  /ERROR_RATE_LIMITED\b/,
];

const UNIT_MS: Record<string, number> = {
  second: 1_000,
  seconds: 1_000,
  sec: 1_000,
  secs: 1_000,
  s: 1_000,
  minute: 60_000,
  minutes: 60_000,
  min: 60_000,
  mins: 60_000,
  m: 60_000,
  hour: 3_600_000,
  hours: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  h: 3_600_000,
  day: 86_400_000,
  days: 86_400_000,
  d: 86_400_000,
  week: 604_800_000,
  weeks: 604_800_000,
  w: 604_800_000,
};

/**
 * Duration until the quota resets, read from phrases such as
 * "It resets in 7 days", "resets in 2 hours 30 minutes", "retry after 45s".
 * Returns undefined when the text carries no usable hint.
 */
export function parseResetHintMs(text: string): number | undefined {
  const anchor = /(?:reset\w*|retry|try again|available again|renew\w*)\s+(?:in|after)\s+/i.exec(text);
  if (!anchor) return undefined;
  const tail = text.slice(anchor.index + anchor[0].length, anchor.index + anchor[0].length + 80);
  const units = /(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w)\b/giy;
  let total = 0;
  let cursor = 0;
  for (;;) {
    units.lastIndex = cursor;
    const match = units.exec(tail);
    if (!match) break;
    total += Number.parseFloat(match[1]!) * (UNIT_MS[match[2]!.toLowerCase()] ?? 0);
    cursor = units.lastIndex;
    const separator = /^(?:\s*(?:,|and)?\s*)/.exec(tail.slice(cursor));
    cursor += separator ? separator[0].length : 0;
  }
  if (total <= 0) return undefined;
  return Math.min(total, MAX_QUOTA_COOLDOWN_MS);
}

export interface QuotaExhaustion {
  reason: string;
  /** Milliseconds the account should rest, already bounded. */
  cooldownMs: number;
  /** True when the duration came from the upstream message rather than the default. */
  fromHint: boolean;
}

/**
 * Decide whether a failure means "this account has no quota left" (as opposed
 * to a transient burst limit or an unrelated error). Only such failures put an
 * account on cooldown.
 */
export function classifyQuotaExhaustion(
  error: unknown,
  defaultCooldownMs = DEFAULT_QUOTA_COOLDOWN_MS,
): QuotaExhaustion | undefined {
  if (!(error instanceof GatewayError)) return undefined;
  if (error.code !== "rate_limited" && error.code !== "forbidden" && error.code !== "cursor_upstream_error") {
    return undefined;
  }
  const message = error.message;
  if (TRANSIENT_PATTERNS.some((pattern) => pattern.test(message))) return undefined;
  if (!QUOTA_EXHAUSTED_PATTERNS.some((pattern) => pattern.test(message))) return undefined;
  const hinted = parseResetHintMs(message);
  const cooldownMs = Math.max(1_000, Math.min(hinted ?? defaultCooldownMs, MAX_QUOTA_COOLDOWN_MS));
  return {
    reason: message.trim().replace(/\s+/g, " ").slice(0, 300),
    cooldownMs,
    fromHint: hinted !== undefined,
  };
}
