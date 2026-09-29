import { describe, expect, test } from "bun:test";
import { createPetLongTask, parsePetLongTask } from "../../../../pet/src/long-task.js";
import type { DesktopPetProjectionSnapshot } from "./pet-state-aggregator.js";
import type {
  GatewayControlEventInput,
  PetChatControlRequest,
} from "../im-gateway-control-server.js";
import { collectImDecisions, PetImDecisions } from "./pet-im-decisions.js";

function fixture(id = "one") {
  const task = createPetLongTask({
    id,
    sessionId: `session-${id}`,
    originClientMessageId: `im-${id}`,
    objective: "Check quota",
    workspacePath: null,
    at: 100,
    completionTarget: {
      kind: "im-gateway",
      channel: "wechat",
      target: "conversation",
      senderId: "owner",
      isDirectMessage: true,
    },
  });
  const params = {
    sessionId: task.sessionId,
    requestId: `request-${id}`,
    connectionId: "worker",
    generation: 3,
    request: {
      toolName: "__ask_user__",
      description: "Path permission",
      args: {
        question: "Read /private/example?",
        optionsOnly: true,
        options: [
          { label: "允许本次", description: "One read" },
          { label: "拒绝", description: "Skip" },
        ],
      } as Record<string, unknown>,
    },
  };
  const snapshot: DesktopPetProjectionSnapshot = {
    version: 1,
    generation: 7,
    workerState: "active",
    sessions: [],
    observedAt: 100,
    workMemorySegments: [],
    pending: [
      {
        agentSessionId: task.sessionId,
        requestId: params.requestId,
        routeGeneration: 3,
        workerGeneration: 7,
        kind: "ask_user",
        title: "需要用户回答",
        createdAt: 100,
        status: "pending",
      },
    ],
  };
  const read = () =>
    collectImDecisions(
      snapshot,
      [task],
      [JSON.stringify({ method: "agent/approvalRequest", params })],
    );
  return { task, params, snapshot, read };
}
function harness(...fixtures: ReturnType<typeof fixture>[]) {
  let now = 20_000;
  const published: GatewayControlEventInput[] = [];
  const approvals: Array<{ requestId: string; decision: unknown }> = [];
  const errors: unknown[] = [];
  const relay = new PetImDecisions({
    read: () => fixtures.flatMap((item) => item.read()),
    now: () => now,
    approve: async (entry, decision) => {
      approvals.push({ requestId: entry.envelope.requestId, decision });
      const f = fixtures.find((item) => item.task.id === entry.task.id)!;
      f.snapshot.pending = [];
    },
    publish: async (event) => {
      published.push(event);
    },
    onError: (error) => errors.push(error),
  });
  const reply = (code: string, answer: string, origin = {}) =>
    relay.reply({
      message: `回答 ${code} ${answer}`,
      origin: {
        channel: "wechat",
        target: "conversation",
        senderId: "owner",
        isDirectMessage: true,
        ...origin,
      },
    });
  return {
    relay,
    published,
    approvals,
    errors,
    reply,
    time: (value: number) => {
      now = value;
    },
  };
}

