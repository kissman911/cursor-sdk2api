import { expect, test } from "vitest";
import { forbiddenError, rateLimited, upstreamError } from "../../src/errors.js";
import {
  classifyQuotaExhaustion,
  DEFAULT_QUOTA_COOLDOWN_MS,
  MAX_QUOTA_COOLDOWN_MS,
  parseResetHintMs,
} from "../../src/auth/quota-cooldown.js";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

test("parseResetHintMs reads Cursor's reset phrasing in days, hours, minutes, and combinations", () => {
  expect(parseResetHintMs("Your included Grok Bot usage limit has been reached. It resets in 7 days. Upgrade to get more usage.")).toBe(7 * DAY);
  expect(parseResetHintMs("usage limit reached, resets in 3 hours")).toBe(3 * HOUR);
  expect(parseResetHintMs("quota exceeded; try again in 45 minutes")).toBe(45 * 60_000);
  expect(parseResetHintMs("limit hit. Resets in 2 days 3 hours and 5 minutes.")).toBe(2 * DAY + 3 * HOUR + 5 * 60_000);
  expect(parseResetHintMs("retry after 30s")).toBe(30_000);
  expect(parseResetHintMs("resets in 400 days")).toBe(MAX_QUOTA_COOLDOWN_MS);
  expect(parseResetHintMs("no hint here")).toBeUndefined();
  expect(parseResetHintMs("resets in a while")).toBeUndefined();
});

test("classifyQuotaExhaustion accepts exhausted-quota failures and uses the hint or the default", () => {
  const grok = classifyQuotaExhaustion(
    rateLimited(
      "[resource_exhausted] ERROR_GPT_4_VISION_PREVIEW_RATE_LIMIT: You've reached your Grok Bot usage limit: " +
        "Your included Grok Bot usage limit has been reached. It resets in 7 days. Upgrade to get more usage.",
    ),
  );
  expect(grok).toMatchObject({ cooldownMs: 7 * DAY, fromHint: true });
  expect(grok?.reason).toContain("Grok Bot usage limit");

  const plain = classifyQuotaExhaustion(rateLimited("[resource_exhausted] ERROR_USAGE_LIMIT: usage limit"), 15 * 60_000);
  expect(plain).toMatchObject({ cooldownMs: 15 * 60_000, fromHint: false });
  expect(classifyQuotaExhaustion(rateLimited("You have exceeded your monthly quota"))?.cooldownMs).toBe(DEFAULT_QUOTA_COOLDOWN_MS);
  expect(classifyQuotaExhaustion(forbiddenError("Out of credits for this plan"))).toBeDefined();
  expect(classifyQuotaExhaustion(upstreamError("Sand inference HTTP 402: usage limit reached"))).toBeDefined();
});

test("classifyQuotaExhaustion ignores transient limits, capacity errors, and unrelated failures", () => {
  expect(classifyQuotaExhaustion(rateLimited("[resource_exhausted] ERROR_RATE_LIMITED: slow down"))).toBeUndefined();
  expect(classifyQuotaExhaustion(rateLimited("All Cursor accounts compatible with x are at active run capacity"))).toBeUndefined();
  expect(classifyQuotaExhaustion(rateLimited("Too many requests"))).toBeUndefined();
  expect(classifyQuotaExhaustion(upstreamError("stream broke"))).toBeUndefined();
  expect(classifyQuotaExhaustion(new Error("usage limit"))).toBeUndefined();
});
