import type { ManagementAccount, ManagementAccountState } from "./api.js";
import type { AccountPayload, ModelsPayload } from "./types.js";

export type TestState = "idle" | "testing" | "pass" | "fail";

export interface RosterItem {
  id: string;
  keyHint: string;
  addedAt: number;
  testState: TestState;
  testMs?: number;
  testError?: string;
  account?: AccountPayload;
  models?: ModelsPayload;
  /** Pool routing state as reported by the management API. */
  enabled: boolean;
  state: ManagementAccountState;
  cooldownUntil?: number;
  cooldownReason?: string;
}

export function poolStateOf(account: ManagementAccount): Pick<RosterItem, "enabled" | "state" | "cooldownUntil" | "cooldownReason"> {
  return {
    enabled: account.enabled !== false,
    state: account.state ?? (account.enabled === false ? "disabled" : "active"),
    cooldownUntil: account.cooldown_until,
    cooldownReason: account.cooldown_reason,
  };
}

export function formatCooldownUntil(until: number | undefined, locale: string): string {
  if (!until) return "";
  return new Date(until).toLocaleString(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function identityLabel(account?: AccountPayload, fallback = ""): string {
  const identity = account?.identity;
  const name = [identity?.first_name, identity?.last_name].filter(Boolean).join(" ");
  return name || identity?.api_key_name || fallback;
}