describe("IM task confirmations", () => {
  test("preserves authenticated origin through durable task parsing", () => {
    const f = fixture();
    expect(parsePetLongTask(JSON.parse(JSON.stringify(f.task)))?.completionTarget).toEqual(
      f.task.completionTarget,
    );
    expect(f.task.completionTarget?.senderId).toBe("owner");
    expect(f.task.completionTarget?.isDirectMessage).toBe(true);
  });
  test("delivers two distinct questions once and answers the exact task", async () => {
    const a = fixture("a"),
      b = fixture("b");
    const h = harness(a, b);
    await h.relay.tick();
    await h.relay.tick();
    expect(h.published).toHaveLength(2);
    const code = b.read()[0]!.code;
    expect(h.published[1]!.text).toContain(`回答 ${code} 1`);
    expect(h.published[1]!.text).toContain("允许本次 — One read");
    expect(h.published[1]!.target).toEqual({ channel: "wechat", target: "conversation" });
    expect(await h.reply(code, "1")).toContain("已处理");
    expect(h.approvals).toEqual([
      { requestId: "request-b", decision: { approved: true, answer: "允许本次" } },
    ]);
    expect(a.read()).toHaveLength(1);
    expect(await h.reply(code, "1")).toContain("已结束");
    expect(h.approvals).toHaveLength(1);
  });
  test("ordinary chat and ambiguous yes never manufacture approval", async () => {
    const f = fixture(),
      h = harness(f),
      code = f.read()[0]!.code;
    expect(await h.relay.reply({ message: "继续啊" })).toBeUndefined();
    expect(await h.reply(code, "好的")).toContain("选项无效");
    expect(await h.reply(code, "3")).toContain("选项无效");
    expect(await h.reply(code, "1,2")).toContain("选项无效");
    expect(h.approvals).toHaveLength(0);
  });
  test("cannot answer from another sender, target, channel or group", async () => {
    const f = fixture(),
      h = harness(f),
      code = f.read()[0]!.code;
    for (const origin of [
      { senderId: "other" },
      { target: "elsewhere" },
      { channel: "telegram" },
      { isDirectMessage: false },
    ]) {
      expect(await h.reply(code, "1", origin)).toContain("不属于当前私聊");
    }
    expect(h.approvals).toHaveLength(0);
  });
  test("legacy and group tasks receive no private details or remote answer authority", async () => {
    const f = fixture();
    delete f.task.completionTarget!.senderId;
    const h = harness(f);
    await h.relay.tick();
    expect(h.published[0]!.text).not.toContain("/private/example");
    expect(await h.reply(f.read()[0]!.code, "1")).toContain("不属于当前私聊");
    expect(h.approvals).toHaveLength(0);
  });
  test("expired asks are explicitly denied, never defaulted to an allow option", async () => {
    const f = fixture(),
      h = harness(f),
      code = f.read()[0]!.code;
    h.time(600_100);
    expect(await h.reply(code, "1")).toContain("超时");
    expect(h.approvals).toHaveLength(1);
    expect(h.approvals[0]!.decision).toMatchObject({ approved: false });
    expect(h.published[0]!.text).toContain("本次操作未获授权");
    await h.relay.tick();
    expect(h.approvals).toHaveLength(1);
  });
  test("cancelled tasks and stale route generations cannot be answered", async () => {
    const f = fixture(),
      h = harness(f),
      oldCode = f.read()[0]!.code;
    f.params.generation++;
    expect(f.read()).toEqual([]);
    expect(await h.reply(oldCode, "1")).toContain("已结束");
    f.snapshot.pending[0]!.routeGeneration++;
    expect(f.read()[0]!.code).not.toBe(oldCode);
    f.task.status = "cancelled";
    await h.relay.tick();
    expect(h.published).toHaveLength(0);
    expect(h.approvals).toHaveLength(0);
  });
  test("auto-approved short-lived prompts never create a notification", async () => {
    const f = fixture(),
      h = harness(f);
    h.time(110);
    await h.relay.tick();
    f.snapshot.pending = [];
    h.time(30_000);
    await h.relay.tick();
    expect(h.published).toHaveLength(0);
  });
  test("tool permissions are once-only and include the exact arguments for review", async () => {
    const f = fixture();
    f.params.request = {
      toolName: "Bash",
      description: "Read status",
      args: { command: "git status" },
    };
    const h = harness(f);
    await h.relay.tick();
    expect(h.published[0]!.text).toContain("git status");
    await h.reply(f.read()[0]!.code, "1");
    expect(h.approvals[0]!.decision).toEqual({ approved: true });
  });
  test("free-text answers and multi-select use the existing ask contract", async () => {
    const a = fixture("free"),
      b = fixture("multi");
    a.params.request.args = { question: "Which file?" };
    b.params.request.args.multiSelect = true;
    const h = harness(a, b);
    await h.reply(a.read()[0]!.code, "a.txt");
    await h.reply(b.read()[0]!.code, "1,2");
    expect(h.approvals.map((item) => item.decision)).toEqual([
      { approved: true, answer: "a.txt" },
      { approved: true, answer: "允许本次, 拒绝" },
    ]);
  });
  test("oversized permission details require reviewing the complete desktop prompt", async () => {
    const f = fixture();
    f.params.request.args.question = "x".repeat(12_001);
    const h = harness(f);
    await h.relay.tick();
    expect(h.published[0]!.text).toContain("查看完整内容");
    const code = f.read()[0]!.code;
    expect(await h.reply(code, "1")).toContain("查看完整确认内容");
    expect(h.approvals).toHaveLength(0);
    await h.reply(code, "拒绝");
    expect(h.approvals[0]!.decision).toMatchObject({ approved: false });
  });

  test("retries publication with the same durable delivery key", async () => {
    const f = fixture();
    const keys: string[] = [];
    let calls = 0;
    const relay = new PetImDecisions({
      read: f.read,
      now: () => 20_000,
      approve: async () => {},
      publish: async (ev) => {
        keys.push(ev.deliveryKey!);
        if (++calls === 1) throw new Error("offline");
      },
      onError: () => {},
    });
    await relay.tick();
    await relay.tick();
    await relay.tick();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });
  test("concurrent answer and timeout cannot submit twice", async () => {
    const f = fixture();
    let finish!: () => void;
    let calls = 0;
    const relay = new PetImDecisions({
      read: f.read,
      now: () => 20_000,
      approve: async () => {
        calls++;
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        f.snapshot.pending = [];
      },
      publish: async () => {},
      onError: () => {},
    });
    const request: PetChatControlRequest = {
      message: `回答 ${f.read()[0]!.code} 1`,
      origin: {
        channel: "wechat",
        target: "conversation",
        senderId: "owner",
        isDirectMessage: true,
        capabilities: {
          inbound: { text: true, attachments: [] },
          outbound: { text: true, attachments: [], button: "link" },
        },
      },
    };
    const first = relay.reply(request);
    expect(await relay.reply(request)).toContain("正在处理");
    finish();
    await first;
    expect(calls).toBe(1);
  });
});

