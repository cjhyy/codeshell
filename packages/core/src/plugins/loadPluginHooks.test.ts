import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPluginHooks, listPluginHooks, pluginHookKey } from "./loadPluginHooks.js";
import { pluginHooksDigest } from "./pluginHookIntegrity.js";
import { HookRegistry } from "../hooks/registry.js";
import { Engine } from "../engine/engine.js";
import { LLMClientBase } from "../llm/client-base.js";
import { registerProvider } from "../llm/client-factory.js";
import type { CreateMessageOptions } from "../llm/types.js";
import type { LLMResponse, Message } from "../types.js";

/**
 * loadPluginHooks reads the real ~/.code-shell/plugins/installed_plugins.json
 * via process.env.HOME, so we redirect HOME at a temp dir and stage a plugin
 * with a SessionStart hook on disk. This locks the disabledPlugins skip — the
 * contract that disabling "superpowers" suppresses its hook injection, not
 * just its Skill-tool entries.
 */

const origHome = process.env.HOME;
const dirs: string[] = [];

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

function stagePlugin(
  pluginKey: string,
  sessionStartGroups: unknown[] = [{ hooks: [{ type: "command", command: "echo hi" }] }],
  hookDigest?: "current" | string,
  approvedHookDigest?: "current" | string,
): string {
  const home = mkdtempSync(join(tmpdir(), "plughome-"));
  dirs.push(home);
  process.env.HOME = home;

  const installPath = join(home, "plugin-install");
  mkdirSync(join(installPath, "hooks"), { recursive: true });
  writeFileSync(
    join(installPath, "hooks", "hooks.json"),
    JSON.stringify({
      hooks: {
        SessionStart: sessionStartGroups,
      },
    }),
  );

  const pluginsDir = join(home, ".code-shell", "plugins");
  mkdirSync(pluginsDir, { recursive: true });
  writeFileSync(
    join(pluginsDir, "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: {
        [pluginKey]: [
          {
            scope: "user",
            installPath,
            version: "1.0.0",
            installedAt: "2026-01-01",
            lastUpdated: "2026-01-01",
            ...(hookDigest
              ? {
                  hookDigest:
                    hookDigest === "current" ? pluginHooksDigest(installPath) : hookDigest,
                }
              : {}),
            ...(approvedHookDigest
              ? {
                  approvedHookDigest:
                    approvedHookDigest === "current"
                      ? pluginHooksDigest(installPath)
                      : approvedHookDigest,
                }
              : {}),
          },
        ],
      },
    }),
  );
  return installPath;
}

const fakeProvider = "fake-session-start-source";
const scenarios = new Map<string, { calls: Message[][] }>();

class FakeSessionStartClient extends LLMClientBase {
  protected initClient(): void {}

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    const scenario = scenarios.get(this.model);
    if (!scenario) throw new Error(`missing fake scenario: ${this.model}`);
    if ((options.tools?.length ?? 0) > 0) {
      scenario.calls.push(options.messages.map((message) => ({ ...message })));
    }
    this.recordUsage({ promptTokens: 1, completionTokens: 1, totalTokens: 2 }, options);
    return {
      text: "ok",
      toolCalls: [],
      stopReason: "stop",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
  }
}

registerProvider(fakeProvider, FakeSessionStartClient);

function messageText(messages: Message[]): string {
  return messages
    .map((message) =>
      typeof message.content === "string" ? message.content : JSON.stringify(message.content),
    )
    .join("\n");
}

describe("loadPluginHooks disabledPlugins filter", () => {
  test("registers a plugin's hooks when not disabled", () => {
    stagePlugin("superpowers@market");
    const reg = new HookRegistry();
    loadPluginHooks(reg);
    expect(reg.hasHooks("on_session_start")).toBe(true);
  });

  test("skips a plugin's hooks when its bare name is disabled", () => {
    stagePlugin("superpowers@market");
    const reg = new HookRegistry();
    loadPluginHooks(reg, ["superpowers"]);
    expect(reg.hasHooks("on_session_start")).toBe(false);
  });

  test("disabledPlugins matches the bare name, ignoring @marketplace", () => {
    stagePlugin("superpowers@some-other-marketplace");
    const reg = new HookRegistry();
    loadPluginHooks(reg, ["superpowers"]);
    expect(reg.hasHooks("on_session_start")).toBe(false);
  });

  test("an unrelated disabled name leaves the plugin's hooks intact", () => {
    stagePlugin("superpowers@market");
    const reg = new HookRegistry();
    loadPluginHooks(reg, ["something-else"]);
    expect(reg.hasHooks("on_session_start")).toBe(true);
  });
});

