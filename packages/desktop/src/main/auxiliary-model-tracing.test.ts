import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, UsageLedger, withUsageOwner } from "@cjhyy/code-shell-core";
import {
  ModelTraceStore,
  recordModelTraceEvent,
  withModelTraceContext,
} from "@cjhyy/code-shell-core/internal";
import { usageOwnerFor, withDesktopSessionModelTrace } from "./auxiliary-model-tracing.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "auxiliary-model-trace-"));
  roots.push(root);
  return {
    root,
    sessions: new SessionManager(root),
    store: new ModelTraceStore({ storageDir: join(root, ".model-traces") }),
  };
}
const event = () =>
  recordModelTraceEvent({
    kind: "lifecycle",
    name: "fixture auxiliary request",
    startedAt: Date.now(),
    status: "completed",
  })!;

test("auxiliary session generation uses its source transcript's workspace and store, without borrowing another caller's run", async () => {
  const { root, sessions, store } = fixture();
  const other = fixture();
  sessions.create("/workspace/actual-source", "fixture", "fixture", "source");
  const ledger = new UsageLedger();
  const captured = await withUsageOwner(
    ledger.owner("billing-caller", "billing-run", ["billing-parent"], "main"),
    () =>
      withModelTraceContext(
        {
          storageDir: join(other.root, ".model-traces"),
          workspacePath: "/workspace/unrelated-caller",
          sessionId: "unrelated",
          runId: "unrelated-run",
          parentSessionId: "unrelated-parent",
          ephemeral: true,
        },
        () =>
          withDesktopSessionModelTrace(root, "source", "session_follow_up", async () => {
            await Promise.resolve();
            return event();
          }),
      ),
  );
  expect(captured).toMatchObject({
    sessionId: "source",
    workspacePath: "/workspace/actual-source",
    status: "completed",
  });
  expect(captured.runId).toBeUndefined();
  expect(captured.traceId).not.toBe("unrelated-run");
  expect(captured.traceId).not.toBe("billing-run");
  expect(store.events(captured.traceId)).toHaveLength(1);
  expect(other.store.events(captured.traceId)).toHaveLength(0);
});

test("temporary auxiliary sources obey the independent ephemeral switch; an unknown source never inherits the active workspace", () => {
  const { root, sessions, store } = fixture();
  store.setConfig({ includeEphemeral: false });
  sessions.create("/workspace/temporary", "fixture", "fixture", "qchat-helper");
  const temporary = withDesktopSessionModelTrace(root, "qchat-helper", "fixture", event);
  expect(temporary.workspacePath).toBe("/workspace/temporary");
  expect(store.events(temporary.traceId)).toHaveLength(0);
  store.setConfig({ includeEphemeral: true });
  const enabled = withDesktopSessionModelTrace(root, "qchat-helper", "fixture", event);
  expect(store.events(enabled.traceId)).toHaveLength(1);
  const unknown = withModelTraceContext(
    { workspacePath: "/workspace/active", runId: "active-run" },
    () => withDesktopSessionModelTrace(root, "unknown-source", "fixture", event),
  );
  expect(unknown.workspacePath).toBeUndefined();
  expect(unknown.runId).toBeUndefined();
});

test("helper usage is charged to the source Session's ledger under an auxiliary purpose", () => {
  const { root, sessions } = fixture();
  sessions.create("/workspace/mimi", "fixture", "fixture", "mimi-source");
  const writer = new UsageLedger({ storageDir: join(root, ".usage-ledger") });
  const reference = writer.sessionReference("mimi-source", root);
  sessions.updateSessionState("mimi-source", { costState: reference });
  const state = sessions.readSessionState("mimi-source");
  const owner = usageOwnerFor(root, "mimi-source", state, "pet_notice_reply");
  expect(owner).toMatchObject({
    sessionId: "mimi-source",
    accountingSessionId: reference.accountingSessionId,
    purpose: "aux_summary",
  });
  expect(owner?.runId).toBeUndefined();
  expect(usageOwnerFor(root, "mimi-source", state, "goal_judge")?.purpose).toBe("goal_judge");
});

test("a source without a ledger reference keeps tracing and gets no owner", () => {
  const { root, sessions } = fixture();
  sessions.create("/workspace/plain", "fixture", "fixture", "plain-source");
  expect(
    usageOwnerFor(root, "plain-source", sessions.readSessionState("plain-source"), "pet_brief"),
  ).toBe(undefined);
  expect(withDesktopSessionModelTrace(root, "plain-source", "pet_brief", () => "result")).toBe(
    "result",
  );
});
