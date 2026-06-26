import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { trace, SpanStatusCode } from "@opentelemetry/api";
import { instrumentAnthropic, withToolSpan } from "../src/instrument.js";
import {
  GenAiAttr,
  GenAiOperationName,
  GEN_AI_PROVIDER_ANTHROPIC,
  AnthropicAttr,
  ErrorAttr,
  LibraryEventName,
} from "../src/semconv.js";

// ---------------------------------------------------------------------------
// OTel in-memory setup
// ---------------------------------------------------------------------------

const spanExporter = new InMemorySpanExporter();
const tracerProvider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(spanExporter)],
});

trace.setGlobalTracerProvider(tracerProvider);

// ---------------------------------------------------------------------------
// Fake Anthropic message fixture
// ---------------------------------------------------------------------------

const FAKE_MODEL = "claude-sonnet-4-6";
const FAKE_RESPONSE_MODEL = "claude-sonnet-4-6-20251022";

const fakeMessage = {
  id: "msg_01XFDUDYJgAACzvnptvVoYEL",
  type: "message" as const,
  role: "assistant" as const,
  model: FAKE_RESPONSE_MODEL,
  content: [{ type: "text", text: "Hello!" }],
  stop_reason: "end_turn" as const,
  stop_sequence: null,
  stop_details: null,
  container: null,
  usage: {
    input_tokens: 100,
    output_tokens: 20,
    cache_read_input_tokens: 50,
    cache_creation_input_tokens: 10,
    cache_creation: null,
    inference_geo: null,
    server_tool_use: null,
    output_tokens_details: null,
  },
};

type FakeCreateFn = ReturnType<typeof vi.fn>;

