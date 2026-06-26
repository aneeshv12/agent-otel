# agent-otel — Progress

## Framing (2026-06-13)
Confirmed this is a portfolio / career-signal project, not a product play. The
owning narrative is **observability of agent failure**: "I built the tracing
layer that shows where and why agents fail, and here is what each failure looks
like in a trace." The plan was amended on this date to make failure modes
first-class (PLAN §1 "The story this project is built to tell", milestone 3
failure-first demo, milestone 5 failure-visible Grafana dashboard).

Open strategic question still under discussion: why build this vs. just using
Langfuse/Phoenix/LangSmith. Resolve before committing to milestone 1. Current
lean: build is justified for *engineering-depth* signal (OTel internals, span
hierarchy, Claude Agent SDK subagent modeling) and because it compounds with
tracelight; if the goal were only to *produce failure stories*, Langfuse plus a
deliberately-failing demo agent would get there faster with less differentiation.

## Milestones

### Milestone 1 — Scaffold + conventions + core span — DONE (2026-06-13)
- `git init` done. npm-workspaces layout: root + `lib/` (the `agent-otel` package). `demo/` deferred to M3.
- Semconv research done against the live source (Opus-owned, not delegated): the GenAI
  conventions have MOVED to `github.com/open-telemetry/semantic-conventions-genai` (the
  opentelemetry.io spec pages are now stubs). All attributes are "Development" stability.
  Vendored verbatim into `lib/src/semconv.ts`, pinned `PINNED_SEMCONV_DATE = 2026-06-13`.
  Notable: provider attr is `gen_ai.provider.name` (value `anthropic`), NOT the deprecated
  `gen_ai.system`. Chat span name `chat {model}`; tool span `execute_tool {tool.name}`.
  Cache tokens have no official slot, so they use an `anthropic.` prefix.
- `instrumentAnthropic` implemented (Proxy over client.messages.create, non-streaming only;
  stream:true passes through untraced until M2). Resilience contract honored: bookkeeping
  failures are swallowed, only real API errors are recorded + rethrown. Content capture
  gated behind `AGENT_OTEL_CAPTURE_CONTENT=true`, off by default.
- Tests: 8 vitest cases via in-memory exporter (span name, request/response attrs, cache
  attrs, transparency, content-capture toggle, error path, stream bypass). All pass.
- Verified independently by orchestrator: `npm run typecheck`, `npm test` (8/8), `npm run build` all green.
- Installed (latest): @anthropic-ai/sdk 0.104.1, @opentelemetry/api 1.9.1, @opentelemetry/sdk-trace-base 2.8.0, vitest 4.1.8, typescript 6.0.3.
- Surprise: sdk-trace-base 2.x dropped `provider.register()`; pass `{ spanProcessors: [...] }` to the
  `BasicTracerProvider` constructor and call `trace.setGlobalTracerProvider`. Note for M2/M3.
