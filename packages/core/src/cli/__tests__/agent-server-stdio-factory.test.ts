import { describe, it, expect } from "vitest";
import { resolveSessionAgentConfig } from "../agent-server-stdio.js";
import type { ValidatedSettings } from "../../settings/schema.js";

const baseSettings = {
  agent: {
    preset: "terminal-coding",
    enabledBuiltinTools: [],
    disabledBuiltinTools: [],
    customSystemPrompt: "CUSTOM_FROM_SETTINGS",
    appendSystemPrompt: "APPEND_FROM_SETTINGS",
  },
} as unknown as ValidatedSettings;

describe("resolveSessionAgentConfig", () => {
  it("falls back to settings.agent.* when slice fields are undefined", () => {
    const out = resolveSessionAgentConfig({ permissionMode: "default" } as any, baseSettings);
    expect(out.appendSystemPrompt).toBe("APPEND_FROM_SETTINGS");
    expect(out.customSystemPrompt).toBe("CUSTOM_FROM_SETTINGS");
    expect(out.preset).toBe("terminal-coding");
  });

  it("lets protocol slice override settings", () => {
    const out = resolveSessionAgentConfig(
      { appendSystemPrompt: "FROM_SLICE", preset: "general" } as any,
      baseSettings,
    );
    expect(out.appendSystemPrompt).toBe("FROM_SLICE");
    expect(out.preset).toBe("general");
  });
});
