/**
 * AgentServer — wraps ChatSessionManager and exposes it over the protocol.
 *
 * Responsibilities:
 *   - Handles RPC requests from the client (run, approve, cancel, configure, query)
 *   - Forwards StreamEvents to the client as notifications with sessionId envelope
 *   - Manages per-session approval flow
 *   - Dispatches agent/run through ChatSessionManager so multiple sessions
 *     run concurrently without cross-talk
 *
 * Backward compat: an optional `engine` can be supplied for global operations
 * (model list, config reads/writes, tool registry queries, etc.) that don't
 * yet have a natural "which session" answer. When not supplied the server
 * falls back to borrowing any live session's engine for those reads.
 */

import type { Transport } from "./transport.js";
import {
  type RpcRequest,
  type RunParams,
  type RunResult,
  type ApproveParams,
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
import type { ApprovalRequest, ApprovalResult, PermissionMode, StreamEvent } from "../types.js";
import { setInteractiveApprovalFn } from "../tool-system/permission.js";
import { getArenaStatus } from "../tool-system/builtin/arena.js";
import { nanoid } from "nanoid";
import type { ChatSessionManager } from "./chat-session-manager.js";

export interface AgentServerOptions {
  /**
   * Multi-session manager. Required for the new multi-session protocol.
   * When present, agent/run dispatches through the manager.
   */
  chatManager?: ChatSessionManager;
  /**
   * Legacy single-engine mode. When chatManager is not supplied the server
   * falls back to the old single-engine behaviour (backwards compat for
   * createInProcessClient and agent-server-stdio until T11).
   */
  engine?: Engine;
  transport: Transport;
}

export class AgentServer {
  private readonly chatManager: ChatSessionManager | null;
  private readonly legacyEngine: Engine | null;
  private transport: Transport;

  // ── Legacy single-engine state (used when chatManager is null) ──
  private running = false;
  private abortController: AbortController | null = null;
  /** Pending approval requests: requestId → resolve function (legacy path) */
  private pendingApprovals = new Map<string, (result: ApprovalResult) => void>();
  /** Timers for approval timeouts */
  private approvalTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Default approval timeout: 5 minutes */
  private static readonly APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

  constructor(options: AgentServerOptions) {
    this.chatManager = options.chatManager ?? null;
    this.legacyEngine = options.engine ?? null;

    if (!this.chatManager && !this.legacyEngine) {
      throw new Error("AgentServer: either chatManager or engine must be supplied");
    }

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

    // Wire approval flow for the legacy single-engine path.
    // In the chatManager path approval flows are per-session and registered
    // when the session's engine raises an approval request via onStream.
    if (this.legacyEngine) {
      setInteractiveApprovalFn((request: ApprovalRequest) => {
        return this.requestApprovalFromClient(request);
      });

      this.legacyEngine.setAskUser((question, opts) => {
        return this.requestAskUserFromClient(question, opts);
      });
    }

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
        await this.handleQuery(req);
        break;
      case Methods.Inject:
        this.handleInject(req);
        break;
      case Methods.CloseSession:
        this.handleCloseSession(req);
        break;
      default:
        this.transport.send(
          createErrorResponse(req.id, ErrorCodes.MethodNotFound, `Unknown method: ${req.method}`),
        );
    }
  }

  // ─── Run ────────────────────────────────────────────────────────

  private async handleRun(req: RpcRequest): Promise<void> {
    // ── ChatSessionManager path (multi-session) ──────────────────
    if (this.chatManager) {
      return this.handleRunMulti(req);
    }
    // ── Legacy single-engine path ────────────────────────────────
    return this.handleRunLegacy(req);
  }

  private async handleRunMulti(req: RpcRequest): Promise<void> {
    const cm = this.chatManager!;
    const params = (req.params ?? {}) as unknown as RunParams;

    if (typeof params.sessionId !== "string" || params.sessionId.length === 0) {
      this.transport.send(
        createErrorResponse(req.id, ErrorCodes.InvalidParams, "sessionId is required"),
      );
      return;
    }
    if (!params.task) {
      this.transport.send(
        createErrorResponse(req.id, ErrorCodes.InvalidParams, "task is required"),
      );
      return;
    }

    let session;
    try {
      session = cm.getOrCreate(params.sessionId, {
        permissionMode: params.permissionMode,
        cwd: params.cwd,
      } as any);
    } catch (err: any) {
      const code = err.code ?? ErrorCodes.InternalError;
      this.transport.send(createErrorResponse(req.id, code, err.message));
      return;
    }

    if (typeof params.planMode === "boolean") {
      session.engine.setPlanMode(params.planMode);
    }

    const sid = params.sessionId;
    try {
      const result = await session.enqueueTurn(params.task, {
        cwd: params.cwd,
        onStream: (event: StreamEvent) =>
          this.notify(Methods.StreamEvent, { sessionId: sid, event }),
      });

      const runResult: RunResult = {
        text: result.text,
        reason: result.reason,
        sessionId: result.sessionId ?? sid,
        turnCount: result.turnCount,
        usage: result.usage,
      };
      this.transport.send(createResponse(req.id, runResult));
    } catch (err) {
      this.transport.send(
        createErrorResponse(req.id, ErrorCodes.InternalError, (err as Error).message),
      );
    }
  }

  private async handleRunLegacy(req: RpcRequest): Promise<void> {
    if (this.running) {
      this.transport.send(
        createErrorResponse(req.id, ErrorCodes.Overloaded, "Agent is already running"),
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
    if (params.cwd !== undefined && (typeof params.cwd !== "string" || params.cwd.length === 0)) {
      this.transport.send(
        createErrorResponse(req.id, ErrorCodes.InvalidParams, "cwd must be a non-empty string"),
      );
      return;
    }

    if (params.permissionMode !== undefined) {
      const mode = params.permissionMode;
      if (!isValidPermissionMode(mode)) {
        this.transport.send(
          createErrorResponse(req.id, ErrorCodes.InvalidParams, `invalid permission mode: ${mode}`),
        );
        return;
      }
      this.legacyEngine!.setPermissionMode(mode);
      // setRuntimeBypass / setInPlanMode singletons were removed in T4/T5;
      // Engine.setPermissionMode now keeps this.permissionMode + this.planMode
      // in sync and tools read them via ToolContext.permissionMode/planMode.
    }

    this.running = true;
    this.abortController = new AbortController();
    this.notify(Methods.Status, { status: "running" });

    const streamToClient = (event: StreamEvent) => {
      this.notify(Methods.StreamEvent, { sessionId: params.sessionId ?? "", event });
    };

    // TodoWrite emits task_update directly through ToolContext.streamCallback;
    // no module singleton wiring needed anymore.

    try {
      const result = await this.legacyEngine!.run(params.task, {
        cwd: params.cwd,
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
      this.running = false;
      this.abortController = null;
      this.notify(Methods.Status, { status: "ready" });
    }
  }

  // ─── Approve ────────────────────────────────────────────────────

  private handleApprove(req: RpcRequest): void {
    const params = (req.params ?? {}) as unknown as ApproveParams;

    // ChatSessionManager path: look up per-session pendingApprovals
    if (this.chatManager && typeof params.sessionId === "string") {
      const s = this.chatManager.get(params.sessionId);
      if (!s) {
        this.transport.send(
          createErrorResponse(
            req.id,
            ErrorCodes.SessionClosed,
            `No such session: ${params.sessionId}`,
          ),
        );
        return;
      }
      const resolve = s.pendingApprovals.get(params.requestId);
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
      s.pendingApprovals.delete(params.requestId);
      resolve(params.decision);
      this.transport.send(createResponse(req.id, { ok: true }));
      return;
    }

    // Legacy path
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
    const params = (req.params ?? {}) as unknown as import("./types.js").CancelParams;

    // ChatSessionManager path: cancel a specific session
    if (this.chatManager) {
      if (typeof params.sessionId !== "string" || params.sessionId.length === 0) {
        this.transport.send(
          createErrorResponse(req.id, ErrorCodes.InvalidParams, "sessionId is required"),
        );
        return;
      }
      const s = this.chatManager.get(params.sessionId);
      if (!s) {
        this.transport.send(
          createErrorResponse(
            req.id,
            ErrorCodes.SessionClosed,
            `No such session: ${params.sessionId}`,
          ),
        );
        return;
      }
      s.cancel();
      this.transport.send(createResponse(req.id, { ok: true }));
      return;
    }

    // Legacy path
    if (!this.running || !this.abortController) {
      this.transport.send(
        createErrorResponse(req.id, ErrorCodes.SessionClosed, "Agent is not running"),
      );
      return;
    }

    this.abortController.abort();

    for (const [, resolve] of this.pendingApprovals) {
      resolve({ approved: false, reason: "cancelled" });
    }
    this.pendingApprovals.clear();
    this.clearAllApprovalTimers();

    this.transport.send(createResponse(req.id, { ok: true }));
  }

  // ─── CloseSession ───────────────────────────────────────────────

  private handleCloseSession(req: RpcRequest): void {
    const params = (req.params ?? {}) as unknown as import("./types.js").CloseSessionParams;
    if (typeof params.sessionId !== "string" || params.sessionId.length === 0) {
      this.transport.send(
        createErrorResponse(req.id, ErrorCodes.InvalidParams, "sessionId is required"),
      );
      return;
    }
    if (this.chatManager) {
      this.chatManager.close(params.sessionId);
    }
    this.transport.send(createResponse(req.id, { ok: true }));
  }

  // ─── Configure ──────────────────────────────────────────────────

  private handleConfigure(req: RpcRequest): void {
    const params = (req.params ?? {}) as unknown as ConfigureParams;

    // If a sessionId is present, mutate that specific session's engine
    if (this.chatManager && typeof params.sessionId === "string") {
      const sid = params.sessionId;
      const s = this.chatManager.get(sid);
      if (!s) {
        this.transport.send(
          createErrorResponse(req.id, ErrorCodes.SessionClosed, `No such session: ${sid}`),
        );
        return;
      }
      if (typeof params.planMode === "boolean") s.engine.setPlanMode(params.planMode);
      if (typeof params.permissionMode === "string") {
        s.engine.setPermissionMode(params.permissionMode as NonNullable<EngineConfig["permissionMode"]>);
      }
      this.transport.send(createResponse(req.id, { ok: true }));
      return;
    }

    // Global configure — delegate to legacyEngine if available,
    // or to any session's engine from chatManager for settings ops
    const engine = this.legacyEngine ?? this.anyEngine();

    if (params.reloadModels && engine) {
      try {
        engine.reloadModelPool();
      } catch (err) {
        this.transport.send(
          createErrorResponse(req.id, ErrorCodes.InternalError, (err as Error).message),
        );
        return;
      }
    }
    if (params.model !== undefined && engine) {
      try {
        const entry = engine.switchModel(params.model);
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
    if (params.planMode !== undefined && engine) {
      engine.setPlanMode(params.planMode);
    }

    this.transport.send(createResponse(req.id, { ok: true }));
  }

  // ─── Query ──────────────────────────────────────────────────────

  private async handleQuery(req: RpcRequest): Promise<void> {
    const params = (req.params ?? {}) as unknown as QueryParams;
    // For query operations we prefer the legacyEngine; if absent borrow any
    // session engine from the manager (model pool, settings are shared).
    const engine = this.legacyEngine ?? this.anyEngine();

    switch (params.type) {
      case "tools": {
        if (!engine) {
          this.transport.send(
            createErrorResponse(req.id, ErrorCodes.InternalError, "No engine available for tools query"),
          );
          return;
        }
        const registry = engine.getToolRegistry();
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
        if (this.chatManager) {
          // Return the ChatSessionManager's live sessions
          const sessions = [...(this.chatManager as any).sessions.entries()].map(
            ([id, s]: [string, any]) => ({
              sessionId: id,
              busy: s.isBusy(),
              queueDepth: s.queueDepth(),
              lastActivityAt: s.lastActivityAt,
            }),
          );
          this.transport.send(createResponse(req.id, { type: "sessions", data: sessions }));
        } else if (engine) {
          const sessions = engine.getSessionManager().list();
          this.transport.send(createResponse(req.id, { type: "sessions", data: sessions }));
        } else {
          this.transport.send(createResponse(req.id, { type: "sessions", data: [] }));
        }
        break;
      }
      case "config": {
        if (!engine) {
          this.transport.send(
            createErrorResponse(req.id, ErrorCodes.InternalError, "No engine available for config query"),
          );
          return;
        }
        const config = engine.getConfig();
        this.transport.send(
          createResponse(req.id, {
            type: "config",
            data: {
              permissionMode: config.permissionMode ?? "default",
              planMode: engine.planMode ?? false,
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
        if (!engine) {
          this.transport.send(
            createErrorResponse(req.id, ErrorCodes.InternalError, "No engine available for session_detail query"),
          );
          return;
        }
        if (params.sessionId) {
          try {
            const bundle = engine.getSessionManager().resume(params.sessionId);
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
        if (!engine) {
          this.transport.send(
            createErrorResponse(req.id, ErrorCodes.InternalError, "No engine available for compact query"),
          );
          return;
        }
        try {
          const result = engine.forceCompact();
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
        if (!engine) {
          this.transport.send(
            createErrorResponse(req.id, ErrorCodes.InternalError, "No engine available for models query"),
          );
          return;
        }
        const pool = engine.getModelPool();
        const models: import("./types.js").ProtocolModelEntry[] = pool.list().map((m) => ({
          key: m.key,
          label: m.label ?? m.key,
          model: m.model,
          protocol: m.provider,
          providerKey: m.providerKey,
          active: m.key === pool.getActiveKey(),
          maxOutputTokens: m.maxOutputTokens,
          maxContextTokens: m.maxContextTokens,
        }));
        this.transport.send(createResponse(req.id, { type: "models", data: models }));
        break;
      }
      case "providers": {
        if (!engine) {
          this.transport.send(
            createErrorResponse(req.id, ErrorCodes.InternalError, "No engine available for providers query"),
          );
          return;
        }
        try {
          const providersRaw = engine.readSetting("providers") as unknown;
          const modelsRaw = engine.readSetting("models") as unknown;
          const providerList = Array.isArray(providersRaw)
            ? (providersRaw as Array<Record<string, unknown>>)
            : [];
          const modelsList = Array.isArray(modelsRaw)
            ? (modelsRaw as Array<Record<string, unknown>>)
            : [];
          const counts = new Map<string, number>();
          for (const m of modelsList) {
            const pk = typeof m.providerKey === "string" ? m.providerKey : "";
            if (!pk) continue;
            counts.set(pk, (counts.get(pk) ?? 0) + 1);
          }
          const { readCache } = await import("../llm/model-cache.js");
          const { defaultCacheDir } = await import("../llm/model-cache.js");
          const cacheDir = defaultCacheDir();
          const enriched = providerList.map((p) => {
            const key = typeof p.key === "string" ? p.key : "";
            const cache = key ? readCache(cacheDir, key) : undefined;
            return {
              ...p,
              modelCount: counts.get(key) ?? 0,
              cachedModels: cache ? cache.models.length : undefined,
              cachedAt: cache ? cache.fetchedAt : undefined,
            };
          });
          this.transport.send(createResponse(req.id, { type: "providers", data: enriched }));
        } catch (err) {
          this.transport.send(
            createErrorResponse(req.id, ErrorCodes.InternalError, (err as Error).message),
          );
        }
        break;
      }
      case "arena_status": {
        const status = getArenaStatus();
        this.transport.send(createResponse(req.id, { type: "arena_status", data: status }));
        break;
      }
      case "config_set": {
        if (!engine) {
          this.transport.send(
            createErrorResponse(req.id, ErrorCodes.InternalError, "No engine available for config_set"),
          );
          return;
        }
        try {
          const { key, value } = params;
          if (!key) throw new Error("key is required for config_set");
          engine.updateConfig(key, value);
          this.transport.send(createResponse(req.id, { type: "config_set", data: { key, value } }));
        } catch (err) {
          this.transport.send(
            createErrorResponse(req.id, ErrorCodes.InternalError, (err as Error).message),
          );
        }
        break;
      }
      case "config_get": {
        if (!engine) {
          this.transport.send(
            createErrorResponse(req.id, ErrorCodes.InternalError, "No engine available for config_get"),
          );
          return;
        }
        try {
          const { key } = params;
          if (!key) throw new Error("key is required for config_get");
          const value = engine.readSetting(key);
          this.transport.send(createResponse(req.id, { type: "config_get", data: { key, value } }));
        } catch (err) {
          this.transport.send(
            createErrorResponse(req.id, ErrorCodes.InternalError, (err as Error).message),
          );
        }
        break;
      }
      case "permission_set": {
        if (!engine) {
          this.transport.send(
            createErrorResponse(req.id, ErrorCodes.InternalError, "No engine available for permission_set"),
          );
          return;
        }
        try {
          const value = params.value as string | undefined;
          const valid = ["default", "acceptEdits", "dontAsk", "bypassPermissions", "auto", "plan"];
          if (!value || !valid.includes(value)) {
            throw new Error(`invalid permission mode: ${value}`);
          }
          engine.setPermissionMode(value as NonNullable<EngineConfig["permissionMode"]>);
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
      case "provider_add": {
        if (!engine) {
          this.transport.send(
            createErrorResponse(req.id, ErrorCodes.InternalError, "No engine available for provider_add"),
          );
          return;
        }
        try {
          const cfg = params.provider as Record<string, unknown> | undefined;
          if (
            !cfg ||
            typeof cfg.key !== "string" ||
            typeof cfg.kind !== "string" ||
            typeof cfg.baseUrl !== "string"
          ) {
            throw new Error("provider_add: requires {key, kind, baseUrl, ...}");
          }
          const current = (engine.readSetting("providers") as unknown[] | undefined) ?? [];
          const next = [...current, cfg];
          engine.updateConfig("providers", next);
          this.transport.send(
            createResponse(req.id, { type: "provider_add", data: { ok: true, key: cfg.key } }),
          );
        } catch (err) {
          this.transport.send(
            createErrorResponse(req.id, ErrorCodes.InternalError, (err as Error).message),
          );
        }
        break;
      }
      case "provider_refresh": {
        if (!engine) {
          this.transport.send(
            createErrorResponse(req.id, ErrorCodes.InternalError, "No engine available for provider_refresh"),
          );
          return;
        }
        try {
          const key = params.key;
          if (!key) throw new Error("provider_refresh: key required");
          const providers =
            (engine.readSetting("providers") as Array<Record<string, unknown>> | undefined) ??
            [];
          const p = providers.find((x) => x.key === key);
          if (!p) throw new Error(`provider not found: ${key}`);
          const { fetchModelList } = await import("../llm/model-fetcher.js");
          const { defaultCacheDir } = await import("../llm/model-cache.js");
          const res = await fetchModelList(
            {
              key: p.key as string,
              kind: p.kind as never,
              baseUrl: p.baseUrl as string,
              apiKey: p.apiKey as string | undefined,
            },
            { cacheDir: defaultCacheDir(), refresh: true },
          );
          this.transport.send(
            createResponse(req.id, {
              type: "provider_refresh",
              data: { count: res.models.length, error: res.error },
            }),
          );
        } catch (err) {
          this.transport.send(
            createErrorResponse(req.id, ErrorCodes.InternalError, (err as Error).message),
          );
        }
        break;
      }
      case "provider_delete": {
        if (!engine) {
          this.transport.send(
            createErrorResponse(req.id, ErrorCodes.InternalError, "No engine available for provider_delete"),
          );
          return;
        }
        try {
          const key = params.key;
          if (!key) throw new Error("provider_delete: key required");
          const models =
            (engine.readSetting("models") as Array<Record<string, unknown>> | undefined) ?? [];
          const refs = models.filter((m) => m.providerKey === key).map((m) => m.key as string);
          if (refs.length > 0) {
            throw new Error(`provider ${key} referenced by models: ${refs.join(", ")}`);
          }
          const providers =
            (engine.readSetting("providers") as Array<Record<string, unknown>> | undefined) ??
            [];
          const next = providers.filter((p) => p.key !== key);
          engine.updateConfig("providers", next);
          this.transport.send(
            createResponse(req.id, { type: "provider_delete", data: { ok: true } }),
          );
        } catch (err) {
          this.transport.send(
            createErrorResponse(req.id, ErrorCodes.InternalError, (err as Error).message),
          );
        }
        break;
      }
      case "model_add": {
        if (!engine) {
          this.transport.send(
            createErrorResponse(req.id, ErrorCodes.InternalError, "No engine available for model_add"),
          );
          return;
        }
        try {
          const entry = params.model as Record<string, unknown> | undefined;
          if (!entry || typeof entry.key !== "string" || typeof entry.model !== "string") {
            throw new Error("model_add: requires {key, model, providerKey}");
          }
          const current = (engine.readSetting("models") as unknown[] | undefined) ?? [];
          const next = [...current, entry];
          engine.updateConfig("models", next);
          this.transport.send(
            createResponse(req.id, { type: "model_add", data: { ok: true, key: entry.key } }),
          );
        } catch (err) {
          this.transport.send(
            createErrorResponse(req.id, ErrorCodes.InternalError, (err as Error).message),
          );
        }
        break;
      }
      case "model_delete": {
        if (!engine) {
          this.transport.send(
            createErrorResponse(req.id, ErrorCodes.InternalError, "No engine available for model_delete"),
          );
          return;
        }
        try {
          const key = params.key;
          if (!key) throw new Error("model_delete: key required");
          const current =
            (engine.readSetting("models") as Array<Record<string, unknown>> | undefined) ?? [];
          const next = current.filter((m) => m.key !== key);
          engine.updateConfig("models", next);
          this.transport.send(
            createResponse(req.id, { type: "model_delete", data: { ok: true } }),
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
    // In the chatManager path, inject into the session's engine
    if (this.chatManager) {
      const s = this.chatManager.get(params.sessionId);
      if (!s) {
        this.transport.send(
          createErrorResponse(
            req.id,
            ErrorCodes.SessionClosed,
            `No such session: ${params.sessionId}`,
          ),
        );
        return;
      }
      try {
        s.engine.injectContext(params.sessionId, params.content);
        this.transport.send(createResponse(req.id, { ok: true }));
      } catch (err) {
        this.transport.send(
          createErrorResponse(req.id, ErrorCodes.InternalError, (err as Error).message),
        );
      }
      return;
    }
    try {
      this.legacyEngine!.injectContext(params.sessionId, params.content);
      this.transport.send(createResponse(req.id, { ok: true }));
    } catch (err) {
      this.transport.send(
        createErrorResponse(req.id, ErrorCodes.InternalError, (err as Error).message),
      );
    }
  }

  // ─── Client Communication ───────────────────────────────────────

  /**
   * Ask the client to approve a tool operation (legacy single-engine path).
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
   * Ask the client to answer a question from the agent (legacy single-engine path).
   */
  private requestAskUserFromClient(
    question: string,
    opts?: import("../tool-system/context.js").AskUserOptions,
  ): Promise<string> {
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

      const args: Record<string, unknown> = { question };
      if (opts?.header !== undefined) args.header = opts.header;
      if (opts?.options !== undefined) args.options = opts.options;
      if (opts?.multiSelect !== undefined) args.multiSelect = opts.multiSelect;

      this.notify(Methods.ApprovalRequest, {
        requestId,
        request: {
          toolName: "__ask_user__",
          args,
          description: question,
          riskLevel: "low" as const,
        },
      });
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.transport.send(createNotification(method, params));
  }

  /**
   * Get any available engine — used for global query ops when chatManager is
   * present but no legacyEngine was supplied. Borrows the first live session.
   */
  private anyEngine(): Engine | null {
    if (!this.chatManager) return null;
    // Access private `sessions` map — acceptable for same-package access.
    const sessions: Map<string, any> = (this.chatManager as any).sessions;
    const first = sessions.values().next().value;
    return first ? (first.engine as Engine) : null;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────

  close(): void {
    if (this.chatManager) {
      this.chatManager.closeAll();
    }

    // Legacy path cleanup
    if (this.abortController) {
      try {
        this.abortController.abort("server closing");
      } catch {
        // swallow
      }
    }

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

function isValidPermissionMode(value: unknown): value is PermissionMode {
  return (
    value === "default" ||
    value === "acceptEdits" ||
    value === "dontAsk" ||
    value === "bypassPermissions" ||
    value === "auto" ||
    value === "plan"
  );
}
