import { trace, context, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { Span, Context, Attributes } from "@opentelemetry/api";
import type {
  SDKMessage,
  SDKAssistantMessage,
  SDKUserMessage,
  SDKResultMessage,
  SDKSystemMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  GenAiAttr,
  GenAiOperationName,
  GEN_AI_PROVIDER_ANTHROPIC,
  AnthropicAttr,
  ErrorAttr,
  LibraryEventName,
  chatSpanName,
  executeToolSpanName,
  invokeAgentSpanName,
} from "./semconv.js";
import { TRACER_NAME, recordSpanError, isContentCaptureEnabled } from "./instrument.js";

/** Key used in the per-parent turn map for top-level (non-subagent) turns. */
const ROOT_PARENT_KEY = "__root__";

function stringifyContent(content: unknown): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}

/**
 * Reconstructs an OTel span tree from the Claude Agent SDK's flat `SDKMessage`
 * stream. The SDK emits messages, not spans, so this builder correlates them:
 *
 *   - `system`/`init`            -> opens the root `invoke_agent` session span
 *   - each `assistant` message   -> a `chat {model}` turn span under its parent
 *   - each `tool_use` block      -> an `execute_tool {name}` span, held open
 *                                   until its matching `tool_result` arrives
 *   - `result`                   -> closes the session span with usage/cost
 *
 * Subagents are nested via `parent_tool_use_id`: a message produced inside a
 * subagent carries the `tool_use_id` of the `Task` call that spawned it, so its
 * turn span is parented under that still-open `execute_tool` span. This recurses
 * naturally to any depth.
 *
 * All parent/child links are set explicitly (via `trace.setSpan`), so the tree
 * does not depend on an ambient context manager being registered.
 */
class AgentTraceBuilder {
  private readonly tracer = trace.getTracer(TRACER_NAME);
  private sessionSpan: Span | undefined;
  private sessionContext: Context | undefined;
  /** tool_use_id -> the open execute_tool span awaiting its tool_result. */
  private readonly openToolSpans = new Map<string, Span>();
  /** tool_use_id -> context whose active span is that tool span (parent for subagent turns). */
  private readonly toolSpanContexts = new Map<string, Context>();
  /** parent key (tool_use_id or ROOT) -> the currently open turn span for that agent context. */
  private readonly openTurns = new Map<string, Span>();

  observe(message: SDKMessage): void {
    try {
      switch (message.type) {
        case "system":
          if (message.subtype === "init") {
            this.startSession(message);
          }
          break;
        case "assistant":
          this.onAssistant(message);
          break;
        case "user":
          this.onUser(message);
          break;
        case "result":
          this.onResult(message);
          break;
        default:
          // Status/progress/notification messages carry no span structure in v1.
          break;
      }
    } catch {
      // Span bookkeeping must never break the caller's iteration over messages.
    }
  }

  /** Marks the session errored when the stream throws before a result message. */
  finalizeWithError(error: unknown): void {
    if (this.sessionSpan !== undefined) {
      recordSpanError(this.sessionSpan, error);
    }
  }

  /** Closes any spans still open (e.g. the stream ended without a result message). */
  finalize(): void {
    try {
      this.closeAllOpen();
      if (this.sessionSpan !== undefined) {
        this.sessionSpan.end();
        this.sessionSpan = undefined;
      }
    } catch {
      // Best-effort cleanup.
    }
  }

  private startSession(message: SDKSystemMessage): void {
    const baseContext = context.active();
    const span = this.tracer.startSpan(
      invokeAgentSpanName(),
      { kind: SpanKind.INTERNAL },
      baseContext
    );
    span.setAttribute(GenAiAttr.OPERATION_NAME, GenAiOperationName.INVOKE_AGENT);
    span.setAttribute(GenAiAttr.PROVIDER_NAME, GEN_AI_PROVIDER_ANTHROPIC);
    span.setAttribute(GenAiAttr.CONVERSATION_ID, message.session_id);
    span.setAttribute(GenAiAttr.REQUEST_MODEL, message.model);
    this.sessionSpan = span;
    this.sessionContext = trace.setSpan(baseContext, span);
  }

