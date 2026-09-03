import { readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { MintUserApiKeyResult } from "../../src/account/session-token.js";
import { closeTestApp, startTestApp, type TestContext } from "../helpers/app.js";

let ctx: TestContext | undefined;

afterEach(async () => {
  if (ctx) await closeTestApp(ctx);
  ctx = undefined;
});

/** Built at runtime so no JWT-shaped literal lands in the repository. */
function fakeSessionToken(userId = "user_01CONTRACTTESTUSER000000000"): string {
  const segment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const jwt = `${segment({ alg: "RS256", typ: "JWT" })}.${segment({ sub: `auth0|${userId}`, exp: 4102444800 })}.sig`;
  return `${userId}::${jwt}`;
}

function readStoredAccountFiles(stateDir: string): string {
  const dir = join(stateDir, "auths");
  return readdirSync(dir).map((name) => readFileSync(join(dir, name), "utf8")).join("\n");
}

test("accounts persist across gateway restarts with CPA-style private files", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "cursor-sdk2api-persistent-"));
  ctx = await startTestApp({ config: { stateDir } });

  const created = await fetch(`${ctx.url}/v0/management/accounts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: "fixture-account-key" }),
  });
  expect(created.status).toBe(201);
  const createdBody = (await created.json()) as { account: { id: string; key_hint: string } };
  expect(createdBody.account.key_hint).toBe("••••-key");
  expect(JSON.stringify(createdBody)).not.toContain("fixture-account-key");
  expect(statSync(join(stateDir, "auths")).mode & 0o777).toBe(0o700);
  expect(statSync(join(stateDir, "auths", `${createdBody.account.id}.json`)).mode & 0o777).toBe(0o600);

  await closeTestApp(ctx);
  ctx = await startTestApp({ config: { stateDir } });
  const restored = await fetch(`${ctx.url}/v0/management/accounts`);
  const restoredBody = (await restored.json()) as { accounts: Array<{ id: string; key_hint: string }> };
  expect(restoredBody.accounts).toEqual([
    expect.objectContaining({ id: createdBody.account.id, key_hint: createdBody.account.key_hint }),
  ]);
  expect(JSON.stringify(restoredBody)).not.toContain("fixture-account-key");

  const removed = await fetch(`${ctx.url}/v0/management/accounts?id=${encodeURIComponent(createdBody.account.id)}`, {
    method: "DELETE",
  });
  expect(removed.status).toBe(200);
  const empty = await fetch(`${ctx.url}/v0/management/accounts`);
  expect(await empty.json()).toMatchObject({ accounts: [] });
});

test("adding the same Cursor key is idempotent", async () => {
  ctx = await startTestApp();
  const add = () => fetch(`${ctx!.url}/v0/management/accounts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: "same-key" }),
  });
  const first = (await (await add()).json()) as { account: { id: string } };
  const second = (await (await add()).json()) as { account: { id: string } };
  expect(second.account.id).toBe(first.account.id);
  const listed = await fetch(`${ctx.url}/v0/management/accounts`);
  const body = (await listed.json()) as { accounts: unknown[] };
  expect(body.accounts).toHaveLength(1);
});

test("a session token is exchanged once for a minted API key and only the key is stored", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "cursor-sdk2api-session-token-"));
  const token = fakeSessionToken();
  const minted: string[] = [];
  ctx = await startTestApp({
    config: { stateDir },
    mintApiKeyFromSessionToken: async (presented) => {
      minted.push(presented);
      return { ok: true, apiKey: "key_minted_by_test", email: "operator@example.com" };
    },
  });

  const created = await fetch(`${ctx.url}/v0/management/accounts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session_token: token }),
  });
  const text = await created.text();
  expect(created.status).toBe(201);
  expect(minted).toEqual([token]);
  expect(JSON.parse(text)).toMatchObject({
    account: { key_hint: "••••test", state: "active" },
    minted_api_key: true,
    email: "operator@example.com",
  });
  expect(text).not.toContain("key_minted_by_test");
  expect(text).not.toContain("user_01CONTRACTTESTUSER");
  expect(text).not.toContain("eyJ");

  const stored = readStoredAccountFiles(stateDir);
  expect(stored).toContain('"api_key":"key_minted_by_test"');
  expect(stored).not.toContain("user_01CONTRACTTESTUSER");
  expect(stored).not.toContain("eyJ");

  // The minted key is a normal pool member from here on.
  const listed = (await (await fetch(`${ctx.url}/v0/management/accounts`)).json()) as { accounts: unknown[] };
  expect(listed.accounts).toHaveLength(1);
});

test("a session token pasted into api_key still takes the mint path", async () => {
  const token = fakeSessionToken().replace("::", "%3A%3A");
  const minted: string[] = [];
  ctx = await startTestApp({
    mintApiKeyFromSessionToken: async (presented) => {
      minted.push(presented);
      return { ok: true, apiKey: "key_minted_from_api_key_field" };
    },
  });
  const created = await fetch(`${ctx.url}/v0/management/accounts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: token }),
  });
  expect(created.status).toBe(201);
  expect(minted).toEqual([token]);
  expect(await created.json()).toMatchObject({ account: { key_hint: "••••ield" }, minted_api_key: true });
});

