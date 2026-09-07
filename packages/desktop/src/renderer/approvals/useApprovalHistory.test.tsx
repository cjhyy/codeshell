import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ApprovalHistoryEntry } from "../app/appUtils";
import { ensureMiniDom, flushMicrotasks, renderHook } from "../test-utils/renderHook";
import {
  APPROVAL_HISTORY_LIMIT,
  APPROVAL_HISTORY_STORAGE_KEY,
  loadApprovalHistory,
  saveApprovalHistory,
  useApprovalHistory,
} from "./useApprovalHistory";

ensureMiniDom();
const { ApprovalsView } = await import("./ApprovalsView");

function entry(id: string, decision: "approve" | "deny" = "approve"): ApprovalHistoryEntry {
  return {
    decision,
    at: 1_800_000_000_000,
    reason: decision === "deny" ? "Keep the existing file" : undefined,
    envelope: {
      sessionId: "session-1",
      requestId: id,
      request: {
        toolName: "Bash",
        args: { command: `command-${id}` },
        description: "Run a command",
        riskLevel: "medium",
      },
    },
  };
}

function allNodes(node: any): any[] {
  return [node, ...Array.from(node.childNodes ?? []).flatMap(allNodes)];
}

function textOf(node: any): string {
  if (node.nodeType === 3) return node.data ?? node.textContent ?? "";
  const children = Array.from(node.childNodes ?? []);
  return children.length ? children.map(textOf).join("") : (node.textContent ?? "");
}

describe("persistent approval history", () => {
  let storageBefore: PropertyDescriptor | undefined;
  let bridgeBefore: PropertyDescriptor | undefined;
  let data: Map<string, string>;
  let hook: Awaited<ReturnType<typeof renderHook<ReturnType<typeof useApprovalHistory>>>> | null;
  let root: Root | null;
  let approvalCalls: unknown[][];

  beforeEach(() => {
    ensureMiniDom();
    storageBefore = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    bridgeBefore = Object.getOwnPropertyDescriptor(window, "codeshell");
    data = new Map();
    hook = null;
    root = null;
    approvalCalls = [];
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => data.get(key) ?? null,
        setItem: (key: string, value: string) => data.set(key, value),
      },
    });
    Object.defineProperty(window, "codeshell", {
      configurable: true,
      value: { approve: (...args: unknown[]) => approvalCalls.push(args) },
    });
  });

  afterEach(async () => {
    await hook?.unmount();
    await act(async () => root?.unmount());
    if (storageBefore) Object.defineProperty(globalThis, "localStorage", storageBefore);
    else Reflect.deleteProperty(globalThis, "localStorage");
    if (bridgeBefore) Object.defineProperty(window, "codeshell", bridgeBefore);
    else Reflect.deleteProperty(window, "codeshell");
  });

  test("retains old decisions and new approvals/denials across renderer remounts", async () => {
    const old = entry("old");
    saveApprovalHistory([old]);
    hook = await renderHook(useApprovalHistory);
    expect(hook.result.current[0]).toEqual([old]);
    const approved = entry("approved");
    const denied = entry("denied", "deny");
    await act(async () => hook!.result.current[1]((history) => [...history, approved, denied]));
    await hook.unmount();

    hook = await renderHook(useApprovalHistory);
    expect(hook.result.current[0]).toEqual([old, approved, denied]);
    expect(approvalCalls).toEqual([]);
  });

  test.each(["{bad JSON", "null", "{}", '"text"'])(
    "ignores corrupt or non-list history: %s",
    (raw) => {
      data.set(APPROVAL_HISTORY_STORAGE_KEY, raw);
      expect(loadApprovalHistory()).toEqual([]);
    },
  );

  test("ignores invalid individual records and pending requests without hiding valid decisions", () => {
    const valid = entry("valid");
    data.set(
      APPROVAL_HISTORY_STORAGE_KEY,
      JSON.stringify([
        null,
        valid,
        { ...valid, decision: "pending" },
        { ...valid, at: 1e100 },
        { ...valid, at: "yesterday" },
        { ...valid, reason: {} },
        { ...valid, envelope: { ...valid.envelope, requestId: null } },
        { ...valid, envelope: { ...valid.envelope, sessionId: 123 } },
        { ...valid, envelope: { ...valid.envelope, request: null } },
        {
          ...valid,
          envelope: { ...valid.envelope, request: { ...valid.envelope.request, args: [] } },
        },
      ]),
    );
    expect(loadApprovalHistory()).toEqual([valid]);
  });

  test("restores older worker requests without description or risk metadata", () => {
    const legacy = entry("legacy");
    const { toolName, args } = legacy.envelope.request;
    const withoutMetadata = {
      ...legacy,
      envelope: { ...legacy.envelope, request: { toolName, args } },
    };
    const withoutArgs = {
      ...legacy,
      envelope: { ...legacy.envelope, request: { toolName } },
    };
    data.set(APPROVAL_HISTORY_STORAGE_KEY, JSON.stringify([withoutMetadata, withoutArgs]));
    expect(loadApprovalHistory()).toEqual([withoutMetadata, withoutArgs]);
  });

  test("bounds persisted and restored history while preserving recent decisions in order", () => {
    const history = Array.from({ length: APPROVAL_HISTORY_LIMIT + 5 }, (_, i) => entry(String(i)));
    const expected = history.slice(5);
    saveApprovalHistory(history);
    expect(JSON.parse(data.get(APPROVAL_HISTORY_STORAGE_KEY)!)).toEqual(expected);
    data.set(APPROVAL_HISTORY_STORAGE_KEY, JSON.stringify(history));
    expect(loadApprovalHistory()).toEqual(expected);
    expect(history).toHaveLength(APPROVAL_HISTORY_LIMIT + 5);
  });

  test("still accepts a decision in memory when browser storage is unavailable", async () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get: () => {
        throw new Error("Storage is unavailable");
      },
    });
    hook = await renderHook(useApprovalHistory);
    const approved = entry("approved");
    await act(async () => hook!.result.current[1]([approved]));
    expect(hook.result.current[0]).toEqual([approved]);
  });

  test("restores display-only history without pending cards or changes to permission grants", async () => {
    const permissionKey = "codeshell.overrides.permission";
    const permissions = JSON.stringify({ "project::session-1": "default" });
    data.set(permissionKey, permissions);
    saveApprovalHistory([entry("approved"), entry("denied", "deny")]);
    const decisions: unknown[][] = [];
    function HistoryPage() {
      const [history] = useApprovalHistory();
      return (
        <ApprovalsView queue={[]} history={history} onDecide={(...args) => decisions.push(args)} />
      );
    }
    const container = document.createElement("div");
    root = createRoot(container);
    await act(async () => {
      root!.render(<HistoryPage />);
      await flushMicrotasks();
    });
    const sections = allNodes(container).filter((node) => node.tagName === "SECTION");
    expect(allNodes(sections[0]).filter((node) => node.tagName === "LI")).toHaveLength(0);
    expect(allNodes(sections[1]).filter((node) => node.tagName === "LI")).toHaveLength(2);
    expect(textOf(sections[1])).toContain("command-approved");
    expect(textOf(sections[1])).toContain("Keep the existing file");
    expect(allNodes(container).filter((node) => node.tagName === "BUTTON")).toHaveLength(0);
    expect(decisions).toEqual([]);
    expect(approvalCalls).toEqual([]);
    expect(data.get(permissionKey)).toBe(permissions);
  });
});
