import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { CursorAccountPool } from "../auth/account-pool.js";
import {
  authorizeClient,
  managedAccountAuth,
  type AuthContext,
  type ClientAuthorization,
} from "../auth/credentials.js";
import { classifyQuotaExhaustion } from "../auth/quota-cooldown.js";
import { fetchCursorSandQuota } from "../account/cursor-dashboard.js";
import { readAccount } from "../account/service.js";
import {
  looksLikeSessionToken,
  mintUserApiKeyFromSessionToken,
  type MintUserApiKeyResult,
} from "../account/session-token.js";
import {
  accountAvailability,
  CursorAccountFileStore,
  type StoredCursorAccount,
} from "../account/file-store.js";
import {
  DEFAULT_RUNTIME_PROFILE,
  resolveRequestProfile,
  type RuntimeProfile,
} from "../core/runtime-profile.js";
import type { Clock } from "../clock.js";
import type { GatewayConfig } from "../config.js";
import { CompactAnchorStore } from "../core/compact-anchor.js";
import { RunCoordinator } from "../core/run-coordinator.js";
import type { PumpBoundary } from "../core/event-pump.js";
import { LineageStore } from "../core/lineage-store.js";
import { OrdinaryTurnJournal } from "../core/ordinary-turn-journal.js";
import { RuntimeLedger } from "../core/runtime-ledger.js";
import type { SandLoaderHealth } from "../sdk/sand-loader.js";
import { inspectSandInference } from "../sdk/sand-inference-runtime.js";
import { SessionRegistry } from "../core/session-registry.js";
import {
  authenticationError,
  forbiddenError,
  GatewayError,
  invalidRequest,
  notFound,
  rateLimited,
  redactSecrets,
  sessionLost,
  toPublicErrorBody,
  upstreamError,
} from "../errors.js";
import { requestId as newRequestId } from "../ids.js";
import type { Logger } from "../log.js";
import { parseMessagesRequest } from "../protocols/anthropic/parse.js";
import type { ParsedMessages } from "../protocols/anthropic/types.js";
import { estimateAnthropicInputTokens } from "../protocols/anthropic/count-tokens.js";
import { writeSseError } from "../protocols/anthropic/sse.js";
import { parseChatCompletionsRequest } from "../protocols/openai-chat/parse.js";
import { writeChatStreamError } from "../protocols/openai-chat/sse.js";
import { createChatWriterFactory } from "../protocols/openai-chat/writer.js";
import {
  bindCompactContinuation,
  mintLocalCompact,
  writeLocalCompactResponse,
} from "../protocols/openai-responses/compact.js";
import { parseResponsesRequest } from "../protocols/openai-responses/parse.js";
import { writeResponsesStreamError } from "../protocols/openai-responses/sse.js";
import { createResponsesWriterFactory } from "../protocols/openai-responses/writer.js";
import type { SdkRuntime } from "../sdk/port.js";
import { ModelCatalog } from "../sdk/catalog.js";
import { headerValue, readJsonBody, requestPath, sendError, sendJson, sendOpenAIError } from "./http-util.js";
import { serveConsole } from "./console.js";

export interface App {
  config: GatewayConfig;
  registry: SessionRegistry;
  coordinator: RunCoordinator;
  catalog: ModelCatalog;
  lineage: LineageStore;
  ordinaryJournal: OrdinaryTurnJournal;
  accounts: CursorAccountFileStore;
  sdk: SdkRuntime;
  ledger?: RuntimeLedger;
  sandHealth: SandLoaderHealth;
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  listen(): Server;
  beginShutdown(): void;
  close(): void;
}

async function listManagedModels(accounts: StoredCursorAccount[], catalog: ModelCatalog): Promise<{
  status: "ok" | "unavailable" | "stale";
  reason?: string;
  models: Awaited<ReturnType<ModelCatalog["list"]>>["models"];
  stale: boolean;
}> {
  if (accounts.length === 0) {
    return {
      status: "unavailable",
      reason: "cursor_account_pool_empty",
      models: [],
      stale: false,
    };
  }
  const results = await Promise.all(
    accounts.map((account) => catalog.list(account.apiKey, managedAccountAuth(account.apiKey).fingerprint)),
  );
  const models = new Map<string, Awaited<ReturnType<ModelCatalog["list"]>>["models"][number]>();
  for (const listed of results) {
    for (const model of listed.models) {
      if (!models.has(model.id)) models.set(model.id, model);
    }
  }
  const hasOk = results.some((listed) => listed.status === "ok");
  const hasStale = results.some((listed) => listed.status === "stale");
  const status = hasOk ? "ok" : hasStale ? "stale" : "unavailable";
  return {
    status,
    ...(status === "unavailable"
      ? { reason: results.map((listed) => listed.reason).find(Boolean) ?? "cursor_models_list_unavailable" }
      : {}),
    models: [...models.values()],
    stale: !hasOk && hasStale,
  };
}

