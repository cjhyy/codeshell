/**
 * Task 1 (identity dimension foundations): SettingsManager must honor an
 * explicitly injected user-config dir — the seam a per-identity server
 * deployment uses instead of relocating $HOME. Default behavior (no override)
 * stays on `join(userHome(), ".code-shell")` and is covered by manager.test.ts.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "./manager.js";

describe("SettingsManager — injected user config dir", () => {
  let userDir: string;
  let projectDir: string;

  beforeEach(() => {
    userDir = mkdtempSync(join(tmpdir(), "csh-settings-user-"));
    projectDir = mkdtempSync(join(tmpdir(), "csh-settings-proj-"));
  });
  afterEach(() => {
    rmSync(userDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  test("load() reads the user layer from the injected dir", () => {
    writeFileSync(
      join(userDir, "settings.json"),
      JSON.stringify({ agent: { appendSystemPrompt: "from-custom-root" } }),
      "utf-8",
    );
    const manager = new SettingsManager(projectDir, "full", true, userDir);
    const settings = manager.load();
    expect(settings.agent.appendSystemPrompt).toBe("from-custom-root");
  });

  test("project layer still wins over the injected user layer", () => {
    writeFileSync(
      join(userDir, "settings.json"),
      JSON.stringify({ agent: { appendSystemPrompt: "user-layer" } }),
      "utf-8",
    );
    mkdirSync(join(projectDir, ".code-shell"), { recursive: true });
    writeFileSync(
      join(projectDir, ".code-shell", "settings.json"),
      JSON.stringify({ agent: { appendSystemPrompt: "project-layer" } }),
      "utf-8",
    );
    const manager = new SettingsManager(projectDir, "full", true, userDir);
    expect(manager.load().agent.appendSystemPrompt).toBe("project-layer");
  });

  test("saveUserSetting() writes into the injected dir, not $HOME", () => {
    const manager = new SettingsManager(projectDir, "full", true, userDir);
    manager.saveUserSetting("agent.appendSystemPrompt", "persisted-custom");
    const file = join(userDir, "settings.json");
    expect(existsSync(file)).toBe(true);
    const raw = JSON.parse(readFileSync(file, "utf-8")) as {
      agent?: { appendSystemPrompt?: string };
    };
    expect(raw.agent?.appendSystemPrompt).toBe("persisted-custom");
    // Round-trip through getForScope("user") reads the same injected dir.
    expect(manager.getForScope("user").agent?.appendSystemPrompt).toBe("persisted-custom");
  });
});
