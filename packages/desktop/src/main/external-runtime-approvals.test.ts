/**
 * An approval router's failure modes are asymmetric: denying when it should
 * have asked is an annoyance, approving when it could not ask is a security
 * hole. Every "cannot ask" path below is asserted to deny.
 */
import { describe, expect, test } from "bun:test";
import { ExternalRuntimeApprovals } from "./external-runtime-approvals.js";

interface FakeWindow {
  isDestroyed(): boolean;
  webContents: { id: number; send(channel: string, payload: unknown): void };
}

function fakeWindow(id: number, sent: Array<{ channel: string; payload: unknown }> = []) {
  const window: FakeWindow = {
    isDestroyed: () => false,
    webContents: { id, send: (channel, payload) => void sent.push({ channel, payload }) },
  };
  return { window, sent };
}

function router(windows: FakeWindow[], owner?: (sessionId: string) => number | undefined) {
  return new ExternalRuntimeApprovals({
    windows: () => windows as never,
    ...(owner ? { ownerWebContentsId: owner } : {}),
  });
}

const request = { toolName: "Bash", riskLevel: "high" as const };

describe("ExternalRuntimeApprovals", () => {
  test("sends the prompt to the renderer and resolves with the decision", async () => {
    const { window, sent } = fakeWindow(1);
    const approvals = router([window]);

    const pending = approvals.request("sess-1", request);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.channel).toBe("externalRuntime:approvalRequest");

    const payload = sent[0]!.payload as { requestId: string; sessionId: string };
    expect(payload.sessionId).toBe("sess-1");
    expect(approvals.settle(payload.requestId, { approved: true })).toBe(true);
    await expect(pending).resolves.toMatchObject({ approved: true });
  });

  test("denies when there is no window to ask", async () => {
    // The important direction: unable to prompt must never mean "allowed".
    const approvals = router([]);
    const decision = await approvals.request("sess-1", request);
    expect(decision.approved).toBe(false);
    expect(decision.reason).toMatch(/no window/i);
  });

  test("ignores destroyed windows", async () => {
    const dead: FakeWindow = {
      isDestroyed: () => true,
      webContents: { id: 9, send: () => throwIfCalled() },
    };
    function throwIfCalled(): never {
      throw new Error("sent to a destroyed window");
    }
    const approvals = router([dead]);
    await expect(approvals.request("sess-1", request)).resolves.toMatchObject({ approved: false });
  });

  test("prefers the session's owning window", () => {
    const a = fakeWindow(1);
    const b = fakeWindow(2);
    const approvals = router([a.window, b.window], () => 2);
    void approvals.request("sess-1", request);
    expect(a.sent).toHaveLength(0);
    expect(b.sent).toHaveLength(1);
  });

  test("falls back to another window when the owner is gone", () => {
    // Unlike Panel.invoke, prompting the "wrong" window is safe — the user can
    // decline. Broadcasting a mutating tool would EXECUTE it per window.
    const a = fakeWindow(1);
    const approvals = router([a.window], () => 999);
    void approvals.request("sess-1", request);
    expect(a.sent).toHaveLength(1);
  });

  test("settling an unknown id is ignored, not an error", () => {
    const approvals = router([fakeWindow(1).window]);
    expect(approvals.settle("nope", { approved: true })).toBe(false);
  });

  test("a second decision for the same prompt is ignored", async () => {
    const { window, sent } = fakeWindow(1);
    const approvals = router([window]);
    const pending = approvals.request("sess-1", request);
    const { requestId } = sent[0]!.payload as { requestId: string };

    expect(approvals.settle(requestId, { approved: true })).toBe(true);
    // A duplicate must not flip an already-granted decision, nor throw.
    expect(approvals.settle(requestId, { approved: false })).toBe(false);
    await expect(pending).resolves.toMatchObject({ approved: true });
  });

  test("closing a session denies its pending prompts", async () => {
    // Otherwise the tool call behind the prompt stays parked forever, holding
    // whatever it acquired, with no runtime left to consume an answer.
    const { window, sent } = fakeWindow(1);
    const approvals = router([window]);
    const pending = approvals.request("sess-1", request);
    expect(approvals.pendingCount).toBe(1);

    approvals.cancelSession("sess-1");
    await expect(pending).resolves.toMatchObject({ approved: false });
    expect(approvals.pendingCount).toBe(0);
    expect(sent).toHaveLength(1);
  });

  test("closing one session leaves another's prompt alone", async () => {
    const { window, sent } = fakeWindow(1);
    const approvals = router([window]);
    const keep = approvals.request("sess-keep", request);
    void approvals.request("sess-drop", request);

    approvals.cancelSession("sess-drop");
    expect(approvals.pendingCount).toBe(1);

    const kept = sent[0]!.payload as { requestId: string };
    approvals.settle(kept.requestId, { approved: true });
    await expect(keep).resolves.toMatchObject({ approved: true });
  });

  test("carries the decision details back verbatim", async () => {
    // scope / pathScope drive "don't ask again" — dropping them silently would
    // make the user re-answer every call.
    const { window, sent } = fakeWindow(1);
    const approvals = router([window]);
    const pending = approvals.request("sess-1", request);
    const { requestId } = sent[0]!.payload as { requestId: string };
    approvals.settle(requestId, { approved: true, scope: "session", pathScope: "dir" });
    await expect(pending).resolves.toEqual({
      approved: true,
      scope: "session",
      pathScope: "dir",
    });
  });
});
