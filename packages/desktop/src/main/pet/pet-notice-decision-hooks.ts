import type { ImGatewayOwnerChannel } from "../im-gateway-service.js";
import type { PetDeliveryResolver } from "./pet-delivery-plan.js";
import type { ImDecisionDeliveryResolver } from "./pet-im-decisions.js";
import type { PetNoticeProjectionView } from "./pet-notice-projection.js";
import { errorText } from "./pet-notice-types.js";

/** Window focus changes are re-checked this long after they settle. */
const PRESENCE_SETTLE_MS = 1_000;

/** The `powerMonitor` events the digest listens to (overloads keep Electron's type assignable). */
export interface PetNoticePowerEvents {
  on(event: "resume", listener: () => void): unknown;
  on(event: "unlock-screen", listener: () => void): unknown;
  on(event: "lock-screen", listener: () => void): unknown;
  removeListener(event: "resume", listener: () => void): unknown;
  removeListener(event: "unlock-screen", listener: () => void): unknown;
  removeListener(event: "lock-screen", listener: () => void): unknown;
}

/** Electron `app` window focus events: presence may have flipped without input. */
export interface PetNoticeFocusEvents {
  on(event: "browser-window-blur", listener: () => void): unknown;
  on(event: "browser-window-focus", listener: () => void): unknown;
  removeListener(event: "browser-window-blur", listener: () => void): unknown;
  removeListener(event: "browser-window-focus", listener: () => void): unknown;
}

export interface PetNoticePresenceTimers {
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(timer: unknown): void;
}

export interface PetDecisionNoticeHooks {
  /**
   * Where a pending decision in this Session is prompted: the IM conversation
   * that started its active long task (`task`), else the Session's active
   * rules that watch blocked (the Session is blocked now, so a rule armed
   * after the request appeared still counts). Undefined: desktop only.
   */
  deliveryFor: ImDecisionDeliveryResolver;
  /** An IM conversation that belongs to the owner (direct messages only). */
  isOwnerConversation(origin: { channel: string; target: string; senderId?: string }): boolean;
  /** Hear about a pending decision in a rule-watched Session as it appears, or a rule armed. */
  onBlocked(listener: (sessionId: string) => void): () => void;
  /** The owner is away (the router's presence): a desktop-kept prompt may now go to IM. */
  isAway(): boolean;
  /**
   * Hear when presence flips (window focus lost or regained, screen locked,
   * the idle threshold passed). Watched only while someone listens.
   */
  onAwayChange(listener: () => void): () => void;
  /** The owner target the router would use on this channel is a confirmed private chat. */
  ownerChannelIsDirect(channel: string): boolean;
  /** The projection's status for a decision; undefined once it is gone. */
  decisionStatus(sessionId: string, requestId: string): string | undefined;
  /** The projection reflects a live worker (not a failed or lost snapshot). */
  projectionLive(): boolean;
  /** The worker is really gone: reclaimed, or no live worker. */
  workerGone(): boolean;
}

export interface PetDecisionHooksDeps {
  view: PetNoticeProjectionView;
  deliveries: Pick<PetDeliveryResolver, "planBlocked">;
  /** The router's presence (settings-aware detector). */
  isPresent(): boolean;
  getSystemIdleTimeSec(): number;
  presenceIdleSec(): number;
  ownerChannels(): ImGatewayOwnerChannel[];
  isOwnerConversation(channel: string, target: string): boolean;
  /** Tasks changed (an IM-started task may now own where a prompt goes). */
  subscribeTasks?: (listener: () => void) => () => void;
  powerEvents?: PetNoticePowerEvents;
  focusEvents?: PetNoticeFocusEvents;
  presenceTimers?: PetNoticePresenceTimers;
  log: (event: string, data: Record<string, unknown>) => void;
}

export interface PetDecisionHooksHandle {
  hooks: PetDecisionNoticeHooks;
  /** Tell PetImDecisions a Session may have a prompt to send (`""`: any Session). */
  nudge(sessionId: string): void;
  dispose(): void;
}

/**
 * What PetImDecisions asks the notice wiring: where a prompt goes, whether
 * the owner is away (with a presence watch that only runs while someone
 * listens), and the projection's view of each decision.
 */
