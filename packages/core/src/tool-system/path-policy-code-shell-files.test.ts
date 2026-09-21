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

  test.each([
    "sessions/child-id/state.json",
    "sessions/child-id/transcript.jsonl",
    "logs/desktop/sessions/session-child.jsonl",
    "profiles/work/memory/notes.md",
    "themes/custom.json",
    "skills/unregistered/references/guide.md",
    "panel-apps/unregistered/README.md",
    "settings.schema.json",
    "im-gateway/inbox.json",
  ])("%s is readable without an approval UI and remains write-protected", async (relativePath) => {
    const path = file(relativePath);
    expect(classifyPath(path, { workspaceRoot: workspace, operation: "read" }).decision).toBe(
      "allow",
    );
    expect(
      await enforcePathPolicyWithApproval(path, "read", { cwd: workspace } as ToolContext),
    ).toBeNull();
    expect(classifyPath(path, { workspaceRoot: workspace, operation: "write" }).decision).toBe(
      "deny",
    );
  });

  test.each([
    "credentials.json",
    "credentials.json.bak",
    "credentials.json.123.01234567-89ab-cdef-0123-456789abcdef.tmp",
    "settings.json",
    "settings.managed.yaml",
    "settings.local.json.bak",
    "no-repo/.code-shell/settings.json",
    "no-repo/.code-shell/settings.local.json",
    "plugins/cache/example/.mcp.json",
    "plugins/cache/example/mcp-servers.json",
    "browser-runtime/profiles/default/Default/Cookies",
    "browser-runtime/profiles/default/Default/Local Storage/000003.log",
    "browser-runtime/chrome-native.json",
    "im-gateway/config.json",
    "im-gateway/desktop-control.json",
    "chat/wechat/accounts/user.state.json",
    "serve/access.json",
    "serve/hub/auth.json.123.01234567-89ab-cdef-0123-456789abcdef.tmp",
    "serve/project-control/registry.json",
    "desktop/project-control/registry.json",
    "serve/project-runtime-secrets/project/runtime.json",
    "desktop/project-runtime-secrets/project/runtime.json",
    "skills/unregistered/.env",
    "sessions/child-id/tool-results/private.key",
    "no-repo/.code-shell/attachments/sid/token.txt",
  ])("%s remains a sensitive read", (relativePath) => {
    const path = file(relativePath);
    expect(classifyPath(path, { workspaceRoot: workspace, operation: "read" }).decision).toBe(
      "ask",
    );
  });

  test("symlinks to credential containers cannot inherit ordinary file access", () => {
    const secret = file("browser-runtime/profiles/default/Default/Cookies");
    const link = join(root, "ordinary.txt");
    symlinkSync(secret, link);
    expect(classifyPath(link, { workspaceRoot: workspace, operation: "read" }).decision).toBe(
      "ask",
    );
  });

  test("the file grant does not authorize recursive reads of a mixed directory", () => {
    file("ordinary.txt");
    file("credentials.json");
    expect(classifyPath(root, { workspaceRoot: workspace, operation: "read" }).decision).toBe(
      "ask",
    );
  });
});
