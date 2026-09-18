import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReviewGitStatusResult } from "../../shared/review";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";

const { PanelArea } = await import("./PanelArea?review-availability");
const nodes = (node: any): any[] => [node, ...(node.childNodes ?? []).flatMap(nodes)];
const text = (node: any): string =>
  node.nodeType === 3
    ? (node.nodeValue ?? node.textContent ?? "")
    : node.childNodes?.length
      ? node.childNodes.map(text).join("")
      : (node.textContent ?? "");
const emptyStatus: ReviewGitStatusResult = { repositories: [], errors: [] };
const repoStatus: ReviewGitStatusResult = {
  repositories: [
    {
      rootId: "root",
      rootIds: ["root"],
      repoRoot: "/repo",
      branch: null,
      entries: [],
      clean: true,
    },
  ],
  errors: [],
};
const snapshot =
  "diff --git a/note.txt b/note.txt\n--- a/note.txt\n+++ b/note.txt\n@@ -1 +1 @@\n-before-note\n+after-note\n";
let root: Root | null = null;
let container: HTMLElement;
let resolveStatus: (status: ReviewGitStatusResult) => void;
let diffCalls = 0;

function Harness({
  reviewDiff,
  sessionId = "panel-session",
  requestKind = null,
}: {
  reviewDiff?: string;
  sessionId?: string;
  requestKind?: "review" | null;
}) {
  const [tabs, setTabs] = useState([{ id: "stored-review", kind: "review" }]);
  const [activeId, setActiveId] = useState<string | null>("stored-review");
  return (
    <PanelArea
      projectPath="/repo"
      engineSessionId={sessionId}
      bucket="panel-test"
      onClose={() => {}}
      tabs={tabs}
      setTabs={setTabs}
      activeId={activeId}
      setActiveId={setActiveId}
      requestNonce={1}
      requestKind={requestKind}
      reviewDiff={reviewDiff}
      width={480}
      onResizeStart={() => {}}
    />
  );
}

beforeEach(() => {
  ensureMiniDom();
  diffCalls = 0;
  Object.assign(window, {
    codeshell: {
      getSessionWorkspace: async () => ({ root: "/repo", kind: "main" }),
      getReviewStatus: () =>
        new Promise<ReviewGitStatusResult>((resolve) => {
          resolveStatus = resolve;
        }),
      getReviewDiff: async () => {
        diffCalls++;
        return emptyStatus;
      },
    },
  });
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
    await flushMicrotasks();
  });
  root = null;
});

const reviewTabs = () =>
  nodes(container).filter(
    (node) =>
      node.getAttribute?.("role") === "tab" &&
      /stored-review/.test(node.getAttribute?.("id") ?? ""),
  );
const reviewLauncher = () =>
  nodes(container).filter(
    (node) => node.tagName === "BUTTON" && /^(Review|审查)$/.test(text(node).trim()),
  );
const render = async (props: React.ComponentProps<typeof Harness> = {}) => {
  await act(async () => {
    root?.render(<Harness {...props} />);
    await flushMicrotasks();
  });
};
const settle = async (status: ReviewGitStatusResult) => {
  await act(async () => {
    resolveStatus(status);
    await flushMicrotasks();
  });
};

describe("PanelArea Git availability", () => {
  test("hides launcher, restored tabs and direct requests while unknown or non-Git", async () => {
    await render({ requestKind: "review" });
    expect(reviewTabs()).toHaveLength(0);
    expect(reviewLauncher()).toHaveLength(0);
    await settle(emptyStatus);
    expect(reviewTabs()).toHaveLength(0);
    expect(reviewLauncher()).toHaveLength(0);
    expect(diffCalls).toBe(0);
    // Unavailable tabs remain stored; confirming a repository restores the tab.
    await render({ sessionId: "repo-session", requestKind: "review" });
    await settle(repoStatus);
    expect(reviewTabs()).toHaveLength(1);
    expect(diffCalls).toBeGreaterThan(0);
    await render({ sessionId: "notes-session" });
    expect(reviewTabs()).toHaveLength(0);
    await settle(emptyStatus);
    expect(reviewTabs()).toHaveLength(0);
  });

  test("keeps a saved turn snapshot visible in a non-repository without Git requests", async () => {
    await render({ reviewDiff: snapshot, requestKind: "review" });
    await settle(emptyStatus);
    expect(reviewTabs()).toHaveLength(1);
    expect(text(container)).toContain("after-note");
    expect(diffCalls).toBe(0);
  });
});
