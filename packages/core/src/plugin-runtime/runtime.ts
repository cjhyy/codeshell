/**
 * The native plugin runtime of one agent worker.
 *
 * At start it finds every approved native plugin, snapshots it, starts its
 * process, checks what it registered against its manifest and offers the
 * resulting module to the composition. Afterwards it keeps those processes
 * alive, restarts or gives up on the ones that fail, and reacts when the
 * install registry changes underneath it.
 *
 * What a plugin declares is fixed for the life of the composition. A refresh
 * can therefore withdraw a plugin at once and swap in new code that declares
 * the same things, but a plugin that is new or declares something different
 * waits for the next composition.
 */

import { join } from "node:path";
import { compileComposition } from "../composition/compiler.js";
import type { AgentModule, PluginAgentModule } from "../composition/types.js";
import { readInstalledPlugins } from "../plugins/installedPlugins.js";
import {
  inspectNativePlugin,
  nativeManifestProblem,
  type NativePluginState,
} from "../plugins/native/approval.js";
import {
  nativeModuleId,
  readNativePluginManifest,
  type NativePluginManifest,
} from "../plugins/native/manifest.js";
import {
  collectNativeSnapshots,
  nativeRuntimeRoot,
  prepareNativeSnapshot,
  touchNativeSnapshot,
} from "../plugins/native/snapshot.js";
import { resolvePluginDataPath } from "../plugins/pluginCommandHook.js";
import { pluginNameFromKey } from "../plugins/pluginHookApproval.js";
import { pluginTreeDigest } from "../plugins/pluginTreeDigest.js";
import type { PluginInstallEntry } from "../plugins/types.js";
import {
  buildNativeModule,
  nativeDeclarationsDigest,
  validateNativeDeclarations,
  type NativeCallBlock,
  type NativePluginCalls,
} from "./module-adapter.js";
import {
  PluginCallError,
  PluginProcess,
  reapLeftoverPluginProcesses,
  type PluginExitReason,
  type PluginProcessSpec,
} from "./process.js";
import type { NativeDeclarations, PluginInvocationKind } from "./protocol.js";

/** A plugin whose process dies this often in this window is not restarted again. */
const CRASH_LIMIT = 3;
const CRASH_WINDOW_MS = 60_000;
/** Nor is one whose calls keep failing with no success in between. */
const CONSECUTIVE_FAILURE_LIMIT = 5;
/** A plugin without background logic gives its process back after this long without a call. */
const IDLE_REAP_MS = 10 * 60 * 1000;
const IDLE_SWEEP_MS = 60 * 1000;
/** How long a plugin with background logic stays down after its process died. */
const BACKGROUND_REVIVE_MS = 1_000;
/**
 * Failures that say nothing about a plugin's health: the caller gave up, or
 * this side refused to send the call (too large, or too many waiting).
 */
const NOT_THE_PLUGINS_FAULT: ReadonlySet<string> = new Set([
  "CANCELLED",
  "MESSAGE_TOO_LARGE",
  "BUSY",
]);

/**
 * - `running`: part of this composition and serving calls.
 * - `circuit-open`: part of it, but failing too often to keep restarting.
 * - `revoked`: part of it, but no longer approved or installed; calls are refused.
 * - `restart-required`: approved, but not what this composition was built
 *   with (new, or declaring something different).
 * - `failed`: approved, but could not be loaded.
 * - the rest: why an installed native plugin was never eligible.
 */
export type NativePluginRuntimeState =
  | "running"
  | "circuit-open"
  | "revoked"
  | "restart-required"
  | "failed"
  | Exclude<NativePluginState, "none" | "approved">;

export interface NativePluginStatus {
  installKey: string;
  plugin: string;
  moduleId: string;
  state: NativePluginRuntimeState;
  error?: string;
  pid?: number;
  startedAt?: number;
  restarts: number;
  calls: number;
  failures: number;
  timeouts: number;
  lastError?: string;
  lastErrorAt?: number;
  logFile: string;
}

