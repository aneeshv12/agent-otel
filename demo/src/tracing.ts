/**
 * OpenTelemetry SDK wiring for the demo.
 *
 * This file is the ONLY place the OTel *SDK* (provider, processor, exporter)
 * appears — the `agent-otel` library itself depends solely on `@opentelemetry/api`
 * and lets the application own this setup. A real user copies a file like this
 * into their own service; the README shows it as the minimal bring-your-own setup.
 */
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
  ConsoleSpanExporter,
} from "@opentelemetry/sdk-trace-base";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { trace, context } from "@opentelemetry/api";

const DEFAULT_OTLP_TRACES_ENDPOINT = "http://localhost:4318/v1/traces";
const SERVICE_NAME = "agent-otel-demo";

/**
 * Initializes a global tracer provider that ships spans to Jaeger over OTLP/HTTP.
 *
 * SimpleSpanProcessor (rather than BatchSpanProcessor) is deliberate for a
 * short-lived CLI: it hands each finished span to the exporter immediately, so a
 * single `await shutdown()` before exit reliably flushes everything. Set
 * `OTEL_CONSOLE=true` to additionally print spans to stdout (handy when Jaeger
 * is not running).
 *
 * @returns a `shutdown` function that flushes and tears down the provider.
 */
export function initTracing(): { shutdown: () => Promise<void> } {
  const otlpExporter = new OTLPTraceExporter({
    url:
      process.env["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"] ??
      DEFAULT_OTLP_TRACES_ENDPOINT,
  });

  const spanProcessors: SpanProcessor[] = [
    new SimpleSpanProcessor(otlpExporter),
  ];
  if (process.env["OTEL_CONSOLE"] === "true") {
    spanProcessors.push(new SimpleSpanProcessor(new ConsoleSpanExporter()));
  }

  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: SERVICE_NAME }),
    spanProcessors,
  });

  // Register an async context manager BEFORE the provider. Without it,
  // `startActiveSpan` cannot propagate the active span across awaits, so every
  // span starts parentless and lands in its own trace instead of one waterfall.
  // BasicTracerProvider (unlike NodeTracerProvider) installs no context manager
  // on its own, so the application must do it — that is this file's job.
  const contextManager = new AsyncLocalStorageContextManager();
  contextManager.enable();
  context.setGlobalContextManager(contextManager);

  trace.setGlobalTracerProvider(provider);

  return {
    shutdown: async () => {
      await provider.shutdown();
    },
  };
}

/** The tracer the demo uses for the per-scenario root span. */
export function getDemoTracer() {
  return trace.getTracer(SERVICE_NAME);
}
