import { createHash, randomUUID } from "node:crypto";
import type {
  PetNavigationRequest,
  PetNavigationResult,
  DesktopPetProjectionSnapshot,
} from "./pet-state-aggregator.js";
import type {
  PetReusableSessionOption,
  PetWorkspaceOption,
  PetWorkDelegation,
} from "@cjhyy/code-shell-pet";
import type { InputAttachmentMeta } from "@cjhyy/code-shell-server/storage";

export interface PetAutoDelegation {
  clientMessageId: string;
  task: string;
  workspacePath: string | null;
  /** Existing host-validated Work Session to continue; absent means create. */
  targetSessionId?: string;
  /** Original durable Goal objective when `task` is a resume/recovery instruction. */
  goalObjective?: string;
}

export type PetStartedDelegation = Omit<PetAutoDelegation, "targetSessionId" | "goalObjective"> & {
  sessionId: string;
  taskId?: string;
  reusedSession: boolean;
};

export interface PetReusableSessionCandidate {
  sessionId: string;
  workspacePath: string | null;
  title: string;
  updatedAt: number;
  status?: "active" | "paused" | "completed" | "failed" | "cancelled";
}

export type PetDispatchCommand =
  | { type: "get_global_status" }
  | { type: "list_pending" }
  | { type: "open_session"; target: PetNavigationRequest }
  | {
      type: "chat";
      message: string;
      clientMessageId?: string;
      /** Per-Pet-session model-pool key selected by the user. */
      model?: string;
      preferredProjectPath?: string;
      attachments?: InputAttachmentMeta[];
      source?: { kind: "im-gateway"; channel: string };
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
      delegation?: PetStartedDelegation;
      delegations?: PetStartedDelegation[];
      /**
       * Present when Mimi decided to delegate but the Work Session could not be
       * launched. The chat turn still succeeds (her reply is in `result`); this
       * only records the delegation side effect that failed.
       */
      delegationError?: string;
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
  listReusableSessions?(): Promise<PetReusableSessionCandidate[]>;
  startWorkSession?(
    delegation: PetAutoDelegation,
  ): Promise<{ sessionId: string; cwd: string; taskId?: string }>;
  /**
   * Topic-segment controller. beginTurn (before each chat turn) may return a
   * carryover brief to inject into the runtime context; onDelegationClosed
   * records a work-memory entry when a delegated Work Session launches.
   */
  segmentController?: {
    beginTurn(clientMessageId?: string): Promise<string | undefined>;
    onDelegationClosed(closure: {
      objective: string;
      outcome: "completed" | "pending-decided" | "failed";
      workspace?: string;
      sessionRef?: string;
      turnRange?: { start: number; end: number };
    }): Promise<void>;
  };
  /** Durable Pet task continuity injected into every manager turn. */
  longTasks?: {
    context(): unknown;
  };
}

const NO_WORKSPACE_ID = "no-workspace";

/**
 * Trailing separators must not split one workspace into two ids: the tracked
 * project list and a disk session's cwd can disagree only by a trailing slash
 * (e.g. "/work/site/" vs "/work/site"). Mirrors the normalization the former
 * renderer PetAutoDelegationHost applied before this moved into the host.
 */
function normalizeWorkspacePath(path: string): string {
  return path.replace(/[/\\]+$/, "");
}

function workspaceIdForPath(path: string): string {
  return `workspace-${createHash("sha256").update(path).digest("hex").slice(0, 16)}`;
}

function reusableSessionId(sessionId: string): string {
  return `session-${createHash("sha256").update(sessionId).digest("hex").slice(0, 20)}`;
}

function parsePetWorkDelegation(value: unknown): PetWorkDelegation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.workspaceId !== "string" ||
    !record.workspaceId.trim() ||
    typeof record.objective !== "string" ||
    !record.objective.trim()
  ) {
    return null;
  }
  if (
    record.reusableSessionId !== undefined &&
    (typeof record.reusableSessionId !== "string" || !record.reusableSessionId.trim())
  ) {
    return null;
  }
  return {
    workspaceId: record.workspaceId.trim(),
    objective: record.objective.trim(),
    ...(typeof record.reusableSessionId === "string"
      ? { reusableSessionId: record.reusableSessionId.trim() }
      : {}),
  };
}

