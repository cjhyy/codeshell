import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyPath,
  enforcePathPolicyWithApproval,
  __resetPathPolicyWarnLatchForTests,
} from "../packages/core/src/tool-system/path-policy.js";
import type { ToolContext } from "../packages/core/src/tool-system/context.js";

/**
 * Task 6 — PathPolicy classifies a file path as allow / ask depending on
 * workspace placement, protected paths, and the requested operation.
 * Reads are always allowed. Writes ask outside the workspace and on protected
 * paths (credentials, .git, agent/IDE config, shell rc files); other
 * in-workspace writes are allowed. Symlinks are followed.
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
    expect(classifyPath(target, { workspaceRoot: workspace, operation: "write" }).decision).toBe(
      "allow",
    );
  });

  test("in-workspace, normal file, read → allow", () => {
    const target = join(workspace, "src/foo.ts");
    expect(classifyPath(target, { workspaceRoot: workspace, operation: "read" }).decision).toBe(
      "allow",
    );
  });

  test("deep nested in-workspace path is allowed", () => {
    const target = join(workspace, "a/b/c/d/e/f.ts");
    expect(classifyPath(target, { workspaceRoot: workspace, operation: "write" }).decision).toBe(
      "allow",
    );
  });

  // ─── read: always allowed ─────────────────────────────────────────
  test("every read is allowed: outside, sensitive, CodeShell state, directories", () => {
    writeFileSync(join(workspace, ".env"), "x\n");
    for (const target of [
      join(outside, "x.txt"),
      outside,
      homedir(),
      join(workspace, ".env"),
      join(workspace, ".git", "config"),
      "~/.ssh/known_hosts",
      "~/.aws/credentials",
      "~/.code-shell/settings.json",
      "~/.code-shell/sessions/s-abc123/tool-results/call_1.txt",
    ]) {
      expect(classifyPath(target, { workspaceRoot: workspace, operation: "read" }).decision).toBe(
        "allow",
      );
    }
  });

  // ─── write: outside workspace asks ────────────────────────────────
  test("outside-workspace write → ask", () => {
    expect(
      classifyPath(join(outside, "x.txt"), { workspaceRoot: workspace, operation: "write" })
        .decision,
    ).toBe("ask");
  });

  // ─── write: protected paths ask, even inside the workspace ────────
  test.each([
    ".env",
    ".env.production",
    "id_rsa",
    "server.pem",
    "credentials.json",
    ".git",
    ".git/hooks/pre-commit",
    "packages/sub/.git/config",
    ".gitmodules",
    ".husky/pre-commit",
    ".code-shell/settings.local.json",
    ".code-shell/skills/demo/SKILL.md",
    ".claude/settings.json",
    ".codex/config.toml",
    ".agents/skills/demo.md",
    ".mcp.json",
    ".vscode/settings.json",
    ".idea/workspace.xml",
    ".devcontainer/devcontainer.json",
    ".npmrc",
    ".yarnrc.yml",
    ".cargo/config.toml",
    ".mvn/wrapper/maven-wrapper.properties",
  ])("write to %s inside the workspace → ask (protected)", (rel) => {
    const c = classifyPath(join(workspace, rel), { workspaceRoot: workspace, operation: "write" });
    expect(c.decision).toBe("ask");
    expect(c.reason).toStartWith("protected path");
  });

  test.each([
    "~/.ssh/id_rsa",
    "~/.aws/credentials",
    "~/.config/gh/hosts.yml",
    "~/Library/Keychains/login.keychain-db",
    "~/.code-shell/settings.json",
    "~/.zshrc",
    "~/.bashrc",
    "~/.gitconfig",
    "~/.claude.json",
  ])("write to %s → ask (protected)", (target) => {
    const c = classifyPath(target, { workspaceRoot: workspace, operation: "write" });
    expect(c.decision).toBe("ask");
    expect(c.reason).toStartWith("protected path");
  });

  test.each(["src/index.ts", ".gitignore", ".github/workflows/ci.yml", ".claude/worktrees/x/a.ts"])(
    "write to %s inside the workspace → allow",
    (rel) => {
      expect(
        classifyPath(join(workspace, rel), { workspaceRoot: workspace, operation: "write" })
          .decision,
      ).toBe("allow");
    },
  );

  test("a workspace opened inside a protected dir owns its files", () => {
    // e.g. a Codex worktree under ~/.codex/worktrees, or the no-repo
    // workspace under ~/.code-shell: only paths below the root are judged.
    const root = join(outside, ".codex", "worktrees", "proj");
    mkdirSync(root, { recursive: true });
    expect(
      classifyPath(join(root, "src", "a.ts"), { workspaceRoot: root, operation: "write" }).decision,
    ).toBe("allow");
    expect(
      classifyPath(join(root, ".git", "hooks", "pre-commit"), {
        workspaceRoot: root,
        operation: "write",
      }).decision,
    ).toBe("ask");

    const previousHome = process.env.HOME;
    const fakeHome = join(outside, "home");
    const noRepo = join(fakeHome, ".code-shell", "no-repo");
    mkdirSync(noRepo, { recursive: true });
    process.env.HOME = fakeHome;
    try {
      expect(
        classifyPath(join(noRepo, "notes.md"), { workspaceRoot: noRepo, operation: "write" })
          .decision,
      ).toBe("allow");
      expect(
        classifyPath(join(fakeHome, ".code-shell", "settings.json"), {
          workspaceRoot: noRepo,
          operation: "write",
        }).decision,
      ).toBe("ask");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  test("protected scope is the protected item, not the file's directory", () => {
    expect(
      classifyPath(join(workspace, ".git", "hooks", "pre-commit"), {
        workspaceRoot: workspace,
        operation: "write",
      }).protectedScope,
    ).toBe(join(realpathSync(workspace), ".git") + "/");
    expect(
      classifyPath(join(workspace, ".env"), { workspaceRoot: workspace, operation: "write" })
        .protectedScope,
    ).toBe(join(realpathSync(workspace), ".env") + "/");
    expect(
      classifyPath(join(outside, "x.txt"), { workspaceRoot: workspace, operation: "write" })
        .protectedScope,
    ).toBeUndefined();
  });

  // ─── symlink resolution ───────────────────────────────────────────
  test("symlink into a protected path is followed before classification", () => {
    const link = join(workspace, "looks-innocent");
    symlinkSync(join(workspace, ".git"), link, "dir");
    mkdirSync(join(workspace, ".git", "hooks"), { recursive: true });
    const c = classifyPath(join(link, "hooks", "pre-commit"), {
      workspaceRoot: workspace,
      operation: "write",
    });
    expect(c.decision).toBe("ask");
    expect(c.reason).toStartWith("protected path");
  });

  // ─── env disable switch ───────────────────────────────────────────
  test("CODESHELL_PATH_POLICY=off makes every decision allow", () => {
    process.env.CODESHELL_PATH_POLICY = "off";
    __resetPathPolicyWarnLatchForTests();
    expect(
      classifyPath("~/.ssh/id_rsa", {
        workspaceRoot: workspace,
        operation: "write",
      }).decision,
    ).toBe("allow");
    expect(
      classifyPath("/etc/passwd", {
        workspaceRoot: workspace,
        operation: "read",
      }).decision,
    ).toBe("allow");
  });

  test("CODESHELL_PATH_POLICY=0 and =false also disable", () => {
    process.env.CODESHELL_PATH_POLICY = "0";
    __resetPathPolicyWarnLatchForTests();
    expect(
      classifyPath("/etc/passwd", { workspaceRoot: workspace, operation: "read" }).decision,
    ).toBe("allow");
    process.env.CODESHELL_PATH_POLICY = "false";
    __resetPathPolicyWarnLatchForTests();
    expect(
      classifyPath("/etc/passwd", { workspaceRoot: workspace, operation: "read" }).decision,
    ).toBe("allow");
  });

  // ─── degenerate inputs ────────────────────────────────────────────
  test("empty path → deny", () => {
    expect(classifyPath("", { workspaceRoot: workspace, operation: "read" }).decision).toBe("deny");
  });

  test("reason text is non-empty and informative", () => {
    const c = classifyPath("~/.ssh/x", { workspaceRoot: workspace, operation: "write" });
    expect(c.reason).toContain("~/.ssh");
  });

  test("outside-workspace ask can be approved and continue", async () => {
    let question = "";
    const ctx = {
      cwd: workspace,
      askUser: async (q: string) => {
        question = q;
        return "允许本次";
      },
    } as ToolContext;

    const blocked = await enforcePathPolicyWithApproval(join(outside, "x.txt"), "write", ctx);

    expect(blocked).toBeNull();
    expect(question).toContain("工作区外路径");
  });

  test("outside-workspace ask is blocked when user denies", async () => {
    const ctx = {
      cwd: workspace,
      askUser: async () => "拒绝",
    } as ToolContext;

    const blocked = await enforcePathPolicyWithApproval(join(outside, "x.txt"), "write", ctx);

    expect(blocked).toContain("path approval denied");
  });

  test("outside-workspace ask is blocked without interactive UI", async () => {
    const ctx = { cwd: workspace } as ToolContext;

    const blocked = await enforcePathPolicyWithApproval(join(outside, "x.txt"), "write", ctx);

    expect(blocked).toContain("No interactive approval UI");
  });
});
