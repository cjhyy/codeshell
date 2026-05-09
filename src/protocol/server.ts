/**
 * AgentServer — wraps Engine and exposes it over the protocol.
 *
 * Responsibilities:
 *   - Handles RPC requests from the client (run, approve, cancel, configure, query)
 *   - Forwards StreamEvents to the client as notifications
 *   - Manages approval flow: engine → server → client → server → engine
 *   - Owns all mutable runtime state (plan mode, bypass, etc.)
 */

import type { Transport } from "./transport.js";
import {
  type RpcRequest,
  type RunParams,
  type RunResult,
  type ApproveParams,
  type CancelParams,
  type ConfigureParams,
  type QueryParams,
  type InjectParams,
  Methods,
  ErrorCodes,
  createResponse,
  createErrorResponse,
  createNotification,
  isRequest,
} from "./types.js";
import type { Engine, EngineConfig } from "../engine/engine.js";
import type { ApprovalRequest, ApprovalResult, StreamEvent } from "../types.js";
import { setInPlanMode, isInPlanMode } from "../tool-system/builtin/plan.js";
import { setRuntimeBypass, isRuntimeBypass } from "../tool-system/permission.js";
import { setInteractiveApprovalFn } from "../tool-system/permission.js";
import { getArenaStatus } from "../tool-system/builtin/arena.js";
import { taskManager } from "../tool-system/builtin/task.js";
import { nanoid } from "nanoid";

export interface AgentServerOptions {
  engine: Engine;
  transport: Transport;
}

export class AgentServer {
  private engine: Engine;
  private transport: Transport;
  private running = false;
  private abortController: AbortController | null = null;

  /** Pending approval requests: requestId → resolve function */
  private pendingApprovals = new Map<string, (result: ApprovalResult) => void>();
  /** Timers for approval timeouts */
  private approvalTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Default approval timeout: 5 minutes */
  private static readonly APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

  constructor(options: AgentServerOptions) {
    this.engine = options.engine;
    this.transport = options.transport;

    // Wire up incoming messages
    this.transport.onMessage((msg) => {
      if (isRequest(msg)) {
        this.handleRequest(msg).catch((err) => {
          this.transport.send(
            createErrorResponse(msg.id, ErrorCodes.InternalError, (err as Error).message),
          );
        });
      }
    });

    // Wire approval flow: engine asks server, server asks client
    setInteractiveApprovalFn((request: ApprovalRequest) => {
      return this.requestApprovalFromClient(request);
    });

    // Wire askUser: install a protocol-backed askUser handler on the engine
    // (replaces the legacy setAskUserFn module singleton).
    this.engine.setAskUser((question: string) => {
      return this.requestAskUserFromClient(question);
    });

    // Notify client we're ready
    this.notify(Methods.Status, { status: "ready" });
  }

  // ─── Request Dispatch ───────────────────────────────────────────

  private async handleRequest(req: RpcRequest): Promise<void> {
    switch (req.method) {
      case Methods.Run:
        await this.handleRun(req);
        break;
      case Methods.Approve:
        this.handleApprove(req);
        break;
      case Methods.Cancel:
        this.handleCancel(req);
        break;
      case Methods.Configure:
        this.handleConfigure(req);
        break;
      case Methods.Query:
        this.handleQuery(req);
        break;
      case Methods.Inject:
        this.handleInject(req);
        break;
      default:
        this.transport.send(
          createErrorResponse(req.id, ErrorCodes.MethodNotFound, `Unknown method: ${req.method}`),
        );
    }
  }

  // ─── Run ────────────────────────────────────────────────────────

