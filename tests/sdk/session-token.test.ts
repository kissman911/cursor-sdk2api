import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test } from "vitest";
import {
  looksLikeSessionToken,
  mintUserApiKeyFromSessionToken,
  parseSessionToken,
} from "../../src/account/session-token.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  })));
});

const NOW = Date.UTC(2026, 8, 3, 12, 0, 0);
const USER = "user_01TESTSESSIONUSER0000000000";

/** Built at runtime so no JWT-shaped literal lands in the repository. */
function fakeJwt(payload: Record<string, unknown>): string {
  const segment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${segment({ alg: "RS256", typ: "JWT" })}.${segment(payload)}.fake-signature`;
}

function sessionToken(overrides: Record<string, unknown> = {}, userId = USER): string {
  return `${userId}::${fakeJwt({ sub: `auth0|${userId}`, exp: Math.floor(NOW / 1000) + 3600, type: "web", ...overrides })}`;
}

async function dashboardServer(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function readBody(request: Parameters<RequestListener>[0]): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

test("parses user_<id>::<jwt> and keeps only the JWT for the wire", () => {
  const token = sessionToken();
  const parsed = parseSessionToken(token, NOW);
  expect(parsed).toMatchObject({ ok: true, userId: USER, expiresAtMs: (Math.floor(NOW / 1000) + 3600) * 1000 });
  if (parsed.ok) {
    expect(parsed.jwt).toBe(token.split("::")[1]);
    expect(parsed.jwt).not.toContain("user_");
  }
});

test("accepts the URL-encoded cookie form and a leading cookie name", () => {
  const token = sessionToken();
  const encoded = token.replace("::", "%3A%3A");
  expect(parseSessionToken(encoded, NOW)).toMatchObject({ ok: true, userId: USER });
  expect(parseSessionToken(`WorkosCursorSessionToken=${encoded}`, NOW)).toMatchObject({ ok: true, userId: USER });
  expect(parseSessionToken(`  ${token}\n`, NOW)).toMatchObject({ ok: true, userId: USER });
});

test("accepts a bare JWT without a user prefix", () => {
  const jwt = fakeJwt({ sub: `auth0|${USER}`, exp: Math.floor(NOW / 1000) + 60 });
  const parsed = parseSessionToken(jwt, NOW);
  expect(parsed).toMatchObject({ ok: true, jwt });
  if (parsed.ok) expect(parsed.userId).toBeUndefined();
});

test("rejects garbage, API keys, missing segments, and undecodable payloads", () => {
  for (const value of [
    "",
    "key_0123456789abcdef",
    "user_01ABC",
    "user_01ABC::",
    "user_01ABC::not-a-jwt",
    `user_01ABC::${fakeJwt({})}::extra`,
    `user-01ABC::${fakeJwt({})}`,
    "aaaa.bbbb.cccc",
    `${USER}::eyJ.${Buffer.from("[1,2]").toString("base64url")}.sig`,
  ]) {
    expect(parseSessionToken(value, NOW)).toEqual({ ok: false, reason: "session_token_malformed" });
  }
});

test("rejects an expired JWT without touching the network", async () => {
  let requests = 0;
  const baseUrl = await dashboardServer((_request, response) => {
    requests += 1;
    response.end("{}");
  });
  const expired = sessionToken({ exp: Math.floor(NOW / 1000) - 1 });
  expect(parseSessionToken(expired, NOW)).toEqual({ ok: false, reason: "session_token_expired" });
  expect(await mintUserApiKeyFromSessionToken(expired, { baseUrl, now: () => NOW })).toEqual({
    ok: false,
    reason: "session_token_expired",
  });
  expect(requests).toBe(0);
});

test("fails closed when the user prefix names a different user than the JWT subject", () => {
  const token = sessionToken({ sub: "auth0|user_01SOMEBODYELSE000000000000" });
  expect(parseSessionToken(token, NOW)).toEqual({ ok: false, reason: "session_token_malformed" });
  // Subjects that do not carry a user_ id at all are not compared.
  expect(parseSessionToken(sessionToken({ sub: "service|abc" }), NOW)).toMatchObject({ ok: true });
});

test("looksLikeSessionToken routes cookie values and JWTs but not API keys", () => {
  expect(looksLikeSessionToken(sessionToken())).toBe(true);
  expect(looksLikeSessionToken(sessionToken().replace("::", "%3A%3A"))).toBe(true);
  expect(looksLikeSessionToken(fakeJwt({ exp: 1 }))).toBe(true);
  expect(looksLikeSessionToken("key_0123456789abcdef")).toBe(false);
  expect(looksLikeSessionToken("fixture-account-key")).toBe(false);
  expect(looksLikeSessionToken("user_id")).toBe(false);
});

test("mints a User API Key with only the JWT as the bearer and reads the email best effort", async () => {
  const token = sessionToken();
  const jwt = token.split("::")[1];
  const seen: Array<{ path: string; authorization?: string; connectVersion?: string; body: string }> = [];
  const baseUrl = await dashboardServer((request, response) => {
    void readBody(request).then((body) => {
      seen.push({
        path: request.url ?? "",
        authorization: request.headers.authorization,
        connectVersion: request.headers["connect-protocol-version"] as string | undefined,
        body,
      });
      response.setHeader("content-type", "application/json");
      if (request.url === "/aiserver.v1.DashboardService/CreateUserApiKey") {
        response.end(JSON.stringify({ apiKey: "key_minted_from_session_token" }));
        return;
      }
      if (request.url === "/aiserver.v1.DashboardService/GetMe") {
        response.end(JSON.stringify({ email: "operator@example.com" }));
        return;
      }
      response.statusCode = 404;
      response.end("{}");
    });
  });

  const result = await mintUserApiKeyFromSessionToken(token, { baseUrl, now: () => NOW });

  expect(result).toEqual({ ok: true, apiKey: "key_minted_from_session_token", email: "operator@example.com" });
  expect(seen.map((entry) => entry.path)).toEqual([
    "/aiserver.v1.DashboardService/CreateUserApiKey",
    "/aiserver.v1.DashboardService/GetMe",
  ]);
  for (const entry of seen) {
    expect(entry.authorization).toBe(`Bearer ${jwt}`);
    expect(entry.authorization).not.toContain("user_");
    expect(entry.connectVersion).toBe("1");
  }
  expect(JSON.parse(seen[0]!.body)).toEqual({ name: "cursor-sdk2api 2026-09-03" });
  expect(JSON.parse(seen[1]!.body)).toEqual({});
});

test("a failed GetMe does not fail the import", async () => {
  const baseUrl = await dashboardServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url?.endsWith("/CreateUserApiKey")) {
      response.end(JSON.stringify({ apiKey: "key_minted_without_email" }));
      return;
    }
    response.statusCode = 500;
    response.end("boom");
  });
  expect(await mintUserApiKeyFromSessionToken(sessionToken(), { baseUrl, now: () => NOW })).toEqual({
    ok: true,
    apiKey: "key_minted_without_email",
  });
});

test("maps Cursor rejections and outages without reflecting the upstream body", async () => {
  const rejected = await dashboardServer((_request, response) => {
    response.statusCode = 401;
    response.end(JSON.stringify({ error: "unauthenticated secret-echo" }));
  });
  const unauthorized = await mintUserApiKeyFromSessionToken(sessionToken(), { baseUrl: rejected, now: () => NOW });
  expect(unauthorized).toEqual({ ok: false, reason: "session_token_rejected", status: 401 });
  expect(JSON.stringify(unauthorized)).not.toContain("secret-echo");

  const forbidden = await dashboardServer((_request, response) => {
    response.statusCode = 403;
    response.end("{}");
  });
  expect(await mintUserApiKeyFromSessionToken(sessionToken(), { baseUrl: forbidden, now: () => NOW })).toEqual({
    ok: false,
    reason: "session_token_rejected",
    status: 403,
  });

  const broken = await dashboardServer((_request, response) => {
    response.statusCode = 500;
    response.end("{}");
  });
  expect(await mintUserApiKeyFromSessionToken(sessionToken(), { baseUrl: broken, now: () => NOW })).toEqual({
    ok: false,
    reason: "mint_unavailable",
    status: 500,
  });

  const empty = await dashboardServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end("{}");
  });
  expect(await mintUserApiKeyFromSessionToken(sessionToken(), { baseUrl: empty, now: () => NOW })).toEqual({
    ok: false,
    reason: "mint_invalid_response",
  });

  const unreachable = await mintUserApiKeyFromSessionToken(sessionToken(), {
    baseUrl: "http://127.0.0.1:9",
    now: () => NOW,
    fetch: async () => {
      throw new Error("connect ECONNREFUSED");
    },
  });
  expect(unreachable).toEqual({ ok: false, reason: "mint_unavailable" });
});
