import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { StreamEvent } from "@cjhyy/code-shell-core";
import { SessionManager } from "../../../core/src/session/session-manager.js";
import { SessionOutputJournal } from "../../../core/src/session/output-journal.js";
import { MainOutputPublisher } from "./main-output-publisher";
import { SessionSnapshotStore } from "./SessionSnapshotStore";
import { publishOwnedExternalStream } from "./owned-external-stream";
import { snapshotHasUnfinishedTopLevelTurn } from "../renderer/snapshotReplay";

test.each(["turn_complete", "error"] as const)(
  "a committed native %s arriving after external takeover retains successor snapshot liveness and cursor",
  (type) => {
    const root = mkdtempSync(join(tmpdir(), "codeshell-snapshot-source-fence-"));
    const sessionId = "source-switch";
    const manager = new SessionManager(root);
    const bundle = manager.create(root, "fixture", "fixture", sessionId);
    const firstUser = bundle.transcript.appendMessage("user", "Native run");
    manager.startSessionRun(bundle.state, firstUser.id, "input-A");
    const firstJournal = new SessionOutputJournal(
      root,
      sessionId,
      firstUser.id,
      bundle.transcript.getEvents()[0].id,
    );
    const snapshots = new SessionSnapshotStore({ maxPerSession: 2 });
    const main = new MainOutputPublisher({
      root: () => root,
      latest: () => snapshots.get(sessionId).outputCursor,
      worker: (id, event) => {
        snapshots.append(id, event);
        return true;
      },
    });
    const committed = (journal: SessionOutputJournal, event: StreamEvent) => ({
      ...event,
      outputCursor: journal.append(event),
    });
    const start = committed(firstJournal, {
      type: "session_started",
      sessionId,
      runId: firstUser.id,
      clientMessageId: "input-A",
      promptTokens: 0,
    });
    const lateTerminal = committed(
      firstJournal,
      type === "error"
        ? { type, error: "Native failure", runId: firstUser.id, clientMessageId: "input-A" }
        : { type, reason: "completed", runId: firstUser.id, clientMessageId: "input-A" },
    );
    try {
      expect(main.observeWorker(sessionId, start)).toBe(true);
      snapshots.append(sessionId, start);
      manager.updateSessionState(sessionId, { status: "completed" }, firstUser.id);
      const secondUser = bundle.transcript.appendMessage("user", "External successor");
      manager.startSessionRun(manager.readSessionState(sessionId)!, secondUser.id, "input-B");
      const secondJournal = new SessionOutputJournal(root, sessionId, secondUser.id, firstUser.id);
      const secondStart = committed(secondJournal, {
        type: "session_started",
        sessionId,
        runId: secondUser.id,
        clientMessageId: "input-B",
        promptTokens: 0,
      });
      publishOwnedExternalStream(snapshots, [], undefined, sessionId, secondStart);
      const secondText = committed(secondJournal, {
        type: "text_delta",
        text: "Still working",
        runId: secondUser.id,
        clientMessageId: "input-B",
      });
      publishOwnedExternalStream(snapshots, [], undefined, sessionId, secondText);
      // A was durably complete before B claimed the Session. Its delayed live
      // notification is still valid output and must remain in the replay suffix.
      expect(main.observeWorker(sessionId, lateTerminal)).toBe(true);
      snapshots.append(sessionId, lateTerminal);
      const snapshot = snapshots.get(sessionId);
      expect(snapshot.events.map(({ event }) => (event as StreamEvent).runId)).toEqual([
        secondUser.id,
        firstUser.id,
      ]);
      expect(snapshot.topLevelRunning).toBe(true);
      expect(snapshot.outputCursor).toBe(secondText.outputCursor);
      expect(snapshotHasUnfinishedTopLevelTurn(snapshot)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
