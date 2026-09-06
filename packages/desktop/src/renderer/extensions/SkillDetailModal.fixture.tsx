// Executed in a fresh Bun process by extensionsPresentation.test.tsx because
// several renderer suites intentionally replace the shared Dialog module.
import assert from "node:assert/strict";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";

ensureMiniDom();
const { SkillsTab } = await import("./SkillsTab");
const { DialogProvider } = await import("../ui/DialogProvider");
const skill = {
  name: "review-skill",
  description: "Review a document",
  filePath: "/tmp/review/SKILL.md",
  source: "user" as const,
  enabled: true,
};
Object.defineProperty(window, "codeshell", {
  configurable: true,
  value: {
    listSkills: async () => [skill],
    checkSkillUpdate: async () => ({ updateAvailable: false }),
    readSkillBody: async () => "Skill instructions are readable.",
  },
});

function props(node: any): Record<string, any> {
  const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
  return key ? node[key] : {};
}
function nodes(node: any): any[] {
  return [node, ...Array.from(node.childNodes ?? []).flatMap(nodes)];
}
function textOf(node: any): string {
  if (node.nodeType === 3) return node.data ?? node.textContent ?? "";
  const children = Array.from(node.childNodes ?? []);
  return children.length ? children.map(textOf).join("") : (node.textContent ?? "");
}
async function click(node: any) {
  await act(async () => {
    props(node).onClick({ stopPropagation() {}, defaultPrevented: false });
    await flushMicrotasks();
  });
}
async function settleFocus() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flushMicrotasks();
  });
}

const container = document.createElement("div");
document.body.appendChild(container);
const root = createRoot(container);
try {
  await act(async () => {
    root.render(
      <DialogProvider>
        <SkillsTab
          configurationTarget={{ noRepo: true }}
          query=""
          isEnabled={() => true}
          onToggle={() => {}}
        />
      </DialogProvider>,
    );
    await flushMicrotasks();
  });
  const open = nodes(container).find(
    (node) => props(node)["aria-label"] === "查看技能 review-skill",
  );
  open.focus();
  await click(open);
  const dialog = nodes(document.body).find((node) => props(node).role === "dialog");
  assert.ok(dialog, "The skill details must expose a real dialog");
  assert.ok(textOf(dialog).includes("Skill instructions are readable."));
  await click(nodes(dialog).find((node) => props(node)["aria-label"] === "关闭"));
  await settleFocus();
  assert.ok(!nodes(document.body).some((node) => props(node).role === "dialog"));
  assert.equal(document.activeElement, open, "Closing returns focus to the skill button");

  await click(open);
  await act(async () => {
    document.dispatchEvent(
      Object.assign(new Event("keydown", { cancelable: true }), { key: "Escape" }),
    );
    await flushMicrotasks();
  });
  await settleFocus();
  assert.ok(
    !nodes(document.body).some((node) => props(node).role === "dialog"),
    "Escape closes the dialog",
  );
  assert.equal(document.activeElement, open);
} finally {
  await act(async () => {
    root.unmount();
    await flushMicrotasks();
  });
  document.body.removeChild(container);
}
