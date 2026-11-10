/**
 * One one-shot timer per key, armed for an instant on the caller's clock and
 * re-armed only when that instant changes. A timer never keeps the process up.
 */
export class KeyedTimers {
  private readonly timers = new Map<string, { at: number; timer: unknown }>();
  private readonly schedule: (callback: () => void, delay: number) => unknown;
  private readonly cancel: (timer: unknown) => void;

  constructor(
    private readonly fire: (key: string) => void,
    private readonly now: () => number,
    options: {
      setTimeout?: (callback: () => void, delay: number) => unknown;
      clearTimeout?: (timer: unknown) => void;
    } = {},
  ) {
    this.schedule = options.setTimeout ?? ((callback, delay) => setTimeout(callback, delay));
    this.cancel =
      options.clearTimeout ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  }

  set(key: string, at: number): void {
    const existing = this.timers.get(key);
    if (existing?.at === at) return;
    if (existing) this.clear(key);
    const timer = this.schedule(
      () => {
        if (this.timers.get(key)?.timer !== timer) return;
        this.timers.delete(key);
        this.fire(key);
      },
      Math.max(0, at - this.now()),
    );
    (timer as { unref?: () => void } | undefined)?.unref?.();
    this.timers.set(key, { at, timer });
  }

  clear(key: string): void {
    const existing = this.timers.get(key);
    if (!existing) return;
    this.timers.delete(key);
    this.cancel(existing.timer);
  }

  clearAll(): void {
    for (const key of [...this.timers.keys()]) this.clear(key);
  }
}
