import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { SessionManager, sessionsRoot } from "@cjhyy/code-shell-core";
import { SessionOutputJournal, SessionOutputCoverageStore } from "@cjhyy/code-shell-core/internal";
import { registerSessionTranscriptIpc } from "./session-transcript-ipc.js";
import { SessionSnapshotStore } from "./SessionSnapshotStore.js";
import { recoverDesktopOutputJournal } from "../renderer/app/outputJournalRecovery.js";

test("actual Main IPC recovers output evicted from the snapshot and survives Main restart", async () => {
  const root = sessionsRoot();
  const id = `journal-main-${Date.now()}-${Math.floor(Math.random() * 1e8)}`;
  const manager = new SessionManager(root);
  const session = manager.create(root, "fixture", "fixture", id);
  for (let index = 0; index < 3; index++)
    session.transcript.appendMessage("assistant", `legacy-${index}:` + "中".repeat(220000));
  manager.startSessionRun(session.state, "run");
  const writer = new SessionOutputJournal(
    root,
    id,
    "run",
    session.transcript.getEvents().at(-1)!.id,
  );
  const snapshots = new SessionSnapshotStore({
    maxPerSession: 2,
    coverage: new SessionOutputCoverageStore(() => root),
  });
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
    publish({ type: "tool_use_start", toolCall: { id: "read", toolName: "Read", args: {} } });
    publish({ type: "tool_result", result: { id: "read", result: "data" } });
    publish({ type: "text_delta", text: "after ", timestamp: 42 });
    publish({ type: "text_delta", text: "the tool", timestamp: 43 });
    const recover = (store: SessionSnapshotStore) =>
      recoverDesktopOutputJournal({
        read: (options) =>
          handlers.get("sessions:outputJournal")!({}, id, { ...options, maxFrames: 3 }),
        snapshot: async () => store.get(id) as any,
        canContinue: () => true,
        latestObservedCursor: () => undefined,
      });
    const before = await recover(snapshots);
    expect(before?.state.messages.filter((item) => item.kind === "assistant")).toHaveLength(5);
    expect(before?.state.messages.slice(-3)).toEqual([
      expect.objectContaining({
        kind: "assistant",
        text: Array.from({ length: 8 }, (_, index) => `汉🙂${index}`).join(""),
        done: true,
      }),
      expect.objectContaining({ kind: "tool", id: "read", result: "data" }),
      expect.objectContaining({
        kind: "assistant",
        text: "after the tool",
        createdAt: 42,
        done: false,
      }),
    ]);
    expect(before?.outputCursor).toBe(snapshots.get(id).outputCursor);
    const restarted = new SessionSnapshotStore({
      coverage: new SessionOutputCoverageStore(() => root),
    });
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

test("a new Session whose journal appears before the snapshot is read again, not reported lost", async () => {
  const root = sessionsRoot();
  const id = `journal-race-${Date.now()}-${Math.floor(Math.random() * 1e8)}`;
  const manager = new SessionManager(root);
  const snapshots = new SessionSnapshotStore({
    coverage: new SessionOutputCoverageStore(() => root),
  });
  const handlers = new Map<string, (...args: any[]) => any>();
  registerSessionTranscriptIpc({
    handle: (channel, listener) => {
      handlers.set(channel, listener);
    },
  });
  const reads: string[] = [];
  let writer: SessionOutputJournal | undefined;
  try {
    const recovered = await recoverDesktopOutputJournal({
      read: async (options) => {
        const page = await handlers.get("sessions:outputJournal")!({}, id, options);
        reads.push(page.status);
        return page;
      },
      snapshot: async () => {
        if (!writer) {
          // The first read ran before the Session existed. The runtime creates
          // it and commits its journal now, but its first frames have not
          // reached Main's live stream yet (an external runtime buffers them).
          const session = manager.create(root, "fixture", "fixture", id);
          manager.startSessionRun(session.state, "run");
          writer = new SessionOutputJournal(
            root,
            id,
            "run",
            session.transcript.getEvents().at(-1)!.id,
          );
          writer.append({ type: "session_user_message", text: "question", clientMessageId: "c" });
        }
        return snapshots.get(id) as any;
      },
      canContinue: () => true,
      latestObservedCursor: () => undefined,
    });
    expect(reads[0]).toBe("unavailable");
    expect(reads).toContain("ok");
    expect(recovered?.state.messages).toEqual([
      expect.objectContaining({ kind: "user", text: "question", clientMessageId: "c" }),
    ]);
  } finally {
    rmSync(join(root, id), { recursive: true, force: true });
  }
});

test("a committed journal that is still unreadable when read again is reported lost", async () => {
  const unavailable = { version: 1, status: "unavailable", frames: [], complete: false } as const;
  let reads = 0;
  await expect(
    recoverDesktopOutputJournal({
      read: async () => {
        reads++;
        return unavailable as any;
      },
      snapshot: async () =>
        ({
          epoch: "epoch",
          events: [],
          nextSeq: 1,
          topLevelRunning: false,
          outputJournalIdentity: "a".repeat(64),
        }) as any,
      canContinue: () => true,
      latestObservedCursor: () => undefined,
    }),
  ).rejects.toThrow("Output recovery journal is unavailable");
  expect(reads).toBe(2);
});