- Surprise: `temperature`/`top_p` are marked `@deprecated` in the current Anthropic SDK (post-4.6
  models don't take them) but still present as optional fields; we still record them when supplied.

### Milestone 2 — Streaming, errors, tools — DONE (2026-06-24)

**Fork resolved:** streaming content capture uses **option A** (Aneesh's call) — buffer the full
streamed text and store it as one `gen_ai.output.messages` attribute at stream end, same posture
as non-streaming. Capture is still opt-in and off by default, so buffering only happens when the
user explicitly set `AGENT_OTEL_CAPTURE_CONTENT=true`.

All event shapes were read from the installed SDK source (`@anthropic-ai/sdk@0.104.1`), not guessed:
`lib/MessageStream.d.ts`, `resources/messages/messages.d.ts` (RawMessageStreamEvent union,
MessageDeltaUsage, TextDelta), `src/lib/MessageStream.ts` (emit lifecycle).

#### Done
- **Two streaming entry points, two idiomatic strategies:**
  - `create({ stream: true })` returns a raw `Stream<RawMessageStreamEvent>`. Instrumented by
    `tracedCreateStream` → `wrapRawStream`, a Proxy over the returned Stream that overrides only
    `Symbol.asyncIterator`. The span is opened with `tracer.startSpan` (NOT active — the caller
    consumes later) and closed in the iterator's `finally`. A `completedNormally` flag separates a
    fully-consumed stream (finalize + OK) from an early `break` (return() runs finally → span just
    ends). Aggregation per the protocol: identity/model/input-usage/cache from `message_start`,
    cumulative `output_tokens` + `stop_reason` from `message_delta`, text across
    `content_block_delta` (text_delta). Other Stream members (`tee`, `toReadableStream`, ...) pass
    through the Proxy untouched.
  - `messages.stream()` returns the SDK's `MessageStream` helper (an event emitter). Instrumented
    by `tracedStream` using the emitter directly: `finalMessage` → `setResponseAttributes` + OK,
    `error`/`abort` → `recordSpanError`, `end` → `span.end()`. Verified in SDK source that `end`
    fires after success (post-finalMessage), abort, AND error, so a single `end` listener closes
    the span in every case with no leak. The same MessageStream object is returned (listeners
    attached), so the user keeps `.on('text')`, `.finalMessage()`, etc.
- **`withToolSpan(name, input, fn)`** (exported): wraps app-side tool execution in an
  `execute_tool {name}` span via `startActiveSpan` (so nested instrumented calls inside `fn` parent
  correctly), sets `gen_ai.operation.name=execute_tool` + `gen_ai.tool.name`, awaits `fn` (sync or
  async), records error.type + rethrows on failure, OK + end on success. Returns `fn`'s result.
- **tool_use as span events** on the chat span (the model *requesting* a tool, distinct from
  execution). Non-streaming + MessageStream paths add one `tool_use` event per `tool_use` content
  block (name + id always; arguments only under content capture). Raw-stream path emits the event
  at `content_block_start` (name + id only — the input JSON streams in later via deltas, so
  arguments aren't available at open). Event name `tool_use` is a **library-defined** constant in
  `semconv.ts` (`LibraryEventName.TOOL_USE`), explicitly NOT recited as a GenAI semconv name (there
  is no official event for a tool *request*).
- **DRY refactor:** response attributes for all three paths funnel through one `AggregatedResponse`
  intermediate + `applyResponseAttributes`, so the attribute keys and null/zero guards live in one
  place. Error recording unified in `recordSpanError` (chat, stream, and tool spans). M1's
  non-streaming behavior is byte-for-byte preserved (its 8 tests still pass untouched).
- **Content capture extended to streaming** (option A) and to tool arguments/result — all gated
  behind the same `AGENT_OTEL_CAPTURE_CONTENT` toggle, default off.
- Tests: 20 vitest cases (8 original + 12 new) via in-memory exporter — raw-stream lifecycle
  (span opens on start, closes only after full consumption), usage/cache/finish aggregation,
  streamed-text capture, mid-stream tool_use event, mid-iteration error → ERROR status,
  tee passthrough; MessageStream finalMessage/end happy path + error path; withToolSpan
  success/error/capture; non-streaming tool_use events. `npm run typecheck`, `npm test` (20/20),
  `npm run build` all green.

#### Punted (all non-blocking, documented in code)
- **Early `break` out of a raw stream** ends the span without OK status and without response
  attributes (only request attrs + whatever was observed). Acceptable: truncation
  (`stop_reason: max_tokens`) is a *normal* stream completion, so the failure-observability story
  is unaffected. Full early-break finalization would need incremental attribute setting.
- **Raw-stream tool_use arguments not captured** — only name + id, because the argument JSON
  arrives via `input_json` deltas after the block opens. The `messages.stream()` path (finalMessage)
  and non-streaming path DO capture full arguments. Assemble-from-deltas was deemed not worth it
  for M2; revisit if the demo needs streamed tool arguments.
- **Alternate stream consumption** (`stream.tee()` / `.toReadableStream()` instead of iterating)
  means the raw-stream span never observes events / never closes. Iteration is the overwhelmingly
  common path; documented as a limitation.
- **APIPromise extras lost on raw streams.** `create({stream:true})` normally returns an APIPromise
  with `.withResponse()`; we `await` it internally and return the wrapped Stream, so that helper is
  dropped. Minor; iteration is unaffected.

#### Surprising
- `MessageStream` emits `end` in a `finally`/after every terminal event (success, abort, error) —
  confirmed in source — which made the emitter strategy clean: one `end` listener, zero leak risk.
  Much simpler than manually aggregating raw events for that path. The raw `create({stream:true})`
  path has no such helper, so it needed the manual aggregator + Proxy.
- `exactOptionalPropertyTypes: true` rejects assigning an explicit `undefined` to an optional field;
  `outputContent` had to be conditionally *added* to the object rather than set to `undefined`.

### Milestone 3 — Demo + Jaeger (failure-first) — DONE, verified live (2026-06-24, live run 2026-06-26)

Built the `demo/` workspace: a real multi-turn Claude tool loop driven by the M1-M2 library,
shipping traces to a local Jaeger over OTLP/HTTP. All OTel SDK/exporter code lives in `demo/`
only — the lib stays `@opentelemetry/api`-and-peer-deps only, as required.

#### Done
- **Workspace:** added `demo` to root `workspaces`; root scripts now build/typecheck lib then demo
  (`test` stays lib-only — M3 mandates no demo tests). `agent-otel` is consumed via the workspace
  symlink (`"agent-otel": "*"`), resolving to the lib's built `dist`.
- **OTel wiring** (`demo/src/tracing.ts`): `BasicTracerProvider({ resource, spanProcessors })` +
  `trace.setGlobalTracerProvider` (per the M2 note — sdk-trace-base 2.x dropped `provider.register()`),
  `OTLPTraceExporter` (http) → `http://localhost:4318/v1/traces`. Uses `SimpleSpanProcessor` (not
  Batch) so a single `await provider.shutdown()` before the CLI exits reliably flushes — important
  for a short-lived process. `OTEL_CONSOLE=true` adds a console exporter for Jaeger-less runs.
  All four OTel APIs were read from installed typings, not guessed (`resourceFromAttributes`,
  `ATTR_SERVICE_NAME`, exporter ctor `{url}`, provider `{resource, spanProcessors}`).
- **Agent loop** (`demo/src/agent.ts`): plain non-streaming tool loop; each tool execution wrapped
  in `withToolSpan`; tool throws are caught, end the execute_tool span with ERROR, and are fed back
  as `is_error` tool_results so the loop can continue. Returns `{ finalText, turns, hitTurnCap,
  toolCallCount }`. A turn cap is the runaway signal.
- **Tools** (`demo/src/tools.ts`): two real-ish (`get_weather`, `add`) for the happy path; two
  pathological — `query_customer_database` (always throws → error span) and `search_archive`
  (always returns no results → non-convergence).
- **Scenarios** (`demo/src/scenarios.ts`): `happy`, `tool-error`, `runaway`, `truncation`
  (single `create` at `max_tokens: 16` → `stop_reason: max_tokens`), and a bonus `streaming`
  (exercises the M2 `messages.stream()` span). Default model `claude-haiku-4-5-20251001`
  (cost — demo is about traces, overridable via `ANTHROPIC_MODEL`).
- **One trace per run:** `index.ts` wraps each scenario in a `scenario {name}` root active span, so
  the chat/tool spans (which use `startActiveSpan`) nest into a single waterfall rather than
  scattering into disconnected traces.
- **`demo/docker-compose.yml`:** Jaeger all-in-one (1.62.0) with `COLLECTOR_OTLP_ENABLED=true`,
  ports 16686/4317/4318. **`demo/.env.example`** documents the env vars.
- **Verification:** `npm run typecheck` (lib + demo), `npm test` (20/20), `npm run build` (lib +
  demo) all green. CLI precondition paths smoke-tested live: unknown-scenario lists options and
  exits 1; missing `ANTHROPIC_API_KEY` prints guidance and exits 1.

#### Live verification (2026-06-26) — demo run end-to-end against the real API
Run on the user's machine (Docker Desktop + real `ANTHROPIC_API_KEY`); orchestrator brought up
Jaeger and verified span structure via the Jaeger query API. All five scenarios confirmed:
- `happy` — one connected 7-span trace: `scenario happy` root → 3 `chat` + 3 `execute_tool`, with
  `tool_use` events on the chat spans. Screenshot saved `docs/jaeger-happy.png`.
- `runaway` — 12 spans, 7 stacked `execute_tool search_archive` (stuck-agent shape). The model gave
  up at turn 4 (under the 6-turn cap), so `hitTurnCap` was false but the repeated-call column still
  reads clearly. Screenshot saved `docs/jaeger-runaway.png`.
- `tool-error` — single ERROR-status `execute_tool query_customer_database` span mid-waterfall, with
  an exception event; surrounding spans OK.
- `truncation` — `chat` span `finish_reasons=["max_tokens"]`, `output_tokens=16`.
- `streaming` — same instrumentation path; not separately screenshotted.

#### Bug found and fixed during live verification: disconnected traces
First `happy` run produced **7 separate single-span traces** instead of one waterfall. Root cause:
the demo registered a `BasicTracerProvider` but **no context manager**, so `startActiveSpan` could
not propagate the active span across `await`s and every span started parentless. Fixed in
`demo/src/tracing.ts` by registering an `AsyncLocalStorageContextManager`
(`@opentelemetry/context-async-hooks`, added as a demo dep) before the provider. Re-ran → one
connected trace. This is an app-side OTel requirement, not a library bug (the lib correctly uses the
API); documented in the README's bring-your-own-SDK note since it is the most common
disconnected-spans footgun. Also gave the tool-error demo tool a named error
(`DatabaseConnectionError`) so `error.type` reads meaningfully instead of bland `"Error"`.

#### Still handed off to the user
- **Optional screenshots** `docs/jaeger-tool-error.png` and `docs/jaeger-truncation.png` (the two
  traces are verified; just capture the images if wanted for M5 README polish). `docs/SCREENSHOTS.md`
  has the steps. The two README-referenced images (happy, runaway) are done.

#### Surprising
- The Anthropic SDK's response `ContentBlock[]` assigns cleanly to a request message's
  `ContentBlockParam[]` in 0.104.x, so `messages.push({ role: "assistant", content: response.content })`
  typechecks with no cast under strict + `exactOptionalPropertyTypes`. Convenient; not guaranteed
  across SDK versions.
- `BasicTracerProvider` installing no context manager (where `NodeTracerProvider` would) is an easy
  trap — instrumentation looks "done" and spans even export, but they all fan out into separate
  traces until a context manager is registered. Only visible once you actually look at the waterfall.

### Next: Milestone 4 — Claude Agent SDK layer
Sonnet-level per the plan (span-hierarchy design is the judgment-heavy part — escalate to Opus if
event shapes are ambiguous). Build `instrumentAgentQuery` wrapping the Claude Agent SDK's `query()`
event stream into a session -> turn -> tool-call span hierarchy, with subagent activity nested under
its spawning tool call. **Read the locally installed Agent SDK source for the event shapes — do not
guess** (this is a hard rule; M1-M3 all paid off by reading SDK source). The demo gains an Agent SDK
example whose Jaeger trace shows a nested subagent. Note: the Agent SDK is a separate package
(`@anthropic-ai/claude-agent-sdk` or similar) — confirm the exact name/`query()` API from its
installed source before designing the span model. This milestone compounds with tracelight, whose
subagent-nesting renderer already models the same parent/child relationship.