function buildFakeClient(createFn: FakeCreateFn) {
  return {
    messages: {
      create: createFn,
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getFinishedSpans() {
  return spanExporter.getFinishedSpans();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("instrumentAnthropic", () => {
  beforeEach(() => {
    spanExporter.reset();
  });

  afterEach(() => {
    delete process.env["AGENT_OTEL_CAPTURE_CONTENT"];
  });

  it("produces exactly one span for a non-streaming create call", async () => {
    const createFn = vi.fn(async () => fakeMessage);
    const client = instrumentAnthropic(buildFakeClient(createFn));

    await client.messages.create({
      model: FAKE_MODEL,
      max_tokens: 1024,
      messages: [{ role: "user", content: "Hello" }],
    });

    const spans = getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe(`chat ${FAKE_MODEL}`);
  });

  it("sets correct request attributes on the span", async () => {
    const createFn = vi.fn(async () => fakeMessage);
    const client = instrumentAnthropic(buildFakeClient(createFn));

    await client.messages.create({
      model: FAKE_MODEL,
      max_tokens: 1024,
      temperature: 0.7,
      top_p: 0.9,
      messages: [{ role: "user", content: "Hello" }],
    });

    const span = getFinishedSpans()[0];
    expect(span).toBeDefined();
    const attributes = span!.attributes;

    expect(attributes[GenAiAttr.OPERATION_NAME]).toBe(GenAiOperationName.CHAT);
    expect(attributes[GenAiAttr.PROVIDER_NAME]).toBe(GEN_AI_PROVIDER_ANTHROPIC);
    expect(attributes[GenAiAttr.REQUEST_MODEL]).toBe(FAKE_MODEL);
    expect(attributes[GenAiAttr.REQUEST_MAX_TOKENS]).toBe(1024);
    expect(attributes[GenAiAttr.REQUEST_TEMPERATURE]).toBe(0.7);
    expect(attributes[GenAiAttr.REQUEST_TOP_P]).toBe(0.9);
  });

  it("sets correct response attributes including cache token fields", async () => {
    const createFn = vi.fn(async () => fakeMessage);
    const client = instrumentAnthropic(buildFakeClient(createFn));

    await client.messages.create({
      model: FAKE_MODEL,
      max_tokens: 1024,
      messages: [{ role: "user", content: "Hello" }],
    });

    const span = getFinishedSpans()[0];
    expect(span).toBeDefined();
    const attributes = span!.attributes;

    expect(attributes[GenAiAttr.RESPONSE_MODEL]).toBe(FAKE_RESPONSE_MODEL);
    expect(attributes[GenAiAttr.RESPONSE_ID]).toBe(fakeMessage.id);
    expect(attributes[GenAiAttr.RESPONSE_FINISH_REASONS]).toEqual(["end_turn"]);
    expect(attributes[GenAiAttr.USAGE_INPUT_TOKENS]).toBe(100);
    expect(attributes[GenAiAttr.USAGE_OUTPUT_TOKENS]).toBe(20);
    expect(attributes[AnthropicAttr.USAGE_CACHE_READ_INPUT_TOKENS]).toBe(50);
    expect(attributes[AnthropicAttr.USAGE_CACHE_CREATION_INPUT_TOKENS]).toBe(
      10
    );
  });

  it("returns the same response object the underlying create returned", async () => {
    const createFn = vi.fn(async () => fakeMessage);
    const client = instrumentAnthropic(buildFakeClient(createFn));

    const result = await client.messages.create({
      model: FAKE_MODEL,
      max_tokens: 1024,
      messages: [{ role: "user", content: "Hello" }],
    });

    expect(result).toBe(fakeMessage);
  });

  describe("content capture", () => {
    it("does NOT include content attributes when AGENT_OTEL_CAPTURE_CONTENT is off (default)", async () => {
      const createFn = vi.fn(async () => fakeMessage);
      const client = instrumentAnthropic(buildFakeClient(createFn));

      await client.messages.create({
        model: FAKE_MODEL,
        max_tokens: 1024,
        messages: [{ role: "user", content: "Hello" }],
        system: "You are a helpful assistant.",
      });

      const span = getFinishedSpans()[0];
      expect(span).toBeDefined();
      const attributes = span!.attributes;

      expect(GenAiAttr.INPUT_MESSAGES in attributes).toBe(false);
      expect(GenAiAttr.OUTPUT_MESSAGES in attributes).toBe(false);
      expect(GenAiAttr.SYSTEM_INSTRUCTIONS in attributes).toBe(false);
    });

    it("DOES include content attributes when AGENT_OTEL_CAPTURE_CONTENT=true", async () => {
      process.env["AGENT_OTEL_CAPTURE_CONTENT"] = "true";
      spanExporter.reset();

      const createFn = vi.fn(async () => fakeMessage);
      const client = instrumentAnthropic(buildFakeClient(createFn));

      const inputMessages = [{ role: "user", content: "Hello" }];
      const systemPrompt = "You are a helpful assistant.";

      await client.messages.create({
        model: FAKE_MODEL,
        max_tokens: 1024,
        messages: inputMessages,
        system: systemPrompt,
      });

      const span = getFinishedSpans()[0];
      expect(span).toBeDefined();
      const attributes = span!.attributes;

      expect(attributes[GenAiAttr.INPUT_MESSAGES]).toBe(
        JSON.stringify(inputMessages)
      );
      expect(attributes[GenAiAttr.SYSTEM_INSTRUCTIONS]).toBe(
        JSON.stringify(systemPrompt)
      );
      expect(attributes[GenAiAttr.OUTPUT_MESSAGES]).toBe(
        JSON.stringify(fakeMessage.content)
      );
    });
  });

  describe("error path", () => {
    it("rejects with the original error, sets ERROR status, and records error.type on the span", async () => {
      const originalError = new Error("API failure");
      originalError.name = "AnthropicError";

      const createFn = vi.fn(async () => {
        throw originalError;
      });
      const client = instrumentAnthropic(buildFakeClient(createFn));

      await expect(
        client.messages.create({
          model: FAKE_MODEL,
          max_tokens: 1024,
          messages: [{ role: "user", content: "Hello" }],
        })
      ).rejects.toThrow(originalError);

      const span = getFinishedSpans()[0];
      expect(span).toBeDefined();
      expect(span!.status.code).toBe(SpanStatusCode.ERROR);
      expect(span!.attributes[ErrorAttr.TYPE]).toBe("AnthropicError");
    });
  });

  describe("tool_use events (non-streaming)", () => {
    const toolUseMessage = {
      ...fakeMessage,
      stop_reason: "tool_use" as const,
      content: [
        {
          type: "tool_use" as const,
          id: "toolu_abc123",
          name: "get_weather",
          input: { city: "San Francisco" },
        },
      ],
    };

    it("adds a tool_use event per tool_use block, with name and id always, arguments only on capture", async () => {
      const createFn = vi.fn(async () => toolUseMessage);
      const client = instrumentAnthropic(buildFakeClient(createFn));

      await client.messages.create({
        model: FAKE_MODEL,
        max_tokens: 1024,
        messages: [{ role: "user", content: "Weather?" }],
      });

      const span = getFinishedSpans()[0];
      expect(span).toBeDefined();
      const events = span!.events;
      expect(events).toHaveLength(1);
      expect(events[0]?.name).toBe(LibraryEventName.TOOL_USE);
      expect(events[0]?.attributes?.[GenAiAttr.TOOL_NAME]).toBe("get_weather");
      expect(events[0]?.attributes?.[GenAiAttr.TOOL_CALL_ID]).toBe("toolu_abc123");
      // Arguments are content — omitted by default.
      expect(
        GenAiAttr.TOOL_CALL_ARGUMENTS in (events[0]?.attributes ?? {})
      ).toBe(false);
    });

    it("includes tool arguments in the event when content capture is on", async () => {
      process.env["AGENT_OTEL_CAPTURE_CONTENT"] = "true";
      const createFn = vi.fn(async () => toolUseMessage);
      const client = instrumentAnthropic(buildFakeClient(createFn));

      await client.messages.create({
        model: FAKE_MODEL,
        max_tokens: 1024,
        messages: [{ role: "user", content: "Weather?" }],
      });

      const event = getFinishedSpans()[0]?.events[0];
      expect(event?.attributes?.[GenAiAttr.TOOL_CALL_ARGUMENTS]).toBe(
        JSON.stringify({ city: "San Francisco" })
      );
    });
  });

  describe("streaming via create({ stream: true })", () => {
    function buildRawStreamEvents() {
      return [
        {
          type: "message_start" as const,
          message: {
            ...fakeMessage,
            content: [],
            stop_reason: null,
            usage: {
              input_tokens: 100,
              output_tokens: 1,
              cache_read_input_tokens: 50,
              cache_creation_input_tokens: 10,
              cache_creation: null,
              inference_geo: null,
              server_tool_use: null,
              output_tokens_details: null,
            },
          },
        },
        {
          type: "content_block_start" as const,
          index: 0,
          content_block: { type: "text" as const, text: "", citations: null },
        },
        {
          type: "content_block_delta" as const,
          index: 0,
          delta: { type: "text_delta" as const, text: "Hello" },
        },
        {
          type: "content_block_delta" as const,
          index: 0,
          delta: { type: "text_delta" as const, text: "!" },
        },
        { type: "content_block_stop" as const, index: 0 },
        {
          type: "message_delta" as const,
          delta: {
            stop_reason: "end_turn" as const,
            stop_sequence: null,
            container: null,
            stop_details: null,
          },
          usage: {
            input_tokens: null,
            output_tokens: 20,
            cache_read_input_tokens: null,
            cache_creation_input_tokens: null,
            output_tokens_details: null,
            server_tool_use: null,
          },
        },
        { type: "message_stop" as const },
      ];
    }

    function buildFakeRawStream(events: unknown[]) {
      return {
        async *[Symbol.asyncIterator]() {
          for (const event of events) {
            yield event;
          }
        },
        tee() {
          return "tee-passthrough";
        },
      };
    }

    async function drain(stream: AsyncIterable<unknown>): Promise<void> {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _event of stream) {
        // consume
      }
    }

    it("opens the span when the stream starts and closes it only after full consumption", async () => {
      const fakeStream = buildFakeRawStream(buildRawStreamEvents());
      const createFn = vi.fn(async () => fakeStream);
      const client = instrumentAnthropic(buildFakeClient(createFn));

      const stream = (await client.messages.create({
        model: FAKE_MODEL,
        max_tokens: 1024,
        messages: [{ role: "user", content: "Hi" }],
        stream: true,
      })) as AsyncIterable<unknown>;

      // Not ended yet — the caller has not consumed the stream.
      expect(getFinishedSpans()).toHaveLength(0);

      await drain(stream);

      const spans = getFinishedSpans();
      expect(spans).toHaveLength(1);
      expect(spans[0]?.name).toBe(`chat ${FAKE_MODEL}`);
    });

    it("aggregates usage, cache, and finish reason from the event sequence", async () => {
      const fakeStream = buildFakeRawStream(buildRawStreamEvents());
      const createFn = vi.fn(async () => fakeStream);
      const client = instrumentAnthropic(buildFakeClient(createFn));

      const stream = (await client.messages.create({
        model: FAKE_MODEL,
        max_tokens: 1024,
        messages: [{ role: "user", content: "Hi" }],
        stream: true,
      })) as AsyncIterable<unknown>;
      await drain(stream);

      const attributes = getFinishedSpans()[0]!.attributes;
      expect(attributes[GenAiAttr.RESPONSE_MODEL]).toBe(FAKE_RESPONSE_MODEL);
      expect(attributes[GenAiAttr.RESPONSE_ID]).toBe(fakeMessage.id);
      expect(attributes[GenAiAttr.USAGE_INPUT_TOKENS]).toBe(100);
      expect(attributes[GenAiAttr.USAGE_OUTPUT_TOKENS]).toBe(20);
      expect(attributes[AnthropicAttr.USAGE_CACHE_READ_INPUT_TOKENS]).toBe(50);
      expect(attributes[AnthropicAttr.USAGE_CACHE_CREATION_INPUT_TOKENS]).toBe(
        10
      );
      expect(attributes[GenAiAttr.RESPONSE_FINISH_REASONS]).toEqual([
        "end_turn",
      ]);
    });

    it("buffers streamed text into output.messages only when content capture is on", async () => {
      process.env["AGENT_OTEL_CAPTURE_CONTENT"] = "true";
      const fakeStream = buildFakeRawStream(buildRawStreamEvents());
      const createFn = vi.fn(async () => fakeStream);
      const client = instrumentAnthropic(buildFakeClient(createFn));

      const stream = (await client.messages.create({
        model: FAKE_MODEL,
        max_tokens: 1024,
        messages: [{ role: "user", content: "Hi" }],
        stream: true,
      })) as AsyncIterable<unknown>;
      await drain(stream);

      expect(getFinishedSpans()[0]!.attributes[GenAiAttr.OUTPUT_MESSAGES]).toBe(
        "Hello!"
      );
    });

    it("emits a tool_use event when the model opens a tool_use block mid-stream", async () => {
      const events = buildRawStreamEvents();
      events.splice(1, 0, {
        // @ts-expect-error minimal tool_use start fixture
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_stream_1",
          name: "search",
          input: {},
        },
      });
      const fakeStream = buildFakeRawStream(events);
      const createFn = vi.fn(async () => fakeStream);
      const client = instrumentAnthropic(buildFakeClient(createFn));

      const stream = (await client.messages.create({
        model: FAKE_MODEL,
        max_tokens: 1024,
        messages: [{ role: "user", content: "Hi" }],
        stream: true,
      })) as AsyncIterable<unknown>;
      await drain(stream);

      const toolEvents = getFinishedSpans()[0]!.events.filter(
        (event) => event.name === LibraryEventName.TOOL_USE
      );
      expect(toolEvents).toHaveLength(1);
      expect(toolEvents[0]?.attributes?.[GenAiAttr.TOOL_NAME]).toBe("search");
      expect(toolEvents[0]?.attributes?.[GenAiAttr.TOOL_CALL_ID]).toBe(
        "toolu_stream_1"
      );
    });

    it("records ERROR status when the underlying stream throws during iteration", async () => {
      const failingStream = {
        // eslint-disable-next-line require-yield
        async *[Symbol.asyncIterator]() {
          throw Object.assign(new Error("stream broke"), {
            name: "APIError",
          });
        },
      };
      const createFn = vi.fn(async () => failingStream);
      const client = instrumentAnthropic(buildFakeClient(createFn));

      const stream = (await client.messages.create({
        model: FAKE_MODEL,
        max_tokens: 1024,
        messages: [{ role: "user", content: "Hi" }],
        stream: true,
      })) as AsyncIterable<unknown>;

      await expect(drain(stream)).rejects.toThrow("stream broke");

      const span = getFinishedSpans()[0];
      expect(span!.status.code).toBe(SpanStatusCode.ERROR);
      expect(span!.attributes[ErrorAttr.TYPE]).toBe("APIError");
    });

    it("passes non-iterator stream members (e.g. tee) through the wrapper", async () => {
      const fakeStream = buildFakeRawStream(buildRawStreamEvents());
      const createFn = vi.fn(async () => fakeStream);
      const client = instrumentAnthropic(buildFakeClient(createFn));

      const stream = (await client.messages.create({
        model: FAKE_MODEL,
        max_tokens: 1024,
        messages: [{ role: "user", content: "Hi" }],
        stream: true,
      })) as { tee: () => string };

      expect(stream.tee()).toBe("tee-passthrough");
    });
  });

  describe("streaming via messages.stream()", () => {
    function buildFakeMessageStream() {
      const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
      return {
        on(event: string, listener: (...args: unknown[]) => void) {
          (listeners[event] ||= []).push(listener);
          return this;
        },
        emit(event: string, ...args: unknown[]) {
          (listeners[event] ?? []).forEach((listener) => listener(...args));
        },
      };
    }

    function buildStreamingClient(fakeStream: unknown) {
      return {
        messages: {
          create: vi.fn(),
          stream: vi.fn(() => fakeStream),
        },
      };
    }

    it("records a chat span from finalMessage and ends it on the end event", () => {
      const fakeStream = buildFakeMessageStream();
      const client = instrumentAnthropic(buildStreamingClient(fakeStream));

      const returned = client.messages.stream({
        model: FAKE_MODEL,
        max_tokens: 1024,
        messages: [{ role: "user", content: "Hi" }],
      }) as ReturnType<typeof buildFakeMessageStream>;

      // The same MessageStream object is returned, with our listeners attached.
      expect(returned).toBe(fakeStream);
      expect(getFinishedSpans()).toHaveLength(0);

      fakeStream.emit("finalMessage", fakeMessage);
      fakeStream.emit("end");

      const spans = getFinishedSpans();
      expect(spans).toHaveLength(1);
      expect(spans[0]?.name).toBe(`chat ${FAKE_MODEL}`);
      expect(spans[0]?.status.code).toBe(SpanStatusCode.OK);
      expect(spans[0]?.attributes[GenAiAttr.USAGE_OUTPUT_TOKENS]).toBe(20);
      expect(spans[0]?.attributes[GenAiAttr.RESPONSE_FINISH_REASONS]).toEqual([
        "end_turn",
      ]);
    });

    it("records ERROR status when the stream emits an error", () => {
      const fakeStream = buildFakeMessageStream();
      const client = instrumentAnthropic(buildStreamingClient(fakeStream));

      client.messages.stream({
        model: FAKE_MODEL,
        max_tokens: 1024,
        messages: [{ role: "user", content: "Hi" }],
      });

      const error = Object.assign(new Error("stream failed"), {
        name: "AnthropicError",
      });
      fakeStream.emit("error", error);
      fakeStream.emit("end");

      const span = getFinishedSpans()[0];
      expect(span!.status.code).toBe(SpanStatusCode.ERROR);
      expect(span!.attributes[ErrorAttr.TYPE]).toBe("AnthropicError");
    });
  });

  describe("withToolSpan", () => {
    it("creates an execute_tool span and returns the tool result", async () => {
      const result = await withToolSpan("read_file", { path: "a.txt" }, () =>
        Promise.resolve("file contents")
      );

      expect(result).toBe("file contents");

      const span = getFinishedSpans()[0];
      expect(span).toBeDefined();
      expect(span!.name).toBe("execute_tool read_file");
      expect(span!.attributes[GenAiAttr.OPERATION_NAME]).toBe(
        GenAiOperationName.EXECUTE_TOOL
      );
      expect(span!.attributes[GenAiAttr.TOOL_NAME]).toBe("read_file");
      expect(span!.status.code).toBe(SpanStatusCode.OK);
    });

    it("does not record arguments/result by default, but does under content capture", async () => {
      await withToolSpan("read_file", { path: "a.txt" }, () =>
        Promise.resolve("contents")
      );
      const defaultSpan = getFinishedSpans()[0];
      expect(GenAiAttr.TOOL_CALL_ARGUMENTS in defaultSpan!.attributes).toBe(
        false
      );
      expect(GenAiAttr.TOOL_CALL_RESULT in defaultSpan!.attributes).toBe(false);

      process.env["AGENT_OTEL_CAPTURE_CONTENT"] = "true";
      spanExporter.reset();

      await withToolSpan("read_file", { path: "a.txt" }, () =>
        Promise.resolve("contents")
      );
      const captureSpan = getFinishedSpans()[0];
      expect(captureSpan!.attributes[GenAiAttr.TOOL_CALL_ARGUMENTS]).toBe(
        JSON.stringify({ path: "a.txt" })
      );
      expect(captureSpan!.attributes[GenAiAttr.TOOL_CALL_RESULT]).toBe(
        JSON.stringify("contents")
      );
    });

    it("records ERROR status and rethrows when the tool fails", async () => {
      const toolError = Object.assign(new Error("disk full"), {
        name: "ToolError",
      });

      await expect(
        withToolSpan("write_file", { path: "a.txt" }, () => {
          throw toolError;
        })
      ).rejects.toThrow("disk full");

      const span = getFinishedSpans()[0];
      expect(span!.status.code).toBe(SpanStatusCode.ERROR);
      expect(span!.attributes[ErrorAttr.TYPE]).toBe("ToolError");
    });
  });
});
