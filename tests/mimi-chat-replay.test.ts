import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentClient,
  AgentServer,
  ChatSessionManager,
  Engine,
  createInProcessTransport,
  type RunParams,
  type StreamEvent,
} from "@cjhyy/code-shell-core";
import {
  LLMClientBase,
  registerProvider,
  type CreateMessageOptions,
  type LLMResponse,
} from "@cjhyy/code-shell-core/extension";
import { createPetModule } from "@cjhyy/code-shell-pet";
import { sessionSelectorId } from "@cjhyy/code-shell-pet/disclosure";
import { ChatGateway } from "../packages/chat/src/chat-gateway.js";
import { createMimiPetChat } from "../packages/chat/src/gateway.js";
import {
  BUILTIN_CHANNEL_CAPABILITIES,
  type ChannelAdapter,
  type OutgoingMessage,
} from "../packages/chat/src/channel.js";
import {
  PetDispatchService,
  type PetAutoDelegation,
  type PetDispatchResult,
} from "../packages/desktop/src/main/pet/pet-dispatch-service.js";
import { PetHostActionReceiptStore } from "../packages/desktop/src/main/pet/pet-host-action-receipts.js";
import { enrichPetChatReplyWithHostActions } from "../packages/desktop/src/main/pet/host-action-reply.js";

// Real gateway middleware -> dispatcher -> protocol -> Engine/Pet tools ->
// host receipts -> outgoing reply. Only the model, platform send and Work
// launch are scripted. All state is isolated; no real account is contacted.
// Inputs replay the September Mimi cases; private URLs and ids are omitted.
type Step = (request: CreateMessageOptions) => LLMResponse | Promise<LLMResponse>;
type Script = { steps: Step[]; requests: CreateMessageOptions[]; summaries: number };
const scripts = new Map<string, Script>();
const cleanups: Array<() => void | Promise<void>> = [];
const provider = "mimi-chat-replay";

function response(toolName?: string, args: Record<string, unknown> = {}, text = ""): LLMResponse {
  return {
    text,
    toolCalls: toolName ? [{ id: `tool-${crypto.randomUUID()}`, toolName, args }] : [],
    stopReason: toolName ? "tool_use" : "stop",
    usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 },
  };
}

class ReplayClient extends LLMClientBase {
  protected initClient(): void {}
  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    const script = scripts.get(this.model)!;
    const turnLimitSummary = String(options.messages.at(-1)?.content).includes(
      "<system-reminder>Turn limit reached.",
    );
    if (
      !options.tools?.length &&
      (turnLimitSummary || !options.systemPrompt.includes('"delegationLaunchReceipt":'))
    ) {
      if (turnLimitSummary) script.summaries += 1;
      // Deliberately wrong terminal summary: a host must not turn exhausted
      // retries into a claim that work was completed. Auxiliary title requests
      // also stay outside scripted manager rounds; receipt turns are scripted.
      return response(undefined, {}, "所有任务已经完成。");
    }
    script.requests.push({
      ...options,
      messages: structuredClone(options.messages),
      tools: structuredClone(options.tools),
    });
    const step = script.steps.shift();
    if (!step) throw new Error("Unexpected model round after the scripted reply boundary");
    const result = await step(options);
    this.recordUsage(result.usage!, options);
    return result;
  }
}
registerProvider(provider, ReplayClient);

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  scripts.clear();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function workspace(request: CreateMessageOptions): string {
  const schema = request.tools!.find((tool) => tool.name === "DelegateWork")!.inputSchema;
  return (schema.properties.workspace_id.enum as string[]).find((id) => id !== "no-workspace")!;
}

