import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../engine.js";

/**
 * Proves the project-scoped builtin override wiring end-to-end on the LIVE
 * registry: a project's `.code-shell/settings.json` containing
 * `capabilityOverrides.builtin.Read = "off"` makes the Engine construct its
 * toolRegistry WITHOUT the Read builtin, while an identical Engine over a cwd
 * with no override keeps it. Read is in the default ("general") preset's
 * builtinTools, so "off" is observable.
 *
 * The seam exercised: Engine ctor → readBuiltinOverride(cwd)
 * (settings.getForScope("project", cwd) reading <cwd>/.code-shell/settings.json,
 * unmerged) → effectiveBuiltinLists → resolveBuiltinToolNames → ToolRegistry.
 */
describe("builtin capability override removes tool from live registry", () => {
  let overrideDir: string;
  let plainDir: string;

  const baseConfig = {
    llm: { provider: "openai", model: "m", apiKey: "", baseUrl: "" },
  } as const;

  beforeEach(() => {
    overrideDir = mkdtempSync(join(tmpdir(), "cs-builtin-ov-"));
    plainDir = mkdtempSync(join(tmpdir(), "cs-builtin-plain-"));
    // getForScope("project", cwd) reads <cwd>/.code-shell/settings.json.
    mkdirSync(join(overrideDir, ".code-shell"), { recursive: true });
    writeFileSync(
      join(overrideDir, ".code-shell", "settings.json"),
      JSON.stringify({
        capabilityOverrides: { builtin: { Read: "off" } },
      }),
      "utf-8",
    );
  });

  afterEach(() => {
    rmSync(overrideDir, { recursive: true, force: true });
    rmSync(plainDir, { recursive: true, force: true });
  });

  it("drops a default-preset builtin (Read) when project override is 'off'", () => {
    const withOverride = new Engine({ ...baseConfig, cwd: overrideDir } as any);
    const control = new Engine({ ...baseConfig, cwd: plainDir } as any);

    const overriddenRegistry = withOverride.buildToolContext().toolRegistry;
    const controlRegistry = control.buildToolContext().toolRegistry;

    // Override wins: Read absent from the constructed registry.
    expect(overriddenRegistry.hasTool("Read")).toBe(false);
    // Control (same config, no override) keeps Read.
    expect(controlRegistry.hasTool("Read")).toBe(true);
    // Sanity: an unrelated default builtin survives the override.
    expect(overriddenRegistry.hasTool("Bash")).toBe(true);
  });
});
