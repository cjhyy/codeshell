import { randomUUID, createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { PanelBridgeError } from "./bridge-contract.js";
import { mkdir } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  panelExecutionProject,
  panelExecutionGate,
  type PanelExecutionScope,
  type PanelExecutionGate,
} from "./execution-gate.js";
import {
  BackgroundServiceStore,
  groupStatus,
  type CommitBoundary,
  type ServiceProcessIdentity,
  type ServiceIdentityInspector,
} from "./background-service-store.js";
import { spawnServiceProcess, type ServiceProcess } from "./background-service-process.js";

export const panelBackgroundServiceMethods = [
  "services.get",
  "services.setDesired",
  "services.configure",
  "services.attach",
  "services.detach",
  "services.read",
  "services.control",
] as const;
export const backgroundServiceLimits = {
  maxRunning: 4,
  maxPerApp: 2,
  maxPerScope: 1,
  healthyResetMs: 60_000,
  maxRetainedScopes: 4096,
  maxChannels: 4,
  maxChannelBytes: 1 << 20,
  maxConfigBytes: 64 << 10,
  minCommitIntervalMs: 1000,
  drainTimeoutMs: 10_000,
  maxLifetimeMs: 21_600_000,
  maxConsecutiveFailures: 5,
  maxServices: 128,
};
export interface BackgroundServiceDefinition {
  entry: string;
  channels: Record<string, { maxBytes: number }>;
  maxLifetimeMs: number;
  idleGraceMs: number;
}
export interface BackgroundServiceScope {
  appId: string;
  projectPath: string;
  name: string;
}
type Desired = "off" | "on-demand" | "always";
type Phase =
  | "stopped"
  | "starting"
  | "running"
  | "draining"
  | "backoff"
  | "failed"
  | "paused"
  | "revoked"
  | "stop-unconfirmed"
  | "needs-consent";
interface Channel {
  generation: number;
  seq: number;
  committedAt: number;
  value: unknown;
}
interface Control {
  requestKey: string;
  action: string;
  result: string;
  at: number;
}
export interface BackgroundServiceState {
  desired: Desired;
  desiredRevision: number;
  configRevision: number;
  phase: Phase;
  generation: number;
  revision: string;
  startedAt: number | null;
  restarts: number;
  lastError: string | null;
  controls: Control[];
}
interface RecordState extends BackgroundServiceState {
  format: "panel.background-service/1";
  scope: BackgroundServiceScope;
  incarnation: string;
  commit: number;
  activeGeneration: number | null;
  process: ServiceProcessIdentity | null;
  config: unknown;
  channels: Record<string, Channel>;
  definition: BackgroundServiceDefinition;
  nextStartAt: number;
  paused: boolean;
  stopPhase?: Phase;
  worker?: ServiceProcessIdentity | null;
  compacted?: boolean;
}
export interface BackgroundServiceDescription {
  revision: string;
  definition: BackgroundServiceDefinition;
  executable: string;
  entry: string;
  sha256: string;
  packageRoot: string;
  cwd: string;
}
export interface BackgroundServiceOptions {
  rootDir: string;
  describe(scope: BackgroundServiceScope): Promise<BackgroundServiceDescription>;
  onEvent?(
    scope: BackgroundServiceScope,
    event: {
      name: string;
      state: BackgroundServiceState;
      generation: number;
      channel?: string;
      seq?: number;
    },
  ): void;
  gate?: PanelExecutionGate;
  now?: () => number;
  fault?: (boundary: CommitBoundary) => void;
  identities?: ServiceIdentityInspector;
  spawn?: typeof spawnServiceProcess;
  /** Tests can block exactly at the authoritative publication boundary. */
  beforePublish?: () => Promise<void>;
  afterSpawnBeforeIdentity?: (identity: ServiceProcessIdentity) => Promise<void>;
}
const clone = <T>(value: T): T => structuredClone(value);
function state(record: RecordState): BackgroundServiceState {
  const {
    desired,
    desiredRevision,
    configRevision,
    phase,
    generation,
    revision,
    startedAt,
    restarts,
    lastError,
    controls,
  } = record;
  return clone({
    desired,
    desiredRevision,
    configRevision,
    phase,
    generation,
    revision,
    startedAt,
    restarts,
    lastError,
    controls,
  });
}
function requestKey(value: unknown): string {
  if (typeof value !== "string" || !value.length || value.length > 256)
    throw new Error("SERVICE_REQUEST_KEY_REQUIRED");
  return value;
}
function validateRecord(record: RecordState): void {
  const counter = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
  const identifier = (value: unknown) =>
    typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(value);
  if (
    !record.scope ||
    !identifier(record.scope.appId) ||
    !identifier(record.scope.name) ||
    !isAbsolute(record.scope.projectPath) ||
    ![
      record.commit,
      record.generation,
      record.desiredRevision,
      record.configRevision,
      record.restarts,
    ].every(counter) ||
    !["off", "on-demand", "always"].includes(record.desired) ||
    ![
      "stopped",
      "starting",
      "running",
      "draining",
      "backoff",
      "failed",
      "paused",
      "revoked",
      "stop-unconfirmed",
      "needs-consent",
    ].includes(record.phase) ||
    typeof record.incarnation !== "string" ||
    typeof record.revision !== "string" ||
    !record.channels ||
    Object.keys(record.channels).length > 4 ||
    !Array.isArray(record.controls) ||
    record.controls.length > 32 ||
    !record.definition ||
    !record.definition.channels ||
    (record.process !== null &&
      (!record.process ||
        !counter(record.process.pid) ||
        record.process.pid <= 1 ||
        typeof record.process.start !== "string" ||
        typeof record.process.host !== "string")) ||
    Object.values(record.channels).some(
      (channel) =>
        !counter(channel.seq) || !counter(channel.generation) || !counter(channel.committedAt),
    )
  )
    throw new Error("SERVICE_RECORD_CORRUPT");
}

