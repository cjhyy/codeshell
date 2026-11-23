import { runMimiGatewayTurn } from "./mimi-gateway-turn.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type { StateStorage } from "@cjhyy/code-shell-core/internal/storage";
import { buildPetLongTaskContext } from "@cjhyy/code-shell-pet";
import { readSettings } from "../../main/settings-service.js";
import {
  PetDispatchService,
  type PetDispatchOptions,
  type PetDispatchCommand,
} from "../../main/pet/pet-dispatch-service.js";
import { createReusableSessionResolver } from "../../main/pet/reusable-session-resolver.js";
import {
  petChatModelKeyFromSettings,
  petPersonalizationFromSettings,
} from "../../shared/pet-settings.js";
import type { MimiRecordCall, MimiRecords } from "../../shared/mimi-records.js";
import type { PetLongTaskControlResult } from "@cjhyy/code-shell-pet";
import {
  sessionModelKeyFromSettings,
  defaultSessionModelKeyFromSettings,
} from "../../shared/session-model-default.js";
import type { ListSessions } from "../../shared/disk-session-query.js";
import { mimiTurnStores, type MimiTurnStorageCommand } from "../../shared/mimi-turn-storage.js";
import type { MimiTaskCommand } from "../../shared/mimi-tasks.js";
import type { MimiNativeMethods } from "../../main/desktop-host/mimi-dispatch-client.js";
import type { DispatchConfiguration, WiredMimiCommand } from "../../shared/mimi-dispatch.js";
import { PrivateHostPeer, type PrivatePort } from "../native-peer.js";
import { readMimiList } from "./mimi-records.js";
import type { HostedMimiTasks } from "./mimi-tasks.js";

