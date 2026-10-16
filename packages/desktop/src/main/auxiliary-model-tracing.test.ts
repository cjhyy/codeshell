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
import { withDesktopSessionModelTrace } from "./auxiliary-model-tracing.js";

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