describe("loadPluginHooks disabledPluginHooks (per-hook) filter", () => {
  test("skips ONE hook by its pluginHookKey while the plugin stays enabled", () => {
    stagePlugin("superpowers@market");
    const reg = new HookRegistry();
    const key = pluginHookKey({
      plugin: "superpowers",
      rawEvent: "SessionStart",
      command: "echo hi",
    });
    loadPluginHooks(reg, [], [key]);
    expect(reg.hasHooks("on_session_start")).toBe(false);
  });

  test("a non-matching per-hook key leaves the hook registered", () => {
    stagePlugin("superpowers@market");
    const reg = new HookRegistry();
    loadPluginHooks(reg, [], ["superpowers:SessionStart:echo other"]);
    expect(reg.hasHooks("on_session_start")).toBe(true);
  });
});

describe("loadPluginHooks install-time integrity", () => {
  test("registers a hook whose digest was explicitly approved", () => {
    stagePlugin("verified@market", undefined, "current", "current");
    const reg = new HookRegistry();
    loadPluginHooks(reg);
    expect(reg.hasHooks("on_session_start")).toBe(true);
    expect(listPluginHooks()[0]?.integrity).toBe("verified");
    expect(listPluginHooks()[0]?.approval).toBe("approved");
  });

  test("fails closed while a new matching hook digest is pending approval", () => {
    stagePlugin("pending@market", undefined, "current");
    const reg = new HookRegistry();
    loadPluginHooks(reg);
    expect(reg.hasHooks("on_session_start")).toBe(false);
    expect(listPluginHooks()[0]?.integrity).toBe("verified");
    expect(listPluginHooks()[0]?.approval).toBe("pending");
  });

  test("fails closed when hooks.json changes after installation", () => {
    const installPath = stagePlugin("changed@market", undefined, "current");
    writeFileSync(
      join(installPath, "hooks", "hooks.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: "echo tampered" }] }],
        },
      }),
    );

    const reg = new HookRegistry();
    loadPluginHooks(reg);
    expect(reg.hasHooks("on_session_start")).toBe(false);
    expect(listPluginHooks()[0]?.integrity).toBe("changed");
    expect(listPluginHooks()[0]?.approval).toBe("changed");
  });

  test("keeps legacy installs compatible until the user explicitly revokes them", () => {
    stagePlugin("legacy@market");
    const reg = new HookRegistry();
    loadPluginHooks(reg);
    expect(reg.hasHooks("on_session_start")).toBe(true);
    expect(listPluginHooks()[0]?.approval).toBe("legacy");
  });

  test("ignores blank command declarations instead of prompting or registering", () => {
    stagePlugin("blank@market", [{ hooks: [{ type: "command", command: "   " }] }], "current");
    const reg = new HookRegistry();
    loadPluginHooks(reg);
    expect(reg.hasHooks("on_session_start")).toBe(false);
    expect(listPluginHooks()).toEqual([]);
  });

  test("fails closed for one invalid plugin without blocking other plugins", () => {
    stagePlugin("valid@market");
    const home = process.env.HOME!;
    const invalidInstallPath = join(home, "invalid-plugin-install");
    mkdirSync(join(invalidInstallPath, "hooks"), { recursive: true });
    writeFileSync(
      join(invalidInstallPath, "hooks", "hooks.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              matcher: "[",
              hooks: [{ type: "command", command: "echo must-not-run" }],
            },
          ],
        },
      }),
    );

    const installedPath = join(home, ".code-shell", "plugins", "installed_plugins.json");
    const installed = JSON.parse(readFileSync(installedPath, "utf-8"));
    installed.plugins = {
      "invalid@market": [
        {
          scope: "user",
          installPath: invalidInstallPath,
          version: "1.0.0",
          installedAt: "2026-01-01",
          lastUpdated: "2026-01-01",
        },
      ],
      ...installed.plugins,
    };
    writeFileSync(installedPath, JSON.stringify(installed));

    const reg = new HookRegistry();
    loadPluginHooks(reg);
    expect(reg.hasHooks("on_session_start")).toBe(true);
    expect(listPluginHooks().map((hook) => hook.plugin)).toEqual(["valid"]);
  });
});

