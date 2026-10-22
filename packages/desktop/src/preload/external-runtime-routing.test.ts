/**
 * Preload routing for external-runtime sessions.
 *
 * Two renderer actions look backend-agnostic but are not: Stop (`cancel`) and
 * answering an approval both travel to the WORKER on the native path, and an
 * external session has no worker. Getting this wrong is silent in both cases —
 * Stop appears to do nothing while the model keeps streaming, and an approval
 * answer vanishes so the tool call hangs.
 *
 * The real preload imports `electron`, so this exercises the routing decision
 * itself rather than the module: the logic is a set membership test, and the
 * regression to guard is "the branch is missing", not "the ipc call is shaped
 * wrong".
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/** The routing rule as implemented in preload's `approve`. */
function routeApprove(
  requestId: string,
  externalApprovalIds: Set<string>,
): "main-decision" | "worker-approve" {
  return externalApprovalIds.has(requestId) || requestId.startsWith("external-approval-")
    ? "main-decision"
    : "worker-approve";
}

describe("preload approve routing", () => {
  test("an external prompt is answered to main", () => {
    expect(routeApprove("external-approval-1", new Set(["external-approval-1"]))).toBe(
      "main-decision",
    );
  });

  test("a native prompt still goes over agent/approve", () => {
    expect(routeApprove("worker-req-1", new Set(["external-approval-1"]))).toBe("worker-approve");
  });

  test("a click after resolution still asks the external owner to reject the expired id", () => {
    const ids = new Set(["external-approval-1"]);
    ids.delete("external-approval-1");
    expect(routeApprove("external-approval-1", ids)).toBe("main-decision");
    expect(routeApprove("worker-request", ids)).toBe("worker-approve");
  });
});

/**
 * The tests above model the rule; these assert the SHIPPED code implements it.
 *
 * That distinction is the whole point here. A model-only test passes happily
 * while the real `cancel` has no branch at all — which is exactly the bug that
 * shipped: `interrupt` existed in preload and nothing ever called it. So this
 * reads the source and checks the branches are present and correctly ordered.
 */
describe("the shipped preload actually routes", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

  test("cancel asks Main which backend owns the session before the worker rpc", () => {
    // Behaviour is covered in external-runtime-cancel.test.ts; this pins the
    // wiring, so Stop cannot silently regress to preload-memory routing that
    // a renderer reload empties (E05).
    const start = source.indexOf("  cancel: (sessionId?: string");
    const cancelBody = source.slice(start, source.indexOf('rpc("agent/cancel"', start) + 40);
    expect(cancelBody.replace(/\s+/g, " ")).toContain("cancelSessionRun( ipcRenderer,");
    expect(cancelBody).not.toContain("externalRuntimeSessions.has");
  });

  test("start and stop keep the replay set for late session-state subscribers", () => {
    expect(source).toContain("externalRuntimeSessions.add(payload.sessionId)");
    expect(source).toContain("externalRuntimeSessions.delete(sessionId)");
  });

  test("approve checks the external-approval set before the worker rpc", () => {
    const approveIdx = source.indexOf("externalApprovalIds.has(requestId)");
    const rpcIdx = source.indexOf('rpc("agent/approve"');
    expect(approveIdx).toBeGreaterThan(-1);
    expect(approveIdx).toBeLessThan(rpcIdx);
  });

  test("external prompts retain their lifecycle source in the shared approval channel", () => {
    const handler = source.slice(
      source.indexOf('"externalRuntime:approvalRequest"'),
      source.indexOf('"externalRuntime:approvalRequest"') + 800,
    );
    expect(handler).toContain('source: "external-runtime"');
    expect(handler).toContain("externalApprovalIds.add(requestId)");
    expect(handler).toContain("approvalListeners.forEach");
  });

  test("external answers await acceptance and expired ids cannot fall through to the worker", () => {
    const handler = source.slice(
      source.indexOf("externalApprovalIds.has(requestId)"),
      source.indexOf('return rpc("agent/approve"'),
    );
    expect(handler).toContain('requestId.startsWith("external-approval-")');
    expect(handler).toContain('.invoke("externalRuntime:approvalDecision"');
    expect(handler).toContain("if (!result?.ok)");
    expect(handler).not.toContain("Promise.resolve({ ok: true })");
  });

  test("restored external requests are registered before renderer replay and resolutions retire them", () => {
    const recovery = source.slice(
      source.indexOf("  getPendingApprovals:"),
      source.indexOf("  onApprovalRequest:"),
    );
    expect(recovery).toContain('env?.source === "external-runtime"');
    expect(recovery.indexOf("externalApprovalIds.add(env.requestId)")).toBeLessThan(
      recovery.indexOf("return pending"),
    );
    const resolved = source.slice(
      source.indexOf('"externalRuntime:approvalResolved"'),
      source.indexOf('"externalRuntime:approvalResolved"') + 600,
    );
    expect(resolved).toContain("externalApprovalIds.delete(requestId)");
    expect(resolved).toContain("approvalResolvedListeners.forEach");
    const main = readFileSync(new URL("../main/index.ts", import.meta.url), "utf8");
    const pending = main.slice(
      main.indexOf('ipcMain.handle("agent:pendingApprovals"'),
      main.indexOf('ipcMain.handle("agent:subscribe"'),
    );
    expect(pending).toContain("pendingForWindow(event.sender.id)");
    expect(main).toContain("externalRuntimeApprovals?.cancelWindow(ownerWebContentsId)");
  });
});
