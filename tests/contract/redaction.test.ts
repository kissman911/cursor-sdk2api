import { afterEach, expect, test } from "vitest";
import { assertNoSecretLeak } from "../../src/log.js";
import { redactSecrets } from "../../src/errors.js";
import { api, closeTestApp, startTestApp, weatherTool, type TestContext } from "../helpers/app.js";

let ctx: TestContext | undefined;

afterEach(async () => {
  if (ctx) await closeTestApp(ctx);
  ctx = undefined;
});

test("default logs do not contain credentials or tool payloads", async () => {
  const canaryKey = "sk-canary-SECRET-123456789";
  const canaryArg = "super-secret-tool-arg";
  ctx = await startTestApp({
    captureLogs: true,
    sdk: {
      scripts: [
        [
          { type: "tools", calls: [{ name: "lookup", input: { q: canaryArg } }] },
          { type: "text", chunks: ["ok"] },
        ],
      ],
    },
  });
  const first = await api(ctx, "/v1/messages", {
    apiKey: canaryKey,
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [{ role: "user", content: "do not log this prompt" }],
      tools: [weatherTool()],
    }),
  });
  const turn = (await first.json()) as { content: Array<{ type: string; id?: string }> };
  const id = turn.content.find((block) => block.type === "tool_use")?.id;
  await api(ctx, "/v1/messages", {
    apiKey: canaryKey,
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "secret-result" }] }],
    }),
  });
  const dumped = ctx.logs.join("\n");
  assertNoSecretLeak(dumped, [canaryKey, canaryArg, "secret-result", "do not log this prompt"]);
  expect(dumped).not.toContain(canaryKey);
});

test("error envelope never echoes the API key", async () => {
  ctx = await startTestApp();
  const res = await api(ctx, "/v1/messages", {
    apiKey: "sk-visible-should-not-echo",
    method: "POST",
    body: JSON.stringify({ model: "composer-2.5", messages: [] }),
  });
  const raw = await res.text();
  expect(raw).not.toContain("sk-visible-should-not-echo");
  expect(raw).toContain("request_id");
});

test("mid-stream SDK errors redact secret-like text", async () => {
  const canary = "sk-stream-secret-ABCDEFGH";
  ctx = await startTestApp({
    sdk: { scripts: [[{ type: "text", chunks: ["partial"] }, { type: "error", message: `failed ${canary}` }]] },
  });
  const res = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      stream: true,
      messages: [{ role: "user", content: "go" }],
    }),
  });
  const body = await res.text();
  expect(res.status).toBe(200);
  expect(body).toContain("event: error");
  expect(body).not.toContain(canary);
  expect(body).toContain("[redacted]");
});

test("session tokens and JWTs are redacted from public errors", () => {
  const segment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const jwt = `${segment({ alg: "RS256", typ: "JWT" })}.${segment({ sub: "auth0|user_01REDACTME", exp: 1 })}.sig`;
  const cookie = `user_01REDACTME000000000000000::${jwt}`;

  const plain = redactSecrets(`import failed for ${cookie} sorry`);
  expect(plain).toBe("import failed for [redacted] sorry");

  const encoded = redactSecrets(`cookie=${cookie.replace("::", "%3A%3A")};`);
  expect(encoded).not.toContain("user_01REDACTME");
  expect(encoded).not.toContain("eyJ");

  const bare = redactSecrets(`token ${jwt} rejected`);
  expect(bare).toBe("token [redacted] rejected");

  // Ordinary identifiers that merely start with user_ are left alone.
  expect(redactSecrets("user_id=42 user_01ABC")).toBe("user_id=42 user_01ABC");
});

test("proxy URL credentials are redacted from public errors", () => {
  const raw = "proxy failed at http://proxy-user:proxy-password@127.0.0.1:7890";
  const redacted = redactSecrets(raw);
  expect(redacted).not.toContain("proxy-user");
  expect(redacted).not.toContain("proxy-password");
  expect(redacted).toContain("http://[redacted]@");
});
