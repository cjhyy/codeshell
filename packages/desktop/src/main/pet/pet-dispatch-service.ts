import type {
  PetNavigationRequest,
  PetNavigationResult,
  DesktopPetProjectionSnapshot,
} from "./pet-state-aggregator.js";

export type PetDispatchCommand =
  | { type: "get_global_status" }
  | { type: "list_pending" }
  | { type: "open_session"; target: PetNavigationRequest }
  | { type: "chat"; message: string };

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
  | { ok: true; type: "chat"; petSessionId: string; result: unknown };

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
        if (typeof command.message !== "string" || !command.message.trim()) {
          return { ok: false, code: "invalid-command" };
        }
        const metadata = await this.options.metadata.ensure();
        const world = boundedWorld(this.options.aggregator.getSnapshot());
        const response = await this.options.worker.requestWorker("agent/run", {
          sessionId: metadata.petSessionId,
          task: `${command.message.trim()}\n\n<pet-world>${JSON.stringify(world)}</pet-world>`,
          cwd: this.options.hostCwd,
          behaviorMode: "pet",
          kind: "pet",
          permissionMode: "default",
        });
        if (!response.ok) {
          return { ok: false, code: "worker-error", message: response.message };
        }
        return {
          ok: true,
          type: "chat",
          petSessionId: metadata.petSessionId,
          result: response.result,
        };
      }
      default:
        return { ok: false, code: "unsupported-in-phase-1" };
    }
  }
}
