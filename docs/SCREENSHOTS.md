# Screenshots to capture (user-side)

These cannot be generated from the build environment — they need a live
`ANTHROPIC_API_KEY` and a running Jaeger (`cd demo && docker compose up -d`).
Run each scenario, open http://localhost:16686, select service
`agent-otel-demo`, open the trace, and screenshot the waterfall.

Capture and commit:

1. **`docs/jaeger-runaway.png`** — LEAD IMAGE. Run `npm run demo -- runaway`.
   The shot should show the long column of repeated `execute_tool search_archive`
   spans (the stuck-agent shape) under one root span.

2. **`docs/jaeger-happy.png`** — Run `npm run demo -- happy`. A clean
   `scenario happy` root with `chat` spans, `tool_use` events on them, and
   `execute_tool` spans nested in between.

3. **`docs/jaeger-tool-error.png`** (optional, strong) — Run
   `npm run demo -- tool-error`. Show the red ERROR-status `execute_tool
   query_customer_database` span; expand its tags to show `error.type`.

4. **`docs/jaeger-truncation.png`** (optional) — Run
   `npm run demo -- truncation`. Expand the `chat` span tags to show
   `gen_ai.response.finish_reasons = ["max_tokens"]`.

The README references images 1 and 2; wire in 3 and 4 during the M5 README
polish if they read well.
