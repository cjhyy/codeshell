import { afterEach, expect, test } from "bun:test";
import { readFileSync, mkdirSync, mkdtempSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { requireRendererProjectPath } from "../../../../packages/desktop/src/main/renderer-project-path";
import {
  replacePanelApps,
  getEnabledPanelEntries,
} from "../../../../packages/desktop/src/renderer/panels/PanelRegistry";

const base = await import("node:url").then(({ fileURLToPath }) =>
  fileURLToPath(new URL("../../../../", import.meta.url)),
);
function arrow(path: string, predicate: (node: ts.CallExpression) => boolean): string {
  const parsed = ts.createSourceFile(
    path,
    readFileSync(base + path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let found: ts.CallExpression | undefined;
  function walk(node: ts.Node) {
    if (ts.isCallExpression(node) && predicate(node)) found = node;
    ts.forEachChild(node, walk);
  }
  walk(parsed);
  if (!found) throw new Error("production callback not found: " + path);
  return found.arguments.find((arg) => ts.isArrowFunction(arg))!.getText(parsed);
}
const backend = arrow(
  "packages/desktop/src/main/project-panel-ipc.ts",
  (node) => node.arguments[0]?.getText() === '"panel-apps:listForProjects"',
);
const frontend = arrow(
  "packages/desktop/src/renderer/App.tsx",
  (node) =>
    node.expression.getText() === "useEffect" &&
    node.arguments[0]?.getText().includes("const applyPanelApps ="),
);
function evaluate(callback: string, context: Record<string, unknown>): any {
  const compiled = ts.transpileModule(`const callback = ${callback};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return runInNewContext(compiled + "\ncallback", context);
}
let root = "";
afterEach(() => {
  replacePanelApps([], null);
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});
const descriptor = {
  id: "panel-app:fixture-panel",
  appId: "fixture-panel",
  title: "Fixture",
  version: "1",
  icon: "puzzle",
  singleton: true,
  hostId: "fixture-host",
  revision: "r1",
  permissions: [],
};
async function runCase(count: number, missing: boolean) {
  root = realpathSync(mkdtempSync(join(tmpdir(), "codeshell-review-panel-batch-")));
  const paths = Array.from({ length: count }, (_, i) => join(root, "project-" + i));
  for (const [index, path] of paths.entries()) {
    if (!missing || index !== count - 1) mkdirSync(path);
  }
  const current = paths[0]!;
  let discovered = 0,
    failure = "";
  const list = evaluate(backend, {
    requireRendererProjectPath: (path: string) =>
      requireRendererProjectPath(path, {
        registeredPaths: paths,
        noRepoPath: join(root, "no-repo"),
      }),
    listPanelAppsForProjects: async () => {
      discovered++;
      return {
        descriptors: [{ ...descriptor, projectPaths: [current] }],
        boundProjectPathsByAppId: { "fixture-panel": [current] },
      };
    },
  });
  const cleanup = evaluate(frontend, {
    projects: paths.map((path) => ({ path })),
    loadProjects: () => paths.map((path) => ({ path })),
    activeProject: { path: current },
    lang: "zh",
    replacePanelApps,
    window: {
      codeshell: {
        listPanelApps: async () => [],
        onPanelAppsChanged: () => () => {},
        listPanelAppsForProjects: async (...args: any[]) => {
          try {
            return await list({}, ...args);
          } catch (error) {
            failure = String(error);
            throw error;
          }
        },
      },
    },
  })();
  for (let i = 0; i < 40; i++) await new Promise((resolve) => setTimeout(resolve, 1));
  const visible = getEnabledPanelEntries({
    projectPath: current,
    cwd: current,
    engineSessionId: null,
  }).some((entry) => entry.key === descriptor.id);
  cleanup();
  return { visible, discovered, failure };
}
test("CONTROL healthy tracked projects expose current project's bound Panel", async () => {
  expect(await runCase(2, false)).toEqual({ visible: true, discovered: 1, failure: "" });
});
test("CONFIRMED one unrelated missing tracked project removes every healthy project's Panels", async () => {
  const result = await runCase(2, true);
  expect(result.visible).toBe(false);
  expect(result.discovered).toBe(0);
  expect(result.failure).toContain("project path must be an existing absolute directory");
  console.log(JSON.stringify({ case: "one unrelated missing root", ...result }));
});
test("CONFIRMED 65 supported tracked projects also remove all Panels before discovery", async () => {
  const result = await runCase(65, false);
  expect(result.visible).toBe(false);
  expect(result.discovered).toBe(0);
  expect(result.failure).toContain("panel-apps:listForProjects requires projectPaths");
  console.log(JSON.stringify({ case: "65 healthy roots", ...result }));
});