export interface NativePluginRuntimeOptions {
  hostKind: string;
  /** The host's own modules; plugin modules must compile alongside them. */
  baseModules: readonly AgentModule[];
  /** Plugins switched off for a session; without a session, the user-level list. */
  disabledPlugins(sessionId: string | undefined): readonly string[];
  sessionCwd(sessionId: string | undefined): string | undefined;
  log?(event: string, fields?: Record<string, unknown>): void;
  /** Test seams. */
  entry?: string;
  setupTimeoutMs?: number;
  pingTimeoutMs?: number;
  idleReapMs?: number;
  backgroundReviveMs?: number;
  now?(): number;
}

interface Candidate {
  installKey: string;
  plugin: string;
  moduleId: string;
  entry: PluginInstallEntry;
  /** The installed version, from the record. A refresh reacts when it changes. */
  recordDigest: string;
}

/** An update or local edit that could not take over a loaded plugin. */
interface Declined {
  recordDigest: string;
  state: "failed" | "restart-required";
  error: string;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One loaded plugin: the stable target the module's stubs call into. */
class PluginSlot implements NativePluginCalls {
  process: PluginProcess | undefined;
  private starting: Promise<PluginProcess> | undefined;
  fenced = false;
  circuitOpen = false;
  restarts = 0;
  lastCallAt: number;
  lastError: string | undefined;
  private crashes: number[] = [];
  private consecutiveFailures = 0;
  /** Counters of processes that are gone, so the totals survive a restart. */
  private retired = { calls: 0, failures: 0, timeouts: 0 };
  /** Bumped when an update takes over, so a start still on its way up cannot displace it. */
  private generation = 0;
  /** The process was given back for being idle: the next one is not a restart. */
  private idleStopped = false;
  /**
   * The last update or local edit that could not take over. It is reported
   * until something does, and the same update is not tried on every refresh.
   */
  declined: Declined | undefined;

  constructor(
    private readonly runtime: NativePluginRuntime,
    readonly candidate: Candidate,
    public spec: PluginProcessSpec,
    /** The installed version this slot serves. */
    public recordDigest: string,
    /** The files it runs: the snapshot taken from disk when it last took over. */
    public runDigest: string,
    readonly revision: string,
    readonly background: boolean,
    process: PluginProcess,
  ) {
    this.process = process;
    this.lastCallAt = runtime.now();
  }

  blocked(sessionId: string | undefined): NativeCallBlock | undefined {
    if (this.fenced) return "revoked";
    return this.runtime.options.disabledPlugins(sessionId).includes(this.candidate.plugin)
      ? "disabled"
      : undefined;
  }

  sessionCwd(sessionId: string | undefined): string | undefined {
    return this.runtime.options.sessionCwd(sessionId);
  }

  /** Why no process may serve this plugin right now, if anything stands in the way. */
  private refusal(): PluginCallError | undefined {
    if (this.fenced) return new PluginCallError("REVOKED", "the plugin is no longer approved");
    if (this.runtime.isClosed) {
      return new PluginCallError("PLUGIN_UNAVAILABLE", "the host is shutting down");
    }
    if (this.circuitOpen) {
      return new PluginCallError("CIRCUIT_OPEN", "the plugin keeps failing and was stopped");
    }
    return undefined;
  }

