import { afterEach, expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "../../src/clock.js";
import { api, closeTestApp, startTestApp, weatherTool, type TestContext } from "../helpers/app.js";

let ctx: TestContext | undefined;

afterEach(async () => {
  if (ctx) await closeTestApp(ctx);
  ctx = undefined;
});

async function addAccount(context: TestContext, apiKey: string): Promise<string> {
  const response = await fetch(`${context.url}/v0/management/accounts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: apiKey }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { account: { id: string } };
  return body.account.id;
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function messageBody(content: unknown = "hello", tools: unknown[] = []) {
  return {
    model: "composer-2.5",
    max_tokens: 256,
    messages: [{ role: "user", content }],
    tools,
  };
}

test("one gateway key round-robins new sessions across persistent Cursor accounts", async () => {
  ctx = await startTestApp({
    config: { authMode: "managed", gatewayAccessKey: "gateway-key", managedCursorKey: undefined },
    sdk: {
      modelsByApiKey: {
        "cursor-a": { ok: true, models: [{ id: "composer-2.5" }] },
        "cursor-b": { ok: true, models: [{ id: "composer-2.5" }] },
      },
    },
  });
  await addAccount(ctx, "cursor-a");
  await addAccount(ctx, "cursor-b");

  for (let index = 0; index < 2; index += 1) {
    const response = await api(ctx, "/v1/messages", {
      apiKey: "gateway-key",
      method: "POST",
      body: JSON.stringify(messageBody(`hello ${index}`)),
    });
    expect(response.status).toBe(200);
  }

  expect(ctx.sdk.agents.map((agent) => agent.input.apiKey)).toEqual(["cursor-a", "cursor-b"]);
});

test("managed routing chooses an account whose live catalog contains the requested model", async () => {
  ctx = await startTestApp({
    config: { authMode: "managed", gatewayAccessKey: "gateway-key", managedCursorKey: undefined },
    sdk: {
      modelsByApiKey: {
        "cursor-a": { ok: true, models: [{ id: "composer-2.5" }] },
        "cursor-b": { ok: true, models: [{ id: "claude-sonnet-4-6" }] },
      },
    },
  });
  await addAccount(ctx, "cursor-a");
  await addAccount(ctx, "cursor-b");

  const response = await api(ctx, "/v1/messages", {
    apiKey: "gateway-key",
    method: "POST",
    body: JSON.stringify({ ...messageBody(), model: "claude-sonnet-4-6" }),
  });
  expect(response.status).toBe(200);
  expect(ctx.sdk.lastCreate?.apiKey).toBe("cursor-b");
});

test("pre-semantic provider failure retries once on another managed account", async () => {
  ctx = await startTestApp({
    config: { authMode: "managed", gatewayAccessKey: "gateway-key", managedCursorKey: undefined },
    sdk: {
      modelsByApiKey: {
        "cursor-a": { ok: true, models: [{ id: "composer-2.5" }] },
        "cursor-b": { ok: true, models: [{ id: "composer-2.5" }] },
      },
      createErrorsByApiKey: {
        "cursor-a": { message: "provider connection reset before first event" },
      },
      agentScripts: [[[{ type: "text", chunks: ["served-by-b"] }]]],
    },
  });
  await addAccount(ctx, "cursor-a");
  await addAccount(ctx, "cursor-b");

  const response = await api(ctx, "/v1/messages", {
    apiKey: "gateway-key",
    method: "POST",
    body: JSON.stringify(messageBody("hello")),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { content: Array<{ text?: string }> };
  expect(body.content.some((item) => item.text === "served-by-b")).toBe(true);
  expect(ctx.sdk.createCalls.map((call) => call.apiKey)).toEqual(["cursor-a", "cursor-b"]);
  expect(ctx.sdk.agents.map((agent) => agent.input.apiKey)).toEqual(["cursor-b"]);
});

const GROK_BOT_EXHAUSTED =
  "[resource_exhausted] ERROR_GPT_4_VISION_PREVIEW_RATE_LIMIT: You've reached your Grok Bot usage limit: " +
  "Your included Grok Bot usage limit has been reached. It resets in 7 days. Upgrade to get more usage.";

async function listAccounts(context: TestContext) {
  const response = await fetch(`${context.url}/v0/management/accounts`);
  expect(response.status).toBe(200);
  return ((await response.json()) as {
    accounts: Array<{ id: string; enabled: boolean; state: string; cooldown_until?: number; cooldown_reason?: string }>;
  }).accounts;
}

test("a quota-exhausted account is rested for the hinted reset window and the pool routes around it", async () => {
  const clock = new FakeClock(1_700_000_000_000);
  const stateDir = mkdtempSync(join(tmpdir(), "cursor-sdk2api-quota-cooldown-"));
  ctx = await startTestApp({
    clock,
    captureLogs: true,
    config: { authMode: "managed", gatewayAccessKey: "gateway-key", managedCursorKey: undefined, stateDir },
    sdk: {
      modelsByApiKey: {
        "cursor-a": { ok: true, models: [{ id: "composer-2.5" }] },
        "cursor-b": { ok: true, models: [{ id: "composer-2.5" }] },
      },
      createErrorsByApiKey: {
        "cursor-a": { message: GROK_BOT_EXHAUSTED, name: "RateLimitError" },
      },
      agentScripts: [[[{ type: "text", chunks: ["served-by-b"] }]], [[{ type: "text", chunks: ["served-by-b-again"] }]]],
    },
  });
  const accountA = await addAccount(ctx, "cursor-a");
  const accountB = await addAccount(ctx, "cursor-b");

  // Round robin lands on A first; the quota failure fails over to B within the same request.
  const first = await api(ctx, "/v1/messages", {
    apiKey: "gateway-key",
    method: "POST",
    body: JSON.stringify(messageBody("hello")),
  });
  expect(first.status).toBe(200);
  expect(((await first.json()) as { content: Array<{ text?: string }> }).content[0]?.text).toBe("served-by-b");
  expect(ctx.sdk.createCalls.map((call) => call.apiKey)).toEqual(["cursor-a", "cursor-b"]);

  // A is now resting until the hinted reset (7 days) and says why.
  const listed = await listAccounts(ctx);
  const restingA = listed.find((account) => account.id === accountA)!;
  expect(restingA.state).toBe("cooldown");
  expect(restingA.enabled).toBe(true);
  expect(restingA.cooldown_until).toBe(clock.now() + 7 * 24 * 60 * 60_000);
  expect(restingA.cooldown_reason).toMatch(/Grok Bot usage limit/);
  expect(listed.find((account) => account.id === accountB)?.state).toBe("active");
  expect(ctx.logs.some((line) => line.includes("managed account rested after quota exhaustion"))).toBe(true);

  // The next new session never touches A.
  const second = await api(ctx, "/v1/messages", {
    apiKey: "gateway-key",
    method: "POST",
    body: JSON.stringify(messageBody("hello again")),
  });
  expect(second.status).toBe(200);
  expect(ctx.sdk.createCalls.map((call) => call.apiKey)).toEqual(["cursor-a", "cursor-b", "cursor-b"]);

  // The cooldown survives a restart because it lives in the account file.
  await closeTestApp(ctx);
  ctx = await startTestApp({
    clock,
    config: { authMode: "managed", gatewayAccessKey: "gateway-key", managedCursorKey: undefined, stateDir },
    sdk: {
      modelsByApiKey: {
        "cursor-a": { ok: true, models: [{ id: "composer-2.5" }] },
        "cursor-b": { ok: true, models: [{ id: "composer-2.5" }] },
      },
      scripts: [[{ type: "text", chunks: ["after-restart"] }]],
    },
  });
  expect((await listAccounts(ctx)).find((account) => account.id === accountA)?.state).toBe("cooldown");
  const third = await api(ctx, "/v1/messages", {
    apiKey: "gateway-key",
    method: "POST",
    body: JSON.stringify(messageBody("post restart")),
  });
  expect(third.status).toBe(200);
  expect(ctx.sdk.createCalls.map((call) => call.apiKey)).toEqual(["cursor-b"]);

  // Once the reset window has passed, A is eligible again.
  clock.advance(7 * 24 * 60 * 60_000 + 1);
  expect((await listAccounts(ctx)).find((account) => account.id === accountA)?.state).toBe("active");
  const fourth = await api(ctx, "/v1/messages", {
    apiKey: "gateway-key",
    method: "POST",
    body: JSON.stringify(messageBody("after reset")),
  });
  expect(fourth.status).toBe(200);
  expect(ctx.sdk.createCalls.map((call) => call.apiKey)).toEqual(["cursor-b", "cursor-a"]);
});

test("when every enabled account is resting the client gets one clear 429 with the earliest reset", async () => {
  const clock = new FakeClock(1_700_000_000_000);
  ctx = await startTestApp({
    clock,
    config: { authMode: "managed", gatewayAccessKey: "gateway-key", managedCursorKey: undefined },
    sdk: {
      modelsByApiKey: { "cursor-a": { ok: true, models: [{ id: "composer-2.5" }] } },
      createErrorsByApiKey: {
        "cursor-a": { message: "You've reached your usage limit. It resets in 3 hours.", name: "RateLimitError" },
      },
    },
  });
  await addAccount(ctx, "cursor-a");

  const exhausted = await api(ctx, "/v1/messages", {
    apiKey: "gateway-key",
    method: "POST",
    body: JSON.stringify(messageBody("hello")),
  });
  expect(exhausted.status).toBe(429);
  expect(ctx.sdk.createCalls).toHaveLength(1);

  const blocked = await api(ctx, "/v1/messages", {
    apiKey: "gateway-key",
    method: "POST",
    body: JSON.stringify(messageBody("hello again")),
  });
  expect(blocked.status).toBe(429);
  const body = (await blocked.json()) as { error: { type: string; message: string } };
  expect(body.error.type).toBe("rate_limited");
  expect(body.error.message).toContain(new Date(clock.now() + 3 * 60 * 60_000).toISOString());
  // No upstream call was made for the blocked request.
  expect(ctx.sdk.createCalls).toHaveLength(1);
});

test("transient rate limits fail over but do not rest the account", async () => {
  ctx = await startTestApp({
    config: { authMode: "managed", gatewayAccessKey: "gateway-key", managedCursorKey: undefined },
    sdk: {
      modelsByApiKey: {
        "cursor-a": { ok: true, models: [{ id: "composer-2.5" }] },
        "cursor-b": { ok: true, models: [{ id: "composer-2.5" }] },
      },
      createErrorsByApiKey: {
        "cursor-a": { message: "[resource_exhausted] ERROR_RATE_LIMITED: slow down", name: "RateLimitError" },
      },
    },
  });
  const accountA = await addAccount(ctx, "cursor-a");
  await addAccount(ctx, "cursor-b");
  const response = await api(ctx, "/v1/messages", {
    apiKey: "gateway-key",
    method: "POST",
    body: JSON.stringify(messageBody("hello")),
  });
  expect(response.status).toBe(200);
  expect((await listAccounts(ctx)).find((account) => account.id === accountA)?.state).toBe("active");
});

test("operators can disable and re-enable an account; enabling also clears a cooldown", async () => {
  const clock = new FakeClock(1_700_000_000_000);
  ctx = await startTestApp({
    clock,
    config: { authMode: "managed", gatewayAccessKey: "gateway-key", managedCursorKey: undefined },
    sdk: {
      modelsByApiKey: {
        "cursor-a": { ok: true, models: [{ id: "composer-2.5" }] },
        "cursor-b": { ok: true, models: [{ id: "composer-2.5" }] },
      },
    },
  });
  const accountA = await addAccount(ctx, "cursor-a");
  const accountB = await addAccount(ctx, "cursor-b");

  const setEnabled = async (id: string, enabled: boolean) => {
    const response = await fetch(`${ctx!.url}/v0/management/accounts/enabled`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, enabled }),
    });
    return { status: response.status, body: (await response.json()) as { account?: { enabled: boolean; state: string } } };
  };

  const disabled = await setEnabled(accountA, false);
  expect(disabled.status).toBe(200);
  expect(disabled.body.account).toMatchObject({ enabled: false, state: "disabled" });

  for (let index = 0; index < 2; index += 1) {
    const response = await api(ctx, "/v1/messages", {
      apiKey: "gateway-key",
      method: "POST",
      body: JSON.stringify(messageBody(`hello ${index}`)),
    });
    expect(response.status).toBe(200);
  }
  expect(ctx.sdk.createCalls.map((call) => call.apiKey)).toEqual(["cursor-b", "cursor-b"]);

  // Disabling the last eligible account makes the pool refuse new sessions clearly.
  await setEnabled(accountB, false);
  const refused = await api(ctx, "/v1/messages", {
    apiKey: "gateway-key",
    method: "POST",
    body: JSON.stringify(messageBody("nobody home")),
  });
  expect(refused.status).toBe(503);
  expect(await refused.text()).toContain("disabled by the operator");

  // Re-enabling A also wipes any cooldown that was recorded meanwhile.
  ctx.app.accounts.setCooldown(accountA, clock.now() + 60_000, "test cooldown");
  expect((await listAccounts(ctx)).find((account) => account.id === accountA)?.state).toBe("disabled");
  const enabled = await setEnabled(accountA, true);
  expect(enabled.body.account).toMatchObject({ enabled: true, state: "active" });
  expect((await listAccounts(ctx)).find((account) => account.id === accountA)?.cooldown_until).toBeUndefined();

  const back = await api(ctx, "/v1/messages", {
    apiKey: "gateway-key",
    method: "POST",
    body: JSON.stringify(messageBody("welcome back")),
  });
  expect(back.status).toBe(200);
  expect(ctx.sdk.createCalls.at(-1)?.apiKey).toBe("cursor-a");

  const invalid = await fetch(`${ctx.url}/v0/management/accounts/enabled`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: accountA, enabled: "yes" }),
  });
  expect(invalid.status).toBe(422);
  expect(((await invalid.json()) as { error: { type: string } }).error.type).toBe("invalid_request");
});

test("managed model catalog returns the union from every configured account", async () => {
  ctx = await startTestApp({
    config: { authMode: "managed", gatewayAccessKey: "gateway-key", managedCursorKey: undefined },
    sdk: {
      modelsByApiKey: {
        "cursor-a": { ok: true, models: [{ id: "claude-sonnet-4-6" }, { id: "shared-model" }] },
        "cursor-b": { ok: true, models: [{ id: "grok-4.6" }, { id: "shared-model" }] },
      },
    },
  });
  await addAccount(ctx, "cursor-a");
  await addAccount(ctx, "cursor-b");

  const response = await api(ctx, "/v1/models", { apiKey: "gateway-key" });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { account_pool_size: number; data: Array<{ id: string }> };
  expect(body.account_pool_size).toBe(2);
  expect(body.data.map((model) => model.id).sort()).toEqual([
    "claude-sonnet-4-6",
    "grok-4.6",
    "shared-model",
  ]);
});

test("a busy compatible account returns 429 instead of model-unavailable", async () => {
  ctx = await startTestApp({
    config: {
      authMode: "managed",
      gatewayAccessKey: "gateway-key",
      managedCursorKey: undefined,
      globalActiveRuns: 4,
      perCredentialActiveRuns: 1,
      firstEventTimeoutMs: 10_000,
    },
    sdk: {
      modelsByApiKey: {
        "cursor-a": { ok: true, models: [{ id: "composer-2.5" }] },
        "cursor-b": { ok: true, models: [{ id: "grok-4.6" }] },
      },
      agentScripts: [[[ { type: "hang" } ]]],
    },
  });
  await addAccount(ctx, "cursor-a");
  await addAccount(ctx, "cursor-b");

  const abort = new AbortController();
  const hanging = api(ctx, "/v1/messages", {
    apiKey: "gateway-key",
    method: "POST",
    signal: abort.signal,
    body: JSON.stringify(messageBody("occupy composer")),
  });
  try {
    await waitFor(
      () => [...ctx!.app.registry.sessions.values()].some((session) => session.state === "running"),
      "compatible account to become busy",
    );
    const blocked = await api(ctx, "/v1/messages", {
      apiKey: "gateway-key",
      method: "POST",
      body: JSON.stringify(messageBody("retry composer")),
    });
    expect(blocked.status).toBe(429);
    expect(((await blocked.json()) as { error: { type: string } }).error.type).toBe("rate_limited");
  } finally {
    abort.abort();
    await hanging.catch(() => undefined);
  }
});

test("tool continuation remains pinned to the original account while another session rotates", async () => {
  ctx = await startTestApp({
    config: { authMode: "managed", gatewayAccessKey: "gateway-key", managedCursorKey: undefined },
    sdk: {
      modelsByApiKey: {
        "cursor-a": { ok: true, models: [{ id: "composer-2.5" }] },
        "cursor-b": { ok: true, models: [{ id: "composer-2.5" }] },
      },
      agentScripts: [
        [
          [
            { type: "tools", calls: [{ name: "lookup", input: { q: "weather" }, id: "sdk_pool_tool" }] },
            { type: "text", chunks: ["continued"] },
          ],
        ],
        [[{ type: "text", chunks: ["other"] }]],
      ],
    },
  });
  await addAccount(ctx, "cursor-a");
  await addAccount(ctx, "cursor-b");

  const first = await api(ctx, "/v1/messages", {
    apiKey: "gateway-key",
    method: "POST",
    body: JSON.stringify(messageBody("use tool", [weatherTool()])),
  });
  const firstBody = (await first.json()) as { content: Array<{ type: string; id?: string }> };
  const toolId = firstBody.content.find((item) => item.type === "tool_use")?.id;
  expect(toolId).toBeTruthy();

  const other = await api(ctx, "/v1/messages", {
    apiKey: "gateway-key",
    method: "POST",
    body: JSON.stringify(messageBody("other session")),
  });
  expect(other.status).toBe(200);

  const continued = await api(ctx, "/v1/messages", {
    apiKey: "gateway-key",
    method: "POST",
    body: JSON.stringify(messageBody([
      { type: "tool_result", tool_use_id: toolId, content: "sunny" },
    ], [weatherTool()])),
  });
  expect(continued.status).toBe(200);
  expect(ctx.sdk.agents.map((agent) => agent.input.apiKey)).toEqual(["cursor-a", "cursor-b"]);
  expect(ctx.sdk.agents[0]?.runs[0]?.capturedToolResults).toEqual(["sunny"]);
});

test("managed mode rejects the wrong gateway key and reports an empty pool", async () => {
  ctx = await startTestApp({
    config: { authMode: "managed", gatewayAccessKey: "gateway-key", managedCursorKey: undefined },
  });
  const wrong = await api(ctx, "/v1/messages", {
    apiKey: "cursor-account-key",
    method: "POST",
    body: JSON.stringify(messageBody()),
  });
  expect(wrong.status).toBe(401);

  const empty = await api(ctx, "/v1/messages", {
    apiKey: "gateway-key",
    method: "POST",
    body: JSON.stringify(messageBody()),
  });
  expect(empty.status).toBe(503);
  expect(await empty.text()).toContain("No Cursor accounts are configured");
});

test("managed account endpoint returns every account without exposing raw Cursor keys", async () => {
  ctx = await startTestApp({
    config: { authMode: "managed", gatewayAccessKey: "gateway-key", managedCursorKey: undefined },
    sdk: {
      accountsByApiKey: {
        "cursor-a": { ok: true, identity: { apiKeyName: "A" } },
        "cursor-b": { ok: true, identity: { apiKeyName: "B" } },
      },
    },
  });
  await addAccount(ctx, "cursor-a");
  await addAccount(ctx, "cursor-b");
  const response = await api(ctx, "/v1/account", { apiKey: "gateway-key" });
  const text = await response.text();
  expect(response.status).toBe(200);
  expect(text).not.toContain("cursor-a");
  expect(text).not.toContain("cursor-b");
  const body = JSON.parse(text) as { pool: boolean; account_count: number; accounts: unknown[] };
  expect(body).toMatchObject({ pool: true, account_count: 2 });
  expect(body.accounts).toHaveLength(2);
});

test("restart recovery resolves the original account from persisted lineage", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "cursor-sdk2api-managed-pool-"));
  ctx = await startTestApp({
    config: { authMode: "managed", gatewayAccessKey: "gateway-key", managedCursorKey: undefined, stateDir },
    sdk: {
      modelsByApiKey: {
        "cursor-a": { ok: true, models: [{ id: "composer-2.5" }] },
      },
      scripts: [[
        { type: "tools", calls: [{ name: "lookup", input: { q: "weather" }, id: "sdk_restart_tool" }] },
      ]],
    },
  });
  await addAccount(ctx, "cursor-a");
  const first = await api(ctx, "/v1/messages", {
    apiKey: "gateway-key",
    method: "POST",
    body: JSON.stringify(messageBody("use tool", [weatherTool()])),
  });
  const firstBody = (await first.json()) as { content: Array<{ type: string; id?: string }> };
  const toolId = firstBody.content.find((item) => item.type === "tool_use")?.id;
  expect(toolId).toBeTruthy();
  await closeTestApp(ctx);
  ctx = undefined;

  ctx = await startTestApp({
    config: { authMode: "managed", gatewayAccessKey: "gateway-key", managedCursorKey: undefined, stateDir },
    sdk: { scripts: [[{ type: "text", chunks: ["recovered"] }]] },
  });
  const continued = await api(ctx, "/v1/messages", {
    apiKey: "gateway-key",
    method: "POST",
    body: JSON.stringify(messageBody([
      { type: "tool_result", tool_use_id: toolId, content: "sunny" },
    ], [weatherTool()])),
  });
  expect(continued.status).toBe(200);
  expect(ctx.sdk.lastResume?.apiKey).toBe("cursor-a");
});

test("full transcript cold-branches a tool continuation when its managed account was removed", async () => {
  ctx = await startTestApp({
    config: { authMode: "managed", gatewayAccessKey: "gateway-key", managedCursorKey: undefined },
    sdk: {
      modelsByApiKey: {
        "cursor-a": { ok: true, models: [{ id: "composer-2.5" }] },
        "cursor-b": { ok: true, models: [{ id: "composer-2.5" }] },
      },
      agentScripts: [
        [[{ type: "tools", calls: [{ name: "lookup", input: { q: "weather" } }] }]],
        [[
          { type: "tools", calls: [{ name: "lookup", input: { q: "weather" } }] },
          { type: "text", chunks: ["recovered-on-b"] },
        ]],
      ],
    },
  });
  const accountA = await addAccount(ctx, "cursor-a");
  await addAccount(ctx, "cursor-b");
  const opened = await api(ctx, "/v1/messages", {
    apiKey: "gateway-key",
    method: "POST",
    body: JSON.stringify(messageBody("use tool", [weatherTool()])),
  });
  const openedBody = (await opened.json()) as {
    content: Array<{ type: string; id?: string; name?: string; input?: unknown }>;
  };
  const call = openedBody.content.find((item) => item.type === "tool_use");
  expect(ctx.sdk.agents[0]?.input.apiKey).toBe("cursor-a");
  expect(ctx.app.accounts.remove(accountA)).toBe(true);

  const continued = await api(ctx, "/v1/messages", {
    apiKey: "gateway-key",
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 64,
      tools: [weatherTool()],
      messages: [
        { role: "user", content: "use tool" },
        { role: "assistant", content: [call] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: call?.id, content: "sunny" }] },
      ],
    }),
  });
  expect(continued.status).toBe(200);
  const body = (await continued.json()) as { content: Array<{ text?: string }> };
  expect(body.content.some((item) => item.text === "recovered-on-b")).toBe(true);
  expect(ctx.sdk.agents[1]?.input.apiKey).toBe("cursor-b");
  expect(ctx.sdk.agents[1]?.runs[0]?.capturedToolResults).toEqual(["sunny"]);
});

test("completed follow-up after restart stays on its original account", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "cursor-sdk2api-managed-follow-up-"));
  const modelsByApiKey = {
    "cursor-a": { ok: true as const, models: [{ id: "composer-2.5" }] },
    "cursor-b": { ok: true as const, models: [{ id: "composer-2.5" }] },
  };
  ctx = await startTestApp({
    config: { authMode: "managed", gatewayAccessKey: "gateway-key", managedCursorKey: undefined, stateDir },
    sdk: { modelsByApiKey },
  });
  await addAccount(ctx, "cursor-a");
  await addAccount(ctx, "cursor-b");
  const advance = await api(ctx, "/v1/messages", {
    apiKey: "gateway-key",
    method: "POST",
    body: JSON.stringify(messageBody("advance round robin")),
  });
  expect(advance.status).toBe(200);
  const first = await api(ctx, "/v1/messages", {
    apiKey: "gateway-key",
    method: "POST",
    body: JSON.stringify(messageBody("complete first turn")),
  });
  expect(first.status).toBe(200);
  const sessionId = ((await first.json()) as { cursor_session_id: string }).cursor_session_id;
  const originalKey = ctx.sdk.lastCreate?.apiKey;
  expect(originalKey).toBe("cursor-b");
  await closeTestApp(ctx);
  ctx = undefined;

  ctx = await startTestApp({
    config: { authMode: "managed", gatewayAccessKey: "gateway-key", managedCursorKey: undefined, stateDir },
    sdk: { modelsByApiKey },
  });
  const followUp = await api(ctx, "/v1/messages", {
    apiKey: "gateway-key",
    method: "POST",
    headers: { "x-cursor-session-id": sessionId },
    body: JSON.stringify(messageBody("continue after restart")),
  });
  expect(followUp.status).toBe(200);
  expect(ctx.sdk.lastResume?.apiKey).toBe(originalKey);
});
