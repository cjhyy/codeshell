// Child-process isolation keeps shared dialog mocks out of other renderer tests.
import assert from "node:assert/strict";
import { mock } from "bun:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";

ensureMiniDom();
const scenario = process.argv[2];
const writes: unknown[][] = [];
const unhandled: string[] = [];
process.on("unhandledRejection", (reason) => unhandled.push(String(reason)));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const confirmation = deferred<boolean>();
const pendingRead = deferred<Record<string, unknown>>();
const pendingWrite = deferred<void>();
const server = (name: string) => ({
  [name]: {
    command: "fixture-tool",
    source: "settings",
    editable: true,
    ...(scenario === "disabled-save" ? { enabled: false } : {}),
  },
});
let projectPath = "/fixture/project-a";
let writesFail = scenario === "save-error";
const mergedTargets: unknown[] = [];
const hasServers = [
  "stale-confirmation",
  "stale-load",
  "editor-switch",
  "probe-error",
  "patch-only-edited",
  "rename",
  "disabled-save",
  "toggle-only-enabled",
].includes(scenario);
const t = (key: string) => key;
mock.module("../i18n/I18nProvider", () => ({ useT: () => ({ t }) }));
mock.module("../ui/ConfirmDialog", () => ({
  useConfirm: () => () =>
    scenario === "stale-confirmation" ? confirmation.promise : Promise.resolve(true),
  truncateTitle: (s: string) => s,
}));
mock.module("../ui/ToastProvider", () => ({ useToast: () => () => {} }));
mock.module("../settingsAuthority", () => ({
  readScopedSettings: async (_scope: string, path: string) => {
    if (scenario === "stale-load" && path.endsWith("project-a")) return pendingRead.promise;
    return {
      mcpServers: hasServers ? server(path.endsWith("project-a") ? "server-a" : "server-b") : {},
    };
  },
  updateScopedSettings: async (...args: unknown[]) => {
    writes.push(args);
    if (writesFail) throw new Error("fixture settings write failed");
    if (["save-lock", "stale-save"].includes(scenario)) await pendingWrite.promise;
  },
}));
mock.module("../configurationTarget", () => ({
  optionalProjectConfigurationTarget: (path: string) => (path ? { projectId: path } : null),
}));
Object.assign(window, {
  codeshell: {
    listMergedMcpServers: async (value: unknown, _disabled: unknown, target: unknown) => {
      mergedTargets.push(target);
      return scenario === "editor-switch"
        ? { ...server("server-a"), ...server("server-b") }
        : value;
    },
    listPluginMcpTrust: async () => [],
    invalidateMcpProbeCache: async () => {},
    probeMcpServers: async (inputs: Array<{ name: string }>, force: boolean) => {
      if (scenario === "probe-error" && force) throw new Error("fixture probe failed");
      return inputs.map(({ name }) => ({ name, status: "connected", tools: [] }));
    },
    credentials: {
      list: async () => {
        if (scenario === "credentials-error") throw new Error("fixture credentials unavailable");
        return [];
      },
    },
  },
});
const { McpSection } = await import("./McpSection");
const container = document.createElement("div");
document.body.appendChild(container);
const root = createRoot(container);
function nodes(node: any): any[] {
  return [node, ...Array.from(node.childNodes ?? []).flatMap(nodes)];
}
function props(node: any): Record<string, any> {
  const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
  return key ? node[key] : {};
}
function textOf(node: any): string {
  if (node.nodeType === 3) return node.data ?? node.textContent ?? "";
  const children = Array.from(node.childNodes ?? []);
  return children.length ? children.map(textOf).join("") : (node.textContent ?? "");
}
function find(test: (node: any) => boolean) {
  const node = nodes(container).find(test);
  assert.ok(node, "expected control");
  return node;
}
async function update(action: () => void) {
  await act(async () => {
    action();
    await flushMicrotasks();
    await flushMicrotasks();
  });
}
async function click(text: string) {
  await update(() => props(find((n) => n.tagName === "BUTTON" && textOf(n) === text)).onClick());
}
async function render() {
  await update(() =>
    root.render(
      <McpSection scope="project" activeProjectPath={null} settingsProjectPath={projectPath} />,
    ),
  );
}
async function fillDraft() {
  await click("settingsX.mcp.addServer");
  const inputs = nodes(container).filter((n) => n.tagName === "INPUT");
  await update(() =>
    props(inputs.find((n) => props(n).placeholder === "my-server")).onChange({
      target: { value: "project-a-private-server" },
    }),
  );
  await update(() => props(inputs[1]).onChange({ target: { value: "fixture-tool" } }));
}
try {
  await render();
  if (scenario === "credentials-error") {
    await click("settingsX.mcp.addServer");
    assert.ok(textOf(container).includes("fixture credentials unavailable"));
    assert.ok(nodes(container).some((n) => props(n).role === "alert"));
  } else if (scenario === "target-switch") {
    await fillDraft();
    projectPath = "/fixture/project-b";
    await render();
    assert.equal(
      nodes(container).filter((n) => n.tagName === "INPUT").length,
      0,
      "Old project draft must close",
    );
    await click("settingsX.mcp.addServer");
    assert.equal(
      props(find((n) => n.tagName === "INPUT" && props(n).placeholder === "my-server")).value,
      "",
    );
    assert.equal(writes.length, 0);
  } else if (scenario === "stale-confirmation") {
    await update(() =>
      props(
        find((n) => n.tagName === "BUTTON" && props(n).title === "settingsX.mcp.delete"),
      ).onClick(),
    );
    projectPath = "/fixture/project-b";
    await render();
    await update(() => confirmation.resolve(true));
    assert.equal(writes.length, 0, "A stale confirmation must not mutate either project");
    assert.ok(textOf(container).includes("server-b"));
  } else if (scenario === "stale-load") {
    projectPath = "/fixture/project-b";
    await render();
    await update(() => pendingRead.resolve({ mcpServers: server("server-a") }));
    assert.ok(textOf(container).includes("server-b"));
    assert.ok(!textOf(container).includes("server-a"));
    assert.deepEqual(mergedTargets, [{ projectId: "/fixture/project-b" }]);
  } else if (scenario === "save-error") {
    await fillDraft();
    await click("settingsX.mcp.add");
    assert.equal(writes.length, 1);
    assert.ok(textOf(container).includes("fixture settings write failed"));
    assert.equal(
      props(find((n) => n.tagName === "INPUT" && props(n).placeholder === "my-server")).value,
      "project-a-private-server",
    );
    writesFail = false;
    await click("settingsX.mcp.add");
    assert.equal(writes.length, 2, "Failed writes remain retryable");
  } else if (scenario === "save-lock") {
    await fillDraft();
    const submit = props(
      find((n) => n.tagName === "BUTTON" && textOf(n) === "settingsX.mcp.add"),
    ).onClick;
    await update(() => {
      submit();
      submit();
    });
    assert.equal(writes.length, 1, "Same-frame double-click can write only once");
    await update(() => pendingWrite.resolve());
    assert.equal(nodes(container).filter((n) => n.tagName === "INPUT").length, 0);
  } else if (scenario === "stale-save") {
    await fillDraft();
    await click("settingsX.mcp.add");
    await click("settingsX.mcp.close");
    await click("settingsX.mcp.addServer");
    await update(() => pendingWrite.resolve());
    assert.equal(
      props(find((n) => n.tagName === "INPUT" && props(n).placeholder === "my-server")).value,
      "",
      "An old save must not close a newly opened editor",
    );
  } else if (scenario === "patch-only-edited") {
    await fillDraft();
    await click("settingsX.mcp.add");
    assert.deepEqual(
      Object.keys((writes[0][1] as any).mcpServers),
      ["project-a-private-server"],
      "An edit must not replay stale sibling configs",
    );
  } else if (scenario === "editor-switch") {
    const edits = nodes(container).filter(
      (n) => n.tagName === "BUTTON" && props(n).title === "settingsX.mcp.edit",
    );
    await update(() => props(edits[0]).onClick());
    assert.equal(
      props(find((n) => n.tagName === "INPUT" && props(n).placeholder === "my-server")).value,
      "server-a",
    );
    await update(() => props(edits[1]).onClick());
    assert.equal(
      props(find((n) => n.tagName === "INPUT" && props(n).placeholder === "my-server")).value,
      "server-b",
    );
  } else if (scenario === "toggle-only-enabled") {
    await update(() =>
      props(find((n) => props(n).role === "switch")).onClick({
        defaultPrevented: false,
        stopPropagation() {},
      }),
    );
    assert.deepEqual(
      writes[0][1],
      { mcpServers: { "server-a": { enabled: false } } },
      "A toggle cannot overwrite concurrently edited configuration",
    );
  } else if (scenario === "disabled-save") {
    await click("settingsX.mcp.edit");
    await click("settingsX.mcp.save");
    assert.equal(
      (writes[0][1] as any).mcpServers["server-a"].enabled,
      false,
      "Editing an inactive server must not enable it",
    );
  } else if (scenario === "rename") {
    await click("settingsX.mcp.edit");
    await update(() =>
      props(find((n) => n.tagName === "INPUT" && props(n).placeholder === "my-server")).onChange({
        target: { value: "renamed" },
      }),
    );
    await click("settingsX.mcp.save");
    assert.equal(writes.length, 1, "Renaming must remain one atomic settings patch");
    const patch = (writes[0][1] as any).mcpServers;
    assert.deepEqual(Object.keys(patch).sort(), ["renamed", "server-a"]);
    assert.equal(patch["server-a"], null);
    assert.equal(patch.renamed.command, "fixture-tool");
  } else if (scenario === "probe-error") {
    await click("settingsX.mcp.test");
    assert.ok(textOf(container).includes("fixture probe failed"));
  } else throw new Error(`Unknown scenario: ${scenario}`);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(unhandled, [], "Async failures must be handled in the UI");
} finally {
  await update(() => root.unmount());
  document.body.removeChild(container);
}
