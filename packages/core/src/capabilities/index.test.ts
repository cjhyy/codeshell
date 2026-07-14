import { describe, expect, test } from "bun:test";
import type { AgentPreset } from "../preset/index.js";
import type { BuiltinTool } from "../tool-system/builtin/index.js";
import {
  composeCapabilityEngineHooks,
  composePromptSections,
  composeToolCatalog,
  resolveCapabilities,
  type CapabilityModule,
} from "./index.js";
import { HookRegistry } from "../hooks/registry.js";

const tool: BuiltinTool = {
  definition: {
    name: "ExampleCapabilityTool",
    description: "Example",
    inputSchema: { type: "object", properties: {} },
    source: "builtin",
    permissionDefault: "allow",
    isReadOnly: true,
  },
  exposure: { presetTags: ["example"] },
  execute: async () => "ok",
};

const preset: AgentPreset = {
  name: "example",
  label: "Example",
  description: "Example capability preset",
  promptSections: ["example"],
  builtinTools: [tool.definition.name],
  defaultPermissionRules: [],
};

const capability: CapabilityModule = {
  id: "example",
  tools: [tool],
  presets: [preset],
  promptSections: { example: "Example prompt" },
};

describe("capability composition", () => {
  test("keeps per-engine modules explicit and composes their contributions", () => {
    const resolved = resolveCapabilities([capability]);
    expect(composeToolCatalog([], resolved)).toEqual([tool]);
    expect(composePromptSections(resolved)).toEqual({ example: "Example prompt" });
  });

  test("rejects ambiguous tool ownership", () => {
    expect(() => composeToolCatalog([tool], [capability])).toThrow(
      "Tool 'ExampleCapabilityTool' is contributed more than once",
    );
  });

  test("contributes trusted code hooks to the normal engine hook chain", async () => {
    const seen: string[] = [];
    const withHooks: CapabilityModule = {
      id: "lifecycle",
      engineHooks: [
        {
          event: "on_session_start",
          name: "warm-panel-controller",
          handler: ({ eventName }) => {
            seen.push(eventName);
            return { messages: ["controller ready"] };
          },
        },
      ],
    };
    const registry = new HookRegistry();
    for (const hook of composeCapabilityEngineHooks([withHooks])) {
      registry.register(hook.event, hook.handler, hook.priority, hook.name);
    }

    expect(registry.listHooks().get("on_session_start")).toEqual([
      "capability:lifecycle:warm-panel-controller",
    ]);
    expect(await registry.emit("on_session_start")).toEqual({ messages: ["controller ready"] });
    expect(seen).toEqual(["on_session_start"]);
  });
});
