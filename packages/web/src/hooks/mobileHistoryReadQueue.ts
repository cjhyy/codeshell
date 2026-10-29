export class HistoryReadBusyError extends Error {
  constructor() {
    super("History read is busy; try again.");
    this.name = "HistoryReadBusyError";
  }
}

export class HistoryReadCancelledError extends Error {
  constructor() {
    super("History read was cancelled.");
    this.name = "HistoryReadCancelledError";
  }
}

interface QueuedRead {
  work: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
}
interface ReadScope {
  key: string;
  active: boolean;
  retired: boolean;
  queued: QueuedRead[];
}

/** Serialize whole detail/page reads for one selection's single protocol waiter. */
export class MobileHistoryReadQueue {
  private scope?: ReadScope;

  constructor(private readonly waitTimeoutMs = 30_000) {}

  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    if (this.scope && this.scope.key !== key) this.reset();
    const scope = (this.scope ??= { key, active: false, retired: false, queued: [] });
    return new Promise<T>((resolve, reject) => {
      const task: QueuedRead = { work, resolve: (value) => resolve(value as T), reject };
      if (!scope.active) {
        this.start(scope, task);
        return;
      }
      if (scope.queued.length >= 8) {
        reject(new HistoryReadBusyError());
        return;
      }
      task.timer = setTimeout(() => {
        const index = scope.queued.indexOf(task);
        if (index < 0) return;
        scope.queued.splice(index, 1);
        reject(new HistoryReadBusyError());
      }, this.waitTimeoutMs);
      scope.queued.push(task);
    });
  }

  /** The owner cancels the active protocol operation separately. Its eventual
   * completion cannot drain this retired queue or interfere with a new view. */
  reset(): void {
    const scope = this.scope;
    this.scope = undefined;
    if (!scope) return;
    scope.retired = true;
    for (const task of scope.queued.splice(0)) {
      clearTimeout(task.timer);
      task.reject(new HistoryReadCancelledError());
    }
  }

  private start(scope: ReadScope, task: QueuedRead): void {
    clearTimeout(task.timer);
    scope.active = true;
    const finish = () => {
      scope.active = false;
      if (scope.retired || this.scope !== scope) return;
      const next = scope.queued.shift();
      if (next) this.start(scope, next);
    };
    void Promise.resolve()
      .then(() => {
        if (scope.retired || this.scope !== scope) throw new HistoryReadCancelledError();
        return task.work();
      })
      .then(
        (value) => {
          task.resolve(value);
          finish();
        },
        (error) => {
          task.reject(error);
          finish();
        },
      );
  }
}
