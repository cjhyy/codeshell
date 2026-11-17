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
} from "@cjhyy/code-shell-core";
import {
  LLMClientBase,
  registerProvider,
  type CreateMessageOptions,
  type LLMResponse,
} from "@cjhyy/code-shell-core/extension";
import { createPetModule } from "@cjhyy/code-shell-pet";
import { ChatGateway } from "../packages/chat/src/chat-gateway.js";
import { createMimiPetChat } from "../packages/chat/src/gateway.js";
import { BUILTIN_CHANNEL_CAPABILITIES, type ChannelAdapter } from "../packages/chat/src/channel.js";
import { PetDispatchService } from "../packages/desktop/src/main/pet/pet-dispatch-service.js";
import { PetHostActionReceiptStore } from "../packages/desktop/src/main/pet/pet-host-action-receipts.js";
import { enrichPetChatReplyWithHostActions } from "../packages/desktop/src/main/pet/host-action-reply.js";
import {
  completePetHostActionReceipt,
  PetHostActionReceiptService,
} from "../packages/desktop/src/main/pet/pet-host-action-completion.js";

// Desktop main appends the visible IM reply to Mimi's transcript after the
// worker's turn. The worker's live Engine never saw that receipt, so a reload
// (worker restart, idle eviction) must replay exactly the history the live
// Engine was sending — otherwise the prompt prefix and its cache fork.
type Step = (request: CreateMessageOptions) => LLMResponse;
type Script = { steps: Step[]; requests: CreateMessageOptions[] };
const scripts = new Map<string, Script>();
const cleanups: Array<() => void | Promise<void>> = [];
const provider = "mimi-restart-transcript-replay";

class ScriptedClient extends LLMClientBase {
  protected initClient(): void {}
  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    const script = scripts.get(this.model)!;
    // Auxiliary requests (titles, tool summaries) carry no tools.
    if (!options.tools?.length) {
      return {
        text: "aux",
        toolCalls: [],
        stopReason: "stop",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    }
    script.requests.push({ ...options, messages: structuredClone(options.messages) });
    const step = script.steps.shift();
    if (!step) throw new Error("Unexpected model round");
    const result = step(options);
    this.recordUsage(result.usage!, options);
    return result;
  }
}
registerProvider(provider, ScriptedClient);

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  scripts.clear();
});

let toolCounter = 0;
function gatewayReply(text: string): LLMResponse {
  return {
    text: "",
    toolCalls: [{ id: `tool-${++toolCounter}`, toolName: "GatewayReply", args: { text } }],
    stopReason: "tool_use",
    usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 },
  };
}

