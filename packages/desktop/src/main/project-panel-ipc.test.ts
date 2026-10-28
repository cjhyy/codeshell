import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import {
  resolvePanelAppBindingProjectPath,
  previewLocalPanelApp,
  installReviewedLocalPanelApp,
} from "@cjhyy/code-shell-core";
import { createDesktopPanelManagement } from "./panel-app-management.js";
import { PanelExecutionGate, panelExecutionGate } from "@cjhyy/code-shell-server/panels";
import { panelChangeOperation, panelUpdateApproval } from "./panel-update-blockers.js";

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
  panelChangeOperation,
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
    expect(await handlers.get("panel-apps:uninstall")!({}, "fixture")).toEqual({ ok: true });
    expect(uninstallEffects).toEqual(["drain", "uninstall"]);
  } finally {
    release();
  }
});

test("I9 uninstall IPC preserves service stop-unconfirmed blockers without deleting package bytes", async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const label = "feed: stop-unconfirmed; original process group 4242; exit unconfirmed";
  uninstallEffects.length = 0;
  const release = uninstallGate.enter({
    appId: "fixture",
    projectPath: tmpdir(),
    holder: { kind: "service", label },
  });
  register({
    ipcMain: {
      handle: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
    },
    requireRendererProjectPath: async (path: string) => path,
    withMutation: async (_cwd: string, write: () => Promise<unknown>) => write(),
    onChanged() {
      uninstallEffects.push("changed");
    },
    revokeAppId() {
      uninstallEffects.push("revoke");
    },
    onCleanupError(error: unknown) {
      throw error;
    },
    describeGuest() {},
    closeForPackageChange: async () => {
      uninstallEffects.push("drain");
    },
  });
  try {
    const result = await handlers.get("panel-apps:uninstall")!({}, "fixture");
    expect(result).toMatchObject({ ok: false, blockers: [{ kind: "service", count: 1, label }] });
    expect(uninstallEffects).toEqual(["drain"]);
    expect(uninstallGate.blockers(() => true)).toHaveLength(1);
  } finally {
    release();
  }
});

test("I9 actual reviewed project unbind IPC returns service blockers and leaves the binding intact", async () => {
  const root = mkdtempSync(join(tmpdir(), "panel-unbind-ipc-"));
  const previousHome = process.env.HOME;
  process.env.HOME = join(root, "home");
  const cwd = join(root, "project"),
    pkg = join(root, "package");
  mkdirSync(cwd);
  mkdirSync(join(pkg, ".codeshell-panel"), { recursive: true });
  mkdirSync(join(pkg, "app"));
  writeFileSync(join(pkg, "app/index.html"), "fixture");
  writeFileSync(
    join(pkg, ".codeshell-panel/panel.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "fixture",
      version: "1.0.0",
      title: { default: "fixture" },
      entry: "app/index.html",
      icon: "panel",
      placement: "right-dock",
      singleton: true,
      permissions: ["storage"],
    }),
  );
  const handlers = new Map<string, (...args: any[]) => any>();
  const sender = Object.assign(new EventEmitter(), { id: 77002, isDestroyed: () => false });
  const effects: string[] = [];
  let release = () => {};
  const unregister = panelExecutionGate.registerServiceDrain(async () => {
    effects.push("drain");
  });
  register({
    ipcMain: {
      handle: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
    },
    requireRendererProjectPath: async (path: string) => path,
    withMutation: async (_cwd: string, write: () => Promise<unknown>) => write(),
    onChanged: () => effects.push("changed"),
    revokeAppId() {},
    onCleanupError() {},
    describeGuest() {},
    closeForPackageChange: async () => {},
  });
  try {
    const input = { kind: "dir" as const, path: pkg };
    const preview = await previewLocalPanelApp(input);
    await installReviewedLocalPanelApp(input, preview.reviewToken, new Date().toISOString());
    const management = createDesktopPanelManagement(cwd);
    const initial = (await management.snapshot())[0]!;
    await management.binding(
      { ownerId: "fixture", authorize: () => true },
      "fixture",
      true,
      initial.revision,
    );
    const selected = (await management.snapshot())[0]!;
    const label = "feed: stop-unconfirmed; original process group 9876; exit unconfirmed";
    release = panelExecutionGate.enter({
      appId: "fixture",
      projectPath: cwd,
      holder: { kind: "service", label },
    });
    effects.length = 0;
    const result = await handlers.get("panel-apps:setProjectBinding")!(
      { sender },
      cwd,
      "fixture",
      false,
      selected.revision,
    );
    expect(result).toMatchObject({ ok: false, blockers: [{ kind: "service", count: 1, label }] });
    expect((await management.snapshot())[0]!.bound).toBe(true);
    expect(effects).toEqual(["drain"]);
    release();
    expect(
      await handlers.get("panel-apps:setProjectBinding")!(
        { sender },
        cwd,
        "fixture",
        false,
        selected.revision,
      ),
    ).toMatchObject({ ok: true, bindings: [{ appId: "fixture", bound: false }] });
  } finally {
    release();
    unregister();
    sender.emit("destroyed");
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});