  private async handleRun(req: RpcRequest): Promise<void> {
    if (this.running) {
      this.transport.send(
        createErrorResponse(req.id, ErrorCodes.AlreadyRunning, "Agent is already running"),
      );
      return;
    }

    const params = (req.params ?? {}) as unknown as RunParams;
    if (!params.task) {
      this.transport.send(
        createErrorResponse(req.id, ErrorCodes.InvalidParams, "task is required"),
      );
      return;
    }

    this.running = true;
    this.abortController = new AbortController();
    this.notify(Methods.Status, { status: "running" });

    const streamToClient = (event: StreamEvent) => {
      this.notify(Methods.StreamEvent, { event });
    };

    // Wire the global TaskManager into this run's stream so TaskCreate /
    // TaskUpdate calls — from the main agent OR any spawned sub-agent —
    // surface as task_update events the UI's top panel listens for.
    // The manager is a module singleton, so a single registration here
    // covers nested engine.run() calls; we tear it down in finally.
    taskManager.setStreamCallback(streamToClient);

    try {
      const result = await this.engine.run(params.task, {
        sessionId: params.sessionId,
        signal: this.abortController!.signal,
        onStream: streamToClient,
      });

      const runResult: RunResult = {
        text: result.text,
        reason: result.reason,
        sessionId: result.sessionId,
        turnCount: result.turnCount,
        usage: result.usage,
      };

      this.transport.send(createResponse(req.id, runResult));
    } catch (err) {
      this.transport.send(
        createErrorResponse(req.id, ErrorCodes.InternalError, (err as Error).message),
      );
    } finally {
      taskManager.setStreamCallback(undefined);
      this.running = false;
      this.abortController = null;
      this.notify(Methods.Status, { status: "ready" });
    }
  }

  // ─── Approve ────────────────────────────────────────────────────

  private handleApprove(req: RpcRequest): void {
    const params = (req.params ?? {}) as unknown as ApproveParams;
    const resolve = this.pendingApprovals.get(params.requestId);

    if (!resolve) {
      this.transport.send(
        createErrorResponse(
          req.id,
          ErrorCodes.InvalidParams,
          `No pending approval: ${params.requestId}`,
        ),
      );
      return;
    }

    this.pendingApprovals.delete(params.requestId);
    this.clearApprovalTimer(params.requestId);
    resolve(params.decision);
    this.transport.send(createResponse(req.id, { ok: true }));
  }

  // ─── Cancel ─────────────────────────────────────────────────────

  private handleCancel(req: RpcRequest): void {
    if (!this.running || !this.abortController) {
      this.transport.send(
        createErrorResponse(req.id, ErrorCodes.NotRunning, "Agent is not running"),
      );
      return;
    }

    this.abortController.abort();

    // Reject all pending approvals
    for (const [id, resolve] of this.pendingApprovals) {
      resolve({ approved: false, reason: "cancelled" });
    }
    this.pendingApprovals.clear();
    this.clearAllApprovalTimers();

    this.transport.send(createResponse(req.id, { ok: true }));
  }

  // ─── Configure ──────────────────────────────────────────────────

  private handleConfigure(req: RpcRequest): void {
    const params = (req.params ?? {}) as unknown as ConfigureParams;

    if (params.planMode !== undefined) {
      setInPlanMode(params.planMode);
    }
    if (params.bypassPermissions !== undefined) {
      setRuntimeBypass(params.bypassPermissions);
    }
    if (params.model !== undefined) {
      try {
        const entry = this.engine.switchModel(params.model);
        this.transport.send(
          createResponse(req.id, { ok: true, model: entry.model, key: entry.key }),
        );
        return;
      } catch (err) {
        this.transport.send(
          createErrorResponse(req.id, ErrorCodes.InvalidParams, (err as Error).message),
        );
        return;
      }
    }
    // permissionMode and effort are stored but need engine-level support
    // to change mid-session — for now we accept and acknowledge

    this.transport.send(createResponse(req.id, { ok: true }));
  }

  // ─── Query ──────────────────────────────────────────────────────

