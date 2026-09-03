import { readLimitedJson } from "./cursor-dashboard.js";

/**
 * Import a Cursor account from a browser session token.
 *
 * The `WorkosCursorSessionToken` cookie is `user_<id>::<jwt>` (often copied
 * URL-encoded as `user_<id>%3A%3A<jwt>`). The gateway never stores or sends
 * that token on the data plane; it is used exactly once, in memory, to call
 * the same `DashboardService/CreateUserApiKey` RPC that `Cursor.auth.login()`
 * in the official SDK uses after its browser login. The minted User API Key is
 * what gets persisted, so the account then behaves like any imported key.
 */

const DEFAULT_BASE_URL = "https://api2.cursor.sh";
const MINT_TIMEOUT_MS = 10_000;
const COOKIE_NAME_PREFIX = /^WorkosCursorSessionToken=/i;
const USER_ID = /^user_[A-Za-z0-9]+$/;
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const SEPARATOR = /::|%3A%3A/i;

export type SessionTokenParseFailure = "session_token_malformed" | "session_token_expired";

export type ParsedSessionToken =
  | { ok: true; jwt: string; userId?: string; expiresAtMs?: number }
  | { ok: false; reason: SessionTokenParseFailure };

export type MintUserApiKeyFailure =
  | SessionTokenParseFailure
  | "session_token_rejected"
  | "mint_unavailable"
  | "mint_invalid_response";

export type MintUserApiKeyResult =
  | { ok: true; apiKey: string; email?: string }
  | { ok: false; reason: MintUserApiKeyFailure; status?: number };

export interface MintUserApiKeyOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  /** Display name of the minted key in the Cursor dashboard. */
  keyName?: string;
}

function normalize(raw: string): string {
  let value = raw.trim().replace(COOKIE_NAME_PREFIX, "").trim();
  if (/%[0-9A-Fa-f]{2}/.test(value)) {
    try {
      value = decodeURIComponent(value);
    } catch {
      // keep the raw value; the shape checks below will reject it
    }
  }
  return value.trim();
}

/** Cheap shape check so a session token pasted into the API-key field is routed correctly. */
export function looksLikeSessionToken(raw: string): boolean {
  const value = normalize(raw);
  if (value.startsWith("user_") && SEPARATOR.test(value)) return true;
  return value.startsWith("eyJ") && JWT.test(value);
}

function decodeJwtPayload(jwt: string): Record<string, unknown> | undefined {
  const segment = jwt.split(".")[1];
  if (!segment) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function parseSessionToken(raw: string, now: number = Date.now()): ParsedSessionToken {
  const value = normalize(raw);
  if (!value) return { ok: false, reason: "session_token_malformed" };

  let userId: string | undefined;
  let jwt: string;
  if (value.startsWith("user_")) {
    const parts = value.split(SEPARATOR);
    if (parts.length !== 2) return { ok: false, reason: "session_token_malformed" };
    userId = parts[0] ?? "";
    jwt = parts[1] ?? "";
    if (!USER_ID.test(userId)) return { ok: false, reason: "session_token_malformed" };
  } else {
    jwt = value;
  }
  if (!JWT.test(jwt)) return { ok: false, reason: "session_token_malformed" };

  const payload = decodeJwtPayload(jwt);
  if (!payload) return { ok: false, reason: "session_token_malformed" };

  // Cursor's WorkOS subject is `auth0|user_...`; a prefix that names a
  // different user than the JWT is a paste error, so fail closed.
  const subject = typeof payload.sub === "string" ? payload.sub : undefined;
  if (userId && subject && subject.includes("user_") && !subject.endsWith(userId)) {
    return { ok: false, reason: "session_token_malformed" };
  }

  let expiresAtMs: number | undefined;
  if (typeof payload.exp === "number" && Number.isFinite(payload.exp)) {
    expiresAtMs = payload.exp * 1000;
    if (expiresAtMs <= now) return { ok: false, reason: "session_token_expired" };
  }

  return {
    ok: true,
    jwt,
    ...(userId ? { userId } : {}),
    ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
  };
}

function defaultKeyName(now: number): string {
  return `cursor-sdk2api ${new Date(now).toISOString().slice(0, 10)}`;
}

async function dashboardRpc(
  method: string,
  jwt: string,
  body: Record<string, unknown>,
  baseUrl: string,
  request: typeof globalThis.fetch,
): Promise<Response> {
  return request(`${baseUrl}/aiserver.v1.DashboardService/${method}`, {
    method: "POST",
    redirect: "error",
    headers: {
      authorization: `Bearer ${jwt}`,
      "content-type": "application/json",
      "connect-protocol-version": "1",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
  });
}

async function readEmail(jwt: string, baseUrl: string, request: typeof globalThis.fetch): Promise<string | undefined> {
  try {
    const response = await dashboardRpc("GetMe", jwt, {}, baseUrl, request);
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    }
    const payload = await readLimitedJson(response);
    const email = typeof payload.email === "string" ? payload.email.trim() : "";
    return email || undefined;
  } catch {
    return undefined;
  }
}

export async function mintUserApiKeyFromSessionToken(
  rawToken: string,
  options: MintUserApiKeyOptions = {},
): Promise<MintUserApiKeyResult> {
  const now = options.now ?? Date.now;
  const parsed = parseSessionToken(rawToken, now());
  if (!parsed.ok) return parsed;

  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const request = options.fetch ?? globalThis.fetch;
  const keyName = options.keyName?.trim() || defaultKeyName(now());

  let response: Response;
  try {
    response = await dashboardRpc("CreateUserApiKey", parsed.jwt, { name: keyName }, baseUrl, request);
  } catch {
    return { ok: false, reason: "mint_unavailable" };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: "session_token_rejected", status: response.status };
    }
    return { ok: false, reason: "mint_unavailable", status: response.status };
  }

  let payload: Record<string, unknown>;
  try {
    payload = await readLimitedJson(response);
  } catch {
    return { ok: false, reason: "mint_invalid_response" };
  }
  const apiKey = typeof payload.apiKey === "string" ? payload.apiKey.trim() : "";
  if (!apiKey) return { ok: false, reason: "mint_invalid_response" };

  const email = await readEmail(parsed.jwt, baseUrl, request);
  return { ok: true, apiKey, ...(email ? { email } : {}) };
}
