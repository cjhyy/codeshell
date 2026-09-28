import { realpathSync } from "node:fs";
import { resolve } from "node:path";

export interface PanelExecutionScope {
  appId: string;
  /** Host-verified binding project, never a directory supplied by the guest. */
  projectPath: string;
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
  constructor(message: string) {
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
    const held = { appId: scope.appId, projectPath: panelExecutionProject(scope.projectPath) };
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
  async mutate<T>(
    matches: (scope: PanelExecutionScope) => boolean,
    work: () => Promise<T>,
  ): Promise<T> {
    if (this.mutations.size)
      throw new PanelExecutionBusyError("另一个面板修改正在进行，请稍后重试。");
    // No await between the snapshot and installing the admission barrier.
    if (
      [...this.executions].some(matches) ||
      [...this.sources].some((source) => [...source()].some(matches))
    )
      throw new PanelExecutionBusyError("面板还有正在提交、排队或运行的任务，请结束后再修改。");
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
