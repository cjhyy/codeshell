import { afterEach, describe, expect, test } from "bun:test";
import type {
  CloudEnvironmentApi,
  CloudEnvironmentEvent,
  CloudConnectionStatus,
  CloudConfiguration,
} from "../../shared/cloud-environment";
import type { CloudProjectBinding } from "../../shared/project-runtime";
import { CloudProjectRuntime, cloudSessionUiId } from "./CloudProjectRuntime";
import { hydrateCloudHistory, replayCloudTranscript } from "./cloudHistory";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../../../../core/src/session/session-manager";
import {
  SessionOutputJournal,
  readOutputJournal,
} from "../../../../core/src/session/output-journal";
const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const binding: CloudProjectBinding = {
  id: "binding-one",
  localProjectId: "local-one",
  origin: "https://cloud.example.com",
  environmentId: "environment-one",
  environmentName: "Cloud",
  remoteProjectId: "project-one",
  remoteProjectName: "Existing",
  createdAt: 1,
  updatedAt: 1,
};
const configuration: CloudConfiguration = {
  workspace: { path: "/remote/repo", settingsScope: "local", skillDirectories: [] },
  defaults: {},
  connections: [],
  catalog: [],
  skills: [],
  mcpServers: [],
  restartRequired: false,
};
const pause = () => new Promise((resolve) => setTimeout(resolve, 0));
function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup() {
  let events: ((event: CloudEnvironmentEvent) => void) | undefined;
  let status: ((value: CloudConnectionStatus) => void) | undefined;
  let count = 0;
  let sessionRows: unknown[] = [];
  const calls: Array<{ connectionId: string; method: string; params: Record<string, unknown> }> =
    [];
  const runs: Array<ReturnType<typeof deferred>> = [];
  const details = new Map<string, unknown>();
  const runtimeApi = {
    onEvent: (callback) => {
      events = callback;
      return () => {
        events = undefined;
      };
    },
    onStatus: (callback) => {
      status = callback;
      return () => {
        status = undefined;
      };
    },
    connect: async () => ({
      connectionId: `connection-${++count}`,
      binding,
      configuration,
      generation: count,
    }),
    disconnect: async () => undefined,
    listSessions: async () => sessionRows,
    readConfiguration: async () => configuration,
    start: async () => ({ id: binding.remoteProjectId }),
    upload: async (input) => ({
      id: "upload-0001",
      name: input.name,
      mimeType: input.mimeType,
      size: input.bytes.length,
    }),
    request: async (input) => {
      calls.push(input);
      if (input.method === "agent/run") {
        const run = deferred();
        runs.push(run);
        return run.promise;
      }
      if (input.method !== "agent/query") return {};
      if (input.params.type === "output_journal") return { data: { status: "unavailable" } };
      if (input.params.type === "output_coverage")
        return { data: { unpaired: false, inputIds: [] } };
      const detail = details.get(String(input.params.sessionId));
      if (detail instanceof Promise) return detail;
      if (detail instanceof Error) throw detail;
      return { data: detail ?? { transcript: [], running: false } };
    },
  } as CloudEnvironmentApi;
  const runtime = new CloudProjectRuntime(binding, runtimeApi);
  return {
    runtime,
    calls,
    runs,
    details,
    api: runtimeApi,
    rows: (rows: unknown[]) => {
      sessionRows = rows;
    },
    event: (
      method: string,
      params: Record<string, unknown>,
      overrides: Partial<CloudEnvironmentEvent> = {},
    ) =>
      events?.({
        connectionId: runtime.getSnapshot().connectionId!,
        bindingId: binding.id,
        environmentId: binding.environmentId,
        projectId: binding.remoteProjectId,
        method,
        params,
        ...overrides,
      }),
    status: (value: "connected" | "disconnected") =>
      status?.({
        connectionId: runtime.getSnapshot().connectionId!,
        bindingId: binding.id,
        status: value,
      }),
    rawHandler: () => events,
  };
}
async function selected(f: ReturnType<typeof setup>, id = "session-alpha") {
  f.rows([
    {
      sessionId: id,
      title: "Existing cloud history",
      startedAt: 1,
      lastActiveAt: 2,
      running: false,
    },
  ]);
  await f.runtime.connect();
  f.runtime.selectSession(cloudSessionUiId(binding.id, id));
  await pause();
}