export function createDecisionHooks(deps: PetDecisionHooksDeps): PetDecisionHooksHandle {
  const { view, log } = deps;
  let disposed = false;

  const decisionListeners = new Set<(sessionId: string) => void>();
  const nudge = (sessionId: string): void => {
    for (const listener of decisionListeners) {
      try {
        listener(sessionId);
      } catch (error) {
        log("pet.notice.decision_listener_failed", { sessionId, error: errorText(error) });
      }
    }
  };

  /**
   * Presence flips, only while a listener waits for one. Window blur / focus
   * and a screen lock are events, re-checked after they settle (switching
   * between CodeShell windows blurs one and focuses the next). The idle
   * threshold is not an event, so while the owner is present a timer looks
   * again when it would pass without input.
   */
  const awayListeners = new Set<() => void>();
  const presenceTimers = deps.presenceTimers ?? {
    setTimeout: (callback: () => void, delay: number) => {
      const timer = setTimeout(callback, delay);
      timer.unref?.();
      return timer;
    },
    clearTimeout: (timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  };
  let lastPresent: boolean | undefined;
  let idleTimer: unknown;
  let settleTimer: unknown;
  const stopPresenceTimers = (): void => {
    if (idleTimer !== undefined) presenceTimers.clearTimeout(idleTimer);
    if (settleTimer !== undefined) presenceTimers.clearTimeout(settleTimer);
    idleTimer = settleTimer = undefined;
  };
  const checkPresence = (): void => {
    stopPresenceTimers();
    if (awayListeners.size === 0 || disposed) {
      lastPresent = undefined;
      return;
    }
    let present: boolean;
    try {
      present = deps.isPresent();
    } catch {
      present = false;
    }
    const changed = lastPresent !== undefined && lastPresent !== present;
    lastPresent = present;
    if (present) {
      let idle: number;
      try {
        idle = deps.getSystemIdleTimeSec();
      } catch {
        idle = 0;
      }
      const left = Math.max(1, deps.presenceIdleSec() - (Number.isFinite(idle) ? idle : 0));
      idleTimer = presenceTimers.setTimeout(checkPresence, left * 1_000 + 250);
    }
    if (!changed) return;
    for (const listener of [...awayListeners]) {
      try {
        listener();
      } catch (error) {
        log("pet.notice.presence_listener_failed", { error: errorText(error) });
      }
    }
  };
  /** Look once the focus has settled; a change that does not hold is not one. */
  const presenceEvent = (): void => {
    if (awayListeners.size === 0 || disposed) return;
    if (settleTimer !== undefined) presenceTimers.clearTimeout(settleTimer);
    settleTimer = presenceTimers.setTimeout(checkPresence, PRESENCE_SETTLE_MS);
  };
  deps.focusEvents?.on("browser-window-blur", presenceEvent);
  deps.focusEvents?.on("browser-window-focus", presenceEvent);
  deps.powerEvents?.on("lock-screen", presenceEvent);
  const unsubscribeTasks = deps.subscribeTasks?.(() => nudge(""));

  const hooks: PetDecisionNoticeHooks = {
    deliveryFor(sessionId, task) {
      return deps.deliveries.planBlocked({
        sessionId,
        ...(task ? { task } : {}),
        // Mimi's own and external Sessions are never watched by rules.
        useRules: view.isEligibleSession(sessionId),
      }).entries[0];
    },
    isOwnerConversation(origin) {
      try {
        return deps.isOwnerConversation(origin.channel, origin.target);
      } catch (error) {
        log("pet.notice.owner_lookup_failed", { error: errorText(error) });
        return false;
      }
    },
    onBlocked(listener) {
      decisionListeners.add(listener);
      return () => decisionListeners.delete(listener);
    },
    isAway() {
      try {
        return !deps.isPresent();
      } catch {
        return false;
      }
    },
    onAwayChange(listener) {
      awayListeners.add(listener);
      if (awayListeners.size === 1) checkPresence();
      // Already away: that is the change this listener is waiting for.
      if (lastPresent === false)
        queueMicrotask(() => {
          if (awayListeners.has(listener)) listener();
        });
      return () => {
        awayListeners.delete(listener);
        if (awayListeners.size === 0) checkPresence();
      };
    },
    ownerChannelIsDirect(channel) {
      try {
        return deps.ownerChannels().some((entry) => entry.id === channel && entry.isDirect);
      } catch {
        return false;
      }
    },
    projectionLive() {
      return view.snapshot().workerState === "active";
    },
    workerGone() {
      return view.workerIsGone(view.snapshot().workerState);
    },
    decisionStatus(sessionId, requestId) {
      return view
        .snapshot()
        .pending.find(
          (pending) => pending.agentSessionId === sessionId && pending.requestId === requestId,
        )?.status;
    },
  };

  return {
    hooks,
    nudge,
    dispose() {
      disposed = true;
      deps.powerEvents?.removeListener("lock-screen", presenceEvent);
      deps.focusEvents?.removeListener("browser-window-blur", presenceEvent);
      deps.focusEvents?.removeListener("browser-window-focus", presenceEvent);
      unsubscribeTasks?.();
      awayListeners.clear();
      checkPresence();
    },
  };
}