describe("loadPluginHooks SessionStart matcher source", () => {
  test("matcher 'resume' fires on resume and not on startup", async () => {
    stagePlugin("superpowers@market", [
      {
        matcher: "resume",
        hooks: [
          {
            type: "command",
            command: `printf '%s' '{"additionalContext":"resume-hook-fired"}'`,
          },
        ],
      },
    ]);

    const dir = mkdtempSync(join(tmpdir(), "session-start-source-"));
    dirs.push(dir);
    const model = `${fakeProvider}-${Date.now()}-${Math.random()}`;
    const scenario = { calls: [] as Message[][] };
    scenarios.set(model, scenario);
    try {
      const engine = new Engine({
        llm: { provider: fakeProvider, model, apiKey: "test" } as never,
        cwd: dir,
        sessionStorageDir: join(dir, "sessions"),
        headless: true,
      });

      const first = await engine.run("startup turn", { cwd: dir });
      await engine.run("resume turn", { cwd: dir, sessionId: first.sessionId });

      expect(scenario.calls).toHaveLength(2);
      expect(messageText(scenario.calls[0]!)).not.toContain("resume-hook-fired");
      expect(messageText(scenario.calls[1]!)).toContain("resume-hook-fired");
    } finally {
      scenarios.delete(model);
    }
  });

  test("fresh session with caller-supplied id is startup, not resume", async () => {
    stagePlugin("superpowers@market", [
      {
        matcher: "resume",
        hooks: [
          {
            type: "command",
            command: `printf '%s' '{"additionalContext":"resume-hook-fired"}'`,
          },
        ],
      },
    ]);

    const dir = mkdtempSync(join(tmpdir(), "session-start-explicit-id-"));
    dirs.push(dir);
    const model = `${fakeProvider}-${Date.now()}-${Math.random()}`;
    const scenario = { calls: [] as Message[][] };
    scenarios.set(model, scenario);
    try {
      const engine = new Engine({
        llm: { provider: fakeProvider, model, apiKey: "test" } as never,
        cwd: dir,
        sessionStorageDir: join(dir, "sessions"),
        headless: true,
      });

      await engine.run("startup with explicit id", {
        cwd: dir,
        sessionId: "caller-fresh-id",
      });
      await engine.run("truly resumed", { cwd: dir, sessionId: "caller-fresh-id" });

      expect(scenario.calls).toHaveLength(2);
      expect(messageText(scenario.calls[0]!)).not.toContain("resume-hook-fired");
      expect(messageText(scenario.calls[1]!)).toContain("resume-hook-fired");
    } finally {
      scenarios.delete(model);
    }
  });
});

describe("listPluginHooks (read-only, for the settings UI)", () => {
  test("returns plugin hooks with owner name + mapped event + command", () => {
    stagePlugin("superpowers@market");
    const list = listPluginHooks();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      plugin: "superpowers",
      installKey: "superpowers@market",
      event: "on_session_start",
      rawEvent: "SessionStart",
      command: "echo hi",
      disabled: false,
      integrity: "legacy",
      approval: "legacy",
      key: "superpowers:SessionStart:echo hi",
    });
  });

  test("flags entries from a disabled plugin (still listed, disabled:true)", () => {
    stagePlugin("superpowers@market");
    const list = listPluginHooks(["superpowers"]);
    expect(list).toHaveLength(1); // still listed (read-only view)
    expect(list[0]!.disabled).toBe(true);
  });

  test("does not register anything (pure read)", () => {
    stagePlugin("superpowers@market");
    listPluginHooks();
    const reg = new HookRegistry();
    // A fresh registry that never had loadPluginHooks called stays empty.
    expect(reg.hasHooks("on_session_start")).toBe(false);
  });
});
