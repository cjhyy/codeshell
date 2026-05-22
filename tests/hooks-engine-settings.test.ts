import { describe, it, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../packages/core/src/engine/engine.js";

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
      // on_session_start gets +1 from the built-in superpowers handler;
      // shell-runner wrapper raises it to 2.
      expect(reg.countHandlers("on_session_start")).toBe(2);
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