function managedPreSemanticFailureCanFailover(error: unknown): boolean {
  if (!(error instanceof GatewayError)) return true;
  if (
    error.code === "authentication_error" ||
    error.code === "forbidden" ||
    error.code === "rate_limited" ||
    error.code === "cursor_timeout" ||
    error.code === "cursor_upstream_error"
  ) {
    return true;
  }
  return error.httpStatus >= 500;
}

function responseStarted(res: ServerResponse): boolean {
  return res.headersSent || res.writableEnded || res.destroyed;
}

function staleCredentialSessionError(error: unknown): boolean {
  if (!(error instanceof GatewayError) || error.code !== "authentication_error") return false;
  return !/invalid|revoked|expired|disabled|unauthorized api key/i.test(error.message);
}

function sessionTokenImportError(result: Extract<MintUserApiKeyResult, { ok: false }>): GatewayError {
  switch (result.reason) {
    case "session_token_malformed":
      return invalidRequest(
        "session_token is not a Cursor session token (expected user_...::<jwt>, the WorkosCursorSessionToken cookie value)",
      );
    case "session_token_expired":
      return invalidRequest("session_token has expired; sign in to cursor.com again and copy a fresh token");
    // Wording avoids "API Key <word>", which the legacy redactor would blank out.
    case "session_token_rejected":
      return authenticationError(
        `Cursor rejected the session token (status ${result.status ?? "unknown"}); sign in to cursor.com again or import a User API Key`,
      );
    case "mint_invalid_response":
      return upstreamError("Cursor Dashboard returned an invalid response to CreateUserApiKey", 502);
    case "mint_unavailable":
    default:
      return upstreamError(
        `Cursor Dashboard could not mint a key for this session token${result.status ? ` (status ${result.status})` : ""}`,
        502,
      );
  }
}

