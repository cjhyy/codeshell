import { afterEach, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot } from "../../../../packages/desktop/node_modules/react-dom/client";
import {
  ensureMiniDom,
  flushMicrotasks,
} from "../../../../packages/desktop/src/renderer/test-utils/renderHook";
import { PanelAppHost } from "../../../../packages/desktop/src/renderer/panels/PanelAppHost";
import { SessionManager, resolvePanelAppBindingProjectPath } from "@cjhyy/code-shell-core";
import { ProjectStore } from "../../../../packages/desktop/src/main/project-store";
import { SessionCwdIndex } from "../../../../packages/desktop/src/main/session-cwd-index";
import {
  __setSessionWorkspaceServiceProjectStoreForTests,
  __setSessionWorkspaceServiceSessionManagerForTests,
  getSessionWorkspaceAuthorityForUi,
} from "../../../../packages/desktop/src/main/session-workspace-service";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { fileURLToPath } from "node:url";

// Execute the actual production method, as existing bridge tests do, without
// loading Electron, application startup, paid providers or real user services.
const file = fileURLToPath(
  new URL("../../../../packages/desktop/src/main/panel-app-bridge.ts", import.meta.url),
);
const source = readFileSync(file, "utf8");
const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
const declaration = parsed.statements.find(
  (node) => ts.isClassDeclaration(node) && node.name?.text === "PanelAppBridge",
)! as ts.ClassDeclaration;
const method = declaration.members.find(
  (node) => ts.isMethodDeclaration(node) && node.name.getText(parsed) === "bindGuest",
)!;
const compiled = ts.transpileModule(`class Bridge { ${method.getText(parsed)} }`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
// 0.9.33 bindGuest became async and rechecks the same owner/guest after awaits.
// Supply those VM globals and stable fixture identities; awaiting also supports
// the original synchronous baseline. Production code is unchanged.
const owner = { id: 1, isDestroyed: () => false };
const Bridge = runInNewContext(`${compiled}\nBridge`, {
  resolvePanelAppBindingProjectPath,
  BrowserWindow: { fromWebContents: () => owner },
  AbortController,
  PANEL_APP_API_VERSION: 14,
});
let fixtureRoot = "";
let root: any;
afterEach(async () => {
  await act(async () => {
    root?.unmount();
    await flushMicrotasks();
  });
  root = undefined;
  __setSessionWorkspaceServiceProjectStoreForTests(undefined);
  __setSessionWorkspaceServiceSessionManagerForTests(undefined);
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
  fixtureRoot = "";
});
function nodes(node: any): any[] {
  return Array.from(node?.childNodes ?? []).flatMap((child: any) => [child, ...nodes(child)]);
}
function props(node: any): any {
  const key = Object.keys(node).find((x) => x.startsWith("__reactProps$"));
  return key ? node[key] : {};
}
function texts(node: any): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(texts).join("");
  return node?.props ? texts(node.props.children) : "";
}

