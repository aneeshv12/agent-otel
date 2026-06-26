/**
 * Demo tools. Each pairs an Anthropic `Tool` spec (what the model sees) with an
 * `execute` function (what actually runs, wrapped in `withToolSpan` by the agent
 * loop). Some tools succeed; some are deliberately pathological so their traces
 * show what failure looks like — an error-status span, or a non-converging loop.
 */
import type { Tool } from "@anthropic-ai/sdk/resources/messages/messages.js";

export interface DemoTool {
  spec: Tool;
  execute: (input: Record<string, unknown>) => Promise<unknown> | unknown;
}

/** A real-ish tool: returns deterministic fake weather so the happy path is stable. */
const getWeather: DemoTool = {
  spec: {
    name: "get_weather",
    description:
      "Get the current temperature in Celsius for a city. Returns a number.",
    input_schema: {
      type: "object",
      properties: {
        city: { type: "string", description: "City name, e.g. 'San Francisco'" },
      },
      required: ["city"],
    },
  },
  execute: (input) => {
    const city = String(input["city"] ?? "");
    // Deterministic pseudo-temperature derived from the city name length.
    const temperatureCelsius = 10 + (city.length % 15);
    return { city, temperature_celsius: temperatureCelsius };
  },
};

/** A real-ish tool: adds two numbers, so the happy path can chain tool calls. */
const addNumbers: DemoTool = {
  spec: {
    name: "add",
    description: "Add two numbers and return the sum.",
    input_schema: {
      type: "object",
      properties: {
        a: { type: "number" },
        b: { type: "number" },
      },
      required: ["a", "b"],
    },
  },
  execute: (input) => {
    const a = Number(input["a"] ?? 0);
    const b = Number(input["b"] ?? 0);
    return { sum: a + b };
  },
};

/**
 * Pathological tool #1: always throws. Drives the tool-error scenario — the
 * `execute_tool` span ends with ERROR status (red in Jaeger).
 */
const flakyDatabaseQuery: DemoTool = {
  spec: {
    name: "query_customer_database",
    description:
      "Look up a customer record by id in the customer database. Returns the record.",
    input_schema: {
      type: "object",
      properties: {
        customer_id: { type: "string" },
      },
      required: ["customer_id"],
    },
  },
  execute: (input) => {
    const customerId = String(input["customer_id"] ?? "");
    // Give the error a real name so it surfaces as a meaningful `error.type` on
    // the span (this is what `resolveErrorType` reads), rather than a bland "Error".
    const error = new Error(
      `connection refused while looking up customer ${customerId}`
    );
    error.name = "DatabaseConnectionError";
    throw error;
  },
};

/**
 * Pathological tool #2: never finds anything. Drives the runaway-loop scenario —
 * the model keeps trying new queries, producing many repeated `execute_tool`
 * spans (the stuck-agent shape) until the turn cap stops it.
 */
const searchArchive: DemoTool = {
  spec: {
    name: "search_archive",
    description:
      "Search the document archive for a query string. Returns matching documents.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
    },
  },
  execute: (input) => {
    const query = String(input["query"] ?? "");
    return {
      results: [],
      message: `No results found for "${query}". Try a different search query.`,
    };
  },
};

export const DEMO_TOOLS = {
  getWeather,
  addNumbers,
  flakyDatabaseQuery,
  searchArchive,
} as const;