function createHarness() {
  const dir = mkdtempSync(join(tmpdir(), "mimi-restart-transcript-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const sessionsRootDir = join(dir, "sessions");
  const model = crypto.randomUUID();
  const script: Script = { steps: [], requests: [] };
  scripts.set(model, script);
  const sessionId = "pet-restart";

  // The worker process: replaced wholesale by `restartWorker`, while desktop
  // main (dispatcher, receipt service, gateway) survives, as in production.
  let worker: { client: AgentClient; close: () => Promise<void> } | undefined;
  let outbound: ((line: string, entry: { sessionId: string; event: unknown }) => void) | undefined;
  const startWorker = () => {
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
          maxTurns: 20,
        });
        (engine as any).hooks.clear();
        return engine;
      },
    });
    const [serverTransport, clientTransport] = createInProcessTransport();
    const server = new AgentServer({ chatManager: manager, transport: serverTransport });
    const client = new AgentClient({ transport: clientTransport });
    client.onStreamEvent((event) => outbound?.("", event));
    worker = {
      client,
      close: async () => {
        server.close();
        client.close();
        await manager.closeAll();
      },
    };
  };
  startWorker();
  cleanups.push(async () => worker?.close());

  const dispatcher = new PetDispatchService({
    metadata: { ensure: async () => ({ petSessionId: sessionId }) },
    aggregator: {
      getSnapshot: () => ({
        version: 1,
        generation: 1,
        observedAt: 0,
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
          const client = worker!.client;
          const result =
            method === "agent/run"
              ? await client.run(params as unknown as RunParams)
              : await client.requestExtension(method, params);
          return { ok: true, result };
        } catch (error) {
          return { ok: false, message: String(error) };
        }
      },
    },
    hostCwd: dir,
    sessionsRootDir,
    listWorkspaces: async () => [{ name: "CodeShell", path: dir }],
    listReusableSessions: async () => [],
    startWorkSession: async () => {
      throw new Error("no delegation in this fixture");
    },
    hostActionReceipts: new PetHostActionReceiptStore(join(dir, "receipts.json")),
    hostActions: { gatewayReply: async (payload) => ({ text: payload.text }) },
    segmentController: {
      beginTurn: async () => undefined,
      requestContextClear: async () => {},
      completeSegmentClosure: async () => {},
      onDelegationClosed: async () => {},
    },
  });
  // The same durable receipt recorder Desktop main wires for Mimi.
  const receipts = new PetHostActionReceiptService({ sessionsRootDir, qrDir: join(dir, "qr") });
  const sent: string[] = [];
  const adapter: ChannelAdapter = {
    channel: "wechat",
    capabilities: BUILTIN_CHANNEL_CAPABILITIES.wechat,
    run: async () => {},
    send: async (_target, message) => {
      sent.push(message.text ?? "");
    },
  };
  const gateway = new ChatGateway({ adapters: [adapter] });
  gateway.use(
    createMimiPetChat({
      desktop: {
        // Mirrors desktop main's IM handler: dispatch, render, then persist the
        // visible reply as a replacement receipt in Mimi's transcript.
        petChat: async (input) => {
          const origin = input.origin!;
          const clientMessageId = `im:wechat:${createHash("sha256")
            .update([origin.channel, origin.target, origin.senderId, origin.messageId].join("\0"))
            .digest("hex")}`;
          const result = await dispatcher.dispatch({
            type: "chat",
            message: input.message,
            clientMessageId,
            source: { kind: "im-gateway", ...origin },
          });
          if (!result.ok || result.type !== "chat") throw new Error("dispatch failed");
          const run = result.result as { text?: string };
          const enriched = await enrichPetChatReplyWithHostActions(
            result.authoritativeReply ?? run.text ?? "",
            result.hostActions,
            {
              qrDir: join(dir, "qr"),
              authoritativeBaseText: Boolean(result.authoritativeReply),
              attachmentKinds: [],
            },
          );
          const receipt = await completePetHostActionReceipt({
            recorder: receipts,
            input: {
              petSessionId: result.petSessionId,
              clientMessageId,
              executions: result.hostActions ?? [],
              authoritativeMessage: enriched.text,
              replaceAssistant: true,
              deliveryChannel: origin.channel,
            },
            publish: () => {},
          });
          expect(receipt?.message).toBe(enriched.text);
          return { ...enriched, petSessionId: result.petSessionId };
        },
      },
    }),
  );
  return {
    script,
    sent,
    transcriptRows: () =>
      readFileSync(join(sessionsRootDir, sessionId, "transcript.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string; data: Record<string, unknown> }),
    restartWorker: async () => {
      await worker!.close();
      startWorker();
    },
    say: (text: string, messageId: string) =>
      gateway.dispatch(adapter, {
        channel: "wechat",
        target: "owner-chat",
        senderId: "owner",
        text,
        messageId,
      }),
  };
}

/** Number of leading messages two requests share byte for byte. */
function sharedPrefix(a: CreateMessageOptions, b: CreateMessageOptions): number {
  let index = 0;
  while (
    index < a.messages.length &&
    index < b.messages.length &&
    JSON.stringify(a.messages[index]) === JSON.stringify(b.messages[index])
  )
    index += 1;
  return index;
}

async function runConversation(restartBeforeLastTurn: boolean) {
  const h = createHarness();
  h.script.steps.push(
    () => gatewayReply("第一条回复"),
    () => gatewayReply("第二条回复"),
    () => gatewayReply("第三条回复"),
  );
  await h.say("你好", "m1");
  await h.say("继续", "m2");
  if (restartBeforeLastTurn) await h.restartWorker();
  await h.say("再继续", "m3");
  expect(h.sent).toEqual(["第一条回复", "第二条回复", "第三条回复"]);
  expect(h.script.requests).toHaveLength(3);
  return h;
}

describe("Mimi transcript replay after a worker restart", () => {
  test("host receipts stay in the transcript for display but out of the replayed model history", async () => {
    const live = await runConversation(false);
    const reloaded = await runConversation(true);
    const [, liveSecond, liveThird] = live.script.requests;
    const [, reloadedSecond, reloadedThird] = reloaded.script.requests;

    // The receipts are durable conversation records (UI / IM history read them).
    const receiptRows = reloaded
      .transcriptRows()
      .filter(
        (row) =>
          row.type === "message" &&
          String(row.data.clientMessageId ?? "").startsWith("pet-host-action-replace"),
      );
    expect(receiptRows.map((row) => row.data.content)).toEqual([
      "第一条回复",
      "第二条回复",
      "第三条回复",
    ]);
    expect(receiptRows.every((row) => row.data.displayOnly === true)).toBe(true);

    // The live Engine's third request keeps the second request's history,
    // minus only the trailing volatile world message.
    const liveShared = sharedPrefix(liveSecond!, liveThird!);
    expect(liveShared).toBeGreaterThan(1);
    expect(liveShared).toBe(liveSecond!.messages.length - 1);

    // A reloaded Engine shares exactly the same prefix with what the live
    // Engine sent before the restart: the receipts never enter the history.
    expect(sharedPrefix(reloadedSecond!, reloadedThird!)).toBe(liveShared);
    expect(reloadedThird!.messages).toHaveLength(liveThird!.messages.length);
    expect(JSON.stringify(reloadedThird!.messages)).not.toContain("pet-host-action");
    const roles = (request: CreateMessageOptions) => request.messages.map((m) => m.role);
    expect(roles(reloadedThird!)).toEqual(roles(liveThird!));
    // No assistant message in the replay repeats the receipt text verbatim.
    const assistantText = reloadedThird!.messages
      .filter((message) => message.role === "assistant" && typeof message.content === "string")
      .map((message) => message.content);
    expect(assistantText).not.toContain("第一条回复");
    expect(assistantText).not.toContain("第二条回复");
  });
});
