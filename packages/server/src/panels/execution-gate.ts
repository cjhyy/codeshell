import { realpathSync } from "node:fs";
import { resolve } from "node:path";

/** What holds an execution, so a refused change can name it. Host-assigned only. */
export interface PanelExecutionHolder {
  kind: "panel-call" | "agent-tool" | "process" | "agent-task" | "tool-job" | "automation";
  /** Desktop WebContents id of the Panel instance that owns this execution. */
  guestId?: number;
  /** Trusted Host description, such as a native tool entry name. */
  label?: string;
}
export interface PanelExecutionScope {
  appId: string;
  /** Host-verified binding project, never a directory supplied by the guest. */
  projectPath: string;
  holder?: PanelExecutionHolder;
}
export interface PanelExecutionBlocker extends PanelExecutionScope {
  count: number;
}
/** Existing path aliases must not create separate admission domains. */
export function panelExecutionProject(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}
export class PanelExecutionBusyError extends Error {
  readonly status = 409;
  constructor(
    message: string,
    /** Present when executions block a change; empty while another change runs. */
    readonly blockers: PanelExecutionBlocker[] = [],
  ) {
    super(message);
    this.name = "PanelExecutionBusyError";
  }
}

/** One process owns admission for every Panel runtime sharing its installed catalog.
 * Acquire synchronously before authorization/IO; release after real execution cleanup,
 * not after a UI timeout, cancellation request or a terminal status notification.
 */
export class PanelExecutionGate {
  private readonly executions = new Set<PanelExecutionScope>();
  private readonly sources = new Set<() => Iterable<PanelExecutionScope>>();
  private readonly mutations = new Set<(scope: PanelExecutionScope) => boolean>();

  enter(scope: PanelExecutionScope): () => void {
    const held: PanelExecutionScope = {
      appId: scope.appId,
      projectPath: panelExecutionProject(scope.projectPath),
      ...(scope.holder ? { holder: { ...scope.holder } } : {}),
    };
    if ([...this.mutations].some((matches) => matches(held)))
      throw new PanelExecutionBusyError("面板正在更新，请完成后重试。");
    this.executions.add(held);
    return () => {
      this.executions.delete(held);
    };
  }
  async run<T>(scope: PanelExecutionScope, work: () => Promise<T>): Promise<T> {
    const release = this.enter(scope);
    try {
      return await work();
    } finally {
      release();
    }
  }
  /** Durable queues remain occupied even while paused and between process attempts. */
  register(source: () => Iterable<PanelExecutionScope>): () => void {
    this.sources.add(source);
    return () => {
      this.sources.delete(source);
    };
  }
  /** Executions that a change matching `matches` would wait for, grouped by holder. */
  blockers(matches: (scope: PanelExecutionScope) => boolean): PanelExecutionBlocker[] {
    const grouped = new Map<string, PanelExecutionBlocker>();
    const scopes = [...this.executions, ...[...this.sources].flatMap((source) => [...source()])];
    for (const scope of scopes) {
      if (!matches(scope)) continue;
      const blocker: PanelExecutionScope = {
        appId: scope.appId,
        projectPath: scope.projectPath,
        ...(scope.holder ? { holder: { ...scope.holder } } : {}),
      };
      const key = JSON.stringify(blocker),
        existing = grouped.get(key);
      if (existing) existing.count++;
      else grouped.set(key, { ...blocker, count: 1 });
    }
    return [...grouped.values()];
  }
  async mutate<T>(
    matches: (scope: PanelExecutionScope) => boolean,
    work: () => Promise<T>,
  ): Promise<T> {
    if (this.mutations.size)
      throw new PanelExecutionBusyError("另一个面板修改正在进行，请稍后重试。");
    // No await between the snapshot and installing the admission barrier.
    const blockers = this.blockers(matches);
    if (blockers.length)
      throw new PanelExecutionBusyError(
        "面板还有正在提交、排队或运行的任务，请结束后再修改。",
        blockers,
      );
    this.mutations.add(matches);
    try {
      return await work();
    } finally {
      this.mutations.delete(matches);
    }
  }
}

// Shared by native Desktop, its paired Web runtimes, and all Hub workspaces in this process.
// This is not a cross-process catalog lock; management also serializes catalog writes.
export const panelExecutionGate = new PanelExecutionGate();
