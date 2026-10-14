import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "@cjhyy/code-shell-core";
import {
  listCapabilities,
  setCapabilityEnabled,
  setCapabilityOverride,
} from "./capabilities-service";

describe("desktop capability service", () => {
  let cwd: string;
  const userSettingsPath = join(process.env.HOME!, ".code-shell", "settings.json");
  let previousUserSettings: Buffer | undefined;

  beforeEach(() => {
    previousUserSettings = existsSync(userSettingsPath)
      ? readFileSync(userSettingsPath)
      : undefined;
    cwd = mkdtempSync(join(tmpdir(), "cs-desktop-cap-cwd-"));
    mkdirSync(join(cwd, ".code-shell"), { recursive: true });
    writeFileSync(
      join(cwd, ".code-shell", "settings.json"),
      JSON.stringify({
        agent: {
          preset: "terminal-coding",
          enabledBuiltinTools: [],
          disabledBuiltinTools: [],
        },
      }),
    );
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    if (previousUserSettings) writeFileSync(userSettingsPath, previousUserSettings);
    else rmSync(userSettingsPath, { force: true });
  });

  test("global overview lists builtin and user capabilities without a project directory", () => {
    new SettingsManager("", "full").saveUserSetting("mcpServers", {
      "overview-fixture": { command: "node", args: [], enabled: true },
    });

    const caps = listCapabilities("");
    expect(caps.some((capability) => capability.id === "builtin:SwitchSessionWorkspace")).toBe(
      true,
    );
    expect(caps.find((capability) => capability.id === "mcp:overview-fixture")?.enabled).toBe(true);

    setCapabilityEnabled("", "mcp:overview-fixture", false, { scope: "user" });
    expect(
      listCapabilities("").find((capability) => capability.id === "mcp:overview-fixture")?.enabled,
    ).toBe(false);

    setCapabilityOverride(cwd, "mcp:overview-fixture", "on");
    const projectCap = listCapabilities(cwd).find(
      (capability) => capability.id === "mcp:overview-fixture",
    );
    expect(projectCap?.enabled).toBe(true);
    expect(projectCap?.globalEnabled).toBe(false);
    expect(projectCap?.projectOverride).toBe("on");
    expect(
      listCapabilities("").find((capability) => capability.id === "mcp:overview-fixture")?.enabled,
    ).toBe(false);
  });

  test("desktop builtin surface shows SwitchSessionWorkspace and hides legacy worktree tools", () => {
    const ids = new Set(listCapabilities(cwd).map((capability) => capability.id));

    expect(ids.has("builtin:SwitchSessionWorkspace")).toBe(true);
    expect(ids.has("builtin:EnterWorktree")).toBe(false);
    expect(ids.has("builtin:ExitWorktree")).toBe(false);
  });
});
