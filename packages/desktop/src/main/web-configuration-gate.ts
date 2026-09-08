/** Shared by Desktop IPC, mobile submissions and host-created runs. */
export class WebConfigurationGate {
  private readonly runs = new Map<string, string>();
  private changing = false;
  private reloadFailed = false;

  get runBlocked(): boolean {
    return this.changing || this.reloadFailed;
  }

  beginRun(requestId: string | number | undefined, sessionId?: string): void {
    if (requestId !== undefined) this.runs.set(String(requestId), sessionId ?? "");
  }

  settleRun(requestId: string | number): void {
    this.runs.delete(String(requestId));
  }

  observe(line: string): void {
    try {
      const message = JSON.parse(line);
      if (message.id !== undefined && !message.method) this.settleRun(message.id);
    } catch {
      // Unrelated logs do not change admission state.
    }
  }

  isRunning(sessionId: string): boolean {
    return [...this.runs.values()].includes(sessionId);
  }

  workerExited(): void {
    this.runs.clear();
    this.reloadFailed = false;
  }

  async mutate<T>(write: () => Promise<T>, reload: () => Promise<void>): Promise<T> {
    if (this.changing || this.runs.size > 0) {
      throw Object.assign(new Error("请等待当前任务完成后再保存配置。"), { status: 409 });
    }
    this.changing = true;
    try {
      const result = await write();
      try {
        await reload();
        this.reloadFailed = false;
      } catch {
        this.reloadFailed = true;
        throw Object.assign(new Error("配置已保存但未能生效，请重新保存或重启桌面。"), {
          status: 503,
        });
      }
      return result;
    } finally {
      this.changing = false;
    }
  }
}
