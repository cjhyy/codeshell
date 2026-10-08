import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { SessionManager, sessionsRoot } from "@cjhyy/code-shell-core";
import { SessionOutputJournal } from "@cjhyy/code-shell-core/internal";
import { registerSessionTranscriptIpc } from "./session-transcript-ipc.js";
import { SessionSnapshotStore } from "./SessionSnapshotStore.js";
import { recoverDesktopOutputJournal } from "../renderer/app/outputJournalRecovery.js";

test("actual Main IPC recovers output evicted from the snapshot and survives Main restart", async () => {
  const root = sessionsRoot();
  const id = `journal-main-${Date.now()}-${Math.floor(Math.random() * 1e8)}`;
  const manager = new SessionManager(root);
  const session = manager.create(root, "fixture", "fixture", id);
  manager.startSessionRun(session.state, "run");
  const writer = new SessionOutputJournal(root, id, "run", session.transcript.getEvents()[0].id);
  const snapshots = new SessionSnapshotStore({ maxPerSession: 2 });
  const handlers = new Map<string, (...args: any[]) => any>();
  registerSessionTranscriptIpc({
    handle: (channel, listener) => {
      handlers.set(channel, listener);
    },
  });
  const publish = (event: any) =>
    snapshots.append(id, { ...event, outputCursor: writer.append(event) });
  try {
    publish({ type: "session_user_message", text: "question", clientMessageId: "client" });
    publish({ type: "session_started", sessionId: id, runId: "run", promptTokens: 0 });
    publish({ type: "stream_request_start", turnNumber: 1, messageId: "reply" });
    for (let index = 0; index < 8; index++) publish({ type: "text_delta", text: `汉🙂${index}` });
    const recover = (store: SessionSnapshotStore) =>
      recoverDesktopOutputJournal({
        read: (options) =>
          handlers.get("sessions:outputJournal")!({}, id, { ...options, maxFrames: 2 }),
        snapshot: async () => store.get(id) as any,
        canContinue: () => true,
        latestObservedCursor: () => undefined,
      });
    const before = await recover(snapshots);
    expect(before?.state.messages).toContainEqual(
      expect.objectContaining({
        kind: "assistant",
        text: Array.from({ length: 8 }, (_, index) => `汉🙂${index}`).join(""),
        done: false,
      }),
    );
    const restarted = new SessionSnapshotStore();
    const after = await recover(restarted);
    expect(after?.outputCursor).toBe(before?.outputCursor);
    expect(after?.snapshot.epoch).not.toBe(before?.snapshot.epoch);
    expect(after?.state.messages.filter((item) => item.kind === "turn_end")).toEqual([]);
    await expect(handlers.get("sessions:outputJournal")!({}, "../outside", {})).rejects.toThrow(
      "invalid desktop sessionId",
    );
  } finally {
    rmSync(join(root, id), { recursive: true, force: true });
  }
});