function createHarness(
  options: {
    failLaunch?: boolean;
    failSendOnce?: boolean;
    failReply?: boolean;
    beforeLaunch?: (dispatcher: PetDispatchService) => Promise<void>;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "mimi-chat-replay-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const model = crypto.randomUUID();
  const script: Script = { steps: [], requests: [], summaries: 0 };
  scripts.set(model, script);
  const sessionId = "pet-replay";
  // Desktop runs each turn through ChatSessionManager. The legacy single-
  // Engine helper has no active input identity for scoped steer/cancel.
  const manager = new ChatSessionManager({
    runtime: {} as never,
    engineFactory: (slice) => {
      const engine = new Engine({
        ...slice,
        llm: { provider, model, apiKey: "offline-fixture" } as never,
        cwd: dir,
        modules: [createPetModule()],
        sessionStorageDir: join(dir, "sessions"),
        settingsScope: "isolated",
        maxTurns: 20,
      });
      (engine as any).hooks.clear();
      return engine;
    },
  });
  const [serverTransport, clientTransport] = createInProcessTransport();
  const server = new AgentServer({ chatManager: manager, transport: serverTransport });
  const client = new AgentClient({ transport: clientTransport });
  cleanups.push(async () => {
    server.close();
    client.close();
    await manager.closeAll();
  });
  const events: StreamEvent[] = [];
  let outbound: ((line: string, entry: { sessionId: string; event: unknown }) => void) | undefined;
  client.onStreamEvent((event) => {
    events.push(event.event);
    outbound?.("", event);
  });
  const launches: PetAutoDelegation[] = [];
  const outcomes: PetDispatchResult[] = [];
  const steered = deferred();
  const scopedSteers: Array<{ expectedClientMessageId: unknown; accepted: unknown }> = [];
  let replyActions = 0;
  let clearCount = 0;
  const dispatcher = new PetDispatchService({
    metadata: { ensure: async () => ({ petSessionId: sessionId }) },
    aggregator: {
      getSnapshot: () => ({
        version: 1,
        generation: 1,
        observedAt: Date.now(),
        workerState: "active",
        sessions: [],
        pending: [],
      }),
      resolveNavigation: async () => ({ status: "not-found" }),
    },
    worker: {
      subscribeOutbound: (listener) => {
        outbound = listener;
        return () => {
          outbound = undefined;
        };
      },
      requestWorker: async (method, params) => {
        try {
          const result =
            method === "agent/run"
              ? await client.run(params as unknown as RunParams)
              : await client.requestExtension(method, params);
          if (method === "agent/steer") {
            scopedSteers.push({
              expectedClientMessageId: params.expectedClientMessageId,
              accepted: (result as { accepted?: boolean }).accepted,
            });
            steered.resolve();
          }
          return { ok: true, result };
        } catch (error) {
          return { ok: false, message: String(error) };
        }
      },
    },
    hostCwd: dir,
    sessionsRootDir: join(dir, "sessions"),
    listWorkspaces: async () => [{ name: "CodeShell", path: dir }],
    listReusableSessions: async () => [
      {
        sessionId: "previous-work",
        workspacePath: dir,
        title: "架构图",
        updatedAt: Date.now(),
        status: "idle",
      },
    ],
    startWorkSession: async (input) => {
      launches.push(input);
      await options.beforeLaunch?.(dispatcher);
      if (options.failLaunch) throw new Error("fixture launch rejected");
      return { sessionId: input.targetSessionId ?? `work-${launches.length}`, cwd: dir };
    },
    hostActionReceipts: new PetHostActionReceiptStore(join(dir, "receipts.json")),
    hostActions: {
      gatewayReply: async (payload) => {
        replyActions += 1;
        if (options.failReply) throw new Error("fixture attachment unavailable");
        return { text: payload.text, ...(payload.button ? { button: payload.button } : {}) };
      },
    },
    segmentController: {
      beginTurn: async () => undefined,
      requestContextClear: async () => {
        clearCount += 1;
      },
      completeSegmentClosure: async () => {},
      onDelegationClosed: async () => {},
    },
  });
  const sent: Array<{ target: string; message: OutgoingMessage }> = [];
  let failSend = options.failSendOnce;
  const adapter: ChannelAdapter = {
    channel: "wechat",
    capabilities: BUILTIN_CHANNEL_CAPABILITIES.wechat,
    run: async () => {},
    send: async (target, message) => {
      if (failSend) {
        failSend = false;
        throw new Error("fixture platform offline");
      }
      sent.push({ target, message });
    },
  };
  const gateway = new ChatGateway({ adapters: [adapter] });
  gateway.use(
    createMimiPetChat({
      desktop: {
        petChat: async (input) => {
          const origin = input.origin!;
          const clientMessageId = `im:wechat:${createHash("sha256").update([origin.channel, origin.target, origin.senderId, origin.messageId].join("\0")).digest("hex")}`;
          const result = await dispatcher.dispatch({
            type: "chat",
            message: input.message,
            clientMessageId,
            source: { kind: "im-gateway", ...origin },
          });
          outcomes.push(result);
          if (!result.ok) throw new Error(result.message ?? result.code);
          if (result.type !== "chat") throw new Error("Expected chat result");
          if (result.suppressReply) return { text: "", suppressReply: true };
          const run = result.result as { text?: string; reason?: string };
          const enriched = await enrichPetChatReplyWithHostActions(
            result.authoritativeReply ?? run.text ?? "",
            result.hostActions,
            {
              qrDir: join(dir, "qr"),
              authoritativeBaseText: Boolean(result.authoritativeReply),
              attachmentKinds: [],
            },
          );
          return { ...enriched, petSessionId: result.petSessionId, reason: run.reason };
        },
      },
    }),
  );
  return {
    script,
    sent,
    launches,
    outcomes,
    events,
    dispatcher,
    client,
    steered,
    expectAcceptedScopedSteer: () => {
      expect(scopedSteers).toEqual([
        { expectedClientMessageId: expect.stringMatching(/^im:wechat:/), accepted: true },
      ]);
    },
    get replyActions() {
      return replyActions;
    },
    get clearCount() {
      return clearCount;
    },
    transcript: () => readFileSync(join(dir, "sessions", sessionId, "transcript.jsonl"), "utf8"),
    say: (text: string, messageId: string, target = "owner-chat", senderId = "owner") =>
      gateway.dispatch(adapter, { channel: "wechat", target, senderId, text, messageId }),
  };
}

function closedWorkFixture() {
  return {
    schemaVersion: 1 as const,
    id: "runtime-closed-work",
    originClientMessageId: "original-work-request",
    objective: "Report the actual work result",
    status: "failed" as const,
    phase: "finalizing" as const,
    attempt: 1,
    revision: 1,
    createdAt: 1,
    updatedAt: 2,
    completedAt: 2,
    artifacts: [],
    events: [],
    lastError: "fixture work process failed",
  };
}

describe("Mimi historical chat replay through the real manager stack", () => {
  test("real Engine Stop rejects a late model reply and cannot stop the successor", async () => {
    const h = createHarness();
    const entered = deferred();
    const nextEntered = deferred();
    const releaseNext = deferred();
    let firstSignal: AbortSignal | undefined;
    let nextSignal: AbortSignal | undefined;
    h.script.steps.push(
      async (request) => {
        firstSignal = request.signal;
        entered.resolve();
        await new Promise<void>((resolve) => {
          if (request.signal?.aborted) resolve();
          else request.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        // Simulate a provider resolving after cancellation. Production Engine
        // must discard this tool request, even though the provider ignored Stop.
        return response("GatewayReply", { text: "STALE_CANCELLED_REPLY" });
      },
      async (request) => {
        nextSignal = request.signal;
        nextEntered.resolve();
        await releaseNext.promise;
        return response("GatewayReply", { text: "后续输入正常完成。" });
      },
    );
    const first = h.say("请先处理这个请求", "cancel-real-engine");
    await entered.promise;
    const originalId = h.events.find((event) => event.type === "session_started")!.clientMessageId!;
    expect(
      await h.dispatcher.dispatch({ type: "stop_chat", clientMessageId: "stale-id" }),
    ).toMatchObject({ stopped: false });
    expect(firstSignal?.aborted).toBe(false);
    expect(
      await h.dispatcher.dispatch({ type: "stop_chat", clientMessageId: originalId }),
    ).toMatchObject({ stopped: true });
    await first;
    expect(firstSignal?.aborted).toBe(true);
    expect(h.outcomes[0]).toMatchObject({ result: { reason: "aborted_streaming" } });
    expect(h.replyActions).toBe(0);

    const next = h.say("继续新的请求", "successor-real-engine");
    await nextEntered.promise;
    expect(
      await h.client.requestExtension("agent/cancel", {
        sessionId: "pet-replay",
        expectedClientMessageId: originalId,
      }),
    ).toEqual({ ok: true, stopped: false });
    expect(nextSignal?.aborted).toBe(false);
    releaseNext.resolve();
    await next;
    expect(h.sent.map((item) => item.message.text).join("\n")).not.toContain(
      "STALE_CANCELLED_REPLY",
    );
    expect(h.sent.at(-1)?.message.text).toBe("后续输入正常完成。");
    expect(h.replyActions).toBe(1);
  });

  test("real manager serializes an internal closure before two queued user inputs", async () => {
    const h = createHarness();
    h.script.steps.push(() => response("GatewayReply", { text: "Mimi 已准备好。" }));
    await h.say("开始验证", "warmup-closure");
    const closureEntered = deferred();
    const releaseClosure = deferred();
    h.script.steps.push(
      async (request) => {
        expect(request.systemPrompt).toContain("fixture work process failed");
        closureEntered.resolve();
        await releaseClosure.promise;
        return response(undefined, {}, "工作失败，保留失败原因。");
      },
      () => response("GatewayReply", { text: "第一条用户输入的回复。" }),
      () => response("GatewayReply", { text: "第二条用户输入的回复。" }),
    );
    const closure = h.dispatcher.reportLongTaskClosure(closedWorkFixture());
    await closureEntered.promise;
    const first = h.say("第一条用户输入", "queued-user-one");
    const second = h.say("第二条用户输入", "queued-user-two");
    await Bun.sleep(10);
    expect(h.script.requests).toHaveLength(2);
    expect(await h.dispatcher.dispatch({ type: "stop_chat" })).toMatchObject({ stopped: false });
    releaseClosure.resolve();
    const [report] = await Promise.all([closure, first, second]);
    expect(report.text).toContain("工作失败");
    expect(h.sent.slice(1).map((item) => item.message.text)).toEqual([
      "第一条用户输入的回复。",
      "第二条用户输入的回复。",
    ]);
    expect(h.events.some((event) => event.type === "steer_injected")).toBe(false);
    expect(h.script.requests).toHaveLength(4);
  });

  test("a real delegation failure can synchronously close work and compose its receipt", async () => {
    const h = createHarness({
      failLaunch: true,
      beforeLaunch: async (dispatcher) => {
        const report = await dispatcher.reportLongTaskClosure(closedWorkFixture());
        expect(report.text).toContain("工作进程失败");
      },
    });
    h.script.steps.push(
      (request) => {
        const delegated = response("DelegateWork", {
          workspace_id: workspace(request),
          objective: "验证启动失败后的真实收尾链路。",
        });
        delegated.toolCalls.push(...response("GatewayReply", { text: "正在启动。" }).toolCalls);
        return delegated;
      },
      (request) => {
        expect(request.systemPrompt).toContain("fixture work process failed");
        return response(undefined, {}, "工作进程失败，尚未完成。");
      },
      (request) => {
        expect(request.systemPrompt).toContain("fixture launch rejected");
        expect(request.tools?.map((tool) => tool.name)).not.toContain("DelegateWork");
        return response(undefined, {}, "本次工作未启动，请重试。");
      },
    );
    await h.say("启动验证任务", "nested-closure");
    expect(h.script.requests).toHaveLength(3);
    expect(h.launches).toHaveLength(1);
    expect(h.sent.map((item) => item.message.text)).toEqual(["本次工作未启动，请重试。"]);
    expect(h.outcomes[0]).toHaveProperty("delegationError");
  });

  test("a real failed turn is transport-idempotent but a fresh retry can succeed", async () => {
    const h = createHarness();
    h.script.steps.push(() => {
      throw new Error("fixture model unavailable");
    });
    await h.say("生成完整结果", "failed-intent");
    expect(h.outcomes[0]).toMatchObject({ result: { reason: "model_error" } });
    expect(h.sent[0]?.message.text).toContain("没能回复");
    const failedRequests = h.script.requests.length;
    // Retrying delivery after an unknown transport outcome must not execute
    // the model again. A user-requested retry is a distinct input intent.
    await h.say("生成完整结果", "failed-intent");
    expect(h.script.requests).toHaveLength(failedRequests);
    expect(h.outcomes[1]).toMatchObject({ result: { reason: "model_error" } });
    h.script.steps.push(() => response("GatewayReply", { text: "重试成功，完整结果已经生成。" }));
    await h.say("生成完整结果", "fresh-retry-intent");
    expect(h.script.requests).toHaveLength(failedRequests + 1);
    expect(h.outcomes[2]).toMatchObject({ result: { reason: "completed" } });
    expect(h.sent.at(-1)?.message.text).toBe("重试成功，完整结果已经生成。");
    expect(h.replyActions).toBe(1);
  });

  test("explains the question once and retains context for the next WeChat message", async () => {
    const h = createHarness();
    h.script.steps.push(
      () => response("GatewayReply", { text: "这道题要求你说明 BPE 如何合并高频词元。" }),
      (request) => {
        const context = JSON.stringify(request.messages);
        expect(context).toContain("就是这个 给我解释一下题目");
        expect(context).toContain("BPE");
        return response("GatewayReply", { text: "题目内容：描述 BPE 的训练过程。" });
      },
    );
    await h.say("就是这个 给我解释一下题目", "question");
    expect(h.outcomes).toMatchObject([{ ok: true, type: "chat", result: { reason: "completed" } }]);
    await h.say("你给我题目内容啊 不要每次都是追加结果", "correction");
    expect(h.script.requests).toHaveLength(2);
    expect(h.sent.map((item) => item.message.text)).toEqual([
      "这道题要求你说明 BPE 如何合并高频词元。",
      "题目内容：描述 BPE 的训练过程。",
    ]);
    expect(h.launches).toHaveLength(0);
    expect(h.replyActions).toBe(2);
  });

  for (const failLaunch of [false, true]) {
    test(`new-session delegation preserves Mimi’s reply and records the ${failLaunch ? "failed" : "accepted"} launch outcome`, async () => {
      const h = createHarness({ failLaunch });
      h.script.steps.push((request) => {
        const delegated = response("DelegateWork", {
          workspace_id: workspace(request),
          objective: "在 CodeShell 项目新开会话调查 Mimi 卡住的原因。",
        });
        delegated.toolCalls.push(
          ...response("GatewayReply", { text: "我会新开工作会话调查 Mimi 卡住的原因。" }).toolCalls,
        );
        return delegated;
      });
      if (failLaunch) {
        h.script.steps.push((request) => {
          expect(request.systemPrompt).toContain("fixture launch rejected");
          expect(request.tools?.map((tool) => tool.name)).not.toContain("DelegateWork");
          expect(request.tools?.map((tool) => tool.name)).not.toContain("GatewayReply");
          return response(undefined, {}, "工作会话未能启动，队列拒绝了这次派发。");
        });
      }
      await h.say("新开一个session 然后做这个工作", "new-task");
      expect(h.script.requests).toHaveLength(failLaunch ? 2 : 1);
      expect(h.launches).toHaveLength(1);
      expect(h.launches[0]?.targetSessionId).toBeUndefined();
      expect(h.launches[0]?.completionTarget).toMatchObject({
        channel: "wechat",
        target: "owner-chat",
      });
      expect(h.sent).toHaveLength(1);
      expect(h.sent[0]?.message.text).toBe(
        failLaunch
          ? "工作会话未能启动，队列拒绝了这次派发。"
          : "我会新开工作会话调查 Mimi 卡住的原因。",
      );
      expect(h.outcomes[0]).not.toHaveProperty("authoritativeReply");
      if (failLaunch) expect(h.outcomes[0]).toHaveProperty("delegationError");
      else expect(h.outcomes[0]).toHaveProperty("delegation.sessionId");
      if (failLaunch) {
        h.script.steps.push((request) => {
          expect(request.tools?.map((tool) => tool.name)).toContain("GatewayReply");
          expect(request.systemPrompt).not.toContain('"delegationLaunchReceipt":');
          return response("GatewayReply", { text: "可以，先讨论下一步。" });
        });
        await h.say("那先讨论下一步", "after-launch-failure");
        expect(h.sent[1]?.message.text).toBe("可以，先讨论下一步。");
        expect(h.launches).toHaveLength(1);
      }
    });
  }

  test("explicit continuation keeps the selected Session and its Workspace", async () => {
    const h = createHarness();
    h.script.steps.push(
      (request) =>
        response("DelegateWork", {
          workspace_id: workspace(request),
          session_id: sessionSelectorId("previous-work"),
          session_continuation: {
            prior_thread: "架构图",
            reason: "继续完善刚才架构图任务中的节点和连线。",
          },
          objective: "继续刚才的架构图任务。",
        }),
      () => response("GatewayReply", { text: "继续处理。" }),
    );
    await h.say("继续执行啊", "continue");
    expect(h.launches).toHaveLength(1);
    expect(h.launches[0]?.targetSessionId).toBe("previous-work");
    expect(h.sent[0]?.message.text).toContain("继续");
    expect(h.sent[0]?.message.text).not.toContain("previous-work");
  });

  test("a failed platform send retries cached output without another model round or action", async () => {
    const h = createHarness({ failSendOnce: true });
    h.script.steps.push(() => response("GatewayReply", { text: "这里是题目内容。" }));
    await expect(h.say("你给我题目内容啊", "retry-delivery")).rejects.toThrow(
      "fixture platform offline",
    );
    await h.say("你给我题目内容啊", "retry-delivery");
    expect(h.script.requests).toHaveLength(1);
    expect(h.replyActions).toBe(1);
    expect(h.sent).toHaveLength(1);
  });

  test("a duplicate dispatch replays Engine output and durable action receipt", async () => {
    const h = createHarness();
    h.script.steps.push(() => response("GatewayReply", { text: "收到。" }));
    await h.say("你好", "duplicate");
    // Direct dispatch bypasses the platform queue's completed-message dedupe
    // to exercise the second, durable barrier at Engine + host-action level.
    await h.say("你好", "duplicate");
    expect(h.script.requests).toHaveLength(1);
    expect(h.replyActions).toBe(1);
    expect(h.transcript().split('"role":"user"')).toHaveLength(2);
  });

  test("a same-conversation correction steers and replaces an unsent draft", async () => {
    const h = createHarness();
    const entered = deferred();
    h.script.steps.push(
      async () => {
        entered.resolve();
        await h.steered.promise;
        return response("GatewayReply", { text: "旧回复" });
      },
      (request) => {
        expect(JSON.stringify(request.messages)).toContain("不要答案 只要题目");
        return response("GatewayReply", { text: "题目：描述 BPE 的训练过程。" });
      },
    );
    const first = h.say("给我解释一下题目", "burst-1");
    await entered.promise;
    const next = h.say("不要答案 只要题目", "burst-2");
    await Promise.all([first, next]);
    h.expectAcceptedScopedSteer();
    expect(h.sent.map((item) => item.message.text)).toEqual(["题目：描述 BPE 的训练过程。"]);
    expect(h.replyActions).toBe(1);
    expect(
      h.outcomes.some((outcome) => outcome.ok && outcome.type === "chat" && outcome.suppressReply),
    ).toBe(true);
    expect(h.transcript()).toContain("不要答案 只要题目");
  });

  test("different conversations receive separate turns and correctly addressed replies", async () => {
    const h = createHarness();
    const entered = deferred();
    const release = deferred();
    h.script.steps.push(
      async () => {
        entered.resolve();
        await release.promise;
        return response("GatewayReply", { text: "会话 A 的回复" });
      },
      () => response("GatewayReply", { text: "会话 B 的回复" }),
    );
    const first = h.say("现在有哪些session", "same-platform-id", "chat-a", "sender-a");
    await entered.promise;
    const second = h.say("有什么进度", "same-platform-id", "chat-b", "sender-b");
    release.resolve();
    await Promise.all([first, second]);
    expect(h.sent).toEqual([
      { target: "chat-a", message: { text: "会话 A 的回复" } },
      { target: "chat-b", message: { text: "会话 B 的回复" } },
    ]);
    expect(h.script.requests).toHaveLength(2);
    expect(h.events.some((event) => event.type === "steer_injected")).toBe(false);
  });

  test("a plain final answer after a correction invalidates the earlier GatewayReply draft", async () => {
    const h = createHarness();
    const entered = deferred();
    h.script.steps.push(
      async () => {
        entered.resolve();
        await h.steered.promise;
        return response("GatewayReply", { text: "旧回复：给你答案。" });
      },
      () => response(undefined, {}, "题目：描述 BPE 的训练过程。"),
    );
    const first = h.say("给我解释一下题目", "plain-draft");
    await entered.promise;
    await Promise.all([first, h.say("不要答案，只要题目", "plain-correction")]);
    h.expectAcceptedScopedSteer();
    expect(h.replyActions).toBe(0);
    expect(h.sent.map((item) => item.message.text)).toEqual(["题目：描述 BPE 的训练过程。"]);
    expect(h.script.requests).toHaveLength(2);
  });

  test("host rejection suppresses the model's premature success claim", async () => {
    const h = createHarness({ failReply: true });
    h.script.steps.push(() => response("GatewayReply", { text: "附件已经发给你了。" }));
    await h.say("附件发我", "attachment-failed");
    expect(h.sent[0]?.message.text).toContain("Gateway 回复未发送");
    expect(h.sent[0]?.message.text).not.toContain("已经发给你");
    expect(h.script.requests).toHaveLength(1);
  });

  test("/clear is a host command and never invokes the LLM", async () => {
    const h = createHarness();
    await h.say(" /CLEAR ", "clear");
    expect(h.script.requests).toHaveLength(0);
    expect(h.clearCount).toBe(1);
    expect(h.sent[0]?.message.text).toContain("上下文已清空");
  });

  test("repeated invalid delegation stops within six rounds and cannot claim completion", async () => {
    const h = createHarness();
    for (let index = 0; index < 20; index += 1) {
      h.script.steps.push(() =>
        response("DelegateWork", {
          workspace_id: "invented-workspace",
          objective: "继续处理飞书表格新增的仓库。",
        }),
      );
    }
    await h.say("处理啊 点完了吗", "runaway");
    expect(h.script.requests).toHaveLength(6);
    expect(h.script.summaries).toBe(1);
    expect(h.launches).toHaveLength(0);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.message.text).toContain("已停止重试");
    expect(h.sent[0]?.message.text).not.toContain("任务已经完成");
    expect(h.outcomes[0]).toMatchObject({ result: { reason: "max_turns" } });
  });

  test("model failure has an honest visible reply instead of an empty success fallback", async () => {
    const h = createHarness();
    h.script.steps.push(() => {
      throw new Error("fixture model unavailable");
    });
    await h.say("现在有哪些session", "model-failure");
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.message.text).toContain("没能回复");
    expect(h.sent[0]?.message.text).not.toContain("已处理");
    expect(h.launches).toHaveLength(0);
    expect(h.outcomes[0]).toMatchObject({ result: { reason: "model_error" } });
  });

  for (const failure of ["max_turns", "model_error"] as const) {
    test(`a correction followed by ${failure} cannot send the stale pending draft`, async () => {
      const h = createHarness();
      const entered = deferred();
      if (failure === "max_turns") {
        for (let index = 0; index < 5; index += 1) {
          h.script.steps.push(() =>
            response("DelegateWork", {
              workspace_id: "invented-workspace",
              objective: "读取题目。",
            }),
          );
        }
      }
      h.script.steps.push(async () => {
        entered.resolve();
        await h.steered.promise;
        return response("GatewayReply", { text: "旧回复：给你答案。" });
      });
      if (failure === "model_error") {
        h.script.steps.push(() => {
          throw new Error("fixture model unavailable after steer");
        });
      }
      const first = h.say("给我解释一下题目", `draft-${failure}`);
      await entered.promise;
      await Promise.all([first, h.say("不要答案，只要题目", `correction-${failure}`)]);
      h.expectAcceptedScopedSteer();
      expect(h.replyActions).toBe(0);
      expect(h.sent).toHaveLength(1);
      expect(h.sent[0]?.message.text).not.toContain("旧回复");
      expect(h.sent[0]?.message.text).toContain(
        failure === "max_turns" ? "已停止重试" : "没能回复",
      );
      expect(h.outcomes).toContainEqual(
        expect.objectContaining({ result: expect.objectContaining({ reason: failure }) }),
      );
      expect(h.transcript()).toContain("不要答案，只要题目");
    });
  }

  // This exercises 100 serial Engine turns with durable transcript/receipt I/O.
  // Allow headroom for full-suite contention; the assertions bound model loops.
  test("100 consecutive chat inputs produce 100 replies without post-reply model loops", async () => {
    const h = createHarness();
    for (let index = 0; index < 100; index += 1) {
      h.script.steps.push(() => response("GatewayReply", { text: `收到第 ${index + 1} 条。` }));
      await h.say(`现在进度怎么样 ${index + 1}`, `soak-${index}`);
    }
    expect(h.script.requests).toHaveLength(100);
    expect(h.replyActions).toBe(100);
    expect(h.sent).toHaveLength(100);
    expect(h.launches).toHaveLength(0);
    const history = h.script.requests.at(-1)!.messages;
    expect(JSON.stringify(history)).not.toContain("<pet-world>");
    expect(h.script.summaries).toBe(0);
  }, 120_000);
});
