// Isolated so Radix captures DOM availability before ChatView and Popover imports.
import assert from "node:assert/strict";
import React, { act } from "react";
import { ensureMiniDom, flushMicrotasks } from "./test-utils/renderHook";

ensureMiniDom();
Object.getPrototypeOf(document.createElement("div")).scrollIntoView = () => undefined;
HTMLElement.prototype.getBoundingClientRect = () =>
  ({ x: 0, y: 0, top: 0, left: 0, right: 240, bottom: 36, width: 240, height: 36 }) as DOMRect;
// Popper writes custom properties; the shared mini DOM stores ordinary style keys.
const createElement = document.createElement.bind(document);
document.createElement = ((...args: Parameters<typeof document.createElement>) => {
  const element = createElement(...args);
  element.style.setProperty = (name: string, value: string | null) => {
    (element.style as unknown as Record<string, string>)[name] = value ?? "";
  };
  element.style.removeProperty = (name: string) => {
    const value = (element.style as unknown as Record<string, string>)[name] ?? "";
    delete (element.style as unknown as Record<string, string>)[name];
    return value;
  };
  element.style.getPropertyValue = (name: string) =>
    (element.style as unknown as Record<string, string>)[name] ?? "";
  return element;
}) as typeof document.createElement;
Object.assign(globalThis, {
  requestAnimationFrame: (callback: FrameRequestCallback) =>
    setTimeout(() => callback(performance.now()), 0),
  cancelAnimationFrame: (handle: number) => clearTimeout(handle),
});
const { createRoot } = await import("react-dom/client");
const { ChatView } = await import("./ChatView");
function descendants(node: any): any[] {
  return [node, ...Array.from(node.childNodes ?? []).flatMap(descendants)];
}
function reactProps(node: any): Record<string, any> {
  const key = Object.keys(node).find((candidate) => candidate.startsWith("__reactProps$"));
  return key ? node[key] : {};
}
const skillCalls: unknown[][] = [];
const attachmentCalls: unknown[][] = [];
const searchCalls: unknown[][] = [];
Object.defineProperty(window, "codeshell", {
  configurable: true,
  value: {
    sttAvailable: async () => ({ available: false }),
    listPluginCommands: async () => [],
    listSkills: async (...args: unknown[]) => {
      skillCalls.push(args);
      return [
        {
          name: "old-skill",
          description: "from old root",
          filePath: "/old-root/.agents/skills/old-skill/SKILL.md",
          enabled: true,
        },
      ];
    },
    inspectAttachments: async (...args: unknown[]) => {
      attachmentCalls.push(args);
      return [];
    },
    searchProjectFiles: async (...args: unknown[]) => {
      searchCalls.push(args);
      return [
        { rootId: "old-root", path: "same-relative.md", name: "same-relative.md", kind: "file" },
        { rootId: "new-root", path: "same-relative.md", name: "same-relative.md", kind: "file" },
      ];
    },
    onPluginCommandsChanged: () => () => undefined,
  },
});
const container = document.createElement("div");
document.body.appendChild(container);
const root = createRoot(container);
function Host() {
  const [draft, setDraft] = React.useState("");
  return (
    <ChatView
      variant="quickChat"
      messages={[]}
      engineSessionId="old-session"
      onSend={() => undefined}
      onStop={() => undefined}
      busy={false}
      activeProjectId="project-1"
      permissionMode="plan"
      onPermissionChange={() => undefined}
      goalEnabled={false}
      onGoalToggle={() => undefined}
      modelOptions={[]}
      activeModelKey={null}
      onModelChange={() => undefined}
      contextTokens={0}
      projects={[
        {
          id: "project-1",
          name: "Multi root",
          path: "/new-root",
          roots: [
            { id: "old-root", path: "/old-root", name: "Old", addedAt: 1 },
            { id: "new-root", path: "/new-root", name: "New", addedAt: 2 },
          ],
          primaryRootId: "new-root",
          addedAt: 1,
        },
      ]}
      onSelectProject={() => undefined}
      onAddProject={() => undefined}
      configurationTarget={{ sessionId: "old-session" }}
      configurationAvailable
      conversationRoot="/old-root"
      conversationRootId="old-root"
      draft={draft}
      onDraftChange={setDraft}
      attachments={[]}
      onAttachmentsChange={() => undefined}
    />
  );
}

try {
  await act(async () => {
    root.render(<Host />);
    await flushMicrotasks();
  });
  const textarea = descendants(container).find((node) => reactProps(node).rows === 1);
  assert.ok(textarea, "Expected the real chat composer");
  await act(async () => {
    reactProps(textarea).onChange({ target: { value: "@same", selectionStart: 5 } });
    await flushMicrotasks();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
    await flushMicrotasks();
  });
  assert.ok(
    skillCalls.some(
      (args) => JSON.stringify(args) === JSON.stringify([{ sessionId: "old-session" }]),
    ),
  );
  assert.ok(
    attachmentCalls.some((args) => JSON.stringify(args) === JSON.stringify([{ cwd: "/old-root" }])),
  );
  assert.ok(
    searchCalls.some((args) => JSON.stringify(args) === JSON.stringify(["project-1", "same"])),
  );
  const listbox = descendants(document.body).find((node) => reactProps(node).role === "listbox");
  assert.ok(listbox, "Mention discovery renders its real floating list");
  assert.equal(container.contains(listbox), false, "Suggestions escape chat clipping");
  const renderedText = descendants(listbox)
    .map((node) => node.nodeValue ?? node.textContent ?? "")
    .join("");
  assert.ok(renderedText.includes("/old-root/same-relative.md"));
  assert.equal(renderedText.includes("/new-root/same-relative.md"), false);
} finally {
  await act(async () => {
    root.unmount();
    await flushMicrotasks();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  document.body.removeChild(container);
}
