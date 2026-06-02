/**
 * Regression coverage for search-provider config resolution.
 *
 * Bug: automation (and any non-cwd-rooted caller) reported "No search provider
 * configured" even though the user had a serper key in ~/.code-shell/settings.json.
 * Two causes, both fixed here:
 *   1. webSearchTool called resolveSearchConfig() with no cwd → process.cwd()
 *      (the Electron main dir for automation), so the wrong settings root.
 *   2. resolveSearchConfig built SettingsManager(cwd) with the DEFAULT scope
 *      ("project"), which only reads ${cwd}/.code-shell — never the USER-level
 *      ~/.code-shell/settings.json where the key actually lives.
 *
 * We pin $HOME to a temp dir so the user-level settings read is deterministic.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { resolveSearchConfig } from "./web-search.js";

describe("resolveSearchConfig — reads user-level (~/.code-shell) search key", () => {
  let home: string;
  let prevHome: string | undefined;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "ws-home-"));
    fs.mkdirSync(path.join(home, ".code-shell"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".code-shell", "settings.json"),
      JSON.stringify({ search: { provider: "serper", apiKey: "test-key-123" } }),
    );
    prevHome = process.env.HOME;
    process.env.HOME = home;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  test("resolves the serper key from user settings even with a cwd that has no project settings", () => {
    const emptyCwd = fs.mkdtempSync(path.join(os.tmpdir(), "ws-cwd-"));
    const cfg = resolveSearchConfig(emptyCwd);
    expect(cfg.provider).toBe("serper");
    expect(cfg.apiKey).toBe("test-key-123");
    expect(cfg.source).toBe("settings");
    fs.rmSync(emptyCwd, { recursive: true, force: true });
  });
});
