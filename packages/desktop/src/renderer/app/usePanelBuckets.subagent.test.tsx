import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, useRef, useState } from "react";
import type { SubagentSelection } from "../subagents/SubagentNavigation";
import { ensureMiniDom, renderHook } from "../test-utils/renderHook";
import { bucketKey, type SessionIndex } from "../transcripts";
import type { ViewMode } from "../view";
import { usePanelBuckets } from "./usePanelBuckets";
import { requestComposerSeed } from "../chat/composerSeed";

type Params = Parameters<typeof usePanelBuckets>[0];

const projectId = "subagent-project";
const firstBucket = bucketKey(projectId, "parent-a");
const secondBucket = bucketKey(projectId, "parent-b");
const firstSelection: SubagentSelection = {
  agentId: "child-a",
  parentSessionId: "engine-parent-a",
  label: "Link investigation",
  running: true,
};
const secondSelection: SubagentSelection = {
  agentId: "child-b",
  parentSessionId: "engine-parent-b",
  label: "Authorization investigation",
  running: false,
};

describe("subagent conversation dock requests", () => {
  let oldStorage: PropertyDescriptor | undefined;
  let oldBridge: PropertyDescriptor | undefined;
  let materializedBuckets: string[];
  let hook: Awaited<ReturnType<typeof renderHook<ReturnType<typeof useHarness>>>> | undefined;

  function useHarness() {
    const [reviewDrafts, setReviewDrafts] = useState<Record<string, string>>({});
    const [sessionIndices, setSessionIndices] = useState<Record<string, SessionIndex>>({
      [projectId]: {
        sessions: [
          { id: "parent-a", title: "First conversation", createdAt: 1, updatedAt: 1 },
          { id: "parent-b", title: "Second conversation", createdAt: 1, updatedAt: 1 },
        ],
        activeSessionId: "parent-a",
      },
    });
    const mainSessionId = sessionIndices[projectId]!.activeSessionId;
    const activeBucket = bucketKey(projectId, mainSessionId);
    const activeBucketRef = useRef(activeBucket);
    activeBucketRef.current = activeBucket;
    const sessionIndicesRef = useRef(sessionIndices);
    sessionIndicesRef.current = sessionIndices;
    const [viewMode, setViewMode] = useState<ViewMode>("chat");
    const [quickChatSessions, setQuickChatSessions] = useState<
      Params["quickChat"]["quickChatSessions"]
    >({});
    const quickChatSessionsRef = useRef(quickChatSessions);
    quickChatSessionsRef.current = quickChatSessions;
    const panels = usePanelBuckets({
      sessions: {
        activeBucket,
        activeProjectId: projectId,
        activeBucketRef,
        sessionIndices,
        sessionIndicesRef,
        setSessionIndices,
        materializeActiveSessionForPanel: () => {
          materializedBuckets.push(activeBucketRef.current);
          return activeBucketRef.current;
        },
        appendReviewDraft: (targetBucket, text) => {
          setReviewDrafts((previous) => ({ ...previous, [targetBucket]: text }));
        },
      },
      quickChat: {
        quickChatSessions,
        setQuickChatSessions,
        setQuickChatDrafts: () => {},
        setQuickChatAttachments: () => {},
        quickChatSessionsRef,
      },
      controls: {
        gitReviewAvailable: true,
        engineToBucketRef: useRef(
          new Map([
            ["engine-parent-a", firstBucket],
            ["engine-parent-b", secondBucket],
          ]),
        ),
        setPermissionOverrides: () => {},
        setModelOverrides: () => {},
        defaultPermissionMode: "default",
        quickChatDefaultModelKey: null,
        resolveEngineSessionIdForBucket: (bucket) =>
          bucket === firstBucket ? "engine-parent-a" : "engine-parent-b",
        dispatch: () => {},
        approvalBucketsRef: useRef(new Map()),
        setApprovalQueue: () => {},
        setApproval: () => {},
        setBusyForKey: () => {},
      },
      stream: {
        runningBucketRef: useRef(null),
        coalescersRef: useRef(new Map()),
        coalescerSeqRef: useRef(new Map()),
        appliedSeqRef: useRef(new Map()),
      },
      shell: {
        toast: () => {},
        t: (key) => key,
        setViewMode,
      },
    });

    return {
      ...panels,
      activeBucket,
      mainSessionId,
      sessionIndices,
      viewMode,
      reviewDrafts,
      selectSession(sessionId: string) {
        activeBucketRef.current = bucketKey(projectId, sessionId);
        setSessionIndices((current) => ({
          ...current,
          [projectId]: { ...current[projectId]!, activeSessionId: sessionId },
        }));
      },
    };
  }

  test("does not acknowledge another conversation's late review draft", async () => {
    hook = await renderHook(useHarness);
    await act(async () => {
      hook!.result.current.selectSession("parent-b");
    });
    expect(
      requestComposerSeed({
        source: "code-review",
        text: "A review",
        sessionId: "engine-parent-a",
      }),
    ).toBe(false);
    expect(hook.result.current.reviewDrafts).toEqual({});
  });

  test("preserves an explicitly empty review snapshot while opening its turn", async () => {
    hook = await renderHook(useHarness);
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("codeshell:review-files", { detail: { files: ["a.ts"], diff: "" } }),
      );
    });
    expect(hook.result.current.activePanelState.reviewDiff).toBe("");
  });

  test("keeps an accepted review bound to its bucket when a chat switch is batched", async () => {
    hook = await renderHook(useHarness);
    await act(async () => {
      expect(
        requestComposerSeed({
          source: "code-review",
          text: "A review",
          sessionId: "engine-parent-a",
        }),
      ).toBe(true);
      hook!.result.current.selectSession("parent-b");
    });
    expect(hook.result.current.activeBucket).toBe(secondBucket);
    expect(hook.result.current.reviewDrafts).toEqual({ [firstBucket]: "A review" });
    expect(hook.result.current.composerSeed).toBe("");
  });

  beforeEach(() => {
    ensureMiniDom();
    oldStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    oldBridge = Object.getOwnPropertyDescriptor(window, "codeshell");
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    });
    Object.defineProperty(window, "codeshell", {
      configurable: true,
      value: {
        onBrowserAnchorFromPopout: () => () => {},
        onBrowserAnchorRemoveFromPopout: () => () => {},
        onBrowserAnchorUpdateFromPopout: () => () => {},
        syncBrowserAnchors: () => {},
      },
    });
    materializedBuckets = [];
  });

  afterEach(async () => {
    await hook?.unmount();
    hook = undefined;
    if (oldStorage) Object.defineProperty(globalThis, "localStorage", oldStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
    if (oldBridge) Object.defineProperty(window, "codeshell", oldBridge);
    else Reflect.deleteProperty(window, "codeshell");
  });

  test("opens the current conversation's dock without changing the main conversation", async () => {
    hook = await renderHook(useHarness);
    const originalIndices = hook.result.current.sessionIndices;

    await act(async () => {
      hook!.result.current.openSubagent(firstSelection);
    });

    expect(hook.result.current.activeBucket).toBe(firstBucket);
    expect(hook.result.current.mainSessionId).toBe("parent-a");
    expect(hook.result.current.sessionIndices).toBe(originalIndices);
    expect(hook.result.current.viewMode).toBe("chat");
    expect(materializedBuckets).toEqual([]);
    expect(hook.result.current.activePanelState).toMatchObject({
      open: true,
      requestKind: "subagent",
      requestNonce: 1,
      subagentSelection: firstSelection,
    });
    expect(hook.result.current.panelBuckets).toContain(firstBucket);
  });

  test("missing or blank child IDs never open or modify a dock", async () => {
    hook = await renderHook(useHarness);
    const originalPanels = hook.result.current.panelByBucket;
    const originalIndices = hook.result.current.sessionIndices;

    await act(async () => {
      for (const agentId of [undefined, "", "   "]) {
        hook!.result.current.openSubagent({
          agentId,
          parentSessionId: "engine-parent-a",
          label: "Unresolved child",
        });
      }
    });

    expect(hook.result.current.panelByBucket).toBe(originalPanels);
    expect(hook.result.current.activePanelState.open).toBe(false);
    expect(hook.result.current.sessionIndices).toBe(originalIndices);
    expect(materializedBuckets).toEqual([]);

    await act(async () => {
      hook!.result.current.openSubagent(firstSelection);
    });
    const openedPanels = hook.result.current.panelByBucket;
    const openedState = hook.result.current.activePanelState;
    await act(async () => {
      hook!.result.current.openSubagent({ parentSessionId: "engine-parent-a" });
      hook!.result.current.openSubagent({ agentId: "  " });
    });
    expect(hook.result.current.panelByBucket).toBe(openedPanels);
    expect(hook.result.current.activePanelState).toBe(openedState);
    expect(hook.result.current.activePanelState.subagentSelection).toEqual({
      ...firstSelection,
      navigationNonce: 1,
    });
  });

  test("reissues the same dock request with a new selection and preserves its tabs", async () => {
    hook = await renderHook(useHarness);
    const tabs = [
      { id: "browser-tab", kind: "browser" as const },
      { id: "subagent-tab", kind: "subagent" as const },
    ];
    await act(async () => {
      hook!.result.current.updatePanelBucket(firstBucket, (state) => ({
        ...state,
        tabs,
        activeId: "subagent-tab",
      }));
      hook!.result.current.openSubagent(firstSelection);
    });
    const firstRequest = hook.result.current.activePanelState;
    expect(firstRequest.requestKind).toBe("subagent");

    await act(async () => {
      hook!.result.current.openSubagent({ ...firstSelection, agentId: "child-a-followup" });
    });

    const secondRequest = hook.result.current.activePanelState;
    expect(secondRequest.requestKind).toBe("subagent");
    expect(secondRequest.requestNonce).toBe(firstRequest.requestNonce + 1);
    expect(secondRequest.subagentSelection?.agentId).toBe("child-a-followup");
    expect(secondRequest.subagentSelection?.navigationNonce).toBe(secondRequest.requestNonce);
    expect(secondRequest.tabs).toBe(tabs);
    expect(secondRequest.activeId).toBe("subagent-tab");
    expect(hook.result.current.mainSessionId).toBe("parent-a");
  });

  test("keeps each main conversation's subagent selection in its own dock bucket", async () => {
    hook = await renderHook(useHarness);
    await act(async () => {
      hook!.result.current.openSubagent(firstSelection);
    });
    const firstState = hook.result.current.activePanelState;

    await act(async () => {
      hook!.result.current.selectSession("parent-b");
    });
    expect(hook.result.current.activeBucket).toBe(secondBucket);
    expect(hook.result.current.activePanelState.open).toBe(false);
    expect(hook.result.current.activePanelState.subagentSelection).toBeUndefined();

    await act(async () => {
      hook!.result.current.openSubagent(secondSelection);
    });
    expect(hook.result.current.mainSessionId).toBe("parent-b");
    expect(hook.result.current.activePanelState.subagentSelection).toEqual({
      ...secondSelection,
      navigationNonce: 1,
    });
    expect(hook.result.current.activePanelState.requestNonce).toBe(1);
    expect(hook.result.current.panelByBucket[firstBucket]).toBe(firstState);

    await act(async () => {
      hook!.result.current.selectSession("parent-a");
    });
    expect(hook.result.current.activePanelState).toBe(firstState);
    expect(hook.result.current.activePanelState.subagentSelection).toEqual({
      ...firstSelection,
      navigationNonce: 1,
    });
    expect(hook.result.current.panelByBucket[secondBucket]?.subagentSelection).toEqual({
      ...secondSelection,
      navigationNonce: 1,
    });
  });

  test("routes an existing click callback through the latest active bucket ref", async () => {
    hook = await renderHook(useHarness);
    const openSubagent = hook.result.current.openSubagent;

    await act(async () => {
      hook!.result.current.selectSession("parent-b");
      openSubagent(secondSelection);
    });

    expect(hook.result.current.mainSessionId).toBe("parent-b");
    expect(hook.result.current.activePanelState).toMatchObject({
      open: true,
      requestKind: "subagent",
      subagentSelection: secondSelection,
    });
    expect(hook.result.current.panelByBucket[firstBucket]?.subagentSelection).toBeUndefined();
    expect(materializedBuckets).toEqual([]);
  });

  const cliTask = (overrides: Record<string, unknown> = {}) =>
    new CustomEvent("codeshell:open-cli-session", {
      detail: {
        jobId: "cc-new",
        sourceSessionId: "engine-parent-a",
        cwd: "/repo",
        cliKind: "codex",
        title: "Run tests",
        ...overrides,
      },
    });

  test("a manual request opens a task before its external session id arrives", async () => {
    hook = await renderHook(useHarness);
    await act(async () => {
      window.dispatchEvent(cliTask());
    });
    expect(hook.result.current.activePanelState).toMatchObject({
      open: true,
      requestKind: "ccRoom",
      openCliSession: {
        jobId: "cc-new",
        sourceSessionId: "engine-parent-a",
        title: "Run tests",
        externalSessionId: undefined,
      },
    });
  });

  test("automatic tasks cannot open a closed dock, replace a page, or navigate another chat", async () => {
    hook = await renderHook(useHarness);
    const closed = hook.result.current.activePanelState;
    await act(async () => {
      window.dispatchEvent(cliTask({ autoOpen: true }));
    });
    expect(hook.result.current.activePanelState).toBe(closed);
    expect(hook.result.current.activePanelState.open).not.toBe(true);
    await act(async () => {
      hook!.result.current.openSubagent(firstSelection);
    });
    const initial = hook.result.current.activePanelState;
    await act(async () => {
      window.dispatchEvent(cliTask({ autoOpen: true }));
      window.dispatchEvent(cliTask({ autoOpen: true, sourceSessionId: "engine-parent-b" }));
    });
    expect(hook.result.current.activePanelState).toBe(initial);
    expect(hook.result.current.panelByBucket[secondBucket]?.open).not.toBe(true);
  });

  test("manual cross-chat task links store the page and invoke normal session navigation", async () => {
    hook = await renderHook(useHarness);
    const navigations: unknown[] = [];
    const listener = (event: Event) => navigations.push((event as CustomEvent).detail);
    window.addEventListener("codeshell:open-notification-session", listener);
    try {
      await act(async () => {
        window.dispatchEvent(cliTask({ sourceSessionId: "engine-parent-b" }));
      });
      expect(hook.result.current.panelByBucket[secondBucket]?.openCliSession?.jobId).toBe("cc-new");
      expect(navigations).toEqual([{ sessionId: "engine-parent-b" }]);
    } finally {
      window.removeEventListener("codeshell:open-notification-session", listener);
    }
  });

  test("return to chat closes only the matching task page", async () => {
    hook = await renderHook(useHarness);
    await act(async () => {
      window.dispatchEvent(cliTask());
    });
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("codeshell:return-from-cli-task", {
          detail: { sourceSessionId: "engine-parent-a", jobId: "other" },
        }),
      );
    });
    expect(hook.result.current.activePanelState.open).toBe(true);
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("codeshell:return-from-cli-task", {
          detail: { sourceSessionId: "engine-parent-a", jobId: "cc-new" },
        }),
      );
    });
    expect(hook.result.current.activePanelState.open).toBe(false);
    expect(hook.result.current.activePanelState.openCliSession?.jobId).toBe("cc-new");
  });

  test("malformed task event identity is ignored without throwing", async () => {
    hook = await renderHook(useHarness);
    await act(async () => {
      for (const overrides of [{ jobId: 2 }, { externalSessionId: 42 }, { sourceSessionId: null }])
        window.dispatchEvent(cliTask(overrides));
    });
    expect(hook.result.current.activePanelState.open).toBe(false);
  });
});
