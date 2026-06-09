import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { selectPlatformScript, runWorktreeSetup } from "./worktree.js";

// Beta cleanup: localEnvironment.setupScripts runs once when a worktree is
// created. Two units under test: platform selection (pure) + the runner
// (real spawn in a temp dir, warns-but-continues on failure).

describe("selectPlatformScript", () => {
  test("undefined scripts → undefined", () => {
    expect(selectPlatformScript(undefined)).toBeUndefined();
  });

  test("picks macos on darwin, linux on linux, windows on win32", () => {
    const scripts = { macos: "echo mac", linux: "echo linux", windows: "echo win" };
    expect(selectPlatformScript(scripts, "darwin")).toBe("echo mac");
    expect(selectPlatformScript(scripts, "linux")).toBe("echo linux");
    expect(selectPlatformScript(scripts, "win32")).toBe("echo win");
  });

  test("falls back to default when the platform key is missing", () => {
    expect(selectPlatformScript({ default: "echo all" }, "darwin")).toBe("echo all");
  });

  test("platform key wins over default", () => {
    expect(selectPlatformScript({ default: "echo all", macos: "echo mac" }, "darwin")).toBe(
      "echo mac",
    );
  });

  test("blank/whitespace script is treated as absent (no fallback to it)", () => {
    expect(selectPlatformScript({ macos: "   " }, "darwin")).toBeUndefined();
    // blank platform key → falls through to default
    expect(selectPlatformScript({ macos: "  ", default: "echo all" }, "darwin")).toBe("echo all");
  });
});

describe("runWorktreeSetup", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wt-setup-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("no script → skipped, ok, no spawn", async () => {
    const r = await runWorktreeSetup(dir, undefined);
    expect(r).toEqual({ skipped: true, ok: true, output: "" });
    const r2 = await runWorktreeSetup(dir, "   ");
    expect(r2.skipped).toBe(true);
  });

  test("runs the script in the worktree root", async () => {
    const r = await runWorktreeSetup(dir, "pwd > where.txt && echo done");
    expect(r.skipped).toBe(false);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("done");
    expect(existsSync(join(dir, "where.txt"))).toBe(true);
    // realpath on macOS may prefix /private; just check the dir basename lands.
    expect(readFileSync(join(dir, "where.txt"), "utf-8")).toContain(dir.split("/").pop()!);
  });

  test("non-zero exit → ok:false but does not throw (warns-but-continues)", async () => {
    const r = await runWorktreeSetup(dir, "echo boom >&2; exit 3");
    expect(r.skipped).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(3);
    expect(r.output).toContain("boom");
  });

  test("layers shellEnv into the script environment", async () => {
    const r = await runWorktreeSetup(dir, "echo $MY_SETUP_VAR", {
      shellEnv: { MY_SETUP_VAR: "injected" },
    });
    expect(r.ok).toBe(true);
    expect(r.output).toContain("injected");
  });
});
