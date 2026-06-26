/**
 * Selectable demo scenarios. One happy path plus three failure modes whose
 * traces are the point of the project: a tool that errors, a runaway loop, and a
 * truncated response. A bonus streaming scenario exercises the streaming span.
 *
 * Each scenario runs inside a per-run root span (created in index.ts), so every
 * model call and tool execution nests into a single Jaeger waterfall.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { runAgent } from "./agent.js";
import { DEMO_TOOLS } from "./tools.js";

/** Cheap model by default — the demo is about traces, not answer quality. */
const MODEL = process.env["ANTHROPIC_MODEL"] ?? "claude-haiku-4-5-20251001";

export interface Scenario {
  name: string;
  description: string;
  run: (client: Anthropic) => Promise<void>;
}

const happyPath: Scenario = {
  name: "happy",
  description:
    "Multi-turn tool loop that succeeds: fetch two temperatures, then add them.",
  run: async (client) => {
    const result = await runAgent({
      client,
      model: MODEL,
      system:
        "You are a concise assistant. Use the provided tools when needed, then give a one-sentence answer.",
      userPrompt:
        "What is the temperature in San Francisco and in Tokyo? Add the two temperatures together and tell me the total.",
      tools: [DEMO_TOOLS.getWeather, DEMO_TOOLS.addNumbers],
      maxTurns: 6,
      maxTokens: 512,
    });
    console.log(
      `Final answer: ${result.finalText}\nTurns: ${result.turns}, tool calls: ${result.toolCallCount}`
    );
  },
};

const toolError: Scenario = {
  name: "tool-error",
  description:
    "A tool throws (database connection refused). The execute_tool span ends with ERROR status.",
  run: async (client) => {
    const result = await runAgent({
      client,
      model: MODEL,
      system:
        "You are a support assistant. Use the database tool to answer, and if it fails, explain what went wrong.",
      userPrompt:
        "Look up customer with id 12345 in the customer database and tell me their account status.",
      tools: [DEMO_TOOLS.flakyDatabaseQuery],
      maxTurns: 4,
      maxTokens: 512,
    });
    console.log(
      `Final answer: ${result.finalText}\nTurns: ${result.turns}, tool calls: ${result.toolCallCount}`
    );
  },
};

const runawayLoop: Scenario = {
  name: "runaway",
  description:
    "A non-converging search tool. The model retries with new queries until the turn cap — the stuck-agent shape.",
  run: async (client) => {
    const result = await runAgent({
      client,
      model: MODEL,
      system:
        "You are a determined research assistant. Keep searching with different queries until you locate the document. Do not give up.",
      userPrompt:
        "Find the classified document codenamed 'Project Zephyr' in the archive and summarize it.",
      tools: [DEMO_TOOLS.searchArchive],
      maxTurns: 6,
      maxTokens: 512,
    });
    console.log(
      `Hit turn cap: ${result.hitTurnCap}\nTurns: ${result.turns}, tool calls: ${result.toolCallCount}`
    );
  },
};

const truncation: Scenario = {
  name: "truncation",
  description:
    "A long answer capped at 16 output tokens. The chat span records finish_reasons = ['max_tokens'].",
  run: async (client) => {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 16,
      messages: [
        {
          role: "user",
          content:
            "Write a detailed, multi-paragraph essay about the history and architecture of OpenTelemetry.",
        },
      ],
    });
    console.log(`stop_reason: ${response.stop_reason}`);
  },
};

const streaming: Scenario = {
  name: "streaming",
  description:
    "A streamed completion via messages.stream(). The chat span stays open until the stream ends.",
  run: async (client) => {
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 256,
      messages: [
        { role: "user", content: "In two sentences, what is distributed tracing?" },
      ],
    });
    const finalMessage = await stream.finalMessage();
    console.log(`stop_reason: ${finalMessage.stop_reason}`);
  },
};

export const SCENARIOS: Record<string, Scenario> = {
  [happyPath.name]: happyPath,
  [toolError.name]: toolError,
  [runawayLoop.name]: runawayLoop,
  [truncation.name]: truncation,
  [streaming.name]: streaming,
};
