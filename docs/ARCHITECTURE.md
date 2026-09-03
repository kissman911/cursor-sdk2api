# Architecture

## Ownership

One live SDK Run has one owner process and one event-pump consumer.

```
HTTP /v1/messages | /v1/chat/completions | /v1/responses
  -> protocol parse (Chat/Responses convert to canonical ParsedMessages)
  -> CursorAgentTurn (protocol-neutral ordinary-turn IR)
  -> RunCoordinator
       -> SdkRunDriver (the only create/resume/send/pump wiring)
       -> tool_result: existing ATTACH / lineage resume / transcript recovery
       -> exact successor: Agent.resume/send(current turn text+images only)
       -> unknown/fork/compact: cold rebuild with full transcript fallback
       -> SessionRegistry (fingerprint, model, tool_use_id, TTL)
       -> ToolBridge (request tools -> local.customTools)
       -> EventPump (single run.stream() consumer for tool/status/terminal)
       -> protocol writer seam (Anthropic SSE, OpenAI Chat data chunks, or Responses events)
       -> SdkRuntime (injected; production adapter wraps @cursor/sdk)
```

`/v1/chat/completions` and `/v1/responses` do not own a second session or continuation engine. They reuse the same RunCoordinator, pending-tool Map, replay, and identity binding. Only the request parser and HTTP writer differ.

Responses continuation is not `previous_response_id` reconstruction. The parser accepts a full Responses transcript and treats only the latest trailing `function_call_output` batch as the continuation. Completed follow-up still uses `x-cursor-session-id` exactly as Messages/Chat. `previous_response_id`, `store=true`, background, conversation, and hosted built-in tools fail closed. The known optional `reasoning.encrypted_content` include is accepted but omitted; unknown expansions fail closed.

Text/thinking streaming uses official `SendOptions.onDelta` (`text-delta` / `thinking-delta`). Early deltas that arrive before `send()` resolves are buffered, then ingested into the pump. When onDelta is active, `run.stream()` assistant/thinking snapshots are not forwarded again.

`customTool.execute` is the authority for client-visible `tool_use`. SDK `tool_call` stream events are diagnostic and are de-duplicated by call id.

`SdkRunDriver` maps one custom-tool table before Agent create/resume and carries that same table through `send()` and EventPump attachment. Tool callbacks that fire synchronously during Agent resume or send are queued on the Session and drained only after the pump is attached; the coordinator never remaps tools or calls `Agent.resume` directly.

## Sand (Grok Bot) transport

The `sand` runtime profile does not use `@cursor/sdk` Agents. Cursor's server-side
harness (`agent.v1.AgentService/Run`) rejects `x-cursor-client-type: sand` with
`Sand traffic is not supported on this endpoint`; Grok Bot quota is billed only
on `aiserver.v1.InferenceService/Stream`. `SandInferenceRuntime`
(`src/sdk/sand-inference-runtime.ts`) implements the same `SdkAgent`/`SdkRun`
port over that RPC, so RunCoordinator, EventPump, ToolBridge, and every protocol
writer are unchanged:

- Auth: the User API Key is exchanged for an access token through the same
  `exchangeApiKey` the Dashboard quota reads use; one 401/403 triggers exactly one
  refresh before any semantic output.
- Wire: Connect streaming (`application/connect+proto`), hand-rolled protobuf in
  `src/sdk/sand-inference-codec.ts` (request: messages/role+text, requestedModel
  + params, conversationId; response: text part, thinking part, usage, error).
  Headers: `x-cursor-client-type: sand`, `x-cursor-client-version: sdk-1.0.30`,
  `x-sand-box-namespace: prod`, `x-ghost-mode: true`. Bare desktop versions are
  rejected as ERROR_OUTDATED_CLIENT.
- Semantics: text and thinking deltas flow through `onDelta` exactly like the
  SDK path. Images are dropped.
- Tools: the wire has no tool calls, so `SandInferenceRuntime` carries them in
  the prompt (`src/sdk/sand-tool-protocol.ts`). When `send()` receives
  `customTools`, a system message (role 4) with the catalog and an explicit
  `<sand:tool_call>{"name","input"}</sand:tool_call>` contract is prepended to
  every round trip (never stored in history). Streamed text passes through
  `SandToolCallScanner`, which forwards prose and captures tagged blocks even
  across chunk boundaries. When the upstream stream ends, every parsed call is
  handed to `customTool.execute` synchronously, so ToolBridge/EventPump see one
  batch and the client gets `tool_use` blocks with `stop_reason: tool_use`. The
  run then awaits the coordinator-resolved results, appends the raw assistant
  text plus a user message of `<sand:tool_result id name is_error>` blocks, and
  opens the next InferenceService request; the loop ends when a step has no
  calls. Steps with only malformed blocks are re-prompted with the parse error
  up to `SAND_MAX_MALFORMED_RETRIES` times, then surfaced as text. `cancel()`
  aborts an in-flight request or a pending tool wait.
