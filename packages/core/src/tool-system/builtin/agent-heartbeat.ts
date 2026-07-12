/**
 * AgentHeartbeatPinger (B: background-agent visibility) — while background
 * sub-agents are running, emit a periodic `agent_heartbeat` per parent session
 * so the UI knows they're alive even during long LLM-request silence (no
 * tool_use / no text for minutes). Decided over mtime/event-stream liveness
 * because the worker KNOWS an agent is mid-request and can keep reporting it,
 * whereas a quiet event stream looks dead.
 *
 * Liveness model deliberately NOT a separate heartbeat-file here — the file +
 * pid (Heartbeat.ts / isProcessAlive) is for cross-restart interrupted
 * detection (phase C). This pinger is the live "still working" UI signal only.
 *
 * Lifecycle (anti-leak): single timer, stored + cleared; `unref()` so it never
 * pins the process open; `start()` idempotent; self-stops emitting when no
 * agent runs but keeps the (unref'd) tick cheap. Mirrors the proven
 * Heartbeat.ts / chat-session-manager sweeper pattern.
 */

import type { StreamEvent } from "../../types.js";
import { asyncAgentRegistry } from "./agent-registry.js";
import { notificationQueue } from "./agent-notifications.js";
import { initialAgentProgress } from "./agent-progress.js";

/** Default 30s — user-chosen. Stale threshold downstream is 3× (90s). */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

export interface AgentHeartbeatConfig {
  intervalMs?: number;
  /** Sink for each heartbeat event (server forwards to the client). */
  publish?: (sessionId: string, event: StreamEvent) => void;
  /** Injectable clock for tests. */
  now?: () => number;
}

export class AgentHeartbeatPinger {
  private readonly intervalMs: number;
  private readonly publish?: (sessionId: string, event: StreamEvent) => void;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(config: AgentHeartbeatConfig) {
    this.intervalMs = config.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.publish = config.publish;
    this.now = config.now ?? Date.now;
  }

  /** Begin periodic heartbeats. Idempotent — a second call is a no-op. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    // Never keep the process alive just for heartbeats.
    if (typeof this.timer === "object" && "unref" in this.timer) {
      (this.timer as { unref: () => void }).unref();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One heartbeat cycle: group running agents by session and publish. */
  private tick(): void {
    const running = asyncAgentRegistry.getSnapshot().filter((e) => e.status === "running");
    if (running.length === 0) {
      // Nothing left to ping — self-stop so the timer doesn't tick forever
      // after the last background agent finishes. start() re-arms on the next
      // handoff. (Idempotent stop.)
      this.stop();
      return;
    }

    const bySession = new Map<string, string[]>();
    const ts = this.now();
    for (const e of running) {
      // Background agents always carry their spawning sessionId; skip any
      // legacy/ad-hoc entry without one (can't address a heartbeat to nobody).
      if (!e.sessionId) continue;
      if (!this.publish) {
        notificationQueue.enqueue({
          kind: "progress",
          from: {
            sessionId: e.childSessionId ?? e.agentId,
            agentId: e.agentId,
            authority: "agent",
          },
          to: { sessionId: e.sessionId, authority: "agent" },
          delivery: "observe-only",
          runtimeGeneration: e.runtimeGeneration,
          payload: e.progress ?? initialAgentProgress(ts),
        });
        continue;
      }
      const list = bySession.get(e.sessionId);
      if (list) list.push(e.agentId);
      else bySession.set(e.sessionId, [e.agentId]);
    }

    for (const [sessionId, agentIds] of bySession) {
      this.publish?.(sessionId, { type: "agent_heartbeat", agentIds, ts });
    }
  }
}

/**
 * Process-wide pinger that publishes to the agentNotificationBus (the same
 * channel background-agent completions use → the protocol server forwards each
 * event to the client). `ensureRunning()` is called when an agent backgrounds;
 * the pinger self-stops once no agent is running, so a fresh handoff re-arms it.
 */
export const agentHeartbeatPinger = new AgentHeartbeatPinger({});

/** Start the shared pinger if not already ticking (idempotent). Call when an
 *  agent enters the background. */
export function ensureAgentHeartbeat(): void {
  agentHeartbeatPinger.start();
}
