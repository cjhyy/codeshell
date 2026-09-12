import { describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { PetApi, SessionSnapshot, StreamEventEnvelope } from "../../preload/types";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { PetStateProvider, usePetState } from "./PetStateProvider";
import { transcriptToFoldItems } from "../../main/transcript-reader";
import { parsePetUserContent } from "./PetChatHost";
import type { PetDispatchResult } from "../../preload/pet-api";

const sessionId = "pet-reload";
const identity = { runId: "run-reload", clientMessageId: "input-reload" };
const epoch = "main-reload";

function envelope(seq: number, event: Record<string, unknown>): StreamEventEnvelope {
  return { sessionId, epoch, seq, event: { ...event, ...identity } as any };
}

const prefix = [
  envelope(1, { type: "session_started", sessionId }),
  envelope(2, { type: "stream_request_start", messageId: "reply-reload" }),
  envelope(3, { type: "text_delta", text: "before " }),
];

async function mount(
  snapshot: SessionSnapshot,
  chatInputs?: Extract<PetDispatchResult, { type: "global_status" }>["chatInputs"],
) {
  ensureMiniDom();
  const testWindow = window as unknown as Record<string, unknown>;
  const originalCodeshell = testWindow.codeshell;
  let streamListener: ((event: StreamEventEnvelope) => void) | undefined;
  let lifecycleListener: ((event: any) => void) | undefined;
  let resolveHistory: ((items: any[]) => void) | undefined;
  const commands: unknown[] = [];
  testWindow.codeshell = {
    getSessionTranscript: () => new Promise<any[]>((resolve) => (resolveHistory = resolve)),
    subscribeSession: async () => snapshot,
    onStreamEvent: (listener: typeof streamListener) => {
      streamListener = listener;
      return () => (streamListener = undefined);
    },
    onAgentLifecycle: (listener: typeof lifecycleListener) => {
      lifecycleListener = listener;
      return () => (lifecycleListener = undefined);
    },
    log: () => {},
  };
  const api: PetApi = {
    getSnapshot: async () => ({
      version: 0,
      generation: 0,
      workerState: "active",
      sessions: [],
      pending: [],
      observedAt: 1,
    }),
    onProjectionEvent: () => () => {},
    openSession: async () => ({ status: "not-found" }),
    dispatch: async (command) => {
      commands.push(command);
      if (command.type === "stop_chat") return { ok: true, type: "chat_stopped", stopped: true };
      if (command.type !== "get_global_status") return { ok: false, code: "invalid-command" };
      return {
        ok: true,
        type: "global_status",
        version: 0,
        generation: 0,
        observedAt: 1,
        workerState: "active",
        petSessionId: sessionId,
        runningCount: 0,
        queuedCount: 0,
        pendingCount: 0,
        sessions: [],
        chatInputs,
      };
    },
    getAttentionSnapshot: async () => ({ surfaceablePendingCount: 0 }),
    onAttentionEvent: () => () => {},
    setActiveSession: async () => ({ ok: true }),
    markAttentionReceipt: async () => ({ ok: true }),
  };
  let current: ReturnType<typeof usePetState>;
  function Consumer() {
    current = usePetState();
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => {
    root.render(
      <PetStateProvider api={api}>
        <Consumer />
      </PetStateProvider>,
    );
    await flushMicrotasks();
  });
  return {
    get state() {
      return current!;
    },
    commands,
    emit: (event: StreamEventEnvelope) => streamListener?.(event),
    exit: () => lifecycleListener?.({ type: "exited", code: 1, signal: null }),
    hydrate: async (
      items: any[] = [
        { kind: "user", text: "reload request", clientMessageId: identity.clientMessageId },
      ],
    ) => {
      resolveHistory?.(items);
      await flushMicrotasks();
    },
    close: async () => {
      await act(async () => root.unmount());
      if (originalCodeshell === undefined) delete testWindow.codeshell;
      else testWindow.codeshell = originalCodeshell;
    },
  };
}

function liveSnapshot(): SessionSnapshot {
  return { epoch, events: prefix, nextSeq: 4, topLevelRunning: true };
}

describe("Mimi reload during a live reply", () => {
  test.each([false, true])(
    "restores a queued intent and its next reply exactly once (starts during history read: %s)",
    async (startsDuringRead) => {
      const nextInput = {
        clientMessageId: "input-next",
        message: "reload request",
        createdAt: 123,
        pending: true,
        attachments: [
          { kind: "file" as const, path: "notes.txt", absPath: "/work/notes.txt", sessionId },
        ],
      };
      const next = (seq: number, event: Record<string, unknown>): StreamEventEnvelope => ({
        ...envelope(seq, event),
        event: { ...event, runId: "run-next", clientMessageId: nextInput.clientMessageId } as any,
      });
      const nextEvents = [
        envelope(4, { type: "turn_complete", reason: "aborted_streaming" }),
        next(5, { type: "session_started", sessionId, previousRunId: identity.runId }),
        next(6, { type: "stream_request_start", messageId: "reply-next" }),
        next(7, { type: "text_delta", text: "next reply" }),
      ];
      const view = await mount(liveSnapshot(), [nextInput, { ...nextInput }]);
      try {
        await act(async () => {
          if (startsDuringRead) nextEvents.forEach(view.emit);
          await view.hydrate();
        });
        if (!startsDuringRead) {
          expect(
            view.state.chatState.messages.filter((message) => message.kind === "user"),
          ).toMatchObject([
            { clientMessageId: identity.clientMessageId },
            {
              clientMessageId: nextInput.clientMessageId,
              pending: true,
              attachments: nextInput.attachments,
            },
          ]);
          expect(view.state.chatBusy).toBe(true);
          await act(async () => {
            await view.state.stopChat();
            nextEvents.forEach(view.emit);
          });
          expect(view.commands).toContainEqual({
            type: "stop_chat",
            clientMessageId: identity.clientMessageId,
          });
        }
        expect(
          view.state.chatState.messages.filter((message) => message.kind === "user"),
        ).toMatchObject([
          { clientMessageId: identity.clientMessageId },
          {
            clientMessageId: nextInput.clientMessageId,
            pending: false,
            attachments: nextInput.attachments,
          },
        ]);
        expect(
          view.state.chatState.messages
            .filter((message) => message.kind === "assistant")
            .map((message) => message.text),
        ).toEqual(["before ", "next reply"]);
        expect(view.state.chatBusy).toBe(true);
        await act(async () => {
          view.emit(next(8, { type: "turn_complete", reason: "completed" }));
        });
        expect(view.state.chatBusy).toBe(false);
        expect(
          view.state.chatState.messages.filter((message) => message.kind === "user"),
        ).toHaveLength(2);
      } finally {
        await view.close();
      }
    },
  );

  test("a queued input already injected during hydration is not marked pending again", async () => {
    const attachments = [
      { kind: "image" as const, path: "pic.png", absPath: "/work/pic.png", sessionId },
    ];
    const view = await mount(liveSnapshot(), [
      {
        clientMessageId: "queued",
        message: "another input",
        createdAt: 1,
        pending: true,
        attachments,
      },
    ]);
    try {
      await act(async () => {
        view.emit(envelope(4, { type: "steer_injected", id: "queued", text: "another input" }));
        await view.hydrate();
      });
      const queued = view.state.chatState.messages.filter(
        (message) => message.kind === "user" && message.steerId === "queued",
      );
      expect(queued).toHaveLength(1);
      expect(queued[0]?.pending).not.toBe(true);
      expect(queued[0]).toMatchObject({ clientMessageId: "queued", attachments });
    } finally {
      await view.close();
    }
  });

  test("keeps durable image and file metadata when restoring the user intent anchor", async () => {
    const imagePath = "/work/.code-shell/attachments/pet-reload/image.png";
    const filePath = "/work/.code-shell/attachments/pet-reload/notes.txt";
    const text = `Review these attachments.
<attached-file path="image.png">
absolutePath: ${imagePath}
mime: image/png
originalName: image.png
</attached-file>
<attached-file path="notes.txt">
absolutePath: ${filePath}
mime: text/plain
originalName: notes.txt
</attached-file>`;
    const history = transcriptToFoldItems(
      JSON.stringify({
        id: "durable-image-input",
        type: "message",
        timestamp: 100,
        turnNumber: 0,
        data: { role: "user", content: text, clientMessageId: identity.clientMessageId },
      }),
    );
    const view = await mount(liveSnapshot());
    try {
      await act(async () => {
        await view.hydrate(history);
      });
      const users = view.state.chatState.messages.filter((message) => message.kind === "user");
      expect(users).toHaveLength(1);
      expect(users[0]?.text).toBe(text);
      expect(parsePetUserContent(users[0]!)).toEqual({
        text: `Review these attachments.\n\n<attached-file path="notes.txt">\nabsolutePath: ${filePath}\nmime: text/plain\noriginalName: notes.txt\n</attached-file>`,
        images: [
          {
            path: imagePath,
            name: "image.png",
            mime: "image/png",
            cwd: "/work",
            sessionId: "pet-reload",
          },
        ],
      });
      expect(view.state.chatState.streamingAssistantId).toBe("reply-reload");
    } finally {
      await view.close();
    }
  });

  test.each([false, true])(
    "does not duplicate a previous reply with durable user identities after two turns (latest complete: %s)",
    async (complete) => {
      const firstIdentity = { runId: "run-first", clientMessageId: "input-first" };
      const first = [
        envelope(1, { type: "session_started", sessionId }),
        envelope(2, { type: "stream_request_start", messageId: "live-first" }),
        envelope(3, { type: "text_delta", text: "QA-FIRST reply" }),
        envelope(4, { type: "turn_complete", reason: "completed", text: "QA-FIRST reply" }),
      ].map((item) => ({ ...item, event: { ...item.event, ...firstIdentity } }));
      const second = [
        envelope(5, { type: "session_started", sessionId, previousRunId: firstIdentity.runId }),
        envelope(6, { type: "stream_request_start", messageId: "live-second" }),
        envelope(7, { type: "text_delta", text: "QA-SECOND reply" }),
        ...(complete
          ? [envelope(8, { type: "turn_complete", reason: "completed", text: "QA-SECOND reply" })]
          : []),
      ];
      const raw = [
        {
          id: "disk-user-first",
          type: "message",
          turnNumber: 0,
          data: {
            role: "user",
            content: "QA-FIRST",
            clientMessageId: firstIdentity.clientMessageId,
          },
        },
        {
          id: "disk-reply-first",
          type: "message",
          turnNumber: 0,
          data: { role: "assistant", content: [{ type: "text", text: "QA-FIRST reply" }] },
        },
        { id: "disk-turn-first", type: "turn_boundary", turnNumber: 1, data: { turnNumber: 1 } },
        {
          id: "disk-user-second",
          type: "message",
          turnNumber: 1,
          data: { role: "user", content: "QA-SECOND", clientMessageId: identity.clientMessageId },
        },
        ...(complete
          ? [
              {
                id: "disk-reply-second",
                type: "message",
                turnNumber: 1,
                data: { role: "assistant", content: [{ type: "text", text: "QA-SECOND reply" }] },
              },
              {
                id: "disk-turn-second",
                type: "turn_boundary",
                turnNumber: 2,
                data: { turnNumber: 2 },
              },
            ]
          : []),
      ]
        .map((item, index) => JSON.stringify({ ...item, timestamp: 100 + index }))
        .join("\n");
      const view = await mount({
        epoch,
        events: [...first, ...second],
        nextSeq: complete ? 9 : 8,
        topLevelRunning: !complete,
      });
      try {
        await act(async () => {
          first.forEach(view.emit);
          await view.hydrate(transcriptToFoldItems(raw));
        });
        expect(
          view.state.chatState.messages
            .filter((item) => item.kind === "user" || item.kind === "assistant")
            .map((item) => item.text),
        ).toEqual(["QA-FIRST", "QA-FIRST reply", "QA-SECOND", "QA-SECOND reply"]);
        expect(view.state.chatBusy).toBe(!complete);
        if (!complete) {
          await act(async () => {
            view.emit(envelope(8, { type: "text_delta", text: " continues" }));
          });
          expect(
            view.state.chatState.messages
              .filter((item) => item.kind === "assistant")
              .map((item) => item.text),
          ).toEqual(["QA-FIRST reply", "QA-SECOND reply continues"]);
        }
      } finally {
        await view.close();
      }
    },
  );

  test("restores the missed prefix and scoped stop, deduplicating overlapping live deltas", async () => {
    const view = await mount(liveSnapshot());
    try {
      await act(async () => {
        view.emit(prefix[2]!);
        view.emit(envelope(4, { type: "text_delta", text: "during " }));
        await view.hydrate();
      });
      expect(view.state.chatBusy).toBe(true);
      expect(view.state.chatCanStop).toBe(true);
      expect(view.state.chatState.streamingAssistantId).toBe("reply-reload");
      expect(
        view.state.chatState.messages.filter((item) => item.kind === "assistant"),
      ).toMatchObject([{ text: "before during " }]);
      await act(async () => {
        view.emit(envelope(4, { type: "text_delta", text: "during " }));
        view.emit(envelope(5, { type: "text_delta", text: "after" }));
      });
      expect(view.state.chatState.messages.find((item) => item.kind === "assistant")).toMatchObject(
        { text: "before during after" },
      );
      await act(async () => {
        await view.state.stopChat();
      });
      expect(view.commands).toContainEqual({
        type: "stop_chat",
        clientMessageId: identity.clientMessageId,
      });
    } finally {
      await view.close();
    }
  });

  test("completion received while history loads wins over the running snapshot", async () => {
    const view = await mount(liveSnapshot());
    try {
      await act(async () => {
        view.emit(envelope(4, { type: "turn_complete", reason: "completed" }));
        await view.hydrate();
      });
      expect(view.state.chatBusy).toBe(false);
      expect(view.state.chatCanStop).toBe(false);
    } finally {
      await view.close();
    }
  });

  test("worker exit during hydration clears the replayed running snapshot", async () => {
    const view = await mount(liveSnapshot());
    try {
      await act(async () => {
        view.exit();
        await view.hydrate();
      });
      expect(view.state.chatBusy).toBe(false);
      expect(view.state.chatState.streamingAssistantId).toBeNull();
    } finally {
      await view.close();
    }
  });

  test("an exit buffered before a replacement run does not stop the new snapshot reply", async () => {
    const replacement = [
      envelope(4, { type: "session_started", sessionId }),
      envelope(5, { type: "stream_request_start", messageId: "reply-new" }),
      envelope(6, { type: "text_delta", text: "replacement" }),
    ].map((item) => ({
      ...item,
      event: {
        ...item.event,
        runId: "run-new",
        clientMessageId: "input-new",
        previousRunId: identity.runId,
      },
    }));
    const view = await mount({
      epoch,
      events: [...prefix, ...replacement],
      nextSeq: 7,
      topLevelRunning: true,
    });
    try {
      await act(async () => {
        view.exit();
        replacement.forEach(view.emit);
        await view.hydrate([
          { kind: "user", text: "reload request", clientMessageId: identity.clientMessageId },
          ...prefix.slice(1).map(({ event }) => ({ kind: "stream", event })),
          { kind: "turn_stopped" },
          { kind: "user", text: "replacement request", clientMessageId: "input-new" },
        ]);
      });
      expect(view.state.chatBusy).toBe(true);
      expect(view.state.chatCanStop).toBe(true);
      expect(view.state.chatState.streamingAssistantId).toBe("reply-new");
      expect(
        view.state.chatState.messages.filter((item) => item.kind === "assistant"),
      ).toMatchObject([{ text: "before " }, { text: "replacement" }]);
    } finally {
      await view.close();
    }
  });

  test("a worker that exited before the reload leaves its retained prefix idle", async () => {
    const view = await mount({ ...liveSnapshot(), topLevelRunning: false });
    try {
      await act(async () => {
        await view.hydrate();
      });
      expect(view.state.chatBusy).toBe(false);
      expect(view.state.chatState.streamingAssistantId).toBeNull();
      expect(view.state.chatState.messages.find((item) => item.kind === "assistant")).toMatchObject(
        { text: "before " },
      );
    } finally {
      await view.close();
    }
  });

  test("completed snapshot and disk overlap leave one assistant response", async () => {
    const completed = envelope(4, { type: "turn_complete", reason: "completed" });
    const view = await mount({
      epoch,
      events: [...prefix, completed],
      nextSeq: 5,
      topLevelRunning: false,
    });
    try {
      await act(async () => {
        await view.hydrate([
          { kind: "user", text: "reload request" },
          ...prefix.slice(1).map(({ event }) => ({ kind: "stream", event })),
          { kind: "stream", event: completed.event },
        ]);
      });
      expect(view.state.chatBusy).toBe(false);
      expect(
        view.state.chatState.messages.filter((item) => item.kind === "assistant"),
      ).toMatchObject([{ text: "before " }]);
    } finally {
      await view.close();
    }
  });
});
