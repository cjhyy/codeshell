import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { classifyPath, enforcePathPolicyWithApproval } from "./path-policy.js";
import type { ToolContext } from "./context.js";

describe("ordinary CodeShell files", () => {
  let home: string;
  let workspace: string;
  let root: string;
  let previousHome: string | undefined;
  let previousPolicy: string | undefined;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "cs-file-policy-")));
    workspace = join(home, "workspace");
    root = join(home, ".code-shell");
    mkdirSync(workspace);
    previousHome = process.env.HOME;
    previousPolicy = process.env.CODESHELL_PATH_POLICY;
    process.env.HOME = home;
    delete process.env.CODESHELL_PATH_POLICY;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousPolicy === undefined) delete process.env.CODESHELL_PATH_POLICY;
    else process.env.CODESHELL_PATH_POLICY = previousPolicy;
    rmSync(home, { recursive: true, force: true });
  });

  function file(relativePath: string): string {
    const path = join(root, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "synthetic fixture\n");
    return path;
  }

  // Reads are never gated; every write under ~/.code-shell is a protected
  // path that asks (it holds provider keys, MCP config and agent settings).
  test.each([
    "sessions/child-id/state.json",
    "sessions/child-id/transcript.jsonl",
    "logs/desktop/sessions/session-child.jsonl",
    "profiles/work/memory/notes.md",
    "skills/unregistered/references/guide.md",
    "panel-apps/unregistered/README.md",
    "credentials.json",
    "settings.json",
    "settings.local.json.bak",
    "plugins/cache/example/.mcp.json",
    "browser-runtime/profiles/default/Default/Cookies",
    "serve/access.json",
    "desktop/project-runtime-secrets/project/runtime.json",
    "no-repo/.code-shell/attachments/sid/token.txt",
  ])("%s is readable without an approval UI and its writes ask", async (relativePath) => {
    const path = file(relativePath);
    expect(classifyPath(path, { workspaceRoot: workspace, operation: "read" }).decision).toBe(
      "allow",
    );
    expect(
      await enforcePathPolicyWithApproval(path, "read", { cwd: workspace } as ToolContext),
    ).toBeNull();
    const write = classifyPath(path, { workspaceRoot: workspace, operation: "write" });
    expect(write.decision).toBe("ask");
    expect(write.reason).toContain("~/.code-shell");
  });

  test("a symlink into ~/.code-shell is judged by its target on write", () => {
    const secret = file("browser-runtime/profiles/default/Default/Cookies");
    const link = join(workspace, "ordinary.txt");
    symlinkSync(secret, link);
    expect(classifyPath(link, { workspaceRoot: workspace, operation: "write" }).decision).toBe(
      "ask",
    );
  });

  test("the whole ~/.code-shell directory is readable", () => {
    file("ordinary.txt");
    file("credentials.json");
    expect(classifyPath(root, { workspaceRoot: workspace, operation: "read" }).decision).toBe(
      "allow",
    );
  });
});
