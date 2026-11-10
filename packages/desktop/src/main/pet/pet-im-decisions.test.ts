import { describe, expect, test } from "bun:test";
import { createPetLongTask, parsePetLongTask } from "../../../../pet/src/long-task.js";
import type { DesktopPetProjectionSnapshot } from "./pet-state-aggregator.js";
import type { PetChatControlRequest } from "../im-gateway-control-server.js";
import { collectImDecisions, PetImDecisions } from "./pet-im-decisions.js";
import type { RouteDecision } from "./pet-notice-policy.js";
import type {
  NoticePriorDecision,
  NoticeSubmission,
  NoticeSubmitResult,
} from "./pet-notice-types.js";

/** What reached an IM conversation through the (stubbed) notice router. */
interface Sent {
  text: string;
  target: { channel: string; target: string } | { owner: true };
  notice: NoticeSubmission;
}

/** A router that sends every notice to its channel, recording what went out. */
function routerStub(sent: Sent[]) {
  return async (notice: NoticeSubmission): Promise<NoticeSubmitResult> => {
    const channel =
      notice.target.kind === "route" ? notice.target.route.channel : String(notice.channel);
    sent.push({
      text: notice.body!,
      target:
        notice.target.kind === "route"
          ? { channel: notice.target.route.channel, target: notice.target.route.target }
          : { owner: true },
      notice,
    });
    return { decision: { outlet: "both", im: channel, reason: "named-im" }, sent: "accepted" };
  };
}

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
    expiresAt: undefined as number | undefined,
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
  const published: Sent[] = [];
  const approvals: Array<{ requestId: string; decision: unknown }> = [];
  const errors: unknown[] = [];
  const relay = new PetImDecisions({
    read: () => fixtures.flatMap((item) => item.read()),
    now: () => now,
    approve: async (entry, decision) => {
      approvals.push({ requestId: entry.envelope.requestId, decision });
      const f = fixtures.find((item) => item.task.id === entry.task!.id)!;
      f.snapshot.pending = [];
    },
    submit: routerStub(published),
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
  test("a numbered reply gets the exact confirmation format without entering its Session", async () => {
    const f = fixture(),
      h = harness(f);
    const request = {
      message: "2",
      origin: {
        channel: "wechat",
        target: "conversation",
        senderId: "owner",
        isDirectMessage: true,
      },
    };
    // Even after a restart, short replies get deterministic guidance, never authorization.
    expect(await h.relay.reply(request)).toContain(`回答 ${f.read()[0]!.code} 2`);
    expect(h.approvals).toHaveLength(0);
    await h.relay.tick();
    expect(h.published[0]!.text).toContain("无需进入 Session");
    const code = f.read()[0]!.code;
    const guidance = await h.relay.reply(request);
    expect(guidance).toContain(`回答 ${code} 2`);
    expect(guidance).toContain("Read /private/example?");
    expect(h.approvals).toHaveLength(0);
    expect(await h.reply(code, "2")).toContain("已处理");
    expect(h.approvals).toEqual([
      { requestId: "request-one", decision: { approved: true, answer: "拒绝" } },
    ]);
    expect(await h.relay.reply(request)).toContain("已结束或超时");
    expect(h.approvals).toHaveLength(1);
  });
  test("short answers never select among multiple pending questions", async () => {
    const a = fixture("a"),
      b = fixture("b"),
      h = harness(a, b);
    await h.relay.tick();
    const answer = await h.relay.reply({
      message: "1",
      origin: {
        channel: "wechat",
        target: "conversation",
        senderId: "owner",
        isDirectMessage: true,
      },
    });
    expect(answer).toContain(`回答 ${a.read()[0]!.code}`);
    expect(answer).toContain(`回答 ${b.read()[0]!.code}`);
    expect(h.approvals).toHaveLength(0);
    await h.reply(b.read()[0]!.code, "1");
    expect(h.approvals).toHaveLength(1);
  });
  test("short replies are limited to the authenticated recipient of the delivered prompt", async () => {
    const f = fixture(),
      h = harness(f);
    await h.relay.tick();
    for (const override of [
      { senderId: "other" },
      { target: "elsewhere" },
      { channel: "telegram" },
      { isDirectMessage: false },
    ]) {
      expect(
        await h.relay.reply({
          message: "1",
          origin: {
            channel: "wechat",
            target: "conversation",
            senderId: "owner",
            isDirectMessage: true,
            ...override,
          },
        }),
      ).toBeUndefined();
    }
    expect(h.approvals).toHaveLength(0);
  });
  test("a bare number cannot authorize a replacement prompt that was not delivered", async () => {
    const old = fixture("old"),
      replacement = fixture("new"),
      h = harness(old, replacement);
    replacement.snapshot.pending = [];
    await h.relay.tick();
    old.snapshot.pending = [];
    replacement.snapshot.pending = fixture("new").snapshot.pending;
    expect(
      await h.relay.reply({
        message: "1",
        origin: {
          channel: "wechat",
          target: "conversation",
          senderId: "owner",
          isDirectMessage: true,
        },
      }),
    ).toContain(`回答 ${replacement.read()[0]!.code}`);
    expect(h.approvals).toHaveLength(0);
  });
  test("a late numbered reply to an answered question cannot authorize the next delivered question", async () => {
    const a = fixture("a"),
      b = fixture("b"),
      h = harness(a, b);
    b.snapshot.pending = [];
    await h.relay.tick();
    a.snapshot.pending = [];
    b.snapshot.pending = fixture("b").snapshot.pending;
    await h.relay.tick();
    const guidance = await h.relay.reply({
      message: "1",
      origin: {
        channel: "wechat",
        target: "conversation",
        senderId: "owner",
        isDirectMessage: true,
      },
    });
    expect(guidance).toContain(`回答 ${b.read()[0]!.code} 1`);
    expect(h.approvals).toHaveLength(0);
  });
  test("the worker deadline controls both the displayed time and expiration", async () => {
    const f = fixture();
    f.params.expiresAt = 140_000;
    const h = harness(f);
    await h.relay.tick();
    expect(h.published[0]!.text).toContain("剩余约 2 分钟");
    const code = f.read()[0]!.code;
    h.time(140_000);
    expect(await h.reply(code, "1")).toContain("超时");
    expect(h.approvals[0]!.decision).toMatchObject({ approved: false, failure: "timed_out" });
  });
  test("a question resolved on desktop or mobile cannot be answered again through WeChat", async () => {
    const f = fixture(),
      h = harness(f);
    await h.relay.tick();
    const code = f.read()[0]!.code;
    f.snapshot.pending = [];
    await h.relay.tick();
    expect(await h.reply(code, "1")).toContain("已结束");
    expect(
      await h.relay.reply({
        message: "1",
        origin: {
          channel: "wechat",
          target: "conversation",
          senderId: "owner",
          isDirectMessage: true,
        },
      }),
    ).toContain("已结束或超时");
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

  test("retries a failed submission with the same dedupe key", async () => {
    const f = fixture();
    const keys: string[] = [];
    let calls = 0;
    const relay = new PetImDecisions({
      read: f.read,
      now: () => 20_000,
      approve: async () => {},
      submit: async (notice) => {
        keys.push(notice.dedupeKey);
        if (++calls === 1) throw new Error("offline");
        return { decision: { outlet: "both", im: "wechat", reason: "named-im" }, sent: "accepted" };
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
      submit: async () => undefined,
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
    await h.relay.tick();
    await say("1");
    expect(replies.at(-1)).toContain(`回答 ${code} 1`);
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

test("worker protocol: IM answer releases the original write; Stop drains queued writes", async () => {
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
        // Reads never ask; writes outside the workspace do.
        [".claude", ".aws", ".ssh"].map((dir) =>
          enforcePathPolicyWithApproval(join(homedir(), dir, "config"), "write", ctx),
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
      submit: async () => undefined,
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

describe("IM model questions (skippable)", () => {
  function modelQuestion(expiresAt: number | undefined, recommended = true) {
    const f = fixture("model");
    f.params.expiresAt = expiresAt;
    f.params.request.args = {
      question: "哪里的样式奇怪？",
      skippable: true,
      ...(expiresAt !== undefined ? { keepWaitable: true } : {}),
      options: [
        { label: "工作台画布", description: "canvas" },
        {
          label: "对照审阅页",
          description: "review",
          ...(recommended ? { recommended: true } : {}),
        },
      ],
    };
    return f;
  }
  function relayFor(f: ReturnType<typeof fixture>, now: { value: number }) {
    const published: Sent[] = [];
    const approvals: unknown[] = [];
    const kept: string[] = [];
    const relay = new PetImDecisions({
      read: () => f.read(),
      now: () => now.value,
      approve: async (entry, decision) => {
        approvals.push(decision);
        f.snapshot.pending = [];
      },
      keepWaiting: async (entry) => {
        kept.push(entry.envelope.requestId);
        f.params.expiresAt = undefined;
        delete f.params.request.args.keepWaitable;
      },
      submit: routerStub(published),
      onError: () => undefined,
    });
    const reply = (code: string, answer: string) =>
      relay.reply({
        message: `回答 ${code} ${answer}`,
        origin: {
          channel: "wechat",
          target: "conversation",
          senderId: "owner",
          isDirectMessage: true,
        },
      });
    return { relay, published, approvals, kept, reply };
  }

  test("announces the recommended default, Skip and keep waiting", async () => {
    const now = { value: 20_000 };
    const f = modelQuestion(now.value + 120_000);
    const h = relayFor(f, now);
    await h.relay.tick();
    const text = h.published[0]!.text;
    const code = f.read()[0]!.code;
    expect(text).toContain("对照审阅页（推荐）");
    expect(text).toContain("超时未回答将自动选择推荐项「对照审阅页」");
    expect(text).toContain(`回答 ${code} 等待`);
    expect(text).toContain(`回答 ${code} 跳过`);
  });

  test("leaves the timeout to Core instead of submitting a denial", async () => {
    const now = { value: 20_000 };
    const f = modelQuestion(now.value + 120_000);
    const h = relayFor(f, now);
    now.value += 121_000;
    await h.relay.tick();
    expect(h.approvals).toEqual([]);
  });

  test("跳过 declines without a reason so Core reports a skip", async () => {
    const now = { value: 20_000 };
    const f = modelQuestion(now.value + 120_000, false);
    const h = relayFor(f, now);
    const code = f.read()[0]!.code;
    expect(await h.reply(code, "跳过")).toContain("已跳过这个问题");
    expect(h.approvals).toEqual([{ approved: false }]);
  });

  test("等待 keeps the question open, after which it never expires", async () => {
    const now = { value: 20_000 };
    const f = modelQuestion(now.value + 120_000);
    const h = relayFor(f, now);
    const code = f.read()[0]!.code;
    expect(await h.reply(code, "等待")).toContain("已改为一直等待");
    expect(h.kept).toEqual(["request-model"]);
    now.value += 60 * 60_000;
    expect(await h.reply(code, "等待")).toContain("已经在一直等待");
    expect(await h.reply(code, "2")).toContain("回答已交给原任务");
    expect(h.approvals).toEqual([{ approved: true, answer: "对照审阅页" }]);
  });

  test("a conversation that cannot reply gets neither the reply code nor the default", async () => {
    const now = { value: 20_000 };
    const f = modelQuestion(now.value + 120_000);
    f.task.completionTarget!.isDirectMessage = false;
    const h = relayFor(f, now);
    await h.relay.tick();
    const text = h.published[0]!.text;
    expect(text).toContain("请打开桌面 Session 处理");
    expect(text).not.toContain(f.read()[0]!.code);
    expect(text).not.toContain("对照审阅页");
  });

  test("options literally named 等待 and 跳过 are answers, not commands", async () => {
    const now = { value: 20_000 };
    const f = modelQuestion(now.value + 120_000);
    f.params.request.args.options = [
      { label: "等待", description: "wait for CI" },
      { label: "跳过", description: "skip this step" },
    ];
    const h = relayFor(f, now);
    const code = f.read()[0]!.code;
    expect(await h.reply(code, "跳过")).toContain("回答已交给原任务");
    expect(h.kept).toEqual([]);
    expect(h.approvals).toEqual([{ approved: true, answer: "跳过" }]);
  });

  test("a bare 跳过 is not a short reply to a permission request", async () => {
    const now = { value: 20_000 };
    const f = fixture("permission");
    const h = relayFor(f, now);
    await h.relay.tick();
    expect(
      await h.relay.reply({
        message: "跳过",
        origin: {
          channel: "wechat",
          target: "conversation",
          senderId: "owner",
          isDirectMessage: true,
        },
      }),
    ).toBeUndefined();
  });
});

describe("decisions routed through the notice router", () => {
  /** A Session without an IM-started task whose blocked rule targets the owner. */
  function ruleFixture(id = "rule") {
    const f = fixture(id);
    delete f.task.completionTarget;
    const read = () =>
      collectImDecisions(
        f.snapshot,
        [f.task],
        [JSON.stringify({ method: "agent/approvalRequest", params: f.params })],
        (sessionId) =>
          sessionId === f.task.sessionId
            ? {
                ruleIds: ["rule-1"],
                attention: "always",
                channel: "auto",
                target: { kind: "owner" },
              }
            : undefined,
      );
    return { ...f, read };
  }
  const OWNER_DM = { channel: "lark", target: "owner-dm", senderId: "me", isDirectMessage: true };
  /** The owner's private chat on another channel. */
  const OTHER_OWNER_DM = {
    channel: "wechat",
    target: "owner-wx",
    senderId: "me",
    isDirectMessage: true,
  };
  function relayWith(
    read: () => ReturnType<typeof collectImDecisions>,
    decide: (notice: NoticeSubmission) => RouteDecision,
    now = { value: 20_000 },
    extra: Partial<ConstructorParameters<typeof PetImDecisions>[0]> = {},
  ) {
    const submitted: NoticeSubmission[] = [];
    const approvals: unknown[] = [];
    const relay = new PetImDecisions({
      read,
      now: () => now.value,
      approve: async (_entry, decision) => {
        approvals.push(decision);
      },
      submit: async (notice) => {
        submitted.push(notice);
        const decision = decide(notice);
        return {
          decision,
          ...(decision.im && decision.outlet !== "desktop" ? { sent: "accepted" as const } : {}),
        };
      },
      isOwnerConversation: (origin) =>
        (origin.channel === OWNER_DM.channel && origin.target === OWNER_DM.target) ||
        (origin.channel === OTHER_OWNER_DM.channel && origin.target === OTHER_OWNER_DM.target),
      ownerChannelIsDirect: () => true,
      onError: (error) => {
        throw error;
      },
      ...extra,
    });
    return { relay, submitted, approvals, now };
  }
  const toIm = (): RouteDecision => ({ outlet: "im", im: "lark", reason: "away-first-ready" });
  const toDesktop = (): RouteDecision => ({ outlet: "desktop", reason: "present-desktop" });

  test("a rule-watched Session gets one code-bearing P0 prompt for the owner", async () => {
    const f = ruleFixture();
    const h = relayWith(f.read, toIm);
    await h.relay.tick();
    await h.relay.tick();
    expect(h.submitted).toHaveLength(1);
    const code = f.read()[0]!.code;
    expect(h.submitted[0]).toMatchObject({
      kind: "session.blocked",
      priority: "P0",
      dedupeKey: `${f.task.sessionId}:request-rule`,
      requestId: "request-rule",
      expiresAt: 100 + 10 * 60_000,
      sessionId: f.task.sessionId,
      ruleIds: ["rule-1"],
      attention: "always",
      channel: "auto",
      target: { kind: "owner" },
      facts: { question: "Read /private/example?", code },
    });
    expect(h.submitted[0]!.reply).toBeUndefined();
    expect(h.submitted[0]!.body).toContain(`回答 ${code} 1`);
    expect(h.submitted[0]!.body).toContain("允许本次 — One read");

    // Only the owner's own direct chat can answer it.
    const answer = (origin: Record<string, unknown>) =>
      h.relay.reply({ message: `回答 ${code} 1`, origin: { ...OWNER_DM, ...origin } as never });
    expect(await answer({ isDirectMessage: false })).toContain("不属于当前私聊");
    expect(await answer({ target: "someone-else" })).toContain("不属于当前私聊");
    expect(h.approvals).toEqual([]);
    expect(await answer({})).toContain("已处理");
    expect(h.approvals).toEqual([{ approved: true, answer: "允许本次" }]);
  });

  test("an IM-started task prompts its own conversation and replies immediately", async () => {
    const f = fixture("origin");
    const h = relayWith(f.read, () => ({ outlet: "both", im: "wechat", reason: "named-im" }));
    await h.relay.tick();
    await h.relay.tick();
    expect(h.submitted).toHaveLength(1);
    expect(h.submitted[0]).toMatchObject({
      channel: "wechat",
      target: { kind: "route", route: { channel: "wechat", target: "conversation" } },
      reply: true,
      ruleIds: [],
    });
  });

  test("a prompt the router kept on the desktop is never treated as delivered", async () => {
    const f = ruleFixture();
    const h = relayWith(f.read, toDesktop);
    await h.relay.tick();
    expect(h.submitted).toHaveLength(1);
    // The owner never saw a code: a bare number is not an answer to anything.
    expect(await h.relay.reply({ message: "1", origin: OWNER_DM })).toBeUndefined();
    // Core owns the deadline for a decision that never went to IM.
    h.now.value = 100 + 10 * 60_000 + 1;
    await h.relay.tick();
    expect(h.approvals).toEqual([]);
    expect(h.submitted).toHaveLength(1);
  });

  test("an unanswered owner prompt times out and says so on the channel it used", async () => {
    const f = ruleFixture();
    const h = relayWith(f.read, toIm);
    await h.relay.tick();
    h.now.value = 100 + 10 * 60_000 + 1;
    await h.relay.tick();
    expect(h.approvals).toEqual([
      expect.objectContaining({ approved: false, failure: "timed_out" }),
    ]);
    expect(h.submitted[1]).toMatchObject({
      kind: "decision.expired",
      channel: "lark",
      target: { kind: "owner" },
      reply: true,
    });
    expect(h.submitted[1]!.body).toContain("本次操作未获授权");
  });

  test("owner prompts carry a generic text for a chat that is not private", async () => {
    const f = ruleFixture();
    const h = relayWith(f.read, toIm, undefined, { ownerChannelIsDirect: () => false });
    await h.relay.tick();
    const generic = h.submitted[0]!.facts.nonDirectBody!;
    expect(generic).toContain("请打开桌面 Session 处理");
    expect(generic).not.toContain(f.read()[0]!.code);
    expect(generic).not.toContain("/private/example");
    // Sent to a group: nothing there is answerable, so a bare reply is not one.
    expect(await h.relay.reply({ message: "1", origin: OWNER_DM })).toBeUndefined();
  });

  test("a bare answer only counts on the channel the owner prompt went to", async () => {
    const f = ruleFixture();
    const h = relayWith(f.read, toIm);
    await h.relay.tick();
    const code = f.read()[0]!.code;
    expect(await h.relay.reply({ message: "1", origin: OTHER_OWNER_DM })).toBeUndefined();
    expect(await h.relay.reply({ message: "1", origin: OWNER_DM })).toContain(`回答 ${code} 1`);
    // A coded answer may come from any of the owner's private chats.
    expect(await h.relay.reply({ message: `回答 ${code} 1`, origin: OTHER_OWNER_DM })).toContain(
      "已处理",
    );
  });

  test("a prompt kept on the desktop goes to IM once the owner leaves", async () => {
    const f = ruleFixture();
    let away = false;
    const h = relayWith(
      f.read,
      (notice) => (notice.dedupeKey.endsWith(":away") ? toIm() : toDesktop()),
      undefined,
      { isAway: () => away },
    );
    await h.relay.tick();
    await h.relay.tick();
    expect(h.submitted).toHaveLength(1);
    away = true;
    await h.relay.tick();
    await h.relay.tick();
    expect(h.submitted.map((notice) => notice.dedupeKey)).toEqual([
      `${f.task.sessionId}:request-rule`,
      `${f.task.sessionId}:request-rule:away`,
    ]);
    expect(h.submitted[1]).toMatchObject({
      requestId: "request-rule",
      facts: { code: f.read()[0]!.code },
    });
    expect(await h.relay.reply({ message: "1", origin: OWNER_DM })).toContain("单独的编号");
  });

  test("no escalation for a desktop-only rule, the P0 cap, or a nearly expired decision", async () => {
    for (const [decision, now] of [
      [{ outlet: "desktop", reason: "desktop-channel" }, 20_000],
      [{ outlet: "digest", reason: "p0-cap" }, 20_000],
      [{ outlet: "record", reason: "muted" }, 20_000],
      [{ outlet: "desktop", reason: "present-desktop" }, 100 + 10 * 60_000 - 59_000],
    ] as const) {
      const f = ruleFixture();
      const h = relayWith(f.read, () => decision, { value: now }, { isAway: () => true });
      await h.relay.tick();
      await h.relay.tick();
      expect(h.submitted).toHaveLength(1);
    }
  });

  test("after a restart the router's record decides: no resubmission, and prompted survives", async () => {
    const f = ruleFixture();
    const records = new Map<string, NoticePriorDecision>();
    const first = relayWith(f.read, toIm);
    await first.relay.tick();
    records.set(first.submitted[0]!.dedupeKey, {
      decision: toIm(),
      status: "accepted",
      channel: "lark",
    });
    const restarted = relayWith(f.read, toIm, undefined, {
      prior: (key) => records.get(key),
    });
    await restarted.relay.tick();
    expect(restarted.submitted).toEqual([]);
    expect(await restarted.relay.reply({ message: "1", origin: OWNER_DM })).toContain("单独的编号");
  });

  test("after a restart a desktop-kept prompt can still escalate once", async () => {
    const f = ruleFixture();
    const key = `${f.task.sessionId}:request-rule`;
    const records = new Map<string, NoticePriorDecision>([[key, { decision: toDesktop() }]]);
    const h = relayWith(f.read, toIm, undefined, {
      prior: (dedupeKey) => records.get(dedupeKey),
      isAway: () => true,
    });
    await h.relay.tick();
    expect(h.submitted.map((notice) => notice.dedupeKey)).toEqual([`${key}:away`]);
    records.set(`${key}:away`, { decision: toIm(), status: "accepted", channel: "lark" });
    const again = relayWith(f.read, toIm, undefined, {
      prior: (dedupeKey) => records.get(dedupeKey),
      isAway: () => true,
    });
    await again.relay.tick();
    expect(again.submitted).toEqual([]);
  });

  test("a queued prompt counts as delivered once the router sends it", async () => {
    const f = ruleFixture();
    const key = `${f.task.sessionId}:request-rule`;
    const records = new Map<string, NoticePriorDecision>();
    const h = relayWith(
      f.read,
      () => ({ outlet: "desktop", im: "lark", queued: true, reason: "im-unavailable-queued" }),
      undefined,
      { prior: (dedupeKey) => records.get(dedupeKey) },
    );
    await h.relay.tick();
    expect(await h.relay.reply({ message: "1", origin: OWNER_DM })).toBeUndefined();
    records.set(key, { status: "accepted", channel: "lark" });
    await h.relay.tick();
    expect(await h.relay.reply({ message: "1", origin: OWNER_DM })).toContain("单独的编号");
  });

  test("Core's deadline firing first still tells the prompted chat; an answer does not", async () => {
    const f = ruleFixture();
    let status: string | undefined = "pending";
    const now = { value: 20_000 };
    const h = relayWith(f.read, toIm, now, { decisionStatus: () => status });
    await h.relay.tick();
    // Core expired it and the projection dropped it before this module's tick.
    f.snapshot.pending = [];
    status = "expired";
    await h.relay.tick();
    await h.relay.tick();
    expect(h.approvals).toEqual([]);
    expect(h.submitted.map((notice) => notice.kind)).toEqual([
      "session.blocked",
      "decision.expired",
    ]);
    expect(h.submitted[1]).toMatchObject({ channel: "lark", target: { kind: "owner" } });

    const g = ruleFixture("answered");
    const answered = relayWith(g.read, toIm, now, { decisionStatus: () => undefined });
    await answered.relay.tick();
    g.snapshot.pending = [];
    await answered.relay.tick();
    expect(answered.submitted.map((notice) => notice.kind)).toEqual(["session.blocked"]);
  });

  test("Sessions with neither an IM task nor a blocked rule are not candidates", () => {
    const f = fixture("none");
    delete f.task.completionTarget;
    expect(f.read()).toEqual([]);
  });
});
