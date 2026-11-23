import {
  buildPetLongTaskContext,
  type PetLongTask,
  type PetLongTaskSnapshot,
} from "@cjhyy/code-shell-pet";
import type {
  PetLongTaskCoordinatorOptions,
  PetLongTaskWorker,
} from "../pet/pet-long-task-coordinator.js";
import { projectMimiTaskEvent } from "../../shared/mimi-task-event.js";
import type { PetLongTaskCoordinator } from "../pet/pet-long-task-coordinator.js";
import { PrivateHostPeer, type PrivatePort } from "../../host/native-peer.js";
import type {
  DirectMimiTask,
  MimiTaskArgs,
  MimiTaskCommand,
  MimiTaskResult,
} from "../../shared/mimi-tasks.js";

type NativeServices = Omit<PetLongTaskCoordinatorOptions, "store" | "projection">;
const workerMethods = new Set([
  "agent/cancel",
  "agent/goalGet",
  "agent/goalUpdate",
  "agent/goalClear",
]);

export class NativeMimiTasks {
  private services?: NativeServices;
  private peer?: PrivateHostPeer;
  private enabled = false;
  private firstStart?: ReturnType<typeof Promise.withResolvers<void>>;
  private subscribers = new Set<(snapshot: PetLongTaskSnapshot) => void>();
  constructor(
    private readonly business: (cmd: MimiTaskCommand, signal?: AbortSignal) => Promise<unknown>,
    private readonly connect: () => Promise<void> | void,
  ) {}
  get needsPort() {
    return this.enabled && !this.peer;
  }
  configure(services: NativeServices) {
    this.services = services;
    return this;
  }
  async start() {
    if (!this.services) throw Error("Native Mimi services are not configured");
    if (this.firstStart) return this.firstStart.promise;
    this.enabled = true;
    const ready = (this.firstStart = Promise.withResolvers<void>());
    Promise.resolve(this.connect()).catch(ready.reject);
    return ready.promise;
  }
  bind(port: PrivatePort) {
    this.disconnect();
    const services = this.services;
    if (!this.enabled || !services) {
      port.close();
      return;
    }
    let publishedRevision = -1;
    const peer = (this.peer = new PrivateHostPeer(port, async (method, input, signal) => {
      signal.throwIfAborted();
      switch (method) {
        case "liveWorker":
          return services.worker.hasLiveWorker(input as string | undefined);
        case "worker": {
          const args = input as Parameters<PetLongTaskWorker["requestWorker"]>;
          if (!Array.isArray(args) || !workerMethods.has(args[0]))
            throw Error("Unknown Mimi worker control");
          return services.worker.requestWorker(...args);
        }
        case "launch":
          return services.launcher.start(
            input as Parameters<NativeServices["launcher"]["start"]>[0],
          );
        case "closed":
          return services.onTaskClosed?.(input as PetLongTask);
        case "delegationStarted":
          return services.onDelegationStarted?.(input as PetLongTask);
        case "workMemory":
          return services.onTaskWorkMemory?.(input as PetLongTask);
        case "changed": {
          const snapshot = await this.getSnapshot();
          if (this.peer === peer && snapshot.revision > publishedRevision) {
            publishedRevision = snapshot.revision;
            for (const listener of this.subscribers) listener(snapshot);
          }
          return;
        }
        default:
          throw Error("Unexpected native Mimi adapter");
      }
    }));
    void this.run("start", [])
      .then(async () => {
        if (this.peer !== peer) return;
        await this.reconcileNow();
        if (this.peer !== peer) return;
        this.firstStart?.resolve();
      })
      .catch((e) => {
        if (this.peer !== peer) return;
        this.firstStart?.reject(e);
        services.onBackgroundError?.("start", e);
      });
  }
  disconnect() {
    this.peer?.close();
    this.peer = undefined;
  }
  stop() {
    this.enabled = false;
    this.disconnect();
    this.firstStart?.reject(Error("Mimi tasks closed"));
  }
  subscribe(listener: (snapshot: PetLongTaskSnapshot) => void) {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }
  private run<K extends keyof DirectMimiTask>(
    method: K,
    args: MimiTaskArgs<K>,
    signal?: AbortSignal,
  ) {
    return this.business({ method, args } as MimiTaskCommand, signal) as Promise<MimiTaskResult<K>>;
  }
  getSnapshot() {
    return this.run("getSnapshot", []);
  }
  get(id: string) {
    return this.run("get", [id]);
  }
  activeForSession(id: string) {
    return this.run("activeForSession", [id]);
  }
  async context() {
    return buildPetLongTaskContext((await this.getSnapshot()).tasks);
  }
  startDelegation(...args: MimiTaskArgs<"startDelegation">) {
    return this.run("startDelegation", args);
  }
  watchSession(...args: MimiTaskArgs<"watchSession">) {
    return this.run("watchSession", args);
  }
  control(input: MimiTaskArgs<"control">[0], signal?: AbortSignal) {
    return this.run("control", [input], signal);
  }
  clearTerminal(signal?: AbortSignal) {
    return this.run("clearTerminal", [], signal);
  }
  clearTerminalTask(id: string, signal?: AbortSignal) {
    return this.run("clearTerminalTask", [id], signal);
  }
  reconcileNow() {
    return this.run("reconcileNow", []);
  }
  recordClosureDecision(...args: MimiTaskArgs<"recordClosureDecision">) {
    return this.run("recordClosureDecision", args);
  }
  recordContinuationStarted(...args: MimiTaskArgs<"recordContinuationStarted">) {
    return this.run("recordContinuationStarted", args);
  }
  observeSessionEvent(
    ...[id, value, outcomes]: Parameters<PetLongTaskCoordinator["observeSessionEvent"]>
  ) {
    if (!this.enabled) return Promise.resolve();
    const event = projectMimiTaskEvent(value);
    return event ? this.run("observeSessionEvent", [id, event, outcomes]) : Promise.resolve();
  }
}
