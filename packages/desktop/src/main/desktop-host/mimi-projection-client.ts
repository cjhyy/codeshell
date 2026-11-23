import type { CallShellBusiness } from "../../shared/shell-business-contracts.js";
import type { MimiProjectionBaseline, MimiProjectionUpdate } from "../../shared/mimi-projection.js";
import type {
  DesktopPetProjectionEvent,
  DesktopPetProjectionSnapshot,
  PetNavigationRequest,
} from "../pet/pet-state-aggregator.js";

function empty(): DesktopPetProjectionSnapshot {
  return {
    version: 0,
    generation: 0,
    observedAt: Date.now(),
    workerState: "disconnected",
    sessions: [],
    pending: [],
    workMemorySegments: [],
  };
}

/** Native window observers need a synchronous display mirror. Navigation and refresh always reach the owner. */
export class NativeMimiProjection {
  private snapshot = empty();
  private sequence = -1;
  private epoch = 0;
  private enabled = false;
  private requiredSequence = -1;
  private repair?: Promise<void>;
  private listeners = new Set<(event: DesktopPetProjectionEvent) => void>();
  constructor(
    private readonly call: CallShellBusiness,
    private readonly report: (error: unknown) => void,
  ) {}
  getSnapshot() {
    return this.snapshot;
  }
  private install(baseline: MimiProjectionBaseline, epoch: number, notify: boolean) {
    if (epoch !== this.epoch || baseline.sequence < this.sequence) return;
    this.sequence = baseline.sequence;
    this.snapshot = baseline.snapshot;
    if (notify) this.reset();
  }
  private reset() {
    const { generation, version, observedAt } = this.snapshot;
    this.emit({ kind: "reset", generation, version, observedAt });
  }
  private emit(event: DesktopPetProjectionEvent) {
    for (const listener of this.listeners) listener(event);
  }
  subscribe(listener: (event: DesktopPetProjectionEvent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private refresh(notify: boolean) {
    if (this.repair) return this.repair;
    const epoch = this.epoch;
    const run = (async () => {
      do {
        const baseline = await this.call("mimi/projectionBaseline", {});
        if (epoch !== this.epoch) return;
        this.install(baseline, epoch, notify);
      } while (this.sequence < this.requiredSequence);
    })();
    this.repair = run;
    void run
      .finally(() => {
        if (this.repair === run) this.repair = undefined;
      })
      .catch(() => {});
    return run;
  }
  start() {
    this.enabled = true;
    return this.refresh(true);
  }
  reconnect() {
    if (this.enabled) void this.refresh(true).catch(this.report);
  }
  disconnect() {
    this.epoch++;
    this.sequence = -1;
    this.requiredSequence = -1;
    this.repair = undefined;
    if (!this.enabled) return;
    this.snapshot = {
      ...empty(),
      generation: this.snapshot.generation,
      version: this.snapshot.version + 1,
    };
    this.reset();
  }
  receive({ sequence, event, snapshot }: MimiProjectionUpdate) {
    if (!this.enabled || sequence <= this.sequence) return;
    this.requiredSequence = Math.max(this.requiredSequence, sequence);
    if (snapshot) {
      this.install({ sequence, snapshot }, this.epoch, false);
    } else {
      if (sequence !== this.sequence + 1 || this.sequence < 0 || event.kind === "reset") {
        void this.refresh(true).catch(this.report);
        return;
      }
      const next = {
        ...this.snapshot,
        observedAt: event.observedAt,
        version: event.version,
        generation: event.generation,
      };
      switch (event.kind) {
        case "session-upsert":
          next.sessions = [
            ...next.sessions.filter((s) => s.agentSessionId !== event.session.agentSessionId),
            event.session,
          ].sort((a, b) => a.agentSessionId.localeCompare(b.agentSessionId));
          break;
        case "session-remove":
          next.sessions = next.sessions.filter((s) => s.agentSessionId !== event.sessionId);
          break;
        case "pending-upsert":
          next.pending = [
            ...next.pending.filter(
              (p) =>
                p.agentSessionId !== event.pending.agentSessionId ||
                p.requestId !== event.pending.requestId,
            ),
            event.pending,
          ].sort((a, b) => a.createdAt - b.createdAt || a.requestId.localeCompare(b.requestId));
          break;
        case "pending-remove":
          next.pending = next.pending.filter(
            (p) => p.agentSessionId !== event.sessionId || p.requestId !== event.requestId,
          );
          break;
        case "worker-state":
          next.workerState = event.state;
          break;
        case "work-memory-segments":
          next.workMemorySegments = event.segments;
          break;
      }
      this.snapshot = next;
      this.sequence = sequence;
    }
    this.emit(event);
  }
  async refreshCatalog(emit = true, opts: { full?: boolean } = {}) {
    const epoch = this.epoch;
    this.install(
      await this.call("mimi/projectionRefresh", { emit, full: opts.full }),
      epoch,
      false,
    );
  }
  resolveNavigation(request: PetNavigationRequest) {
    return this.call("mimi/projectionNavigate", request);
  }
  sources(projectCwds: string[]) {
    return this.call("mimi/projectionSources", { projectCwds });
  }
  stop() {
    this.enabled = false;
    this.epoch++;
    this.sequence = -1;
    this.requiredSequence = -1;
    this.repair = undefined;
    this.listeners.clear();
    this.snapshot = empty();
  }
}
