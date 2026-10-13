/** Connection health only: a long-running task is never given a deadline here. */
const CONNECT_MS = 10_000;
const CHECK_MS = 15_000;
const PROBE_MS = 5_000;

/** One instance per socket. Retired sockets and queued background timers cannot
 * change the next connection's state. Any explicit response, including a denied
 * read-only probe, proves transport liveness; it does not grant permission. */
export class ConnectionLiveness {
  private timer?: ReturnType<typeof setTimeout>;
  private revision = 0;
  private stopped = false;
  private paused: boolean;
  private ready = false;
  private opened = false;
  private probing = false;

  constructor(
    private readonly sendProbe: () => void,
    private readonly expire: () => void,
    paused = false,
  ) {
    this.paused = paused;
    this.arm(CONNECT_MS, () => this.fail());
  }

  connected(): void {
    if (this.stopped) return;
    this.ready = true;
    this.arm(CHECK_MS, () => this.check());
  }

  /** Native pairing/authentication gets its own bounded phase after open. */
  authenticating(): void {
    if (this.stopped || this.ready || this.opened) return;
    this.opened = true;
    this.arm(CONNECT_MS, () => this.fail());
  }

  /** Return whether this frame answered the current single-flight health check. */
  received(): boolean {
    if (this.stopped || this.paused || !this.probing) return false;
    this.probing = false;
    this.arm(CHECK_MS, () => this.check());
    return true;
  }

  check(): void {
    if (this.stopped || this.paused || this.probing || !this.ready) return;
    this.probing = true;
    // Arm before send: a synchronous response must be able to clear this timer.
    this.arm(PROBE_MS, () => this.fail());
    try {
      this.sendProbe();
    } catch {
      this.fail();
    }
  }

  pause(): void {
    this.paused = true;
    this.probing = false;
    this.clear();
  }

  resume(): void {
    if (this.stopped) return;
    const wasPaused = this.paused;
    this.paused = false;
    if (this.ready) this.check();
    else if (wasPaused) this.arm(CONNECT_MS, () => this.fail());
  }

  stop(): void {
    this.stopped = true;
    this.probing = false;
    this.clear();
  }

  private clear(): void {
    this.revision++;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private arm(ms: number, run: () => void): void {
    this.clear();
    if (this.stopped || this.paused) return;
    const revision = this.revision;
    this.timer = setTimeout(() => {
      if (this.stopped || this.paused || revision !== this.revision) return;
      this.timer = undefined;
      run();
    }, ms);
  }

  private fail(): void {
    if (this.stopped) return;
    this.stop();
    this.expire();
  }
}

export function connectionPageHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}
