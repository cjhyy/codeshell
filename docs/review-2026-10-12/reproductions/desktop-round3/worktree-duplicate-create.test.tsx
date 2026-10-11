import { afterEach, expect, mock, test } from "bun:test";
import React, { act } from "react";
import { createRoot } from "../../../../packages/desktop/node_modules/react-dom/client";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "@cjhyy/code-shell-core";
import {
  ensureMiniDom,
  flushMicrotasks,
} from "../../../../packages/desktop/src/renderer/test-utils/renderHook";
import {
  __setSessionWorkspaceServiceSessionManagerForTests,
  switchSessionWorkspaceForUi,
} from "../../../../packages/desktop/src/main/session-workspace-service";
import { registerProjectAuthorityIpc } from "../../../../packages/desktop/src/main/project-authority-ipc";

ensureMiniDom();
const PopoverContext = React.createContext<any>({ open: false });
const uiRoot = "../../../../packages/desktop/src/renderer/components/ui/";
mock.module(uiRoot + "popover", () => ({
  Popover: ({ open, onOpenChange, children }: any) => (
    <PopoverContext.Provider value={{ open, onOpenChange }}>{children}</PopoverContext.Provider>
  ),
  PopoverTrigger: ({ children }: any) => {
    const ctx = React.useContext(PopoverContext);
    return React.cloneElement(children, { onClick: () => ctx.onOpenChange(!ctx.open) });
  },
  PopoverContent: ({ children }: any) =>
    React.useContext(PopoverContext).open ? <div>{children}</div> : null,
}));
const pass = ({ children }: any) => <div>{children}</div>;
mock.module(uiRoot + "dialog", () => ({
  Dialog: ({ open, children }: any) => (open ? <div>{children}</div> : null),
  DialogContent: pass,
  DialogDescription: pass,
  DialogFooter: pass,
  DialogHeader: pass,
  DialogTitle: pass,
}));
const { WorkspaceIndicator } =
  await import("../../../../packages/desktop/src/renderer/topbar/WorkspaceIndicator");
let root: any,
  fixtureRoot = "";
const originalPath = process.env.PATH;
afterEach(async () => {
  await act(async () => {
    root?.unmount();
    await flushMicrotasks();
  });
  root = undefined;
  process.env.PATH = originalPath;
  __setSessionWorkspaceServiceSessionManagerForTests(undefined);
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
  fixtureRoot = "";
});
function nodes(node: any): any[] {
  return [node, ...Array.from(node?.childNodes ?? []).flatMap(nodes)];
}
function props(node: any): any {
  const key = Object.keys(node).find((x) => x.startsWith("__reactProps$"));
  return key ? node[key] : {};
}
function text(node: any): string {
  if (node.nodeType === 3) return node.data ?? node.textContent ?? "";
  const children = Array.from(node.childNodes ?? []);
  return children.length ? children.map(text).join("") : (node.textContent ?? "");
}

test("CONFIRMED new-worktree Enter submits again while Create is already disabled", async () => {
  const workspace = { root: "/fixture/repo", kind: "main" };
  const list = {
    current: workspace,
    mainRoot: workspace.root,
    worktrees: [{ path: workspace.root, isMain: true, branch: "main", isManaged: false }],
  };
  const requests: any[] = [];
  Object.defineProperty(window, "codeshell", {
    configurable: true,
    value: {
      getSessionWorkspaceAuthority: async () => ({
        workspace,
        projectId: null,
        mainRootId: null,
        mainRoot: workspace.root,
        mainRootName: "Fixture",
        rootStatus: "ok",
      }),
      getSessionGitBranches: async () => ({ isRepo: true, current: "main", branches: [] }),
      listProfiles: async () => [],
      listSessionWorktrees: async () => list,
      getSessionWorktreeDiff: async () => ({
        changedFiles: 0,
        aheadCommits: 0,
        hasUncommittedChanges: false,
      }),
      switchSessionWorkspace: (...args: any[]) => {
        requests.push(args);
        return new Promise(() => {});
      },
    },
  });
  const container = document.createElement("div");
  root = createRoot(container);
  await act(async () => {
    root.render(
      <WorkspaceIndicator
        sessionId="fixture-session"
        projectPath={workspace.root}
        projectName="Fixture"
      />,
    );
    await flushMicrotasks();
  });
  await act(async () => {
    props(nodes(container).find((node) => node.tagName === "BUTTON")).onClick();
    await flushMicrotasks();
  });
  await act(async () => {
    props(
      nodes(container).find(
        (node) => node.tagName === "BUTTON" && /New worktree|新建 worktree/.test(text(node)),
      ),
    ).onClick();
    await flushMicrotasks();
  });
  let input = nodes(container).find((node) => node.tagName === "INPUT");
  await act(async () => {
    props(input).onChange({ target: { value: "duplicate" } });
    await flushMicrotasks();
  });
  input = nodes(container).find((node) => node.tagName === "INPUT");
  await act(async () => {
    props(input).onKeyDown({ key: "Enter" });
    await flushMicrotasks();
  });
  const create = nodes(container).find(
    (node) => node.tagName === "BUTTON" && /Create and switch|创建并切换/.test(text(node)),
  );
  expect(props(create).disabled).toBe(true);
  expect(requests).toHaveLength(1);
  await act(async () => {
    props(input).onKeyDown({ key: "Enter" });
    await flushMicrotasks();
  });
  expect(requests).toHaveLength(2);
  expect(requests[0]).toEqual(requests[1]);
  console.log(JSON.stringify({ createDisabled: props(create).disabled, requests }));
});

