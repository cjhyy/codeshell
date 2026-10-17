import assert from "node:assert/strict";

/** Fixture response timing only. Always calls the original production listener;
 * returns its exact result or throws its exact rejection. No IPC/process authority. */
export function createReviewDraftResponseGate(sessionIds, { onRecord = () => {} } = {}) {
  assert.ok(Array.isArray(sessionIds) && sessionIds.length === 2);
  assert.ok(sessionIds.every((id) => typeof id === "string" && id.length > 0));
  assert.equal(new Set(sessionIds).size, 2);
  const allowed = new Set(sessionIds);
  const calls = [],
    violations = [];
  let hold,
    closed = false;
  const notify = (kind, row = {}) => {
    try {
      // A diagnostic observer cannot block or replace the original listener.
      if (onRecord({ kind, ...row }) !== undefined && violations.length < 16)
        violations.push("Review IPC diagnostic sink must be synchronous");
    } catch {
      if (violations.length < 16) violations.push("Review IPC diagnostic recording failed");
    }
  };
  const refuse = (message) => {
    if (violations.length < 16) violations.push(message);
    notify("violation", { message });
    throw new Error(message);
  };
  const selector = (sessionId, mode) => {
    if (!allowed.has(sessionId) || !["staged", "unstaged"].includes(mode))
      refuse("Unexpected owned Review Session/scope");
  };
  return {
    arm(sessionId, mode) {
      selector(sessionId, mode);
      if (closed || hold) refuse("Review response hold is unavailable");
      let release;
      const wait = new Promise((done) => {
        release = done;
      });
      hold = { sessionId, mode, status: "armed", callId: null, wait, release };
      notify("response-armed", { sessionId, mode });
    },
    async invoke(listener, args) {
      if (closed) refuse("Review response gate is closed");
      const sessionId = args[1],
        request = args[2];
      selector(sessionId, request?.scope?.mode);
      if (
        request?.kind !== "git" ||
        request.scope.kind !== "working" ||
        typeof request.instructions !== "string" ||
        request.instructions.length > 2000
      )
        refuse("Unexpected owned Review request");
      if (calls.length >= 5) refuse("Unexpected extra Review preparation");
      const selected = hold;
      if (
        selected &&
        (selected.status !== "armed" ||
          selected.sessionId !== sessionId ||
          selected.mode !== request.scope.mode)
      )
        refuse("Review hold does not match the actual request");
      const row = {
        id: calls.length + 1,
        sessionId,
        request: {
          kind: request.kind,
          scope: { ...request.scope },
          instructions: request.instructions,
        },
        held: !!selected,
        status: "calling",
        response: null,
      };
      calls.push(row);
      notify("request", { id: row.id, sessionId, request: row.request });
      if (selected) {
        selected.status = "calling";
        selected.callId = row.id;
      }
      try {
        const result = await listener(...args);
        if (
          typeof result?.prompt !== "string" ||
          !result.prompt.trim() ||
          result.prompt.length > 32768 ||
          typeof result.truncated !== "boolean"
        )
          refuse("Invalid production Review prompt result");
        row.response = { prompt: result.prompt, truncated: result.truncated };
        notify("production-result", { id: row.id, sessionId, response: row.response });
        if (selected) {
          row.status = "held-after-production-result";
          selected.status = "held-after-production-result";
          await selected.wait;
          if (hold === selected) hold = undefined;
        }
        row.status = "returned";
        notify("returned", { id: row.id, sessionId });
        return result;
      } catch (error) {
        row.status = "rejected";
        if (hold === selected) hold = undefined;
        // Preserve the actual rejection. Only fixed metadata enters the ledger.
        row.rejected = true;
        notify("production-rejected", { id: row.id, sessionId });
        throw error;
      }
    },
    release(callId) {
      if (!hold || hold.status !== "held-after-production-result" || hold.callId !== callId)
        refuse("No completed production Review result matches this release");
      hold.status = "released";
      notify("response-released", { id: callId });
      hold.release();
    },
    close() {
      closed = true;
      notify("gate-closed");
      if (hold) {
        if (violations.length < 16) violations.push("Unsettled Review response at fixture cleanup");
        hold.release();
        hold = undefined;
      }
    },
    snapshot() {
      return {
        closed,
        hold: hold
          ? { sessionId: hold.sessionId, mode: hold.mode, status: hold.status, callId: hold.callId }
          : null,
        calls: calls.map((row) => ({
          ...row,
          request: { ...row.request, scope: { ...row.request.scope } },
          response: row.response ? { ...row.response } : null,
        })),
        violations: [...violations],
      };
    },
  };
}
