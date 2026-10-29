import type { MimiCompanionState } from "../../shared/mimi-companion.js";
import type { RunOutcome } from "./computer-activity-bus.js";
import type { CompanionOperation } from "./cua-activity-server.js";

type Point = { x: number; y: number };
type Rect = { x: number; y: number; width: number; height: number };
/** What the stage knows about where an action happens. Content-free. */
export interface CompanionPlacementScene {
  window?: Rect;
  element?: CompanionOperation["element"];
}
export type CompanionActivity = MimiCompanionState["activity"];

/** A finished gesture stays legible this long before the next one or idle. */
export const GESTURE_DWELL_MS = 700;
export const COMPLETE_DWELL_MS = 1_200;
export const ERROR_DWELL_MS = 2_000;

export interface ChoreographerHost {
  now(): number;
  setTimer(run: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** The human is touching the character or chatting: show nothing new. */
  suppressed(): boolean;
  /** Move the character to act at `point`, keeping clear of `reserved`. */
  place(point: Point | undefined, reserved?: Rect, scene?: CompanionPlacementScene): void;
  /** A gesture is about to be shown (cancel previews, make sure a window exists). */
  beginGesture(): void;
  /** Publish the hidden state and resolve once the character is out of the
   * next screen capture. Called after `capturing` became true. */
  hideForCapture(): Promise<void>;
  publish(): void;
}

// Cached AX/screenshot geometry may already be stale when pointer input
// starts, so follow the native cursor. A pointerless value write has no such
// cursor; its element frame is the only position that describes it.
const trustedTarget = (event: CompanionOperation) =>
  event.targetSource === "native-cursor" || event.targetSource === "element"
    ? event.target
    : undefined;

/** Presentation state machine from execution activity to the character's
 * current gesture. Pure: time, timers and placement belong to the host. */
export class CompanionChoreographer {
  private readonly active = new Map<string, CompanionOperation>();
  private readonly captures = new Set<string>();
  private idleTimer: unknown;
  private placed: { target?: Point; avoidRect?: Rect } = {};
  private current: CompanionActivity;
  private disposed = false;

  constructor(private readonly host: ChoreographerHost) {
    this.current = { id: "idle", action: "idle", phase: "end", startedAt: host.now() };
  }

  get activity(): CompanionActivity {
    return this.current;
  }

  /** A screen capture is in progress; the character must stay hidden. */
  get capturing(): boolean {
    return this.captures.size > 0;
  }

  /** Show an activity that did not come from execution (previews). */
  show(activity: CompanionActivity): void {
    this.current = activity;
  }

  /** The human took over: drop the current gesture and its target. */
  interrupt(id = "human"): void {
    this.clearIdle();
    this.current = { id, action: "idle", phase: "end", startedAt: this.host.now() };
    this.placed = {};
  }

  async receive(event: CompanionOperation): Promise<void> {
    if (this.disposed) return;
    if (event.phase === "update") return this.update(event);
    if (event.phase === "start") {
      this.active.set(event.id, { ...event, target: trustedTarget(event) });
      if (event.capture) {
        this.captures.add(event.id);
        await this.host.hideForCapture();
        return;
      }
      // Read-only metadata probes must not erase the input target or cut off
      // the gesture that the input is still completing.
      if (event.action === "observe") return;
      if (this.host.suppressed()) return;
      this.host.beginGesture();
      this.clearIdle();
      // Pointer input waits for this operation's native cursor update.
      if (event.action !== "key")
        this.place(
          trustedTarget(event),
          event.targetSource === "element" ? event.avoidRect : undefined,
          { window: event.window, element: event.element },
        );
      this.current = {
        id: event.id,
        action: event.action,
        phase: "start",
        startedAt: this.host.now(),
      };
    } else {
      this.active.delete(event.id);
      this.captures.delete(event.id);
      // A failed tool call is not a failed task; the run outcome decides that.
      if (this.current.id === event.id) this.dwellThenNext(event.id);
    }
    this.host.publish();
  }

  run(run: { sessionId: string; outcome: RunOutcome }): void {
    if (this.disposed || this.host.suppressed() || run.outcome === "cancelled") return;
    if (this.active.size > 0) return;
    this.clearIdle();
    const id = `run:${run.sessionId}:${this.host.now()}`;
    this.current = {
      id,
      action: run.outcome === "completed" ? "complete" : "error",
      phase: "end",
      startedAt: this.host.now(),
    };
    this.host.publish();
    this.idleTimer = this.host.setTimer(
      () => {
        if (this.current.id !== id || this.disposed) return;
        this.current = { id: "idle", action: "idle", phase: "end", startedAt: this.host.now() };
        this.host.publish();
      },
      run.outcome === "completed" ? COMPLETE_DWELL_MS : ERROR_DWELL_MS,
    );
  }

  dispose(): void {
    this.disposed = true;
    this.clearIdle();
  }

  private update(event: CompanionOperation): void {
    const previous = this.active.get(event.id);
    if (!previous || previous.capture || !event.target) return;
    this.active.set(event.id, { ...previous, target: event.target, avoidRect: event.avoidRect });
    if (this.host.suppressed() || this.current.id !== event.id) return;
    // Native cursor snapshots refine the existing operation's target; they
    // must not replay its gesture or release a capture held by another call.
    const { target, avoidRect } = this.placed;
    const retainedInput =
      event.action === "key" &&
      target &&
      avoidRect &&
      target.x === event.target.x &&
      target.y === event.target.y
        ? avoidRect
        : undefined;
    this.place(event.target, event.avoidRect ?? retainedInput, {
      window: previous.window,
      element: previous.element,
    });
    this.host.publish();
  }

  private dwellThenNext(id: string): void {
    this.clearIdle();
    this.current = { ...this.current, phase: "end" };
    this.idleTimer = this.host.setTimer(() => {
      if (this.current.id !== id || this.disposed) return;
      const next = [...this.active.values()]
        .reverse()
        .find((candidate) => !candidate.capture && candidate.action !== "observe");
      this.current = next
        ? { id: next.id, action: next.action, phase: "start", startedAt: this.host.now() }
        : { id: "idle", action: "idle", phase: "end", startedAt: this.host.now() };
      if (next && !this.host.suppressed())
        this.place(next.target, next.avoidRect, { window: next.window, element: next.element });
      this.host.publish();
    }, GESTURE_DWELL_MS);
  }

  private place(point: Point | undefined, reserved?: Rect, scene?: CompanionPlacementScene): void {
    this.placed = { target: point, avoidRect: reserved };
    this.host.place(point, reserved, scene);
  }

  private clearIdle(): void {
    if (this.idleTimer !== undefined) this.host.clearTimer(this.idleTimer);
    this.idleTimer = undefined;
  }
}
