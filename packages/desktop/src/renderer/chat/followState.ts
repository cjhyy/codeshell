/**
 * Pure follow-state machine for stick-to-bottom scrolling.
 *
 * Extracted as a plain reducer so the transition logic — including the
 * programmatic-scroll race that plagues stick-to-bottom implementations — is
 * unit-testable without a DOM (the renderer's test harness is
 * `renderToStaticMarkup`, no jsdom, so effects/scroll never run in tests).
 *
 * The React hook (`useStickToBottom`) owns the DOM glue (attaching listeners,
 * assigning `scrollTop`); this module owns *whether* we should be following and
 * whether the jump-to-bottom affordance should show.
 */

export interface FollowState {
  /** Whether streaming content should auto-scroll to the bottom. */
  following: boolean;
  /** Whether the viewport is within `threshold` px of the bottom. Drives UI. */
  atBottom: boolean;
}

export const INITIAL_FOLLOW_STATE: FollowState = { following: true, atBottom: true };

export type FollowEvent =
  /**
   * A scroll event fired. `distance` = scrollHeight - (scrollTop + clientHeight).
   * `lastProgrammaticTop` / `scrollTop` let us reject our OWN programmatic
   * bottom-snap (which fires an async scroll event) instead of misreading it as
   * the user scrolling up — the classic "follows once then stops" bug (S2).
   */
  | {
      kind: "scroll";
      distance: number;
      threshold: number;
      scrollTop: number;
      /** scrollTop we last set programmatically, or null if none pending. */
      lastProgrammaticTop: number | null;
    }
  /** User sent a message — unconditionally re-arm follow + snap to bottom. */
  | { kind: "send" }
  /** User clicked the jump-to-bottom button — same as send. */
  | { kind: "jumpClick" }
  /** Session switched — unconditionally re-arm (jumpKey change). */
  | { kind: "sessionSwitch" };

/** How close (px) counts as "this scroll event was our programmatic snap". */
const PROGRAMMATIC_EPSILON = 2;

/**
 * Compute the next follow-state. Pure — no side effects, no DOM.
 *
 * Returns whether a programmatic bottom-snap should be performed by the caller
 * via `scrollNow`, separate from the state itself.
 */
export function nextFollowState(
  prev: FollowState,
  event: FollowEvent,
): { state: FollowState; scrollNow: boolean } {
  switch (event.kind) {
    case "scroll": {
      const near = event.distance <= event.threshold;
      // Ignore the scroll event our own snap produced: if we just set scrollTop
      // programmatically and this event lands at (approximately) that position,
      // it is not the user scrolling — don't let it flip `following` off.
      const isProgrammatic =
        event.lastProgrammaticTop !== null &&
        Math.abs(event.scrollTop - event.lastProgrammaticTop) <= PROGRAMMATIC_EPSILON;
      if (isProgrammatic) {
        // Keep following; just refresh atBottom for the UI.
        return { state: { following: prev.following, atBottom: near }, scrollNow: false };
      }
      // Genuine user scroll: follow iff at bottom.
      return { state: { following: near, atBottom: near }, scrollNow: false };
    }
    case "send":
    case "jumpClick":
    case "sessionSwitch":
      // Explicit "take me to now" signals: re-arm follow and snap to bottom.
      return { state: { following: true, atBottom: true }, scrollNow: true };
  }
}

/** Derived: show the jump-to-bottom button whenever the viewport isn't at bottom. */
export function showJumpButton(state: FollowState): boolean {
  return !state.atBottom;
}
