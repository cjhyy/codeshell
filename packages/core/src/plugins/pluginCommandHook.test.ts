import { describe, test, expect, spyOn } from "bun:test";
import { runPluginCommandHook } from "./pluginCommandHook.js";
import type { HookContext } from "../hooks/events.js";

// TODO §3.3 — verify a plugin SessionStart hook's additionalContext actually
// becomes HookResult.messages. The engine then splices these into a
// <system-reminder> right before the user prompt (engine.ts on_session_start
// path), so this conversion is the linchpin of "does the plugin's startup
// context reach the model". We exercise all three accepted stdout shapes.

const ctx: HookContext = {
  eventName: "on_session_start",
  data: { source: "startup" },
} as unknown as HookContext;

// A command that prints fixed JSON. Single-quoted so the shell passes it
// through verbatim; the JSON itself uses double quotes.
function echoJson(json: string): string {
  // printf avoids trailing-newline quirks across shells; %s leaves JSON intact.
  return `printf '%s' '${json}'`;
}

describe("runPluginCommandHook → additionalContext becomes messages", () => {
  test("CC nested shape: hookSpecificOutput.additionalContext", async () => {
    const out = await runPluginCommandHook(
      {
        command: echoJson(
          '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"CC-CONTEXT"}}',
        ),
        installPath: process.cwd(),
        pluginKey: "test@local",
      },
      ctx,
    );
    expect(out.messages).toEqual(["CC-CONTEXT"]);
  });

  test("SDK top-level shape: additionalContext", async () => {
    const out = await runPluginCommandHook(
      {
        command: echoJson('{"additionalContext":"SDK-CONTEXT"}'),
        installPath: process.cwd(),
        pluginKey: "test@local",
      },
      ctx,
    );
    expect(out.messages).toEqual(["SDK-CONTEXT"]);
  });

  test("Cursor snake_case shape: additional_context", async () => {
    const out = await runPluginCommandHook(
      {
        command: echoJson('{"additional_context":"CURSOR-CONTEXT"}'),
        installPath: process.cwd(),
        pluginKey: "test@local",
      },
      ctx,
    );
    expect(out.messages).toEqual(["CURSOR-CONTEXT"]);
  });

  test("side-effect-only hook (no context) → empty result", async () => {
    const out = await runPluginCommandHook(
      {
        command: echoJson('{"someOtherField":true}'),
        installPath: process.cwd(),
        pluginKey: "test@local",
      },
      ctx,
    );
    expect(out.messages).toBeUndefined();
  });

  test("non-zero exit → empty result (a broken plugin can't wedge the engine)", async () => {
    const out = await runPluginCommandHook(
      { command: "exit 3", installPath: process.cwd(), pluginKey: "test@local" },
      ctx,
    );
    expect(out).toEqual({});
  });

  test("exit 2 → native-compatible deny with stderr message", async () => {
    const out = await runPluginCommandHook(
      {
        command: "printf '%s' 'blocked by plugin policy' >&2; exit 2",
        installPath: process.cwd(),
        pluginKey: "test@local",
      },
      { eventName: "pre_tool_use", data: { toolName: "Bash" } },
    );

    expect(out).toEqual({ decision: "deny", messages: ["blocked by plugin policy"] });
  });

  test("exit 1 stays normalized but logs a warning", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const out = await runPluginCommandHook(
        {
          command: "printf '%s' 'plugin crashed' >&2; exit 1",
          installPath: process.cwd(),
          pluginKey: "test@local",
        },
        { eventName: "pre_tool_use", data: { toolName: "Bash" } },
      );

      expect(out).toEqual({});
      expect(warn).toHaveBeenCalled();
      expect(warn.mock.calls.flat().join(" ")).toContain("exited 1");
    } finally {
      warn.mockRestore();
    }
  });

  test("explicit deny JSON is propagated even when the plugin exits non-zero", async () => {
    const out = await runPluginCommandHook(
      {
        command: 'printf \'%s\' \'{"decision":"deny","reason":"unsafe args"}\'; exit 1',
        installPath: process.cwd(),
        pluginKey: "test@local",
      },
      { eventName: "pre_tool_use", data: { toolName: "Bash" } },
    );

    expect(out).toEqual({ decision: "deny", messages: ["unsafe args"] });
  });

  test("non-JSON stdout → empty result", async () => {
    const out = await runPluginCommandHook(
      { command: echoJson("not json at all"), installPath: process.cwd(), pluginKey: "test@local" },
      ctx,
    );
    expect(out).toEqual({});
  });
});
