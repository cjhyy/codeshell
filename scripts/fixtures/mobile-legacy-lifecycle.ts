// Legacy CLI rooms: real authenticated transport, production Main handlers,
// RoomManager, resident processes, approval bridge and disk transcript follower.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { once } from "node:events";
import { encodeCwd } from "@cjhyy/code-shell-capability-coding/orchestration";
import {
  RemoteHostManager,
  TrustedDeviceStore,
  MobileUploadService,
  RoomManager,
  ResidentAgentProcess,
  CodexRoomAgent,
  mobileTranscriptSubscriberId,
} from "@cjhyy/code-shell-server/mobile-remote";
import { ApprovalBridge } from "../../packages/desktop/src/main/cc-room/approval-bridge.js";
import { createRoomTranscriptSubscriptions } from "../../packages/desktop/src/main/cc-room/transcript-subscriptions.js";
import { resolveLinkedSessionFromDisk } from "../../packages/desktop/src/main/cc-room/linked-session-resolver.js";
import {
  handleClientEvent,
  type OrchestratorCtx,
} from "../../packages/desktop/src/main/mobile-remote/handle-client-event.js";

const NativeWebSocket = globalThis.WebSocket;
type Kind = "claude-code" | "codex";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runLegacyLifecycle(root: string) {
  assert(globalThis[Symbol.for("codeshell.external-output.fixture-guard")]);
  process.env.CODESHELL_OUTPUT_LEGACY = "1";
  const cwd = join(root, "legacy-workspace");
  mkdirSync(cwd);
  const devices = new TrustedDeviceStore(join(root, "legacy-devices.json"));
  const device = devices.addDevice({
    name: "Legacy fixture phone",
    secretHash: "legacy-fixture-secret",
  });
  const uploads = new MobileUploadService({
    rootDir: join(root, "legacy-uploads"),
    cleanupIntervalMs: 0,
  });
  let context!: OrchestratorCtx;
  const routed: string[] = [];
  const remote = new RemoteHostManager({
    devices,
    uploads,
    async onClientEvent(event) {
      assert(remote.hasAuthenticatedViewer(event.viewerId!, event.deviceId!));
      routed.push(event.type);
      await handleClientEvent(context, event);
    },
  });
  const approvalBridge = new ApprovalBridge({
    onPush: (roomId, req) => remote.broadcast({ type: "ccRoom.approvalRequest", roomId, req }),
    onResolve: (roomId, requestId, decision) =>
      remote.broadcast({ type: "ccRoom.approvalResolved", roomId, requestId, decision }),
  });
  const roomManager = new RoomManager({
    rootDir: join(root, "legacy-rooms"),
    resolveLinkedSession: resolveLinkedSessionFromDisk,
    createAgent: (room, onEvent) =>
      room.kind === "codex"
        ? new CodexRoomAgent({
            command: join(root, "bin/codex"),
            cwd: room.cwd,
            permissionMode: room.permissionMode,
            resumeThreadId: room.claudeSessionId,
            onEvent,
            onThreadId: (id) => roomManager.setRoomSessionId(room.id, id),
          })
        : new ResidentAgentProcess({
            command: join(root, "bin/claude"),
            cwd: room.cwd,
            permissionMode: room.permissionMode,
            resumeSessionId: room.claudeSessionId,
            onEvent,
          }),
    onMessage: (roomId, msg) => remote.broadcast({ type: "room.message", roomId, msg }),
    onApprovalRequest: (roomId, event) => {
      void approvalBridge
        .request(roomId, event.requestId, event)
        .then((decision) => roomManager.respondApproval(roomId, event.requestId, decision));
    },
    onRoomEnded: (roomId) => {
      approvalBridge.cancelRoom(roomId);
      transcripts.endRoom(roomId);
    },
  });
  const transcripts = createRoomTranscriptSubscriptions({
    roomManager,
    checkpointDir: join(root, "legacy-checkpoints"),
    broadcast: (event) => remote.broadcast(event),
    windows: () => [],
  });
  remote.on("viewer-offline", ({ viewerId }) =>
    transcripts.unsubscribeSubscriber(mobileTranscriptSubscriberId(viewerId)),
  );
  context = {
    remote,
    uploads,
    roomManager,
    approvalBridge,
    transcriptSubscriptions: transcripts,
    roomToPublic: (room: any) => ({
      ...room,
      open: roomManager.isOpen(room.id),
      observing: room.linkedSessionMode === "observe-only",
    }),
    roomMatchesTranscript: (roomId: string, path: string, sessionId: string, kind: Kind) => {
      const room = roomManager.getRoom(roomId);
      return (
        !!room && room.cwd === path && room.claudeSessionId === sessionId && room.kind === kind
      );
    },
    settleMobileUploadClaims: async (id: string, claims: any[], action: "release" | "finalize") => {
      for (const claim of claims) await uploads[action](id, claim.uploadId, claim.claimId);
    },
  } as unknown as OrchestratorCtx;
  const fileFor = (kind: Kind, id: string) =>
    kind === "claude-code"
      ? join(homedir(), ".claude/projects", encodeCwd(cwd), `${id}.jsonl`)
      : join(homedir(), ".codex/sessions/2026/10/29", `rollout-${id}.jsonl`);
  const transcriptLine = (kind: Kind, id: string, role: string, text: string) =>
    JSON.stringify(
      kind === "claude-code"
        ? {
            type: role,
            sessionId: id,
            cwd,
            message: { role, content: role === "assistant" ? [{ type: "text", text }] : text },
          }
        : {
            type: "response_item",
            payload: {
              type: "message",
              role,
              content: [{ type: role === "user" ? "input_text" : "output_text", text }],
            },
          },
    ) + "\n";
  for (const kind of ["claude-code", "codex"] as const) {
    for (let index = 0; index < 22; index++) {
      const id = `legacy-${kind}-${index}`;
      const file = fileFor(kind, id);
      mkdirSync(dirname(file), { recursive: true });
      let content =
        kind === "codex"
          ? JSON.stringify({ type: "session_meta", payload: { id, cwd } }) + "\n"
          : "";
      for (let turn = 0; turn < 12; turn++)
        content += transcriptLine(kind, id, turn % 2 ? "assistant" : "user", `saved-${turn}`);
      writeFileSync(file, content);
      const time = new Date(Date.now() - (index === 0 ? 30 * 24 * 60 * 60 * 1000 : index * 1000));
      utimesSync(file, time, time);
    }
  }
  let socket!: WebSocket;
  const events: any[] = [];
  const cases: string[] = [];
  let phase = "connect";
  const log = () => {
    try {
      return readFileSync(process.env.CODESHELL_OUTPUT_REQUEST_LOG!, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  };
  const until = async (predicate: () => boolean) => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await sleep(10);
    }
    throw new Error(
      "Legacy lifecycle deadline: " +
        JSON.stringify({
          phase,
          routed: routed.slice(-5),
          events: events
            .slice(-5)
            .map((event) => ({ type: event.type, message: event.message, status: event.status })),
        }),
    );
  };
  const send = (event: unknown) => socket.send(JSON.stringify(event));
  const ask = async (event: unknown, predicate: (event: any) => boolean) => {
    const offset = events.length;
    send(event);
    await until(() => events.slice(offset).some(predicate));
    return events.slice(offset).find(predicate);
  };
  const connect = async (port: number) => {
    socket = new NativeWebSocket(`ws://127.0.0.1:${port}/ws`);
    socket.addEventListener("message", (message) => events.push(JSON.parse(String(message.data))));
    await once(socket, "open");
    await ask(
      { type: "auth.device", deviceId: device.id, secretHash: "legacy-fixture-secret" },
      (event) => event.type === "auth.ok",
    );
  };
  let sequence = 0;
  const roomSend = async (roomId: string, text: string) => {
    const clientMessageId = `legacy-${++sequence}`;
    const reply = await ask(
      { type: "room.send", roomId, text, clientMessageId },
      (event) =>
        ["room.accepted", "room.error"].includes(event.type) &&
        event.clientMessageId === clientMessageId,
    );
    assert.equal(reply.type, "room.accepted", JSON.stringify(reply));
  };
  const waitTurn = async (roomId: string, offset: number) =>
    until(() =>
      events
        .slice(offset)
        .some(
          (event) =>
            event.type === "room.message" &&
            event.roomId === roomId &&
            event.msg.type === "turn_end",
        ),
    );
  try {
    const started = await remote.start({ host: "127.0.0.1", port: 0 });
    await connect(started.port);
    for (const kind of ["claude-code", "codex"] as const) {
      phase = `${kind} older CLI discovery and history`;
      const recent = await ask(
        { type: "ccRoom.listSessions", cwd, kind },
        (event) => event.type === "ccRoom.listSessions.ok" && event.kind === kind,
      );
      assert.equal(recent.total, 22);
      assert.equal(recent.sessions.length, 20);
      const all = await ask(
        { type: "ccRoom.listSessions", cwd, kind, all: true },
        (event) => event.type === "ccRoom.listSessions.ok" && event.kind === kind && event.all,
      );
      assert.equal(all.sessions.length, 22);
      const observedId = `legacy-${kind}-0`;
      assert(all.sessions.some((entry: any) => entry.sessionId === observedId));
      const history = await ask(
        { type: "ccRoom.readHistory", cwd, kind, sessionId: observedId, limit: 5 },
        (event) => event.type === "ccRoom.readHistory.ok" && event.sessionId === observedId,
      );
      assert.equal(history.messages.length, 5);
      assert.equal(history.totalCount, 12);
      assert(history.hasMore);
      const expanded = await ask(
        { type: "ccRoom.readHistory", cwd, kind, sessionId: observedId, limit: 20 },
        (event) => event.type === "ccRoom.readHistory.ok" && event.sessionId === observedId,
      );
      assert.equal(expanded.messages.length, 12);
      assert(!expanded.hasMore);
      cases.push(
        `${kind}: real CLI disk discovery retains older 22 sessions; bounded history expands without losing messages`,
      );

      phase = `${kind} read-only linked transcript observation`;
      // A Desktop-created linked room stays read-only when the phone opens it.
      const observed = roomManager.openLinkedSession(observedId, cwd, kind);
      const countBefore = log().filter(
        (entry: any) => entry.event === "legacy-physical-turn",
      ).length;
      const opened = await ask(
        { type: "room.open", roomId: observed.roomId },
        (event) => event.type === "room.opened" && event.roomId === observed.roomId,
      );
      assert.equal(opened.status, "observing");
      const readonly = await ask(
        {
          type: "room.send",
          roomId: observed.roomId,
          text: "must not execute",
          clientMessageId: "readonly",
        },
        (event) => event.type === "room.error" && event.clientMessageId === "readonly",
      );
      assert(readonly.message);
      assert.equal(
        log().filter((entry: any) => entry.event === "legacy-physical-turn").length,
        countBefore,
      );
      const subscribed = await ask(
        {
          type: "ccRoom.subscribeTranscript",
          roomId: observed.roomId,
          sessionId: observedId,
          cwd,
          kind,
          limit: 5,
        },
        (event) => event.type === "ccRoom.transcriptSubscribed" && event.roomId === observed.roomId,
      );
      assert(subscribed.active);
      assert.equal(subscribed.messages.length, 5);
      const appendedOffset = events.length;
      appendFileSync(
        fileFor(kind, observedId),
        transcriptLine(kind, observedId, "assistant", "fresh external tail"),
      );
      await until(() =>
        events
          .slice(appendedOffset)
          .some(
            (event) =>
              event.type === "room.message" &&
              event.roomId === observed.roomId &&
              event.msg.text === "fresh external tail",
          ),
      );
      const mismatch = await ask(
        {
          type: "ccRoom.subscribeTranscript",
          roomId: observed.roomId,
          sessionId: `legacy-${kind}-1`,
          cwd,
          kind,
          limit: 5,
        },
        (event) => event.type === "room.error",
      );
      assert(mismatch.message.includes("does not match"));
      assert.equal(
        roomManager
          .getMessages(observed.roomId)
          .filter((message) => message.text === "fresh external tail").length,
        1,
      );
      await ask(
        { type: "room.close", roomId: observed.roomId },
        (event) => event.type === "room.closed" && event.roomId === observed.roomId,
      );
      cases.push(
        `${kind}: Mobile observes appended transcript once, rejects mismatched subscription and cannot write a Desktop read-only room`,
      );

      phase = `${kind} resume old CLI through Mobile room`;
      const id = `legacy-${kind}-1`;
      const resumed = await ask(
        { type: "ccRoom.openSession", sessionId: id, cwd, kind, mode: "bypassPermissions" },
        (event) => event.type === "ccRoom.opened" && event.sessionId === id,
      );
      assert.equal(resumed.status, "running");
      assert.equal(resumed.permissionMode, "default");
      const roomId = resumed.roomId;
      const outputOffset = events.length;
      await roomSend(roomId, "legacy continue");
      await waitTurn(roomId, outputOffset);
      assert(
        log().some(
          (entry: any) =>
            entry.event === "legacy-physical-turn" &&
            entry.kind === kind &&
            entry.resumed &&
            entry.mode === (kind === "codex" ? "read-only" : "default"),
        ),
      );
      const page1 = await ask(
        { type: "room.history", roomId, page: true, limit: 1, requestId: "legacy-page-1" },
        (event) => event.type === "room.history.ok" && event.requestId === "legacy-page-1",
      );
      assert.equal(page1.messages.length, 1);
      assert(page1.page.nextCursor);
      const page2 = await ask(
        {
          type: "room.history",
          roomId,
          page: true,
          limit: 20,
          cursor: page1.page.nextCursor,
          requestId: "legacy-page-2",
        },
        (event) => event.type === "room.history.ok" && event.requestId === "legacy-page-2",
      );
      assert(page2.messages.some((message: any) => message.text === "legacy synthetic reply"));
      assert(!page2.messages.some((message: any) => message.seq === page1.messages[0].seq));
      cases.push(
        `${kind}: Main resumes the real synthetic legacy CLI with safe permission mode and pages durable room output`,
      );
      if (kind === "claude-code") {
        phase = "resident Claude approval reconnect";
        const offset = events.length;
        await roomSend(roomId, "legacy-approval");
        await until(() =>
          events
            .slice(offset)
            .some((event) => event.type === "ccRoom.approvalRequest" && event.roomId === roomId),
        );
        socket.close();
        await once(socket, "close");
        await connect(started.port);
        const replayOffset = events.length;
        await ask(
          { type: "ccRoom.openSession", sessionId: id, cwd, kind, mode: "default" },
          (event) => event.type === "ccRoom.opened" && event.sessionId === id,
        );
        await until(() =>
          events
            .slice(replayOffset)
            .some(
              (event) =>
                event.type === "ccRoom.approvalRequest" && event.req.requestId === "legacy-control",
            ),
        );
        const finishOffset = events.length;
        send({
          type: "ccRoom.respondApproval",
          roomId,
          requestId: "legacy-control",
          decision: { behavior: "allow", answer: "accept" },
        });
        await waitTurn(roomId, finishOffset);
        assert.deepEqual(
          log().find((entry: any) => entry.event === "legacy-approval-answer").response.updatedInput
            .answers,
          { "Choose synthetic room target": "accept" },
        );
        cases.push(
          "resident Claude control approval is replayed after reconnect and actual stdin receives the chosen answer",
        );
      }
      phase = `${kind} stop physical legacy room process`;
      const heldBefore = log().filter(
        (entry: any) => entry.event === "legacy-held" && entry.kind === kind,
      ).length;
      await roomSend(roomId, "legacy-hold");
      await until(
        () =>
          log().filter((entry: any) => entry.event === "legacy-held" && entry.kind === kind)
            .length ===
          heldBefore + 1,
      );
      const held = log()
        .filter((entry: any) => entry.event === "legacy-held" && entry.kind === kind)
        .at(-1)!;
      await ask(
        { type: "room.close", roomId },
        (event) => event.type === "room.closed" && event.roomId === roomId,
      );
      await until(() => {
        try {
          process.kill(held.pid, 0);
          return false;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === "ESRCH";
        }
      });
      assert(!roomManager.isOpen(roomId));
      const created = await ask(
        { type: "room.create", name: `new ${kind}`, cwd, kind, permissionMode: "default" },
        (event) => event.type === "room.opened" && event.roomId !== roomId,
      );
      const createdOffset = events.length;
      await roomSend(created.roomId, "legacy new room");
      await waitTurn(created.roomId, createdOffset);
      await ask(
        { type: "room.close", roomId: created.roomId },
        (event) => event.type === "room.closed" && event.roomId === created.roomId,
      );
      cases.push(
        `${kind}: Mobile closes the actual held process and creates/sends/closes a fresh room through Main`,
      );
    }
    console.log(
      JSON.stringify({
        mobileLegacyLifecycle: true,
        cases,
        actualNode: process.versions.node,
        syntheticOnly: true,
      }),
    );
  } finally {
    socket?.close();
    transcripts.closeAll();
    roomManager.closeAll();
    await remote.stop();
    delete process.env.CODESHELL_OUTPUT_LEGACY;
  }
}
