import { describe, it, expect } from "bun:test";
import { PromptComposer } from "./composer.js";
import type { ToolDefinition } from "../types.js";

/**
 * B1: tool definitions were sent twice — once as a full JSON-schema dump in
 * the system prompt ("Parameters: {...}") and again in the provider's native
 * `tools` field. The schema dump is redundant (the model gets structured
 * tools natively) and inflates every request. The system-prompt section now
 * lists name + one-line description only; the schema lives in the tools field.
 */
const tools: ToolDefinition[] = [
  {
    name: "Read",
    description: "Read a file from disk",
    inputSchema: {
      type: "object",
      properties: { file_path: { type: "string", description: "absolute path" } },
      required: ["file_path"],
    },
  },
];

describe("PromptComposer tool listing", () => {
  it("lists the tool name and description but NOT the JSON schema", async () => {
    const composer = new PromptComposer({ cwd: process.cwd(), model: "test-model" });
    const prompt = await composer.buildSystemPrompt(tools);

    expect(prompt).toContain("Read");
    expect(prompt).toContain("Read a file from disk");
    // No schema dump — that would duplicate the native tools field.
    expect(prompt).not.toContain("Parameters:");
    expect(prompt).not.toContain("file_path");
  });
});
