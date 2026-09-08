import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { isAbsolute } from "node:path";
import { SettingsManager } from "@cjhyy/code-shell-core";
import { getMergedCatalog } from "@cjhyy/code-shell-core/internal";
import { WorkerBridgeCore, type WorkerRpcOutcome } from "../worker-bridge-core.js";
import {
  PanelAppAgentTaskService,
  type PanelAgentTaskOwner,
  type PanelAgentTaskProgressInput,
  type PanelAgentTaskRuntime,
  type PanelAgentTaskStartInput,
} from "./agent-task-service.js";
import {
  buildPanelAgentTaskModelCatalog,
  type PanelAgentTaskModelCatalog,
} from "./agent-task-models.js";

export interface PanelAgentTaskScope {
  instanceId: string;
  ownerId: string;
  appId: string;
  appTitle: string;
  projectPath: string;
  cwd: string;
  permissions: readonly string[];
  availableSkills: readonly string[];
  isAuthorized: () => Promise<boolean>;
  emit: (event: string, payload: unknown) => void;
}

export interface PanelAgentTaskHostOptions {
  workerEntryPath?: string;
  execPath?: string;
  buildEnv?: () => NodeJS.ProcessEnv;
  models?: (cwd: string) => PanelAgentTaskModelCatalog | Promise<PanelAgentTaskModelCatalog>;
  /** The host implements panel discovery and callbacks, scoped to this one installed app. */
  onPanelAction?: (scope: PanelAgentTaskScope, input: Record<string, unknown>) => Promise<unknown>;
  maxConcurrentTasks?: number;
  authorizationPollMs?: number;
  runTimeoutMs?: number;
}

interface PendingApproval {
  id: string;
  taskId: string;
  sessionId: string;
  connectionId?: string;
  generation?: number;
  settling: boolean;
}

interface RunningTask {
  bridge: WorkerBridgeCore;
  taskId: string;
  sessionId: string;
  cancelled: boolean;
  pid?: number;
}

interface Instance {
  scope: PanelAgentTaskScope;
  owner: PanelAgentTaskOwner;
  service: PanelAppAgentTaskService;
  running: Map<string, RunningTask>;
  approvals: Map<string, PendingApproval>;
  cancelledSessions: Set<string>;
  closed: boolean;
  timer: ReturnType<typeof setInterval>;
}

// Keep the request's hard tool ceiling. Scheduling, delegation, arbitrary MCP,
// workspace switching and other panels are not granted by agent.task.
const TASK_TOOLS = new Set([
  "Panel",
  "Bash",
  "BashOutput",
  "ListShells",
  "KillShell",
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
  "Skill",
]);
const MAX_APPROVALS = 16;

function outcomeResult(outcome: WorkerRpcOutcome): unknown {
  if (outcome.status === "result") return outcome.result;
  if (outcome.status === "error") throw new Error(outcome.error.message || "Agent task failed");
  if (outcome.status === "timeout") throw new Error("Agent task timed out");
  throw new Error("Agent task worker stopped or could not start");
}

function progressFromEvent(event: Record<string, unknown>): PanelAgentTaskProgressInput | null {
  switch (event.type) {
    case "session_started":
      return { kind: "model", status: "running", message: "Task started" };
    case "stream_request_start":
      return { kind: "model", status: "running", message: "AI is planning the next step" };
    case "text_delta":
    case "assistant_message":
      return { kind: "model", status: "running", message: "AI is preparing the result" };
    case "tool_use_start": {
      const name = String((event.toolCall as any)?.toolName || "Tool").slice(0, 128);
      return { kind: "tool", status: "running", message: `Running ${name}`, toolName: name };
    }
    case "tool_result": {
      const name = String((event.result as any)?.toolName || "Tool").slice(0, 128);
      return { kind: "tool", status: "completed", message: `${name} returned`, toolName: name };
    }
    case "error":
      return { kind: "error", status: "failed", message: String(event.error || "Task failed") };
    default:
      return null;
  }
}

