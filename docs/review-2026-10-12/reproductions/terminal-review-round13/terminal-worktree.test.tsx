import { afterEach, expect, mock, test } from "bun:test";
import React, { act } from "react";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { runInNewContext } from "node:vm";
const repo = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/$/, "");
if (!process.env.CODE_SHELL_TEST_HOME) throw new Error("guarded HOME required");
const { installLocalNetworkGuard } = await import(repo + "/scripts/runtime-cost-smoke-isolation.mjs");
installLocalNetworkGuard("http://127.0.0.1:9");
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";
const { default: ts } = await import(repo + "/node_modules/typescript/lib/typescript.js");
const { SessionManager } = await import(repo + "/packages/core/src/index.ts");
const { getProjectStore, __resetProjectStoreForTest } = await import(repo + "/packages/desktop/src/main/project-store.ts");
const { requireRendererProjectPath } = await import(repo + "/packages/desktop/src/main/renderer-project-path.ts");
const { assertValidPtySessionId } = await import(repo + "/packages/desktop/src/main/pty-service.ts");
const workspace = await import(repo + "/packages/desktop/src/main/session-workspace-service.ts");
const { ensureMiniDom, flushMicrotasks } = await import(repo + "/packages/desktop/src/renderer/test-utils/renderHook.tsx");
const { createRoot } = await import(repo + "/packages/desktop/node_modules/react-dom/client");
const writes: string[] = [];
class FakeTerminal {
  cols = 80; rows = 24; buffer = { active: { getLine: () => undefined } };
  loadAddon() {} open() {} focus() {} dispose() {}
  write(value: string) { writes.push(value); }
  onData() { return { dispose() {} }; }
  registerLinkProvider() { return { dispose() {} }; }
}
mock.module("@xterm/xterm", () => ({ Terminal: FakeTerminal }));
mock.module("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
const { TerminalPanel } = await import(repo + "/packages/desktop/src/renderer/panels/TerminalPanel.tsx");
const { usePanelWorkspaceRoot } = await import(repo + "/packages/desktop/src/renderer/panels/usePanelWorkspaceRoot.ts");
let root: any;
let temporary = "";
afterEach(async () => {
  if (root) await act(async () => { root.unmount(); await flushMicrotasks(); });
  root = undefined;
  workspace.__setSessionWorkspaceServiceProjectStoreForTests(undefined);
  workspace.__setSessionWorkspaceServiceSessionManagerForTests(undefined);
  __resetProjectStoreForTest();
  if (temporary) rmSync(temporary, { recursive: true, force: true });
  temporary = "";
});
const settle = async () => { await flushMicrotasks(); await new Promise(r => setTimeout(r, 0)); await flushMicrotasks(); };
async function until(check: () => boolean) {
  const end = Date.now() + 4000;
  while (!check()) { if (Date.now() >= end) throw new Error("terminal fixture did not settle"); await act(settle); }
}
test("CONFIRMED valid managed-worktree Terminal is rejected by actual Main path validation before native spawn; primary-root control succeeds", async () => {
  ensureMiniDom();
  Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
  Object.assign(document.documentElement, { classList: { contains: () => false } });
  temporary = realpathSync(mkdtempSync(join(tmpdir(), "codeshell-terminal-worktree-round13-")));
  const cwd = join(temporary, "project"); mkdirSync(cwd);
  const git = (args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
  git(["init", "-q"]); git(["config", "user.name", "Fixture"]); git(["config", "user.email", "fixture@example.invalid"]);
  writeFileSync(join(cwd, "note.txt"), "initial\n"); git(["add", "-A"]); git(["commit", "-qm", "initial"]);
  const store = getProjectStore(); const project = await store.createFromPath(cwd);
  const sm = new SessionManager(join(temporary, "sessions")); const sid = "worktree-terminal-session";
  sm.create(cwd, "fixture-model", "fixture-provider", sid);
  sm.updateSessionState(sid, { project: { projectId: project.id, mainRootId: project.primaryRootId } });
  workspace.__setSessionWorkspaceServiceProjectStoreForTests(store);
  workspace.__setSessionWorkspaceServiceSessionManagerForTests(sm);
  const attached = await workspace.switchSessionWorkspaceForUi(sid, cwd, "terminal-fixture");
  expect(attached.current.kind).toBe("worktree");
  const authority = await workspace.getSessionWorkspaceAuthorityForUi(sid);
  expect(authority.rootStatus).toBe("ok"); expect(authority.workspace.root).toBe(attached.current.root);
  expect(await workspace.requireSessionFileRootForUi(sid, project.primaryRootId)).toBe(attached.current.root);
  expect((await store.list()).flatMap(p => p.roots).some(r => r.path === attached.current.root)).toBe(false);
  const parsed = ts.createSourceFile("index.ts", readFileSync(repo + "/packages/desktop/src/main/index.ts", "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let callback: any;
  function visit(n: any) { if (ts.isCallExpression(n) && n.arguments[0]?.getText(parsed) === '"pty:start"') callback = n.arguments.find((a: any) => ts.isArrowFunction(a)); ts.forEachChild(n, visit); }
  visit(parsed); expect(callback).toBeDefined();
  const nativeSpawns: any[] = [];
  const js = ts.transpileModule("const handler = " + callback.getText(parsed), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const handler = runInNewContext(js + "\nhandler", { assertValidPtySessionId, requireRendererProjectPath, resolveNoRepoCwd: () => join(temporary, "no-repo"), ptyStart: (_wc: any, opts: any) => { nativeSpawns.push(opts); return { ok: true }; } });
  const requests: any[] = [];
  Object.defineProperty(window, "codeshell", { configurable: true, value: {
    windowToken: "fixture-window",
    getSessionWorkspaceAuthority: (id: string) => workspace.getSessionWorkspaceAuthorityForUi(id),
    ptyStart: async (opts: any) => { requests.push(opts); return handler({ sender: {} }, opts); },
    ptyResize: async () => {}, ptyWrite: async () => {}, onPtyData: () => () => {}, onPtyExit: () => () => {}, openExternal: async () => {}, openPath: async () => "",
  } });
  function Host() { const w = usePanelWorkspaceRoot(sid, cwd); return w.ready && w.root ? <TerminalPanel cwd={w.root} sessionId="term:fixture:1" /> : null; }
  const container = document.createElement("div"); root = createRoot(container);
  await act(async () => { root.render(<Host />); await settle(); });
  await until(() => writes.some(v => v.includes("project path is not registered with CodeShell")));
  expect(requests).toHaveLength(1); expect(requests[0].cwd).toBe(attached.current.root); expect(nativeSpawns).toHaveLength(0);
  expect(writes.join("")).toContain("project path is not registered with CodeShell");
  const primary = await handler({ sender: {} }, { sessionId: "term:primary:1@fixture-window", cwd, cols: 80, rows: 24 });
  expect(primary.ok).toBe(true); expect(nativeSpawns).toHaveLength(1); expect(nativeSpawns[0].cwd).toBe(cwd);
  const secondary = join(temporary, "secondary"); mkdirSync(secondary); await store.addRoot(project.id, secondary);
  expect((await handler({ sender: {} }, { sessionId: "term:secondary:1@fixture-window", cwd: secondary })).ok).toBe(true);
  const unregistered = join(temporary, "unregistered"); mkdirSync(unregistered);
  await expect(handler({ sender: {} }, { sessionId: "term:unknown:1@fixture-window", cwd: unregistered })).rejects.toThrow("project path is not registered with CodeShell");
  expect(nativeSpawns).toHaveLength(2);
  await act(async () => { root.unmount(); await settle(); }); root = undefined;
  await workspace.switchSessionWorkspaceForUi(sid, cwd, "main");
  root = createRoot(container);
  await act(async () => { root.render(<Host />); await settle(); });
  await until(() => requests.length === 2 && nativeSpawns.length === 3);
  expect(requests[1].cwd).toBe(cwd); expect(nativeSpawns[2].cwd).toBe(cwd);
  console.log(JSON.stringify({ rootStatus: authority.rootStatus, managedWorkspace: attached.current.kind, rendererPtyCwd: requests[0].cwd, error: "project path is not registered with CodeShell", rejectedBeforeNativeSpawn: true, primaryControl: primary.ok, actualNativePtyStarted: false }));
});
