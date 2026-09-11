// Isolate shared dialog mocks from other renderer suites while exercising the real editor.
import assert from "node:assert/strict";
import { mock } from "bun:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import type { DigitalHumanProfileEntry } from "./types";

ensureMiniDom();
const scenario = process.argv[2];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let confirmImpl = async () => true;
let confirmCount = 0;
const toasts: unknown[] = [];
let requestClose: (open: boolean) => void = () => {};
const passthrough = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
mock.module("@/components/ui/dialog", () => ({
  Dialog: ({ open, children, onOpenChange }: any) => {
    requestClose = onOpenChange;
    return open ? <div>{children}</div> : null;
  },
  DialogContent: passthrough,
  DialogHeader: passthrough,
  DialogFooter: passthrough,
  DialogTitle: passthrough,
  DialogDescription: passthrough,
}));
mock.module("../ui/ConfirmDialog", () => ({
  useConfirm: () => () => {
    confirmCount++;
    return confirmImpl();
  },
}));
mock.module("../ui/ToastProvider", () => ({
  useToast: () => (value: unknown) => toasts.push(value),
}));
const { DigitalHumanEditorDialog } = await import("./DigitalHumanEditorDialog");
const saved: Array<Omit<DigitalHumanProfileEntry, "active">> = [];
const profile: DigitalHumanProfileEntry = {
  name: "researcher",
  label: "Research Partner",
  basePreset: "general",
  plugins: [],
  skills: ["constructor", "toString", "__proto__"],
  mcp: [],
  agents: [],
  active: false,
  portableMemory: false,
  exclusiveCapabilities: false,
};
if (scenario !== "prototype-sources") {
  profile.skills = ["research"];
  profile.requires = {
    skills: [{ source: "github", repo: "owner/skills", scope: "project", fullDepth: false }],
    tools: [],
  };
}
const preview = {
  needsInstall: true,
  willRun: ["Install owner/skills"],
  warnings: [],
  blockers: [],
};
const pendingPreview = deferred<typeof preview>();
const pendingInstall = deferred<{ ok: boolean; errors: string[] }>();
const pendingConfirmation = deferred<boolean>();
const previewCalls: unknown[] = [];
const installCalls: unknown[] = [];
let refreshed = 0;
const openChanges: boolean[] = [];
Object.assign(window, {
  codeshell: {
    previewProfileRequirements: async (...args: unknown[]) => {
      previewCalls.push(args);
      return ["install-lock", "stale-preview", "stale-install-result"].includes(scenario)
        ? pendingPreview.promise
        : preview;
    },
    installProfileRequirements: async (...args: unknown[]) => {
      installCalls.push(args);
      return scenario === "stale-install-result"
        ? pendingInstall.promise
        : { ok: true, errors: [] };
    },
  },
});
if (["stale-confirmation", "stale-discard"].includes(scenario)) {
  confirmImpl = () => pendingConfirmation.promise;
}
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
const container = document.createElement("div");
document.body.appendChild(container);
const root = createRoot(container);
let editorProps: React.ComponentProps<typeof DigitalHumanEditorDialog> = {
  open: true,
  profile,
  existingIds: [profile.name],
  skills: [],
  configurationTarget: { projectId: "project-a" },
  busy: false,
  installing: scenario === "parent-installing",
  onOpenChange: (open) => openChanges.push(open),
  onRequirementsInstalled: () => {
    refreshed++;
  },
  onSave: (value) => saved.push(value),
};
const render = () => update(() => root.render(<DigitalHumanEditorDialog {...editorProps} />));
async function skillsTab() {
  const nav = find((node) => node.tagName === "NAV");
  const skillTab = nodes(nav).filter((node) => node.tagName === "BUTTON")[2];
  await update(() => props(skillTab).onClick());
}
const installButton = () =>
  find((node) => node.tagName === "BUTTON" && textOf(node) === "检查并安装");
async function switchProfile() {
  editorProps = { ...editorProps, profile: { ...profile, name: "writer", label: "Writer" } };
  await render();
}
try {
  await render();
  if (scenario === "prototype-sources") {
    await skillsTab();
    const sourceInputs = () =>
      nodes(container).filter((node) =>
        String(props(node).id ?? "").startsWith("digital-human-skill-repo"),
      );
    assert.equal(sourceInputs().length, 3);
    for (const input of sourceInputs()) assert.equal(props(input).value, "");
    for (const input of sourceInputs()) {
      await update(() => props(input).onChange({ target: { value: "owner/skills" } }));
    }
    await update(() =>
      props(find((node) => node.tagName === "FORM")).onSubmit({ preventDefault() {} }),
    );
    assert.deepEqual(saved[0]?.requires?.skills, [
      {
        source: "github",
        repo: "owner/skills",
        skills: [...profile.skills].sort((left, right) => left.localeCompare(right)),
        scope: "project",
        fullDepth: false,
      },
    ]);
  } else if (scenario === "install-lock") {
    await skillsTab();
    const click = props(installButton()).onClick;
    await update(() => {
      click();
      click();
    });
    assert.equal(previewCalls.length, 1, "Rapid clicks must share one dependency operation");
    await update(() => pendingPreview.resolve(preview));
    assert.equal(installCalls.length, 1);
  } else if (["stale-preview", "stale-confirmation", "stale-install-result"].includes(scenario)) {
    await skillsTab();
    await update(() => props(installButton()).onClick());
    if (scenario === "stale-install-result") await update(() => pendingPreview.resolve(preview));
    await switchProfile();
    if (scenario === "stale-preview") await update(() => pendingPreview.resolve(preview));
    if (scenario === "stale-confirmation") await update(() => pendingConfirmation.resolve(true));
    if (scenario === "stale-install-result") {
      await skillsTab();
      await update(() => props(installButton()).onClick());
      await update(() => pendingInstall.resolve({ ok: true, errors: [] }));
      assert.equal(refreshed, 1, "Only the current profile's operation may refresh the editor");
      assert.equal(toasts.length, 1, "Old operations must not report success in another profile");
    } else {
      assert.equal(
        installCalls.length,
        0,
        "An old review must not start installation after switching",
      );
      assert.equal(refreshed, 0);
      assert.equal(toasts.length, 0);
      if (scenario === "stale-preview") assert.equal(confirmCount, 0);
    }
  } else if (scenario === "target-change") {
    const label = find((node) => props(node).id === "digital-human-label");
    await update(() => props(label).onChange({ target: { value: "Project A draft" } }));
    editorProps = { ...editorProps, configurationTarget: { projectId: "project-b" } };
    await render();
    assert.equal(
      props(find((node) => props(node).id === "digital-human-label")).value,
      profile.label,
    );
  } else if (scenario === "stale-discard") {
    const label = find((node) => props(node).id === "digital-human-label");
    await update(() => props(label).onChange({ target: { value: "Unsaved draft" } }));
    await update(() => requestClose(false));
    await switchProfile();
    await update(() => pendingConfirmation.resolve(true));
    assert.deepEqual(openChanges, [], "A discard decision for A cannot close the editor for B");
  } else if (scenario === "parent-installing") {
    assert.equal(
      props(find((node) => node.tagName === "BUTTON" && props(node).type === "submit")).disabled,
      true,
    );
    await update(() => requestClose(false));
    assert.deepEqual(openChanges, [], "Installation supplied by the parent keeps the editor open");
  } else throw new Error(`Unknown scenario: ${scenario}`);
} finally {
  await update(() => root.unmount());
  document.body.removeChild(container);
}
