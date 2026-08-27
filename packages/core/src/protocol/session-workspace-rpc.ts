import type { Engine } from "../engine/engine.js";
import type { SessionProjectBinding, SessionWorkspace } from "../types.js";
import { canonicalKey } from "../workspace/canonical-key.js";
import {
  validateWorkspaceContext,
  workspacePrimaryRoot,
  type WorkspaceContext,
} from "../workspace/workspace-context.js";
import type { ChatSession } from "./chat-session.js";
import type { ChatSessionManager, EngineConfigSlice } from "./chat-session-manager.js";
import type { Transport } from "./transport.js";
import {
  createErrorResponse,
  createResponse,
  ErrorCodes,
  type CompleteSessionMainRootMigrationParams,
  type MigrateSessionMainRootParams,
  type MigrateSessionMainRootResult,
  type ReleaseWorkspaceParams,
  type RpcRequest,
  type SetWorkspaceParams,
} from "./types.js";

interface WorkspaceEngine {
  releaseSessionWorkspace?(sessionId: string): SessionWorkspace | null;
  setSessionWorkspace?(sessionId: string, workspace: SessionWorkspace): SessionWorkspace | null;
  migrateSessionMainRoot?(
    sessionId: string,
    project: SessionProjectBinding,
    mainRoot: string,
  ): SessionWorkspace | null;
}

interface SessionWorkspaceRpcDependencies {
  transport: Transport;
  getChatManager(): ChatSessionManager | null;
  getLegacyEngine(): Engine | null;
  getLastSlice(sessionId: string): EngineConfigSlice | undefined;
  rememberSessionSlice(sessionId: string, slice: EngineConfigSlice): void;
  wireInteractiveSession(session: ChatSession, sessionId: string): void;
}

/** Protocol boundary for Session workspace ownership and root migration. */
export class SessionWorkspaceRpcHandlers {
  constructor(private readonly deps: SessionWorkspaceRpcDependencies) {}

  release(req: RpcRequest): void {
    const params = (req.params ?? {}) as unknown as ReleaseWorkspaceParams;
    if (typeof params.sessionId !== "string" || params.sessionId.length === 0) {
      this.deps.transport.send(
        createErrorResponse(req.id, ErrorCodes.InvalidParams, "sessionId is required"),
      );
      return;
    }
    const manager = this.deps.getChatManager();
    if (manager) {
      const session = manager.get(params.sessionId);
      if (!session) {
        this.deps.transport.send(createResponse(req.id, { ok: true, workspace: null }));
        return;
      }
      const workspace =
        (session.engine as WorkspaceEngine).releaseSessionWorkspace?.(params.sessionId) ?? null;
      this.deps.transport.send(createResponse(req.id, { ok: true, workspace }));
      return;
    }
    const workspace =
      (this.deps.getLegacyEngine() as WorkspaceEngine | null)?.releaseSessionWorkspace?.(
        params.sessionId,
      ) ?? null;
    this.deps.transport.send(createResponse(req.id, { ok: true, workspace }));
  }

  set(req: RpcRequest): void {
    const params = (req.params ?? {}) as unknown as SetWorkspaceParams;
    if (typeof params.sessionId !== "string" || params.sessionId.length === 0) {
      this.deps.transport.send(
        createErrorResponse(req.id, ErrorCodes.InvalidParams, "sessionId is required"),
      );
      return;
    }
    if (
      !params.workspace ||
      typeof params.workspace !== "object" ||
      typeof params.workspace.root !== "string" ||
      params.workspace.root.length === 0 ||
      (params.workspace.kind !== "main" && params.workspace.kind !== "worktree")
    ) {
      this.deps.transport.send(
        createErrorResponse(req.id, ErrorCodes.InvalidParams, "valid workspace is required"),
      );
      return;
    }
    const manager = this.deps.getChatManager();
    const engine = manager ? manager.get(params.sessionId)?.engine : this.deps.getLegacyEngine();
    if (!engine) {
      this.deps.transport.send(createResponse(req.id, { ok: true, workspace: null }));
      return;
    }
    const workspace = (engine as WorkspaceEngine).setSessionWorkspace?.(
      params.sessionId,
      params.workspace,
    );
    this.deps.transport.send(
      createResponse(req.id, {
        ok: workspace !== undefined && workspace !== null,
        workspace: workspace ?? null,
      }),
    );
  }