describe("native cloud project runtime", () => {
  test("projects cloud history into scoped UI IDs and keeps native reducer output", async () => {
    const f = setup();
    f.details.set("session-alpha", {
      transcript: [
        { id: "meta", type: "session_meta", data: { sessionId: "session-alpha" } },
        {
          id: "user",
          type: "message",
          data: { role: "user", content: "Existing question", clientMessageId: "old-input" },
        },
        { id: "answer", type: "message", data: { role: "assistant", content: "Existing answer" } },
      ],
      running: false,
    });
    await selected(f);
    expect(f.runtime.getSnapshot().error).toBe("");
    expect(f.runtime.getSnapshot().sessions[0].id).toBe("cloud:binding-one:session-alpha");
    expect(f.runtime.getSnapshot().state.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "user", text: "Existing question" }),
        expect.objectContaining({ kind: "assistant", text: "Existing answer" }),
      ]),
    );
    f.runtime.disconnect();
  });

  test("send streams through native reducer and rejects wrong environment/project/connection/session", async () => {
    const f = setup();
    await f.runtime.connect();
    f.runtime.setDraft("hello");
    const send = f.runtime.send("hello");
    const id = f.runtime.getSnapshot().remoteSessionId!;
    const call = f.calls.find((item) => item.method === "agent/run")!;
    expect(Object.keys(call.params).sort()).toEqual(["clientMessageId", "sessionId", "task"]);
    f.event("agent/streamEvent", { sessionId: id, event: { type: "stream_request_start" } });
    for (const overrides of [
      { connectionId: "stale" },
      { environmentId: "wrong" },
      { projectId: "wrong" },
    ])
      f.event(
        "agent/streamEvent",
        { sessionId: id, event: { type: "text_delta", text: "WRONG" } },
        overrides,
      );
    f.event("agent/streamEvent", {
      sessionId: "other",
      event: { type: "text_delta", text: "WRONG" },
    });
    f.event("agent/streamEvent", {
      sessionId: id,
      event: { type: "text_delta", text: "Cloud answer" },
    });
    expect(
      f.runtime
        .getSnapshot()
        .state.messages.some(
          (message) => message.kind === "assistant" && message.text.includes("Cloud answer"),
        ),
    ).toBe(true);
    expect(JSON.stringify(f.runtime.getSnapshot().state)).not.toContain("WRONG");
    f.runs[0].resolve({});
    await send;
    f.runtime.disconnect();
  });

  test("buffers stream during hydration and applies only notifications newer than snapshot", async () => {
    const f = setup();
    const detail = deferred();
    f.details.set("session-alpha", detail.promise);
    f.rows([{ sessionId: "session-alpha", startedAt: 1 }]);
    await f.runtime.connect();
    f.runtime.selectSession(cloudSessionUiId(binding.id, "session-alpha"));
    f.event("agent/streamEvent", {
      sessionId: "session-alpha",
      hubEpoch: "epoch",
      hubSequence: 1,
      event: { type: "text_delta", text: "duplicate" },
    });
    f.event("agent/streamEvent", {
      sessionId: "session-alpha",
      hubEpoch: "epoch",
      hubSequence: 2,
      event: { type: "text_delta", text: "new tail" },
    });
    detail.resolve({
      data: {
        transcript: [],
        streamCursor: { epoch: "epoch", sequence: 1 },
        liveStream: {
          events: [{ sequence: 1, event: { type: "stream_request_start" } }],
          truncated: false,
        },
        running: true,
      },
    });
    await pause();
    expect(JSON.stringify(f.runtime.getSnapshot().state)).toContain("new tail");
    expect(JSON.stringify(f.runtime.getSnapshot().state)).not.toContain("duplicate");
    f.runtime.disconnect();
  });

  test("a new remote stream epoch reloads authority instead of silently dropping the stream", async () => {
    const f = setup();
    f.details.set("session-alpha", {
      transcript: [],
      streamCursor: { epoch: "old-epoch", sequence: 4 },
      running: false,
    });
    await selected(f);
    f.details.set("session-alpha", {
      transcript: [
        { type: "message", data: { role: "user", content: "Recovered after worker restart" } },
      ],
      streamCursor: { epoch: "new-epoch", sequence: 1 },
      running: false,
    });
    f.event("agent/streamEvent", {
      sessionId: "session-alpha",
      hubEpoch: "new-epoch",
      hubSequence: 1,
      event: { type: "text_delta", text: "new worker output" },
    });
    await pause();
    expect(f.runtime.getSnapshot().state.messages).toContainEqual(
      expect.objectContaining({ kind: "user", text: "Recovered after worker restart" }),
    );
    expect(f.runtime.getSnapshot().historyFailed).toBe(false);
    f.runtime.disconnect();
  });

  test("stale selected-session hydration cannot replace the next session", async () => {
    const f = setup();
    const detail = deferred();
    f.details.set("session-alpha", detail.promise);
    f.rows([{ sessionId: "session-alpha" }, { sessionId: "session-beta" }]);
    await f.runtime.connect();
    f.runtime.selectSession(cloudSessionUiId(binding.id, "session-alpha"));
    f.runtime.selectSession(cloudSessionUiId(binding.id, "session-beta"));
    await pause();
    detail.resolve({
      data: {
        transcript: [{ type: "message", data: { role: "user", content: "STALE" } }],
        running: false,
      },
    });
    await pause();
    expect(f.runtime.getSnapshot().remoteSessionId).toBe("session-beta");
    expect(JSON.stringify(f.runtime.getSnapshot().state)).not.toContain("STALE");
    f.runtime.disconnect();
  });

  test("approval and AskUser use remote request authority and never local autoapproval", async () => {
    const f = setup();
    await selected(f);
    f.event("agent/approvalRequest", {
      sessionId: "other",
      requestId: "other-approval",
      request: { toolName: "Bash", args: {} },
    });
    expect(f.runtime.getSnapshot().pendingApproval).toBeNull();
    f.event("agent/approvalRequest", {
      sessionId: "session-alpha",
      requestId: "approval",
      request: { toolName: "Bash", args: { command: "pwd" } },
    });
    expect(f.calls.filter((call) => call.method === "agent/approve")).toHaveLength(0);
    await f.runtime.approve("approval", true);
    expect(f.calls.find((call) => call.method === "agent/approve")?.params).toEqual({
      sessionId: "session-alpha",
      requestId: "approval",
      decision: { approved: true },
    });
    f.event("agent/approvalRequest", {
      sessionId: "session-alpha",
      requestId: "ask",
      request: {
        toolName: "__ask_user__",
        args: { question: "Choose", options: [{ label: "Yes", description: "Continue" }] },
      },
    });
    expect(f.runtime.getSnapshot().state.messages).toContainEqual(
      expect.objectContaining({ kind: "ask_user", requestId: "ask", question: "Choose" }),
    );
    await f.runtime.approve("ask", true, "Yes");
    expect(f.runtime.getSnapshot().state.messages).toContainEqual(
      expect.objectContaining({ kind: "ask_user", answer: "Yes" }),
    );
    f.runtime.disconnect();
  });

  test("pre-connect approval snapshots are retained and stale approval completions cannot affect another session", async () => {
    const f = setup();
    f.rows([{ sessionId: "session-alpha" }, { sessionId: "session-beta" }]);
    f.api.connect = async () => {
      f.event(
        "serve/approvalSnapshot",
        {
          approvals: [
            {
              sessionId: "session-alpha",
              requestId: "early-approval",
              request: { toolName: "Bash", args: { command: "pwd" } },
            },
          ],
        },
        { connectionId: "early-connection" },
      );
      return { connectionId: "early-connection", binding, configuration, generation: 1 };
    };
    await f.runtime.connect();
    f.runtime.selectSession(cloudSessionUiId(binding.id, "session-alpha"));
    await pause();
    expect(f.runtime.getSnapshot().pendingApproval?.requestId).toBe("early-approval");
    const approval = deferred();
    const originalRequest = f.api.request;
    f.api.request = (input) =>
      input.method === "agent/approve" ? approval.promise : originalRequest(input);
    const pending = f.runtime.approve("early-approval", false, undefined, "wrong target");
    f.runtime.selectSession(cloudSessionUiId(binding.id, "session-beta"));
    await pause();
    approval.reject(new Error("expired"));
    await pending;
    expect(f.runtime.getSnapshot().remoteSessionId).toBe("session-beta");
    expect(f.runtime.getSnapshot().error).toBe("");
    expect(f.runtime.getSnapshot().pendingApproval).toBeNull();
    f.runtime.disconnect();
  });

  test("incomplete remote history blocks send until a successful authoritative reload", async () => {
    const f = setup();
    f.details.set("session-alpha", {
      transcript: [],
      liveStream: { events: [], truncated: true },
      running: false,
    });
    await selected(f);
    expect(f.runtime.getSnapshot().historyFailed).toBe(true);
    f.runtime.setDraft("preserve on history failure");
    await f.runtime.send("preserve on history failure");
    expect(f.calls.filter((call) => call.method === "agent/run")).toHaveLength(0);
    expect(f.runtime.getSnapshot().draft).toBe("preserve on history failure");
    f.details.set("session-alpha", { transcript: [], running: false });
    await f.runtime.refresh();
    expect(f.runtime.getSnapshot().historyFailed).toBe(false);
    f.runtime.disconnect();
  });

  test("disconnect never resends an uncertain task and reconnect reconciles clientMessageId", async () => {
    const f = setup();
    await f.runtime.connect();
    const send = f.runtime.send("execute once");
    const id = f.runtime.getSnapshot().remoteSessionId!;
    const clientMessageId = String(
      f.calls.find((call) => call.method === "agent/run")!.params.clientMessageId,
    );
    const oldHandler = f.rawHandler();
    const oldConnection = f.runtime.getSnapshot().connectionId!;
    f.status("disconnected");
    f.runs[0].reject(Object.assign(new Error("ack lost"), { kind: "transport" }));
    await send;
    expect(f.runtime.getSnapshot().busy).toBe(true);
    f.rows([{ sessionId: id, running: false }]);
    f.details.set(id, {
      transcript: [
        {
          id: "user",
          type: "message",
          data: { role: "user", content: "execute once", clientMessageId },
        },
      ],
      running: false,
    });
    await f.runtime.reconnect();
    oldHandler?.({
      connectionId: oldConnection,
      bindingId: binding.id,
      environmentId: binding.environmentId,
      projectId: binding.remoteProjectId,
      method: "agent/streamEvent",
      params: { sessionId: id, event: { type: "text_delta", text: "STALE" } },
    });
    expect(f.calls.filter((call) => call.method === "agent/run")).toHaveLength(1);
    expect(f.runtime.getSnapshot().busy).toBe(false);
    expect(f.runtime.getSnapshot().draft).toBe("");
    expect(JSON.stringify(f.runtime.getSnapshot().state)).not.toContain("STALE");
    f.runtime.disconnect();
  });

  test("certain rejection restores unsent input; uncertain absent session restores only after reconciliation", async () => {
    const f = setup();
    await f.runtime.connect();
    f.runtime.setDraft("restore me");
    const send = f.runtime.send("restore me");
    f.runs[0].reject(Object.assign(new Error("rejected"), { kind: "response" }));
    await send;
    expect(f.runtime.getSnapshot().draft).toBe("restore me");
    expect(
      f.runtime.getSnapshot().state.messages.filter((message) => message.kind === "user"),
    ).toHaveLength(0);
    const second = f.runtime.send("restore me");
    const id = f.runtime.getSnapshot().remoteSessionId!;
    f.status("disconnected");
    f.runs[1].reject(Object.assign(new Error("transport"), { kind: "transport" }));
    await second;
    expect(f.runtime.getSnapshot().draft).toBe("");
    f.details.set(
      id,
      Object.assign(new Error(`Session not found: ${id}`), { kind: "response", code: -32001 }),
    );
    await f.runtime.reconnect();
    expect(f.runtime.getSnapshot().draft).toBe("restore me");
    expect(f.runtime.getSnapshot().busy).toBe(false);
    f.runtime.disconnect();
  });

  test("stop waits for remote authority instead of claiming local cancellation", async () => {
    const f = setup();
    await f.runtime.connect();
    const send = f.runtime.send("running");
    const id = f.runtime.getSnapshot().remoteSessionId!;
    f.details.set(id, { transcript: [], running: true });
    await f.runtime.stop();
    expect(f.calls.find((call) => call.method === "agent/cancel")?.params).toEqual({
      sessionId: id,
    });
    expect(f.runtime.getSnapshot().busy).toBe(true);
    f.runs[0].resolve({});
    await send;
    f.runtime.disconnect();
  });

  test("switching away preserves draft/upload identity and uploads explicit bytes only", async () => {
    const f = setup();
    await f.runtime.connect();
    f.runtime.setDraft("unsent");
    await f.runtime.addFiles([new File(["remote bytes"], "note.txt", { type: "text/plain" })]);
    const id = f.runtime.getSnapshot().remoteSessionId;
    expect(f.runtime.getSnapshot().uploads[0]).toEqual({
      id: "upload-0001",
      name: "note.txt",
      mimeType: expect.stringContaining("text/plain"),
      size: 12,
    });
    f.runtime.disconnect();
    await f.runtime.connect();
    expect(f.runtime.getSnapshot().remoteSessionId).toBe(id);
    expect(f.runtime.getSnapshot().draft).toBe("unsent");
    expect(f.runtime.getSnapshot().uploads).toHaveLength(1);
    f.runtime.disconnect();
  });
});

