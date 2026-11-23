import type { PetProjectionDelta, PetProjectionSnapshotResult } from "@cjhyy/code-shell-pet";
import type { ListSessions } from "../../shared/disk-session-query.js";
import type {
  MimiProjectionOperations,
  MimiProjectionUpdate,
} from "../../shared/mimi-projection.js";
import { mimiWorkView, type MimiWorkSnapshot } from "../../shared/mimi-work-memory.js";
import {
  PetStateAggregator,
  type AgentBridgePetEvent,
  type DesktopPetSession,
  type DesktopPetWorkMemorySegment,
} from "../../main/pet/pet-state-aggregator.js";
import type { ParsedWorkerLine } from "../../main/worker-line.js";
import type { BusinessMethods } from "./business-calls.js";

interface ProjectionWorker {
  petProjectionSnapshot(): Promise<PetProjectionSnapshotResult | null>;
  hasLiveWorker(): boolean;
}

export class HostedMimiProjection {
  readonly state: PetStateAggregator;
  private workerEvent?: (event: AgentBridgePetEvent) => void | Promise<void>;
  private generation = 0;
  private seq = 0;
  private startup?: Promise<void>;
  private segments: DesktopPetWorkMemorySegment[] = [];
  private segmentWatermark?: Pick<MimiWorkSnapshot, "epoch" | "revision">;
  private sourcesQueue = Promise.resolve();
  private externalRows = new Map<string, string>();
  private dirty = false;
  private reading = false;
  private stopped = false;
  constructor(
    private readonly options: {
      catalog: ListSessions;
      worker(): ProjectionWorker | undefined;
      memory(): Promise<MimiWorkSnapshot>;
      external(input: { projectCwds?: string[] }): Promise<DesktopPetSession[]>;
      publish(update: MimiProjectionUpdate): void;
      report(operation: string, error: unknown): void;
    },
  ) {
    this.state = new PetStateAggregator({
      bridge: {
        hasLiveWorker: () => options.worker()?.hasLiveWorker() ?? false,
        subscribePetProjection: (listen) => {
          this.workerEvent = listen;
          return () => {
            this.workerEvent = undefined;
          };
        },
        requestPetProjectionSnapshot: async () => {
          const generation = this.generation;
          const value = await options.worker()?.petProjectionSnapshot();
          if (!value || this.generation !== generation) return null;
          return {
            ...value,
            workerGeneration: generation,
            pending: value.pending.map((row) => ({ ...row, workerGeneration: generation })),
          };
        },
      },
      listDiskSessions: options.catalog,
      workMemorySegments: () => this.segments,
      onBackgroundError: options.report,
    });
    this.state.subscribe((event) => {
      if (this.stopped) return;
      this.options.publish({
        sequence: ++this.seq,
        event,
        ...(event.kind === "reset" && { snapshot: this.state.getSnapshot() }),
      });
    });
  }
  start() {
    if (this.stopped) return Promise.reject(Error("Mimi projection closed"));
    return (this.startup ??= (async () => {
      this.applyMemory(await this.options.memory(), false);
      if (this.stopped) throw Error("Mimi projection closed");
      await this.state.start();
    })().catch((e) => {
      this.state.stop();
      this.startup = undefined;
      throw e;
    }));
  }
  async snapshot() {
    await this.start();
    return this.state.getSnapshot();
  }
  async baseline() {
    await this.start();
    return { sequence: this.seq, snapshot: this.state.getSnapshot() };
  }
  private emit(event: AgentBridgePetEvent) {
    void Promise.resolve(this.workerEvent?.(event)).catch((e) =>
      this.options.report("worker-projection", e),
    );
  }
  workerState(generation: number, state: "active" | "reclaimed" | "disconnected") {
    this.generation = generation;
    this.emit({ kind: "lifecycle", state });
  }
  /** Consume this private worker-only notification before the compatibility stdio route. */
  observe(line: ParsedWorkerLine) {
    const msg = line.message as { method?: string; params?: PetProjectionDelta } | undefined;
    if (msg?.method !== "agent/petProjectionDelta") return false;
    const delta = msg.params;
    if (
      delta &&
      typeof delta.workerGeneration === "number" &&
      typeof delta.version === "number" &&
      typeof delta.observedAt === "number" &&
      typeof delta.kind === "string"
    ) {
      const generation = this.generation;
      this.emit({
        kind: "delta",
        delta:
          delta.kind === "pending-upsert"
            ? {
                ...delta,
                workerGeneration: generation,
                pending: { ...delta.pending, workerGeneration: generation },
              }
            : { ...delta, workerGeneration: generation },
      });
    }
    return true;
  }
  applyMemory(data: MimiWorkSnapshot, notify = true) {
    if (
      this.segmentWatermark?.epoch === data.epoch &&
      this.segmentWatermark.revision >= data.revision
    )
      return;
    this.segmentWatermark = { epoch: data.epoch, revision: data.revision };
    const segments = mimiWorkView(data.segments).segments;
    if (JSON.stringify(segments) === JSON.stringify(this.segments)) return;
    this.segments = segments;
    if (notify && this.startup) this.state.notifyWorkMemorySegmentsChanged();
  }
  private external(input: { projectCwds?: string[] }) {
    const operation = this.sourcesQueue.then(async () => {
      let rows: DesktopPetSession[] = [];
      try {
        rows = await this.options.external(input);
      } finally {
        if (!this.stopped) {
          const ids = new Set(rows.map((row) => row.agentSessionId));
          for (const id of this.externalRows.keys())
            if (!ids.has(id)) {
              this.externalRows.delete(id);
              this.state.removeExternalSession(id);
            }
          for (const row of rows) {
            const value = JSON.stringify(row);
            if (this.externalRows.get(row.agentSessionId) === value) continue;
            this.externalRows.set(row.agentSessionId, value);
            this.state.upsertExternalSession(row);
          }
        }
      }
    });
    this.sourcesQueue = operation.catch(() => {});
    return operation;
  }
  activityChanged() {
    this.dirty = true;
    if (this.reading || this.stopped) return;
    this.reading = true;
    void (async () => {
      try {
        while (this.dirty && !this.stopped) {
          this.dirty = false;
          await this.external({});
        }
      } catch (e) {
        this.options.report("external-projection", e);
      } finally {
        this.reading = false;
        if (this.dirty && !this.stopped) this.activityChanged();
      }
    })();
  }
  readonly methods = {
    "mimi/projectionBaseline": () => this.baseline(),
    "mimi/projectionRefresh": async (input) => {
      await this.start();
      await this.state.refreshCatalog(input.emit, { full: input.full });
      return this.baseline();
    },
    "mimi/projectionNavigate": async (input) => {
      await this.start();
      return this.state.resolveNavigation(input);
    },
    "mimi/projectionSources": async (input) => {
      await this.start();
      await this.external(input);
    },
  } satisfies Pick<BusinessMethods, keyof MimiProjectionOperations>;
  async close() {
    this.stopped = true;
    await this.startup?.catch(() => {});
    this.state.stop();
    await this.sourcesQueue;
  }
}
