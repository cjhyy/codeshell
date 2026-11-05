import type { AgentBridge } from "./agent-bridge.js";
import type { PanelAgentTaskOwner } from "./panel-app-agent-task-service.js";

type TaskWorker = Pick<
  AgentBridge,
  "workerGeneration" | "hasLiveWorker" | "hostReservation" | "panelOwnerWebContentsId"
>;

/** A running task is an explicit owner; a reserved or prefix-matching SID is not. */
export class PanelAgentTaskOwnership {
  private readonly runs = new Map<string, { bridge: TaskWorker; generation: number }>();

  constructor(
    private readonly options: {
      activeOwner(sessionId: string): PanelAgentTaskOwner | undefined;
      currentBridge(): TaskWorker | null;
      isPanelAppBound(projectPath: string, appId: string): boolean;
      isWorkspaceTrusted(cwd: string): boolean;
    },
  ) {}

  /** Register after requestWorker has synchronously spawned/submitted to this generation. */
  track(sessionId: string, bridge: TaskWorker): () => void {
    if (this.runs.has(sessionId)) throw new Error("Panel task already has an active worker");
    const run = { bridge, generation: bridge.workerGeneration() };
    this.runs.set(sessionId, run);
    return () => {
      if (this.runs.get(sessionId) === run) this.runs.delete(sessionId);
    };
  }

  hasActiveOwner(sessionId: string): boolean {
    const run = this.runs.get(sessionId);
    const owner = this.options.activeOwner(sessionId);
    if (!run || !owner) return false;
    const { bridge } = run;
    const reservation = bridge.hostReservation(sessionId);
    return (
      bridge === this.options.currentBridge() &&
      bridge.hasLiveWorker() &&
      bridge.workerGeneration() === run.generation &&
      reservation?.producer === "panel-agent-task" &&
      reservation.cwd === owner.cwd &&
      reservation.mainRoot === owner.projectPath &&
      bridge.panelOwnerWebContentsId(sessionId) === owner.ownerWebContentsId &&
      this.options.isPanelAppBound(owner.projectPath, owner.appId) &&
      this.options.isWorkspaceTrusted(owner.projectPath) &&
      this.options.isWorkspaceTrusted(owner.cwd)
    );
  }
}
