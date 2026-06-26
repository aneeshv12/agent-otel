/**
 * Vendored OpenTelemetry GenAI semantic-convention attribute names.
 *
 * These strings are the contract between this library and every OTel backend
 * (Jaeger, Grafana, Datadog, Honeycomb). They MUST NOT be recited from memory
 * or guessed: the GenAI conventions have churned repeatedly. They are copied
 * verbatim from the official source and pinned below.
 *
 * Pinned source:
 *   OpenTelemetry GenAI Semantic Conventions
 *   repo:   github.com/open-telemetry/semantic-conventions-genai (main)
 *   docs:   docs/gen-ai/gen-ai-spans.md, docs/gen-ai/gen-ai-agent-spans.md
 *   pulled: 2026-06-13
 *   status: "Development" stability for all attributes below. Client/chat spans
 *           exited experimental in early 2026; agent/tool spans remain in
 *           Development but have been stable in practice.
 *
 * When re-pinning, update PINNED_SEMCONV_DATE and re-verify every string here
 * against the source above. Attributes that have no official GenAI slot
 * (Anthropic cache tokens) use an `anthropic.` prefix and are grouped separately.
 */

/** The date the GenAI semantic conventions below were last verified against source. */
export const PINNED_SEMCONV_DATE = "2026-06-13";

/**
 * `gen_ai.operation.name` well-known values.
 * Source: gen-ai-spans.md (chat, execute_tool), gen-ai-agent-spans.md (invoke_agent, create_agent).
 */
export const GenAiOperationName = {
  CHAT: "chat",
  EXECUTE_TOOL: "execute_tool",
  INVOKE_AGENT: "invoke_agent",
  CREATE_AGENT: "create_agent",
} as const;

/** `gen_ai.provider.name` value for Anthropic (replaces the deprecated `gen_ai.system`). */
export const GEN_AI_PROVIDER_ANTHROPIC = "anthropic";

/**
 * GenAI span attribute keys, copied verbatim from the pinned source.
 * Grouped only for readability; all are flat OTel attribute keys.
 */
export const GenAiAttr = {
  // Operation / provider
  OPERATION_NAME: "gen_ai.operation.name",
  PROVIDER_NAME: "gen_ai.provider.name",

  // Request
  REQUEST_MODEL: "gen_ai.request.model",
  REQUEST_MAX_TOKENS: "gen_ai.request.max_tokens",
  REQUEST_TEMPERATURE: "gen_ai.request.temperature",
  REQUEST_TOP_P: "gen_ai.request.top_p",

  // Response
  RESPONSE_MODEL: "gen_ai.response.model",
  RESPONSE_ID: "gen_ai.response.id",
  RESPONSE_FINISH_REASONS: "gen_ai.response.finish_reasons",

  // Usage
  USAGE_INPUT_TOKENS: "gen_ai.usage.input_tokens",
  USAGE_OUTPUT_TOKENS: "gen_ai.usage.output_tokens",

  // Content capture (opt-in only; gated behind AGENT_OTEL_CAPTURE_CONTENT)
  INPUT_MESSAGES: "gen_ai.input.messages",
  OUTPUT_MESSAGES: "gen_ai.output.messages",
  SYSTEM_INSTRUCTIONS: "gen_ai.system_instructions",

  // Agent
  AGENT_NAME: "gen_ai.agent.name",
  AGENT_ID: "gen_ai.agent.id",
  AGENT_DESCRIPTION: "gen_ai.agent.description",
  CONVERSATION_ID: "gen_ai.conversation.id",

  // Tool execution
  TOOL_NAME: "gen_ai.tool.name",
  TOOL_CALL_ID: "gen_ai.tool.call.id",
  TOOL_TYPE: "gen_ai.tool.type",
  TOOL_DESCRIPTION: "gen_ai.tool.description",
  TOOL_CALL_ARGUMENTS: "gen_ai.tool.call.arguments",
  TOOL_CALL_RESULT: "gen_ai.tool.call.result",
} as const;

/**
 * General-purpose error attribute, used to mark a span that ended in an error.
 * Source: gen-ai-spans.md error handling ("the canonical name of exception that
 * occurred, or another low-cardinality error identifier"). Fallback value: `_OTHER`.
 */
export const ErrorAttr = {
  TYPE: "error.type",
} as const;

/** Fallback `error.type` value when no more specific identifier is available. */
export const ERROR_TYPE_OTHER = "_OTHER";

/**
 * Span event names defined by THIS library, not vendored from the GenAI
 * conventions. The GenAI spec models a tool *execution* as its own span
 * (`execute_tool {name}`), but has no event for the model merely *requesting*
 * a tool inside a chat response. We record that request as an event on the chat
 * span so the waterfall reads: chat (with tool_use request events) ->
 * execute_tool span -> next chat. The `tool_use` name mirrors the Anthropic
 * `tool_use` content-block type it is derived from.
 */
export const LibraryEventName = {
  TOOL_USE: "tool_use",
} as const;

/**
 * Anthropic-specific attributes with no official GenAI slot. The `anthropic.`
 * prefix marks these as provider extensions so they never collide with future
 * official `gen_ai.*` keys.
 */
export const AnthropicAttr = {
  /** Tokens read from the prompt cache (Anthropic `usage.cache_read_input_tokens`). */
  USAGE_CACHE_READ_INPUT_TOKENS: "anthropic.usage.cache_read_input_tokens",
  /** Tokens written to the prompt cache (Anthropic `usage.cache_creation_input_tokens`). */
  USAGE_CACHE_CREATION_INPUT_TOKENS: "anthropic.usage.cache_creation_input_tokens",
} as const;

/**
 * Builds the conventional span name for a chat operation: `"{operation} {model}"`.
 * Source: gen-ai-spans.md span name format.
 */
export function chatSpanName(model: string): string {
  return `${GenAiOperationName.CHAT} ${model}`;
}

/**
 * Builds the conventional span name for a tool execution: `"execute_tool {tool.name}"`.
 * Source: gen-ai-spans.md Execute Tool span.
 */
export function executeToolSpanName(toolName: string): string {
  return `${GenAiOperationName.EXECUTE_TOOL} ${toolName}`;
}
