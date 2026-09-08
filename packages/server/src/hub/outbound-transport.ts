import type { WebSocket } from "ws";

export interface HubOutboundLimits {
  /** A history response can contain a 32 MiB transcript plus state and live overlay. */
  maxFrameBytes: number;
  /** A single large history frame is allowed; additional queued frames are bounded. */
  maxSocketBacklogBytes: number;
  maxTotalBacklogBytes: number;
}

export type HubOutboundDropReason =
  | "frame-too-large"
  | "socket-backlog"
  | "total-backlog"
  | "send-error";

export interface HubOutboundDrop {
  reason: HubOutboundDropReason;
  frameBytes: number;
  socketBacklogBytes: number;
  totalBacklogBytes: number;
}

const DEFAULT_LIMITS: HubOutboundLimits = {
  maxFrameBytes: 64 * 1024 * 1024,
  maxSocketBacklogBytes: 8 * 1024 * 1024,
  maxTotalBacklogBytes: 128 * 1024 * 1024,
};

/**
 * Bound the WS write queue separately from the replay buffer. A disconnected
 * browser can recover through the existing authenticated snapshot protocol;
 * keeping an unread socket alive would retain every subsequent stream frame.
 */
export class HubOutboundTransport {
  private readonly limits: HubOutboundLimits;
  private readonly dropped = new WeakSet<WebSocket>();
  private readonly largeFrames = new WeakMap<WebSocket, { followingBytes: number }>();

  constructor(
    private readonly options: {
      tabs: () => Iterable<WebSocket>;
      limits?: Partial<HubOutboundLimits>;
      /** Diagnostic metadata only: never includes conversation contents. */
      onDrop?: (drop: HubOutboundDrop) => void;
    },
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    for (const value of Object.values(this.limits)) {
      if (!Number.isSafeInteger(value) || value <= 0)
        throw new Error("Outbound transport limits must be positive safe integers");
    }
  }

  send(tab: WebSocket, line: string): boolean {
    if (tab.readyState !== tab.OPEN || this.dropped.has(tab)) return false;
    const frameBytes = Buffer.byteLength(line);
    if (frameBytes > this.limits.maxFrameBytes) {
      this.drop(tab, "frame-too-large", frameBytes);
      return false;
    }
    const largeFrame = this.largeFrames.get(tab);
    const followingBytes = frameBytes + 14;
    if (
      largeFrame
        ? largeFrame.followingBytes + followingBytes > this.limits.maxSocketBacklogBytes
        : this.backlog(tab) > this.limits.maxSocketBacklogBytes
    ) {
      this.drop(tab, "socket-backlog", frameBytes);
      return false;
    }

    // Prefer retiring the largest lagging peer to disconnecting a healthy
    // recipient. Still count closing sockets until ws releases their buffers:
    // terminate() can complete asynchronously, and ignoring those bytes would
    // permit transient allocations above the shared bound.
    const wireBytes = followingBytes;
    if (this.totalBacklog() + wireBytes > this.limits.maxTotalBacklogBytes) {
      const lagging = [...this.options.tabs()]
        .filter(
          (peer) =>
            peer !== tab &&
            peer.readyState === peer.OPEN &&
            !this.dropped.has(peer) &&
            this.backlog(peer) > 0,
        )
        .sort((left, right) => this.backlog(right) - this.backlog(left));
      for (const peer of lagging) {
        this.drop(peer, "total-backlog", frameBytes);
        if (this.totalBacklog() + wireBytes <= this.limits.maxTotalBacklogBytes) break;
      }
      if (this.totalBacklog() + wireBytes > this.limits.maxTotalBacklogBytes) {
        this.drop(tab, "total-backlog", frameBytes);
        return false;
      }
    }

    // A valid large snapshot must be allowed to reach the browser before the
    // next small stream notification. Otherwise a perfectly healthy but slow
    // connection would be terminated mid-history and reconnect forever. Bound
    // its following stream tail independently until the large write drains.
    const pendingLarge =
      !largeFrame && frameBytes > this.limits.maxSocketBacklogBytes
        ? { followingBytes: 0 }
        : undefined;
    if (pendingLarge) this.largeFrames.set(tab, pendingLarge);
    if (largeFrame) largeFrame.followingBytes += followingBytes;
    try {
      tab.send(line, (error) => {
        if (pendingLarge && this.largeFrames.get(tab) === pendingLarge)
          this.largeFrames.delete(tab);
        if (error) this.drop(tab, "send-error", frameBytes);
      });
      return true;
    } catch {
      this.drop(tab, "send-error", frameBytes);
      return false;
    }
  }

  private backlog(tab: WebSocket): number {
    const amount = tab.bufferedAmount;
    return Number.isFinite(amount) && amount >= 0 ? amount : Number.POSITIVE_INFINITY;
  }

  private totalBacklog(): number {
    let total = 0;
    for (const tab of this.options.tabs()) total += this.backlog(tab);
    return total;
  }

  private drop(tab: WebSocket, reason: HubOutboundDropReason, frameBytes: number): void {
    if (this.dropped.has(tab)) return;
    this.dropped.add(tab);
    this.largeFrames.delete(tab);
    const metadata = {
      reason,
      frameBytes,
      socketBacklogBytes: this.backlog(tab),
      totalBacklogBytes: this.totalBacklog(),
    };
    // A graceful close frame would wait behind the very backlog being bounded.
    try {
      tab.terminate();
    } catch {
      // Races with socket teardown must not affect other viewers or worker routing.
    }
    try {
      this.options.onDrop?.(metadata);
    } catch {
      // Diagnostics must not break the stream router either.
    }
  }
}
