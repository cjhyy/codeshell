import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentClient,
  AgentServer,
  ChatSessionManager,
  Engine,
  createInProcessTransport,
  type RunParams,
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
import { createBoundSessionChat } from "../packages/chat/src/bound-session-chat.js";
import { createMimiPetChat } from "../packages/chat/src/gateway.js";
import { DesktopControlClient } from "../packages/chat/src/desktop-control-client.js";
import { createDesktopNotificationHandler } from "../packages/chat/src/notification-relay.js";
import {
  BUILTIN_CHANNEL_CAPABILITIES,
  type ChannelAdapter,
  type OutgoingMessage,
} from "../packages/chat/src/channel.js";
import { GatewayControlServer } from "../packages/desktop/src/main/im-gateway-control-server.js";
import { PetDispatchService } from "../packages/desktop/src/main/pet/pet-dispatch-service.js";
import { enrichPetChatReplyWithHostActions } from "../packages/desktop/src/main/pet/host-action-reply.js";
import { createReusableSessionResolver } from "../packages/desktop/src/main/pet/reusable-session-resolver.js";
import {
  createBoundSessionHealth,
  createBoundSessionRunner,
  createSessionBridgeWiring,
} from "../packages/desktop/src/main/pet/session-bridge-wiring.js";

// Only model answers and the IM transport are fixtures. The HTTP control plane,
// host action parser/executor, protocol acceptance, Session queue/history,
// engine, outbox and notification relay all execute their production code.
type Step = (request: CreateMessageOptions) => LLMResponse | Promise<LLMResponse>;
const provider = "mimi-bound-session-replay";
const scripts = new Map<string, { steps: Step[]; requests: CreateMessageOptions[] }>();
const cleanups: Array<() => void | Promise<void>> = [];
const WORK_SESSION = "work-context-replay";
const PET_SESSION = "pet-context-replay";
const TITLE = "量化训练上下文";

function answer(text: string, toolName?: string, args: Record<string, unknown> = {}): LLMResponse {
  return {
    text,
    toolCalls: toolName ? [{ id: crypto.randomUUID(), toolName, args }] : [],
    stopReason: toolName ? "tool_use" : "stop",
    usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
  };
}

