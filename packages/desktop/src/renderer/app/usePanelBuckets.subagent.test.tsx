import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, useRef, useState } from "react";
import type { SubagentSelection } from "../subagents/SubagentNavigation";
import { ensureMiniDom, renderHook } from "../test-utils/renderHook";
import { bucketKey, type SessionIndex } from "../transcripts";
import type { ViewMode } from "../view";
import { usePanelBuckets } from "./usePanelBuckets";

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
        engineToBucketRef: useRef(new Map()),
        setPermissionOverrides: () => {},
        setModelOverrides: () => {},
        defaultPermissionMode: "default",
        quickChatDefaultModelKey: null,
        resolveEngineSessionIdForBucket: () => undefined,
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
      selectSession(sessionId: string) {
        activeBucketRef.current = bucketKey(projectId, sessionId);
        setSessionIndices((current) => ({
          ...current,
          [projectId]: { ...current[projectId]!, activeSessionId: sessionId },
        }));
      },
    };
  }

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
    expect(hook.result.current.activePanelState.subagentSelection).toEqual(secondSelection);
    expect(hook.result.current.activePanelState.requestNonce).toBe(1);
    expect(hook.result.current.panelByBucket[firstBucket]).toBe(firstState);

    await act(async () => {
      hook!.result.current.selectSession("parent-a");
    });
    expect(hook.result.current.activePanelState).toBe(firstState);
    expect(hook.result.current.activePanelState.subagentSelection).toEqual(firstSelection);
    expect(hook.result.current.panelByBucket[secondBucket]?.subagentSelection).toEqual(
      secondSelection,
    );
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
});