test("HTTP gateway resolves exact decisions before bound Sessions and Mimi", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { GatewayControlServer } = await import("../im-gateway-control-server.js");
  const { DesktopControlClient } = await import("../../../../chat/src/desktop-control-client.js");
  const { ChatGateway } = await import("../../../../chat/src/chat-gateway.js");
  const { createBoundSessionChat } = await import("../../../../chat/src/bound-session-chat.js");
  const { createMimiPetChat } = await import("../../../../chat/src/gateway.js");
  const { BUILTIN_CHANNEL_CAPABILITIES } = await import("../../../../chat/src/channel.js");
  type ChannelAdapter = import("../../../../chat/src/channel.js").ChannelAdapter;
  type ChannelMessage = import("../../../../chat/src/channel.js").ChannelMessage;
  const root = mkdtempSync(join(tmpdir(), "im-decision-gateway-"));
  const descriptorPath = join(root, "control.json");
  const f = fixture("bound");
  const h = harness(f);
  const code = f.read()[0]!.code;
  const boundMessages: string[] = [];
  const mimiMessages: string[] = [];
  const replies: string[] = [];
  const server = new GatewayControlServer({
    descriptorPath,
    open: async () => {
      throw new Error("Remote must not open");
    },
    close: async () => {},
    status: () => ({
      running: false,
      tunnelRunning: false,
      tunnelConnected: false,
      passcodeSet: false,
      onlineDeviceCount: 0,
    }),
    pairingUrl: () => {
      throw new Error("Pairing must not occur");
    },
    routeSession: async (request) => {
      const decision = await h.relay.replyToSession(request);
      if (decision) return decision;
      if (request.target === "unbound") return { kind: "not-bound" };
      boundMessages.push(request.text);
      return { kind: "accepted" };
    },
    petChat: async (request) => {
      mimiMessages.push(request.message);
      return { text: "Mimi reply", petSessionId: "pet" };
    },
  });
  try {
    await server.start();
    const desktop = new DesktopControlClient({
      descriptorPath,
      autoLaunch: false,
      args: [],
      startupTimeoutMs: 1_000,
    });
    const adapter: ChannelAdapter = {
      channel: "wechat",
      capabilities: BUILTIN_CHANNEL_CAPABILITIES.wechat,
      run: async () => {},
      send: async (_target, message) => {
        replies.push(message.text ?? "");
      },
    };
    const gateway = new ChatGateway({
      adapters: [adapter],
      onError: (error) => {
        throw error;
      },
    });
    // Production cli.ts middleware order: bound Session routing runs before Mimi.
    gateway.use(createBoundSessionChat({ desktop }));
    gateway.use(createMimiPetChat({ desktop }));
    const say = (text: string, overrides: Partial<ChannelMessage> = {}) =>
      gateway.dispatch(
        { ...adapter, channel: overrides.channel ?? adapter.channel },
        {
          channel: "wechat",
          target: "conversation",
          senderId: "owner",
          isDirectMessage: true,
          text,
          messageId: crypto.randomUUID(),
          ...overrides,
        },
      );
    for (const origin of [
      { senderId: "other" },
      { target: "another-room" },
      { channel: "telegram" },
      { isDirectMessage: false },
    ]) {
      await say(`回答 ${code} 1`, origin);
      expect(replies.at(-1)).toContain("不属于当前私聊");
    }
    expect(h.approvals).toHaveLength(0);
    expect(boundMessages).toEqual([]);
    expect(mimiMessages).toEqual([]);
    await say(`回答 ${code} 1`);
    expect(replies.at(-1)).toContain("已处理");
    expect(h.approvals).toHaveLength(1);
    await say(`回答 ${code} 1`);
    expect(replies.at(-1)).toContain("已结束");
    expect(h.approvals).toHaveLength(1);
    expect(boundMessages).toEqual([]);
    expect(mimiMessages).toEqual([]);
    await say("ordinary bound chat");
    expect(boundMessages).toEqual(["ordinary bound chat"]);
    await say("ordinary unbound chat", { target: "unbound" });
    expect(mimiMessages).toEqual(["ordinary unbound chat"]);
    expect(replies.at(-1)).toBe("Mimi reply");
  } finally {
    await server.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("worker protocol: IM answer releases the original read; Stop drains queued reads", async () => {
  const { AgentServer } = await import("../../../../core/src/protocol/server.js");
  const { ChatSessionManager } =
    await import("../../../../core/src/protocol/chat-session-manager.js");
  const { enforcePathPolicyWithApproval } =
    await import("../../../../core/src/tool-system/path-policy.js");
  const { homedir, tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  type Engine = import("../../../../core/src/engine/engine.js").Engine;
  type ToolContext = import("../../../../core/src/tool-system/context.js").ToolContext;
  const f = fixture("protocol");
  const frames: any[] = [];
  let receive!: (message: any) => void;
  let askUser: ToolContext["askUser"];
  let results: Array<string | null> | undefined;
  const engine = {
    setAskUser(fn: ToolContext["askUser"]) {
      askUser = fn;
    },
    setPlanMode() {},
    setBrowserBridge() {},
    setInjectCredential() {},
    setSessionMessageRouter() {},
    isHeadless: () => false,
    async run(_task: string, options: { signal: AbortSignal; sessionId: string }) {
      const ctx = {
        cwd: join(tmpdir(), "im-decision-protocol"),
        sessionId: options.sessionId,
        signal: options.signal,
        askUser,
      } as ToolContext;
      results = await Promise.all(
        [".claude", ".codex", ".ssh"].map((dir) =>
          enforcePathPolicyWithApproval(join(homedir(), dir), "read", ctx),
        ),
      );
      return {
        text: "finished",
        reason: "completed",
        sessionId: options.sessionId,
        turnCount: 1,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    },
  } as unknown as Engine;
  const manager = new ChatSessionManager({ runtime: {} as never, engineFactory: () => engine });
  new AgentServer({
    connectionId: "im-protocol-test",
    chatManager: manager,
    transport: {
      send: (frame: unknown) => {
        frames.push(frame);
      },
      onMessage: (fn: any) => {
        receive = fn;
      },
      close() {},
    } as any,
  });
  const waitFor = async (predicate: () => boolean) => {
    for (let i = 0; i < 200; i++) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Worker protocol did not settle");
  };
  const requests = () => frames.filter((frame) => frame.method === "agent/approvalRequest");
  try {
    receive({
      jsonrpc: "2.0",
      id: "run",
      method: "agent/run",
      params: { sessionId: f.task.sessionId, task: "quota" },
    });
    await waitFor(() => requests().length === 1);
    const read = () => {
      const session = manager.get(f.task.sessionId)!;
      f.snapshot.pending = [...session.pendingApprovals.values()].map(({ metadata }) => ({
        ...metadata,
        agentSessionId: metadata.sessionId,
        kind: "ask_user" as const,
        status: "pending" as const,
      }));
      return collectImDecisions(
        f.snapshot,
        [f.task],
        requests().map((frame) => JSON.stringify(frame)),
      );
    };
    const relay = new PetImDecisions({
      read,
      publish: async () => {},
      onError: (error) => {
        throw error;
      },
      approve: async (entry, decision) => {
        const { request: _request, ...route } = entry.envelope;
        receive({
          jsonrpc: "2.0",
          id: "answer",
          method: "agent/approve",
          params: { ...route, decision },
        });
        await waitFor(() => frames.some((frame) => frame.id === "answer"));
        expect(frames.find((frame) => frame.id === "answer").result).toEqual({ ok: true });
      },
    });
    const code = read()[0]!.code;
    const reply = await relay.reply({
      message: `回答 ${code} 1`,
      origin: {
        channel: "wechat",
        target: "conversation",
        senderId: "owner",
        isDirectMessage: true,
      },
    });
    expect(reply).toContain("已处理");
    await waitFor(() => requests().length === 2);
    receive({
      jsonrpc: "2.0",
      id: "cancel",
      method: "agent/cancel",
      params: { sessionId: f.task.sessionId },
    });
    await waitFor(() => results !== undefined);
    expect(results![0]).toBeNull();
    expect(results!.slice(1).every((result) => result?.includes("cancelled"))).toBe(true);
    expect(requests()).toHaveLength(2);
    expect(manager.get(f.task.sessionId)!.pendingApprovals.size).toBe(0);
  } finally {
    receive({
      jsonrpc: "2.0",
      id: "cleanup",
      method: "agent/cancel",
      params: { sessionId: f.task.sessionId },
    });
  }
});