test("CONFIRMED failed duplicate rolls back the successful request's worktree and uncommitted file", async () => {
  fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "codeshell-review-duplicate-")));
  const repo = join(fixtureRoot, "repo"),
    bin = join(fixtureRoot, "bin");
  mkdirSync(repo);
  mkdirSync(bin);
  const realGit = execFileSync("/usr/bin/which", ["git"], { encoding: "utf8" }).trim();
  const git = (args: string[]) =>
    execFileSync(realGit, args, {
      cwd: repo,
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
  git(["init", "-q"]);
  git(["config", "user.name", "Fixture"]);
  git(["config", "user.email", "fixture@example.invalid"]);
  writeFileSync(join(repo, "file.txt"), "fixture\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "fixture"]);
  const sm = new SessionManager(join(fixtureRoot, "sessions"));
  sm.create(repo, "fixture-model", "fixture-provider", "fixture-session");
  __setSessionWorkspaceServiceSessionManagerForTests(sm);
  // This executable uses actual Git for every operation. It imposes only an
  // allowed process-completion schedule: both add calls pass prechecks, the
  // winner finishes, and the loser's real Git failure reaches JS later.
  const wrapper = `#!${process.execPath}\nconst {mkdirSync,existsSync,writeFileSync}=require('node:fs');const{spawnSync}=require('node:child_process');const args=process.argv.slice(2);const gate=${JSON.stringify(join(fixtureRoot, "gate"))};if(args[0]==='worktree'&&args[1]==='add'){let first=false;try{mkdirSync(gate);first=true}catch{}if(first){while(!existsSync(gate+'/second'))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5)}else{writeFileSync(gate+'/second','');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100)}}const result=spawnSync(${JSON.stringify(realGit)},args,{encoding:'utf8'});if(args[0]==='worktree'&&args[1]==='add'&&result.status!==0)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,700);if(result.stdout)process.stdout.write(result.stdout);if(result.stderr)process.stderr.write(result.stderr);process.exit(result.status??1);\n`;
  writeFileSync(join(bin, "git"), wrapper, { mode: 0o755 });
  process.env.PATH = bin + ":" + originalPath;
  const handlers = new Map<string, any>(),
    events: any[] = [];
  registerProjectAuthorityIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: { send: (channel, payload) => events.push({ channel, payload }) },
      },
    ],
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    applyGitPathFromSettings: async () => {},
    projectStore: {} as any,
    getBridge: () => undefined,
    getTrust: async () => "trusted",
    assertSessionId: (id) => {
      if (typeof id !== "string" || !id) throw Error("invalid sid");
    },
    trackGitRoot: () => {},
    broadcastMobileProjects: async () => {},
    getGitStatus: async () => ({}) as any,
    getGitBranches: async () => ({}) as any,
    revealInFinder: async () => {},
    openPath: async () => "",
  } as any);
  let successfulPath = "",
    precious = "",
    beforeFailure: any;
  const start = () =>
    handlers
      .get("workspace:switch")({}, "fixture-session", repo, "duplicate")
      .then((result) => {
        successfulPath = result.current.root;
        precious = join(successfulPath, "new-uncommitted-work.txt");
        writeFileSync(precious, "user changes after successful creation\n");
        beforeFailure = {
          pathExists: existsSync(successfulPath),
          fileExists: existsSync(precious),
          branches: git(["branch", "--list", "*duplicate*"]),
        };
        expect(beforeFailure.pathExists).toBe(true);
        expect(beforeFailure.fileExists).toBe(true);
        expect(beforeFailure.branches).toContain("duplicate");
        return result;
      });
  const results = await Promise.allSettled([start(), start()]);
  expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((item) => item.status === "rejected")).toHaveLength(1);
  expect(successfulPath).not.toBe("");
  expect(existsSync(successfulPath)).toBe(false);
  expect(existsSync(precious)).toBe(false);
  expect(git(["branch", "--list", "*duplicate*"])).toBe("");
  expect(sm.getSessionWorkspace("fixture-session")?.root).toBe(successfulPath);
  expect(events.filter((event) => event.channel === "workspace:changed")).toHaveLength(1);
  console.log(
    JSON.stringify({
      beforeFailure,
      results: results.map((item) =>
        item.status === "fulfilled"
          ? { status: item.status, workspace: item.value.current }
          : { status: item.status, error: String(item.reason) },
      ),
      successfulPath,
      pathExists: existsSync(successfulPath),
      uncommittedFileExists: existsSync(precious),
      sessionWorkspace: sm.getSessionWorkspace("fixture-session"),
      events,
    }),
  );
});