export class HostedMimiDispatch {
  private peer?: PrivateHostPeer;
  private stream?: Parameters<NonNullable<PetDispatchOptions["worker"]["subscribeOutbound"]>>[0];
  constructor(
    private readonly storage: Promise<StateStorage>,
    private readonly sessionsDir: string,
    private readonly listSessions: ListSessions,
    private readonly tasks: HostedMimiTasks,
    private readonly projection: PetDispatchOptions["aggregator"],
    private readonly replies: Pick<Parameters<typeof runMimiGatewayTurn>[1], "render" | "receipt">,
    private readonly runTask: (command: MimiTaskCommand, signal?: AbortSignal) => Promise<unknown>,
    private readonly runRecord: (command: MimiRecordCall, signal?: AbortSignal) => Promise<unknown>,
    private readonly turnStorage: (
      command: MimiTurnStorageCommand,
      signal?: AbortSignal,
    ) => Promise<unknown>,
  ) {}
  observe(envelope: { sessionId: string; event: unknown }) {
    const event = envelope.event as { type?: string; result?: { toolName?: string } } | null;
    if (
      event?.type === "steer_injected" ||
      (event?.type === "tool_result" && event.result?.toolName === "NewContext")
    )
      this.stream?.("", envelope);
  }
  close() {
    this.peer?.close();
    this.peer = undefined;
    this.stream = undefined;
  }
  bind(port: PrivatePort) {
    if (this.peer) {
      port.close();
      return;
    }
    const scope = new AsyncLocalStorage<{ signal: AbortSignal; admitted: boolean }>();
    const gates = new Map<string, { token: string; current?: () => Promise<boolean> }>();
    let service: PetDispatchService | undefined;
    const admission = (effect = false) => {
      const ctx = scope.getStore();
      if (ctx && (effect || !ctx.admitted)) ctx.signal.throwIfAborted();
      if (ctx && effect) {
        ctx.admitted = true;
        return ctx.signal;
      }
      return ctx?.admitted ? undefined : ctx?.signal;
    };
    const native =
      <K extends keyof MimiNativeMethods>(name: K, effect = false) =>
      (...args: Parameters<MimiNativeMethods[K]>) =>
        peer.call<Awaited<ReturnType<MimiNativeMethods[K]>>>(name, args, admission(effect));
    const task = <R>(command: MimiTaskCommand, effect = false) =>
      this.runTask(command, admission(effect)) as Promise<R>;
    const configure = ({ hostCwd, actions }: DispatchConfiguration) => {
      if (
        service ||
        !isAbsolute(hostCwd) ||
        !Array.isArray(actions) ||
        actions.length > 64 ||
        actions.some((kind) => typeof kind !== "string" || !/^[a-zA-Z][a-zA-Z0-9]*$/.test(kind))
      )
        throw Error("Invalid Mimi configuration");
      const stores = mimiTurnStores((cmd) => this.turnStorage(cmd, admission()));
      const worker: PetDispatchOptions["worker"] = {
        requestWorker: (...args) => native("worker", args[0] !== "agent/goalGet")(...args),
        subscribeOutbound: (listener) => {
          this.stream = listener;
          return () => {
            if (this.stream === listener) this.stream = undefined;
          };
        },
      };
      service = new PetDispatchService({
        hostCwd,
        sessionsRootDir: this.sessionsDir,
        metadata: { ensure: () => readMimiList(this.storage, "metadata") },
        attachmentContext: stores.attachmentContext,
        contextLinks: stores.contextLinks,
        hostActionReceipts: stores.receipts,
        worker,
        aggregator: this.projection,
        managerModel: async () => {
          const settings = await readSettings("user");
          return petChatModelKeyFromSettings(settings) ?? sessionModelKeyFromSettings(settings);
        },
        personalization: async () =>
          petPersonalizationFromSettings(await readSettings("user").catch(() => null)),
        externalRuntime: {
          run: native("externalRun", true),
          stop: native("externalStop", true),
          resetContext: native("externalReset", true),
        },
        segmentController: {
          requestContextClear: native("clear", true),
          beginTurn: native("begin"),
          completeSegmentClosure: native("complete", true),
          onDelegationClosed: native("closeDelegation", true),
        },
        longTasks: {
          context: async () => buildPetLongTaskContext((await this.tasks.snapshot()).tasks),
          recordClosureDecision: (...args) => task({ method: "recordClosureDecision", args }, true),
          recordContinuationStarted: (...args) =>
            task({ method: "recordContinuationStarted", args }, true),
        },
        startWorkSession: (...args) => task({ method: "startDelegation", args }, true),
        validateFollowUpContinuation: native("validateContinuation"),
        taskInbox: native("taskInbox"),
        recentProactive: native("recentProactive"),
        noticeTurns: {
          isOwnerConversation: native("owner"),
          begin: async (id, allowed, current) => {
            const token = randomUUID();
            gates.set(id, { token, current });
            await native("gateBegin")(id, allowed, token);
          },
          end: async (id) => {
            const gate = gates.get(id);
            if (!gate) return;
            gates.delete(id);
            await native("gateEnd")(id, gate.token);
          },
        },
        hostActions: {
          ...Object.fromEntries(
            actions.map((kind) => [
              kind,
              (...args: Parameters<NonNullable<PetDispatchOptions["hostActions"]>[string]>) =>
                native("action", true)(kind, ...args),
            ]),
          ),
          longTaskControl: async (payload) => {
            const taskId = payload.taskId,
              action = payload.action;
            if (
              typeof taskId !== "string" ||
              !taskId ||
              (action !== "pause" &&
                action !== "resume" &&
                action !== "retry" &&
                action !== "cancel")
            )
              throw Error("invalid long-task control request");
            const controlled = await task<PetLongTaskControlResult>(
              { method: "control", args: [{ taskId, action }] },
              true,
            );
            if (!controlled.ok) throw Error(controlled.message);
            return { action, objective: controlled.task.objective, status: controlled.task.status };
          },
          memory: (payload, ctx) =>
            this.runRecord(
              {
                action: "memoryAction",
                args: [
                  payload,
                  ctx && { originRef: ctx.originRef, groundedTasks: ctx.groundedTasks },
                ],
              },
              admission(true),
            ) as Promise<Record<string, unknown>>,
        },
        worldContext: async (input) => {
          const [memory, remote, settings] = await Promise.all([
            this.runRecord(
              {
                action: "memoryRecall",
                args: [
                  {
                    message: input.message,
                    originRef: input.originRef,
                    groundedObjectives: input.groundedTasks.map((t) => t.objective),
                    taskIds: input.groundedTasks.map((t) => t.taskId),
                  },
                ],
              },
              admission(),
            ) as Promise<ReturnType<MimiRecords["memoryRecall"]>>,
            native("remoteContext")(),
            readSettings("user"),
          ]);
          return {
            ...memory,
            mobileRemote: remote,
            defaultWorkSessionModel: defaultSessionModelKeyFromSettings(settings),
          };
        },
        listWorkspaces: native("workspaces"),
        listFollowUps: native("followUps"),
        listOutboundTargets: native("targets"),
        replyAttachmentRoots: native("roots"),
        resolveReusableSessionBySelector: createReusableSessionResolver(this.sessionsDir),
        listReusableSessions: async () => {
          const { sessions } = await this.listSessions({ limit: 100 });
          return sessions
            .filter((row) => row.origin === "desktop")
            .map((row) => ({
              sessionId: row.engineSessionId,
              workspacePath: resolve(row.cwd || hostCwd) === resolve(hostCwd) ? null : row.cwd,
              title: row.title,
              updatedAt: row.updatedAt,
              status: row.status,
            }));
        },
      });
    };
    const peer: PrivateHostPeer = new PrivateHostPeer(
      port,
      (method, args, signal) => {
        if (!Array.isArray(args)) throw Error("Invalid Mimi request");
        if (method === "configure") {
          configure(args[0]);
          return;
        }
        if (method === "gateCurrent") {
          for (const gate of gates.values())
            if (gate.token === args[0]) return gate.current?.() ?? false;
          return false;
        }
        const manager = service;
        if (!manager) throw Error("Mimi dispatcher unavailable");
        return scope.run({ signal, admitted: false }, () => {
          signal.throwIfAborted();
          switch (method) {
            case "getSessionId":
              return manager.getSessionId();
            case "wakeFollowUp":
              return manager.wakeFollowUp(args[0]);
            case "reportSessionMessage":
              return manager.reportSessionMessage(args[0], args[1]);
            case "reportLongTaskClosure":
              return manager.reportLongTaskClosure(args[0]);
            case "gatewayTurn": {
              const [input, token, replay] = args;
              if (typeof token !== "string" || typeof replay !== "boolean")
                throw Error("Invalid gateway turn");
              return runMimiGatewayTurn(input, {
                ...this.replies,
                manager,
                ...(replay && {
                  pending: {
                    take: () => native("takePending")(token),
                    started: () => native("pendingStarted")(token),
                  },
                }),
                native: {
                  submitted: (event) => native("gatewaySubmitted")(token, event),
                  dispatched: () => native("gatewayDispatched")(token),
                  completed: (event) => native("gatewayCompleted")(token, event),
                  attachmentsSent: async () => {
                    await native("gatewayAttachmentsSent")(token);
                  },
                },
                onReceiptError: (e) =>
                  console.warn("[Desktop Host] Mimi gateway receipt failed", e),
              });
            }
            case "dispatch": {
              const cmd = args[0] as WiredMimiCommand;
              if (cmd.type !== "chat" || !cmd.noticeSource) return manager.dispatch(cmd);
              const { noticeSource, ...chat } = cmd;
              const command: PetDispatchCommand = {
                ...chat,
                pendingNotices: {
                  take: () => native("takePending")(noticeSource),
                  started: () => native("pendingStarted")(noticeSource),
                },
              };
              return manager.dispatch(command);
            }
            default:
              throw Error("Unknown Mimi dispatcher operation");
          }
        });
      },
      () => {
        gates.clear();
        if (this.peer === peer) {
          this.peer = undefined;
          this.stream = undefined;
        }
      },
    );
    this.peer = peer;
  }
}
