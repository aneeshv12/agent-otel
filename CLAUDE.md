# agent-otel — instructions for coding sessions

`PLAN.md` is the single source of truth; it was architected in a Fable session. Coding sessions (usually Sonnet/Haiku) execute one milestone at a time.

Session start: read `PLAN.md`, then `PROGRESS.md` (create if missing) to find the next milestone. Do only that milestone.
Session end: `npm run typecheck`, `npm test`, and `npm run build` must pass; append a dated entry to `PROGRESS.md` (done / punted / surprising / plan seems wrong).

Hard rules:
- Never recite OTel GenAI semantic-convention attribute names from memory — they are vendored in `src/semconv.ts` after milestone-1 research against current docs (PLAN §2).
- The library depends only on `@opentelemetry/api` and peer-deps; OTel SDK/exporters live in `demo/` only.
- Instrumentation must never break the underlying API call — span failures are caught and logged, the real call proceeds.
- Content capture defaults OFF; the toggle is `AGENT_OTEL_CAPTURE_CONTENT`.
- In-memory-exporter tests are mandatory and may be written without asking; read installed SDK source instead of guessing APIs.
- Strict TypeScript, descriptive names, every dep in the right package.json. If the plan seems wrong, stop and flag in PROGRESS.md.