function canonicalConfig(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalConfig).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalConfig((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}

/** Host-only coordinator. Package code never receives the authoritative storage path. */
export class PanelBackgroundService {
  private readonly store: BackgroundServiceStore<RecordState>;
  private readonly records = new Map<string, RecordState>();
  private readonly processes = new Map<string, { process: ServiceProcess; generation: number }>();
  private readonly attachments = new Map<string, { key: string; guestId: number }>();
  private readonly pending = new Map<
    string,
    { actual: { process: ServiceProcess; generation: number }; values: Map<string, unknown> }
  >();
  private readonly failedCommits = new Map<string, RecordState>();
  private emergency?: Promise<void>;
  private storageRetryAt = 0;
  private readonly publishTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly idleSince = new Map<string, number>();
  private readonly heldForUpdate = new Set<string>();
  private tail: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private initialized = false;
  private stopping = false;
  private ticking = false;
  private unregister?: () => void;
  private unregisterMutation?: () => void;
  private unregisterDrain?: () => void;
  private readonly now: () => number;
  constructor(private readonly options: BackgroundServiceOptions) {
    this.store = new BackgroundServiceStore(options.rootDir, options.fault, options.identities);
    this.now = options.now ?? Date.now;
  }
  private exclusive<T>(work: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.catch(() => {});
    return result;
  }
  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.store.acquire();
    try {
      for (const record of this.store.all()) {
        validateRecord(record);
        this.records.set(this.store.key(record.scope), record);
      }
      this.initialized = true;
      this.unregister = (this.options.gate ?? panelExecutionGate).register(() =>
        [...this.records.values()]
          .filter((record) => record.process !== null)
          .map((record) => ({
            ...record.scope,
            holder: {
              kind: "service" as const,
              label:
                record.phase === "stop-unconfirmed"
                  ? `${record.scope.name}: stop-unconfirmed; original process group ${record.process!.pid} must exit before retry`
                  : record.scope.name,
            },
          })),
      );
      this.unregisterDrain = (this.options.gate ?? panelExecutionGate).registerServiceDrain(
        (matches) => this.drain(matches),
      );
      this.unregisterMutation = (this.options.gate ?? panelExecutionGate).onMutationSettled(() =>
        this.resumeAfterUpdate(),
      );
      await this.exclusive(async () => {
        for (const key of this.records.keys()) {
          try {
            await this.reconcile(key);
          } catch {
            /* failed scope remains supervised; others recover */
          }
        }
      });
      this.timer = setInterval(() => {
        if (this.ticking) return;
        this.ticking = true;
        void this.tick()
          .catch(() => {})
          .finally(() => {
            this.ticking = false;
          });
      }, 1000);
      this.timer.unref();
    } catch (error) {
      this.initialized = false;
      this.unregister?.();
      this.unregisterMutation?.();
      this.unregisterDrain?.();
      this.store.release();
      throw error;
    }
  }
  private commit(key: string, mutate: (record: RecordState) => void): RecordState {
    const next = clone(this.records.get(key)!);
    mutate(next);
    next.commit++;
    validateRecord(next);
    try {
      this.store.commit(key, next);
    } catch (error) {
      this.failedCommits.set(key, next);
      this.beginEmergencyStop();
      throw error;
    }
    this.records.set(key, next);
    return next;
  }
  private beginEmergencyStop(): void {
    this.pending.clear();
    for (const timer of this.publishTimers.values()) clearTimeout(timer);
    this.publishTimers.clear();
    // No disk write is a prerequisite to stopping an owned executor.
    this.emergency ??= Promise.all(
      [...this.processes].map(async ([key, actual]) => {
        const confirmed = await actual.process.terminate(0).catch(() => false);
        if (confirmed && this.processes.get(key) === actual) this.processes.delete(key);
      }),
    ).then(() => {});
  }
  private async recoverStorage(): Promise<void> {
    this.beginEmergencyStop();
    await this.emergency;
    if (this.now() < this.storageRetryAt) return;
    this.storageRetryAt = this.now() + 5000;
    // Do not re-enable writes while a previous owned process may still publish.
    if (this.processes.size) {
      this.emergency = undefined;
      return;
    }
    try {
      const disk = this.store.recover(validateRecord);
      for (const record of disk) {
        validateRecord(record);
        this.records.set(this.store.key(record.scope), record);
      }
      for (const [key, candidate] of this.failedCommits) {
        const durable = this.records.get(key);
        if (!durable || candidate.commit >= durable.commit) this.records.set(key, candidate);
      }
      for (const [key, record] of this.records) {
        const unconfirmed = record.process && groupStatus(record.process.pid) !== "dead";
        const next = this.commit(key, (value) => {
          value.activeGeneration = null;
          if (unconfirmed) {
            value.phase = "stop-unconfirmed";
            value.lastError = "Storage recovered; previous process group exit remains unconfirmed";
            return;
          }
          value.process = null;
          value.worker = null;
          value.phase = value.desired === "off" ? (value.stopPhase ?? "stopped") : "backoff";
          value.nextStartAt = this.now() + 5000;
          value.lastError = "Recovered after storage failure; previous executors confirmed exited";
        });
        this.emit(next);
      }
      this.failedCommits.clear();
      this.emergency = undefined;
    } catch {
      this.store.quarantine();
      this.beginEmergencyStop();
    }
  }
  private emit(record: RecordState, channel?: string) {
    try {
      this.options.onEvent?.(record.scope, {
        name: record.scope.name,
        state: state(record),
        generation: record.generation,
        ...(channel ? { channel, seq: record.channels[channel]!.seq } : {}),
      });
    } catch {
      /* observers cannot abort committed lifecycle work */
    }
  }
  private async ensure(scope: BackgroundServiceScope): Promise<string> {
    if (!this.initialized || this.stopping || !this.store.available())
      throw new Error("SERVICE_UNAVAILABLE");
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(scope.name)) throw new Error("SERVICE_INVALID_NAME");
    scope = { ...scope, projectPath: panelExecutionProject(scope.projectPath) };
    const description = await this.options.describe(scope);
    const key = this.store.key(scope);
    if (!this.records.has(key)) {
      if (this.records.size >= backgroundServiceLimits.maxRetainedScopes)
        throw new Error("SERVICE_RECORD_CAPACITY");
      this.compactInactive();
      const record = this.emptyRecord(scope, description);
      record.commit = 1;
      try {
        this.store.commit(key, record);
      } catch (error) {
        this.failedCommits.set(key, record);
        this.beginEmergencyStop();
        throw error;
      }
      this.records.set(key, record);
    }
    return key;
  }
  private emptyRecord(
    scope: BackgroundServiceScope,
    description: BackgroundServiceDescription,
  ): RecordState {
    return {
      format: "panel.background-service/1",
      scope,
      incarnation: randomUUID(),
      commit: 0,
      desired: "off",
      desiredRevision: 0,
      configRevision: 0,
      phase: "stopped",
      generation: 0,
      activeGeneration: null,
      revision: description.revision,
      startedAt: null,
      restarts: 0,
      lastError: null,
      controls: [],
      process: null,
      config: {},
      channels: {},
      definition: description.definition,
      nextStartAt: 0,
      paused: false,
    };
  }
  private compactInactive(): void {
    const full = [...this.records].filter(([, record]) => !record.compacted);
    if (full.length < backgroundServiceLimits.maxServices) return;
    const inactive = full
      .filter(
        ([key, record]) =>
          record.desired === "off" &&
          !record.process &&
          ![...this.attachments.values()].some((value) => value.key === key),
      )
      .sort((a, b) => a[1].commit - b[1].commit);
    if (!inactive.length) throw new Error("SERVICE_RECORD_CAPACITY");
    const [key] = inactive[0]!;
    const compacted = this.commit(key, (record) => {
      // Preserve incarnation, every monotonic counter, configuration and control receipts.
      // Only obsolete snapshot payloads are compacted; null is a new publication, not ABA.
      record.compacted = true;
      for (const value of Object.values(record.channels)) {
        value.value = null;
        value.seq++;
        value.committedAt = this.now();
      }
    });
    for (const channel of Object.keys(compacted.channels)) this.emit(compacted, channel);
  }
  private async inspect(scope: BackgroundServiceScope): Promise<RecordState> {
    if (!this.initialized || this.stopping) throw new Error("SERVICE_UNAVAILABLE");
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(scope.name)) throw new Error("SERVICE_INVALID_NAME");
    scope = { ...scope, projectPath: panelExecutionProject(scope.projectPath) };
    const existing = this.records.get(this.store.key(scope));
    let description: BackgroundServiceDescription;
    try {
      description = await this.options.describe(scope);
    } catch (error) {
      if (
        !existing ||
        (error instanceof PanelBridgeError && ["REVOKED", "PERMISSION_DENIED"].includes(error.code))
      )
        throw error;
      return { ...existing, lastError: String(error).slice(0, 2048) };
    }
    const record = existing ?? this.emptyRecord(scope, description);
    if (!this.store.available())
      return {
        ...record,
        phase: "stop-unconfirmed",
        lastError: "SERVICE_STORAGE_UNAVAILABLE; owned executors are being stopped",
      };
    return record;
  }
  private receipt(record: RecordState, key: string, action: string): boolean {
    const previous = record.controls.find((control) => control.requestKey === key);
    if (previous && previous.action !== action)
      throw new PanelBridgeError("SERVICE_REQUEST_KEY_CONFLICT", "SERVICE_REQUEST_KEY_CONFLICT");
    return !!previous;
  }
  private remember(record: RecordState, key: string, action: string, result = "committed") {
    record.controls = [
      ...record.controls,
      { requestKey: key, action, result, at: this.now() },
    ].slice(-32);
  }
  get(scope: BackgroundServiceScope) {
    return this.exclusive(async () => state(await this.inspect(scope)));
  }
  read(scope: BackgroundServiceScope, channel: string, afterSeq?: number) {
    return this.exclusive(async () => {
      const record = await this.inspect(scope);
      if (!Object.hasOwn(record.definition.channels, channel))
        throw new Error("SERVICE_UNKNOWN_CHANNEL");
      const snapshot = record.channels[channel];
      if (!snapshot)
        return { generation: record.generation, seq: 0, committedAt: null, value: null };
      return afterSeq === snapshot.seq ? { unchanged: true as const } : clone(snapshot);
    });
  }
  setDesired(
    scope: BackgroundServiceScope,
    input: { desired: Desired; expectedRevision: number; requestKey: string },
  ) {
    return this.exclusive(async () => {
      if (!["off", "on-demand", "always"].includes(input.desired))
        throw new Error("SERVICE_INVALID_DESIRED");
      const key = await this.ensure(scope),
        receipt = requestKey(input.requestKey),
        current = this.records.get(key)!;
      if (this.receipt(current, receipt, `desired:${input.desired}`)) return state(current);
      if (input.expectedRevision !== current.desiredRevision)
        throw new PanelBridgeError("SERVICE_REVISION_CONFLICT", "SERVICE_REVISION_CONFLICT");
      const wantsStart =
        input.desired === "always" ||
        (input.desired === "on-demand" &&
          [...this.attachments.values()].some((attachment) => attachment.key === key));
      if (wantsStart && !current.process) this.assertCapacity(current);
      this.commit(key, (record) => {
        record.desired = input.desired;
        record.desiredRevision++;
        record.paused = false;
        if (input.desired === "off") {
          record.activeGeneration = null;
          record.phase = record.process ? "draining" : "stopped";
        }
        this.remember(record, receipt, `desired:${input.desired}`);
      });
      if (input.desired === "off") await this.stop(key, "stopped");
      else await this.reconcile(key);
      const result = this.records.get(key)!;
      this.emit(result);
      return state(result);
    });
  }
  configure(
    scope: BackgroundServiceScope,
    input: { config: unknown; expectedConfigRevision: number; requestKey: string },
  ) {
    return this.exclusive(async () => {
      if (
        !input.config ||
        typeof input.config !== "object" ||
        Array.isArray(input.config) ||
        Buffer.byteLength(JSON.stringify(input.config)) > backgroundServiceLimits.maxConfigBytes
      )
        throw new Error("SERVICE_INVALID_CONFIG");
      const key = await this.ensure(scope),
        receipt = requestKey(input.requestKey),
        current = this.records.get(key)!;
      const action = `configure:${createHash("sha256").update(canonicalConfig(input.config)).digest("hex")}`;
      if (this.receipt(current, receipt, action))
        return {
          configRevision: Number(
            current.controls.find((control) => control.requestKey === receipt)!.result,
          ),
        };
      if (isDeepStrictEqual(current.config, input.config)) {
        this.commit(key, (record) =>
          this.remember(record, receipt, action, String(record.configRevision)),
        );
        return { configRevision: current.configRevision };
      }
      if (input.expectedConfigRevision !== current.configRevision)
        throw new PanelBridgeError("SERVICE_CONFIG_CONFLICT", "SERVICE_CONFIG_CONFLICT");
      const next = this.commit(key, (record) => {
        record.config = clone(input.config);
        record.configRevision++;
        this.remember(record, receipt, action, String(record.configRevision));
      });
      this.processes
        .get(key)
        ?.process.send({ t: "config", config: next.config, configRevision: next.configRevision });
      return { configRevision: next.configRevision };
    });
  }
  attach(scope: BackgroundServiceScope, guestId: number) {
    return this.exclusive(async () => {
      const key = await this.ensure(scope);
      const existing = [...this.attachments].find(
        ([, value]) => value.key === key && value.guestId === guestId,
      );
      const attachId = existing?.[0] ?? randomUUID();
      if (!existing) {
        if (this.attachments.size >= 512) throw new Error("SERVICE_ATTACH_CAPACITY");
        this.attachments.set(attachId, { key, guestId });
      }
      this.idleSince.delete(key);
      await this.reconcile(key);
      return { attachId, state: state(this.records.get(key)!) };
    });
  }
  detach(attachId: string, guestId: number) {
    return this.exclusive(() => {
      if (this.attachments.get(attachId)?.guestId === guestId) this.attachments.delete(attachId);
      return { detached: true };
    });
  }
  detachGuest(guestId: number): void {
    for (const [id, attachment] of this.attachments)
      if (attachment.guestId === guestId) this.attachments.delete(id);
  }
  control(
    scope: BackgroundServiceScope,
    input: { action: "poke" | "pause" | "resume" | "stop" | "restart"; requestKey: string },
  ) {
    return this.exclusive(async () => {
      if (!["poke", "pause", "resume", "stop", "restart"].includes(input.action))
        throw new Error("SERVICE_INVALID_ACTION");
      const key = await this.ensure(scope),
        receipt = requestKey(input.requestKey),
        current = this.records.get(key)!;
      if (this.receipt(current, receipt, input.action)) return state(current);
      this.commit(key, (record) => {
        if (input.action === "stop") {
          record.desired = "off";
          record.desiredRevision++;
        }
        if (input.action === "pause") record.paused = true;
        if (input.action === "resume" || input.action === "restart") {
          record.paused = false;
          record.restarts = 0;
          record.nextStartAt = 0;
        }
        if (["stop", "pause", "restart"].includes(input.action)) {
          record.activeGeneration = null;
          record.phase = record.process ? "draining" : "stopped";
        }
        this.remember(record, receipt, input.action);
      });
      if (["stop", "pause", "restart"].includes(input.action))
        await this.stop(key, input.action === "pause" ? "paused" : "stopped");
      await this.reconcile(key);
      if (input.action === "poke") this.processes.get(key)?.process.send({ t: "poke" });
      const result = this.records.get(key)!;
      this.emit(result);
      return state(result);
    });
  }
  private async stop(key: string, phase: Phase) {
    const current = this.records.get(key)!;
    this.pending.delete(key);
    const timer = this.publishTimers.get(key);
    if (timer) clearTimeout(timer);
    this.publishTimers.delete(key);
    let failure: unknown;
    try {
      this.emit(
        this.commit(key, (record) => {
          record.activeGeneration = null;
          record.stopPhase = phase;
          record.phase = record.process ? "draining" : phase;
        }),
      );
    } catch (error) {
      failure = error;
    }
    const running = this.processes.get(key);
    const confirmed = running
      ? await running.process.terminate(failure ? 0 : backgroundServiceLimits.drainTimeoutMs)
      : !current.process || groupStatus(current.process.pid) === "dead";
    if (confirmed) this.processes.delete(key);
    if (failure) throw failure;
    this.emit(
      this.commit(key, (record) => {
        record.phase = confirmed ? phase : "stop-unconfirmed";
        if (confirmed) {
          record.process = null;
          record.worker = null;
        }
      }),
    );
  }
  private assertCapacity(record: RecordState) {
    const occupied = [...this.records.values()].filter((value) => value.process);
    if (
      occupied.length >= backgroundServiceLimits.maxRunning ||
      occupied.filter(
        (value) =>
          value.scope.appId === record.scope.appId &&
          value.scope.projectPath === record.scope.projectPath,
      ).length >= backgroundServiceLimits.maxPerScope ||
      occupied.filter((value) => value.scope.appId === record.scope.appId).length >=
        backgroundServiceLimits.maxPerApp
    )
      throw new PanelBridgeError("SERVICE_CAPACITY", "SERVICE_CAPACITY");
  }
  private async reconcile(key: string): Promise<void> {
    if (this.stopping || this.heldForUpdate.has(key)) return;
    if (!this.store.available()) {
      await this.recoverStorage();
      return;
    }
    let record = this.records.get(key)!;
    if (record.process && record.phase === "stop-unconfirmed" && this.processes.has(key)) {
      if (groupStatus(record.process.pid) === "dead") this.processes.delete(key);
      else return;
    }
    if (record.process && !this.processes.has(key)) {
      if (groupStatus(record.process.pid) !== "dead") {
        if (record.phase !== "stop-unconfirmed")
          this.emit(
            this.commit(key, (next) => {
              next.activeGeneration = null;
              next.phase = "stop-unconfirmed";
            }),
          );
        return;
      }
      record = this.commit(key, (next) => {
        next.process = null;
        next.activeGeneration = null;
        next.phase = next.stopPhase ?? "stopped";
      });
      this.emit(record);
    }
    if (!record.process && record.nextStartAt > this.now()) return;
    let description: BackgroundServiceDescription;
    try {
      description = await this.options.describe(record.scope);
    } catch (error) {
      const revoked =
        error instanceof PanelBridgeError && ["REVOKED", "PERMISSION_DENIED"].includes(error.code);
      if (revoked) {
        if (record.phase !== "revoked") {
          this.commit(key, (next) => {
            next.desired = "off";
            next.desiredRevision++;
            next.activeGeneration = null;
          });
          await this.stop(key, "revoked");
        }
      } else {
        if (record.process) await this.stop(key, "backoff");
        this.failAttempt(key, error);
      }
      return;
    }
    const attached = [...this.attachments.values()].some((value) => value.key === key);
    if (attached) this.idleSince.delete(key);
    else if (!this.idleSince.has(key)) this.idleSince.set(key, this.now());
    const shouldRun =
      !record.paused &&
      (record.desired === "always" ||
        (record.desired === "on-demand" &&
          (attached ||
            (this.processes.has(key) &&
              this.now() - this.idleSince.get(key)! < record.definition.idleGraceMs))));
    if (!shouldRun) {
      if (record.process) await this.stop(key, record.paused ? "paused" : "stopped");
      return;
    }
    if (this.processes.has(key)) {
      if (
        record.revision !== description.revision ||
        this.now() - record.startedAt! >= record.definition.maxLifetimeMs
      )
        await this.stop(key, "stopped");
      else {
        if (
          record.phase === "running" &&
          record.restarts &&
          this.now() - record.startedAt! >= backgroundServiceLimits.healthyResetMs
        )
          this.emit(
            this.commit(key, (next) => {
              next.restarts = 0;
              next.lastError = null;
            }),
          );
        return;
      }
      record = this.records.get(key)!;
      if (record.process) return;
    }
    if (
      record.restarts >= backgroundServiceLimits.maxConsecutiveFailures ||
      record.nextStartAt > this.now()
    )
      return;
    try {
      this.assertCapacity(record);
    } catch (error) {
      this.emit(
        this.commit(key, (next) => {
          next.phase = "backoff";
          next.nextStartAt = this.now() + 5000;
          next.lastError = error instanceof Error ? error.message : String(error);
        }),
      );
      return;
    }
    const gate = this.options.gate ?? panelExecutionGate;
    const release = gate.enter({
      ...record.scope,
      holder: { kind: "service", label: record.scope.name },
    });
    try {
      await mkdir(description.cwd, { recursive: true, mode: 0o700 });
      if (record.compacted) this.compactInactive();
      record = this.commit(key, (next) => {
        next.generation++;
        next.activeGeneration = next.generation;
        next.phase = "starting";
        next.revision = description.revision;
        next.definition = description.definition;
        next.startedAt = this.now();
        next.compacted = false;
        next.lastError = null;
      });
      this.emit(record);
      const generation = record.generation;
      const process = await (this.options.spawn ?? spawnServiceProcess)({
        ...description,
        maxLineBytes:
          Math.max(
            ...Object.values(description.definition.channels).map((channel) => channel.maxBytes),
          ) + 4096,
        onLine: (message) => this.onLine(key, generation, message),
        onExit: (error) => {
          void this.exclusive(() => this.onExit(key, generation, error)).catch(() => {});
        },
      });
      // Commit the verified custody identity BEFORE the guardian may launch package code.
      try {
        await this.options.afterSpawnBeforeIdentity?.(process.identity);
        record = this.commit(key, (next) => {
          next.process = process.identity;
        });
      } catch (error) {
        await process.terminate(0);
        throw error;
      }
      this.processes.set(key, { process, generation });
      const member = await process.prepare();
      record = this.commit(key, (next) => {
        next.worker = member;
      });
      process.activate({
        t: "hello",
        protocol: 1,
        generation,
        config: record.config,
        configRevision: record.configRevision,
        last: Object.fromEntries(
          Object.entries(record.channels).map(([name, value]) => [name, value.value]),
        ),
      });
      this.emit(record);
    } catch (error) {
      if (this.processes.has(key)) await this.stop(key, "backoff").catch(() => {});
      if (this.store.available()) this.failAttempt(key, error);
      throw error;
    } finally {
      release();
    }
  }
  private failAttempt(key: string, error: unknown): void {
    this.emit(
      this.commit(key, (next) => {
        next.activeGeneration = null;
        next.restarts++;
        next.phase = next.process
          ? "stop-unconfirmed"
          : next.restarts >= backgroundServiceLimits.maxConsecutiveFailures
            ? "failed"
            : "backoff";
        next.nextStartAt =
          this.now() + Math.min(300_000, 5000 * 2 ** Math.min(16, next.restarts - 1));
        next.lastError = String(error).slice(0, 2048);
      }),
    );
  }
  private onLine(key: string, generation: number, message: any) {
    const record = this.records.get(key)!;
    const actual = this.processes.get(key);
    if (!actual || actual.generation !== generation || record.activeGeneration !== generation)
      return;
    if (message?.t === "ready") {
      void this.exclusive(() => {
        const current = this.records.get(key)!;
        if (
          this.processes.get(key) !== actual ||
          current.activeGeneration !== generation ||
          current.phase !== "starting"
        )
          return;
        this.emit(
          this.commit(key, (next) => {
            next.phase = "running";
          }),
        );
      }).catch(() => {});
      return;
    }
    if (message?.t !== "publish") return;
    const channel =
      typeof message.channel === "string" &&
      Object.hasOwn(record.definition.channels, message.channel)
        ? record.definition.channels[message.channel]
        : undefined;
    if (!channel || Buffer.byteLength(JSON.stringify(message.value)) > channel.maxBytes)
      throw new Error("SERVICE_CHANNEL_LIMIT");
    let pending = this.pending.get(key);
    if (!pending) {
      pending = { actual, values: new Map() };
      this.pending.set(key, pending);
    }
    if (pending.actual !== actual) {
      pending = { actual, values: new Map() };
      this.pending.set(key, pending);
    }
    pending.values.set(message.channel, clone(message.value));
    if (this.publishTimers.has(key)) return;
    const previous = Math.max(
      0,
      ...Object.values(record.channels).map((value) => value.committedAt),
    );
    const timer = setTimeout(
      () => {
        // External preparation may wait; stop must still reach the commit point.
        // Keep the timer marker until completion to bound in-flight work to one.
        void Promise.resolve()
          .then(() => this.options.beforePublish?.())
          .then(() =>
            this.exclusive(() => {
              const current = this.records.get(key)!;
              if (
                this.processes.get(key) !== actual ||
                current.activeGeneration !== generation ||
                !["running", "starting"].includes(current.phase)
              ) {
                if (this.pending.get(key)?.actual === actual) this.pending.delete(key);
                return;
              }
              const values =
                this.pending.get(key)?.actual === actual
                  ? this.pending.get(key)!.values
                  : undefined;
              this.pending.delete(key);
              if (!values?.size) return;
              const next = this.commit(key, (record) => {
                for (const [name, value] of values)
                  record.channels[name] = {
                    generation,
                    seq: (record.channels[name]?.seq ?? 0) + 1,
                    committedAt: this.now(),
                    value,
                  };
              });
              for (const name of values.keys()) this.emit(next, name);
            }),
          )
          .catch(() => {})
          .finally(() => {
            if (this.publishTimers.get(key) !== timer) return;
            this.publishTimers.delete(key);
            const next = this.processes.get(key),
              pending = this.pending.get(key);
            const value =
              pending && pending.actual === next
                ? pending.values.entries().next().value
                : undefined;
            if (!this.stopping && next && value)
              this.onLine(key, next.generation, {
                t: "publish",
                channel: value[0],
                value: value[1],
              });
          });
      },
      Math.max(0, previous + backgroundServiceLimits.minCommitIntervalMs - this.now()),
    );
    this.publishTimers.set(key, timer);
  }
  private async onExit(key: string, generation: number, error?: string) {
    if (this.processes.get(key)?.generation !== generation) return;
    this.pending.delete(key);
    const record = this.records.get(key)!;
    if (!this.store.available()) {
      this.beginEmergencyStop();
      return;
    }
    if (record.process && groupStatus(record.process.pid) !== "dead") {
      this.emit(
        this.commit(key, (next) => {
          next.activeGeneration = null;
          next.phase = "stop-unconfirmed";
        }),
      );
      return;
    }
    this.processes.delete(key);
    const expected = record.activeGeneration === null || this.stopping;
    const next = this.commit(key, (next) => {
      next.process = null;
      next.activeGeneration = null;
      if (expected) next.phase = next.stopPhase ?? (next.paused ? "paused" : "stopped");
      else {
        next.restarts++;
        next.phase = next.restarts >= 5 ? "failed" : "backoff";
        next.nextStartAt = this.now() + Math.min(300_000, 5000 * 2 ** (next.restarts - 1));
        next.lastError = error ?? "Service exited unexpectedly";
      }
    });
    this.emit(next);
  }
  tick() {
    return this.exclusive(async () => {
      if (!this.store.available()) {
        await this.recoverStorage();
        return;
      }
      for (const key of this.records.keys()) {
        try {
          await this.reconcile(key);
        } catch {
          /* other scopes still progress */
        }
      }
    });
  }
  drain(matches: (scope: PanelExecutionScope) => boolean) {
    return this.exclusive(async () => {
      for (const [key, record] of this.records)
        if (matches(record.scope)) {
          this.heldForUpdate.add(key);
          await this.stop(key, "stopped");
        }
    });
  }
  /** Called after the catalog mutation releases its admission barrier, success or rollback. */
  resumeAfterUpdate(): void {
    this.heldForUpdate.clear();
    void this.tick().catch(() => {});
  }
  revoke(appId: string) {
    return this.exclusive(async () => {
      for (const [key, record] of this.records)
        if (record.scope.appId === appId) {
          this.commit(key, (next) => {
            next.desired = "off";
            next.desiredRevision++;
            next.activeGeneration = null;
            next.config = {};
            next.configRevision++;
            for (const channel of Object.values(next.channels)) {
              channel.value = null;
              channel.seq++;
              channel.committedAt = this.now();
            }
          });
          await this.stop(key, "revoked");
        }
    });
  }
  async shutdown(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    for (const timer of this.publishTimers.values()) clearTimeout(timer);
    this.publishTimers.clear();
    await this.exclusive(async () => {
      await Promise.all(
        [...this.records]
          .filter(([, record]) => record.process)
          .map(async ([key, record]) => {
            try {
              await this.stop(key, record.stopPhase ?? (record.paused ? "paused" : "stopped"));
            } catch {
              await this.processes.get(key)?.process.terminate(0);
            }
          }),
      );
      await this.emergency;
    });
    this.unregister?.();
    this.unregisterMutation?.();
    this.unregisterDrain?.();
    this.store.release();
    this.initialized = false;
  }
}