export function createApp(input: {
  config: GatewayConfig;
  sdk: SdkRuntime;
  clock: Clock;
  logger: Logger;
  workspaceDir: string;
  beforeApplyBoundary?: (boundary: PumpBoundary) => Promise<void>;
  fetchSandQuota?: typeof fetchCursorSandQuota;
  sandHealth?: SandLoaderHealth;
  assertSandAccess?: (apiKey: string) => Promise<void>;
  /** Test seam: exchange a session token for a User API Key without the network. */
  mintApiKeyFromSessionToken?: (token: string) => Promise<MintUserApiKeyResult>;
}): App {
  const { config, sdk, clock, logger, workspaceDir, beforeApplyBoundary } = input;
  const fetchSandQuota = input.fetchSandQuota ?? fetchCursorSandQuota;
  const mintApiKeyFromSessionToken =
    input.mintApiKeyFromSessionToken ?? ((token: string) => mintUserApiKeyFromSessionToken(token));
  const sandHealth = input.sandHealth ?? inspectSandInference();
  const assertSandAccess = input.assertSandAccess ?? (async (apiKey: string) => {
    const quota = await fetchSandQuota(apiKey);
    if (!quota.available) throw forbiddenError("Sand is unavailable until Grok Bot access is granted");
  });
  const registry = new SessionRegistry(clock, config.instanceId, {
    globalActiveRuns: config.globalActiveRuns,
    perCredentialActiveRuns: config.perCredentialActiveRuns,
    maxAwaitingSessions: config.maxAwaitingSessions,
    sessionTtlMs: config.sessionTtlMs,
    replayTtlMs: config.replayTtlMs,
    runDeadlineMs: config.runDeadlineMs,
  });
  const lineage = new LineageStore(config.stateDir, clock);
  const compactStore = new CompactAnchorStore(config.stateDir, clock);
  const ordinaryJournal = new OrdinaryTurnJournal(join(config.stateDir, "ordinary-turns.json"), {
    now: () => clock.now(),
  });
  const ledger = config.runtimeLedgerV2
    ? RuntimeLedger.open(config.stateDir, { clock, migrateLegacy: true })
    : undefined;
  const coordinator = new RunCoordinator({
    config,
    sdk,
    registry,
    clock,
    logger,
    workspaceDir,
    lineage,
    ordinaryJournal,
    ledger,
    sandHealth,
    assertSandAccess,
    beforeApplyBoundary,
  });
  const catalog = new ModelCatalog(sdk, clock, config.catalogCacheMs);
  const accounts = new CursorAccountFileStore(config.stateDir, config.managedCursorKey);
  const accountPool = new CursorAccountPool();
  const accountPayload = (apiKey: string, defaultProfile?: RuntimeProfile) =>
    readAccount(sdk, apiKey, {
      fetchSandQuota,
      defaultProfile: defaultProfile ?? config.runtimePolicy.defaultProfile ?? DEFAULT_RUNTIME_PROFILE,
      sandLoaderReady: sandHealth.ready,
    });
  const publicAccount = (account: StoredCursorAccount) => {
    const availability = accountAvailability(account, clock.now());
    return {
      id: account.id,
      key_hint: account.keyHint,
      added_at: account.addedAt,
      default_profile: account.defaultProfile,
      enabled: account.enabled,
      state: availability.available ? "active" : availability.reason,
      ...(account.disabledAt ? { disabled_at: account.disabledAt } : {}),
      ...(account.cooldownUntil ? { cooldown_until: account.cooldownUntil } : {}),
      ...(account.cooldownReason ? { cooldown_reason: account.cooldownReason } : {}),
    };
  };

  /**
   * Remember that an account has no quota left so new sessions stop landing on
   * it. Bound sessions keep their account; only pool selection changes.
   */
  const restAccountAfterQuotaFailure = (auth: AuthContext, error: unknown): void => {
    if (auth.mode !== "managed") return;
    const exhaustion = classifyQuotaExhaustion(error, config.accountQuotaCooldownMs);
    if (!exhaustion) return;
    const account = accounts.findByFingerprint(auth.fingerprint);
    if (!account) return;
    const until = clock.now() + exhaustion.cooldownMs;
    accounts.setCooldown(account.id, until, exhaustion.reason);
    logger.warn(
      {
        account_id: account.id,
        cooldown_until: new Date(until).toISOString(),
        cooldown_ms: exhaustion.cooldownMs,
        reset_hint: exhaustion.fromHint,
      },
      "managed account rested after quota exhaustion",
    );
  };

  const boundCredentialFingerprint = (parsed: ParsedMessages, sessionHint?: string): string | undefined => {
    if (parsed.continuation) {
      const ids = parsed.continuation.map((result) => result.toolUseId);
      const lookup = registry.lookupByToolIds(ids);
      if (!lookup.mixed && lookup.session) return lookup.session.credentialFingerprint;
      const record = lineage.findByToolIds(ids);
      if (record) return record.credentialFingerprint;
    }
    if (sessionHint) {
      return registry.get(sessionHint)?.credentialFingerprint ?? lineage.get(sessionHint)?.credentialFingerprint;
    }
    return undefined;
  };

  const resolveManagedAuth = async (
    parsed?: ParsedMessages,
    sessionHint?: string,
    excludedFingerprints: ReadonlySet<string> = new Set(),
  ): Promise<AuthContext> => {
    const boundFingerprint = parsed ? boundCredentialFingerprint(parsed, sessionHint) : undefined;
    if (boundFingerprint && !excludedFingerprints.has(boundFingerprint)) {
      const bound = accounts.findByFingerprint(boundFingerprint);
      if (bound) return managedAccountAuth(bound.apiKey, bound.defaultProfile);
      // A self-contained tool continuation can cold-branch from its full
      // transcript when the originally bound managed account was removed.
      // Completed session follow-ups still require their original account.
      if (!parsed?.continuation) {
        throw sessionLost("The Cursor account bound to this session is no longer configured");
      }
    }

    const stored = accounts.list();
    if (stored.length === 0) {
      throw upstreamError("No Cursor accounts are configured in the gateway pool", 503);
    }
    const now = clock.now();
    const configured = stored.filter((account) => accountAvailability(account, now).available);
    if (configured.length === 0) {
      const resting = stored
        .map((account) => accountAvailability(account, now))
        .filter((availability): availability is Extract<typeof availability, { reason: "cooldown" }> =>
          !availability.available && availability.reason === "cooldown");
      if (resting.length === 0) {
        throw upstreamError("Every Cursor account in the gateway pool is disabled by the operator", 503);
      }
      const earliest = new Date(Math.min(...resting.map((availability) => availability.until))).toISOString();
      throw rateLimited(
        `Every enabled Cursor account has exhausted its quota; the earliest one becomes available again at ${earliest}`,
      );
    }
    let candidates = configured;
    if (parsed) {
      const checked = await Promise.all(
        configured.map(async (account) => ({
          account,
          catalog: await catalog.list(account.apiKey, managedAccountAuth(account.apiKey).fingerprint),
        })),
      );
      candidates = checked
        .filter(({ catalog: listed }) => listed.models.some((model) => model.id === parsed.model))
        .map(({ account }) => account);
      if (candidates.length === 0) {
        if (checked.some(({ catalog: listed }) => listed.status === "unavailable")) {
          throw upstreamError("Cursor model catalogs are unavailable across the configured account pool", 503);
        }
        throw forbiddenError(`Model ${parsed.model} is unavailable across the configured Cursor accounts`);
      }
    }

    candidates = candidates.filter(
      (account) =>
        !excludedFingerprints.has(managedAccountAuth(account.apiKey).fingerprint) &&
        registry.activeRunCountForCredential(managedAccountAuth(account.apiKey).fingerprint) <
        config.perCredentialActiveRuns,
    );
    if (candidates.length === 0) {
      throw rateLimited(
        parsed
          ? `All Cursor accounts compatible with ${parsed.model} are at active run capacity`
          : "All Cursor accounts are at active run capacity",
      );
    }

    const selected = accountPool.pick(candidates, parsed?.model ?? "account");
    if (!selected) throw upstreamError("No Cursor account is available", 503);
    return managedAccountAuth(selected.apiKey, selected.defaultProfile);
  };

  const resolveAuth = async (
    client: ClientAuthorization,
    parsed?: ParsedMessages,
    sessionHint?: string,
    excludedFingerprints: ReadonlySet<string> = new Set(),
  ): Promise<AuthContext> => client.mode === "byok"
    ? client.auth
    : resolveManagedAuth(parsed, sessionHint, excludedFingerprints);
  const credentialProbes = new Map<string, Promise<"valid" | "invalid" | "unavailable">>();
  const probeCredential = (auth: AuthContext): Promise<"valid" | "invalid" | "unavailable"> => {
    const existing = credentialProbes.get(auth.fingerprint);
    if (existing) return existing;
    const probe = sdk.probeCredential(auth.cursorApiKey);
    credentialProbes.set(auth.fingerprint, probe);
    void probe.finally(() => {
      if (credentialProbes.get(auth.fingerprint) === probe) credentialProbes.delete(auth.fingerprint);
    }).catch(() => undefined);
    return probe;
  };

  const runWithProviderRecovery = async (
    res: ServerResponse,
    client: ClientAuthorization,
    parsed: ParsedMessages,
    sessionHint: string | undefined,
    run: (auth: AuthContext) => Promise<void>,
  ): Promise<void> => {
    const first = await resolveAuth(client, parsed, sessionHint);
    try {
      await run(first);
      return;
    } catch (initialError) {
      let error = initialError;
      restAccountAfterQuotaFailure(first, error);
      if (!responseStarted(res) && staleCredentialSessionError(error)) {
        const probe = await probeCredential(first);
        if (probe === "valid") {
          logger.warn(
            { model: parsed.model, error_type: "authentication_error" },
            "retrying pre-semantic Cursor request after credential probe",
          );
          try {
            await run(first);
            return;
          } catch (retryError) {
            error = retryError;
          }
        }
      }
      if (
        client.mode !== "managed" ||
        responseStarted(res) ||
        !managedPreSemanticFailureCanFailover(error)
      ) {
        throw error;
      }
      let alternate: AuthContext;
      try {
        alternate = await resolveAuth(client, parsed, sessionHint, new Set([first.fingerprint]));
      } catch {
        throw error;
      }
      logger.warn(
        { model: parsed.model, error_type: error instanceof GatewayError ? error.code : "cursor_upstream_error" },
        "retrying pre-semantic Cursor request on another managed account",
      );
      try {
        await run(alternate);
      } catch (alternateError) {
        restAccountAfterQuotaFailure(alternate, alternateError);
        throw alternateError;
      }
    }
  };

  const runtimeProfileFor = (req: IncomingMessage, client: ClientAuthorization, auth?: AuthContext) => {
    try {
      return resolveRequestProfile({
        header: headerValue(req, "x-cursor-runtime-profile"),
        policy: config.runtimePolicy,
        authMode: client.mode,
        accountDefaultProfile: auth?.defaultProfile,
      });
    } catch (error) {
      throw invalidRequest(error instanceof Error ? error.message : "Invalid runtime profile");
    }
  };

  let shuttingDown = false;
  const sweepTimer = setInterval(() => {
    try {
      registry.sweep();
      lineage.sweep();
      compactStore.sweep();
      coordinator.sweepOrdinaryState();
    } catch {
      // sweep must not crash the process
    }
  }, Math.max(20, config.sweepIntervalMs));
  sweepTimer.unref();

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const requestId = headerValue(req, "x-request-id") || newRequestId();
    const path = requestPath(req);
    const method = (req.method ?? "GET").toUpperCase();
    try {
      if (
        (method === "GET" || method === "HEAD") &&
        serveConsole(res, path, requestId, config.consoleDir, method === "HEAD")
      ) {
        return;
      }

      if (method === "GET" && path === "/health") {
        sendJson(
          res,
          200,
          {
            status: shuttingDown ? "not_ready" : "ok",
            service: "cursor-sdk2api",
            version: config.version,
            sdk_version:
              sdk.sdkVersion && sdk.sdkVersion !== "unavailable" ? sdk.sdkVersion : config.sdkVersion,
            network: {
              proxy_configured: config.proxyConfigured,
              agent_transport: config.agentTransport,
              fetch_transport: config.fetchTransport,
            },
            runtime: "local",
            instance_id: config.instanceId,
            profiles: {
              default: config.runtimePolicy.defaultProfile,
              sdk: {
                ready: true,
                sdk_version:
                  sdk.sdkVersion && sdk.sdkVersion !== "unavailable" ? sdk.sdkVersion : config.sdkVersion,
              },
              sand: {
                ready: sandHealth.ready,
                sdk_version: sandHealth.sdk_version,
                patch_contract_version: sandHealth.patch_contract_version,
                ...(sandHealth.transport ? { transport: sandHealth.transport } : {}),
                ...(sandHealth.client_version ? { client_version: sandHealth.client_version } : {}),
                ...(sandHealth.capabilities ? { capabilities: sandHealth.capabilities } : {}),
                ...(sandHealth.ready || !sandHealth.reason ? {} : { reason: sandHealth.reason }),
              },
            },
            readiness: {
              accepting_sessions: !shuttingDown && !registry.shuttingDown,
              shutting_down: shuttingDown,
            },
            capabilities: {
              ...config.capabilities,
              agent_resume: config.capabilities.agent_resume,
              pending_tool_restart_resume: config.capabilities.pending_tool_restart_resume,
              ordinary_turn_coordinator: config.ordinaryTurnCoordinator,
              store_backend: config.capabilities.store_backend ?? "jsonl",
            },
            verification: {
              live_smoke: false,
              chat_completions: "contract_tested_unverified_live",
              responses: "contract_tested_unverified_live",
              streaming: "sdk_onDelta",
              thinking: "implemented_unverified_live",
              images: "implemented_unverified_live",
              parallel_tools: "implemented_unverified_live",
            },
          },
          requestId,
        );
        return;
      }

      if (path === "/v0/management/accounts/probe" && method === "GET") {
        const id = new URL(req.url ?? "/", "http://localhost").searchParams.get("id")?.trim() ?? "";
        if (!id) throw invalidRequest("id is required");
        const stored = accounts.get(id);
        if (!stored) throw notFound("Persistent account was not found");
        const auth = managedAccountAuth(stored.apiKey, stored.defaultProfile);
        const [models, account] = await Promise.all([
          catalog.list(stored.apiKey, auth.fingerprint),
          accountPayload(stored.apiKey, stored.defaultProfile),
        ]);
        sendJson(res, 200, {
          models: {
            object: "list",
            data: models.models.map((model) => ({
              id: model.id,
              object: "model",
              display_name: model.displayName,
              description: model.description,
              parameters: model.parameters,
              variants: model.variants,
            })),
            status: models.status,
            ...(models.reason ? { reason: models.reason } : {}),
            cache: { stale: models.stale, ...(models.stale ? { reason: models.reason ?? "refresh_failed" } : {}) },
          },
          account,
        }, requestId);
        return;
      }

      if (path === "/v0/management/accounts/run" && method === "POST") {
        const body = await readJsonBody(req, config.maxBodyBytes) as {
          account_id?: unknown;
          protocol?: unknown;
          request?: unknown;
        } | undefined;
        const id = typeof body?.account_id === "string" ? body.account_id.trim() : "";
        const protocol = body?.protocol;
        if (!id) throw invalidRequest("account_id is required");
        const stored = accounts.get(id);
        if (!stored) throw notFound("Persistent account was not found");
        if (!body || body.request === undefined) throw invalidRequest("request is required");
        const auth = managedAccountAuth(stored.apiKey, stored.defaultProfile);
        if (protocol === "messages") {
          const parsed = parseMessagesRequest(body.request);
          await coordinator.handleMessages(req, res, auth, parsed, requestId);
          return;
        }
        if (protocol === "chat") {
          const chat = parseChatCompletionsRequest(body.request);
          await coordinator.handleMessages(
            req,
            res,
            auth,
            chat.parsed,
            requestId,
            undefined,
            createChatWriterFactory({ includeUsage: chat.includeUsage }),
          );
          return;
        }
        if (protocol === "responses") {
        const responses = parseResponsesRequest(body.request, {
          hostedSearchMode: config.runtimePolicy.hostedSearchMode,
        });
          await coordinator.handleMessages(req, res, auth, responses.parsed, requestId, undefined, createResponsesWriterFactory());
          return;
        }
        throw invalidRequest("protocol must be messages, chat, or responses");
      }

      if (path === "/v0/management/accounts/default_profile" && method === "PUT") {
        const body = await readJsonBody(req, config.maxBodyBytes) as {
          id?: unknown;
          default_profile?: unknown;
        } | undefined;
        const id = typeof body?.id === "string" ? body.id.trim() : "";
        if (!id) throw invalidRequest("id is required");
        const stored = accounts.get(id);
        if (!stored) throw notFound("Persistent account was not found");
        const rawProfile = typeof body?.default_profile === "string" ? body.default_profile.trim().toLowerCase() : "";
        if (rawProfile !== "sdk" && rawProfile !== "sand") {
          throw invalidRequest("default_profile is invalid");
        }
        const grokBot = await fetchSandQuota(stored.apiKey).catch(() => ({ available: false as const }));
        if (rawProfile === "sand" && !grokBot.available) {
          throw invalidRequest("Sand is unavailable until Grok Bot access is granted");
        }
        const updated = accounts.setDefaultProfile(id, rawProfile);
        if (!updated) throw notFound("Persistent account was not found");
        sendJson(res, 200, {
          ...publicAccount(updated),
          account: await accountPayload(updated.apiKey, updated.defaultProfile),
        }, requestId);
        return;
      }

      if (path === "/v0/management/accounts/enabled" && method === "PUT") {
        const body = await readJsonBody(req, config.maxBodyBytes) as {
          id?: unknown;
          enabled?: unknown;
        } | undefined;
        const id = typeof body?.id === "string" ? body.id.trim() : "";
        if (!id) throw invalidRequest("id is required");
        if (typeof body?.enabled !== "boolean") throw invalidRequest("enabled must be a boolean");
        const updated = accounts.setEnabled(id, body.enabled, clock.now());
        if (!updated) throw notFound("Persistent account was not found");
        logger.info(
          { account_id: updated.id, enabled: updated.enabled },
          updated.enabled ? "managed account enabled by operator" : "managed account disabled by operator",
        );
        sendJson(res, 200, { account: publicAccount(updated) }, requestId);
        return;
      }

      if (path === "/v0/management/accounts") {
        if (method === "GET") {
          sendJson(
            res,
            200,
            {
              accounts: accounts.list().map(publicAccount),
            },
            requestId,
          );
          return;
        }
        if (method === "POST") {
          const body = await readJsonBody(req, config.maxBodyBytes) as
            | { api_key?: unknown; session_token?: unknown }
            | undefined;
          const apiKey = typeof body?.api_key === "string" ? body.api_key.trim() : "";
          const explicitToken = typeof body?.session_token === "string" ? body.session_token.trim() : "";
          // A cookie value pasted into the API-key field still takes the mint path.
          const sessionToken = explicitToken || (apiKey && looksLikeSessionToken(apiKey) ? apiKey : "");
          if (sessionToken) {
            const minted = await mintApiKeyFromSessionToken(sessionToken);
            if (!minted.ok) throw sessionTokenImportError(minted);
            const account = accounts.add(minted.apiKey);
            logger.info({ account_id: account.id }, "managed account imported from a Cursor session token");
            sendJson(
              res,
              201,
              {
                account: publicAccount(account),
                minted_api_key: true,
                ...(minted.email ? { email: minted.email } : {}),
              },
              requestId,
            );
            return;
          }
          if (!apiKey) throw invalidRequest("Provide session_token (user_...::<jwt>) or api_key");
          const account = accounts.add(apiKey);
          sendJson(
            res,
            201,
            {
              account: publicAccount(account),
            },
            requestId,
          );
          return;
        }
        if (method === "DELETE") {
          const id = new URL(req.url ?? "/", "http://localhost").searchParams.get("id")?.trim() ?? "";
          if (!id) throw invalidRequest("id is required");
          if (!accounts.remove(id)) throw notFound("Persistent account was not found");
          sendJson(res, 200, { deleted: true }, requestId);
          return;
        }
      }

      if (method === "GET" && path === "/v1/models") {
        const client = authorizeClient(req, config);
        const listed = client.mode === "byok"
          ? await catalog.list(client.auth.cursorApiKey, client.auth.fingerprint)
          : await listManagedModels(accounts.list(), catalog);
        sendJson(
          res,
          listed.status === "unavailable" ? 200 : 200,
          {
            object: "list",
            data: listed.models.map((model) => ({
              id: model.id,
              object: "model",
              display_name: model.displayName,
              description: model.description,
              parameters: model.parameters,
              variants: model.variants,
            })),
            status: listed.status,
            ...(listed.reason ? { reason: listed.reason } : {}),
            cache: listed.stale
              ? { stale: true, reason: listed.reason ?? "refresh_failed" }
              : { stale: false },
            ...(client.mode === "managed" ? { account_pool_size: accounts.list().length } : {}),
          },
          requestId,
        );
        return;
      }

      if (method === "GET" && path === "/v1/account") {
        const client = authorizeClient(req, config);
        if (client.mode === "byok") {
          const account = await accountPayload(client.auth.cursorApiKey);
          sendJson(res, 200, account, requestId);
        } else {
          const configured = accounts.list();
          const details = await Promise.all(
            configured.map(async (account) => {
              const summary = publicAccount(account);
              return {
                id: account.id,
                key_hint: account.keyHint,
                enabled: summary.enabled,
                state: summary.state,
                ...(summary.cooldown_until ? { cooldown_until: summary.cooldown_until } : {}),
                account: await accountPayload(account.apiKey, account.defaultProfile),
              };
            }),
          );
          sendJson(res, 200, { pool: true, account_count: details.length, accounts: details }, requestId);
        }
        return;
      }

      if (method === "POST" && path === "/v1/messages/count_tokens") {
        authorizeClient(req, config);
        const body = await readJsonBody(req, config.maxBodyBytes);
        if (body === undefined) throw invalidRequest("JSON body is required");
        const parsed = parseMessagesRequest(body);
        res.setHeader("x-cursor-sdk2api-token-count", "estimated");
        sendJson(res, 200, { input_tokens: estimateAnthropicInputTokens(body, parsed) }, requestId);
        return;
      }

      if (method === "POST" && path === "/v1/messages") {
        const client = authorizeClient(req, config);
        const body = await readJsonBody(req, config.maxBodyBytes);
        if (body === undefined) throw invalidRequest("JSON body is required");
        const parsed = parseMessagesRequest(body);
        const sessionHint = headerValue(req, "x-cursor-session-id");
        await runWithProviderRecovery(res, client, parsed, sessionHint, (auth) =>
          coordinator.handleMessages(req, res, auth, parsed, requestId, sessionHint));
        return;
      }

      if (method === "POST" && path === "/v1/chat/completions") {
        const client = authorizeClient(req, config);
        const body = await readJsonBody(req, config.maxBodyBytes);
        if (body === undefined) throw invalidRequest("JSON body is required");
        const chat = parseChatCompletionsRequest(body);
        const sessionHint = headerValue(req, "x-cursor-session-id");
        await runWithProviderRecovery(res, client, chat.parsed, sessionHint, (auth) =>
          coordinator.handleMessages(
            req,
            res,
            auth,
            chat.parsed,
            requestId,
            sessionHint,
            createChatWriterFactory({ includeUsage: chat.includeUsage }),
          ));
        return;
      }

      if (method === "POST" && path === "/v1/responses") {
        const client = authorizeClient(req, config);
        const body = await readJsonBody(req, config.maxBodyBytes);
        if (body === undefined) throw invalidRequest("JSON body is required");
        const responses = parseResponsesRequest(body, {
          hostedSearchMode: config.runtimePolicy.hostedSearchMode,
        });
        const sessionHint = headerValue(req, "x-cursor-session-id");
        if (responses.compaction.trigger) {
          const auth = await resolveAuth(client, responses.parsed, sessionHint);
          const minted = mintLocalCompact({
            store: compactStore,
            account: auth.fingerprint,
            profile: runtimeProfileFor(req, client, auth),
            parsed: responses,
            sessionHint,
          });
          writeLocalCompactResponse({
            res,
            clock,
            requestId,
            stream: responses.parsed.stream,
            model: responses.parsed.model,
            token: minted.token,
            compactId: minted.record.compactId,
            sessionId: sessionHint,
          });
          return;
        }
        await runWithProviderRecovery(res, client, responses.parsed, sessionHint, (auth) => {
          let hint = sessionHint;
          if (responses.compaction.encryptedContent) {
            const bound = bindCompactContinuation({
              store: compactStore,
              token: responses.compaction.encryptedContent,
              account: auth.fingerprint,
              profile: runtimeProfileFor(req, client, auth),
              parsed: responses,
            });
            hint = sessionHint ?? bound.sessionId;
          }
          return coordinator.handleMessages(
            req,
            res,
            auth,
            responses.parsed,
            requestId,
            hint,
            createResponsesWriterFactory(),
          );
        });
        return;
      }

      if (method === "POST" && path === "/v1/responses/compact") {
        const client = authorizeClient(req, config);
        const body = await readJsonBody(req, config.maxBodyBytes);
        if (body === undefined) throw invalidRequest("JSON body is required");
        const responses = parseResponsesRequest(body, {
          hostedSearchMode: config.runtimePolicy.hostedSearchMode,
        });
        const sessionHint = headerValue(req, "x-cursor-session-id");
        const auth = await resolveAuth(client, responses.parsed, sessionHint);
        const minted = mintLocalCompact({
          store: compactStore,
          account: auth.fingerprint,
          profile: runtimeProfileFor(req, client, auth),
          parsed: responses,
          sessionHint,
        });
        writeLocalCompactResponse({
          res,
          clock,
          requestId,
          stream: responses.parsed.stream,
          model: responses.parsed.model,
          token: minted.token,
          compactId: minted.record.compactId,
          sessionId: sessionHint,
        });
        return;
      }

      throw notFound(`No route for ${method} ${path}`);
    } catch (error) {
      logger.warn(
        {
          request_id: requestId,
          path,
          method,
          status: error instanceof GatewayError ? error.httpStatus : 502,
          error_type: error instanceof GatewayError ? error.code : "cursor_upstream_error",
          error: redactSecrets(error instanceof Error ? error.message : String(error ?? "Unexpected error")),
        },
        "request failed",
      );
      if (res.writableEnded || res.destroyed) return;
      if (res.headersSent) {
        if (path === "/v1/chat/completions") writeChatStreamError(res, error, requestId);
        else if (path === "/v1/responses" || path === "/v1/responses/compact") writeResponsesStreamError(res, error, requestId);
        else writeSseError(res, toPublicErrorBody(error, requestId));
        res.end();
        return;
      }
      if (path === "/v1/chat/completions" || path === "/v1/responses" || path === "/v1/responses/compact") sendOpenAIError(res, error, requestId);
      else sendError(res, error, requestId);
    }
  };

  return {
    config,
    registry,
    coordinator,
    catalog,
    lineage,
    ordinaryJournal,
    accounts,
    sdk,
    ledger,
    sandHealth,
    handler,
    listen() {
      const server = createServer((req, res) => {
        void handler(req, res);
      });
      server.listen(config.port, config.host);
      return server;
    },
    beginShutdown() {
      shuttingDown = true;
      clearInterval(sweepTimer);
      registry.beginShutdown();
    },
    close() {
      ledger?.close();
    },
  };
}
