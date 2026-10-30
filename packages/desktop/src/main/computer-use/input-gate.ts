import {
  MAX_CANCELLED_SESSIONS,
  type InputGateState,
  type InputLane,
} from "./input-gate-policy.js";

export interface InputGateStatus {
  /** Every input lane is held until the user resumes. */
  stopped: boolean;
  /** Only foreground input is held (chat with Mimi is open). */
  foregroundHeld: boolean;
  userActive: boolean;
}

/** Desktop-owned execution gate. The proxy enforces it; nothing here depends
 * on the character window being alive. */
export class InputGate {
  private state: InputGateState = { version: 0, userActive: false, cancelledSessions: [] };
  private readonly listeners = new Set<(state: InputGateState) => void>();

  snapshot(): InputGateState {
    return { ...this.state, cancelledSessions: [...this.state.cancelledSessions] };
  }

  status(): InputGateStatus {
    return {
      stopped: this.state.holdAll === "user-stop",
      foregroundHeld: this.state.holdForeground === "chat-open",
      userActive: this.state.userActive,
    };
  }

  subscribe(listener: (state: InputGateState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** User pressed Stop: refuse every input lane until an explicit resume. */
  stopAll(): void {
    if (this.state.holdAll === "user-stop") return;
    this.update({ holdAll: "user-stop" });
  }

  /** Explicit user resume clears every hold the user can see. */
  resume(): void {
    if (!this.state.holdAll && !this.state.holdForeground) return;
    this.update({ holdAll: undefined, holdForeground: undefined });
  }

  holdForegroundForChat(): void {
    if (this.state.holdForeground === "chat-open") return;
    this.update({ holdForeground: "chat-open" });
  }

  releaseForegroundForChat(): void {
    if (this.state.holdForeground !== "chat-open") return;
    this.update({ holdForeground: undefined });
  }

  setUserActive(active: boolean): void {
    if (this.state.userActive === active) return;
    this.update({ userActive: active });
  }

  /** The user cancelled this Session's run; its lineage gets no further input. */
  cancelSession(sessionId: string): void {
    if (this.state.cancelledSessions.includes(sessionId)) return;
    const cancelledSessions = [...this.state.cancelledSessions, sessionId];
    while (cancelledSessions.length > MAX_CANCELLED_SESSIONS) cancelledSessions.shift();
    this.update({ cancelledSessions });
  }

  /** A new run of the Session starts with a clean slate. */
  clearSession(sessionId: string): void {
    if (!this.state.cancelledSessions.includes(sessionId)) return;
    this.update({
      cancelledSessions: this.state.cancelledSessions.filter((id) => id !== sessionId),
    });
  }

  private update(change: Partial<InputGateState>): void {
    const next: InputGateState = { ...this.state, ...change, version: this.state.version + 1 };
    if (!next.holdAll) delete next.holdAll;
    if (!next.holdForeground) delete next.holdForeground;
    this.state = next;
    const snapshot = this.snapshot();
    for (const listener of [...this.listeners]) {
      try {
        listener(snapshot);
      } catch {
        /* One failing listener must not keep the gate from others. */
      }
    }
  }
}

export interface UserActivityMonitorOptions {
  gate: InputGate;
  /** Seconds since the last keyboard/mouse input (Electron powerMonitor). */
  idleSeconds(): number;
  intervalMs?: number;
  /** Input within this many whole seconds counts as the user being active. */
  activeWithinSeconds?: number;
  /** After a foreground CUA action, ignore idle resets for this long. */
  selfInputGraceMs?: number;
  now?: () => number;
}

/** Marks the user active while they use the keyboard or mouse. Foreground CUA
 * delivery posts real input events, which reset the same idle clock, so idle
 * resets during and just after our own foreground action are not counted. */
export class UserActivityMonitor {
  private timer?: ReturnType<typeof setInterval>;
  private readonly foreground = new Set<string>();
  private lastForegroundEnd = Number.NEGATIVE_INFINITY;
  private readonly now: () => number;

  constructor(private readonly options: UserActivityMonitorOptions) {
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sample(), this.options.intervalMs ?? 250);
    this.timer.unref?.();
    this.sample();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.foreground.clear();
    this.options.gate.setUserActive(false);
  }

  observe(event: { id: string; phase: "start" | "update" | "end"; lane?: InputLane }): void {
    if (event.phase === "start" && event.lane === "foreground") this.foreground.add(event.id);
    else if (event.phase === "end" && this.foreground.delete(event.id))
      this.lastForegroundEnd = this.now();
  }

  sample(): void {
    let idle: number;
    try {
      idle = this.options.idleSeconds();
    } catch {
      return;
    }
    if (!Number.isFinite(idle)) return;
    const recent = idle < (this.options.activeWithinSeconds ?? 2);
    const ours =
      this.foreground.size > 0 ||
      this.now() - this.lastForegroundEnd < (this.options.selfInputGraceMs ?? 2_500);
    // While our own input may have reset the clock, keep the previous verdict.
    if (recent && ours) return;
    this.options.gate.setUserActive(recent);
  }
}