  private handleQuery(req: RpcRequest): void {
    const params = (req.params ?? {}) as unknown as QueryParams;

    switch (params.type) {
      case "tools": {
        const registry = this.engine.getToolRegistry();
        // listToolsDetailed() returns objects with name/description,
        // listTools() returns just names — use detailed if available
        const tools =
          typeof registry.listToolsDetailed === "function"
            ? registry
                .listToolsDetailed()
                .map((t: any) => ({ name: t.name, description: t.description ?? "" }))
            : registry.listTools().map((name: string) => ({ name, description: "" }));
        this.transport.send(createResponse(req.id, { type: "tools", data: tools }));
        break;
      }
      case "sessions": {
        const sessions = this.engine.getSessionManager().list();
        this.transport.send(createResponse(req.id, { type: "sessions", data: sessions }));
        break;
      }
      case "config": {
        const config = this.engine.getConfig();
        this.transport.send(
          createResponse(req.id, {
            type: "config",
            data: {
              permissionMode: config.permissionMode ?? "default",
              planMode: isInPlanMode(),
              preset: config.preset,
              model: config.llm.model,
              cwd: config.cwd,
              maxContextTokens: config.maxContextTokens,
              llm: {
                provider: config.llm.provider,
                model: config.llm.model,
                apiKey: config.llm.apiKey,
                baseUrl: config.llm.baseUrl,
                temperature: config.llm.temperature,
                maxTokens: config.llm.maxTokens,
                enableStreaming: config.llm.enableStreaming,
              },
            },
          }),
        );
        break;
      }
      case "session_detail": {
        if (params.sessionId) {
          try {
            const bundle = this.engine.getSessionManager().resume(params.sessionId);
            const data = {
              state: bundle.state,
              transcript: bundle.transcript.getEvents(),
            };
            this.transport.send(createResponse(req.id, { type: "session_detail", data }));
          } catch (err) {
            this.transport.send(
              createErrorResponse(req.id, ErrorCodes.SessionNotFound, (err as Error).message),
            );
          }
        } else {
          this.transport.send(
            createErrorResponse(
              req.id,
              ErrorCodes.InvalidParams,
              "sessionId required for session_detail",
            ),
          );
        }
        break;
      }
      case "compact": {
        // Force context compaction and return stats
        try {
          const result = this.engine.forceCompact();
          this.transport.send(
            createResponse(req.id, {
              type: "compact",
              data: result,
            }),
          );
        } catch (err) {
          this.transport.send(
            createErrorResponse(req.id, ErrorCodes.InternalError, (err as Error).message),
          );
        }
        break;
      }
      case "models": {
        const pool = this.engine.getModelPool();
        const models: import("./types.js").ProtocolModelEntry[] = pool.list().map((m) => ({
          key: m.key,
          label: m.label ?? m.key,
          model: m.model,
          provider: m.provider,
          active: m.key === pool.getActiveKey(),
        }));
        this.transport.send(createResponse(req.id, { type: "models", data: models }));
        break;
      }
      case "arena_status": {
        // Returns what Arena would do if invoked right now: which
        // participants it would default to, against which endpoint,
        // and whether each one looks compatible.
        const status = getArenaStatus();
        this.transport.send(createResponse(req.id, { type: "arena_status", data: status }));
        break;
      }
      case "config_set": {
        // Update a settings key
        try {
          const { key, value } = params;
          if (!key) throw new Error("key is required for config_set");
          this.engine.updateConfig(key, value);
          this.transport.send(createResponse(req.id, { type: "config_set", data: { key, value } }));
        } catch (err) {
          this.transport.send(
            createErrorResponse(req.id, ErrorCodes.InternalError, (err as Error).message),
          );
        }
        break;
      }
      case "config_get": {
        try {
          const { key } = params;
          if (!key) throw new Error("key is required for config_get");
          const value = this.engine.readSetting(key);
          this.transport.send(createResponse(req.id, { type: "config_get", data: { key, value } }));
        } catch (err) {
          this.transport.send(
            createErrorResponse(req.id, ErrorCodes.InternalError, (err as Error).message),
          );
        }
        break;
      }
      case "permission_set": {
        try {
          const value = params.value as string | undefined;
          const valid = ["default", "acceptEdits", "dontAsk", "bypassPermissions", "auto", "plan"];
          if (!value || !valid.includes(value)) {
            throw new Error(`invalid permission mode: ${value}`);
          }
          this.engine.setPermissionMode(value as NonNullable<EngineConfig["permissionMode"]>);
          this.transport.send(
            createResponse(req.id, {
              type: "permission_set",
              data: { mode: value },
            }),
          );
        } catch (err) {
          this.transport.send(
            createErrorResponse(req.id, ErrorCodes.InternalError, (err as Error).message),
          );
        }
        break;
      }
      default:
        this.transport.send(
          createErrorResponse(
            req.id,
            ErrorCodes.InvalidParams,
            `Unknown query type: ${params.type}`,
          ),
        );
    }
  }

