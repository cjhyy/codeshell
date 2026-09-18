import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transcript } from "@cjhyy/code-shell-core";
import { sessionSelectorId } from "@cjhyy/code-shell-pet/disclosure";
import { replacementReceiptDisplayMetadata } from "../../shared/pet-host-action-receipt.js";
import { ConversationSessionRouteStore } from "./conversation-session-route-store.js";
import { enrichPetChatReplyWithHostActions } from "./host-action-reply.js";
import { PetDispatchService } from "./pet-dispatch-service.js";
import {
  completePetHostActionReceipt,
  PetHostActionReceiptService,
  type PetHostActionCompletedEvent,
} from "./pet-host-action-completion.js";
import { PetHostActionReceiptStore } from "./pet-host-action-receipts.js";
import type { DesktopPetProjectionSnapshot } from "./pet-state-aggregator.js";
import { createReusableSessionResolver } from "./reusable-session-resolver.js";
import {
  createBoundSessionHealth,
  createBoundSessionRunner,
  createSessionBridgeWiring,
} from "./session-bridge-wiring.js";
import { imConversationRouteKey } from "./session-turn-scheduler.js";

const roots: string[] = [];
const PET_SESSION_ID = "pet-feedback";
const WORK_SESSION_ID = "work-edge-model";
const TITLE = "端侧小模型如何训练";
const PENDING_REPLY = `已提交进入「${TITLE}」的请求，由宿主校验后给出结果。`;
const INBOUND = {
  channel: "wechat",
  target: "owner-one",
  senderId: "owner-one",
  isDirectMessage: true,
  messageId: "next-message",
  text: "接着讲量化训练",
};

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function harness(options: { missingWorkspace?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "session-bind-feedback-"));
  roots.push(root);
  const sessionsRootDir = join(root, "sessions");
  const workspace = join(root, "workspace");
  const routesFilePath = join(root, "pet", "conversation-session-routes.json");
  const transcriptPath = join(sessionsRootDir, PET_SESSION_ID, "transcript.jsonl");
  await mkdir(join(sessionsRootDir, WORK_SESSION_ID), { recursive: true });
  await mkdir(join(sessionsRootDir, PET_SESSION_ID), { recursive: true });
  if (!options.missingWorkspace) await mkdir(workspace);
  await writeFile(
    join(sessionsRootDir, WORK_SESSION_ID, "state.json"),
    JSON.stringify({ parentSessionId: null, origin: "desktop", title: TITLE, cwd: workspace }),
  );

  const snapshot: DesktopPetProjectionSnapshot = {
    version: 1,
    generation: 1,
    workerState: "active",
    observedAt: Date.now(),
    sessions: [
      {
        agentSessionId: WORK_SESSION_ID,
        title: TITLE,
        workspaceDisplayName: "coding-learning",
        runState: "idle",
        summary: "空闲",
        queueDepth: 0,
        lastActivityAt: Date.now(),
        pendingDecisionCount: 0,
        freshness: { source: "live-event", observedAt: Date.now(), workerState: "active" },
      },
    ],
    pending: [],
  };
  const aggregator = {
    getSnapshot: () => snapshot,
    refreshCatalog: async () => {},
    resolveNavigation: async () => ({ status: "not-found" as const }),
  };
  let requestedAction: "enter" | "leave" = "enter";
  const workRuns: Array<Record<string, unknown>> = [];
  const outbound = new Set<(line: string) => void>();
  const worker = {
    subscribeOutbound: (listener: (line: string) => void) => {
      outbound.add(listener);
      return () => {
        outbound.delete(listener);
      };
    },
    injectWorkerMessage: (line: string) => {
      const request = JSON.parse(line);
      expect(request.method).toBe("agent/run");
      expect(request.params.sessionId).toBe(WORK_SESSION_ID);
      workRuns.push(request.params);
      // The bridge must see the worker's explicit acceptance, not infer it
      // from an unresolved RPC or fabricate a completed turn.
      for (const listener of outbound)
        listener(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "agent/runAccepted",
            params: { requestId: request.id, sessionId: WORK_SESSION_ID },
          }),
        );
    },
    requestWorker: async (method: string, params: Record<string, unknown>) => {
      expect(method).toBe("agent/run");
      expect(params.sessionId).toBe(PET_SESSION_ID);
      expect((params.profileParams as { hostActions: string[] }).hostActions).toContain(
        "sessionBind",
      );
      // Stand in only for the model/worker response. Keep the real persisted
      // draft so the receipt must identify which visible answer it replaces.
      const transcript = Transcript.loadFromFile(transcriptPath);
      transcript.appendMessage("user", String(params.task), {
        clientMessageId: String(params.clientMessageId),
      });
      transcript.appendMessage("assistant", PENDING_REPLY);
      return {
        ok: true as const,
        result: {
          text: PENDING_REPLY,
          extensions: {
            pet: {
              hostActions: [
                {
                  kind: "sessionBind",
                  payload:
                    requestedAction === "enter"
                      ? { action: "enter", sessionSelector: sessionSelectorId(WORK_SESSION_ID) }
                      : { action: "leave" },
                },
              ],
            },
          },
        },
      };
    },
  };
  const wiring = createSessionBridgeWiring({
    routesFilePath,
    resolveSelector: createReusableSessionResolver(sessionsRootDir),
    createRunner: (onTurn) => createBoundSessionRunner(worker, aggregator, onTurn),
    health: createBoundSessionHealth(aggregator, sessionsRootDir),
    describeStatus: async (route) => `当前在「${route.sessionTitle}」。`,
    publish: async () => {
      throw new Error("This test must not send external messages");
    },
  });
  const dispatcher = new PetDispatchService({
    metadata: { ensure: async () => ({ petSessionId: PET_SESSION_ID }) },
    aggregator,
    worker,
    hostCwd: root,
    sessionsRootDir,
    hostActions: { sessionBind: wiring.sessionBindExecutor },
    hostActionReceipts: new PetHostActionReceiptStore(join(root, "pet", "host-actions.json")),
  });
  const recorder = new PetHostActionReceiptService({ sessionsRootDir, qrDir: join(root, "qr") });
  const events: PetHostActionCompletedEvent[] = [];

  async function controlTurn(action: "enter" | "leave", expectedMessage: string) {
    requestedAction = action;
    const clientMessageId = `im:wechat:${action}`;
    const result = await dispatcher.dispatch({
      type: "chat",
      message: action === "enter" ? "进入刚才列出的 Session" : "退出这个 Session",
      clientMessageId,
      source: {
        kind: "im-gateway",
        channel: INBOUND.channel,
        target: INBOUND.target,
        senderId: INBOUND.senderId,
        isDirectMessage: true,
        capabilities: {
          inbound: { text: true, attachments: [] },
          outbound: { text: true, button: "link", attachments: [] },
        },
      },
    });
    if (!result.ok || result.type !== "chat") throw new Error("expected a completed Mimi turn");
    // This catches a valid sessionBind envelope being dropped by the shared
    // response parser before the real host executor ever runs.
    expect(result.hostActions).toHaveLength(1);
    expect(result.hostActions?.[0]).toMatchObject({ kind: "sessionBind", payload: { action } });
    const enriched = await enrichPetChatReplyWithHostActions(
      (result.result as { text: string }).text,
      result.hostActions,
      { qrDir: join(root, "qr"), attachmentKinds: [] },
    );
    expect(enriched.text).toBe(expectedMessage);
    expect(enriched.text).not.toContain("由宿主校验后给出结果");
    const receipt = await completePetHostActionReceipt({
      recorder,
      input: {
        petSessionId: result.petSessionId,
        clientMessageId,
        executions: result.hostActions ?? [],
        authoritativeMessage: enriched.text,
      },
      publish: (event) => events.push(event),
    });
    expect(receipt).toEqual({ message: expectedMessage, replaceAssistant: true });
    expect(events.at(-1)).toMatchObject({
      kind: "host-action-completed",
      clientMessageId,
      message: expectedMessage,
      replaceAssistant: true,
    });
    const rows = (await readFile(transcriptPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const persisted = rows.at(-1).data;
    expect(persisted).toMatchObject({ role: "assistant", content: expectedMessage });
    expect(replacementReceiptDisplayMetadata(persisted.clientMessageId, persisted.content)).toEqual(
      {
        sourceClientMessageId: clientMessageId,
      },
    );
    return result.hostActions![0]!;
  }

  return { wiring, controlTurn, workRuns, routesFilePath };
}

test("an accepted Session entry binds the next input and persists its final receipt, then leaves", async () => {
  const h = await harness();
  const entered = await h.controlTurn(
    "enter",
    `已进入「${TITLE}」。接下来的消息会直接发送到这个 Session，沿用它的已有上下文。\n发送 /mimi 可退出，发送 /session 可查看当前状态。`,
  );
  expect(entered).toMatchObject({ ok: true, result: { action: "enter", ok: true } });
  const diskRoutes = new ConversationSessionRouteStore(h.routesFilePath);
  expect(await diskRoutes.boundRoute(imConversationRouteKey(INBOUND)!)).toMatchObject({
    sessionId: WORK_SESSION_ID,
    sessionTitle: TITLE,
  });
  expect(h.workRuns).toEqual([]);
  expect(await h.wiring.routeInbound(INBOUND)).toMatchObject({ kind: "accepted" });
  expect(h.workRuns).toHaveLength(1);
  expect(h.workRuns[0]).toMatchObject({ sessionId: WORK_SESSION_ID, task: INBOUND.text });

  await h.controlTurn("leave", `已退出「${TITLE}」，接下来由 Mimi 处理。`);
  expect(await h.wiring.routeInbound({ ...INBOUND, messageId: "after-leave" })).toEqual({
    kind: "not-bound",
  });
  expect(h.workRuns).toHaveLength(1);
});

test("a refused Session entry publishes its actual reason and leaves following input with Mimi", async () => {
  const h = await harness({ missingWorkspace: true });
  const refused = await h.controlTurn(
    "enter",
    "这个 Session 的工作目录已经不存在了（可能 worktree 被删除），进入会把消息写到一个无效目录。",
  );
  expect(refused).toMatchObject({ ok: true, result: { action: "enter", ok: false } });
  expect(await h.wiring.routes.all()).toEqual([]);
  expect(await h.wiring.routeInbound(INBOUND)).toEqual({ kind: "not-bound" });
  expect(h.workRuns).toEqual([]);
});