class ReplayClient extends LLMClientBase {
  protected initClient(): void {}
  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    // Session titles and background summaries are auxiliary model requests.
    if (!options.tools?.length) return answer(TITLE);
    const script = scripts.get(this.model)!;
    script.requests.push({ ...options, messages: structuredClone(options.messages) });
    const step = script.steps.shift();
    if (!step) throw new Error("Unexpected model request after replay boundary");
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

async function promptly<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Session acceptance waited for model completion")),
          2_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function harness() {
  const dir = mkdtempSync(join(tmpdir(), "mimi-bound-session-replay-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const sessionsRootDir = join(dir, "sessions");
  const model = crypto.randomUUID();
  const script = { steps: [] as Step[], requests: [] as CreateMessageOptions[] };
  scripts.set(model, script);
  const manager = new ChatSessionManager({
    runtime: {} as never,
    engineFactory: (slice) => {
      const engine = new Engine({
        ...slice,
        llm: { provider, model, apiKey: "offline-fixture" } as never,
        cwd: dir,
        modules: [createPetModule()],
        sessionStorageDir: sessionsRootDir,
        settingsScope: "isolated",
        maxTurns: 10,
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
  type Listener = (line: string, snapshot?: { sessionId: string; event: unknown }) => void;
  const listeners = new Set<Listener>();
  const wire: any[] = [];
  // Same serialized protocol frames seen by Desktop's real AgentBridge.
  // No synthetic runAccepted or assistant stream events are manufactured.
  clientTransport.onMessage((message) => {
    wire.push(message);
    const snapshot =
      "method" in message && message.method === "agent/streamEvent"
        ? (message.params as { sessionId: string; event: unknown })
        : undefined;
    for (const listener of listeners) listener(JSON.stringify(message), snapshot);
  });
  const injected: Array<{ method: string; params: Record<string, unknown> }> = [];
  const worker = {
    subscribeOutbound: (listener: Listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    injectWorkerMessage: (line: string) => {
      const message = JSON.parse(line);
      injected.push(message);
      clientTransport.send(message);
    },
    requestWorker: async (method: string, params: Record<string, unknown>) => {
      try {
        const result =
          method === "agent/run"
            ? await client.run(params as unknown as RunParams)
            : await client.requestExtension(method, params);
        return { ok: true as const, result };
      } catch (error) {
        return { ok: false as const, message: String(error) };
      }
    },
  };
  const aggregator = {
    getSnapshot: () => ({
      version: 1 as const,
      generation: 1,
      observedAt: Date.now(),
      workerState: "active" as const,
      sessions: [
        {
          agentSessionId: WORK_SESSION,
          title: TITLE,
          workspaceDisplayName: "Replay workspace",
          runState: "idle" as const,
          summary: "空闲",
          queueDepth: 0,
          lastActivityAt: Date.now(),
          pendingDecisionCount: 0,
          freshness: {
            source: "live-event" as const,
            observedAt: Date.now(),
            workerState: "active" as const,
          },
        },
      ],
      pending: [],
    }),
    refreshCatalog: async () => {},
    resolveNavigation: async () => ({ status: "not-found" as const }),
  };
  const published: Array<{ type: string; text: string }> = [];
  const wiring = createSessionBridgeWiring({
    routesFilePath: join(dir, "routes.json"),
    resolveSelector: createReusableSessionResolver(sessionsRootDir),
    createRunner: (onTurn) => createBoundSessionRunner(worker, aggregator, onTurn),
    health: createBoundSessionHealth(aggregator, sessionsRootDir),
    describeStatus: async (route) => `当前在「${route.sessionTitle}」。`,
    publish: async (event) => {
      published.push(event);
      await controlServer.publish(event);
    },
  });
  const dispatcher = new PetDispatchService({
    metadata: { ensure: async () => ({ petSessionId: PET_SESSION }) },
    aggregator,
    worker,
    hostCwd: dir,
    sessionsRootDir,
    hostActions: { sessionBind: wiring.sessionBindExecutor },
  });
  const descriptorPath = join(dir, "desktop-control.json");
  let mimiTurns = 0;
  const controlServer: GatewayControlServer = new GatewayControlServer({
    descriptorPath,
    open: async () => {
      throw new Error("Remote access must not open in this test");
    },
    close: async () => {},
    status: () => ({
      running: true,
      tunnelRunning: false,
      tunnelConnected: false,
      passcodeSet: false,
      onlineDeviceCount: 0,
    }),
    pairingUrl: () => {
      throw new Error("Pairing must not occur in this test");
    },
    routeSession: (input) => wiring.routeInbound(input),
    petChat: async (input) => {
      mimiTurns += 1;
      const result = await dispatcher.dispatch({
        type: "chat",
        message: input.message,
        clientMessageId: `im:wechat:${input.origin!.messageId}`,
        source: { kind: "im-gateway", ...input.origin! },
      });
      if (!result.ok || result.type !== "chat") throw new Error("Mimi fixture turn failed");
      const run = result.result as { text?: string; reason?: string };
      const enriched = await enrichPetChatReplyWithHostActions(run.text ?? "", result.hostActions, {
        qrDir: join(dir, "qr"),
        attachmentKinds: [],
      });
      return { ...enriched, petSessionId: result.petSessionId, reason: run.reason };
    },
  });
  await controlServer.start();
  cleanups.push(() => controlServer.stop());
  const desktop = new DesktopControlClient({
    descriptorPath,
    autoLaunch: false,
    args: [],
    startupTimeoutMs: 1_000,
  });
  const sent: Array<{ target: string; message: OutgoingMessage }> = [];
  const adapter: ChannelAdapter = {
    channel: "wechat",
    capabilities: BUILTIN_CHANNEL_CAPABILITIES.wechat,
    run: async () => {},
    send: async (target, message) => {
      sent.push({ target, message });
    },
  };
  const gateway = new ChatGateway({ adapters: [adapter] });
  gateway.use(createBoundSessionChat({ desktop }));
  gateway.use(createMimiPetChat({ desktop }));
  const relay = createDesktopNotificationHandler(
    [adapter],
    [{ channel: "wechat", target: "owner-chat" }],
  );
  let cursor = 0;
  return {
    script,
    client,
    sent,
    injected,
    wire,
    published,
    wiring,
    get mimiTurns() {
      return mimiTurns;
    },
    say: (text: string, messageId: string) =>
      gateway.dispatch(adapter, {
        channel: "wechat",
        target: "owner-chat",
        senderId: "owner-user",
        isDirectMessage: true,
        text,
        messageId,
      }),
    setTitle: () => {
      const path = join(sessionsRootDir, WORK_SESSION, "state.json");
      const state = JSON.parse(readFileSync(path, "utf8"));
      // Desktop owns this catalog metadata; the generic AgentServer does not.
      writeFileSync(path, JSON.stringify({ ...state, title: TITLE, origin: "desktop" }));
    },
    transcript: () => readFileSync(join(sessionsRootDir, WORK_SESSION, "transcript.jsonl"), "utf8"),
    relayNext: async () => {
      const page = await desktop.events(cursor, 1_000);
      for (const event of page.events) await relay(event, { streamId: page.streamId });
      cursor = page.cursor;
      return page.events;
    },
  };
}

test("private IM enters an existing Session, preserves context, queues promptly, and receives native final replies", async () => {
  const h = await harness();
  const entered = deferred();
  const release = deferred();
  cleanups.push(release.resolve);
  const original = "记住这个实验代号是 ORCHID-73，量化采用 4 bit。";
  const initialAnswer = "记住了：ORCHID-73，4 bit 量化。";
  h.script.steps.push(() => answer(initialAnswer));
  await h.client.run({
    sessionId: WORK_SESSION,
    task: original,
    clientMessageId: "desktop-original",
  });
  h.setTitle();

  h.script.steps.push(
    (request) => {
      expect(request.tools?.some((tool) => tool.name === "BindConversationSession")).toBe(true);
      return answer("", "Sessions", { action: "list" });
    },
    (request) => {
      expect(JSON.stringify(request.messages)).toContain(sessionSelectorId(WORK_SESSION));
      return answer("", "BindConversationSession", {
        action: "enter",
        session_selector: sessionSelectorId(WORK_SESSION),
      });
    },
    () => answer("已提交进入请求，由宿主校验后给出结果。"),
  );
  await h.say("列出最近 Session，然后进入量化训练那个", "bind");
  expect(h.sent.at(-1)?.message.text).toContain(`已进入「${TITLE}」`);
  expect(h.sent.at(-1)?.message.text).not.toContain("由宿主校验");
  expect(h.mimiTurns).toBe(1);
  expect(h.transcript()).not.toContain("列出最近 Session");
  expect(await h.wiring.routes.all()).toMatchObject([
    { sessionId: WORK_SESSION, target: "owner-chat", senderId: "owner-user" },
  ]);

  h.script.steps.push(
    async (request) => {
      const context = JSON.stringify(request.messages);
      expect(context).toContain(original);
      expect(context).toContain(initialAnswer);
      expect(context).toContain("之前的实验代号和精度是什么");
      entered.resolve();
      await release.promise;
      return answer("实验代号是 ORCHID-73，精度是 4 bit。");
    },
    (request) => {
      const context = JSON.stringify(request.messages);
      expect(context).toContain(original);
      expect(context).toContain("实验代号是 ORCHID-73，精度是 4 bit。");
      expect(context).toContain("再把实验代号重复一遍");
      return answer("ORCHID-73。");
    },
  );
  const beforeWork = h.sent.length;
  await promptly(h.say("之前的实验代号和精度是什么", "work-one"));
  await promptly(entered.promise);
  expect(h.sent).toHaveLength(beforeWork);
  await promptly(h.say("再把实验代号重复一遍", "work-two"));
  expect(h.injected).toHaveLength(2);
  expect(h.injected.every((entry) => entry.method === "agent/run")).toBe(true);
  expect(h.injected.map((entry) => entry.params)).toEqual([
    expect.objectContaining({ sessionId: WORK_SESSION, task: "之前的实验代号和精度是什么" }),
    expect.objectContaining({ sessionId: WORK_SESSION, task: "再把实验代号重复一遍" }),
  ]);
  expect(
    h.wire.filter((entry) => entry.method === "agent/runAccepted").length,
  ).toBeGreaterThanOrEqual(4);
  expect(h.mimiTurns).toBe(1);
  release.resolve();
  for (let attempt = 0; attempt < 5 && h.sent.length < beforeWork + 2; attempt += 1)
    await h.relayNext();
  expect(h.sent.slice(beforeWork).map((entry) => entry.message.text)).toEqual([
    "实验代号是 ORCHID-73，精度是 4 bit。",
    "ORCHID-73。",
  ]);
  expect(h.sent.every((entry) => entry.target === "owner-chat")).toBe(true);
  expect(h.published.map((event) => event.type)).toEqual(["session.reply", "session.reply"]);
  expect(h.transcript()).toContain("再把实验代号重复一遍");

  const workRequests = h.injected.length;
  await h.say("/session", "status");
  expect(h.sent.at(-1)?.message.text).toBe(`当前在「${TITLE}」。`);
  await h.say("/mimi", "leave");
  expect(h.sent.at(-1)?.message.text).toContain("Mimi");
  expect(h.injected).toHaveLength(workRequests);
  expect(h.mimiTurns).toBe(1);
  h.script.steps.push(() => answer("现在由 Mimi 处理。"));
  await h.say("你好 Mimi", "after-leave");
  expect(h.sent.at(-1)?.message.text).toBe("现在由 Mimi 处理。");
  expect(h.mimiTurns).toBe(2);
  expect(h.injected).toHaveLength(workRequests);
  expect(h.transcript()).not.toContain("你好 Mimi");
  expect(h.script.steps).toHaveLength(0);
}, 20_000);