  // ─── Inject ─────────────────────────────────────────────────────

  private handleInject(req: RpcRequest): void {
    const params = (req.params ?? {}) as unknown as InjectParams;
    if (!params.content || !params.sessionId) {
      this.transport.send(
        createErrorResponse(req.id, ErrorCodes.InvalidParams, "content and sessionId required"),
      );
      return;
    }
    try {
      this.engine.injectContext(params.sessionId, params.content);
      this.transport.send(createResponse(req.id, { ok: true }));
    } catch (err) {
      this.transport.send(
        createErrorResponse(req.id, ErrorCodes.InternalError, (err as Error).message),
      );
    }
  }

  // ─── Client Communication ───────────────────────────────────────

  /**
   * Ask the client to approve a tool operation.
   * Sends a notification, returns a promise that resolves when client responds.
   */
  private requestApprovalFromClient(request: ApprovalRequest): Promise<ApprovalResult> {
    return new Promise((resolve) => {
      const requestId = nanoid(12);
      this.pendingApprovals.set(requestId, resolve);

      const timer = setTimeout(() => {
        if (this.pendingApprovals.has(requestId)) {
          this.pendingApprovals.delete(requestId);
          this.approvalTimers.delete(requestId);
          resolve({ approved: false, reason: "approval timed out" });
        }
      }, AgentServer.APPROVAL_TIMEOUT_MS);
      this.approvalTimers.set(requestId, timer);

      this.notify(Methods.ApprovalRequest, { requestId, request });
    });
  }

  /**
   * Ask the client to answer a question from the agent.
   * Reuses the approval flow with a synthetic request.
   */
  private requestAskUserFromClient(question: string): Promise<string> {
    return new Promise((resolve) => {
      const requestId = nanoid(12);
      this.pendingApprovals.set(requestId, (result: ApprovalResult) => {
        this.clearApprovalTimer(requestId);
        if (result.approved) {
          resolve(result.answer ?? "");
        } else {
          resolve(result.reason ?? "(user declined to answer)");
        }
      });

      const timer = setTimeout(() => {
        if (this.pendingApprovals.has(requestId)) {
          this.pendingApprovals.delete(requestId);
          this.approvalTimers.delete(requestId);
          resolve("(approval timed out)");
        }
      }, AgentServer.APPROVAL_TIMEOUT_MS);
      this.approvalTimers.set(requestId, timer);

      this.notify(Methods.ApprovalRequest, {
        requestId,
        request: {
          toolName: "__ask_user__",
          args: { question },
          description: question,
          riskLevel: "low" as const,
        },
      });
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.transport.send(createNotification(method, params));
  }

  // ─── Lifecycle ──────────────────────────────────────────────────

  close(): void {
    // Reject pending approvals
    for (const [, resolve] of this.pendingApprovals) {
      resolve({ approved: false, reason: "server closing" });
    }
    this.pendingApprovals.clear();
    this.clearAllApprovalTimers();

    this.notify(Methods.Status, { status: "shutdown" });
    this.transport.close();
  }

  private clearApprovalTimer(requestId: string): void {
    const timer = this.approvalTimers.get(requestId);
    if (timer) {
      clearTimeout(timer);
      this.approvalTimers.delete(requestId);
    }
  }

  private clearAllApprovalTimers(): void {
    for (const timer of this.approvalTimers.values()) {
      clearTimeout(timer);
    }
    this.approvalTimers.clear();
  }
}
