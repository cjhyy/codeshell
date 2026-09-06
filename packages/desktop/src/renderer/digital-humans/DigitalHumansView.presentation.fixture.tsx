// Isolate real Radix navigation from renderer suites that mock shared primitives.
import assert from "node:assert/strict";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";

ensureMiniDom();
globalThis.requestAnimationFrame = (callback) =>
  setTimeout(() => callback(performance.now()), 0) as unknown as number;
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
const scenario = process.argv[2];
const en = scenario.endsWith("-en");
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: () => (en ? "en" : "zh"), setItem() {} },
});
const { DigitalHumansView } = await import("./DigitalHumansView");
const { DialogProvider } = await import("../ui/DialogProvider");
const repoCalls: string[] = [];
const profile = {
  name: "researcher",
  label: "Research Partner",
  description: "Find evidence",
  basePreset: "general",
  plugins: [],
  skills: [],
  mcp: [],
  agents: [],
  active: false,
  portableMemory: false,
};
Object.defineProperty(window, "codeshell", {
  configurable: true,
  value: {
    listProfiles: async () => [profile],
    listProfileCatalog: async () => [
      { ...profile, category: "engineering", tags: ["evidence"], installed: false },
    ],
    listDigitalHumanTeams: async () => [],
    listSkills: async () => [],
    listProfileRepos: async () => [],
    addProfileRepo: async (repo: string) => {
      repoCalls.push(repo);
      return { ok: false, error: "Source unavailable: " + "x".repeat(180) };
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
async function update(action: () => void) {
  await act(async () => {
    action();
    await flushMicrotasks();
  });
}
function find(test: (node: any) => boolean) {
  const node = nodes(container).find(test);
  assert.ok(node, "Expected rendered control");
  return node;
}
async function market() {
  const tab = find(
    (node) => props(node).role === "tab" && textOf(node).includes(en ? "Market" : "数字人广场"),
  );
  await update(() => props(tab).onMouseDown({ button: 0, ctrlKey: false, preventDefault() {} }));
  assert.equal(props(tab)["aria-selected"], true);
}
const container = document.createElement("div");
document.body.appendChild(container);
const root = createRoot(container);
try {
  await update(() =>
    root.render(
      <DialogProvider>
        <DigitalHumansView
          configurationTarget={{ noRepo: true }}
          projectName={null}
          onUse={() => {
            throw new Error("Unexpected apply");
          }}
        />
      </DialogProvider>,
    ),
  );
  assert.equal(nodes(container).filter((node) => node.tagName === "H1").length, 1);
  if (scenario.startsWith("search-")) {
    const search = find((node) => node.tagName === "INPUT" && props(node).type === "search");
    await update(() => props(search).onChange({ target: { value: "no-match" } }));
    assert.ok(textOf(container).includes(en ? "No matching results" : "没有匹配结果"));
    assert.ok(!nodes(container).some((node) => props(node)["data-digital-human-card"]));
    const clear = find(
      (node) => node.tagName === "BUTTON" && textOf(node) === (en ? "Clear search" : "清除搜索"),
    );
    assert.equal(props(clear).type, "button");
    await update(() => props(clear).onClick());
    assert.equal(props(search).value, "");
    assert.equal(document.activeElement, search);
    assert.ok(textOf(container).includes("Research Partner"));
    await update(() => props(search).onChange({ target: { value: "evidence" } }));
    await market();
    assert.equal(props(search).value, "evidence", "Tab navigation must preserve the filter");
    assert.ok(textOf(container).includes("Research Partner"), "Catalog tags remain searchable");
    const clearIcon = find(
      (node) => props(node)["aria-label"] === (en ? "Clear search" : "清除搜索"),
    );
    await update(() => props(clearIcon).onClick());
    assert.equal(document.activeElement, search);
    assert.equal(props(search).value, "");
    assert.deepEqual(repoCalls, []);
  } else if (scenario.startsWith("empty-market-")) {
    await market();
    const teams = find((node) => props(node)["data-testid"] === "digital-human-market-teams");
    assert.equal(props(teams)["aria-pressed"], false);
    await update(() => props(teams).onClick());
    assert.equal(props(teams)["aria-pressed"], true);
    assert.ok(textOf(container).includes(en ? "No teams in the market yet" : "广场中还没有团队"));
    assert.ok(!textOf(container).includes(en ? "No matching results" : "没有匹配结果"));
    const browse = nodes(container)
      .filter(
        (node) => node.tagName === "BUTTON" && textOf(node) === (en ? "Digital humans" : "数字人"),
      )
      .at(-1);
    assert.ok(browse);
    await update(() => props(browse).onClick());
    assert.equal(props(teams)["aria-pressed"], false);
    assert.ok(textOf(container).includes("Research Partner"));
    assert.deepEqual(repoCalls, []);
  } else if (scenario === "repo-input") {
    await market();
    const input = find((node) => props(node).placeholder === "owner/repo");
    await update(() => props(input).onChange({ target: { value: "wrong" } }));
    assert.equal(props(input)["aria-invalid"], true);
    const invalid = find((node) => props(node).id === props(input)["aria-describedby"]);
    assert.equal(props(invalid).role, "alert");
    await update(() => props(input).onChange({ target: { value: "owner/repo" } }));
    const enter = (extra = {}) =>
      update(() =>
        props(input).onKeyDown({
          key: "Enter",
          keyCode: 13,
          nativeEvent: { isComposing: false },
          preventDefault() {},
          ...extra,
        }),
      );
    await enter({ nativeEvent: { isComposing: true } });
    await enter({ keyCode: 229 });
    await update(() => props(input).onCompositionStart());
    await enter();
    assert.deepEqual(repoCalls, [], "IME confirmation must not add a source");
    await update(() => props(input).onCompositionEnd());
    await enter();
    assert.deepEqual(repoCalls, ["owner/repo"]);
    const feedback = find((node) => props(node).id === props(input)["aria-describedby"]);
    assert.equal(props(feedback).role, "alert");
    assert.ok(
      textOf(feedback).endsWith("x".repeat(180)),
      "Failures preserve the full actionable message",
    );
    assert.equal(props(input).value, "owner/repo", "Failed additions retain the input for retry");
    await update(() => props(input).onChange({ target: { value: "owner/other" } }));
    assert.equal(props(input)["aria-describedby"], undefined);
  } else throw new Error(`Unknown scenario: ${scenario}`);
} finally {
  await update(() => root.unmount());
  document.body.removeChild(container);
}
