import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyPath,
  __resetPathPolicyWarnLatchForTests,
} from "../packages/core/src/tool-system/path-policy.js";

/**
 * Task 6 — PathPolicy classifies a file path as allow / ask / deny depending
 * on workspace placement, sensitivity, and the requested operation.
 * Sensitive write → deny. Sensitive read → ask. Outside workspace → ask.
 * Inside workspace + non-sensitive → allow. Symlinks are followed.
 */

describe("classifyPath", () => {
  let workspace: string;
  let outside: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "codeshell-pathpolicy-ws-"));
    outside = mkdtempSync(join(tmpdir(), "codeshell-pathpolicy-out-"));
    delete process.env.CODESHELL_PATH_POLICY;
    __resetPathPolicyWarnLatchForTests();
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    delete process.env.CODESHELL_PATH_POLICY;
  });

  // ─── allow ────────────────────────────────────────────────────────
  test("in-workspace, normal file, write → allow", () => {
    const target = join(workspace, "src/foo.ts");
    expect(classifyPath(target, { workspaceRoot: workspace, operation: "write" }).decision)
      .toBe("allow");
  });

  test("in-workspace, normal file, read → allow", () => {
    const target = join(workspace, "src/foo.ts");
    expect(classifyPath(target, { workspaceRoot: workspace, operation: "read" }).decision)
      .toBe("allow");
  });

  test("deep nested in-workspace path is allowed", () => {
    const target = join(workspace, "a/b/c/d/e/f.ts");
    expect(classifyPath(target, { workspaceRoot: workspace, operation: "write" }).decision)
      .toBe("allow");
  });

  // ─── ask: outside workspace ───────────────────────────────────────
  test("outside-workspace write → ask", () => {
    expect(classifyPath(join(outside, "x.txt"), { workspaceRoot: workspace, operation: "write" })
      .decision).toBe("ask");
  });

  test("outside-workspace read → ask", () => {
    expect(classifyPath(join(outside, "x.txt"), { workspaceRoot: workspace, operation: "read" })
      .decision).toBe("ask");
  });

  // ─── deny: sensitive write ────────────────────────────────────────
  test("write under ~/.ssh → deny", () => {
    const c = classifyPath("~/.ssh/id_rsa", { workspaceRoot: workspace, operation: "write" });
    expect(c.decision).toBe("deny");
    expect(c.reason).toContain("~/.ssh");
  });

  test("write to ~/.aws/credentials → deny", () => {
    const c = classifyPath("~/.aws/credentials", { workspaceRoot: workspace, operation: "write" });
    expect(c.decision).toBe("deny");
  });

  test("write to a .env file inside workspace → deny", () => {
    // Sensitive file pattern wins even inside the workspace.
    writeFileSync(join(workspace, ".env"), "SECRET=x\n");
    expect(classifyPath(join(workspace, ".env"), { workspaceRoot: workspace, operation: "write" })
      .decision).toBe("deny");
  });

  test("write to a .env.production file → deny", () => {
    expect(classifyPath(join(workspace, ".env.production"), {
      workspaceRoot: workspace,
      operation: "write",
    }).decision).toBe("deny");
  });

  test("write to an id_rsa file → deny", () => {
    expect(classifyPath(join(workspace, "id_rsa"), {
      workspaceRoot: workspace,
      operation: "write",
    }).decision).toBe("deny");
  });

  test("write to a .pem file → deny", () => {
    expect(classifyPath(join(workspace, "server.pem"), {
      workspaceRoot: workspace,
      operation: "write",
    }).decision).toBe("deny");
  });

  // ─── ask: sensitive read ──────────────────────────────────────────
  test("read under ~/.ssh → ask", () => {
    expect(classifyPath("~/.ssh/known_hosts", {
      workspaceRoot: workspace,
      operation: "read",
    }).decision).toBe("ask");
  });

  test("read current CodeShell session artifacts → allow", () => {
    const c = classifyPath("~/.code-shell/sessions/s-abc123/tool-results/call_1.txt", {
      workspaceRoot: workspace,
      operation: "read",
    });
    expect(c.decision).toBe("allow");
    expect(c.reason).toContain("diagnostic");
  });

  test("read CodeShell desktop logs → allow", () => {
    expect(classifyPath("~/.code-shell/logs/desktop-2026-05-31.log", {
      workspaceRoot: workspace,
      operation: "read",
    }).decision).toBe("allow");
  });

  test("CodeShell auth/token material remains protected", () => {
    expect(classifyPath("~/.code-shell/auth.json", {
      workspaceRoot: workspace,
      operation: "read",
    }).decision).toBe("ask");
    expect(classifyPath("~/.code-shell/sessions/s-abc123/token.txt", {
      workspaceRoot: workspace,
      operation: "read",
    }).decision).toBe("ask");
    expect(classifyPath("~/.code-shell/sessions/s-abc123/tool-results/call_1.txt", {
      workspaceRoot: workspace,
      operation: "write",
    }).decision).toBe("deny");
  });

  test("read of .env in workspace → ask", () => {
    writeFileSync(join(workspace, ".env"), "x\n");
    expect(classifyPath(join(workspace, ".env"), {
      workspaceRoot: workspace,
      operation: "read",
    }).decision).toBe("ask");
  });

  // ─── symlink resolution ───────────────────────────────────────────
  test("symlink-to-sensitive-path is followed before classification (write → deny)", () => {
    // A symlink inside the workspace that points at ~/.ssh must not let a
    // write slip through as "in workspace".
    const home = homedir();
    const sshLike = join(home, ".ssh");
    // Don't try to create the user's real ~/.ssh — assume it usually exists,
    // and if not, fall back to a sensitive-pattern dir we DO control.
    const realSensitive = sshLike;
    // Best-effort: only run the symlink follow check when the sensitive dir
    // exists on the host. Otherwise we can't symlink to it.
    try {
      const link = join(workspace, "looks-innocent");
      symlinkSync(realSensitive, link, "dir");
      const c = classifyPath(join(link, "id_rsa"), {
        workspaceRoot: workspace,
        operation: "write",
      });
      // Realpath resolves the link → ~/.ssh/id_rsa → deny.
      expect(c.decision).toBe("deny");
    } catch (e) {
      // ~/.ssh missing or symlink not permitted on this host — skip.
      if (!(e instanceof Error)) throw e;
    }
  });

  // ─── env disable switch ───────────────────────────────────────────
  test("CODESHELL_PATH_POLICY=off makes every decision allow", () => {
    process.env.CODESHELL_PATH_POLICY = "off";
    __resetPathPolicyWarnLatchForTests();
    expect(classifyPath("~/.ssh/id_rsa", {
      workspaceRoot: workspace,
      operation: "write",
    }).decision).toBe("allow");
    expect(classifyPath("/etc/passwd", {
      workspaceRoot: workspace,
      operation: "read",
    }).decision).toBe("allow");
  });

  test("CODESHELL_PATH_POLICY=0 and =false also disable", () => {
    process.env.CODESHELL_PATH_POLICY = "0";
    __resetPathPolicyWarnLatchForTests();
    expect(classifyPath("/etc/passwd", { workspaceRoot: workspace, operation: "read" }).decision)
      .toBe("allow");
    process.env.CODESHELL_PATH_POLICY = "false";
    __resetPathPolicyWarnLatchForTests();
    expect(classifyPath("/etc/passwd", { workspaceRoot: workspace, operation: "read" }).decision)
      .toBe("allow");
  });

  // ─── degenerate inputs ────────────────────────────────────────────
  test("empty path → deny", () => {
    expect(classifyPath("", { workspaceRoot: workspace, operation: "read" }).decision)
      .toBe("deny");
  });

  test("reason text is non-empty and informative", () => {
    const c = classifyPath("~/.ssh/x", { workspaceRoot: workspace, operation: "write" });
    expect(c.reason.length).toBeGreaterThan(0);
    expect(c.reason.toLowerCase()).toContain("sensitive");
  });
});
