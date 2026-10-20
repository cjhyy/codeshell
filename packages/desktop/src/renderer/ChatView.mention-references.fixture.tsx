// Real ChatView/Popover interaction; only native transport and submission are owned spies.
import assert from "node:assert/strict";
import React, { act } from "react";
import { ensureMiniDom, flushMicrotasks } from "./test-utils/renderHook";
import type { InputAttachmentMeta } from "../preload/types";
import type { ImageAttachment } from "./chat/attachments";

globalThis.fetch = (() => {
  throw new Error("Renderer reference fixture denies network");
}) as unknown as typeof fetch;
ensureMiniDom();
Object.getPrototypeOf(document.createElement("div")).scrollIntoView = () => undefined;
HTMLElement.prototype.getBoundingClientRect = () =>
  ({ x: 0, y: 0, top: 0, left: 0, right: 240, bottom: 36, width: 240, height: 36 }) as DOMRect;
const createElement = document.createElement.bind(document);
document.createElement = ((...args: Parameters<typeof document.createElement>) => {
  const element = createElement(...args);
  Object.assign(element.style, {
    setProperty(name: string, value: string | null) {
      (element.style as any)[name] = value ?? "";
    },
    removeProperty(name: string) {
      const previous = (element.style as any)[name] ?? "";
      delete (element.style as any)[name];
      return previous;
    },
    getPropertyValue(name: string) {
      return (element.style as any)[name] ?? "";
    },
  });
  return element;
}) as typeof document.createElement;
Object.assign(globalThis, {
  requestAnimationFrame: () => 1,
  cancelAnimationFrame: () => undefined,
});
const { createRoot } = await import("react-dom/client");
const { ChatView } = await import("./ChatView");
const scenario = process.argv[2];
const cwd = "/owned";
const fileName = scenario === "spaces-unicode" ? "报告 notes.md" : "report.md";
const filePath = `${cwd}/${fileName}`;
const recent: InputAttachmentMeta = {
  id: "owned-recent",
  sessionId: "owned-session",
  kind: "image",
  origin: "paste",
  path: ".code-shell/attachments/owned-session/recent.png",
  absPath: "/owned/.code-shell/attachments/owned-session/recent.png",
  size: 1,
  sha256: "owned-hash",
  originalName: "recent.png",
  createdAt: 1,
};
const calls: Array<{ route: string; text: string; opts: { attachments?: InputAttachmentMeta[] } }> =
  [];
const record =
  (route: string) =>
  (text: string, opts: { attachments?: InputAttachmentMeta[] } = {}) =>
    calls.push({ route, text, opts });
Object.defineProperty(window, "codeshell", {
  configurable: true,
  value: {
    sttAvailable: async () => ({ available: false }),
    listPluginCommands: async () => [],
    listSkills: async () => [],
    inspectAttachments: async () => [recent],
    searchProjectFiles: async (_project: string, query: string) =>
      query === "recent" ? [] : [{ rootId: "root", path: fileName, name: fileName, kind: "file" }],
    onPluginCommandsChanged: () => () => undefined,
  },
});
const container = document.createElement("div");
document.body.appendChild(container);
const root = createRoot(container);
let externalDraft!: React.Dispatch<React.SetStateAction<string>>;
const explicitImages: ImageAttachment[] = ["paste", "picker", "os-drop"].map((origin) => ({
  id: `owned-${origin}`,
  name: `${origin}.png`,
  origin: origin as ImageAttachment["origin"],
  path: `attachments/${origin}.png`,
  absPath: `/owned/attachments/${origin}.png`,
  dataUrl: "data:image/png;base64,AA==",
  mime: "image/png",
  size: 1,
  sessionId: "owned-session",
  createdAt: 1,
}));
function Host() {
  const [draft, setDraft] = React.useState("");
  externalDraft = setDraft;
  const [images, setImages] = React.useState(
    scenario === "explicit-attachments" ? explicitImages : [],
  );
  return (
    <ChatView
      variant="quickChat"
      messages={[]}
      engineSessionId="owned-session"
      onSend={record("send")}
      onQueueInput={record("queue")}
      onForceSend={record("force")}
      onStop={() => undefined}
      busy={scenario?.endsWith("force") || scenario === "delete-file-queue"}
      activeProjectId="owned-project"
      permissionMode="plan"
      onPermissionChange={() => undefined}
      goalEnabled={false}
      onGoalToggle={() => undefined}
      modelOptions={[
        { key: "owned-model", provider: "owned", label: "Owned", supportsVision: true },
      ]}
      activeModelKey="owned-model"
      onModelChange={() => undefined}
      contextTokens={0}
      projects={[
        {
          id: "owned-project",
          name: "Owned",
          path: cwd,
          roots: [{ id: "root", path: cwd, name: "Root", addedAt: 1 }],
          primaryRootId: "root",
          addedAt: 1,
        },
      ]}
      onSelectProject={() => undefined}
      onAddProject={() => undefined}
      configurationTarget={{ sessionId: "owned-session" }}
      configurationAvailable
      conversationRoot={cwd}
      conversationRootId="root"
      draft={draft}
      onDraftChange={setDraft}
      attachments={images}
      onAttachmentsChange={setImages}
      onCompactCommand={() => undefined}
      onPrepareAttachmentSession={() => ({ cwd, sessionId: "owned-session" })}
    />
  );
}
const descendants = (node: any): any[] => [
  node,
  ...Array.from(node.childNodes ?? []).flatMap(descendants),
];
function props(node: any): Record<string, any> {
  const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
  return key ? node[key] : {};
}
const textarea = () => descendants(container).find((node) => props(node).rows === 1);
const draft = () => props(textarea()).value as string;
const text = (node: any): string =>
  descendants(node)
    .map((child) => child.nodeValue ?? child.textContent ?? "")
    .join("");
