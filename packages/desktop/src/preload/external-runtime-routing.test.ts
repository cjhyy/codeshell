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

/** The routing rule as implemented in preload's `cancel`. */
function routeCancel(
  sessionId: string | undefined,
  externalSessions: Set<string>,
): "runtime-interrupt" | "worker-cancel" {
  if (sessionId && externalSessions.has(sessionId)) return "runtime-interrupt";
  return "worker-cancel";
}

/** The routing rule as implemented in preload's `approve`. */
function routeApprove(
  requestId: string,
  externalApprovalIds: Set<string>,
): "main-decision" | "worker-approve" {
  return externalApprovalIds.has(requestId) ? "main-decision" : "worker-approve";
}

describe("preload cancel routing", () => {
  test("an external session's Stop interrupts the runtime", () => {
    // The bug this guards: agent/cancel goes to a worker that does not exist,
    // so Stop is a no-op and the model keeps streaming.
    const external = new Set(["sess-codex"]);
    expect(routeCancel("sess-codex", external)).toBe("runtime-interrupt");
  });

  test("a native session's Stop still goes to the worker", () => {
    // The other direction matters just as much — misrouting a native Stop
    // would break the feature everyone uses.
    expect(routeCancel("sess-native", new Set(["sess-codex"]))).toBe("worker-cancel");
  });

  test("no session id falls through to the worker", () => {
    // Legacy single-session callers pass undefined.
    expect(routeCancel(undefined, new Set(["sess-codex"]))).toBe("worker-cancel");
  });

  test("a stopped session stops being routed to the runtime", () => {
    // `stop()` removes the id. Leaving it would send interrupts to a runtime
    // that is gone, and — worse — never fall back to the worker if the id is
    // later reused by a native session.
    const external = new Set(["sess-codex"]);
    external.delete("sess-codex");
    expect(routeCancel("sess-codex", external)).toBe("worker-cancel");
  });
});

describe("preload approve routing", () => {
  test("an external prompt is answered to main", () => {
    expect(routeApprove("external-approval-1", new Set(["external-approval-1"]))).toBe(
      "main-decision",
    );
  });

  test("a native prompt still goes over agent/approve", () => {
    expect(routeApprove("worker-req-1", new Set(["external-approval-1"]))).toBe("worker-approve");
  });

  test("an answered prompt is forgotten, so a reused id is not misrouted", () => {
    const ids = new Set(["external-approval-1"]);
    ids.delete("external-approval-1");
    expect(routeApprove("external-approval-1", ids)).toBe("worker-approve");
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

  test("cancel checks the external-session set before falling back to the worker", () => {
    const start = source.indexOf("  cancel: (sessionId?: string)");
    // Anchor the end on the rpc CALL, not the string "agent/cancel" — that also
    // appears in the explanatory comment above it, which would truncate the
    // slice before the branch and make this test fail on correct code.
    const cancelBody = source.slice(start, source.indexOf('rpc("agent/cancel"', start) + 40);
    expect(cancelBody).toContain("externalRuntimeSessions.has(sessionId)");
    expect(cancelBody).toContain("externalRuntime:interrupt");
    // The membership check must come FIRST; after the rpc it is dead code.
    expect(cancelBody.indexOf("externalRuntimeSessions.has")).toBeLessThan(
      cancelBody.indexOf('rpc("agent/cancel"'),
    );
  });

  test("start records the session, or cancel can never match it", () => {
    // The pairing is the load-bearing part: a `start` that forgets to record
    // leaves Stop broken with no other symptom.
    expect(source).toContain("externalRuntimeSessions.add(payload.sessionId)");
    expect(source).toContain("externalRuntimeSessions.delete(sessionId)");
  });

  test("approve checks the external-approval set before the worker rpc", () => {
    const approveIdx = source.indexOf("externalApprovalIds.has(requestId)");
    const rpcIdx = source.indexOf('rpc("agent/approve"');
    expect(approveIdx).toBeGreaterThan(-1);
    expect(approveIdx).toBeLessThan(rpcIdx);
  });
});
