/** Admission fence shared by external runtime starts, input and workspace mutations. */
export class ExternalRuntimeWorkspaceGate {
  private readonly pending = new Map<string, symbol>();

  assertAvailable(sessionId: string): void {
    if (this.pending.has(sessionId)) {
      throw new Error("工作区正在切换，请稍后重试。");
    }
  }

  async mutate<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const token = Symbol();
    // Mark admission before entering the service's serialized lifecycle queue.
    // Later starts must not queue a stale cwd behind this mutation.
    this.pending.set(sessionId, token);
    try {
      return await operation();
    } finally {
      // A newer queued mutation keeps its fence after an earlier one settles.
      if (this.pending.get(sessionId) === token) this.pending.delete(sessionId);
    }
  }
}
