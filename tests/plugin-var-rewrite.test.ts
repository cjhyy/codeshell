import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rewritePluginVars } from "../src/plugins/varRewrite.js";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "varrewrite-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("rewritePluginVars", () => {
  it("replaces CLAUDE_PLUGIN_ROOT in hooks.json", () => {
    const file = join(workDir, "hooks.json");
    writeFileSync(
      file,
      JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/run" }] }] },
      }),
    );
    rewritePluginVars(workDir);
    const after = readFileSync(file, "utf8");
    expect(after).toContain("${CODESHELL_PLUGIN_ROOT}/run");
    expect(after).not.toContain("CLAUDE_PLUGIN_ROOT");
  });

  it("rewrites shell script content", () => {
    const file = join(workDir, "session-start");
    writeFileSync(
      file,
      [
        "#!/usr/bin/env bash",
        'cat "${CLAUDE_PLUGIN_ROOT}/skills/foo.md"',
        'if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then',
        "  echo hi",
        "fi",
      ].join("\n"),
    );
    rewritePluginVars(workDir);
    const after = readFileSync(file, "utf8");
    expect(after.includes("CLAUDE_PLUGIN_ROOT")).toBe(false);
    expect(after).toContain("${CODESHELL_PLUGIN_ROOT}/skills/foo.md");
    expect(after).toContain('[ -n "${CODESHELL_PLUGIN_ROOT:-}" ]');
  });

  it("recurses into subdirectories", () => {
    const sub = join(workDir, "hooks");
    mkdirSync(sub);
    const file = join(sub, "hooks.json");
    writeFileSync(file, '{"x": "${CLAUDE_PLUGIN_ROOT}"}');
    rewritePluginVars(workDir);
    expect(readFileSync(file, "utf8")).toBe('{"x": "${CODESHELL_PLUGIN_ROOT}"}');
  });

  it("skips binary files (NUL byte heuristic)", () => {
    const file = join(workDir, "icon.png");
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x43, 0x4c, 0x41, 0x55, 0x44, 0x45, 0x5f, 0x50, 0x4c, 0x55, 0x47, 0x49, 0x4e, 0x5f, 0x52, 0x4f, 0x4f, 0x54]);
    writeFileSync(file, buf);
    rewritePluginVars(workDir);
    const after = readFileSync(file);
    expect(after.equals(buf)).toBe(true);
  });

  it("drops a breadcrumb file at install root", () => {
    writeFileSync(join(workDir, "x.txt"), "hello");
    rewritePluginVars(workDir);
    const breadcrumb = JSON.parse(
      readFileSync(join(workDir, ".code-shell-installed.json"), "utf8"),
    );
    expect(breadcrumb.from).toBe("CLAUDE_PLUGIN_ROOT");
    expect(breadcrumb.to).toBe("CODESHELL_PLUGIN_ROOT");
    expect(typeof breadcrumb.rewrittenAt).toBe("string");
  });

  it("reports counts in summary", () => {
    writeFileSync(join(workDir, "a.txt"), "no var here");
    writeFileSync(join(workDir, "b.txt"), "use ${CLAUDE_PLUGIN_ROOT} here");
    writeFileSync(join(workDir, "c.txt"), "${CLAUDE_PLUGIN_ROOT} and ${CLAUDE_PLUGIN_ROOT}");
    const summary = rewritePluginVars(workDir);
    expect(summary.filesScanned).toBeGreaterThanOrEqual(3);
    expect(summary.filesRewritten).toBe(2);
  });

  it("is idempotent (second run is a no-op for content)", () => {
    writeFileSync(join(workDir, "x.txt"), "${CLAUDE_PLUGIN_ROOT}");
    rewritePluginVars(workDir);
    const first = readFileSync(join(workDir, "x.txt"), "utf8");
    rewritePluginVars(workDir);
    const second = readFileSync(join(workDir, "x.txt"), "utf8");
    expect(first).toBe(second);
    expect(first).toBe("${CODESHELL_PLUGIN_ROOT}");
  });

  it("skips .git directory", () => {
    const git = join(workDir, ".git");
    mkdirSync(git);
    writeFileSync(join(git, "config"), "${CLAUDE_PLUGIN_ROOT}");
    rewritePluginVars(workDir);
    expect(readFileSync(join(git, "config"), "utf8")).toBe("${CLAUDE_PLUGIN_ROOT}");
  });

  it("no-ops when installPath does not exist", () => {
    const summary = rewritePluginVars(join(workDir, "nonexistent"));
    expect(summary.filesRewritten).toBe(0);
    expect(summary.filesScanned).toBe(0);
  });
});
