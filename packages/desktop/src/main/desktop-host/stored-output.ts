import { Methods } from "@cjhyy/code-shell-core";
import {
  needsIndependentOutput,
  readOutputJournal,
  SessionOutputCoverageStore,
} from "@cjhyy/code-shell-core/internal";
import { SessionSnapshotStore } from "../SessionSnapshotStore.js";
import {
  MainOutputPublisher,
  captureIdleOutputPrefix,
  type MainOutputSource,
} from "../main-output-publisher.js";
import { projectWorkerOutput } from "./worker-output.js";
import { annotateBrowserRuntimeStreamEvent } from "../browser-runtime/stream-projection.js";
import { parseWorkerLine } from "../worker-line.js";
import type { LiveStreamEnvelope } from "../parseStreamLine.js";

type Visibility = "hidden" | "milestones" | "full";
export type OutputMutation =
  | { type: "worker"; lines: string[] }
  | { type: "worker-exit"; ids: string[] }
  | {
      type: "publish";
      sessionId: string;
      event: unknown;
      owned?: boolean;
      visibility?: Visibility;
      workerRunning?: boolean;
    }
  | {
      type: "capture";
      sessionId: string;
      sourceId: string;
      visibility?: Visibility;
      workerRunning: boolean;
    }
  | { type: "captured"; sessionId: string; sourceId: string; event: unknown }
  | { type: "release-capture"; sessionId: string; sourceId: string }
  | { type: "register-external" | "reset" | "forget"; sessionId: string };
export interface OutputPublication {
  origin: "worker" | "external" | "owned";
  envelope: LiveStreamEnvelope;
  line?: string;
}
export interface OutputResult {
  frames: OutputPublication[];
  diagnostics: { name: string; details: Record<string, unknown> }[];
}

/** Synchronous journal/coverage locks are confined to the existing storage
 * thread. All producers for the same session share its cursor and snapshot. */
export class StoredDesktopOutput {
  readonly snapshots: SessionSnapshotStore;
  private readonly publisher: MainOutputPublisher;
  private readonly owned = new Map<string, MainOutputSource>();
  private readonly captured = new Map<string, { sessionId: string; source: MainOutputSource }>();
  private frames: OutputPublication[] = [];
  private diagnostics: OutputResult["diagnostics"] = [];