  async migrateMainRoot(req: RpcRequest): Promise<void> {
    const params = (req.params ?? {}) as unknown as MigrateSessionMainRootParams;
    if (!validMigrationParams(params)) {
      this.deps.transport.send(
        createErrorResponse(
          req.id,
          ErrorCodes.InvalidParams,
          "valid Session root migration is required",
        ),
      );
      return;
    }
    let workspaceContext: WorkspaceContext;
    try {
      workspaceContext = validateWorkspaceContext(params.workspaceContext);
      const primary = workspacePrimaryRoot(workspaceContext);
      if (
        workspaceContext.projectId !== params.project.projectId ||
        workspaceContext.sessionMainRootId !== params.project.mainRootId ||
        canonicalKey(primary.path) !== canonicalKey(params.mainRoot)
      ) {
        throw new Error("migration target authority does not match the requested root");
      }
    } catch (error) {
      this.deps.transport.send(
        createErrorResponse(
          req.id,
          ErrorCodes.InvalidParams,
          error instanceof Error ? error.message : "valid target authority is required",
        ),
      );
      return;
    }
    const manager = this.deps.getChatManager();
    let engine: Engine | null | undefined;
    let residentSession: ChatSession | undefined;
    if (manager) {
      const ownership = manager.beginSessionMigration(params.sessionId, params.ownershipToken);
      if (ownership.status === "not-resident") {
        this.deps.transport.send(
          createResponse(req.id, {
            status: "not-resident",
            ownershipToken: ownership.ownershipToken,
          } satisfies MigrateSessionMainRootResult),
        );
        return;
      }
      if (ownership.status === "failed") {
        this.deps.transport.send(
          createResponse(req.id, {
            status: "failed",
            error: ownership.error,
          } satisfies MigrateSessionMainRootResult),
        );
        return;
      }
      residentSession = ownership.session;
      engine = residentSession.engine;
    } else {
      engine = this.deps.getLegacyEngine();
    }
    if (!engine) {
      this.deps.transport.send(
        createResponse(req.id, {
          status: "failed",
          error: "Session migration owner is unavailable",
        } satisfies MigrateSessionMainRootResult),
      );
      return;
    }
    try {
      const workspace = residentSession
        ? await manager!.migrateResidentSessionMainRoot(params.sessionId, {
            project: params.project,
            mainRoot: params.mainRoot,
            workspaceContext,
            projectTrusted: params.projectTrusted,
          })
        : (engine as WorkspaceEngine).migrateSessionMainRoot?.(
            params.sessionId,
            params.project,
            params.mainRoot,
          );
      if (!workspace) throw new Error(`Session ${params.sessionId} migration was not committed`);
      if (residentSession) {
        this.deps.rememberSessionSlice(params.sessionId, {
          ...(this.deps.getLastSlice(params.sessionId) ?? {}),
          cwd: params.mainRoot,
          workspaceContext,
          projectTrusted: params.projectTrusted,
        } as EngineConfigSlice);
        this.deps.wireInteractiveSession(residentSession, params.sessionId);
      }
      this.deps.transport.send(
        createResponse(req.id, {
          status: "migrated",
          workspace,
        } satisfies MigrateSessionMainRootResult),
      );
    } catch (error) {
      this.deps.transport.send(
        createResponse(req.id, {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        } satisfies MigrateSessionMainRootResult),
      );
    }
  }

  completeMainRootMigration(req: RpcRequest): void {
    const params = (req.params ?? {}) as unknown as CompleteSessionMainRootMigrationParams;
    if (
      typeof params.sessionId !== "string" ||
      params.sessionId.length === 0 ||
      typeof params.ownershipToken !== "string" ||
      params.ownershipToken.length === 0 ||
      params.ownershipToken.length > 128
    ) {
      this.deps.transport.send(
        createErrorResponse(req.id, ErrorCodes.InvalidParams, "valid migration claim is required"),
      );
      return;
    }
    if (
      !this.deps.getChatManager()?.completeSessionMigration(params.sessionId, params.ownershipToken)
    ) {
      this.deps.transport.send(
        createErrorResponse(req.id, ErrorCodes.InvalidParams, "migration claim is not active"),
      );
      return;
    }
    this.deps.transport.send(createResponse(req.id, { released: true }));
  }
}

function validMigrationParams(params: MigrateSessionMainRootParams): boolean {
  return (
    typeof params.sessionId === "string" &&
    params.sessionId.length > 0 &&
    Boolean(params.project) &&
    typeof params.project?.projectId === "string" &&
    params.project.projectId.length > 0 &&
    typeof params.project.mainRootId === "string" &&
    params.project.mainRootId.length > 0 &&
    typeof params.mainRoot === "string" &&
    params.mainRoot.length > 0 &&
    typeof params.projectTrusted === "boolean" &&
    typeof params.ownershipToken === "string" &&
    params.ownershipToken.length > 0 &&
    params.ownershipToken.length <= 128
  );
}
