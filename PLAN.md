# Project Plan: OpenTelemetry Agent Tracing (working title: "agent-otel")

A TypeScript instrumentation library that makes Claude-based agents emit standards-compliant OpenTelemetry traces — every model call, tool call, turn, and subagent as proper spans with GenAI semantic-convention attributes — viewable in whatever observability stack a company already runs (Jaeger, Grafana, Datadog, Honeycomb).

**Why this project:** the standard enterprise complaint about LLM observability vendors is "another dashboard, another silo." Emitting OTel means agent telemetry flows into existing infrastructure. Building against an open standard is itself the career signal: it reads as infrastructure maturity, and the demo (an agent's full trace waterfall in vanilla Jaeger) lands instantly with engineers. Compounds with the `agent-trace-viewer` project, whose renderer was designed to accept a second trace source later.

**The story this project is built to tell:** observability of *agent failure*. The intended interview narrative is not "I emitted spec-compliant spans" but "I built the tracing layer that shows where and why agents fail, and here is what each failure looks like in a trace." Everyone instruments the happy path; the differentiator is making failure legible. This biases the build: tool failures, runaway loops (the same tool called repeatedly without converging), truncation (`stop_reason: max_tokens`), refusals (`stop_reason: refusal`), and latency outliers are treated as first-class demo scenarios, not edge cases. The money artifact is a screenshot of a pathological waterfall ("this is what a stuck agent looks like"), not a clean one.

Written for Sonnet/Haiku coding sessions. Weekend-sized: **5 milestones × ~2 hours.** Read `CLAUDE.md` first.

---

## 1. Product definition

- **Install:** `npm install agent-otel @opentelemetry/api`
- **Core API (small on purpose):**
  ```ts
  import { instrumentAnthropic, withToolSpan } from "agent-otel";
  const client = instrumentAnthropic(new Anthropic());      // all messages.create calls now traced
  const result = await withToolSpan("read_file", input, () => executeTool(input)); // app-side tool execution spans
  ```
- **What gets traced:**
  - Each `messages.create` call (streaming and non-streaming) → a span named `chat {model}` with GenAI semantic-convention attributes: system, request/response model, input/output token usage, cache read/creation tokens (custom `anthropic.*` attributes where conventions have no slot), stop reason, error status on failure.
  - `tool_use` blocks in responses → span events on the chat span (the model *requested* a tool); actual tool *execution* spans come from `withToolSpan` so the waterfall shows request → execution → next call.
  - **Content capture is OFF by default.** Prompts/completions are recorded as span attributes only when `AGENT_OTEL_CAPTURE_CONTENT=true`. This default is a feature — it's the enterprise privacy posture — document it prominently.
- **Claude Agent SDK layer (milestone 4):** a wrapper around the SDK's `query()` event stream producing a span hierarchy: session → turn → tool call, with subagent activity nested under its spawning tool call.
- **Deliverables beyond the library:** a runnable demo agent (multi-turn tool loop), a `docker-compose.yml` bringing up Jaeger, and a Grafana dashboard JSON (token spend over time, latency percentiles by model, error rate, estimated cost panel).

### Non-goals (v1)
No Python version, no metrics/logs signals (spans only), no auto-instrumentation via module patching (explicit wrapping only — it's more honest and easier to debug), no support for non-Anthropic providers.

---

## 2. Architecture and ground rules

- **Dependency discipline:** the library depends only on `@opentelemetry/api` (as a peer dependency, per OTel instrumentation convention) and treats `@anthropic-ai/sdk` as a peer too. The OTel SDK, exporters, Jaeger, etc. appear only in the demo workspace. Users bring their own SDK/exporter setup; the README shows a minimal one.
- **Conventions are a moving target — pin and vendor them.** Milestone 1 starts by fetching the *current* OTel GenAI semantic conventions (search/WebFetch the official semconv docs; do NOT recite attribute names from memory — they have churned repeatedly). Vendor the chosen attribute names as constants in `src/semconv.ts` with a comment recording the semconv version pinned against. Attributes with no official slot (cache tokens, stop reason) use an `anthropic.` prefix.
- **Wrapping strategy:** a Proxy around the client that intercepts `messages.create` (and `messages.stream`). Streaming spans stay open until the stream ends/errors and aggregate usage from the final message event. Never swallow or alter the underlying call's behavior — if span logic throws, catch, log, and let the real call proceed untraced.
- **Testing (mandatory, write without asking):** unit tests with a mocked Anthropic client and OTel's `InMemorySpanExporter`, asserting span names, attribute presence/values, parent-child structure, error status, and the content-capture toggle. These tests are the spec.
- **Repo layout:** npm workspaces — `lib/` (the package), `demo/` (agent + docker-compose + Grafana JSON). Strict TypeScript throughout.

---

## 3. Milestones (~2h each)

1. **Scaffold + conventions + core span.** Workspace setup; research and vendor current GenAI semconv attribute names into `src/semconv.ts`; implement `instrumentAnthropic` for non-streaming `messages.create` with full attributes; in-memory-exporter test suite. Acceptance: tests assert a correct `chat {model}` span for a mocked call.
2. **Streaming, errors, tools.** Streaming span lifecycle with aggregated usage, error status codes, `tool_use` span events, `withToolSpan`, content-capture env toggle. Acceptance: test suite covers all of §1's tracing behavior.
3. **Demo + Jaeger (failure-first).** Demo agent running a real multi-turn tool loop against the API, docker-compose Jaeger, OTLP exporter wiring. The demo must be able to run in selectable scenarios, at least one happy path and several deliberate failure modes: a tool that errors, a runaway loop (same tool called repeatedly without converging), and a truncated response (`stop_reason: max_tokens`). Acceptance: a screenshot-worthy happy-path waterfall *and* at least two failure-mode waterfalls in Jaeger that visibly show the failure (error-status spans, the pathological loop shape, the truncation), with chat spans, tool events, and tool-execution spans correctly nested. Put both the happy-path and a failure screenshot in the README immediately; the failure screenshot is the lead image.
4. **Claude Agent SDK layer.** `instrumentAgentQuery` wrapping the SDK event stream into session/turn/tool spans with subagent nesting. Read the locally installed SDK source to learn the event shapes — do not guess them. Acceptance: the demo gains an Agent SDK example whose Jaeger trace shows a nested subagent.
5. **Grafana + publish.** Grafana dashboard JSON wired to a Tempo/Prometheus-less simple setup (or Jaeger-backed where possible — keep the demo stack minimal and honest about what each panel needs), README polish (the privacy-default story front and center, the failure-observability story as the hook). The dashboard should make failure visible at a glance: error rate, latency p95/p99 by model, token/cost spikes (the runaway-loop signal), and a stop-reason breakdown (truncations and refusals). `npm publish`, launch post draft. Acceptance: `npm install agent-otel` works on a clean project.

### Model assignment
Milestones 3, 5: Haiku-capable. Milestones 1, 2, 4: Sonnet. Semconv ambiguity or span-hierarchy design doubts: escalate to Fable/Opus rather than improvising — the span model is the product.