test("session token failures map to client or upstream errors without echoing the token", async () => {
  const cases: Array<[MintUserApiKeyResult & { ok: false }, number, string]> = [
    [{ ok: false, reason: "session_token_malformed" }, 400, "invalid_request"],
    [{ ok: false, reason: "session_token_expired" }, 400, "invalid_request"],
    [{ ok: false, reason: "session_token_rejected", status: 401 }, 401, "authentication_error"],
    [{ ok: false, reason: "mint_unavailable", status: 503 }, 502, "cursor_upstream_error"],
    [{ ok: false, reason: "mint_invalid_response" }, 502, "cursor_upstream_error"],
  ];
  for (const [result, status, code] of cases) {
    if (ctx) await closeTestApp(ctx);
    ctx = await startTestApp({ mintApiKeyFromSessionToken: async () => result });
    const token = fakeSessionToken();
    const response = await fetch(`${ctx.url}/v0/management/accounts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_token: token }),
    });
    const text = await response.text();
    expect(response.status, result.reason).toBe(status);
    expect(JSON.parse(text)).toMatchObject({ error: { type: code } });
    expect(text).not.toContain("user_01CONTRACTTESTUSER");
    expect(text).not.toContain("eyJ");
    // The operator-facing message survives the public redactor intact.
    expect(text, result.reason).not.toContain("[redacted]");
    const listed = (await (await fetch(`${ctx.url}/v0/management/accounts`)).json()) as { accounts: unknown[] };
    expect(listed.accounts).toHaveLength(0);
  }
});

test("adding an account requires api_key or session_token", async () => {
  ctx = await startTestApp();
  const response = await fetch(`${ctx.url}/v0/management/accounts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    error: { type: "invalid_request", message: "Provide session_token (user_...::<jwt>) or api_key" },
  });
});

test("account probe uses the stored Cursor key without returning it to the browser", async () => {
  ctx = await startTestApp({
    sdk: {
      modelsByApiKey: {
        "probe-secret-key": { ok: true, models: [{ id: "claude-sonnet-4-6", displayName: "Sonnet 4.6" }] },
      },
      accountsByApiKey: {
        "probe-secret-key": { ok: true, identity: { apiKeyName: "probe-account" } },
      },
    },
  });
  const created = await fetch(`${ctx.url}/v0/management/accounts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: "probe-secret-key" }),
  });
  const { account } = (await created.json()) as { account: { id: string } };

  const response = await fetch(`${ctx.url}/v0/management/accounts/probe?id=${encodeURIComponent(account.id)}`);
  const text = await response.text();
  expect(response.status).toBe(200);
  expect(text).not.toContain("probe-secret-key");
  expect(JSON.parse(text)).toMatchObject({
    models: { data: [{ id: "claude-sonnet-4-6" }] },
    account: { identity: { api_key_name: "probe-account" } },
  });
  expect(ctx.sdk.listModelsApiKeys).toContain("probe-secret-key");
  expect(ctx.sdk.getAccountApiKeys).toContain("probe-secret-key");
});

test("account playground runs with the selected stored Cursor key", async () => {
  ctx = await startTestApp({
    sdk: { scripts: [[{ type: "text", chunks: ["managed console ok"] }]] },
  });
  const created = await fetch(`${ctx.url}/v0/management/accounts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: "run-secret-key" }),
  });
  const { account } = (await created.json()) as { account: { id: string } };

  const response = await fetch(`${ctx.url}/v0/management/accounts/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      account_id: account.id,
      protocol: "messages",
      request: {
        model: "claude-sonnet-4-6",
        max_tokens: 128,
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      },
    }),
  });
  expect(response.status).toBe(200);
  expect(ctx.sdk.lastCreate?.apiKey).toBe("run-secret-key");
  expect(await response.text()).toContain("managed console ok");
});