/** Real independent Core workers shared by Desktop Web and standalone Hub. */
export function createPanelAgentTaskHost(options: PanelAgentTaskHostOptions = {}) {
  const instances = new Map<string, Instance>();
  let closed = false;
  const models =
    options.models ??
    ((cwd: string) =>
      buildPanelAgentTaskModelCatalog(new SettingsManager(cwd, "full").get(), getMergedCatalog()));
  const activeTaskCount = (): number =>
    [...instances.values()].reduce(
      (count, instance) =>
        count +
        instance.service
          .list(instance.owner)
          .filter((task) => ["queued", "running", "cancelling"].includes(task.status)).length,
      0,
    );

  const assertAuthorized = async (instance: Instance): Promise<void> => {
    let authorized = false;
    if (!closed && !instance.closed) {
      try {
        authorized = await instance.scope.isAuthorized();
      } catch {
        /* Fail closed. */
      }
    }
    if (closed || instance.closed || !authorized) {
      revokeInstance(instance.scope.instanceId);
      throw new Error("Panel App owner is no longer authorized");
    }
    if (closed || instance.closed) throw new Error("Panel App owner is no longer authorized");
  };

  const rpc = (running: RunningTask, method: string, params: unknown, timeoutMs = 5_000) =>
    running.bridge.request(method, params, {
      id: `panel-${randomUUID()}`,
      timeoutMs,
      consume: true,
      settleOnExit: true,
      failFast: true,
      meta: { origin: "host", producer: "web-panel-agent-task" },
    });

  const stopWorker = (running: RunningTask): void => {
    running.cancelled = true;
    running.bridge.kill();
    const timer = setTimeout(() => {
      // This bridge belongs to exactly one task and never respawns after close.
      if (running.pid && running.bridge.hasChild()) {
        try {
          process.kill(running.pid, "SIGKILL");
        } catch {
          /* Already exited. */
        }
      }
    }, 500);
    timer.unref();
  };

  function revokeInstance(instanceId: string): void {
    const instance = instances.get(instanceId);
    if (!instance || instance.closed) return;
    instance.closed = true;
    clearInterval(instance.timer);
    instance.service.cancelApp(instance.scope.appId);
    instance.approvals.clear();
    for (const running of instance.running.values()) stopWorker(running);
    instances.delete(instanceId);
  }

  const deliver = async (instance: Instance, event: string, payload: unknown) => {
    try {
      await assertAuthorized(instance);
      instance.scope.emit(event, payload);
    } catch {
      /* Revoked instances receive no additional task output. */
    }
  };

  async function handleWorkerApproval(
    instance: Instance,
    running: RunningTask,
    params: Record<string, any>,
  ): Promise<void> {
    await assertAuthorized(instance);
    if (params.sessionId !== running.sessionId || typeof params.requestId !== "string") return;
    const request = params.request;
    if (!request || typeof request.toolName !== "string") return;
    const pending: PendingApproval = {
      id: params.requestId,
      taskId: running.taskId,
      sessionId: running.sessionId,
      settling: false,
      ...(typeof params.connectionId === "string" ? { connectionId: params.connectionId } : {}),
      ...(Number.isInteger(params.generation) ? { generation: params.generation } : {}),
    };
    if (request.toolName.startsWith("__")) {
      let decision: Record<string, unknown>;
      if (request.toolName === "__panel_action__" && options.onPanelAction) {
        try {
          const result = await options.onPanelAction(instance.scope, request.args ?? {});
          await assertAuthorized(instance);
          const answer = JSON.stringify(result);
          if (!answer || Buffer.byteLength(answer) > 512 * 1024)
            throw new Error("Panel callback returned an invalid or oversized result");
          decision = { approved: true, answer };
        } catch (error) {
          decision = {
            approved: false,
            failure: "unavailable",
            reason: String(error).slice(0, 500),
          };
        }
      } else {
        decision = {
          approved: false,
          failure: "unavailable",
          reason: "This task host does not provide that capability",
        };
      }
      await assertAuthorized(instance);
      outcomeResult(
        await rpc(running, "agent/approve", {
          sessionId: pending.sessionId,
          requestId: pending.id,
          connectionId: pending.connectionId,
          generation: pending.generation,
          decision,
        }),
      );
      return;
    }
    if (instance.approvals.size >= MAX_APPROVALS)
      throw new Error("Too many pending task approvals");
    instance.approvals.set(pending.id, pending);
    await deliver(instance, "agent.task.approvalRequested", {
      taskId: running.taskId,
      requestId: pending.id,
      title: `批准 ${request.toolName.slice(0, 128)}`,
      body: String(request.description || "").slice(0, 2_000),
      toolName: request.toolName.slice(0, 128),
      args: JSON.stringify(request.args ?? {}).slice(0, 12_000),
    });
  }

  function getInstance(scope: PanelAgentTaskScope): Instance {
    if (closed) throw new Error("Panel task host is closed");
    if (
      !scope ||
      !scope.instanceId ||
      !scope.ownerId ||
      !scope.appId ||
      !isAbsolute(scope.cwd) ||
      !isAbsolute(scope.projectPath) ||
      !scope.permissions?.includes("agent.task") ||
      !Array.isArray(scope.availableSkills) ||
      typeof scope.isAuthorized !== "function" ||
      typeof scope.emit !== "function"
    )
      throw new Error("Panel App permission denied: agent.task");
    const existing = instances.get(scope.instanceId);
    if (existing) {
      if (
        ["ownerId", "appId", "projectPath", "cwd"].some(
          (key) =>
            existing.scope[key as keyof PanelAgentTaskScope] !==
            scope[key as keyof PanelAgentTaskScope],
        )
      )
        throw new Error("Panel App task owner does not match");
      return existing;
    }
    const owner: PanelAgentTaskOwner = {
      guestId: 0,
      ownerWebContentsId: 0,
      appId: scope.appId,
      appTitle: scope.appTitle,
      projectPath: scope.projectPath,
      cwd: scope.cwd,
      bucket: `web-panel:${scope.instanceId}`,
      availableSkills: [...scope.availableSkills],
    };
    const instance = {
      scope: { ...scope },
      owner,
      running: new Map(),
      approvals: new Map(),
      cancelledSessions: new Set(),
      closed: false,
    } as Instance;
    const runtime: PanelAgentTaskRuntime = {
      run: async (input) => {
        await assertAuthorized(instance);
        if (
          [...instances.values()].reduce((n, item) => n + item.running.size, 0) >=
          (options.maxConcurrentTasks ?? 4)
        )
          throw new Error("Too many active panel tasks; wait for a task to finish");
        const catalog = await models(scope.cwd);
        await assertAuthorized(instance);
        if (instance.cancelledSessions.has(input.sessionId)) throw new Error("Task cancelled");
        if (
          [...instances.values()].reduce((n, item) => n + item.running.size, 0) >=
          (options.maxConcurrentTasks ?? 4)
        )
          throw new Error("Too many active panel tasks; wait for a task to finish");
        const model = input.model ?? catalog.defaultModel;
        if (!model || !catalog.models.some((item) => item.id === model))
          throw new Error("请先在设置中配置并选择可用的默认模型。");
        const entryPath =
          options.workerEntryPath ??
          createRequire(import.meta.url).resolve("@cjhyy/code-shell-core/bin/agent-server-stdio");
        const running = {
          taskId: input.taskId,
          sessionId: input.sessionId,
          cancelled: false,
        } as RunningTask;
        running.bridge = new WorkerBridgeCore({
          entryPath,
          execPath: options.execPath,
          fallbackCwd: () => scope.cwd,
          buildEnv:
            options.buildEnv ??
            (() => ({
              ...process.env,
              CODE_SHELL_CREDENTIAL_ACCESS: "local",
              CODE_SHELL_CAPABILITY_MODULES: `${import.meta.resolve("@cjhyy/code-shell-capability-coding")}#createCodingModule`,
            })),
          onWorkerStarted: ({ pid }) => {
            running.pid = pid;
          },
        });
        instance.running.set(input.sessionId, running);
        let latestError = "";
        const unsubscribe = running.bridge.subscribeLines((line) => {
          let message: any;
          try {
            message = JSON.parse(line);
          } catch {
            return;
          }
          if (message.params?.sessionId !== input.sessionId) return;
          if (message.method === "agent/approvalRequest") {
            void handleWorkerApproval(instance, running, message.params).catch(() =>
              stopWorker(running),
            );
          } else if (message.method === "agent/approvalResolved") {
            instance.approvals.delete(message.params.requestId);
            void deliver(instance, "agent.task.approvalResolved", {
              taskId: input.taskId,
              requestId: message.params.requestId,
            });
          } else if (message.method === "agent/streamEvent") {
            const event = message.params.event ?? {};
            if (event.type === "error") latestError = String(event.error || "Task failed");
            const update = progressFromEvent(event);
            if (update) input.onProgress(update);
          }
        });
        try {
          await assertAuthorized(instance);
          if (running.cancelled) throw new Error("Task cancelled");
          running.bridge.ensureWorker(scope.cwd);
          const result = outcomeResult(
            await rpc(
              running,
              "agent/run",
              {
                sessionId: input.sessionId,
                cwd: scope.cwd,
                bucket: owner.bucket,
                task: input.prompt,
                displayText: input.label,
                clientMessageId: `panel-task:${scope.appId}:${input.sessionId}`,
                behaviorMode: "isolatedTask",
                ephemeral: true,
                permissionMode: "default",
                model,
                toolAllowlist: input.toolNames,
                skillAllowlist: input.skillNames,
                maxTurns: input.maxTurns,
                maxContextTokens: input.maxContextTokens,
              },
              options.runTimeoutMs ?? 30 * 60 * 1000,
            ),
          ) as any;
          await assertAuthorized(instance);
          return {
            text: typeof result?.text === "string" ? result.text : "",
            reason: typeof result?.reason === "string" ? result.reason : "model_error",
            ...(latestError ? { error: latestError } : {}),
            ...(result?.usage &&
            ["promptTokens", "completionTokens", "totalTokens"].every((key) =>
              Number.isFinite(result.usage[key]),
            )
              ? { usage: result.usage }
              : {}),
          };
        } finally {
          unsubscribe();
          stopWorker(running);
          instance.running.delete(input.sessionId);
        }
      },
      cancel: async (sessionId) => {
        instance.cancelledSessions.add(sessionId);
        const running = instance.running.get(sessionId);
        if (!running) return;
        running.cancelled = true;
        try {
          await rpc(running, "agent/cancel", { sessionId }, 1_000);
        } finally {
          stopWorker(running);
        }
      },
      close: async (sessionId) => {
        instance.cancelledSessions.delete(sessionId);
        const running = instance.running.get(sessionId);
        if (running) stopWorker(running);
        instance.running.delete(sessionId);
        for (const [id, approval] of instance.approvals)
          if (approval.sessionId === sessionId) instance.approvals.delete(id);
      },
      rebind: () => {},
    };
    instance.service = new PanelAppAgentTaskService(runtime, (_owner, task) => {
      void deliver(instance, "agent.task.changed", task);
    });
    let checking = false;
    instance.timer = setInterval(() => {
      if (checking) return;
      checking = true;
      void assertAuthorized(instance)
        .catch(() => {})
        .finally(() => {
          checking = false;
        });
    }, options.authorizationPollMs ?? 1_000);
    instance.timer.unref();
    instances.set(scope.instanceId, instance);
    return instance;
  }

  return {
    async call(scope: PanelAgentTaskScope, method: string, params?: unknown): Promise<unknown> {
      const instance = getInstance(scope);
      await assertAuthorized(instance);
      if (method === "agent.task.models" || method === "agent.models") {
        const result = await models(scope.cwd);
        await assertAuthorized(instance);
        return result;
      }
      if (method === "agent.task.start") {
        const raw = (params ?? {}) as PanelAgentTaskStartInput;
        if (Array.isArray(raw.toolNames) && raw.toolNames.some((tool) => !TASK_TOOLS.has(tool)))
          throw new Error("A requested tool is unavailable to Panel App tasks");
        const alreadyRunning =
          typeof raw.key === "string" &&
          instance.service
            .list(instance.owner)
            .some(
              (task) =>
                task.key === raw.key && ["queued", "running", "cancelling"].includes(task.status),
            );
        if (!alreadyRunning && activeTaskCount() >= (options.maxConcurrentTasks ?? 4))
          throw new Error("Too many active panel tasks; wait for a task to finish");
        return instance.service.start(instance.owner, raw);
      }
      if (method === "agent.task.list") return instance.service.list(instance.owner);
      if (method === "agent.task.get")
        return instance.service.get(instance.owner, (params as any)?.id);
      if (method === "agent.task.cancel") {
        const result = await instance.service.cancel(instance.owner, (params as any)?.id);
        await assertAuthorized(instance);
        return result;
      }
      // Host-private: never expose this method to an iframe's allowed SDK methods.
      if (method === "agent.task.approvalRespond") {
        const input = params as { taskId?: unknown; requestId?: unknown; approved?: unknown };
        const pending =
          typeof input?.requestId === "string"
            ? instance.approvals.get(input.requestId)
            : undefined;
        if (
          !pending ||
          pending.settling ||
          pending.taskId !== input.taskId ||
          typeof input.approved !== "boolean"
        )
          throw new Error("Task approval is unavailable or already answered");
        const running = instance.running.get(pending.sessionId);
        if (!running || running.cancelled) throw new Error("Task is no longer running");
        pending.settling = true;
        try {
          outcomeResult(
            await rpc(running, "agent/approve", {
              sessionId: pending.sessionId,
              requestId: pending.id,
              connectionId: pending.connectionId,
              generation: pending.generation,
              decision: input.approved
                ? { approved: true, scope: "once" }
                : { approved: false, reason: "Declined by user" },
            }),
          );
          instance.approvals.delete(pending.id);
          await assertAuthorized(instance);
          return true;
        } catch (error) {
          pending.settling = false;
          throw error;
        }
      }
      throw new Error(`Panel App task method is unsupported: ${method}`);
    },
    revokeInstance,
    close(): void {
      for (const id of instances.keys()) revokeInstance(id);
      closed = true;
    },
    activeTaskCount,
  };
}

export type PanelAgentTaskHost = ReturnType<typeof createPanelAgentTaskHost>;
