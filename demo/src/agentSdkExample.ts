/**
 * Claude Agent SDK example for agent-otel.
 *
 *   node dist/agentSdkExample.js
 *
 * Runs a real `query()` that delegates a subtask to a defined subagent, wrapped
 * in `instrumentAgentQuery`. The resulting Jaeger trace is an `invoke_agent`
 * session with `chat` turns and `execute_tool` calls, and the subagent's turns
 * nested under the `Task` tool span that spawned them.
 *
 * Requires the Claude Agent SDK runtime (it spawns the bundled Claude Code CLI)
 * and ANTHROPIC_API_KEY. Whether the model actually delegates is model-driven;
 * the prompt and `allowedTools: ["Task"]` push it to, but you may need to tune
 * the prompt if a run produces no subagent turn.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { instrumentAgentQuery } from "agent-otel";
import { initTracing } from "./tracing.js";

const JAEGER_UI_URL = "http://localhost:16686";
const MODEL = process.env["ANTHROPIC_MODEL"] ?? "claude-haiku-4-5-20251001";

async function main(): Promise<void> {
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

  console.log(
    "\nRunning Agent SDK example: main agent delegates to a 'researcher' subagent.\n"
  );

  const conversation = query({
    prompt:
      "Use the researcher subagent to gather three facts about OpenTelemetry, then summarize them for me in two sentences.",
    options: {
      model: MODEL,
      // Forward the subagent's full conversation (as messages with
      // parent_tool_use_id set) so its turns appear in the stream and nest under
      // the spawning tool span. Without this the SDK only emits the subagent's
      // tool_use/tool_result heartbeat, so nothing nests.
      forwardSubagentText: true,
      // Push the main agent to delegate rather than answer directly. The
      // subagent-spawning tool is named "Agent" in this SDK version (some docs
      // still call it "Task"); allow both so delegation isn't blocked.
      allowedTools: ["Agent", "Task"],
      agents: {
        researcher: {
          description:
            "Researches a topic and returns a few concise factual bullet points. Use for any research subtask.",
          prompt:
            "You are a focused researcher. Given a topic, reply with exactly three concise factual bullet points and nothing else.",
        },
      },
      maxTurns: 8,
    },
  });

  for await (const message of instrumentAgentQuery(conversation)) {
    if (message.type === "assistant" && message.parent_tool_use_id !== null) {
      console.log(`  [subagent ${message.subagent_type ?? "?"}] turn`);
    } else if (message.type === "result") {
      console.log(
        `\nResult: ${message.subtype} (${message.num_turns} turns, $${message.total_cost_usd.toFixed(4)})`
      );
    }
  }

  await tracing.shutdown();
  console.log(
    `\nDone. Open Jaeger at ${JAEGER_UI_URL}, select "agent-otel-demo", and open the invoke_agent trace.\n`
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
