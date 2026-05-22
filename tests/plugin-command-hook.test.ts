import { describe, it, expect } from "bun:test";
import { runPluginCommandHook } from "../packages/core/src/plugins/pluginCommandHook.js";
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
  it("exposes CODESHELL_PLUGIN_ROOT and strips CLAUDE_PLUGIN_ROOT from inherited env", async () => {
    // Set CLAUDE_PLUGIN_ROOT in the parent — the runner must strip it
    // before spawning so plugin-side host-detection branches conclude
    // "not Claude Code".
    const saved = process.env.CLAUDE_PLUGIN_ROOT;
    process.env.CLAUDE_PLUGIN_ROOT = "/parent/leaked";
    try {
      const res = await runPluginCommandHook(
        {
          command: `printf '{"additionalContext":"plugin_root=%s claude=%s"}' "$CODESHELL_PLUGIN_ROOT" "$CLAUDE_PLUGIN_ROOT"`,
          installPath: "/expected/path",
          pluginKey: "test@m",
        },
        ctx(),
      );
      const msg = res.messages?.[0] ?? "";
      expect(msg).toContain("plugin_root=/expected/path");
      // CLAUDE_PLUGIN_ROOT should be empty inside the child, even though
      // the parent set it.
      expect(msg).toMatch(/claude=\s*$/);
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
      else process.env.CLAUDE_PLUGIN_ROOT = saved;
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
