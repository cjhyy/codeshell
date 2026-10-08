import { afterEach, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { ProfilePluginExportReview } from "./ProfilePluginExportDialog";

function props(node: any): any {
  const key = Object.keys(node).find((key) => key.startsWith("__reactProps$"));
  return key ? node[key] : {};
}
function elements(node: any, tag: string): any[] {
  return [
    ...(node.tagName === tag ? [node] : []),
    ...(node.childNodes ?? []).flatMap((child) => elements(child, tag)),
  ];
}
let root: Root | null = null;
afterEach(async () => {
  if (root)
    await act(async () => {
      root?.unmount();
      await flushMicrotasks();
    });
  root = null;
});

test("selection and complete text/loss review gate saving; changing context cancels old review", async () => {
  ensureMiniDom();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const canceled: string[] = [],
    committed: unknown[][] = [];
  let serial = 0;
  const id = "a".repeat(64);
  Object.assign(window, {
    codeshell: {
      async previewProfilePluginExport(_name, _target, selection) {
        const selected = selection.componentIds.includes(id);
        return {
          reviewToken: `review-${++serial}`,
          format: "codeshell-cc-static-v1",
          profileName: "example",
          pluginName: "profile-example",
          canExport: selected,
          totalBytes: 50,
          components: [
            {
              id,
              kind: "skill",
              name: "selected",
              exportName: "skill-selected",
              source: "project",
              selected,
              textFiles: [],
            },
          ],
          losses: ["Permissions and memory are not equivalent"],
          files: selected
            ? [
                {
                  path: "skills/skill-selected/SKILL.md",
                  text: "<script>not executed</script> COMPLETE_REVIEW_TEXT",
                  bytes: 50,
                  sha256: "hash",
                },
              ]
            : [],
        };
      },
      async cancelProfilePluginExport(token) {
        canceled.push(token);
      },
      async commitProfilePluginExport(...args) {
        committed.push(args);
        return { canceled: false, directoryName: "example.plugin" };
      },
    },
  });
  let closed = 0;
  const exported: string[] = [];
  const render = (target: { projectId: string }) => (
    <ProfilePluginExportReview
      name="example"
      target={target}
      onClose={() => closed++}
      onExported={(name) => exported.push(name)}
    />
  );
  root = createRoot(container);
  await act(async () => {
    root!.render(render({ projectId: "one" }));
    await flushMicrotasks();
  });
  const save = () =>
    elements(container, "BUTTON").find((node) => String(node.textContent).includes("选择新目录"));
  expect(props(save()).disabled).toBe(true);
  await act(async () => {
    props(elements(container, "INPUT")[0]).onChange({ target: { checked: true } });
    await flushMicrotasks();
  });
  expect(elements(container, "PRE")[0].textContent).toContain("COMPLETE_REVIEW_TEXT");
  expect(elements(container, "SCRIPT")).toEqual([]);
  expect(props(save()).disabled).toBe(true);
  await act(async () => {
    props(elements(container, "INPUT").at(-1)).onChange({ target: { checked: true } });
    await flushMicrotasks();
  });
  expect(props(save()).disabled).toBe(false);
  await act(async () => {
    root!.render(render({ projectId: "two" }));
    await flushMicrotasks();
  });
  expect(canceled).toContain("review-2");
  expect(props(save()).disabled).toBe(true);
  await act(async () => {
    props(elements(container, "INPUT")[0]).onChange({ target: { checked: true } });
    await flushMicrotasks();
  });
  await act(async () => {
    props(elements(container, "INPUT").at(-1)).onChange({ target: { checked: true } });
    await flushMicrotasks();
  });
  await act(async () => {
    props(save()).onClick();
    await flushMicrotasks();
  });
  expect(committed).toEqual([["review-4", { projectId: "two" }, true]]);
  expect(exported).toEqual(["example.plugin"]);
  expect(closed).toBe(1);
});
