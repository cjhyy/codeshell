import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { resolvePanelAppBindingProjectPath } from "@cjhyy/code-shell-core";
import { createDesktopPanelManagement } from "./panel-app-management.js";
import { PanelExecutionGate } from "../../../server/src/panels/execution-gate.js";
import { panelChangeFailure, panelUpdateApproval } from "./panel-update-blockers.js";

// Exercise the actual registrar without loading Electron's composition root.
// Unrelated route providers are adapters; review validation and cancellation use
// the production management service and execution gate.
const source = readFileSync(new URL("./project-panel-ipc.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("ipc.ts", source, ts.ScriptTarget.Latest, true);
const declaration = parsed.statements.find(
  (node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === "registerProjectPanelIpc",
)!;
const compiled = ts.transpileModule(
  declaration.getText(parsed).replace("export function", "function"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
).outputText;
const uninstallGate = new PanelExecutionGate();
const uninstallEffects: string[] = [];
const register = runInNewContext(`${compiled}\nregisterProjectPanelIpc`, {
  createDesktopPanelManagement,
  panelUpdateApproval,
  panelChangeFailure,
  resolvePanelAppBindingProjectPath,
  createProjectPanelAppUpdateService: () => ({ invalidate() {} }),
  panelAppUpdateService: { invalidate() {} },
  registerProjectPanelVersionIpc() {},
  Error,
  panelExecutionGate: uninstallGate,
  uninstallPanelAppForUi: async () => {
    uninstallEffects.push("uninstall");
  },
  readSettings: async () => ({}),
  writeSettings: async () => {},
});

test("the force-update IPC never closes Panel work for an invalid review", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "panel-force-ipc-"));
  const handlers = new Map<string, (...args: any[]) => any>();
  const sideEffects: string[] = [];
  const sender = Object.assign(new EventEmitter(), { id: 77001, isDestroyed: () => false });
  register({
    ipcMain: {
      handle: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
    },
    requireRendererProjectPath: async (path: string) => path,
    withMutation: async (_cwd: string, write: () => Promise<unknown>) => write(),
    onChanged: () => sideEffects.push("changed"),
    revokeAppId() {},
    onCleanupError() {},
    describeGuest: () => undefined,
    closeForPackageChange: async () => {
      sideEffects.push("cancelled");
    },
  });
  try {
    const result = await handlers.get("panel-apps:installUpdate")!(
      { sender },
      {
        cwd,
        id: "active-panel",
        reviewToken: "expired-or-invalid-review",
        force: true,
      },
    );
    expect(result).toMatchObject({ ok: false });
    expect(result.error).toContain("预览已失效");
    expect(sideEffects).toEqual([]);
  } finally {
    sender.emit("destroyed");
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("uninstall IPC drains package custody before removing bytes", async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  uninstallEffects.length = 0;
  const release = uninstallGate.enter({
    appId: "fixture",
    projectPath: tmpdir(),
    holder: { kind: "service" },
  });
  register({
    ipcMain: {
      handle: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
    },
    requireRendererProjectPath: async (path: string) => path,
    withMutation: async (_cwd: string, write: () => Promise<unknown>) => write(),
    onChanged() {},
    revokeAppId() {},
    onCleanupError(error: unknown) {
      throw error;
    },
    describeGuest() {},
    closeForPackageChange: async () => {
      uninstallEffects.push("drain");
      release();
    },
  });
  try {
    await handlers.get("panel-apps:uninstall")!({}, "fixture");
    expect(uninstallEffects).toEqual(["drain", "uninstall"]);
  } finally {
    release();
  }
});
