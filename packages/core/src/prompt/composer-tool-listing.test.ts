import { describe, it, expect } from "bun:test";
import { PromptComposer } from "./composer.js";
import type { ToolDefinition } from "../types.js";
import { BUILTIN_AGENT_PRESETS } from "../preset/index.js";

/**
 * Full descriptions and schemas belong in the provider's native tools field.
 * The system prompt retains names so discovery does not depend on duplicating
 * long tool manuals. Visibility must stay aligned with tool-gated instructions.
 */
const tools: ToolDefinition[] = [
  {
    name: "Read",
    description: "Read a file from disk\nA long tool manual belongs only in native tools.",
    inputSchema: {
      type: "object",
      properties: { file_path: { type: "string", description: "absolute path" } },
      required: ["file_path"],
    },
  },
];

describe("PromptComposer tool listing", () => {
  it("keeps tool names without duplicating descriptions or schemas", async () => {
    const composer = new PromptComposer({ cwd: process.cwd(), model: "test-model" });
    const originalDefinitions = structuredClone(tools);
    const prompt = await composer.buildSystemPrompt(tools);

    expect(prompt).toContain(
      "# Available Tools\n\nDescriptions and input schemas are provided in the tools field.\nRead",
    );
    expect(prompt).not.toContain(tools[0]!.description);
    expect(prompt).not.toContain("Read a file from disk");
    expect(prompt).not.toContain("Parameters:");
    expect(prompt).not.toContain("file_path");
    // The provider still receives the original, complete definitions.
    expect(tools).toEqual(originalDefinitions);
  });

  it("updates the name index and browser instructions when visible tools change", async () => {
    const composer = new PromptComposer({
      cwd: process.cwd(),
      model: "test-model",
      preset: BUILTIN_AGENT_PRESETS.general,
    });
    const browserTool: ToolDefinition = {
      name: "browser_navigate",
      description: "Open the browser target",
      inputSchema: { type: "object", properties: {} },
    };

    const enabled = await composer.buildSystemPrompt([...tools, browserTool]);
    expect(enabled).toContain("\nRead, browser_navigate");
    expect(enabled).toContain("## Browser automation");

    const disabled = await composer.buildSystemPrompt(tools);
    expect(disabled).not.toContain("browser_navigate");
    expect(disabled).not.toContain("## Browser automation");
    expect(disabled).toContain("Working style");

    const enabledAgain = await composer.buildSystemPrompt([browserTool]);
    expect(enabledAgain).toContain("tools field.\nbrowser_navigate");
    expect(enabledAgain).not.toContain("tools field.\nRead");
    expect(enabledAgain).toContain("## Browser automation");
  });

  it("omits the name index when no tools are visible", async () => {
    const composer = new PromptComposer({
      cwd: process.cwd(),
      model: "test-model",
      preset: BUILTIN_AGENT_PRESETS.general,
    });
    await composer.buildSystemPrompt(tools);
    const prompt = await composer.buildSystemPrompt([]);

    expect(prompt).not.toContain("# Available Tools");
    expect(prompt).not.toContain("## Browser automation");
  });
});