test("CONFIRMED valid secondary-root session cannot bind its project's installed Panel App", async () => {
  fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "codeshell-review-desktop-multiroot-")));
  const primary = join(fixtureRoot, "project-primary"),
    secondary = join(fixtureRoot, "project-secondary");
  mkdirSync(primary);
  mkdirSync(secondary);
  const sessionsRoot = join(fixtureRoot, "sessions"),
    sm = new SessionManager(sessionsRoot),
    index = new SessionCwdIndex({ sessionsRoot });
  await index.ensureLoaded();
  const store = new ProjectStore({
    file: join(fixtureRoot, "projects.json"),
    recentsFile: join(fixtureRoot, "recents.json"),
    migrationMarkerFile: join(fixtureRoot, "migration.json"),
    sessionIndex: index,
    sessionManager: sm,
    noRepoPath: join(fixtureRoot, "no-repo"),
  });
  const initial = await store.createFromPath(primary);
  const project = (await store.addRoot(initial.id, secondary)).project;
  const secondaryRoot = project.roots.find((r) => r.path === secondary)!;
  sm.create(primary, "fixture-model", "fixture-provider", "multi-root-session");
  sm.updateSessionState("multi-root-session", {
    project: { projectId: project.id, mainRootId: project.primaryRootId },
  });
  await store.migrateSessionMainRoot("multi-root-session", secondaryRoot.id);
  __setSessionWorkspaceServiceProjectStoreForTests(store);
  __setSessionWorkspaceServiceSessionManagerForTests(sm);
  const authority = await getSessionWorkspaceAuthorityForUi("multi-root-session");
  expect(authority.rootStatus).toBe("ok");
  expect(authority.projectId).toBe(project.id);
  expect(authority.workspace.root).toBe(secondary);

  const descriptor = {
    id: "panel-app:fixture-panel",
    appId: "fixture-panel",
    title: "Fixture",
    version: "1",
    icon: "puzzle",
    singleton: true,
    hostId: "fixture-host",
    revision: "fixture-revision",
    permissions: [],
  };
  const binding = {
    ownerWindowId: 1,
    resource: { descriptor },
    projectPath: primary,
    guest: { id: 42, isDestroyed: () => false, send() {} },
  };
  const bridge = new Bridge();
  bridge.guests = new Map([[42, binding]]);
  bridge.assertProjectBinding = () => {};
  bridge.assertTrustedHost = () => {};
  bridge.capabilitiesFor = () => ({});
  const input = {
    guestId: 42,
    appDescriptorId: descriptor.id,
    tabId: "fixture-tab",
    bucket: `${project.id}::multi-root-session`,
    sessionId: "multi-root-session",
    projectPath: primary,
    cwd: secondary,
  };
  // Same-project primary-root control succeeds; only the valid secondary-root
  // cwd triggers the real production rejection before any guest API runs.
  expect(await bridge.bindGuest({}, { ...input, cwd: primary })).toBe(true);
  await expect(Promise.resolve().then(() => bridge.bindGuest({}, input))).rejects.toThrow(
    "Panel App workspace does not belong to its bound project",
  );

  ensureMiniDom();
  Object.defineProperty(document.documentElement, "classList", {
    configurable: true,
    writable: true,
    value: { contains: () => false },
  });
  Object.defineProperty(HTMLElement.prototype, "getWebContentsId", {
    configurable: true,
    value: () => 42,
  });
  Object.defineProperty(window, "codeshell", {
    configurable: true,
    writable: true,
    value: {
      preparePanelApp: async () => ({
        id: descriptor.id,
        src: "cspanel://fixture/app/index.html",
        partition: "cspanel:fixture",
        revision: descriptor.revision,
      }),
      bindPanelApp: async (request) => bridge.bindGuest({}, request),
    },
  });
  const container = document.createElement("div");
  root = createRoot(container);
  await act(async () => {
    root.render(
      <PanelAppHost
        descriptor={descriptor as any}
        tabId="fixture-tab"
        bucket={input.bucket}
        projectPath={primary}
        cwd={authority.workspace.root}
        engineSessionId="multi-root-session"
        busy={false}
        modelKey={null}
        permissionMode="default"
        planMode={false}
        hasGoal={false}
        visible
      />,
    );
    await flushMicrotasks();
  });
  const view = nodes(container).find((node) => node.tagName === "WEBVIEW");
  expect(view).toBeDefined();
  await act(async () => {
    view.dispatchEvent(new Event("dom-ready"));
    await flushMicrotasks();
  });
  expect(nodes(container).some((node) => node.tagName === "WEBVIEW")).toBe(false);
  expect(
    nodes(container)
      .map((node) => texts(props(node).children))
      .join(" "),
  ).toContain("Panel App workspace does not belong to its bound project");
  console.log(
    JSON.stringify({
      projectId: project.id,
      primary,
      secondary,
      authorityStatus: authority.rootStatus,
      uiFailure: "Panel App workspace does not belong to its bound project",
    }),
  );
  delete (HTMLElement.prototype as any).getWebContentsId;
});