describe("native cloud history completeness", () => {
  test("replays a real multi-page durable journal into native user/tool/assistant cards", async () => {
    const root = mkdtempSync(join(tmpdir(), "codeshell-cloud-history-"));
    temporaryDirectories.push(root);
    const manager = new SessionManager(root);
    const session = manager.create(root, "fixture", "fixture", "remote-history");
    manager.startSessionRun(session.state, "run");
    const writer = new SessionOutputJournal(root, "remote-history", "run", "legacy-meta");
    writer.append({
      type: "session_user_message",
      text: "durable question",
      clientMessageId: "durable-input",
    });
    writer.append({ type: "stream_request_start", turnNumber: 1 });
    writer.append({ type: "text_delta", text: "durable answer" });
    writer.append({
      type: "tool_use_start",
      toolCall: { id: "durable-tool", toolName: "Bash", args: { command: "pwd" } },
    });
    writer.append({
      type: "tool_result",
      result: { id: "durable-tool", result: "/remote", isError: false },
    });
    writer.append({ type: "turn_complete", reason: "completed" } as any);
    const first = readOutputJournal(root, "remote-history", { maxFrames: 2 });
    const proof = {
      unpaired: false,
      inputIds: ["durable-input"],
      incarnation: first.coverageIdentity,
      journalIdentity: writer.identityPin,
      outputCursor: first.through,
    };
    const restored = await hydrateCloudHistory({
      detail: {
        transcript: [
          { id: "legacy-meta", type: "session_meta", data: { sessionId: "remote-history" } },
        ],
        outputJournal: first,
        outputCoverage: proof,
        running: false,
      },
      buffered: [],
      read: async (options) =>
        readOutputJournal(root, "remote-history", { ...options, maxFrames: 2 }),
      coverage: async () => proof,
      canContinue: () => true,
    });
    expect(restored.state.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "user",
          text: "durable question",
          clientMessageId: "durable-input",
        }),
        expect.objectContaining({ kind: "assistant", text: "durable answer", done: true }),
        expect.objectContaining({
          kind: "tool",
          id: "durable-tool",
          result: "/remote",
          status: "succeeded",
        }),
      ]),
    );
    expect(restored.state.outputCursor).toBe(first.through);
  });

  test("shared transcript projection folds native tools and assistant messages", () => {
    const state = replayCloudTranscript([
      {
        type: "tool_use",
        data: { toolCallId: "tool", toolName: "Bash", args: { command: "pwd" } },
      },
      { type: "tool_result", data: { toolCallId: "tool", result: "remote" } },
    ]);
    expect(state.messages).toContainEqual(
      expect.objectContaining({
        kind: "tool",
        toolName: "Bash",
        result: "remote",
        status: "succeeded",
      }),
    );
  });
  test("fails closed for truncated snapshots without a durable journal", async () => {
    await expect(
      hydrateCloudHistory({
        detail: { transcript: [], liveStream: { events: [], truncated: true } },
        buffered: [],
        read: async () => ({ status: "unavailable" }) as any,
        coverage: async () => ({ unpaired: false, inputIds: [] }),
        canContinue: () => true,
      }),
    ).rejects.toThrow("incomplete");
  });
  test("fails closed when durable output is missing its exact legacy prefix", async () => {
    await expect(
      hydrateCloudHistory({
        detail: {
          transcript: [],
          outputJournal: { status: "ok", legacyBaseThroughEventId: "missing" } as any,
        },
        buffered: [],
        read: async () => ({ status: "unavailable" }) as any,
        coverage: async () => ({ unpaired: false, inputIds: [] }),
        canContinue: () => true,
      }),
    ).rejects.toThrow("exact legacy base");
  });
});
