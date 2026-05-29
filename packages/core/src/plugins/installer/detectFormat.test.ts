import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectPluginFormat } from "./detectFormat.js";

describe("detectPluginFormat", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cs-fmt-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns codex when .codex-plugin/plugin.json exists", () => {
    mkdirSync(join(dir, ".codex-plugin"), { recursive: true });
    writeFileSync(join(dir, ".codex-plugin", "plugin.json"), "{}");
    expect(detectPluginFormat(dir)).toBe("codex");
  });

  test("returns cc otherwise", () => {
    mkdirSync(join(dir, "skills"), { recursive: true });
    expect(detectPluginFormat(dir)).toBe("cc");
  });
});
