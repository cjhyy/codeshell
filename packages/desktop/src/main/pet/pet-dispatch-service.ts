import { createHash, randomUUID } from "node:crypto";
import type {
  PetNavigationRequest,
  PetNavigationResult,
  DesktopPetProjectionSnapshot,
} from "./pet-state-aggregator.js";
import type { PetWorkspaceOption, PetWorkDelegation } from "@cjhyy/code-shell-pet";
import type { InputAttachmentMeta } from "@cjhyy/code-shell-server";

export interface PetAutoDelegation {
  clientMessageId: string;
  task: string;
  workspacePath: string | null;
}

export type PetDispatchCommand =
  | { type: "get_global_status" }
  | { type: "list_pending" }
  | { type: "open_session"; target: PetNavigationRequest }
  | {
      type: "chat";
      message: string;
      clientMessageId?: string;
      preferredProjectPath?: string;
      attachments?: InputAttachmentMeta[];
    };

export type PetDispatchResult =
  | {
      ok: false;
      code: "unsupported-in-phase-1" | "invalid-command" | "worker-error";
      message?: string;
    }
  | {
      ok: true;
      type: "global_status";
      version: number;
      generation: number;
      observedAt: number;
      workerState: DesktopPetProjectionSnapshot["workerState"];
      petSessionId: string;
      runningCount: number;
      queuedCount: number;
      pendingCount: number;
      sessions: DesktopPetProjectionSnapshot["sessions"];
    }
  | { ok: true; type: "pending_list"; pending: DesktopPetProjectionSnapshot["pending"] }
  | { ok: true; type: "open_session"; result: PetNavigationResult }
  | {
      ok: true;
      type: "chat";
      petSessionId: string;
      result: unknown;
      delegation?: PetAutoDelegation;
    };

interface PetDispatchOptions {
  metadata: { ensure(): Promise<{ petSessionId: string }> };
  aggregator: {
    getSnapshot(): DesktopPetProjectionSnapshot;
    resolveNavigation(request: PetNavigationRequest): Promise<PetNavigationResult>;
  };
  worker: {
    requestWorker(
      method: string,
      params: Record<string, unknown>,
    ): Promise<{ ok: true; result: unknown } | { ok: false; message: string; code?: number }>;
  };
  hostCwd: string;
  listWorkspaces?(): Promise<Array<{ path: string; name: string }>>;
}

const NO_WORKSPACE_ID = "no-workspace";

function workspaceIdForPath(path: string): string {
  return `workspace-${createHash("sha256").update(path).digest("hex").slice(0, 16)}`;
}

function readPetWorkDelegation(result: unknown): PetWorkDelegation | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  // New shape: RunResult.extensions.pet.workDelegation (generic result slot);
  // legacy petWorkDelegation mirror kept as fallback for older workers.
  const extensions = (result as { extensions?: unknown }).extensions;
  const petExtension =
    extensions && typeof extensions === "object" && !Array.isArray(extensions)
      ? (extensions as { pet?: unknown }).pet
      : undefined;
  const fromExtensions =
    petExtension && typeof petExtension === "object" && !Array.isArray(petExtension)
      ? (petExtension as { workDelegation?: unknown }).workDelegation
      : undefined;
  const delegation =
    fromExtensions ?? (result as { petWorkDelegation?: unknown }).petWorkDelegation;
  if (!delegation || typeof delegation !== "object" || Array.isArray(delegation)) return null;
  const record = delegation as Record<string, unknown>;
  if (
    typeof record.workspaceId !== "string" ||
    !record.workspaceId.trim() ||
    typeof record.objective !== "string" ||
    !record.objective.trim()
  ) {
    return null;
  }
  return { workspaceId: record.workspaceId, objective: record.objective.trim() };
}

function boundedWorld(snapshot: DesktopPetProjectionSnapshot): Record<string, unknown> {
  return {
    version: snapshot.version,
    generation: snapshot.generation,
    observedAt: snapshot.observedAt,
    workerState: snapshot.workerState,
    sessions: snapshot.sessions.slice(0, 25).map((session) => ({
      agentSessionId: session.agentSessionId,
      title: session.title,
      workspace: session.workspaceDisplayName,
      runState: session.runState,
      phase: session.phase,
      summary: session.summary,
      queueDepth: session.queueDepth,
      pendingDecisionCount: session.pendingDecisionCount,
      observedAt: session.freshness.observedAt,
    })),
    pending: snapshot.pending
      .filter((pending) => pending.status === "pending")
      .slice(0, 25)
      .map((pending) => ({
        agentSessionId: pending.agentSessionId,
        kind: pending.kind,
        title: pending.kind === "ask_user" ? "需要用户回答" : pending.title,
        toolName: pending.toolName,
        riskLevel: pending.riskLevel,
        createdAt: pending.createdAt,
      })),
  };
}

