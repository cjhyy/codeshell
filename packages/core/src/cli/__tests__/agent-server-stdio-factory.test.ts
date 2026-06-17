import { describe, it, expect } from "bun:test";
import { resolveSessionAgentConfig, resolveSessionCwd } from "../agent-server-stdio.js";
import { noRepoDir } from "../../settings/manager.js";
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

describe("resolveSessionCwd", () => {
  it("uses the slice cwd when the session is bound to a project", () => {
    expect(resolveSessionCwd({ cwd: "/Users/me/proj" } as any)).toBe("/Users/me/proj");
  });

  it("falls back to the no-repo sandbox (NOT the boot cwd) when slice has no cwd", () => {
    // Regression: a no-repo "纯聊天" send arrives with no cwd. Previously this
    // inherited the long-lived worker's boot cwd (whatever project spawned it),
    // silently running the chat against an unrelated repo AND defeating the
    // no-repo skill/plugin whitelist. It must resolve to noRepoDir().
    expect(resolveSessionCwd({ permissionMode: "default" } as any)).toBe(noRepoDir());
    expect(resolveSessionCwd({} as any)).toBe(noRepoDir());
  });
});
