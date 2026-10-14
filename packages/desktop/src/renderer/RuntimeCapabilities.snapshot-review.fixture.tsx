// A fresh process initializes the DOM before Radix captures its browser environment.
import assert from "node:assert/strict";
import React, { act } from "react";
import { ensureMiniDom, flushMicrotasks } from "./test-utils/renderHook";

ensureMiniDom();
const { createRoot } = await import("react-dom/client");
const { FilesChangedCard } = await import("./messages/FilesChangedCard");
const { LocalRuntimeActionsContext } = await import("./runtime/RuntimeCapabilities");
const calls: string[] = [];
window.codeshell = new Proxy(
  {},
  {
    get: (_target, name) => () => {
      calls.push(String(name));
      throw new Error(`Cloud snapshot called native method ${String(name)}`);
    },
  },
) as typeof window.codeshell;
function descendants(node: any): any[] {
  return [node, ...Array.from(node.childNodes ?? []).flatMap(descendants)];
}
function propsOf(node: any): Record<string, any> {
  const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
  return key ? node[key] : {};
}
const container = document.createElement("div");
container.className = "cs-stream-item";
document.body.appendChild(container);
const root = createRoot(container);
try {
  await act(async () => {
    root.render(
      <LocalRuntimeActionsContext.Provider value={false}>
        <FilesChangedCard
          message={{
            kind: "files_changed",
            id: "remote-files",
            files: [{ path: "report.md", added: 1, removed: 1, count: 1 }],
            totalAdded: 1,
            totalRemoved: 1,
            sessionDiffs: [
              {
                path: "report.md",
                toolCallId: "remote-edit",
                diff: "diff --git a/report.md b/report.md\n--- a/report.md\n+++ b/report.md\n@@ -1 +1 @@\n-old\n+new\n",
              },
            ],
          }}
          cwd="/cloud/workspace"
          sessionId="session-also-valid-locally"
          isLatest
        />
      </LocalRuntimeActionsContext.Provider>,
    );
    await flushMicrotasks();
  });
  const review = descendants(container).find((node) =>
    propsOf(node)["aria-label"]?.includes("审核"),
  );
  assert.ok(review);
  await act(async () => {
    propsOf(review).onClick();
    await flushMicrotasks();
  });
  const dialog = descendants(document.body).find((node) => propsOf(node).role === "dialog");
  assert.ok(dialog, "Snapshot review renders a real dialog");
  assert.equal(container.contains(dialog), false, "Dialog escapes transcript containment");
  assert.ok(descendants(dialog).some((node) => node.tagName === "TABLE"));
  assert.equal(
    descendants(dialog).some((node) =>
      ["打开文件", "评论此行"].includes(propsOf(node)["aria-label"]),
    ),
    false,
  );
  assert.deepEqual(calls, [], "Cloud snapshot never invokes native methods");
} finally {
  await act(async () => {
    root.unmount();
    await flushMicrotasks();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  document.body.removeChild(container);
}