export class PetDispatchService {
  constructor(private readonly options: PetDispatchOptions) {}

  async getSessionId(): Promise<string> {
    return (await this.options.metadata.ensure()).petSessionId;
  }

  async dispatch(command: PetDispatchCommand): Promise<PetDispatchResult> {
    if (!command || typeof command !== "object" || typeof command.type !== "string") {
      return { ok: false, code: "invalid-command" };
    }
    switch (command.type) {
      case "get_global_status": {
        const snapshot = this.options.aggregator.getSnapshot();
        const metadata = await this.options.metadata.ensure();
        const pending = snapshot.pending.filter((entry) => entry.status === "pending");
        return {
          ok: true,
          type: "global_status",
          version: snapshot.version,
          generation: snapshot.generation,
          observedAt: snapshot.observedAt,
          workerState: snapshot.workerState,
          petSessionId: metadata.petSessionId,
          runningCount: snapshot.sessions.filter((session) => session.runState === "running")
            .length,
          queuedCount: snapshot.sessions.filter((session) => session.runState === "queued").length,
          pendingCount: pending.length,
          sessions: snapshot.sessions.slice(0, 100),
        };
      }
      case "list_pending":
        return {
          ok: true,
          type: "pending_list",
          pending: this.options.aggregator
            .getSnapshot()
            .pending.filter((pending) => pending.status === "pending")
            .slice(0, 100),
        };
      case "open_session":
        return {
          ok: true,
          type: "open_session",
          result: await this.options.aggregator.resolveNavigation(command.target),
        };
      case "chat": {
        const attachments = Array.isArray(command.attachments) ? command.attachments : [];
        if (
          typeof command.message !== "string" ||
          (!command.message.trim() && attachments.length === 0)
        ) {
          return { ok: false, code: "invalid-command" };
        }
        const metadata = await this.options.metadata.ensure();
        const listedWorkspaces = (await this.options.listWorkspaces?.()) ?? [];
        const workspacePathById = new Map<string, string | null>([[NO_WORKSPACE_ID, null]]);
        const petWorkspaces: PetWorkspaceOption[] = [
          {
            id: NO_WORKSPACE_ID,
            name: "No workspace",
            description: "Use only when the execution task is unrelated to every listed Workspace.",
          },
        ];
        for (const workspace of listedWorkspaces.slice(0, 63)) {
          if (!workspace.path || [...workspacePathById.values()].includes(workspace.path)) continue;
          const id = workspaceIdForPath(workspace.path);
          workspacePathById.set(id, workspace.path);
          petWorkspaces.push({
            id,
            name: workspace.name,
            description:
              workspace.path === command.preferredProjectPath
                ? `${workspace.path} (currently active)`
                : workspace.path,
          });
        }
        const world = {
          ...boundedWorld(this.options.aggregator.getSnapshot()),
          workspaces: petWorkspaces,
        };
        const response = await this.options.worker.requestWorker("agent/run", {
          sessionId: metadata.petSessionId,
          task: command.message.trim(),
          ...(attachments.length > 0 ? { attachments } : {}),
          petRuntimeContext: JSON.stringify(world),
          petWorkspaces,
          profileParams: {
            runtimeContext: JSON.stringify(world),
            workspaces: petWorkspaces,
          },
          cwd: this.options.hostCwd,
          behaviorMode: "pet",
          kind: "pet",
          permissionMode: "default",
          clientMessageId: command.clientMessageId,
        });
        if (!response.ok) {
          return { ok: false, code: "worker-error", message: response.message };
        }
        const workDelegation = readPetWorkDelegation(response.result);
        if (workDelegation && !workspacePathById.has(workDelegation.workspaceId)) {
          return {
            ok: false,
            code: "worker-error",
            message: "Mimi returned a Workspace outside the host-provided list",
          };
        }
        return {
          ok: true,
          type: "chat",
          petSessionId: metadata.petSessionId,
          result: response.result,
          ...(workDelegation
            ? {
                delegation: {
                  clientMessageId: command.clientMessageId ?? `pet-${randomUUID()}`,
                  task: workDelegation.objective,
                  workspacePath: workspacePathById.get(workDelegation.workspaceId) ?? null,
                },
              }
            : {}),
        };
      }
      default:
        return { ok: false, code: "unsupported-in-phase-1" };
    }
  }
}