async function change(
  next: string,
  selectionStart = draft().length,
  selectionEnd = selectionStart,
  paste = false,
) {
  const ta = textarea();
  ta.selectionStart = selectionStart;
  ta.selectionEnd = selectionEnd;
  await act(async () => {
    if (paste) await props(ta).onPaste({ currentTarget: ta, clipboardData: { items: [] } });
    else props(ta).onBeforeInput?.({ currentTarget: ta, target: ta });
    props(ta).onChange({ target: { value: next, selectionStart: next.length }, nativeEvent: {} });
    await flushMicrotasks();
  });
  textarea().selectionStart = next.length;
}
async function pick(kind: "file" | "recent") {
  const query = kind === "recent" ? "recent" : "report";
  await change(`${draft()}@${query}`);
  await act(async () => {
    await new Promise((done) => setTimeout(done, 80));
    await flushMicrotasks();
  });
  const option = descendants(document.body).find(
    (node) =>
      props(node).role === "option" &&
      text(node).includes(kind === "recent" ? recent.path : fileName),
  );
  assert.ok(option, "Expected actual MentionPopover option");
  textarea().selectionStart = draft().length;
  await act(async () => {
    props(option).onMouseDown({ preventDefault() {} });
    await flushMicrotasks();
  });
}
async function submit() {
  await act(async () => {
    if (scenario?.endsWith("force")) {
      const button = descendants(container).find(
        (node) =>
          props(node)["aria-label"] &&
          props(node).onClick &&
          /引导|Guide/u.test(props(node)["aria-label"]),
      );
      assert.ok(button, "Expected actual ForceSend control");
      props(button).onClick();
    } else props(textarea()).onKeyDown({ key: "Enter", nativeEvent: {}, preventDefault() {} });
    await flushMicrotasks();
  });
}
try {
  await act(async () => {
    root.render(<Host />);
    await flushMicrotasks();
  });
  await pick(
    scenario?.startsWith("delete-recent") || scenario === "recent-preserved" ? "recent" : "file",
  );
  if (scenario?.startsWith("delete-")) await change("ordinary message", 0, draft().length);
  else if (scenario === "spaces-unicode" || scenario === "recent-preserved")
    await change(`${draft()}explain this`);
  else if (scenario === "duplicate") {
    await pick("file");
    const firstEnd = draft().indexOf(" ") + 1;
    await change(draft().slice(firstEnd) + "explain", 0, firstEnd);
  } else if (scenario === "suffix" || scenario === "space-suffix" || scenario === "paste-suffix") {
    const end = draft().length - 1;
    await change(
      draft().slice(0, end) + (scenario === "suffix" ? ".bak" : " copy") + " ",
      end,
      end,
      scenario === "paste-suffix",
    );
  } else if (scenario === "clear-restore") {
    const previous = draft();
    await act(async () => {
      externalDraft("");
      await flushMicrotasks();
    });
    await act(async () => {
      externalDraft(previous);
      await flushMicrotasks();
    });
  } else if (scenario === "explicit-attachments") {
    const dropTarget = descendants(container).find((node) => props(node).onDrop);
    await act(async () => {
      props(dropTarget).onDrop({
        preventDefault() {},
        dataTransfer: { getData: () => "/owned/dropped.txt" },
      });
      await flushMicrotasks();
    });
    await change("ordinary message", 0, draft().length);
  } else if (scenario === "compact-clear") {
    await change("/compact", 0, draft().length);
    await submit();
    await change("ordinary message");
  }
  await submit();
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]!.route,
    scenario?.endsWith("force") ? "force" : scenario === "delete-file-queue" ? "queue" : "send",
  );
  const attachments = calls[0]!.opts.attachments ?? [];
  if (scenario === "spaces-unicode" || scenario === "duplicate") {
    assert.equal(attachments.length, 1);
    assert.equal(attachments[0]!.absPath, filePath);
  } else if (scenario === "recent-preserved") {
    assert.deepEqual(
      attachments,
      [recent],
      "Recent metadata including its paste origin remains unchanged",
    );
  } else if (scenario === "explicit-attachments") {
    assert.deepEqual(
      attachments.map(({ origin }) => origin),
      ["paste", "picker", "os-drop", "file-panel"],
    );
  } else assert.deepEqual(attachments, [], "Removed/edited mention metadata must not be submitted");
  console.log(
    JSON.stringify({
      scenario,
      route: calls[0]!.route,
      references: attachments.map(({ absPath, origin }) => ({ absPath, origin })),
      passed: true,
    }),
  );
} finally {
  await act(async () => {
    root.unmount();
    await flushMicrotasks();
  });
  document.body.removeChild(container);
}
