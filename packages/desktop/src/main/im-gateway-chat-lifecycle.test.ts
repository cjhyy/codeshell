import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerBridgeCore } from "@cjhyy/code-shell-server/worker";
import { DesktopControlClient } from "../../../chat/src/desktop-control-client.js";
import { createMimiPetChat } from "../../../chat/src/gateway.js";
import { DeliveryQueue } from "../../../chat/src/delivery-queue.js";
import { BUILTIN_CHANNEL_CAPABILITIES, type ChannelAdapter } from "../../../chat/src/channel.js";
import { GatewayControlServer } from "./im-gateway-control-server.js";
import { PetDispatchService } from "./pet/pet-dispatch-service.js";
import { enrichPetChatReplyWithHostActions } from "./pet/host-action-reply.js";

// Only model output is scripted. HTTP, stdio, run admission, queue persistence,
// steering, work launch and host reply handling all use the production code.
const workerScript = `
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let n;
  while ((n = buffer.indexOf("\\n")) >= 0) {
    const req = JSON.parse(buffer.slice(0, n));
    buffer = buffer.slice(n + 1);
    const p = req.params;
    if (req.method === "agent/steer") {
      send({ method: "test/event", params: { sessionId: p.sessionId,
        event: { type: "steer_injected", id: p.id, text: p.text } } });
      send({ id: req.id, result: { accepted: true } });
    } else if (req.method === "agent/run") {
      send({ method: "agent/runAccepted", params: { requestId: req.id, sessionId: p.sessionId } });
      const delegate = p.clientMessageId === "im:wechat:first";
      const text = delegate
        ? "已创建工作任务，正在核对截图和501058行情。" : "消息已处理，会继续跟进。";
      setTimeout(() => send({ id: req.id, result: { text: "", reason: "completed",
        extensions: { pet: {
          ...(delegate ? { workDelegation: { workspaceId: p.petWorkspaces[0].id,
            objective: "核对截图和501058行情" } } : {}),
          hostActions: [{ kind: "gatewayReply", payload: { text } }],
        } },
      } }), 240);
    } else send({ id: req.id, result: {} });
  }
});
send({ method: "test/ready" });
`;

