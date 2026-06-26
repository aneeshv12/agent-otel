/**
 * Demo CLI entry point.
 *
 *   node dist/index.js <scenario>
 *
 * Initializes OTel -> Jaeger, builds an instrumented Anthropic client, and runs
 * the chosen scenario inside a single root span so the whole run is one trace.
 */
import Anthropic from "@anthropic-ai/sdk";
import { SpanStatusCode } from "@opentelemetry/api";
import { instrumentAnthropic } from "agent-otel";
import { initTracing, getDemoTracer } from "./tracing.js";
import { SCENARIOS } from "./scenarios.js";

const JAEGER_UI_URL = "http://localhost:16686";

async function main(): Promise<void> {
  const scenarioName = process.argv[2] ?? "happy";
  const scenario = SCENARIOS[scenarioName];

  if (scenario === undefined) {
    console.error(
      `Unknown scenario "${scenarioName}".\nAvailable: ${Object.keys(
        SCENARIOS
      ).join(", ")}`
    );
    process.exit(1);
  }

  if (
    process.env["ANTHROPIC_API_KEY"] === undefined ||
    process.env["ANTHROPIC_API_KEY"] === ""
  ) {
    console.error(
      "ANTHROPIC_API_KEY is not set. Export it before running the demo:\n  export ANTHROPIC_API_KEY=sk-ant-..."
    );
    process.exit(1);
  }

  const tracing = initTracing();
  const client = instrumentAnthropic(new Anthropic());
  const tracer = getDemoTracer();

  console.log(`\nRunning scenario: ${scenario.name}`);
  console.log(`  ${scenario.description}\n`);

  await tracer.startActiveSpan(`scenario ${scenario.name}`, async (rootSpan) => {
    try {
      await scenario.run(client);
      rootSpan.setStatus({ code: SpanStatusCode.OK });
    } catch (scenarioError: unknown) {
      rootSpan.setStatus({ code: SpanStatusCode.ERROR });
      if (scenarioError instanceof Error) {
        rootSpan.recordException(scenarioError);
      }
      console.error("Scenario threw:", scenarioError);
    } finally {
      rootSpan.end();
    }
  });

  await tracing.shutdown();
  console.log(
    `\nDone. Open Jaeger at ${JAEGER_UI_URL} and select service "agent-otel-demo".\n`
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
