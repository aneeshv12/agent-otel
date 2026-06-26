import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { trace, SpanStatusCode } from "@opentelemetry/api";
import { instrumentAgentQuery } from "../src/agentInstrument.js";
import { GenAiAttr, AnthropicAttr, ErrorAttr, LibraryEventName } from "../src/semconv.js";

// ---------------------------------------------------------------------------
// OTel in-memory setup
// ---------------------------------------------------------------------------

const spanExporter = new InMemorySpanExporter();
trace.setGlobalTracerProvider(
  new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(spanExporter)],
  })
);

// ---------------------------------------------------------------------------
// SDKMessage fixtures (shaped to what the builder reads; loosely typed for tests)
// ---------------------------------------------------------------------------

const MODEL = "claude-sonnet-4-6";

function usage(over: Record<string, number> = {}) {
  return {
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    ...over,
  };
}

function systemInit() {
  return {
    type: "system",
    subtype: "init",
    session_id: "sess_1",
    model: MODEL,
    tools: [],
    mcp_servers: [],
    uuid: "u",
  };
}

function toolUse(id: string, name: string, input: unknown = {}) {
  return { type: "tool_use", id, name, input };
}

function text(value: string) {
  return { type: "text", text: value };
}

interface AssistantOpts {
  parent?: string | null;
  content?: unknown[];
  stop_reason?: string | null;
  subagent_type?: string;
  task_description?: string;
  error?: string;
  usg?: ReturnType<typeof usage>;
}

function assistant(opts: AssistantOpts = {}) {
  const message: Record<string, unknown> = {
    type: "assistant",
    parent_tool_use_id: opts.parent ?? null,
    message: {
      type: "message",
      role: "assistant",
      id: "msg_x",
      model: MODEL,
      stop_reason: opts.stop_reason ?? "end_turn",
      content: opts.content ?? [text("hi")],
      usage: opts.usg ?? usage(),
    },
  };
  if (opts.subagent_type !== undefined) message["subagent_type"] = opts.subagent_type;
  if (opts.task_description !== undefined) message["task_description"] = opts.task_description;
  if (opts.error !== undefined) message["error"] = opts.error;
  return message;
}

interface ToolResult {
  id: string;
  content?: string;
  is_error?: boolean;
}

function userToolResult(parent: string | null, results: ToolResult[]) {
  return {
    type: "user",
    parent_tool_use_id: parent,
    message: {
      role: "user",
      content: results.map((r) => ({
        type: "tool_result",
        tool_use_id: r.id,
        content: r.content ?? "ok",
        is_error: r.is_error ?? false,
      })),
    },
  };
}