  private onAssistant(message: SDKAssistantMessage): void {
    if (this.sessionContext === undefined) {
      return;
    }
    const parentToolUseId = message.parent_tool_use_id;
    const turnKey = parentToolUseId ?? ROOT_PARENT_KEY;

    // A new assistant message for this agent context ends the previous turn.
    this.endTurn(turnKey);

    const parentContext = this.contextForParent(parentToolUseId);
    const betaMessage = message.message;
    const turnSpan = this.tracer.startSpan(
      chatSpanName(betaMessage.model),
      { kind: SpanKind.CLIENT },
      parentContext
    );
    this.setTurnAttributes(turnSpan, message);

    this.openTurns.set(turnKey, turnSpan);
    const turnContext = trace.setSpan(parentContext, turnSpan);

    // Open an execute_tool span per tool_use block; it stays open until the
    // matching tool_result arrives (and, for a Task tool, hosts the subagent).
    for (const block of betaMessage.content) {
      if (block.type !== "tool_use") {
        continue;
      }
      const eventAttributes: Attributes = {
        [GenAiAttr.TOOL_NAME]: block.name,
        [GenAiAttr.TOOL_CALL_ID]: block.id,
      };
      if (isContentCaptureEnabled()) {
        eventAttributes[GenAiAttr.TOOL_CALL_ARGUMENTS] = JSON.stringify(
          block.input
        );
      }
      turnSpan.addEvent(LibraryEventName.TOOL_USE, eventAttributes);

      const toolSpan = this.tracer.startSpan(
        executeToolSpanName(block.name),
        { kind: SpanKind.INTERNAL },
        turnContext
      );
      toolSpan.setAttribute(
        GenAiAttr.OPERATION_NAME,
        GenAiOperationName.EXECUTE_TOOL
      );
      toolSpan.setAttribute(GenAiAttr.TOOL_NAME, block.name);
      toolSpan.setAttribute(GenAiAttr.TOOL_CALL_ID, block.id);
      if (isContentCaptureEnabled()) {
        toolSpan.setAttribute(
          GenAiAttr.TOOL_CALL_ARGUMENTS,
          JSON.stringify(block.input)
        );
      }
      this.openToolSpans.set(block.id, toolSpan);
      this.toolSpanContexts.set(block.id, trace.setSpan(turnContext, toolSpan));
    }
  }

  private onUser(message: SDKUserMessage): void {
    const content = message.message.content;
    if (typeof content === "string") {
      return; // A plain prompt, not a tool_result carrier.
    }
    for (const block of content) {
      if (block.type !== "tool_result") {
        continue;
      }
      const toolSpan = this.openToolSpans.get(block.tool_use_id);
      if (toolSpan === undefined) {
        continue;
      }
      // A subagent's last turn may still be open under this Task tool span; close
      // it before closing the tool span itself so nesting stays well-formed.
      this.endTurn(block.tool_use_id);

      if (isContentCaptureEnabled() && block.content !== undefined) {
        toolSpan.setAttribute(
          GenAiAttr.TOOL_CALL_RESULT,
          stringifyContent(block.content)
        );
      }
      if (block.is_error === true) {
        toolSpan.setStatus({ code: SpanStatusCode.ERROR });
        toolSpan.setAttribute(ErrorAttr.TYPE, "tool_error");
      } else {
        toolSpan.setStatus({ code: SpanStatusCode.OK });
      }
      toolSpan.end();
      this.openToolSpans.delete(block.tool_use_id);
      this.toolSpanContexts.delete(block.tool_use_id);
    }
  }

  private onResult(message: SDKResultMessage): void {
    this.closeAllOpen();
    if (this.sessionSpan === undefined) {
      return;
    }
    const usage = message.usage;
    this.sessionSpan.setAttribute(
      GenAiAttr.USAGE_INPUT_TOKENS,
      usage.input_tokens
    );
    this.sessionSpan.setAttribute(
      GenAiAttr.USAGE_OUTPUT_TOKENS,
      usage.output_tokens
    );
    if (usage.cache_read_input_tokens > 0) {
      this.sessionSpan.setAttribute(
        AnthropicAttr.USAGE_CACHE_READ_INPUT_TOKENS,
        usage.cache_read_input_tokens
      );
    }
    if (usage.cache_creation_input_tokens > 0) {
      this.sessionSpan.setAttribute(
        AnthropicAttr.USAGE_CACHE_CREATION_INPUT_TOKENS,
        usage.cache_creation_input_tokens
      );
    }
    this.sessionSpan.setAttribute(
      AnthropicAttr.AGENT_NUM_TURNS,
      message.num_turns
    );
    this.sessionSpan.setAttribute(
      AnthropicAttr.AGENT_DURATION_MS,
      message.duration_ms
    );
    this.sessionSpan.setAttribute(
      AnthropicAttr.AGENT_COST_USD,
      message.total_cost_usd
    );

    if (message.subtype === "success") {
      this.sessionSpan.setStatus({ code: SpanStatusCode.OK });
    } else {
      this.sessionSpan.setStatus({ code: SpanStatusCode.ERROR });
      this.sessionSpan.setAttribute(ErrorAttr.TYPE, message.subtype);
    }
    this.sessionSpan.end();
    this.sessionSpan = undefined;
    this.sessionContext = undefined;
  }

