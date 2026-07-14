import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noRepoDir } from "../../settings/manager.js";
import type { ValidatedSettings } from "../../settings/schema.js";

const previousAgentCwd = process.env.AGENT_CWD;
const previousHome = process.env.HOME;
const fixtureCwd = mkdtempSync(join(tmpdir(), "agent-server-stdio-cwd-"));
const fixtureHome = mkdtempSync(join(tmpdir(), "agent-server-stdio-home-"));

mkdirSync(join(fixtureCwd, ".code-shell"), { recursive: true });
writeFileSync(
  join(fixtureCwd, ".code-shell", "settings.json"),
  JSON.stringify({
    credentials: [
      {
        id: "ds-key",
        catalogId: "deepseek",
        apiKey: "sk-test",
        baseUrl: "https://api.deepseek.com/v1",
      },
    ],
    modelConnections: [
      {
        id: "ds",
        catalogId: "deepseek",
        tag: "text",
        model: "deepseek-v4-flash",
        credentialId: "ds-key",
      },
    ],
    defaults: { text: "ds" },
  }),
);

process.env.AGENT_CWD = fixtureCwd;
process.env.HOME = fixtureHome;

const { resolveSessionAgentConfig, resolveSessionCwd } = await import("../agent-server-stdio.js");

afterAll(() => {
  if (previousAgentCwd === undefined) delete process.env.AGENT_CWD;
  else process.env.AGENT_CWD = previousAgentCwd;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  rmSync(fixtureCwd, { recursive: true, force: true });
  rmSync(fixtureHome, { recursive: true, force: true });
});

const baseSettings = {
  agent: {
    preset: "general",
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
    expect(out.preset).toBe("general");
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
