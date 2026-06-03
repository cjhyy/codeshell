import { describe, it, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, diskDefaultsFrom } from "../packages/core/src/engine/engine.js";

function makeProject(settings: object): string {
  const cwd = mkdtempSync(join(tmpdir(), "engine-config-reload-"));
  mkdirSync(join(cwd, ".code-shell"), { recursive: true });
  writeFileSync(join(cwd, ".code-shell", "settings.json"), JSON.stringify(settings));
  return cwd;
}

function newEngine(cwd: string) {
  return new Engine({
    llm: { provider: "openai", model: "test", apiKey: "test" },
    cwd,
    sessionStorageDir: join(cwd, ".code-shell", "sessions"),
  });
}

describe("diskDefaultsFrom", () => {
  it("picks only disk-default fields, excludes request-override fields", () => {
    const settings: any = {
      agent: {
        preset: "coder",
        customSystemPrompt: "custom",
        appendSystemPrompt: "append",
        responseLanguage: "zh",
        userProfile: "profile",
        instructions: { compatClaude: true },
      },
      mcpServers: { foo: { command: "x" } },
      // request-override / unrelated fields that must NOT leak through:
      permissionMode: "bypassPermissions",
      goal: "do it",
      maxTurns: 99,
    };
    const patch = diskDefaultsFrom(settings);
    expect(patch.preset).toBe("coder");
    expect(patch.customSystemPrompt).toBe("custom");
    expect(patch.appendSystemPrompt).toBe("append");
    expect(patch.responseLanguage).toBe("zh");
    expect(patch.userProfile).toBe("profile");
    expect(patch.instructions).toEqual({ compatClaude: true });
    expect(patch.mcpServers).toEqual({ foo: { command: "x" } });
    expect((patch as any).permissionMode).toBeUndefined();
    expect((patch as any).goal).toBeUndefined();
    expect((patch as any).maxTurns).toBeUndefined();
    expect((patch as any).cwd).toBeUndefined();
  });
});

describe("Engine.refreshRuntimeConfig", () => {
  it("merges patch into this.config (visible via getConfig)", () => {
    const cwd = makeProject({});
    try {
      const engine = newEngine(cwd);
      engine.refreshRuntimeConfig({ appendSystemPrompt: "NEW APPEND", responseLanguage: "fr" }, 1);
      const cfg = engine.getConfig();
      expect(cfg.appendSystemPrompt).toBe("NEW APPEND");
      expect(cfg.responseLanguage).toBe("fr");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("ignores a stale (<= last applied) version, applies a newer one", () => {
    const cwd = makeProject({});
    try {
      const engine = newEngine(cwd);
      engine.refreshRuntimeConfig({ appendSystemPrompt: "v2" }, 2);
      expect(engine.getConfig().appendSystemPrompt).toBe("v2");
      // Stale version 1 must NOT overwrite.
      engine.refreshRuntimeConfig({ appendSystemPrompt: "v1-stale" }, 1);
      expect(engine.getConfig().appendSystemPrompt).toBe("v2");
      // Equal version is also a no-op.
      engine.refreshRuntimeConfig({ appendSystemPrompt: "v2-dup" }, 2);
      expect(engine.getConfig().appendSystemPrompt).toBe("v2");
      // Newer version applies.
      engine.refreshRuntimeConfig({ appendSystemPrompt: "v3" }, 3);
      expect(engine.getConfig().appendSystemPrompt).toBe("v3");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("connects newly-added MCP servers via the idempotent connectAll, never disconnects", async () => {
    const cwd = makeProject({});
    try {
      const engine = newEngine(cwd);
      const connected: Array<Record<string, unknown>> = [];
      let disconnectCalls = 0;
      // Inject a fake MCPManager so we can spy on connectAll without spawning.
      (engine as any).mcpManager = {
        connectAll: async (servers: Record<string, unknown>) => {
          connected.push(servers);
        },
        disconnectAll: async () => {
          disconnectCalls++;
        },
      };
      engine.refreshRuntimeConfig({ mcpServers: { foo: { command: "x" } as any } }, 1);
      // refreshRuntimeConfig schedules the connect asynchronously (void); give it a tick.
      await new Promise((r) => setTimeout(r, 5));
      expect(connected.length).toBe(1);
      expect(connected[0]).toEqual({ foo: { command: "x" } });
      expect(disconnectCalls).toBe(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