  /** Resolves the parent context for a message given its parent_tool_use_id. */
  private contextForParent(parentToolUseId: string | null): Context {
    if (parentToolUseId !== null) {
      const toolContext = this.toolSpanContexts.get(parentToolUseId);
      if (toolContext !== undefined) {
        return toolContext;
      }
    }
    // Top-level message, or a subagent whose parent tool span was not found.
    return this.sessionContext ?? context.active();
  }

  private endTurn(turnKey: string): void {
    const turnSpan = this.openTurns.get(turnKey);
    if (turnSpan !== undefined) {
      turnSpan.end();
      this.openTurns.delete(turnKey);
    }
  }

  private setTurnAttributes(span: Span, message: SDKAssistantMessage): void {
    const betaMessage = message.message;
    span.setAttribute(GenAiAttr.OPERATION_NAME, GenAiOperationName.CHAT);
    span.setAttribute(GenAiAttr.PROVIDER_NAME, GEN_AI_PROVIDER_ANTHROPIC);
    span.setAttribute(GenAiAttr.REQUEST_MODEL, betaMessage.model);
    span.setAttribute(GenAiAttr.RESPONSE_MODEL, betaMessage.model);
    span.setAttribute(GenAiAttr.RESPONSE_ID, betaMessage.id);
    if (betaMessage.stop_reason !== null) {
      span.setAttribute(GenAiAttr.RESPONSE_FINISH_REASONS, [
        betaMessage.stop_reason,
      ]);
    }
    span.setAttribute(
      GenAiAttr.USAGE_INPUT_TOKENS,
      betaMessage.usage.input_tokens
    );
    span.setAttribute(
      GenAiAttr.USAGE_OUTPUT_TOKENS,
      betaMessage.usage.output_tokens
    );

    // Subagent provenance, when this turn ran inside a subagent.
    if (message.subagent_type !== undefined) {
      span.setAttribute(GenAiAttr.AGENT_NAME, message.subagent_type);
    }
    if (
      isContentCaptureEnabled() &&
      message.task_description !== undefined
    ) {
      span.setAttribute(GenAiAttr.AGENT_DESCRIPTION, message.task_description);
    }
    if (isContentCaptureEnabled()) {
      span.setAttribute(
        GenAiAttr.OUTPUT_MESSAGES,
        JSON.stringify(betaMessage.content)
      );
    }

    if (message.error !== undefined) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.setAttribute(ErrorAttr.TYPE, message.error);
    } else {
      span.setStatus({ code: SpanStatusCode.OK });
    }
  }

  /** Ends every still-open tool and turn span (on result or premature stream end). */
  private closeAllOpen(): void {
    for (const toolSpan of this.openToolSpans.values()) {
      toolSpan.end();
    }
    this.openToolSpans.clear();
    this.toolSpanContexts.clear();
    for (const turnSpan of this.openTurns.values()) {
      turnSpan.end();
    }
    this.openTurns.clear();
  }
}

/**
 * Wraps a Claude Agent SDK `query()` result (or any async iterable of
 * `SDKMessage`s) so iterating it emits an OTel span hierarchy:
 * `invoke_agent` session -> `chat` turns -> `execute_tool` calls, with subagents
 * nested under their spawning `Task` tool span.
 *
 * Returns an async generator that yields the same messages unchanged. Spans are
 * closed when iteration completes, errors, or is abandoned early (the `finally`
 * runs on `return()` too). Note: this returns a plain generator, so control
 * methods on a `Query` object (e.g. `interrupt`) are not preserved — iterate the
 * wrapper, call control methods on the original `Query`.
 */
export async function* instrumentAgentQuery(
  messages: AsyncIterable<SDKMessage>
): AsyncGenerator<SDKMessage, void> {
  const builder = new AgentTraceBuilder();
  try {
    for await (const message of messages) {
      builder.observe(message);
      yield message;
    }
  } catch (error: unknown) {
    // A result message normally closes the session span; if the stream throws
    // first, mark the session errored before finalizing.
    builder.finalizeWithError(error);
    throw error;
  } finally {
    builder.finalize();
  }
}
