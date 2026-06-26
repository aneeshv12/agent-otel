/**
 * A minimal multi-turn tool loop against the real Anthropic API, using an
 * `agent-otel`-instrumented client plus `withToolSpan` for tool execution. The
 * loop itself is deliberately plain — the interesting output is the trace it
 * emits, not the agent logic.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type {
  Message,
  MessageParam,
  ContentBlock,
  ToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/messages/messages.js";
import { withToolSpan } from "agent-otel";
import type { DemoTool } from "./tools.js";

export interface AgentRunOptions {
  client: Anthropic;
  model: string;
  system: string;
  userPrompt: string;
  tools: DemoTool[];
  /** Stop after this many model turns; reaching it is the runaway-loop signal. */
  maxTurns: number;
  maxTokens: number;
}

export interface AgentRunResult {
  finalText: string | null;
  turns: number;
  hitTurnCap: boolean;
  toolCallCount: number;
}

function extractText(content: ContentBlock[]): string {
  return content
    .filter((block): block is Extract<ContentBlock, { type: "text" }> =>
      block.type === "text"
    )
    .map((block) => block.text)
    .join("\n");
}

export async function runAgent(options: AgentRunOptions): Promise<AgentRunResult> {
  const { client, model, system, userPrompt, tools, maxTurns, maxTokens } =
    options;

  const toolByName = new Map(tools.map((tool) => [tool.spec.name, tool]));
  const toolSpecs = tools.map((tool) => tool.spec);
  const messages: MessageParam[] = [{ role: "user", content: userPrompt }];
  let toolCallCount = 0;

  for (let turn = 1; turn <= maxTurns; turn++) {
    const response: Message = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system,
      tools: toolSpecs,
      messages,
    });

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      return {
        finalText: extractText(response.content),
        turns: turn,
        hitTurnCap: false,
        toolCallCount,
      };
    }

    const toolResults: ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") {
        continue;
      }
      toolCallCount++;

      const tool = toolByName.get(block.name);
      const input = (block.input ?? {}) as Record<string, unknown>;
      let resultContent: string;
      let isError = false;

      if (tool === undefined) {
        isError = true;
        resultContent = `Unknown tool: ${block.name}`;
      } else {
        try {
          // withToolSpan owns the execute_tool span; a throw here ends that
          // span with ERROR status and is reported back to the model as an
          // is_error tool_result so the loop can continue or recover.
          const output = await withToolSpan(block.name, input, () =>
            tool.execute(input)
          );
          resultContent =
            typeof output === "string" ? output : JSON.stringify(output);
        } catch (toolError: unknown) {
          isError = true;
          resultContent =
            toolError instanceof Error
              ? toolError.message
              : String(toolError);
        }
      }

      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: resultContent,
        is_error: isError,
      });
    }

    messages.push({ role: "user", content: toolResults });
  }

  return {
    finalText: null,
    turns: maxTurns,
    hitTurnCap: true,
    toolCallCount,
  };
}
