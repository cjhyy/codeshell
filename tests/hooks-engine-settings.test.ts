import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../packages/core/src/engine/engine.js";

function writeSettings(cwd: string, settings: object): void {
  writeFileSync(join(cwd, ".code-shell", "settings.json"), JSON.stringify(settings));
}

function makeProjectWithSettings(settings: object): string {
  const cwd = mkdtempSync(join(tmpdir(), "engine-settings-hooks-"));
  mkdirSync(join(cwd, ".code-shell"), { recursive: true });
  writeFileSync(
    join(cwd, ".code-shell", "settings.json"),
    JSON.stringify(settings),
  );
  return cwd;
}

describe("Engine — settings.hooks → shell-runner wrappers", () => {
  let fakeHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    fakeHome = mkdtempSync(join(tmpdir(), "engine-settings-hooks-home-"));
    process.env.HOME = fakeHome;
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
  });

  it("registers one wrapper handler per settings entry", () => {
    const cwd = makeProjectWithSettings({
      hooks: [
        { event: "pre_tool_use", command: "echo a" },
        { event: "post_tool_use", command: "echo b" },
        { event: "on_session_start", command: "echo c" },
      ],
    });
    try {
      const engine = new Engine({
        llm: { provider: "openai", model: "test", apiKey: "test" },
        cwd,
        sessionStorageDir: join(cwd, ".code-shell", "sessions"),
      });
      const reg = engine.getHookRegistry();
      expect(reg.countHandlers("pre_tool_use")).toBe(1);
      expect(reg.countHandlers("post_tool_use")).toBe(1);
      expect(reg.countHandlers("on_session_start")).toBe(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("sub-agent Engine skips settings.hooks registration entirely", () => {
    const cwd = makeProjectWithSettings({
      hooks: [{ event: "pre_tool_use", command: "echo skipped" }],
    });
    try {
      const engine = new Engine({
        llm: { provider: "openai", model: "test", apiKey: "test" },
        cwd,
        sessionStorageDir: join(cwd, ".code-shell", "sessions"),
        isSubAgent: true,
      });
      expect(engine.getHookRegistry().countHandlers("pre_tool_use")).toBe(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("reloadHooks swaps settings hooks: old gone, new present, no duplicates", () => {
    const cwd = makeProjectWithSettings({
      hooks: [{ event: "pre_tool_use", command: "echo X" }],
    });
    try {
      const engine = new Engine({
        llm: { provider: "openai", model: "test", apiKey: "test" },
        cwd,
        sessionStorageDir: join(cwd, ".code-shell", "sessions"),
      });
      const reg = engine.getHookRegistry();
      expect(reg.countHandlers("pre_tool_use")).toBe(1);
      expect(reg.countHandlers("post_tool_use")).toBe(0);
      const before = reg.listHooks().get("pre_tool_use") ?? [];
      expect(before.some((n) => n.includes("echo X"))).toBe(true);

      // Change settings on disk: drop X (pre_tool_use), add Y (post_tool_use).
      writeSettings(cwd, { hooks: [{ event: "post_tool_use", command: "echo Y" }] });
      engine.reloadHooks();

      // Old settings hook X removed; new settings hook Y registered exactly once.
      expect(reg.countHandlers("pre_tool_use")).toBe(0);
      expect(reg.countHandlers("post_tool_use")).toBe(1);
      const after = reg.listHooks().get("post_tool_use") ?? [];
      expect(after.some((n) => n.includes("echo Y"))).toBe(true);

      // Reloading again with the SAME settings must not accumulate duplicates.
      engine.reloadHooks();
      expect(reg.countHandlers("post_tool_use")).toBe(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("reloadHooks does not touch built-in (non-settings) hooks", () => {
    const cwd = makeProjectWithSettings({
      hooks: [{ event: "on_session_start", command: "echo c" }],
    });
    try {
      const engine = new Engine({
        llm: { provider: "openai", model: "test", apiKey: "test" },
        cwd,
        sessionStorageDir: join(cwd, ".code-shell", "sessions"),
        hooks: [
          {
            event: "on_session_start",
            handler: async () => ({}),
            name: "config:on_session_start",
          },
        ],
      });
      const reg = engine.getHookRegistry();
      // 1 config hook + 1 settings shell wrapper.
      expect(reg.countHandlers("on_session_start")).toBe(2);
      // Remove the settings hook entirely.
      writeSettings(cwd, {});
      engine.reloadHooks();
      // Settings wrapper gone; non-settings config hook survives.
      expect(reg.countHandlers("on_session_start")).toBe(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("no settings.hooks → no extra registrations beyond built-ins", () => {
    const cwd = makeProjectWithSettings({});
    try {
      const engine = new Engine({
        llm: { provider: "openai", model: "test", apiKey: "test" },
        cwd,
        sessionStorageDir: join(cwd, ".code-shell", "sessions"),
      });
      expect(engine.getHookRegistry().countHandlers("pre_tool_use")).toBe(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