- State: a Sand Agent is an in-memory message history keyed by agent id and
  credential (user turn, assistant text with tags, tool-result user message,
  ..., final assistant text). Exact live successors reuse it via `send()`;
  after a process restart `Agent.resume` is refused and the coordinator's
  existing full-transcript cold rebuild takes over. Nothing is written to the
  SDK store.
- Health: `/health.profiles.sand` reports `transport`, `client_version`, and a
  `capabilities` envelope (`tools: true`, `images: false`,
  `cross_process_resume: false`). The hash-guarded SDK clone
  (`sand-loader.ts`) is no longer on the request path.

## Network transport

Direct local SDK runs retain the official HTTP/2 transport. Node does not apply
standard proxy environment variables to that transport automatically. When an
HTTP(S) proxy is configured, startup switches Agent traffic to HTTP/1.1 and
installs `proxy-agent` as the Node HTTP/HTTPS global agent. SDK fetch traffic
(`models.list` and account lookup) separately uses Undici's
`EnvHttpProxyAgent`; both paths honor `NO_PROXY`. SOCKS/PAC is rejected instead
of allowing one SDK path to bypass the proxy. The gateway never stores or
returns proxy URLs; health reports only the active Agent and fetch modes.

## State machine

`Creating -> Running -> AwaitingToolResults -> Resuming -> Running -> ... -> Completed`

Any active state can go to `Failed` or `Cancelled`, then `Closed`.

Pending calls live in a `Map<toolUseId, PendingCall>`. There is no single-pending shortcut.

## Restart

SDK Agent history lives in credential-partitioned `$STATE_DIR/sdk-store/<fingerprint>` directories via the official `JsonlLocalAgentStore`. Each credential also receives a private empty-workspace partition. Gateway lineage (`$STATE_DIR/lineage`) keeps only resume metadata: session id, SDK agent id, credential fingerprint, model and explicit model parameters, canonical session-policy and executable-tool-catalog digests, state, pending tool ids, optional result digest, and timestamps. Lineage schema v2 fails closed and quarantines older/incomplete records instead of silently resuming them.

Ordinary multi-turn requests without `x-cursor-session-id` use a credential-free journal of digests (`STATE_DIR/ordinary-turns.json`). Exact linear successors reuse the same Agent and `send()` only the latest user text/images. Forks, compact/missing anchors, model/effort/tool-catalog mismatches, and credential rotation cold-rebuild. Identical request digests replay in-process; after a process restart they fail closed because assistant bodies are not persisted.

Completed follow-up with `x-cursor-session-id` looks up lineage, checks credential/model/session policy, then `Agent.resume` + `send` on that same store. `ORDINARY_TURN_COORDINATOR=0` restores the previous flatten-every-turn path. Pending callback Promises are not serialized; the lineage stores only tool ids, names, and policy digests. After owner death, an exact credential/model/tool-catalog/tool-id batch resumes the persisted Agent and sends a synthetic host-recovery turn with `local.force=true`. Concurrent duplicate-same recovery is singleflight. Assistant replay bodies are not persisted, so duplicate-same after a later process restart still has no persisted response body.

When no exact live or persisted owner can attach, tool continuation may cold-branch only from a self-contained transcript. The latest assistant tool batch must exactly match the submitted result ids and every call must exist in the request catalog. Historical completed calls are indexed by stable tool-name/input signature; if the recovered Harness requests one again, the gateway returns the recorded result internally rather than exposing the same side effect to the client twice. Identical recovery requests are singleflight and replayable for the normal replay TTL.

Before any semantic response is emitted, a generic SDK authentication-session failure is checked with an official `Cursor.me` credential probe. A still-valid key receives one same-credential Agent rebuild; an invalid key fails immediately. Managed mode may then try one different compatible account for authentication, permission, rate-limit, timeout, or upstream failures. No retry occurs after response headers/deltas begin.

## Injection

Production uses `createCursorRuntime({ stateDir })` and passes the matching credential-partitioned `JsonlLocalAgentStore` and workspace to every `Agent.create` and `Agent.resume`. Tests inject `FakeSdk`. The HTTP layer never imports `@cursor/sdk` directly except through that adapter.

Gateway lineage is a separate JSON file store under `STATE_DIR/lineage`. It recovers completed Agent ids and exact pending-tool metadata; pending callback Promises themselves are never serialized.
