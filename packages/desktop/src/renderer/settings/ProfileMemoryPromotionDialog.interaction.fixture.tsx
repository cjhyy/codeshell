// Child-process isolation keeps dialog/widget mocks out of other renderer tests.
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { mock } from "bun:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { MemoryLevel, RendererMemoryEntryFull } from "../../preload/types";
import type {
  PreviewProfileMemoryPromotionInput,
  ProfileMemoryPromotionReview,
} from "../../shared/profile-memory-promotion";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";

let denied = 0;
const deny = () => {
  denied++;
  throw new Error("Memory promotion interaction fixture denies HTTP");
};
globalThis.fetch = deny as typeof fetch;
http.request = deny as typeof http.request;
http.get = deny as typeof http.get;
https.request = deny as typeof https.request;
https.get = deny as typeof https.get;
syncBuiltinESMExports();
for (const probe of [
  () => fetch("http://127.0.0.1:9/deny"),
  () => http.request("http://127.0.0.1:9/deny"),
  () => http.get("http://127.0.0.1:9/deny"),
  () => https.request("https://127.0.0.1:9/deny"),
  () => https.get("https://127.0.0.1:9/deny"),
]) assert.throws(probe, /denies HTTP/);
assert.equal(denied, 5);
denied = 0;
assert.equal(process.env.NODE_ENV, "test");
assert.ok(process.env.HOME && process.env.CODE_SHELL_TEST_HOME?.startsWith(process.env.HOME));