function readPetWorkDelegations(result: unknown): PetWorkDelegation[] {
  if (!result || typeof result !== "object" || Array.isArray(result)) return [];
  // New shape: RunResult.extensions.pet.workDelegation (generic result slot);
  // legacy petWorkDelegation mirror kept as fallback for older workers.
  const extensions = (result as { extensions?: unknown }).extensions;
  const petExtension =
    extensions && typeof extensions === "object" && !Array.isArray(extensions)
      ? (extensions as { pet?: unknown }).pet
      : undefined;
  const petResults =
    petExtension && typeof petExtension === "object" && !Array.isArray(petExtension)
      ? (petExtension as { workDelegation?: unknown; workDelegations?: unknown })
      : undefined;
  if (Array.isArray(petResults?.workDelegations)) {
    if (petResults.workDelegations.length > 8) return [];
    const parsed = petResults.workDelegations.map(parsePetWorkDelegation);
    return parsed.every((entry): entry is PetWorkDelegation => entry !== null) ? parsed : [];
  }
  const delegation =
    petResults?.workDelegation ?? (result as { petWorkDelegation?: unknown }).petWorkDelegation;
  const parsed = parsePetWorkDelegation(delegation);
  return parsed ? [parsed] : [];
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
        const [listedWorkspaces, listedReusableSessions] = await Promise.all([
          this.options.listWorkspaces?.() ?? [],
          this.options.listReusableSessions?.() ?? [],
        ]);
        const workspacePathById = new Map<string, string | null>([[NO_WORKSPACE_ID, null]]);
        const workspaceIdByPath = new Map<string, string>();
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
          workspaceIdByPath.set(normalizeWorkspacePath(workspace.path), id);
          petWorkspaces.push({
            id,
            name: workspace.name,
            description:
              workspace.path === command.preferredProjectPath
                ? `${workspace.path} (currently active)`
                : workspace.path,
          });
        }
        const snapshot = this.options.aggregator.getSnapshot();
        const unavailableSessionIds = new Set(
          snapshot.sessions
            .filter(
              (session) =>
                session.runState === "running" ||
                session.runState === "queued" ||
                session.pendingDecisionCount > 0,
            )
            .map((session) => session.agentSessionId),
        );
        const reusableSessionById = new Map<
          string,
          PetReusableSessionCandidate & { workspaceId: string }
        >();
        const reusableSessionCounts = new Map<string, number>();
        const petReusableSessions: PetReusableSessionOption[] = [];
        for (const candidate of listedReusableSessions) {
          if (
            petReusableSessions.length >= 32 ||
            !candidate.sessionId ||
            candidate.sessionId === metadata.petSessionId ||
            unavailableSessionIds.has(candidate.sessionId)
          ) {
            continue;
          }
          const workspaceId =
            candidate.workspacePath === null
              ? NO_WORKSPACE_ID
              : workspaceIdByPath.get(normalizeWorkspacePath(candidate.workspacePath));
          if (!workspaceId || (reusableSessionCounts.get(workspaceId) ?? 0) >= 6) continue;
          const id = reusableSessionId(candidate.sessionId);
          if (reusableSessionById.has(id)) continue;
          reusableSessionById.set(id, { ...candidate, workspaceId });
          reusableSessionCounts.set(workspaceId, (reusableSessionCounts.get(workspaceId) ?? 0) + 1);
          petReusableSessions.push({
            id,
            workspaceId,
            name: candidate.title.slice(0, 120) || "Untitled Session",
            description: `status=${candidate.status ?? "idle"}; updated=${
              Number.isFinite(candidate.updatedAt)
                ? new Date(candidate.updatedAt).toISOString()
                : "unknown"
            }`,
          });
        }
        // Advance the topic-segment clock and, if a long-idle boundary was
        // crossed, obtain a carryover brief (open tasks + recent conclusions)
        // to inject as background continuity via the pet runtime context. The
        // clientMessageId keys the new segment's boundary to this turn so the
        // chat UI can render the divider before it (see PetSegmentController).
        const carryoverBrief = await this.options.segmentController?.beginTurn(
          command.clientMessageId,
        );
        const world = {
          ...boundedWorld(snapshot),
          ...(carryoverBrief ? { carryoverBrief } : {}),
          ...(this.options.longTasks ? { longTasks: this.options.longTasks.context() } : {}),
          workspaces: petWorkspaces,
          reusableSessions: petReusableSessions,
          ...(command.source
            ? {
                currentMessageSource: {
                  kind: command.source.kind,
                  channel: command.source.channel.slice(0, 32),
                },
              }
            : {}),
        };
        const response = await this.options.worker.requestWorker("agent/run", {
          sessionId: metadata.petSessionId,
          task: command.message.trim(),
          ...(command.model ? { model: command.model } : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
          petRuntimeContext: JSON.stringify(world),
          petWorkspaces,
          profileParams: {
            runtimeContext: JSON.stringify(world),
            workspaces: petWorkspaces,
            reusableSessions: petReusableSessions,
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
        const workDelegations = readPetWorkDelegations(response.result);
        if (workDelegations.some((entry) => !workspacePathById.has(entry.workspaceId))) {
          return {
            ok: false,
            code: "worker-error",
            message: "Mimi returned a Workspace outside the host-provided list",
          };
        }
        const resolvedDelegations = workDelegations.map((entry) => ({
          entry,
          reusableSession: entry.reusableSessionId
            ? reusableSessionById.get(entry.reusableSessionId)
            : undefined,
        }));
        if (
          resolvedDelegations.some(
            ({ entry, reusableSession }) => entry.reusableSessionId && !reusableSession,
          )
        ) {
          return {
            ok: false,
            code: "worker-error",
            message: "Mimi returned a Session outside the host-provided reusable set",
          };
        }
        if (
          resolvedDelegations.some(
            ({ entry, reusableSession }) =>
              reusableSession && reusableSession.workspaceId !== entry.workspaceId,
          )
        ) {
          return {
            ok: false,
            code: "worker-error",
            message: "Mimi returned a reusable Session outside the selected Workspace",
          };
        }
        let delegations: PetStartedDelegation[] = [];
        let delegationError: string | undefined;
        if (resolvedDelegations.length > 0) {
          const baseClientMessageId = command.clientMessageId ?? `pet-${randomUUID()}`;
          const requests: PetAutoDelegation[] = resolvedDelegations.map(
            ({ entry, reusableSession }, index) => ({
              clientMessageId:
                resolvedDelegations.length === 1
                  ? baseClientMessageId
                  : `${baseClientMessageId}:${index}:work`,
              task: entry.objective,
              workspacePath: workspacePathById.get(entry.workspaceId) ?? null,
              ...(reusableSession ? { targetSessionId: reusableSession.sessionId } : {}),
            }),
          );
          // A delegation-launch failure must not discard Mimi's already-generated
          // chat reply: the turn succeeded, only the side effect of starting the
          // Work Session failed. On IM channels a thrown error here would drop the
          // reply entirely, so we surface it as a non-fatal `delegationError`.
          if (!this.options.startWorkSession) {
            delegationError = "Mimi work delegation host is unavailable";
          } else {
            const outcomes = await Promise.allSettled(
              requests.map((request) => this.options.startWorkSession!(request)),
            );
            delegations = outcomes.flatMap((outcome, index) => {
              const request = requests[index]!;
              if (outcome.status === "rejected") return [];
              return [
                {
                  clientMessageId: request.clientMessageId,
                  task: request.task,
                  workspacePath: request.workspacePath,
                  sessionId: outcome.value.sessionId,
                  ...(outcome.value.taskId ? { taskId: outcome.value.taskId } : {}),
                  reusedSession: Boolean(request.targetSessionId),
                },
              ];
            });
            const failures = outcomes.filter(
              (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
            );
            if (failures.length > 0) {
              const failureMessage = failures
                .map((failure) =>
                  failure.reason instanceof Error ? failure.reason.message : String(failure.reason),
                )
                .join("; ");
              delegationError =
                failures.length === 1
                  ? `Mimi failed to start the delegated Work Session: ${failureMessage}`
                  : `Mimi failed to start ${failures.length} delegated Work Sessions: ${failureMessage}`;
            }
          }
        }
        // Launch acceptance is not task completion. PetLongTaskCoordinator owns
        // the real terminal signal and records work memory only after a worker
        // completion/failure/cancellation event is observed.
        const delegation = delegations[0];
        return {
          ok: true,
          type: "chat",
          petSessionId: metadata.petSessionId,
          result: response.result,
          ...(delegation ? { delegation } : {}),
          ...(delegations.length > 1 ? { delegations } : {}),
          ...(delegationError ? { delegationError } : {}),
        };
      }
      default:
        return { ok: false, code: "unsupported-in-phase-1" };
    }
  }
}