async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("lifecycle test did not settle");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("WeChat long run survives a dropped poll, steers the next input, launches once and delivers real replies", async () => {
  const root = await mkdtemp(join(tmpdir(), "mimi-http-lifecycle-"));
  const descriptorPath = join(root, "control.json");
  const inboxPath = join(root, "inbox.json");
  const entryPath = join(root, "worker.cjs");
  await writeFile(entryPath, workerScript);
  const core = new WorkerBridgeCore({ entryPath, fallbackCwd: () => root });
  const calls: Array<{ method: string; clientMessageId?: unknown; outcome?: string }> = [];
  let accepted = 0;
  let ready = false;
  core.subscribeLines((line) => {
    const msg = JSON.parse(line);
    if (msg.method === "agent/runAccepted") accepted++;
    if (msg.method === "test/ready") ready = true;
  });
  let launches = 0;
  let hostReplies = 0;
  let requestId = 0;
  const service = new PetDispatchService({
    hostCwd: root,
    metadata: { ensure: async () => ({ petSessionId: "pet-lifecycle" }) },
    aggregator: {
      getSnapshot: () => ({
        version: 1,
        generation: 1,
        workerState: "active",
        observedAt: Date.now(),
        sessions: [],
        pending: [],
      }),
      resolveNavigation: async () => ({ status: "not-found" }),
    },
    listWorkspaces: async () => [{ path: root, name: "Test workspace" }],
    startWorkSession: async () => {
      launches++;
      return { sessionId: "pet-work-started", cwd: root };
    },
    hostActions: {
      gatewayReply: async (payload) => {
        hostReplies++;
        return { text: payload.text };
      },
    },
    worker: {
      subscribeOutbound: (listener) =>
        core.subscribeLines((line) => {
          const msg = JSON.parse(line);
          listener(line, msg.method === "test/event" ? msg.params : undefined);
        }),
      requestWorker: async (method, params, options) => {
        const call = { method, clientMessageId: params.clientMessageId, outcome: "pending" };
        calls.push(call);
        const result = await core.request(method, params, {
          ...options,
          id: `http-test-${++requestId}`,
          timeoutMs: 80,
          ensureWorker: method === "agent/run",
          ensureWorkerCwd: root,
        });
        call.outcome = result.status;
        return result.status === "result"
          ? { ok: true, result: result.result }
          : { ok: false, message: result.status };
      },
    },
  });
  const server = new GatewayControlServer({
    descriptorPath,
    open: async () => {
      throw new Error("unexpected open");
    },
    close: async () => {},
    status: () => ({
      running: false,
      tunnelRunning: false,
      tunnelConnected: false,
      passcodeSet: true,
      onlineDeviceCount: 0,
    }),
    pairingUrl: () => {
      throw new Error("unexpected pairing");
    },
    petChat: async (input) => {
      const reply = await service.dispatch({
        type: "chat",
        message: input.message,
        clientMessageId: `im:wechat:${input.origin!.messageId}`,
        source: { kind: "im-gateway", ...input.origin! },
      });
      if (!reply.ok) throw new Error(reply.message ?? reply.code);
      if (reply.type !== "chat") throw new Error("unexpected chat result");
      if (reply.suppressReply)
        return { text: "", petSessionId: reply.petSessionId, suppressReply: true };
      const enriched = await enrichPetChatReplyWithHostActions(
        reply.authoritativeReply ?? "",
        reply.hostActions,
        { qrDir: root, authoritativeBaseText: Boolean(reply.authoritativeReply) },
      );
      return { ...enriched, petSessionId: reply.petSessionId };
    },
  });
  let dropped = false;
  const starts: string[] = [];
  const desktop = new DesktopControlClient(
    { descriptorPath, autoLaunch: false, args: [], startupTimeoutMs: 1_000 },
    {
      fetch: async (url, init) => {
        const response = await fetch(url, init);
        if (String(url).includes("/chat/start"))
          starts.push((await response.clone().json()).requestId);
        if (String(url).includes(`/chat/result/${starts[0]}`) && !dropped) {
          // Desktop finished, but the channel never received that response.
          dropped = true;
          await response.arrayBuffer();
          throw new Error("simulated disconnected response");
        }
        return response;
      },
    },
  );
  const mimi = createMimiPetChat({ desktop });
  const adapter: ChannelAdapter = {
    channel: "wechat",
    capabilities: BUILTIN_CHANNEL_CAPABILITIES.wechat,
    run: async () => {},
    send: async () => {},
  };
  const replies: string[] = [];
  const errors: unknown[] = [];
  const queue = new DeliveryQueue(
    {
      path: inboxPath,
      maxPending: 10,
      maxConcurrent: 2,
      maxPerTarget: 2,
      retryBaseMs: 5,
      retryMaxMs: 5,
      completedTtlMs: 60_000,
    },
    async (_id, message) =>
      mimi(
        {
          message,
          adapter,
          reply: async (reply) => {
            replies.push(reply.text);
          },
        },
        async () => {},
      ),
    (error) => {
      errors.push(error);
    },
  );
  const enqueue = (messageId: string, text: string) =>
    queue.enqueue("wechat", {
      channel: "wechat",
      target: "owner",
      senderId: "owner",
      isDirectMessage: true,
      messageId,
      text,
    });
  try {
    await server.start();
    core.ensureWorker(root);
    await until(() => ready);
    await queue.start();
    await enqueue("first", "我发了截图你帮我看看最新结论");
    await until(() => accepted > 0);
    await enqueue("second", "然后看下501058实时行情");
    await until(() => queue.status().pending === 0);
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain("simulated disconnected response");
    expect(starts.length).toBe(3); // first + steer + same-identity retry
    expect(new Set(starts).size).toBe(2);
    expect(launches).toBe(1);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("501058");
    expect(calls.filter((call) => call.method === "agent/steer")).toHaveLength(1);
    expect(calls.filter((call) => call.clientMessageId === "im:wechat:first")).toHaveLength(1);
    expect(calls.every((call) => call.outcome === "result")).toBe(true);
    await enqueue("third", "为什么卡住");
    await until(() => queue.status().pending === 0);
    expect(replies).toHaveLength(2);
    expect(replies[1]).toContain("消息已处理");
    expect(hostReplies).toBeGreaterThanOrEqual(2);
    expect(launches).toBe(1);
    expect(calls.filter((call) => call.clientMessageId === "im:wechat:third")).toHaveLength(1);
    expect(calls.every((call) => call.outcome === "result")).toBe(true);
    await until(async () => JSON.parse(await readFile(inboxPath, "utf8")).pending.length === 0);
    queue.stop();
    const inbox = JSON.parse(await readFile(inboxPath, "utf8"));
    expect(Object.keys(inbox.completed)).toHaveLength(3);
    expect(inbox.pending).toHaveLength(0);
  } finally {
    queue.stop();
    core.kill();
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});
