import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, statSync, truncateSync } from "node:fs";
import { join } from "node:path";
import { once } from "node:events";
import { act } from "react";
import {
  AgentServer,
  ChatSessionManager,
  Engine,
  sessionsRoot,
  SessionManager,
} from "@cjhyy/code-shell-core";
import { SessionOutputJournal } from "@cjhyy/code-shell-core/internal";
import { RemoteHostManager, TrustedDeviceStore } from "@cjhyy/code-shell-server/mobile-remote";
import {
  handleClientEvent,
  type OrchestratorCtx,
} from "../../packages/desktop/src/main/mobile-remote/handle-client-event.js";
import { MobileOutputRecovery } from "../../packages/desktop/src/main/mobile-remote/output-recovery.js";
import { mobileOutputRecoveryAuthority } from "../../packages/desktop/src/main/mobile-remote/output-recovery-authority.js";
import { SessionSnapshotStore } from "../../packages/desktop/src/main/SessionSnapshotStore.js";
import { getProjectStore } from "../../packages/desktop/src/main/project-store.js";
import {
  ensureMiniDom,
  flushMicrotasks,
  renderHook,
} from "../../packages/web/src/test-utils/renderHook.js";
import { useRemoteApp } from "../../packages/web/src/hooks/useRemoteApp.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
export async function run(origin: string, root: string, port: number) {
  const startedAt = Date.now();
  const nativeNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const cwd = join(root, "workspace");
  mkdirSync(cwd);
  const project = await getProjectStore().createFromPath(cwd);
  const parts = Array.from({ length: 2205 }, (_, index) => `${index}-汉🙂${"x".repeat(4096)}\n`);
  const expected = parts.join("");
  assert.ok(Buffer.byteLength(expected) > 8 * 1024 * 1024);
  let modelRequests = 0,
    pageRequests = 0,
    maximumPageBytes = 0,
    completedPages = 0;
  let snapshots = new SessionSnapshotStore();
  let appendDuringReply: (() => void) | undefined;
  let frozenAppendThrough: string | undefined;
  const devices = new TrustedDeviceStore(join(root, "trusted-devices.json"));
  const device = devices.addDevice({
    name: "Synthetic phone",
    secretHash: "synthetic-mobile-secret",
  });
  let context: OrchestratorCtx;
  const routed: string[] = [];
  const remote = new RemoteHostManager({
    devices,
    outputJournal: true,
    webApi: {
      start() {},
      async close() {},
      revokeDevice() {},
      async handle(request, response) {
        if (request.url !== "/api/v1/sdk/chat/completions") return false;
        let raw = "";
        for await (const chunk of request) raw += chunk;
        const body = JSON.parse(raw);
        assert.equal(body.stream, true);
        modelRequests++;
        response.setHeader("content-type", "text/event-stream");
        for (const text of modelRequests === 1 ? parts : ["native-follow-up"]) {
          const chunk = {
            id: "fixture",
            object: "chat.completion.chunk",
            created: 1,
            model: "gpt-4o",
            choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
          };
          if (!response.write(`data: ${JSON.stringify(chunk)}\n\n`)) await once(response, "drain");
        }
        response.end(
          `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "gpt-4o", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2205, total_tokens: 2215 } })}\n\ndata: [DONE]\n\n`,
        );
        return true;
      },
    } as never,
    async onClientEvent(raw) {
      const event = raw as Parameters<typeof handleClientEvent>[1];
      if (
        [
          "session.select",
          "session.outputJournal",
          "session.recovery.cancel",
          "session.sync",
        ].includes(event.type)
      ) {
        routed.push(event.type);
        if (event.type === "session.outputJournal") pageRequests++;
        await handleClientEvent(context, event);
      }
    },
  });
  const recovery = new MobileOutputRecovery({
    root: sessionsRoot,
    authority: mobileOutputRecoveryAuthority,
    snapshot: (sessionId) => snapshots.get(sessionId),
    reply: (viewer, event) => {
      if (event.type === "session.outputJournal") {
        if (event.page.complete) completedPages++;
        maximumPageBytes = Math.max(
          maximumPageBytes,
          Buffer.byteLength(JSON.stringify(event.page)),
        );
        if (event.page.status === "ok" && appendDuringReply) {
          frozenAppendThrough = event.page.through;
          const append = appendDuringReply;
          appendDuringReply = undefined;
          append();
          assert.equal(event.page.through, frozenAppendThrough);
        }
      }
      remote.sendToViewer(viewer, event);
    },
  });
  remote.on("viewer-offline", ({ viewerId }: { viewerId: string }) => recovery.revoke(viewerId));
  const state = {};
  context = {
    outputRecovery: recovery,
    remote,
    getBridge: () => ({
      getLastRunContext: () => ({}),
      getSnapshot: (id: string, since: number) => snapshots.get(id, since),
    }),
    deviceState: () => state,
    mobilePermissionModes: new Map(),
    lookupDiskSessionCwd: async () => cwd,
    sendMobilePermissionMode() {},
    replayPendingMobileApprovals() {},
  } as unknown as OrchestratorCtx;
  let cleanupEngine = () => {};
  let cleanupGateway = async () => {};
  let cleanupHook = async () => {};
  try {
    await remote.start({ host: "127.0.0.1", port });
    const engine = new Engine({
      llm: {
        provider: "openai",
        model: "gpt-4o",
        apiKey: "synthetic",
        baseUrl: origin + "/api/v1/sdk",
        // Synthetic long response must not invoke unrelated compaction models
        // when the same actual protocol Session submits its small second turn.
        maxContextTokens: 10_000_000,
      },
      cwd,
      sessionStorageDir: sessionsRoot(),
      settingsScope: "isolated",
      headless: true,
      maxTurns: 2,
      behaviorProfiles: [
        {
          id: "mobile-fixture",
          disableSessionTitle: true,
          disableHooks: true,
          disableInstructions: true,
          disableMemoryContext: true,
          disableCapabilityContext: true,
          disableSourcesContext: true,
          disableMcp: true,
        },
      ],
    });
    cleanupEngine = () => {
      engine.dispose();
    };
    engine.getHookRegistry().clear();
    let frames = 0;
    let deliver!: (request: unknown) => void;
    let activeRequestId = 77;
    let resolveRun!: (result: { reason: string; text: string }) => void;
    let rejectRun!: (error: Error) => void;
    const runResult = new Promise<{ reason: string; text: string }>((resolve, reject) => {
      resolveRun = resolve;
      rejectRun = reject;
    });
    const gateway = new AgentServer({
      chatManager: new ChatSessionManager({
        runtime: engine.runtime ?? ({} as never),
        engineFactory: () => engine,
      }),
      ownsBackgroundWakeups: false,
      transport: {
        onMessage(handler) {
          deliver = handler;
        },
        close() {},
        send(raw) {
          const message = raw as {
            id?: number;
            error?: { message: string };
            result?: { reason: string; text: string };
            method?: string;
            params?: { sessionId: string; event: import("@cjhyy/code-shell-core").StreamEvent };
          };
          if (message.method === "agent/streamEvent" && message.params) {
            if (message.params.event.type === "error")
              console.error(JSON.stringify({ fixtureEngineError: message.params.event }));
            frames++;
            const entry = snapshots.append(message.params.sessionId, message.params.event);
            remote.broadcast({
              type: "session.stream",
              sessionId: message.params.sessionId,
              epoch: snapshots.epoch,
              ...entry,
            });
          }
          if (message.id === activeRequestId) {
            if (message.error) rejectRun(new Error(message.error.message));
            else if (message.result) resolveRun(message.result);
          }
        },
      },
    });
    cleanupGateway = () => gateway.close();
    deliver({
      jsonrpc: "2.0",
      id: 77,
      method: "agent/run",
      params: {
        task: "Return local fixture output",
        displayText: "Return local fixture output",
        sessionId: "native-mobile",
        clientMessageId: "stable-native-submit",
        behaviorMode: "mobile-fixture",
        cwd,
      },
    });
    const result = await runResult;
    assert.equal(result.reason, "completed");
    assert.equal(hash(result.text), hash(expected));
    assert.ok(frames > 2000);
    assert.deepEqual(snapshots.get("native-mobile").outputInputIds, ["stable-native-submit"]);
    assert.equal(snapshots.get("native-mobile").outputUnpaired, undefined);
    const retained = snapshots.get("native-mobile");
    assert.ok(
      retained.nextSeq > 2000 && (!retained.events.length || retained.events[0]!.seq > 1),
      "RAM prefix must be evicted",
    );
    const journalBytes = statSync(
      join(sessionsRoot(), "native-mobile", "output-journal.jsonl"),
    ).size;
    const NativeEvent = globalThis.Event;
    ensureMiniDom();
    // This fixture shares a PID between a Node host and a tiny React DOM. The
    // real product uses separate host/browser contexts. Retain the Node SDK's
    // default browser rejection; do not enable dangerouslyAllowBrowser.
    Reflect.deleteProperty(globalThis, "navigator");
    // React's tiny DOM needs a shim; native Undici WebSocket requires the real Event class.
    Object.defineProperty(globalThis, "Event", { configurable: true, value: NativeEvent });
    const storage = new Map([
      ["cs.deviceId", device.id],
      ["cs.deviceSecret", "synthetic-mobile-secret"],
      ["cs.deviceName", "Synthetic phone"],
    ]);
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
    });
    const NativeWebSocket = globalThis.WebSocket;
    assert.equal(typeof NativeWebSocket, "function", "Native Mobile smoke requires Node >=22.16");
    class FixtureWebSocket extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        assert.equal(
          String(url),
          origin.replace(/^http/, "ws") + "/ws",
          "Non-fixture WebSocket refused",
        );
        super(url, protocols);
      }
    }
    assert.throws(() => new FixtureWebSocket("wss://example.com/ws"), /Non-fixture/);
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: FixtureWebSocket });
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { origin, pathname: "/mobile", search: "" },
    });
    Object.defineProperty(window, "history", { configurable: true, value: { replaceState() {} } });
    const hook = await renderHook(() => useRemoteApp());
    cleanupHook = () => hook.unmount();
    const text = () =>
      hook.result.current.chat.items
        .filter((item) => item.kind === "assistant")
        .map((item) => item.text)
        .join("");
    const until = async (condition: () => boolean) => {
      for (let count = 0; count < 400; count++) {
        await act(async () => {
          await sleep(10);
          await flushMicrotasks();
        });
        if (condition()) return;
      }
      throw new Error(
        "Mobile fixture did not settle: " +
          JSON.stringify({
            notice: hook.result.current.notice,
            routed: routed.slice(-8),
            pages: pageRequests,
          }),
      );
    };
    await until(() => remote.onlineDeviceIds().includes(device.id));
    await act(async () => {
      hook.result.current.selectSession("native-mobile");
      await flushMicrotasks();
    });
    await until(() => text().length === expected.length);
    assert.equal(hash(text()), hash(expected));
    assert.equal(hook.result.current.chat.run, "completed");
    assert.equal(
      hook.result.current.chat.items.find((item) => item.kind === "user")?.clientMessageId,
      "stable-native-submit",
    );
    assert.ok(pageRequests > 8);
    assert.ok(maximumPageBytes <= 1024 * 1024 + 16 * 1024);
    // A normal second request is produced by the same actual AgentServer.
    // Its preliminary stable-ID input must not permanently fence the new Run.
    activeRequestId = 78;
    const followResult = new Promise<{ reason: string; text: string }>((resolve, reject) => {
      resolveRun = resolve;
      rejectRun = reject;
    });
    await act(async () => {
      deliver({
        jsonrpc: "2.0",
        id: 78,
        method: "agent/run",
        params: {
          task: "Follow up",
          displayText: "Follow up",
          sessionId: "native-mobile",
          clientMessageId: "stable-native-follow",
          behaviorMode: "mobile-fixture",
          cwd,
        },
      });
      assert.equal((await followResult).reason, "completed");
    });
    const displayExpected = expected + "native-follow-up";
    await until(() => text() === displayExpected && hook.result.current.chat.run === "completed");
    assert.equal(hook.result.current.notice, undefined);
    assert.equal(
      hook.result.current.chat.items.filter(
        (item) => item.kind === "user" && item.clientMessageId === "stable-native-follow",
      ).length,
      1,
    );
    const beforeRetryRequests = modelRequests,
      beforeRetryFrames = frames,
      beforeRetryPages = completedPages;
    activeRequestId = 79;
    const retryResult = new Promise<{ reason: string; text: string }>((resolve, reject) => {
      resolveRun = resolve;
      rejectRun = reject;
    });
    await act(async () => {
      deliver({
        jsonrpc: "2.0",
        id: 79,
        method: "agent/run",
        params: {
          task: "Return local fixture output",
          displayText: "Return local fixture output",
          sessionId: "native-mobile",
          clientMessageId: "stable-native-submit",
          behaviorMode: "mobile-fixture",
          cwd,
        },
      });
      const replayed = await retryResult;
      assert.equal(replayed.reason, "completed");
      assert.equal(hash(replayed.text), hash(expected));
    });
    assert.equal(modelRequests, beforeRetryRequests, "Idempotent retry must not call the model");
    assert.equal(
      frames,
      beforeRetryFrames + 1,
      "Retry only produces its preliminary input, no new start",
    );
    await until(() => completedPages > beforeRetryPages);
    await act(async () => {
      await sleep(20);
      await flushMicrotasks();
    });
    const title = {
      type: "session_title" as const,
      sessionId: "native-mobile",
      title: "Retry joined",
    };
    remote.broadcast({
      type: "session.stream",
      sessionId: "native-mobile",
      epoch: snapshots.epoch,
      ...snapshots.append("native-mobile", title),
    });
    await until(() => hook.result.current.chat.title === "Retry joined");
    assert.equal(text(), displayExpected);
    assert.equal(hook.result.current.notice, undefined);
    const oldEpoch = snapshots.epoch,
      oldCursor = snapshots.get("native-mobile").outputCursor;
    const oldPages = pageRequests;
    await act(async () => {
      await remote.stop();
      await sleep(20);
    });
    snapshots = new SessionSnapshotStore();
    await remote.start({ host: "127.0.0.1", port });
    // An actual authenticated WS reconnect joins the new Main transport epoch.
    await until(
      () =>
        pageRequests > oldPages + 8 &&
        !hook.result.current.loading.sessionHistory &&
        hook.result.current.chat.run === "completed",
    );
    assert.notEqual(snapshots.epoch, oldEpoch);
    assert.equal(hash(text()), hash(displayExpected));
    const { readOutputJournal } = await import("@cjhyy/code-shell-core/internal");
    assert.equal(readOutputJournal(sessionsRoot(), "native-mobile").through, oldCursor);
    // Real writer appends a new unfinished run; drop one live Main frame then send the suffix.
    const manager = new SessionManager();
    const active = manager.readSessionState("native-mobile")!;
    manager.startSessionRun(active, "native-tail");
    const writer = new SessionOutputJournal(sessionsRoot(), "native-mobile", "native-tail");
    const publish = (event: import("@cjhyy/code-shell-core").StreamEvent, send: boolean) => {
      const entry = snapshots.append("native-mobile", {
        ...event,
        outputCursor: writer.append(event),
      });
      if (send)
        remote.broadcast({
          type: "session.stream",
          sessionId: "native-mobile",
          epoch: snapshots.epoch,
          ...entry,
        });
    };
    publish({ type: "stream_request_start", turnNumber: 1, messageId: "tail-reply" }, true);
    await until(() => hook.result.current.chat.run === "running");
    publish({ type: "text_delta", text: "missing-" }, false);
    appendDuringReply = () => publish({ type: "text_delta", text: "+frozen-join" }, true);
    publish({ type: "text_delta", text: "suffix" }, true);
    await until(() => text() === displayExpected + "missing-suffix+frozen-join");
    assert.ok(frozenAppendThrough);
    assert.equal(hook.result.current.chat.run, "running", "EOF is not terminal");
    const visibleHash = hash(text());
    publish({ type: "text_delta", text: "unrecoverable-prefix" }, false);
    publish({ type: "text_delta", text: "unrecoverable-suffix" }, true);
    truncateSync(join(sessionsRoot(), "native-mobile", "output-journal.jsonl"), 0);
    // Corruption cannot release a replacement candidate or forge a completion.
    await until(() => Boolean(hook.result.current.notice));
    assert.equal(hash(text()), visibleHash);
    assert.notEqual(hook.result.current.chat.run, "completed");
    await getProjectStore().remove(project.id);
    await assert.rejects(mobileOutputRecoveryAuthority("native-mobile"));
    devices.revoke(device.id);
    remote.revokeDevice(device.id);
    await until(() => !remote.onlineDeviceIds().length);
    console.log(
      JSON.stringify({
        mobileNativeRecovery: true,
        elapsedMs: Date.now() - startedAt,
        actualPid: process.pid,
        ppid: process.ppid,
        homeHash: hash(process.env.HOME!),
        modelRequests,
        frames,
        recoveredBytes: Buffer.byteLength(expected),
        journalBytes,
        pageRequests,
        maximumPageBytes,
        stableSubmit: true,
        actualAgentServerPreliminaryInput: true,
        actualFollowUpInput: true,
        actualIdempotentRetry: true,
        newMainEpoch: true,
        authenticatedWsReconnect: true,
        frozenAppendJoined: true,
        sameEpochGap: true,
        unfinishedNotCompleted: true,
        corruptionBarrier: true,
        projectRevoked: true,
        deviceRevoked: true,
        visibleBeforeDamageHash: visibleHash,
      }),
    );
  } finally {
    await cleanupHook();
    await cleanupGateway();
    cleanupEngine();
    await remote.stop();
    if (nativeNavigator) Object.defineProperty(globalThis, "navigator", nativeNavigator);
  }
}