ensureMiniDom();
const scenario = process.argv[2];
const unhandled: string[] = [];
process.on("unhandledRejection", (reason) => unhandled.push(String(reason)));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const profiles = [
  { name: "researcher", label: "Research Partner", portableMemory: false },
  { name: "writer", label: "Writing Partner", portableMemory: true },
];
const pendingProfiles = deferred<typeof profiles>();
const pendingPreview = deferred<ProfileMemoryPromotionReview>();
const pendingConfirmation = deferred<boolean>();
const pendingCommit = deferred<{ profileName: string; id: string; fileName: string }>();
const profileCalls: unknown[] = [];
const previewCalls: PreviewProfileMemoryPromotionInput[] = [];
const commitCalls: unknown[] = [];
const confirmations: Array<{ detail?: string; confirmLabel?: string }> = [];
const otherWrites: unknown[] = [];
const { translate } = await import("../i18n/translate");
const t = (key: any, parameters?: any) => translate("zh", key, parameters);
mock.module("../i18n/I18nProvider", () => ({ useT: () => ({ t, lang: "zh" }) }));
mock.module("../ui/ConfirmDialog", () => ({
  useConfirm: () => async (options: { detail?: string }) => {
    confirmations.push(options);
    if (["stale-confirmation-scope", "source-switch", "commit-lock"].includes(scenario)) {
      return pendingConfirmation.promise;
    }
    return scenario !== "cancel-review";
  },
}));
const passthrough = ({ children }: any) => <div>{children}</div>;
mock.module("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: any) => open ? <div role="dialog">{children}</div> : null,
  DialogContent: passthrough,
  DialogHeader: passthrough,
  DialogTitle: passthrough,
  DialogDescription: passthrough,
}));
mock.module("@/components/ui/simple-select", () => ({
  SimpleSelect: ({ value, options, onChange, disabled, ariaLabel }: any) => (
    <select aria-label={ariaLabel} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
      <option value="">Choose</option>
      {options.map((option: any) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  ),
}));
mock.module("@/components/ui/checkbox", () => ({
  Checkbox: ({ checked, onCheckedChange, disabled }: any) => (
    <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onCheckedChange(event.target.checked)} />
  ),
}));

let cwd = "/fixture/project-a";
let level: MemoryLevel = "project";
let conflict = scenario === "rename-after-conflict";
function entry(project: string | undefined, scope: string, second = false): RendererMemoryEntryFull {
  return {
    id: `mem-${project?.endsWith("project-b") ? "b" : "a"}-${scope}${second ? "-second" : ""}`,
    name: second ? "Second memory" : `Source ${project ?? "global"} ${scope}`,
    description: "Original description",
    type: "project",
    content: "Original body\nSecond original line",
    scope: scope as "user" | "dream",
    level,
    fileName: second ? "second.md" : "source.md",
    origin: scope === "dream" ? "dream" : "manual",
    pinned: false,
  };
}
function review(input: PreviewProfileMemoryPromotionInput): ProfileMemoryPromotionReview {
  const original = entry(input.cwd, input.source.scope);
  const target = profiles.find((profile) => profile.name === input.profileName)!;
  return {
    reviewId: `review-${previewCalls.length}`,
    expiresAt: Date.now() + 300_000,
    source: { id: input.source.id, scope: input.source.scope, name: original.name, description: original.description, type: original.type, content: original.content },
    target: { profileName: target.name, label: target.label, portableMemory: target.portableMemory },
    draft: { ...input.draft },
  };
}
Object.assign(window, {
  codeshell: {
    listMemory: async (_level: string, scope: string, project: string | undefined) => [entry(project, scope), entry(project, scope, true)],
    readMemory: async (_level: string, scope: string, name: string, project: string | undefined) => entry(project, scope, name === "Second memory"),
    getSettings: async () => ({}),
    listPendingMemory: async () => [],
    listProfiles: async (target: unknown) => {
      profileCalls.push(target);
      return scenario === "stale-profile-list" && profileCalls.length === 1 ? pendingProfiles.promise : profiles;
    },
    previewProfileMemoryPromotion: async (input: PreviewProfileMemoryPromotionInput) => {
      previewCalls.push(structuredClone(input));
      if (["cancel-pending-preview", "stale-preview-project", "preview-lock"].includes(scenario) && previewCalls.length === 1) return pendingPreview.promise;
      if (conflict) throw new Error("A memory with this name already exists");
      return review(input);
    },
    commitProfileMemoryPromotion: async (input: { cwd: string; reviewId: string }) => {
      commitCalls.push(input);
      if (scenario === "commit-lock") return pendingCommit.promise;
      return { profileName: previewCalls.at(-1)!.profileName, id: "mem-copy", fileName: "copy.md" };
    },
    saveMemory: async (...args: unknown[]) => { otherWrites.push(args); },
    deleteMemory: async (...args: unknown[]) => { otherWrites.push(args); },
    activateProfile: async (...args: unknown[]) => { otherWrites.push(args); },
  },
});
const { saveProjects } = await import("../projects");
saveProjects(["a", "b"].map((suffix) => ({
  id: `project-${suffix}`,
  name: `Project ${suffix}`,
  path: `/fixture/project-${suffix}`,
  primaryRootId: `root-${suffix}`,
  roots: [{ id: `root-${suffix}`, path: `/fixture/project-${suffix}`, name: `Root ${suffix}`, addedAt: 1 }],
  addedAt: 1,
})));
const { MemoryStoreView } = await import("./MemorySection");
const container = document.createElement("div");
document.body.appendChild(container);
const root = createRoot(container);
const nodes = (node: any): any[] => [node, ...Array.from(node.childNodes ?? []).flatMap(nodes)];
function props(node: any): Record<string, any> {
  const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
  return key ? node[key] : {};
}
function textOf(node: any): string {
  if (node.nodeType === 3) return node.data ?? node.textContent ?? "";
  const children = Array.from(node.childNodes ?? []);
  return children.length ? children.map(textOf).join("") : node.textContent ?? "";
}
function find(predicate: (node: any) => boolean) {
  const node = nodes(container).find(predicate);
  assert.ok(node, "Expected rendered control");
  return node;
}
function button(text: string) { return find((node) => node.tagName === "BUTTON" && textOf(node) === text); }
async function update(action: () => void) {
  await act(async () => { action(); await flushMicrotasks(); await flushMicrotasks(); });
}
async function click(text: string) { await update(() => props(button(text)).onClick()); }
async function render() {
  await update(() => root.render(<MemoryStoreView level={level} cwd={level === "project" ? cwd : undefined} profileName={level === "profile" ? "writer" : undefined} />));
}
async function openSource(dream = false) {
  if (dream) await click("自动整理");
  await update(() => props(find((node) => node.tagName === "BUTTON" && textOf(node).startsWith("Source "))).onClick());
}
async function openCopy(dream = false) { await openSource(dream); await click("复制到数字人"); }
async function selectTarget(name = "researcher") {
  await update(() => props(find((node) => node.tagName === "SELECT" && props(node)["aria-label"] === "目标数字人")).onChange({ target: { value: name } }));
}
async function editDraft() {
  const inputs = nodes(container).filter((node) => node.tagName === "INPUT" && props(node).type !== "checkbox");
  await update(() => props(inputs[0]).onChange({ target: { value: "Reusable lesson" } }));
  await update(() => props(inputs[1]).onChange({ target: { value: "Reviewed description" } }));
  await update(() => props(find((node) => node.tagName === "SELECT" && props(node)["aria-label"] === "记忆类型")).onChange({ target: { value: "reference" } }));
  await update(() => props(find((node) => node.tagName === "TEXTAREA")).onChange({ target: { value: "Reviewed full body\nLast reviewed line" } }));
  await update(() => props(find((node) => node.tagName === "INPUT" && props(node).type === "checkbox")).onChange({ target: { checked: true } }));
}
try {
  await render();
  if (scenario === "entrypoint-scope") {
    await openSource();
    assert.ok(button("复制到数字人"));
    for (const next of ["user", "profile"] as const) {
      level = next; await render(); await openSource();
      assert.ok(!nodes(container).some((node) => node.tagName === "BUTTON" && textOf(node) === "复制到数字人"));
    }
    assert.equal(profileCalls.length, 0);
  } else {
    await openCopy(scenario === "project-dream-copy");
    assert.deepEqual(profileCalls[0], { projectId: "project-a" });
    assert.equal(previewCalls.length, 0, "Opening the editor does not create a review or write");
    if (scenario === "stale-profile-list") {
      cwd = "/fixture/project-b"; await render(); await openCopy();
      await update(() => pendingProfiles.resolve([{ name: "old-profile", label: "Old profile", portableMemory: true }]));
      assert.ok(!textOf(container).includes("Old profile"));
      assert.deepEqual(profileCalls, [{ projectId: "project-a" }, { projectId: "project-b" }]);
      assert.equal(commitCalls.length, 0);
    } else {
      await selectTarget();
      assert.ok(textOf(container).includes("不会自动使用，也不会启用开关"));
      if (["project-user-copy", "project-dream-copy"].includes(scenario)) {
        await editDraft(); await click("审阅复制");
        assert.deepEqual(previewCalls, [{ cwd, source: { id: scenario === "project-dream-copy" ? "mem-a-dream" : "mem-a-user", scope: scenario === "project-dream-copy" ? "dream" : "user" }, profileName: "researcher", draft: { name: "Reusable lesson", description: "Reviewed description", type: "reference", content: "Reviewed full body\nLast reviewed line", pinned: true } }]);
        assert.deepEqual(commitCalls, [{ cwd, reviewId: "review-1" }]);
        assert.equal(confirmations.length, 1);
        for (const content of ["Research Partner", "researcher", "Reusable lesson", "Reviewed description", "Reviewed full body\nLast reviewed line", "Original body\nSecond original line", "不会自动使用，也不会启用开关", "项目原件会保留", "已置顶", "参考资料"]) assert.ok(confirmations[0].detail?.includes(content), content);
        assert.ok(textOf(container).includes("已复制到「Research Partner」"));
        assert.ok(textOf(container).includes("Original body"), "Source stays selected and unchanged");
      } else if (scenario === "cancel-review") {
        await click("审阅复制");
        assert.equal(previewCalls.length, 1); assert.equal(confirmations.length, 1); assert.equal(commitCalls.length, 0);
        assert.ok(nodes(container).some((node) => props(node).role === "dialog"));
      } else if (scenario === "cancel-pending-preview") {
        await click("审阅复制"); await click("取消");
        await update(() => pendingPreview.resolve(review(previewCalls[0])));
        assert.equal(confirmations.length, 0); assert.equal(commitCalls.length, 0);
        assert.ok(!nodes(container).some((node) => props(node).role === "dialog"));
      } else if (scenario === "stale-preview-project") {
        await click("审阅复制"); cwd = "/fixture/project-b"; await render();
        await update(() => pendingPreview.resolve(review(previewCalls[0])));
        assert.equal(confirmations.length, 0); assert.equal(commitCalls.length, 0);
        assert.ok(!nodes(container).some((node) => props(node).role === "dialog"));
      } else if (scenario === "stale-confirmation-scope") {
        await click("审阅复制"); await click("自动整理");
        await update(() => pendingConfirmation.resolve(true));
        assert.equal(confirmations.length, 1); assert.equal(commitCalls.length, 0);
      } else if (scenario === "source-switch") {
        await click("审阅复制");
        await update(() => props(find((node) => node.tagName === "BUTTON" && textOf(node).startsWith("Second memory"))).onClick());
        await update(() => pendingConfirmation.resolve(true));
        assert.equal(commitCalls.length, 0);
        assert.ok(textOf(container).includes("Second memory"));
      } else if (scenario === "preview-lock") {
        const submit = props(button("审阅复制")).onClick;
        await update(() => { submit(); submit(); });
        assert.equal(previewCalls.length, 1);
        await update(() => pendingPreview.resolve(review(previewCalls[0])));
        assert.equal(commitCalls.length, 1);
      } else if (scenario === "commit-lock") {
        const submit = props(button("审阅复制")).onClick;
        await update(() => { submit(); submit(); });
        await update(() => pendingConfirmation.resolve(true));
        await update(() => { submit(); submit(); });
        assert.equal(previewCalls.length, 1); assert.equal(commitCalls.length, 1);
        assert.equal(props(button("取消")).disabled, true);
        await update(() => pendingCommit.resolve({ profileName: "researcher", id: "copy", fileName: "copy.md" }));
        assert.ok(!nodes(container).some((node) => props(node).role === "dialog"));
      } else if (scenario === "rename-after-conflict") {
        await click("审阅复制");
        assert.ok(textOf(container).includes("A memory with this name already exists"));
        assert.equal(commitCalls.length, 0); assert.equal(confirmations.length, 0);
        conflict = false;
        await editDraft(); await selectTarget("writer"); await click("审阅复制");
        assert.equal(previewCalls.length, 2); assert.equal(previewCalls[1].draft.name, "Reusable lesson");
        assert.equal(previewCalls[1].profileName, "writer");
        assert.deepEqual(commitCalls, [{ cwd, reviewId: "review-2" }]);
      } else throw new Error(`Unknown scenario: ${scenario}`);
    }
  }
  assert.deepEqual(otherWrites, [], "The copy flow cannot save/delete the source or activate a Profile");
  assert.equal(denied, 0);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(unhandled, [], "UI async failures must be handled");
  console.log(JSON.stringify({ scenario, previewCalls: previewCalls.length, commitCalls: commitCalls.length, unexpectedDenials: denied, passed: true }));
} finally {
  await update(() => root.unmount());
  document.body.removeChild(container);
}
