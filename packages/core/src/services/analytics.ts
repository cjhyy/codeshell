/**
 * Analytics service — event tracking and telemetry.
 *
 * Provides a lightweight analytics pipeline that queues events
 * and flushes them to configured sinks (file, console, or remote).
 */

import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface AnalyticsEvent {
  name: string;
  properties?: Record<string, unknown>;
  timestamp?: string;
}

type AnalyticsSink = (events: AnalyticsEvent[]) => void;

class AnalyticsService {
  private queue: AnalyticsEvent[] = [];
  private sinks: AnalyticsSink[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private initialized = false;

  /**
   * Initialize the analytics service with default file sink.
   */
  init(): void {
    if (this.initialized) return;
    this.initialized = true;

    // Default: file-based sink
    this.addSink(fileAnalyticsSink());

    // Flush every 30 seconds
    this.flushTimer = setInterval(() => this.flush(), 30_000);

    // Flush on exit
    process.on("beforeExit", () => this.flush());
  }

  addSink(sink: AnalyticsSink): void {
    this.sinks.push(sink);
  }

  track(name: string, properties?: Record<string, unknown>): void {
    this.queue.push({
      name,
      properties,
      timestamp: new Date().toISOString(),
    });

    // Auto-flush if queue gets large
    if (this.queue.length >= 100) {
      this.flush();
    }
  }

  flush(): void {
    if (this.queue.length === 0) return;

    const events = [...this.queue];
    this.queue = [];

    for (const sink of this.sinks) {
      try {
        sink(events);
      } catch {
        // Silently ignore sink errors
      }
    }
  }

  shutdown(): void {
    this.flush();
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }
}

function fileAnalyticsSink(): AnalyticsSink {
  const logDir = join(homedir(), ".code-shell", "analytics");

  return (events: AnalyticsEvent[]) => {
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }

    const dateStr = new Date().toISOString().split("T")[0];
    const logFile = join(logDir, `${dateStr}.jsonl`);

    const lines = events
      .map((e) => JSON.stringify({ ...e, ...e.properties, properties: undefined }))
      .join("\n") + "\n";

    appendFileSync(logFile, lines, "utf-8");
  };
}

// Singleton
export const analytics = new AnalyticsService();

// Convenience
export function trackEvent(name: string, properties?: Record<string, unknown>): void {
  analytics.track(name, properties);
}
