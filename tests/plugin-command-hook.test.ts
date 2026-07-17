import { describe, it, expect } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolvePluginDataPath,
  runPluginCommandHook,
} from "../packages/core/src/plugins/pluginCommandHook.js";
import type { HookContext } from "../packages/core/src/hooks/events.js";

function ctx(eventName: HookContext["eventName"] = "on_session_start"): HookContext {
  return { eventName, data: { source: "startup" } };
}

describe("runPluginCommandHook — stdout parsing", () => {
  it("extracts hookSpecificOutput.additionalContext (Claude Code shape)", async () => {
    const json = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: "from-cc-shape",
      },
    });
    const res = await runPluginCommandHook(
      { command: `printf '%s' '${json}'`, installPath: "/tmp", pluginKey: "test@m" },
      ctx(),
    );
    expect(res.messages).toEqual(["from-cc-shape"]);
  });

  it("extracts top-level additionalContext (SDK shape)", async () => {
    const json = JSON.stringify({ additionalContext: "sdk-shape" });
    const res = await runPluginCommandHook(
      { command: `printf '%s' '${json}'`, installPath: "/tmp", pluginKey: "test@m" },
      ctx(),
    );
    expect(res.messages).toEqual(["sdk-shape"]);
  });

  it("extracts additional_context (snake_case / Cursor shape)", async () => {
    const json = JSON.stringify({ additional_context: "cursor-shape" });
    const res = await runPluginCommandHook(
      { command: `printf '%s' '${json}'`, installPath: "/tmp", pluginKey: "test@m" },
      ctx(),
    );
    expect(res.messages).toEqual(["cursor-shape"]);
  });

  it("empty stdout returns {} (no messages)", async () => {
    const res = await runPluginCommandHook(
      { command: "true", installPath: "/tmp", pluginKey: "test@m" },
      ctx(),
    );
    expect(res).toEqual({});
  });

  it("non-JSON stdout returns {} (does NOT throw)", async () => {
    const res = await runPluginCommandHook(
      { command: `echo not-json`, installPath: "/tmp", pluginKey: "test@m" },
      ctx(),
    );
    expect(res).toEqual({});
  });

  it("JSON without any *additionalContext field returns {}", async () => {
    const res = await runPluginCommandHook(
      { command: `echo '{"unrelated":"value"}'`, installPath: "/tmp", pluginKey: "test@m" },
      ctx(),
    );
    expect(res).toEqual({});
  });

  it("non-zero exit returns {} (does NOT throw)", async () => {
    const res = await runPluginCommandHook(
      { command: `sh -c 'echo err >&2; exit 7'`, installPath: "/tmp", pluginKey: "test@m" },
      ctx(),
    );
    expect(res).toEqual({});
  });

  it("times out and returns {} when command exceeds timeoutMs", async () => {
    const res = await runPluginCommandHook(
      { command: "sleep 5", installPath: "/tmp", pluginKey: "test@m", timeoutMs: 100 },
      ctx(),
    );
    expect(res).toEqual({});
  });
});

describe("runPluginCommandHook — env exposure", () => {
  it("exposes CodeShell/Codex root and data vars and strips Claude vars", async () => {
    const dataPath = mkdtempSync(join(tmpdir(), "codeshell-plugin-data-"));
    const savedRoot = process.env.CLAUDE_PLUGIN_ROOT;
    const savedData = process.env.CLAUDE_PLUGIN_DATA;
    process.env.CLAUDE_PLUGIN_ROOT = "/parent/leaked";
    process.env.CLAUDE_PLUGIN_DATA = "/parent/data-leaked";
    try {
      const res = await runPluginCommandHook(
        {
          command: `printf '{"additionalContext":"plugin_root=%s codex_root=%s plugin_data=%s codex_data=%s claude_root=%s claude_data=%s"}' "$CODESHELL_PLUGIN_ROOT" "$PLUGIN_ROOT" "$CODESHELL_PLUGIN_DATA" "$PLUGIN_DATA" "$CLAUDE_PLUGIN_ROOT" "$CLAUDE_PLUGIN_DATA"`,
          installPath: "/expected/path",
          pluginKey: "test@m",
          dataPath,
        },
        ctx(),
      );
      const msg = res.messages?.[0] ?? "";
      expect(msg).toContain("plugin_root=/expected/path");
      expect(msg).toContain("codex_root=/expected/path");
      expect(msg).toContain(`plugin_data=${dataPath}`);
      expect(msg).toContain(`codex_data=${dataPath}`);
      expect(msg).toMatch(/claude_root= claude_data=\s*$/);
      expect(existsSync(dataPath)).toBe(true);
    } finally {
      if (savedRoot === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
      else process.env.CLAUDE_PLUGIN_ROOT = savedRoot;
      if (savedData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
      else process.env.CLAUDE_PLUGIN_DATA = savedData;
      rmSync(dataPath, { recursive: true, force: true });
    }
  });

  it("derives a stable traversal-safe data directory from CODE_SHELL_HOME", () => {
    const saved = process.env.CODE_SHELL_HOME;
    process.env.CODE_SHELL_HOME = "/tmp/codeshell-home";
    try {
      const first = resolvePluginDataPath("../../same@marketplace");
      const second = resolvePluginDataPath("../../same@marketplace");
      expect(first).toBe(second);
      expect(first.startsWith("/tmp/codeshell-home/plugin-data/")).toBe(true);
      expect(first).not.toContain("..");
    } finally {
      if (saved === undefined) delete process.env.CODE_SHELL_HOME;
      else process.env.CODE_SHELL_HOME = saved;
    }
  });

  it("exposes CODESHELL_HOOK_EVENT matching ctx.eventName", async () => {
    const res = await runPluginCommandHook(
      {
        command: `printf '{"additionalContext":"evt=%s"}' "$CODESHELL_HOOK_EVENT"`,
        installPath: "/tmp",
        pluginKey: "test@m",
      },
      ctx("user_prompt_submit"),
    );
    expect(res.messages?.[0]).toBe("evt=user_prompt_submit");
  });
});
