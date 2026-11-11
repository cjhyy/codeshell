import assert from "node:assert/strict";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";

ensureMiniDom();
const scenario = process.argv[2];
let deniedFetches = 0;
globalThis.fetch = (async () => {
  deniedFetches += 1;
  throw new Error("No network allowed in this fixture");
}) as unknown as typeof fetch;
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: () => "zh", setItem() {} },
});
const { SessionDefaultModelSelector } = await import("./SessionDefaultModelSelector");
const { saveProjects } = await import("../projects");
saveProjects([
  {
    id: "fixture-project",
    name: "Fixture project",
    path: "/tmp/fixture-project",
    roots: [
      { id: "fixture-root", name: "Fixture project", path: "/tmp/fixture-project", addedAt: 1 },
    ],
    primaryRootId: "fixture-root",
    addedAt: 1,
  },
]);
const modelKey = "codex/gpt-6.1-sol";
let stored: Record<string, any> = {
  defaults: { text: "api-model", auxText: "aux-model" },
  modelConnections: [{ id: "api-model", catalogId: "fixture-api", tag: "text", model: "api-1" }],
  ...(scenario === "unavailable" || scenario === "reset"
    ? { sessionDefaults: { model: modelKey } }
    : {}),
};
const writes: Array<{ scope: string; patch: Record<string, any>; target?: unknown }> = [];
let projectStored: Record<string, any> = {};
const write = async (scope: string, patch: Record<string, any>, target?: unknown) => {
  writes.push({ scope, patch: structuredClone(patch), target });
  if (scenario === "write-failure") throw new Error("synthetic storage failure");
  const next = {
    ...(scope === "project" ? projectStored : stored),
    sessionDefaults: patch.sessionDefaults?.model === null ? {} : patch.sessionDefaults,
  };
  if (scope === "project") projectStored = next;
  else stored = next;
};
Object.defineProperty(window, "codeshell", {
  configurable: true,
  value: {
    getSettings: async () => structuredClone(stored),
    getConfigurationSettings: async () => structuredClone(projectStored),
    updateSettings: (scope: string, patch: Record<string, any>) => write(scope, patch),
    updateConfigurationSettings: (target: unknown, patch: Record<string, any>) =>
      write("project", patch, target),
    getModelCatalog: async () => [
      {
        id: "fixture-api",
        displayName: "Fixture API",
        tag: "text",
        modelPresets: [{ value: "api-1", label: "API 1" }],
      },
    ],
    externalRuntime: {
      models: async () =>
        scenario === "unavailable"
          ? []
          : [
              {
                key: modelKey,
                label: "Codex · GPT-6.1 Sol",
                provider: "codex",
                kind: "codex",
                maxContextTokens: 1_000_000,
              },
            ],
    },
  },
});
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
const container = document.createElement("div");
document.body.appendChild(container);
const root = createRoot(container);
const scope = scenario === "project" ? "project" : "user";
await act(async () => {
  root.render(
    <SessionDefaultModelSelector scope={scope} activeProjectPath="/tmp/fixture-project" />,
  );
  await flushMicrotasks();
});
function select() {
  const node = nodes(container).find(
    (node) => node.tagName === "SELECT" && props(node).name === "session-default-model",
  );
  assert.ok(node, "The model selector must expose its current value");
  return node;
}
function optionValues() {
  return nodes(select())
    .filter((node) => node.tagName === "OPTION")
    .map((node) => props(node).value);
}
assert.ok(textOf(container).includes(scope === "project" ? "全局新会话默认" : "微信和 Mimi"));
assert.ok(optionValues().includes("api-model"), "Configured API models remain available");
if (scenario === "unavailable") {
  assert.equal(props(select()).value, modelKey);
  assert.ok(
    optionValues().includes(modelKey),
    "Unavailable saved default is retained as a visible option",
  );
  assert.ok(textOf(container).includes("当前不可用"));
  assert.equal(writes.length, 0, "Discovery cannot replace a saved choice");
} else {
  assert.ok(optionValues().includes(modelKey), "External runtime models are selectable");
  const value = scenario === "reset" ? "" : modelKey;
  await act(async () => {
    props(select()).onChange({ target: { value } });
    await flushMicrotasks();
  });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].scope, scope);
  assert.deepEqual(writes[0].patch, { sessionDefaults: { model: value || null } });
  assert.deepEqual(stored.defaults, { text: "api-model", auxText: "aux-model" });
  if (scope === "project") {
    assert.deepEqual(writes[0].target, { projectId: "fixture-project" });
  }
  if (scenario === "write-failure") {
    assert.equal(props(select()).value, "", "A failed save keeps the last persisted choice");
    assert.ok(textOf(container).includes("读取或保存失败"));
  } else {
    assert.equal(props(select()).value, value);
    await act(async () => {
      window.dispatchEvent(new Event("codeshell:settings-changed"));
      await flushMicrotasks();
    });
    assert.equal(props(select()).value, value, "Reload inherits the persisted default");
  }
}
await act(async () => root.unmount());
document.body.removeChild(container);
assert.equal(deniedFetches, 0);
process.stdout.write(JSON.stringify({ scenario, passed: true, deniedFetches }));