  async invoke(
    kind: PluginInvocationKind,
    name: string,
    payload: unknown,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<unknown> {
    const refused = this.refusal();
    if (refused) throw refused;
    this.lastCallAt = this.runtime.now();
    const process = await this.ensureProcess();
    try {
      const value = await process.invoke(kind, name, payload, options);
      this.consecutiveFailures = 0;
      return value;
    } catch (error) {
      if (!(error instanceof PluginCallError) || !NOT_THE_PLUGINS_FAULT.has(error.code)) {
        this.lastError = describe(error);
        this.consecutiveFailures += 1;
        if (this.consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) {
          this.openCircuit(`${CONSECUTIVE_FAILURE_LIMIT} calls in a row failed`);
        }
      }
      throw error;
    }
  }

  /** The current process, started again if it exited or was given back while idle. */
  private ensureProcess(): Promise<PluginProcess> {
    const current = this.process;
    if (current?.accepting) return Promise.resolve(current);
    this.starting ??= this.startAfter(current).finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  /** Start a new process once `leaving`, if any, is gone: two copies never run side by side. */
  private async startAfter(leaving: PluginProcess | undefined): Promise<PluginProcess> {
    if (leaving) await leaving.whenExited();
    // An update may have taken over while the old copy was leaving: serve from
    // it instead of starting a second copy that would displace it.
    if (this.process?.accepting) return this.process;
    const refused = this.refusal();
    if (refused) throw refused;
    return this.startProcess(this.spec);
  }

  /** Start a process from `spec` and require it to declare exactly what this slot was built for. */
  async startProcess(spec: PluginProcessSpec): Promise<PluginProcess> {
    const generation = this.generation;
    const process = this.runtime.createProcess(spec, (reason) => this.handleExit(process, reason));
    let declarations: NativeDeclarations;
    try {
      declarations = await process.start();
    } catch (error) {
      this.recordCrash();
      throw error;
    }
    if (nativeDeclarationsDigest(declarations) !== this.revision) {
      await process.stop();
      this.recordCrash();
      throw new PluginCallError(
        "PLUGIN_UNAVAILABLE",
        "the plugin registered something different from what this session was built with",
      );
    }
    // Revoked, closed or given up on while this copy was setting up, or an
    // update took over meanwhile: it never serves.
    const refused = this.refusal();
    if (refused || generation !== this.generation) {
      await process.stop();
      if (refused) throw refused;
      if (this.process?.accepting) return this.process;
      throw new PluginCallError("PLUGIN_UNAVAILABLE", "the plugin was updated while starting");
    }
    this.adopt(process, spec);
    return process;
  }

  /** Make `process` the one that serves calls. */
  adopt(process: PluginProcess, spec: PluginProcessSpec): void {
    const previous = this.process;
    if (previous && previous !== process) this.absorb(previous);
    this.process = process;
    this.spec = spec;
    if (this.idleStopped) this.idleStopped = false;
    else this.restarts += 1;
    if (this.background) process.setBackground(true);
  }

  /** An update takes over: a start of the previous code still under way never serves. */
  takeOver(process: PluginProcess, spec: PluginProcessSpec): void {
    this.generation += 1;
    this.adopt(process, spec);
  }

  private absorb(process: PluginProcess): void {
    this.retired.calls += process.stats.calls;
    this.retired.failures += process.stats.failures;
    this.retired.timeouts += process.stats.timeouts;
  }

  /** The process this slot was serving from is gone. */
  handleExit(process: PluginProcess, reason: PluginExitReason): void {
    if (this.process !== process) return;
    this.absorb(process);
    this.process = undefined;
    if (reason === "crashed" || reason === "unresponsive") {
      this.lastError = process.stats.lastError ?? `the plugin process ${reason}`;
      this.recordCrash();
      this.revive(this.runtime.options.backgroundReviveMs ?? BACKGROUND_REVIVE_MS);
    }
  }

  /**
   * A plugin with background logic is expected to be running, not to wait for
   * the next call that happens to need it. The others start on demand.
   */
  revive(delayMs = 0): void {
    if (!this.background) return;
    const timer = setTimeout(() => {
      if (this.refusal() || this.process) return;
      void this.ensureProcess().catch(() => {});
    }, delayMs);
    timer.unref?.();
  }

  private recordCrash(): void {
    const now = this.runtime.now();
    this.crashes = [...this.crashes.filter((at) => now - at < CRASH_WINDOW_MS), now];
    if (this.crashes.length >= CRASH_LIMIT) {
      this.openCircuit(`the process failed ${CRASH_LIMIT} times within a minute`);
    }
  }

  private openCircuit(why: string): void {
    if (this.circuitOpen) return;
    this.circuitOpen = true;
    this.lastError = `stopped: ${why}${this.lastError ? ` (${this.lastError})` : ""}`;
    this.runtime.options.log?.("native_plugin.circuit_open", {
      plugin: this.candidate.installKey,
      reason: why,
    });
    void this.process?.stop();
  }

  /** Stop the process that is serving, or the one still on its way up. */
  async stopForGood(): Promise<void> {
    await this.starting?.catch(() => {});
    await this.process?.stop();
  }

  /**
   * No longer approved or installed: refused from here on, in every session,
   * and its process stopped, including one that is still starting.
   */
  async fence(): Promise<void> {
    this.fenced = true;
    await this.stopForGood();
  }

  /** Forget past failures: the user asked to try again, or the plugin was updated. */
  resetCircuit(): void {
    this.circuitOpen = false;
    this.crashes = [];
    this.consecutiveFailures = 0;
  }

  reapIfIdle(now: number, idleMs: number): void {
    const process = this.process;
    if (!process?.accepting || this.background) return;
    if (process.inFlight > 0 || now - this.lastCallAt < idleMs) return;
    this.idleStopped = true;
    void process.stop();
  }

  stats(): Pick<
    NativePluginStatus,
    "pid" | "startedAt" | "calls" | "failures" | "timeouts" | "lastError" | "lastErrorAt"
  > {
    const live = this.process?.stats;
    return {
      ...(live?.pid !== undefined && this.process?.isReady ? { pid: live.pid } : {}),
      ...(live?.startedAt !== undefined ? { startedAt: live.startedAt } : {}),
      calls: this.retired.calls + (live?.calls ?? 0),
      failures: this.retired.failures + (live?.failures ?? 0),
      timeouts: this.retired.timeouts + (live?.timeouts ?? 0),
      ...((this.lastError ?? live?.lastError)
        ? { lastError: this.lastError ?? live?.lastError }
        : {}),
      ...(live?.lastErrorAt !== undefined ? { lastErrorAt: live.lastErrorAt } : {}),
    };
  }
}

export class NativePluginRuntime {
  private readonly slots = new Map<string, PluginSlot>();
  /** Why an installed native plugin is not part of this composition. */
  private readonly notes = new Map<string, { state: NativePluginRuntimeState; error?: string }>();
  /** Plugins that could not be loaded when this worker started, and the version that failed. */
  private readonly loadFailures = new Map<string, { recordDigest: string; error: string }>();
  private accepted: PluginAgentModule[] = [];
  private sweeper: ReturnType<typeof setInterval> | undefined;
  private refreshing: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly root = nativeRuntimeRoot();

  constructor(readonly options: NativePluginRuntimeOptions) {}

  now(): number {
    return (this.options.now ?? Date.now)();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private get pidDir(): string {
    return join(this.root, ".pids");
  }

  private logFile(moduleId: string): string {
    return join(this.root, ".logs", `${moduleId}.log`);
  }

  createProcess(
    spec: PluginProcessSpec,
    onExit: (reason: PluginExitReason) => void,
  ): PluginProcess {
    // In use from now on: snapshot collection measures age from the last start.
    touchNativeSnapshot(spec.root);
    return new PluginProcess(spec, {
      entry: this.options.entry,
      setupTimeoutMs: this.options.setupTimeoutMs,
      pingTimeoutMs: this.options.pingTimeoutMs,
      onExit: (info) => onExit(info.reason),
    });
  }

  private specFor(
    candidate: Candidate,
    root: string,
    manifest: NativePluginManifest,
  ): PluginProcessSpec {
    return {
      moduleId: candidate.moduleId,
      plugin: candidate.plugin,
      installKey: candidate.installKey,
      root,
      main: manifest.main,
      dataDir: resolvePluginDataPath(candidate.installKey),
      logFile: this.logFile(candidate.moduleId),
      pidDir: this.pidDir,
      apiVersion: manifest.apiVersion,
      hostKind: this.options.hostKind,
    };
  }

  /** Read the registry: which installs are approved native plugins, and why the others are not. */
  private discover(): {
    candidates: Candidate[];
    ineligible: Map<string, NativePluginInspectionNote>;
  } {
    const candidates: Candidate[] = [];
    const ineligible = new Map<string, NativePluginInspectionNote>();
    for (const [installKey, entries] of Object.entries(readInstalledPlugins().plugins)) {
      // One key, one plugin: its public names come from the key. CodeShell
      // keeps one entry per key; an older registry may hold more, and the
      // newest of them is the one that loads.
      const entry = entries.at(-1);
      if (!entry) continue;
      const inspection = inspectNativePlugin(installKey, entry);
      if (inspection.state === "none") continue;
      const plugin = pluginNameFromKey(installKey);
      if (inspection.state !== "approved" || !entry.contentDigest) {
        ineligible.set(installKey, {
          state: inspection.state === "approved" ? "invalid" : inspection.state,
          ...(inspection.error ? { error: inspection.error } : {}),
        });
        continue;
      }
      candidates.push({
        installKey,
        plugin,
        moduleId: nativeModuleId(plugin, installKey),
        entry,
        recordDigest: entry.contentDigest,
      });
    }
    return { candidates, ineligible };
  }

  /**
   * Snapshot the plugin's files as they are now, start it and check what it
   * registered. Throws with the reason it cannot be loaded.
   */
  private async prepare(candidate: Candidate): Promise<{
    process: PluginProcess;
    spec: PluginProcessSpec;
    declarations: NativeDeclarations;
    onExit: { current?: (reason: PluginExitReason) => void };
    runDigest: string;
  }> {
    const snapshot = prepareNativeSnapshot({
      moduleId: candidate.moduleId,
      installPath: candidate.entry.installPath,
    });
    if (!snapshot.ok) throw new Error(snapshot.reason);
    // The manifest comes from the copy that runs, not from the install
    // directory a moment earlier: local edits can land in between.
    const read = readNativePluginManifest(snapshot.root);
    if (read.kind !== "native") {
      throw new Error(read.kind === "invalid" ? read.error : "the plugin has no native entry");
    }
    const unusable = nativeManifestProblem(candidate.installKey, read.manifest);
    if (unusable) throw new Error(unusable.error);
    const spec = this.specFor(candidate, snapshot.root, read.manifest);
    const onExit: { current?: (reason: PluginExitReason) => void } = {};
    const process = this.createProcess(spec, (reason) => onExit.current?.(reason));
    const declarations = await process.start();
    const problem = validateNativeDeclarations(read.manifest, declarations);
    if (problem) {
      await process.stop();
      throw new Error(problem);
    }
    return { process, spec, declarations, onExit, runDigest: snapshot.digest };
  }

  /**
   * Load every approved native plugin. Returns once each of them has either
   * finished `setup` or been given up on; a plugin can only delay this by its
   * own setup deadline, and none of them can fail the others.
   */
  async start(): Promise<void> {
    const reaped = await reapLeftoverPluginProcesses(this.pidDir);
    if (reaped.length > 0) this.options.log?.("native_plugin.leftovers_stopped", { reaped });

    const { candidates, ineligible } = this.discover();
    for (const [installKey, note] of ineligible) this.notes.set(installKey, note);
    const prepared = await Promise.allSettled(
      candidates.map((candidate) => this.prepare(candidate)),
    );

    // In registry order, so of two plugins that collide the earlier install wins.
    for (const [index, candidate] of candidates.entries()) {
      const outcome = prepared[index]!;
      if (outcome.status === "rejected") {
        this.fail(candidate, describe(outcome.reason));
        continue;
      }
      const { process, spec, declarations, onExit, runDigest } = outcome.value;
      const revision = nativeDeclarationsDigest(declarations);
      const slot = new PluginSlot(
        this,
        candidate,
        spec,
        candidate.recordDigest,
        runDigest,
        revision,
        declarations.background,
        process,
      );
      const module = buildNativeModule({
        moduleId: candidate.moduleId,
        plugin: candidate.plugin,
        declarations,
        calls: slot,
      });
      try {
        compileComposition({
          modules: this.options.baseModules,
          pluginModules: [...this.accepted, { module, revision }],
        });
      } catch (error) {
        await process.stop();
        this.fail(candidate, describe(error));
        continue;
      }
      onExit.current = (reason) => slot.handleExit(process, reason);
      if (declarations.background) process.setBackground(true);
      this.accepted.push({ module, revision });
      this.slots.set(candidate.installKey, slot);
    }

    this.collectSnapshots();
    this.sweeper = setInterval(() => this.sweepIdle(), IDLE_SWEEP_MS);
    this.sweeper.unref?.();
    this.options.log?.("native_plugin.started", {
      loaded: [...this.slots.keys()],
      skipped: [...this.notes.keys()],
    });
  }

  /** Drop old snapshots no loaded plugin runs from. */
  private collectSnapshots(): void {
    collectNativeSnapshots(new Set([...this.slots.values()].map((slot) => slot.spec.root)));
  }

  /** Give back the processes of plugins nobody has called for a while. */
  sweepIdle(): void {
    const now = this.now();
    for (const slot of this.slots.values()) {
      slot.reapIfIdle(now, this.options.idleReapMs ?? IDLE_REAP_MS);
    }
  }

  private fail(candidate: Candidate, error: string): void {
    const { installKey, recordDigest } = candidate;
    this.loadFailures.set(installKey, { recordDigest, error });
    this.notes.set(installKey, { state: "failed", error });
    this.options.log?.("native_plugin.load_failed", { plugin: installKey, error });
  }

  /** The modules to compile into the composition, in registry order. */
  pluginModules(): PluginAgentModule[] {
    return [...this.accepted];
  }

  /** Run `task` after every refresh or restart queued before it, one at a time. */
  private queue(task: () => Promise<void>): Promise<void> {
    const run = this.refreshing.then(() => (this.closed ? undefined : task()));
    // One failed pass must not stop the ones after it.
    this.refreshing = run.catch(() => {});
    return run;
  }

  /**
   * Apply the install registry as it is now. Safe to call often; calls run
   * one at a time. Only what the registry records counts here (approvals,
   * updates, uninstalls): local edits are picked up when a plugin is started
   * again, so files a plugin or its tools write meanwhile swap nothing.
   */
  refresh(): Promise<void> {
    return this.queue(() => this.applyRegistry());
  }

  private async applyRegistry(): Promise<void> {
    const { candidates, ineligible } = this.discover();
    const approved = new Map(candidates.map((candidate) => [candidate.installKey, candidate]));
    this.notes.clear();
    for (const [installKey, note] of ineligible) this.notes.set(installKey, note);

    for (const [installKey, slot] of this.slots) {
      const candidate = approved.get(installKey);
      if (!candidate) {
        // Uninstalled or revoked: withdrawn at once, in every session,
        // including the ones that are running.
        if (!slot.fenced) {
          this.options.log?.("native_plugin.fenced", { plugin: installKey });
          // Refused at once; then its process is stopped, a starting one included.
          await slot.fence();
        }
        continue;
      }
      slot.fenced = false;
      if (candidate.recordDigest === slot.recordDigest) continue;
      // Already tried and reported; it stays that way until the next start.
      if (slot.declined?.recordDigest === candidate.recordDigest) continue;
      await this.replace(slot, candidate);
    }
    for (const candidate of candidates) {
      if (this.slots.has(candidate.installKey)) continue;
      const failure = this.loadFailures.get(candidate.installKey);
      this.notes.set(
        candidate.installKey,
        // The version that failed to load at start is still not loaded.
        failure?.recordDigest === candidate.recordDigest
          ? { state: "failed", error: failure.error }
          : {
              state: "restart-required",
              error: failure
                ? "updated after it failed to load; it loads on the next start"
                : "approved after this worker started; it loads on the next start",
            },
      );
    }
  }

  /**
   * Run a loaded plugin's files as they are on disk now, in place, if nothing
   * the model sees changed. Otherwise the version this composition was built
   * with keeps serving and the reason is reported. Returns whether it took over.
   */
  private async replace(slot: PluginSlot, candidate: Candidate): Promise<boolean> {
    const decline = (state: Declined["state"], error: string) => {
      slot.declined = { recordDigest: candidate.recordDigest, state, error };
      this.options.log?.("native_plugin.not_replaced", { plugin: candidate.installKey, error });
      return false;
    };
    let prepared: Awaited<ReturnType<NativePluginRuntime["prepare"]>>;
    try {
      prepared = await this.prepare(candidate);
    } catch (error) {
      return decline("failed", describe(error));
    }
    if (this.closed) {
      await prepared.process.stop();
      return false;
    }
    if (nativeDeclarationsDigest(prepared.declarations) !== slot.revision) {
      await prepared.process.stop();
      return decline(
        "restart-required",
        "the plugin now declares something different; it loads on the next start",
      );
    }
    // Background logic changes hands without overlap: the old copy's effects
    // are cleaned up before the new copy starts its own.
    if (slot.background) await slot.process?.stopBackground();
    if (this.closed) {
      await prepared.process.stop();
      return false;
    }
    // Read after the wait: the old copy may have been replaced meanwhile.
    const previous = slot.process;
    prepared.onExit.current = (reason) => slot.handleExit(prepared.process, reason);
    slot.recordDigest = candidate.recordDigest;
    slot.runDigest = prepared.runDigest;
    slot.declined = undefined;
    slot.resetCircuit();
    slot.takeOver(prepared.process, prepared.spec);
    this.options.log?.("native_plugin.replaced", { plugin: candidate.installKey });
    // Calls already running finish on the process they started on.
    if (previous && previous !== prepared.process) {
      void previous.retire().then(() => this.collectSnapshots());
    }
    return true;
  }

  /**
   * Give a plugin another chance, with its files as they are on disk now: a
   * local edit that declares the same things takes over in place. One that
   * declares something new, or does not load, is reported and the current
   * version is restarted instead. Returns false when it is not loaded here.
   */
  async restart(installKey: string): Promise<boolean> {
    const slot = this.slots.get(installKey);
    if (!slot || slot.fenced) return false;
    await this.queue(async () => {
      if (slot.fenced) return;
      slot.resetCircuit();
      const files = pluginTreeDigest(slot.candidate.entry.installPath);
      if (files.ok && files.digest !== slot.runDigest) {
        // The user asked to try again: a version reported before is retried.
        if (await this.replace(slot, { ...slot.candidate, recordDigest: slot.recordDigest })) {
          return;
        }
      }
      await slot.process?.stop();
      slot.revive();
    });
    return true;
  }

  status(): NativePluginStatus[] {
    const out: NativePluginStatus[] = [];
    const seen = new Set<string>();
    for (const [installKey, slot] of this.slots) {
      seen.add(installKey);
      const note = slot.fenced
        ? this.notes.get(installKey)
        : (slot.declined ?? this.notes.get(installKey));
      out.push({
        installKey,
        plugin: slot.candidate.plugin,
        moduleId: slot.candidate.moduleId,
        state: slot.fenced
          ? (note?.state ?? "revoked")
          : slot.circuitOpen
            ? "circuit-open"
            : note?.state === "restart-required" || note?.state === "failed"
              ? note.state
              : "running",
        ...(note?.error ? { error: note.error } : {}),
        restarts: slot.restarts,
        ...slot.stats(),
        logFile: slot.spec.logFile,
      });
    }
    for (const [installKey, note] of this.notes) {
      if (seen.has(installKey)) continue;
      const plugin = pluginNameFromKey(installKey);
      const moduleId = nativeModuleId(plugin, installKey);
      out.push({
        installKey,
        plugin,
        moduleId,
        state: note.state,
        ...(note.error ? { error: note.error } : {}),
        restarts: 0,
        calls: 0,
        failures: 0,
        timeouts: 0,
        logFile: this.logFile(moduleId),
      });
    }
    return out;
  }

  /**
   * Stop every plugin process, for good: a call that arrives afterwards is
   * refused instead of starting one again. Called once the worker's sessions
   * are closed, so their last hooks still reach the plugins.
   */
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.sweeper);
    await Promise.allSettled([...this.slots.values()].map((slot) => slot.stopForGood()));
  }
}

type NativePluginInspectionNote = { state: NativePluginRuntimeState; error?: string };
