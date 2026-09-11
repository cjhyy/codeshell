// Isolate real Radix navigation from renderer suites that mock shared primitives.
import assert from "node:assert/strict";
import { mock } from "bun:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";

ensureMiniDom();
globalThis.requestAnimationFrame = (callback) =>
  setTimeout(() => callback(performance.now()), 0) as unknown as number;
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
const scenario = process.argv[2];
let editorProps:
  | React.ComponentProps<typeof import("./DigitalHumanEditorDialog").DigitalHumanEditorDialog>
  | undefined;
if (scenario === "save-target-switch" || scenario.startsWith("settings-")) {
  mock.module("./DigitalHumanEditorDialog", () => ({
    DigitalHumanEditorDialog: (props: NonNullable<typeof editorProps>) => {
      editorProps = props;
      return null;
    },
  }));
}
const en = scenario.endsWith("-en");
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: () => (en ? "en" : "zh"), setItem() {} },
});
const { DigitalHumansView } = await import("./DigitalHumansView");
const { DigitalHumansSection } = await import("../settings/DigitalHumansSection");
const { DialogProvider } = await import("../ui/DialogProvider");
const { I18nProvider } = await import("../i18n/I18nProvider");
const repoCalls: string[] = [];
const requirementCalls: unknown[] = [];
const activations: unknown[] = [];
const selections: unknown[] = [];
let completeRequirementCheck!: () => void;
const pendingRequirementCheck = new Promise<void>((resolve) => {
  completeRequirementCheck = resolve;
});
let completeSave!: () => void;
const pendingSave = new Promise<void>((resolve) => {
  completeSave = resolve;
});
let completeOldProfiles!: (profiles: any[]) => void;
const oldProfiles = new Promise<any[]>((resolve) => {
  completeOldProfiles = resolve;
});
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
    listProfiles: async (target: { projectId?: string }) => {
      if (scenario !== "settings-stale-list") return [profile];
      return target.projectId === "project-a" ? oldProfiles : [{ ...profile, label: "Project B" }];
    },
    listProfileCatalog: async () => [
      { ...profile, category: "engineering", tags: ["evidence"], installed: false },
    ],
    listDigitalHumanTeams: async () => [],
    listSkills: async (target: { projectId?: string }) => {
      if (scenario !== "settings-failed-target-skills") return [];
      if (target.projectId !== "project-a") throw new Error("Project B skills unavailable");
      return [{ name: "only-in-project-a", description: "", source: "project" }];
    },
    getSettings: async () => ({}),
    listProfileRepos: async () => [],
    saveProfile: () => pendingSave,
    previewProfileRequirements: async (...args: unknown[]) => {
      requirementCalls.push(args);
      if (["start-target-switch", "default-target-switch"].includes(scenario))
        await pendingRequirementCheck;
      return { needsInstall: false, willRun: [], warnings: [], blockers: [] };
    },
    activateProfile: async (...args: unknown[]) => {
      activations.push(args);
    },
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
function profileCardProps() {
  const card = find((node) => props(node)["data-digital-human-card"]);
  const fiberKey = Object.keys(card).find((key) => key.startsWith("__reactFiber$"));
  let fiber = fiberKey ? card[fiberKey] : undefined;
  while (fiber && !fiber.memoizedProps?.onEdit) fiber = fiber.return;
  assert.ok(fiber?.memoizedProps.onEdit);
  return fiber.memoizedProps;
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
let configurationTarget: import("../../preload/types").RendererConfigurationTarget =
  scenario.endsWith("target-switch") || scenario.startsWith("settings-")
    ? { projectId: "project-a" }
    : { noRepo: true };
const render = () =>
  update(() =>
    root.render(
      <I18nProvider>
        <DialogProvider>
          {scenario.startsWith("settings-") ? (
            <DigitalHumansSection
              scope="user"
              projectPath="/repo"
              configurationTarget={configurationTarget}
            />
          ) : (
            <DigitalHumansView
              configurationTarget={configurationTarget}
              projectName={null}
              onUse={(selection) => {
                selections.push(selection);
              }}
            />
          )}
        </DialogProvider>
      </I18nProvider>,
    ),
  );
try {
  await render();
  if (!scenario.startsWith("settings-"))
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
  } else if (scenario.endsWith("save-target-switch")) {
    if (scenario.startsWith("settings-")) {
      const edit = find((node) => node.tagName === "BUTTON" && textOf(node) === "编辑");
      await update(() => props(edit).onClick());
    } else {
      await update(() => profileCardProps().onEdit());
    }
    assert.equal(editorProps?.open, true);
    await update(() =>
      editorProps?.onSave(
        { ...profile, exclusiveCapabilities: false },
        { installRequirements: true },
      ),
    );
    configurationTarget = { projectId: "project-b" };
    await render();
    await update(() => completeSave());
    assert.deepEqual(
      requirementCalls,
      [],
      "Saving in A must not start its dependency install after switching to B",
    );
    assert.equal(editorProps?.open, true, "An old save cannot close the editor in the new project");
    assert.equal(editorProps?.busy, false);
  } else if (scenario === "settings-stale-list") {
    configurationTarget = { projectId: "project-b" };
    await render();
    assert.ok(textOf(container).includes("Project B"));
    await update(() => completeOldProfiles([{ ...profile, label: "Project A" }]));
    assert.ok(
      textOf(container).includes("Project B"),
      "An old settings load cannot replace the current project data",
    );
    assert.ok(!textOf(container).includes("Project A"));
  } else if (scenario === "settings-failed-target-skills") {
    assert.equal(editorProps?.projectSkills?.length, 1);
    configurationTarget = { projectId: "project-b" };
    await render();
    assert.deepEqual(
      editorProps?.projectSkills,
      [],
      "A failed project B load cannot keep project A's installed skills",
    );
  } else if (["start-target-switch", "default-target-switch"].includes(scenario)) {
    await update(() =>
      profileCardProps()[scenario === "start-target-switch" ? "onUse" : "onToggleDefault"](),
    );
    assert.equal(requirementCalls.length, 1);
    configurationTarget = { projectId: "project-b" };
    await render();
    await update(() => completeRequirementCheck());
    assert.deepEqual(activations, [], "An old dependency check cannot activate a project default");
    assert.deepEqual(selections, [], "An old dependency check cannot start work in a new project");
  } else if (scenario === "settings-repo-input") {
    const input = find((node) => String(props(node).placeholder ?? "").includes("owner/repo"));
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
    assert.deepEqual(repoCalls, [], "IME confirmation must not clone a digital-human source");
    await update(() => props(input).onCompositionStart());
    await enter();
    assert.deepEqual(repoCalls, []);
    await update(() => props(input).onCompositionEnd());
    await enter();
    assert.deepEqual(repoCalls, ["owner/repo"]);
    assert.equal(props(input).value, "owner/repo", "A failed clone retains its source for retry");
  } else throw new Error(`Unknown scenario: ${scenario}`);
} finally {
  await update(() => root.unmount());
  document.body.removeChild(container);
}