function result(over: Record<string, unknown> = {}) {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 1234,
    duration_api_ms: 1000,
    is_error: false,
    num_turns: 2,
    result: "done",
    stop_reason: null,
    total_cost_usd: 0.0123,
    usage: usage({ input_tokens: 100, output_tokens: 50 }),
    modelUsage: {},
    permission_denials: [],
    session_id: "sess_1",
    uuid: "u",
    ...over,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function* asStream(messages: any[]): AsyncGenerator<any> {
  for (const message of messages) {
    yield message;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function drain(gen: AsyncIterable<any>): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _ of gen) {
    // consume
  }
}

// ---------------------------------------------------------------------------
// Span-tree helpers
// ---------------------------------------------------------------------------

function spansById(spans: ReadableSpan[]): Map<string, ReadableSpan> {
  return new Map(spans.map((s) => [s.spanContext().spanId, s]));
}

function parentOf(span: ReadableSpan, byId: Map<string, ReadableSpan>) {
  const parentId = span.parentSpanContext?.spanId;
  return parentId ? byId.get(parentId) : undefined;
}

function byName(spans: ReadableSpan[], name: string): ReadableSpan {
  const found = spans.find((s) => s.name === name);
  if (!found) throw new Error(`no span named ${name}`);
  return found;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("instrumentAgentQuery", () => {
  beforeEach(() => spanExporter.reset());
  afterEach(() => {
    delete process.env["AGENT_OTEL_CAPTURE_CONTENT"];
  });

  it("builds session -> turn -> tool_call spans, all in one trace", async () => {
    await drain(
      instrumentAgentQuery(
        asStream([
          systemInit(),
          assistant({
            content: [toolUse("t1", "get_weather", { city: "SF" })],
            stop_reason: "tool_use",
          }),
          userToolResult(null, [{ id: "t1", content: "23C" }]),
          assistant({ content: [text("It's 23C")] }),
          result(),
        ])
      )
    );

    const spans = spanExporter.getFinishedSpans();
    const byId = spansById(spans);

    // 1 session + 2 turns + 1 tool = 4 spans
    expect(spans).toHaveLength(4);
    expect(spans.filter((s) => s.name === "invoke_agent")).toHaveLength(1);
    expect(spans.filter((s) => s.name === `chat ${MODEL}`)).toHaveLength(2);
    expect(spans.filter((s) => s.name === "execute_tool get_weather")).toHaveLength(1);

    // one trace
    const traceIds = new Set(spans.map((s) => s.spanContext().traceId));
    expect(traceIds.size).toBe(1);

    const session = byName(spans, "invoke_agent");
    const tool = byName(spans, "execute_tool get_weather");
    const turnWithTool = parentOf(tool, byId);

    expect(turnWithTool?.name).toBe(`chat ${MODEL}`);
    expect(parentOf(turnWithTool!, byId)).toBe(session);
    expect(session.parentSpanContext).toBeUndefined(); // root

    // tool_use event sits on the turn span
    expect(turnWithTool!.events.map((e) => e.name)).toContain(
      LibraryEventName.TOOL_USE
    );

    // session carries result-level usage/cost/turns
    expect(session.attributes[GenAiAttr.USAGE_INPUT_TOKENS]).toBe(100);
    expect(session.attributes[GenAiAttr.USAGE_OUTPUT_TOKENS]).toBe(50);
    expect(session.attributes[AnthropicAttr.AGENT_NUM_TURNS]).toBe(2);
    expect(session.attributes[AnthropicAttr.AGENT_COST_USD]).toBe(0.0123);
    expect(session.status.code).toBe(SpanStatusCode.OK);
  });

  it("nests subagent turns under their spawning Task tool span", async () => {
    await drain(
      instrumentAgentQuery(
        asStream([
          systemInit(),
          // root turn requests a Task (spawns a subagent)
          assistant({
            content: [toolUse("task_1", "Task", { description: "search" })],
            stop_reason: "tool_use",
          }),
          // subagent turn: runs its own tool
          assistant({
            parent: "task_1",
            subagent_type: "search-agent",
            task_description: "find the file",
            content: [toolUse("sub_1", "grep_files", { q: "X" })],
            stop_reason: "tool_use",
          }),
          userToolResult("task_1", [{ id: "sub_1", content: "found" }]),
          // subagent's final turn
          assistant({
            parent: "task_1",
            subagent_type: "search-agent",
            content: [text("Found it")],
          }),
          // Task tool returns to the parent agent
          userToolResult(null, [{ id: "task_1", content: "subagent done" }]),
          assistant({ content: [text("All done")] }),
          result(),
        ])
      )
    );

    const spans = spanExporter.getFinishedSpans();
    const byId = spansById(spans);

    const taskTool = byName(spans, "execute_tool Task");
    const grepTool = byName(spans, "execute_tool grep_files");

    // The subagent turn is the chat span tagged with the subagent type.
    const subagentTurns = spans.filter(
      (s) =>
        s.name === `chat ${MODEL}` &&
        s.attributes[GenAiAttr.AGENT_NAME] === "search-agent"
    );
    expect(subagentTurns.length).toBeGreaterThanOrEqual(1);

    // The Task tool span hangs off a root-level turn, which hangs off the session.
    const rootTurnForTask = parentOf(taskTool, byId);
    expect(rootTurnForTask?.name).toBe(`chat ${MODEL}`);
    expect(parentOf(rootTurnForTask!, byId)?.name).toBe("invoke_agent");

    // The subagent turn that ran grep is a child of the Task tool span...
    const subagentTurnWithGrep = parentOf(grepTool, byId)!;
    expect(subagentTurnWithGrep.attributes[GenAiAttr.AGENT_NAME]).toBe(
      "search-agent"
    );
    expect(parentOf(subagentTurnWithGrep, byId)).toBe(taskTool);

    // ...and everything is still one trace.
    expect(new Set(spans.map((s) => s.spanContext().traceId)).size).toBe(1);
  });

  it("marks an execute_tool span ERROR when the tool_result is_error", async () => {
    await drain(
      instrumentAgentQuery(
        asStream([
          systemInit(),
          assistant({
            content: [toolUse("t1", "query_db", {})],
            stop_reason: "tool_use",
          }),
          userToolResult(null, [
            { id: "t1", content: "connection refused", is_error: true },
          ]),
          assistant({ content: [text("failed")] }),
          result(),
        ])
      )
    );

    const tool = byName(spanExporter.getFinishedSpans(), "execute_tool query_db");
    expect(tool.status.code).toBe(SpanStatusCode.ERROR);
    expect(tool.attributes[ErrorAttr.TYPE]).toBe("tool_error");
  });

  it("marks the session span ERROR when the result subtype is an error", async () => {
    await drain(
      instrumentAgentQuery(
        asStream([
          systemInit(),
          assistant({ content: [text("...")] }),
          result({ subtype: "error_max_turns", is_error: true }),
        ])
      )
    );

    const session = byName(spanExporter.getFinishedSpans(), "invoke_agent");
    expect(session.status.code).toBe(SpanStatusCode.ERROR);
    expect(session.attributes[ErrorAttr.TYPE]).toBe("error_max_turns");
  });

  it("captures tool arguments/results only when content capture is enabled", async () => {
    const messages = [
      systemInit(),
      assistant({
        content: [toolUse("t1", "get_weather", { city: "SF" })],
        stop_reason: "tool_use",
      }),
      userToolResult(null, [{ id: "t1", content: "23C" }]),
      assistant({ content: [text("done")] }),
      result(),
    ];

    await drain(instrumentAgentQuery(asStream(messages)));
    let tool = byName(spanExporter.getFinishedSpans(), "execute_tool get_weather");
    expect(GenAiAttr.TOOL_CALL_ARGUMENTS in tool.attributes).toBe(false);
    expect(GenAiAttr.TOOL_CALL_RESULT in tool.attributes).toBe(false);

    spanExporter.reset();
    process.env["AGENT_OTEL_CAPTURE_CONTENT"] = "true";
    await drain(instrumentAgentQuery(asStream(messages)));
    tool = byName(spanExporter.getFinishedSpans(), "execute_tool get_weather");
    expect(tool.attributes[GenAiAttr.TOOL_CALL_ARGUMENTS]).toBe(
      JSON.stringify({ city: "SF" })
    );
    expect(tool.attributes[GenAiAttr.TOOL_CALL_RESULT]).toBe("23C");
  });

  it("records ERROR on the session and rethrows when the stream throws", async () => {
    const boom = Object.assign(new Error("stream died"), { name: "StreamError" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async function* failing(): AsyncGenerator<any> {
      yield systemInit();
      yield assistant({ content: [text("partial")] });
      throw boom;
    }

    await expect(drain(instrumentAgentQuery(failing()))).rejects.toThrow(
      "stream died"
    );

    const session = byName(spanExporter.getFinishedSpans(), "invoke_agent");
    expect(session.status.code).toBe(SpanStatusCode.ERROR);
    expect(session.attributes[ErrorAttr.TYPE]).toBe("StreamError");
  });
});
