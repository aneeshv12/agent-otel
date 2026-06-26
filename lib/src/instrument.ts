import { trace, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { Span, Attributes } from "@opentelemetry/api";
import type {
  Message,
  ContentBlock,
  MessageCreateParamsBase,
  RawMessageStreamEvent,
} from "@anthropic-ai/sdk/resources/messages/messages.js";
import {
  GenAiOperationName,
  GEN_AI_PROVIDER_ANTHROPIC,
  GenAiAttr,
  ErrorAttr,
  ERROR_TYPE_OTHER,
  AnthropicAttr,
  LibraryEventName,
  chatSpanName,
  executeToolSpanName,
} from "./semconv.js";

const TRACER_NAME = "agent-otel";

/**
 * Returns true when the caller has opted-in to capturing message content as
 * span attributes. Read at call time so tests can toggle the env var between
 * test cases without reloading the module.
 */
export function isContentCaptureEnabled(): boolean {
  return process.env["AGENT_OTEL_CAPTURE_CONTENT"] === "true";
}

/**
 * The minimal shape we need from the Anthropic messages object so we can
 * proxy it without tying the library to a specific SDK version at runtime.
 * `stream` is optional because not every messages-like object exposes it.
 */
interface MessagesResource {
  create: (...args: unknown[]) => Promise<unknown>;
  stream?: (...args: unknown[]) => unknown;
}

// ---------------------------------------------------------------------------
// Request attributes (shared by streaming and non-streaming)
// ---------------------------------------------------------------------------

function setRequestAttributes(
  span: Span,
  params: MessageCreateParamsBase
): void {
  span.setAttributes({
    [GenAiAttr.OPERATION_NAME]: GenAiOperationName.CHAT,
    [GenAiAttr.PROVIDER_NAME]: GEN_AI_PROVIDER_ANTHROPIC,
    [GenAiAttr.REQUEST_MODEL]: params.model,
  });

  if (params.max_tokens !== undefined) {
    span.setAttribute(GenAiAttr.REQUEST_MAX_TOKENS, params.max_tokens);
  }
  if (params.temperature !== undefined) {
    span.setAttribute(GenAiAttr.REQUEST_TEMPERATURE, params.temperature);
  }
  if (params.top_p !== undefined) {
    span.setAttribute(GenAiAttr.REQUEST_TOP_P, params.top_p);
  }

  if (isContentCaptureEnabled()) {
    span.setAttribute(
      GenAiAttr.INPUT_MESSAGES,
      JSON.stringify(params.messages)
    );
    if (params.system !== undefined) {
      span.setAttribute(
        GenAiAttr.SYSTEM_INSTRUCTIONS,
        JSON.stringify(params.system)
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Response attributes
//
// Both the non-streaming path (which has a complete `Message`) and the
// streaming path (which assembles fields incrementally from raw events) funnel
// through the same `AggregatedResponse` intermediate so the attribute keys and
// their null/zero guards live in exactly one place.
// ---------------------------------------------------------------------------

interface AggregatedResponse {
  model?: string;
  id?: string;
  /** null is a valid "no stop reason yet" value distinct from "not observed". */
  stopReason?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number | null;
  cacheCreationInputTokens?: number | null;
  /** Serialized output content; only populated when content capture is enabled. */
  outputContent?: string;
}

function applyResponseAttributes(span: Span, agg: AggregatedResponse): void {
  if (agg.model !== undefined) {
    span.setAttribute(GenAiAttr.RESPONSE_MODEL, agg.model);
  }
  if (agg.id !== undefined) {
    span.setAttribute(GenAiAttr.RESPONSE_ID, agg.id);
  }
  if (agg.stopReason !== undefined && agg.stopReason !== null) {
    span.setAttribute(GenAiAttr.RESPONSE_FINISH_REASONS, [agg.stopReason]);
  }
  if (agg.inputTokens !== undefined) {
    span.setAttribute(GenAiAttr.USAGE_INPUT_TOKENS, agg.inputTokens);
  }
  if (agg.outputTokens !== undefined) {
    span.setAttribute(GenAiAttr.USAGE_OUTPUT_TOKENS, agg.outputTokens);
  }
  if (
    agg.cacheReadInputTokens !== null &&
    agg.cacheReadInputTokens !== undefined &&
    agg.cacheReadInputTokens > 0
  ) {
    span.setAttribute(
      AnthropicAttr.USAGE_CACHE_READ_INPUT_TOKENS,
      agg.cacheReadInputTokens
    );
  }
  if (
    agg.cacheCreationInputTokens !== null &&
    agg.cacheCreationInputTokens !== undefined &&
    agg.cacheCreationInputTokens > 0
  ) {
    span.setAttribute(
      AnthropicAttr.USAGE_CACHE_CREATION_INPUT_TOKENS,
      agg.cacheCreationInputTokens
    );
  }
  if (isContentCaptureEnabled() && agg.outputContent !== undefined) {
    span.setAttribute(GenAiAttr.OUTPUT_MESSAGES, agg.outputContent);
  }
}

function messageToAggregated(response: Message): AggregatedResponse {
  const aggregated: AggregatedResponse = {
    model: response.model,
    id: response.id,
    stopReason: response.stop_reason,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    cacheReadInputTokens: response.usage.cache_read_input_tokens,
    cacheCreationInputTokens: response.usage.cache_creation_input_tokens,
  };
  if (isContentCaptureEnabled()) {
    aggregated.outputContent = JSON.stringify(response.content);
  }
  return aggregated;
}

/**
 * Records one `tool_use` span event per tool the model requested in its
 * response content. Tool *arguments* are app data, so they are gated behind the
 * content-capture toggle; the tool name and call id are always recorded because
 * they are low-cardinality structural metadata, not user content.
 */
function addToolUseEvents(span: Span, content: ContentBlock[]): void {
  const captureContent = isContentCaptureEnabled();
  for (const block of content) {
    if (block.type !== "tool_use") {
      continue;
    }
    const attributes: Attributes = {
      [GenAiAttr.TOOL_NAME]: block.name,
      [GenAiAttr.TOOL_CALL_ID]: block.id,
    };
    if (captureContent) {
      attributes[GenAiAttr.TOOL_CALL_ARGUMENTS] = JSON.stringify(block.input);
    }
    span.addEvent(LibraryEventName.TOOL_USE, attributes);
  }
}

/** Applies all response-derived attributes and tool_use events for a full Message. */
function setResponseAttributes(span: Span, response: Message): void {
  applyResponseAttributes(span, messageToAggregated(response));
  addToolUseEvents(span, response.content);
}

// ---------------------------------------------------------------------------
// Error handling (shared by chat spans, stream spans, and tool spans)
// ---------------------------------------------------------------------------

function resolveErrorType(error: unknown): string {
  if (
    error !== null &&
    typeof error === "object" &&
    "name" in error &&
    typeof (error as { name: unknown }).name === "string"
  ) {
    const name = (error as { name: string }).name;
    return name.length > 0 ? name : ERROR_TYPE_OTHER;
  }
  return ERROR_TYPE_OTHER;
}

/** Marks a span as errored. Never throws — bookkeeping must not mask the real error. */
function recordSpanError(span: Span, error: unknown): void {
  try {
    span.setStatus({ code: SpanStatusCode.ERROR });
    span.setAttribute(ErrorAttr.TYPE, resolveErrorType(error));
    if (error instanceof Error) {
      span.recordException(error);
    }
  } catch {
    // Bookkeeping failure — nothing more we can do; let the caller proceed.
  }
}

// ---------------------------------------------------------------------------
// Non-streaming create
// ---------------------------------------------------------------------------

/**
 * Wraps a single non-streaming `messages.create` call with an OTel span.
 *
 * The resilience contract: if anything in our bookkeeping (attribute setting,
 * span creation) fails, we catch it and still let the real API call proceed and
 * return normally. Only errors from the API call itself are recorded and rethrown.
 */
async function tracedCreate(
  originalCreate: (...args: unknown[]) => Promise<unknown>,
  params: MessageCreateParamsBase,
  options: unknown
): Promise<unknown> {
  const tracer = trace.getTracer(TRACER_NAME);

  return tracer.startActiveSpan(
    chatSpanName(params.model),
    { kind: SpanKind.CLIENT },
    async (span: Span) => {
      try {
        setRequestAttributes(span, params);
      } catch {
        // Bookkeeping failure — continue with the real call anyway.
      }

      let response: Message;
      try {
        response = (await originalCreate(params, options)) as Message;
      } catch (apiError: unknown) {
        recordSpanError(span, apiError);
        span.end();
        throw apiError;
      }

      try {
        setResponseAttributes(span, response);
        span.setStatus({ code: SpanStatusCode.OK });
      } catch {
        // Bookkeeping failure — continue returning the response.
      } finally {
        span.end();
      }

      return response;
    }
  );
}

// ---------------------------------------------------------------------------
// Streaming create({ stream: true }) — raw event stream
// ---------------------------------------------------------------------------

/**
 * Accumulates response fields from the raw streaming event sequence. Per the
 * Anthropic streaming protocol: identity/model/input usage arrive in
 * `message_start`; the final cumulative output usage and stop reason arrive in
 * `message_delta`; text content arrives across `content_block_delta` events.
 */
function createStreamAggregator() {
  const aggregated: AggregatedResponse = {};
  const captureContent = isContentCaptureEnabled();
  let textBuffer = "";

  function observe(event: RawMessageStreamEvent, span: Span): void {
    switch (event.type) {
      case "message_start": {
        const message = event.message;
        aggregated.model = message.model;
        aggregated.id = message.id;
        aggregated.inputTokens = message.usage.input_tokens;
        aggregated.outputTokens = message.usage.output_tokens;
        aggregated.cacheReadInputTokens =
          message.usage.cache_read_input_tokens;
        aggregated.cacheCreationInputTokens =
          message.usage.cache_creation_input_tokens;
        break;
      }
      case "content_block_start": {
        // The model requesting a tool: emit the tool_use event as soon as the
        // block opens. The full argument JSON is not yet available (it streams
        // in via input_json deltas), so arguments are not captured here.
        const block = event.content_block;
        if (block.type === "tool_use") {
          span.addEvent(LibraryEventName.TOOL_USE, {
            [GenAiAttr.TOOL_NAME]: block.name,
            [GenAiAttr.TOOL_CALL_ID]: block.id,
          });
        }
        break;
      }
      case "content_block_delta": {
        if (captureContent && event.delta.type === "text_delta") {
          textBuffer += event.delta.text;
        }
        break;
      }
      case "message_delta": {
        // output_tokens here is the authoritative cumulative total.
        aggregated.outputTokens = event.usage.output_tokens;
        if (event.usage.cache_read_input_tokens !== null) {
          aggregated.cacheReadInputTokens =
            event.usage.cache_read_input_tokens;
        }
        if (event.usage.cache_creation_input_tokens !== null) {
          aggregated.cacheCreationInputTokens =
            event.usage.cache_creation_input_tokens;
        }
        aggregated.stopReason = event.delta.stop_reason;
        break;
      }
      default:
        break;
    }
  }

  function finalize(): AggregatedResponse {
    if (captureContent) {
      // Option A: buffer the full streamed text and store it as one
      // gen_ai.output.messages attribute at stream end, same posture as the
      // non-streaming path (capture only happens when explicitly opted in).
      aggregated.outputContent = textBuffer;
    }
    return aggregated;
  }

  return { observe, finalize };
}

/**
 * Wraps the raw `Stream` returned by `create({ stream: true })` so that the
 * chat span stays open until the caller finishes consuming the stream. The
 * wrapper is a Proxy that only overrides async iteration; all other Stream
 * members (`tee`, `toReadableStream`, `controller`, ...) pass through. Consuming
 * the stream via those alternate paths means events are not observed — a
 * documented limitation, since iteration is the overwhelmingly common case.
 */
function wrapRawStream(
  stream: object,
  span: Span,
  aggregator: ReturnType<typeof createStreamAggregator>
): object {
  async function* instrumentedIterator(): AsyncGenerator<RawMessageStreamEvent> {
    let completedNormally = false;
    try {
      for await (const event of stream as AsyncIterable<RawMessageStreamEvent>) {
        try {
          aggregator.observe(event, span);
        } catch {
          // Bookkeeping failure — keep forwarding events to the caller.
        }
        yield event;
      }
      completedNormally = true;
    } catch (streamError: unknown) {
      recordSpanError(span, streamError);
      throw streamError;
    } finally {
      // completedNormally distinguishes a fully-consumed stream (finalize +
      // OK) from an early `break` (return() runs finally without completion).
      if (completedNormally) {
        try {
          applyResponseAttributes(span, aggregator.finalize());
          span.setStatus({ code: SpanStatusCode.OK });
        } catch {
          // Bookkeeping failure — still end the span below.
        }
      }
      span.end();
    }
  }

  return new Proxy(stream, {
    get(target, property, receiver) {
      if (property === Symbol.asyncIterator) {
        return () => instrumentedIterator();
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

async function tracedCreateStream(
  originalCreate: (...args: unknown[]) => Promise<unknown>,
  params: MessageCreateParamsBase,
  options: unknown
): Promise<unknown> {
  const tracer = trace.getTracer(TRACER_NAME);

  let span: Span;
  let aggregator: ReturnType<typeof createStreamAggregator>;
  try {
    span = tracer.startSpan(chatSpanName(params.model), {
      kind: SpanKind.CLIENT,
    });
    setRequestAttributes(span, params);
    aggregator = createStreamAggregator();
  } catch {
    // Span setup failed — run the call untraced rather than break it.
    return originalCreate(params, options);
  }

  let stream: unknown;
  try {
    stream = await originalCreate(params, options);
  } catch (apiError: unknown) {
    recordSpanError(span, apiError);
    span.end();
    throw apiError;
  }

  if (stream === null || typeof stream !== "object") {
    // Not the iterable we expected — end the span and hand back what we got.
    span.end();
    return stream;
  }

  return wrapRawStream(stream, span, aggregator);
}

// ---------------------------------------------------------------------------
// Streaming via messages.stream() — MessageStream helper
// ---------------------------------------------------------------------------

/**
 * The subset of the SDK's MessageStream we depend on: an event emitter whose
 * `end` event fires on success (after `finalMessage`), on `abort`, and on
 * `error`, which lets a single `end` listener reliably close the span.
 */
interface MessageStreamLike {
  on: (event: string, listener: (...args: unknown[]) => void) => unknown;
}

function tracedStream(
  originalStream: (...args: unknown[]) => unknown,
  params: MessageCreateParamsBase,
  options: unknown
): unknown {
  const messageStream = originalStream(params, options);

  if (
    messageStream === null ||
    typeof messageStream !== "object" ||
    typeof (messageStream as { on?: unknown }).on !== "function"
  ) {
    // Not an emitter we can instrument — hand it back untouched.
    return messageStream;
  }

  const tracer = trace.getTracer(TRACER_NAME);
  try {
    const span = tracer.startSpan(chatSpanName(params.model), {
      kind: SpanKind.CLIENT,
    });
    setRequestAttributes(span, params);

    const emitter = messageStream as MessageStreamLike;
    emitter.on("finalMessage", (message: unknown) => {
      try {
        setResponseAttributes(span, message as Message);
        span.setStatus({ code: SpanStatusCode.OK });
      } catch {
        // Bookkeeping failure — the `end` listener still ends the span.
      }
    });
    emitter.on("error", (error: unknown) => recordSpanError(span, error));
    emitter.on("abort", (error: unknown) => recordSpanError(span, error));
    emitter.on("end", () => {
      try {
        span.end();
      } catch {
        // Nothing more we can do.
      }
    });
  } catch {
    // Span setup failed — return the real stream so the call still works.
  }

  return messageStream;
}

// ---------------------------------------------------------------------------
// Tool execution spans
// ---------------------------------------------------------------------------

/**
 * Wraps app-side tool execution in an `execute_tool {name}` span so the trace
 * shows the model's tool request, the actual execution, and the next model call
 * in sequence. Uses an active span so any instrumented calls made *inside* `fn`
 * (e.g. a nested model call) nest under this tool span.
 *
 * Tool arguments and result are app data, captured only when content capture is
 * enabled. Errors are recorded and rethrown — the tool's real behavior is never
 * altered.
 */
export function withToolSpan<T>(
  toolName: string,
  input: unknown,
  fn: () => T | Promise<T>
): Promise<T> {
  const tracer = trace.getTracer(TRACER_NAME);

  return tracer.startActiveSpan(
    executeToolSpanName(toolName),
    { kind: SpanKind.INTERNAL },
    async (span: Span) => {
      try {
        span.setAttribute(
          GenAiAttr.OPERATION_NAME,
          GenAiOperationName.EXECUTE_TOOL
        );
        span.setAttribute(GenAiAttr.TOOL_NAME, toolName);
        if (isContentCaptureEnabled()) {
          span.setAttribute(
            GenAiAttr.TOOL_CALL_ARGUMENTS,
            JSON.stringify(input)
          );
        }
      } catch {
        // Bookkeeping failure — run the tool anyway.
      }

      let result: T;
      try {
        result = await fn();
      } catch (toolError: unknown) {
        recordSpanError(span, toolError);
        span.end();
        throw toolError;
      }

      try {
        if (isContentCaptureEnabled()) {
          span.setAttribute(
            GenAiAttr.TOOL_CALL_RESULT,
            JSON.stringify(result)
          );
        }
        span.setStatus({ code: SpanStatusCode.OK });
      } catch {
        // Bookkeeping failure — still return the result.
      } finally {
        span.end();
      }

      return result;
    }
  );
}

// ---------------------------------------------------------------------------
// Client / resource proxies
// ---------------------------------------------------------------------------

/**
 * Wraps the `messages` resource so that `.create` (streaming and non-streaming)
 * and `.stream` are traced. All other properties pass through untouched.
 */
function buildMessagesProxy(messagesResource: MessagesResource): MessagesResource {
  return new Proxy(messagesResource, {
    get(target, property, receiver) {
      if (property === "create") {
        return function wrappedCreate(
          params: MessageCreateParamsBase,
          options?: unknown
        ): Promise<unknown> {
          const boundCreate = target.create.bind(target);
          if (params.stream === true) {
            return tracedCreateStream(boundCreate, params, options);
          }
          return tracedCreate(boundCreate, params, options);
        };
      }

      if (property === "stream" && typeof target.stream === "function") {
        const originalStream = target.stream;
        return function wrappedStream(
          params: MessageCreateParamsBase,
          options?: unknown
        ): unknown {
          const boundStream = originalStream.bind(target);
          return tracedStream(boundStream, params, options);
        };
      }

      return Reflect.get(target, property, receiver);
    },
  });
}

/**
 * Wraps an Anthropic SDK client so that every `messages.create`/`messages.stream`
 * call is recorded as an OTel span. All other client properties pass through
 * unchanged.
 *
 * If the client does not have a `.messages` property shaped like the Anthropic
 * messages resource, it is returned unchanged.
 */
export function instrumentAnthropic<T extends object>(client: T): T {
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property !== "messages") {
        return Reflect.get(target, property, receiver);
      }

      const messagesValue = Reflect.get(target, property, receiver) as unknown;

      if (
        messagesValue === null ||
        typeof messagesValue !== "object" ||
        !("create" in messagesValue) ||
        typeof (messagesValue as { create: unknown }).create !== "function"
      ) {
        return messagesValue;
      }

      return buildMessagesProxy(messagesValue as MessagesResource);
    },
  });
}
