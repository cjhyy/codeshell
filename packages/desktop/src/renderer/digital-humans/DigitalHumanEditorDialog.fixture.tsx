// Isolate shared dialog mocks from other renderer suites while exercising the real editor.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
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
if (scenario.startsWith("dependencies-")) {
  profile.requires = {
    skills: [
      {
        source: "github",
        repo: "owner/skills",
        skills: ["research"],
        scope: "project",
        fullDepth: true,
      },
      { source: "github", repo: "owner/all", scope: "project", fullDepth: false },
    ],
    tools: [{ bin: "node", minVersion: "22.1", hint: "Install Node" }],
  };
  profile.plugins = ["research-plugin"];
  profile.mcp = ["sources"];
  profile.agents = ["reviewer"];
  profile.version = "1.2.3";
  if (
    [
      "dependencies-sync",
      "dependencies-source-metadata",
      "dependencies-user-source-replace",
    ].includes(scenario)
  )
    profile.requires.skills.pop();
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
  skills:
    scenario === "dependencies-user-source-replace"
      ? [{ name: "research", description: "Installed user copy", source: "user" }]
      : [],
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
async function settingsTab() {
  const nav = find((node) => node.tagName === "NAV");
  const tab = nodes(nav).filter((node) => node.tagName === "BUTTON")[3];
  await update(() => props(tab).onClick());
}
const control = (id: string) => find((node) => props(node).id === id);
const button = (id: string) => find((node) => props(node)["data-testid"] === id);
const change = (id: string, value: string) =>
  update(() => props(control(id)).onChange({ target: { value } }));
const click = (id: string) => update(() => props(button(id)).onClick());
const saveButton = () => find((node) => node.tagName === "BUTTON" && props(node).type === "submit");
const submit = () =>
  update(() => props(find((node) => node.tagName === "FORM")).onSubmit({ preventDefault() {} }));
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
  } else if (scenario === "dependencies-roundtrip") {
    await settingsTab();
    assert.equal(props(control("requirement-repository-0")).value, "owner/skills");
    assert.equal(props(control("requirement-repository-0-depth"))["aria-checked"], true);
    assert.equal(props(control("requirement-tool-version-0")).value, "22.1");
    await change("requirement-repository-0", "owner/new-skills");
    await click("requirement-repository-0-add-skill");
    await change("requirement-repository-0-skill-1", "summarize");
    await click("requirement-remove-repository-1");
    await click("requirement-add-repository");
    await change("requirement-repository-1", "owner/new-all");
    await update(() =>
      props(control("requirement-repository-1-depth")).onClick({
        defaultPrevented: false,
        isPropagationStopped: () => false,
        stopPropagation() {},
      }),
    );
    await click("requirement-remove-tool-0");
    await click("requirement-add-tool");
    await change("requirement-tool-0", "ffmpeg");
    await change("requirement-tool-version-0", "7.1.0");
    await change("requirement-tool-hint-0", "brew install ffmpeg");
    await submit();
    assert.deepEqual(saved[0]?.requires, {
      skills: [
        {
          source: "github",
          repo: "owner/new-skills",
          skills: ["research", "summarize"],
          scope: "project",
          fullDepth: true,
        },
        { source: "github", repo: "owner/new-all", scope: "project", fullDepth: true },
      ],
      tools: [{ bin: "ffmpeg", minVersion: "7.1.0", hint: "brew install ffmpeg" }],
    });
    assert.deepEqual(saved[0]?.plugins, profile.plugins);
    assert.deepEqual(saved[0]?.mcp, profile.mcp);
    assert.deepEqual(saved[0]?.agents, profile.agents);
    assert.equal(saved[0]?.version, profile.version);
    assert.equal(
      previewCalls.length,
      0,
      "Saving declarations must not review or execute installation",
    );
    assert.equal(installCalls.length, 0);
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const temporaryHome = mkdtempSync(join(tmpdir(), "digital-human-editor-"));
    const persistProfile = (value: Omit<DigitalHumanProfileEntry, "active">) => {
      // A separate Bun process exercises core persistence without pulling Node
      // internals into the renderer fixture's TypeScript/browser boundary.
      const storePath = fileURLToPath(
        new URL("../../../../core/src/profile/store.ts", import.meta.url),
      );
      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          "-e",
          `
          import { saveWorkspaceProfile, readWorkspaceProfile } from ${JSON.stringify(storePath)};
          const profile = JSON.parse(await new Response(Bun.stdin.stream()).text());
          saveWorkspaceProfile(profile);
          process.stdout.write(JSON.stringify(readWorkspaceProfile(profile.name)));
        `,
        ],
        stdin: new TextEncoder().encode(JSON.stringify(value)),
        env: { ...process.env, CODE_SHELL_HOME: temporaryHome },
        stdout: "pipe",
        stderr: "pipe",
      });
      assert.equal(result.exitCode, 0, result.stderr.toString());
      return JSON.parse(result.stdout.toString()) as Omit<DigitalHumanProfileEntry, "active">;
    };
    try {
      const loaded = persistProfile(saved[0]!);
      assert.deepEqual(loaded.requires, saved[0]?.requires);
      editorProps = { ...editorProps, open: false };
      await render();
      editorProps = { ...editorProps, open: true, profile: { ...loaded, active: false } };
      await render();
      await settingsTab();
      assert.equal(props(control("requirement-repository-0-skill-1")).value, "summarize");
      assert.equal(props(control("requirement-tool-hint-0")).value, "brew install ffmpeg");
      await click("requirement-remove-repository-1");
      await click("requirement-remove-repository-0");
      await click("requirement-remove-tool-0");
      await submit();
      assert.equal(
        Object.hasOwn(saved[1]!, "requires"),
        false,
        "Removing all rows removes the declaration",
      );
      assert.equal(persistProfile(saved[1]!).requires, undefined);
    } finally {
      rmSync(temporaryHome, { recursive: true, force: true });
    }
  } else if (scenario === "dependencies-validation") {
    await settingsTab();
    await change("requirement-repository-0", "https://github.com/owner/repo");
    assert.equal(props(saveButton()).disabled, true);
    assert.ok(nodes(container).some((node) => props(node).role === "alert"));
    await submit();
    assert.equal(saved.length, 0);
    await change("requirement-repository-0", "owner/repo");
    await change("requirement-repository-0-skill-0", "--all");
    assert.equal(props(saveButton()).disabled, true);
    await change("requirement-repository-0-skill-0", "*");
    assert.equal(props(saveButton()).disabled, true);
    await change("requirement-repository-0-skill-0", "research");
    await click("requirement-repository-0-add-skill");
    await change("requirement-repository-0-skill-1", "research");
    assert.equal(props(saveButton()).disabled, true);
    await change("requirement-repository-0-skill-1", "review");
    await change("requirement-tool-version-0", "v22.1");
    assert.equal(props(saveButton()).disabled, true);
    await change("requirement-tool-version-0", "22.1.0");
    assert.equal(props(saveButton()).disabled, false);
    await change("requirement-tool-0", "");
    assert.equal(props(saveButton()).disabled, true);
    await change("requirement-tool-0", "node");
    await click("requirement-add-repository");
    assert.equal(props(saveButton()).disabled, true);
    await click("requirement-remove-repository-2");
    assert.equal(props(saveButton()).disabled, false);
    await submit();
    assert.equal(saved.length, 1);
  } else if (scenario === "dependencies-sync") {
    await skillsTab();
    await change("digital-human-skill-repo", "owner/changed");
    await settingsTab();
    assert.equal(props(control("requirement-repository-0")).value, "owner/changed");
    await change("requirement-repository-0", "owner/second");
    assert.equal(props(control("requirement-repository-0-depth"))["aria-checked"], true);
    await skillsTab();
    assert.equal(props(control("digital-human-skill-repo")).value, "owner/second");
    await submit();
    assert.equal(saved[0]?.requires?.skills[0]?.fullDepth, true);
    await settingsTab();
    await click("requirement-remove-repository-0");
    await skillsTab();
    assert.equal(props(control("digital-human-skill-repo")).value, "");
    await submit();
    assert.deepEqual(saved[1]?.requires?.skills, []);
  } else if (scenario === "dependencies-source-metadata") {
    await skillsTab();
    await change("digital-human-skill-repo", "owner/temporary");
    await submit();
    assert.equal(saved[0]?.requires?.skills[0]?.fullDepth, true);
    await change("digital-human-skill-repo", "owner/skills");
    await submit();
    assert.deepEqual(saved[1]?.requires, profile.requires);
    await change("digital-human-skill-repo", " owner/skills ");
    await submit();
    assert.deepEqual(saved[2]?.requires, profile.requires);
  } else if (scenario === "dependencies-user-source-replace") {
    await skillsTab();
    assert.equal(props(control("digital-human-skill-repo")).value, "owner/skills");
    await change("digital-human-skill-repo", "");
    assert.equal(
      props(control("digital-human-skill-repo")).value,
      "",
      "Clearing a source must keep the active project requirement editor visible",
    );
    assert.equal(
      props(saveButton()).disabled,
      true,
      "An incomplete source must not silently remove a project dependency",
    );
    await submit();
    assert.equal(saved.length, 0);
    await change("digital-human-skill-repo", "owner/replacement");
    assert.equal(props(saveButton()).disabled, false);
    await submit();
    assert.deepEqual(saved[0]?.requires?.skills, [
      { ...profile.requires!.skills[0], repo: "owner/replacement" },
    ]);
    await settingsTab();
    await click("requirement-remove-repository-0");
    await skillsTab();
    assert.equal(
      nodes(container).some((node) => props(node).id === "digital-human-skill-repo"),
      false,
      "An explicit removal may use the installed user copy",
    );
    await submit();
    assert.deepEqual(saved[1]?.requires?.skills, []);
  } else if (scenario === "dependencies-saved-normalization") {
    await settingsTab();
    await change("requirement-repository-1", " owner/all ");
    await click("digital-human-requirements-save-install");
    assert.equal(saved[0]?.requires?.skills[1]?.repo, "owner/all");
    // Simulate the same-name parent refresh after persistence, while the
    // subsequent install review was cancelled and keeps the editor open.
    editorProps = { ...editorProps, profile: { ...saved[0]!, active: false } };
    await render();
    assert.equal(
      props(control("requirement-repository-1")).value,
      " owner/all ",
      "A saved refresh must not jump tabs or overwrite the live draft",
    );
    await skillsTab();
    assert.equal(
      props(installButton()).disabled,
      false,
      "A normalized saved draft must restore the saved dependency check action",
    );
    await update(() => requestClose(false));
    assert.equal(confirmCount, 0, "Normalized saved sources must not report unsaved changes");
    assert.deepEqual(openChanges, [false]);
  } else if (scenario === "dependencies-discard") {
    await settingsTab();
    await change("requirement-tool-hint-0", "Install another version");
    await update(() => requestClose(false));
    assert.equal(confirmCount, 1, "Dependency-only edits need the unsaved-changes prompt");
    assert.deepEqual(openChanges, [false]);
  } else throw new Error(`Unknown scenario: ${scenario}`);
} finally {
  await update(() => root.unmount());
  document.body.removeChild(container);
}
