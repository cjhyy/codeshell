import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { PanelExecutionGate } from "@cjhyy/code-shell-server/panels";
import { panelChangeOperation } from "./panel-update-blockers.js";

// Exercise the composition callbacks without booting Electron or a real worker.
function declaration(file: string, name: string): string {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const node = parsed.statements.find(
    (value): value is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(value) && value.name?.text === name,
  );
  if (!node) throw new Error(`Missing production function ${name}`);
  return ts.transpileModule(node.getText(parsed).replace("export function", "function"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
}

function fixture(hasBridge = true) {
  const events: Array<{ kind: string; args?: unknown[] }> = [];
  const windows = [
    {
      isDestroyed: () => false,
      webContents: { send: (...args: unknown[]) => events.push({ kind: "native", args }) },
    },
    {
      isDestroyed: () => true,
      webContents: { send: () => events.push({ kind: "destroyed" }) },
    },
  ];
  const composition = runInNewContext(
    `${declaration("./index.ts", "broadcastPanelAppsChanged")}
     ${declaration("./index.ts", "applyRendererSettingsSideEffects")}
     ({ broadcastPanelAppsChanged, applyRendererSettingsSideEffects })`,
    {
      bridge: hasBridge
        ? {
            notifyWebConfigurationChanged: (...args: unknown[]) =>
              events.push({ kind: "paired-web", args }),
          }
        : null,
      invalidatePanelAppBindingGuard: () => events.push({ kind: "invalidate" }),
      mainWindows: windows,
      touchesExternalSessionVisibility: () => false,
    },
  );
  return { events, windows, composition };
}

test("Panel changes invalidate authority before refreshing native and paired Web clients", () => {
  const f = fixture();
  f.composition.broadcastPanelAppsChanged(f.windows);
  expect(f.events).toEqual([
    { kind: "invalidate" },
    // Global removal/disable must refresh the phone's current authorized
    // workspace, including another project or a secondary/worktree path.
    { kind: "paired-web", args: [] },
    { kind: "native", args: ["panel-apps:changed"] },
  ]);
});

test("native global disable refreshes paired Web without a project mutation reload", async () => {
  const f = fixture();
  await f.composition.applyRendererSettingsSideEffects("user", {
    disabledPanelApps: ["fixture-panel"],
  });
  expect(f.events.filter((event) => event.kind === "paired-web")).toEqual([
    { kind: "paired-web", args: [] },
  ]);
  expect(f.events[0]?.kind).toBe("invalidate");
});

test("native uninstall refreshes paired Web even though it does not reload project configuration", async () => {
  const f = fixture();
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const register = runInNewContext(
    `${declaration("./project-panel-ipc.ts", "registerProjectPanelIpc")}\nregisterProjectPanelIpc`,
    {
      registerProjectPanelVersionIpc() {},
      panelExecutionGate: new PanelExecutionGate(),
      panelChangeOperation,
      uninstallPanelAppForUi: async () => f.events.push({ kind: "uninstall" }),
      readSettings: async () => ({ disabledPanelApps: ["fixture-panel"] }),
      writeSettings: async () => f.events.push({ kind: "settings" }),
    },
  );
  register({
    ipcMain: {
      handle: (name: string, handler: (...args: unknown[]) => Promise<unknown>) =>
        handlers.set(name, handler),
    },
    requireRendererProjectPath: async (path: string) => path,
    withMutation: () => {
      throw new Error("Uninstall does not pass through the project mutation notifier");
    },
    onChanged: () => f.composition.broadcastPanelAppsChanged(f.windows),
    revokeAppId: () => f.events.push({ kind: "revoke-native" }),
    onCleanupError: () => {
      throw new Error("Unexpected cleanup failure");
    },
    describeGuest: () => undefined,
    closeForPackageChange: async () => {
      f.events.push({ kind: "drain" });
    },
  });
  expect(await handlers.get("panel-apps:uninstall")!({}, "fixture-panel")).toEqual({ ok: true });
  expect(f.events).toEqual([
    { kind: "drain" },
    { kind: "uninstall" },
    { kind: "revoke-native" },
    { kind: "settings" },
    { kind: "invalidate" },
    { kind: "paired-web", args: [] },
    { kind: "native", args: ["panel-apps:changed"] },
  ]);
});

test("native Panel notifications remain available before the bridge is created", () => {
  const f = fixture(false);
  f.composition.broadcastPanelAppsChanged(f.windows);
  expect(f.events).toEqual([
    { kind: "invalidate" },
    { kind: "native", args: ["panel-apps:changed"] },
  ]);
});