  constructor(private readonly root: string) {
    this.snapshots = new SessionSnapshotStore({
      coverage: new SessionOutputCoverageStore(() => root),
    });
    this.publisher = new MainOutputPublisher({
      root: () => root,
      latest: (id) => this.snapshots.get(id).outputCursor,
      worker: (sessionId, event) => {
        this.worker(
          JSON.stringify({
            jsonrpc: "2.0",
            method: Methods.StreamEvent,
            params: { sessionId, event },
          }),
        );
        return this.snapshots.get(sessionId).outputCursor === event.outputCursor;
      },
    });
  }
  private worker(line: string) {
    const frame = projectWorkerOutput(parseWorkerLine(line), this.publisher, this.snapshots, {
      observeLifecycle() {},
      report: (name, details) => {
        this.diagnostics.push({ name, details });
      },
    });
    if (frame?.liveStreamEnvelope?.sessionId)
      this.frames.push({
        origin: "worker",
        envelope: frame.liveStreamEnvelope,
        line: frame.projectedLine,
      });
  }
  private append(
    origin: "external" | "owned",
    sessionId: string,
    raw: unknown,
    visibility: Visibility = "full",
  ) {
    const event = annotateBrowserRuntimeStreamEvent(raw, visibility);
    try {
      const entry = this.snapshots.append(sessionId, event);
      this.frames.push({
        origin,
        envelope: { sessionId, event, seq: entry.seq, epoch: this.snapshots.epoch },
      });
      return true;
    } catch {
      this.diagnostics.push({ name: "stream.coverage_unavailable", details: { sessionId } });
      return false;
    }
  }
  private capture(sessionId: string, visibility: Visibility | undefined, running: boolean) {
    const prefix = captureIdleOutputPrefix(
      this.root,
      sessionId,
      this.snapshots.get(sessionId),
      running,
    );
    return this.publisher.capture(
      sessionId,
      (event) => this.append("external", sessionId, event, visibility),
      undefined,
      prefix,
    );
  }
  private bindOwned(sessionId: string, prefix?: string) {
    if (this.owned.has(sessionId)) return;
    this.owned.set(
      sessionId,
      this.publisher.capture(
        sessionId,
        (event) => this.append("owned", sessionId, event, "full"),
        (id, event) => this.append("owned", id, event, "full"),
        prefix,
      ),
    );
  }
  private publish(command: Extract<OutputMutation, { type: "publish" }>) {
    const { sessionId, event, owned, visibility } = command;
    if (needsIndependentOutput(event)) {
      if (!owned)
        return this.capture(sessionId, visibility, command.workerRunning === true).publish(event);
      const source = this.owned.get(sessionId);
      if (source) return source.publish(event);
      this.append("owned", sessionId, { ...event, outputRecovery: "incomplete" }, "full");
      throw new Error("External output has no committed Session anchor");
    }
    if ((event as { outputCursor?: unknown } | null)?.outputCursor) {
      if (!this.publisher.observeWorker(sessionId, event)) return;
      if (owned) this.bindOwned(sessionId);
    }
    this.append(owned ? "owned" : "external", sessionId, event, owned ? "full" : visibility);
  }
  mutate(command: OutputMutation): OutputResult {
    this.frames = [];
    this.diagnostics = [];
    try {
      switch (command.type) {
        case "worker":
          for (const line of command.lines) this.worker(line);
          break;
        case "worker-exit":
          this.snapshots.onWorkerExit(command.ids);
          break;
        case "publish":
          this.publish(command);
          break;
        case "capture":
          if (this.captured.has(command.sourceId) || this.captured.size >= 8192)
            throw new Error("Output source capacity reached");
          this.captured.set(command.sourceId, {
            sessionId: command.sessionId,
            source: this.capture(command.sessionId, command.visibility, command.workerRunning),
          });
          break;
        case "captured": {
          const item = this.captured.get(command.sourceId);
          if (!item || item.sessionId !== command.sessionId)
            throw new Error("Output source was revoked");
          item.source.publish(command.event);
          break;
        }
        case "release-capture":
          if (this.captured.get(command.sourceId)?.sessionId === command.sessionId)
            this.captured.delete(command.sourceId);
          break;
        case "register-external": {
          const history = readOutputJournal(this.root, command.sessionId, { maxFrames: 1 });
          if (history.status === "ok") {
            const snapshot = this.snapshots.get(command.sessionId);
            this.bindOwned(
              command.sessionId,
              !snapshot.events.length && !snapshot.outputCursor && !snapshot.topLevelRunning
                ? history.through
                : undefined,
            );
          }
          break;
        }
        case "reset":
        case "forget":
          if (command.type === "reset") this.snapshots.resetForHistoryCheckpoint(command.sessionId);
          else this.snapshots.forget(command.sessionId);
          this.publisher.forget(command.sessionId);
          this.owned.delete(command.sessionId);
          for (const [token, item] of this.captured)
            if (item.sessionId === command.sessionId) this.captured.delete(token);
          break;
      }
    } catch (error) {
      if (
        command.type === "publish" &&
        command.owned &&
        (error as { coverageIncomplete?: boolean })?.coverageIncomplete
      )
        this.append(
          "owned",
          command.sessionId,
          { ...(command.event as object), outputCursor: undefined, outputRecovery: "incomplete" },
          "full",
        );
      this.diagnostics.push({
        name: "stream.source_unavailable",
        details: { error: String(error) },
      });
      if (command.type === "capture" || command.type === "captured") throw error;
    }
    const result = { frames: this.frames, diagnostics: this.diagnostics };
    this.frames = [];
    this.diagnostics = [];
    return result;
  }
}
