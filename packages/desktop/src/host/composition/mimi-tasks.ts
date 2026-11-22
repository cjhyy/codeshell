import { AsyncLocalStorage } from "node:async_hooks";
import { renameSync } from "node:fs";
import { join } from "node:path";
import {
  PetLongTaskCoordinator,
  type PetLongTaskCoordinatorOptions,
  type PetLongTaskWorker,
} from "../../main/pet/pet-long-task-coordinator.js";
import { PetLongTaskStore } from "../../main/pet/pet-long-task-store.js";
import type {
  DesktopPetProjectionEvent,
  DesktopPetProjectionSnapshot,
} from "../../main/pet/pet-state-aggregator.js";
import { PrivateHostPeer, type PrivatePort } from "../native-peer.js";
import type { MimiTaskCommand } from "../../shared/mimi-tasks.js";
import type { BusinessGrant } from "./business-calls.js";
import { dlog } from "../../main/desktop-logger.js";

/** Owns the durable task transitions, per-session ordering, reconciliation and closure receipts. */
export class HostedMimiTasks {
  private readonly pendingGrant = new AsyncLocalStorage<{
    grant: BusinessGrant;
    committed: boolean;
  }>();
  private readonly store: PetLongTaskStore;
  private readonly coordinator: PetLongTaskCoordinator;
  private readonly subscribers = new Set<(event: DesktopPetProjectionEvent) => void>();
  private peer?: PrivateHostPeer;
  private notified = false;
  private loaded?: Promise<void>;
  private startup?: Promise<void>;
  private stopped = false;
  constructor(directory: string) {
    this.store = new PetLongTaskStore(
      join(directory, "long-tasks.json"),
      Date.now,
      async (from, to) => {
        if (this.stopped) throw Error("Mimi tasks closed");
        const admission = this.admission();
        renameSync(from, to);
        if (admission) admission.committed = true;
      },
    );
    this.store.subscribe(() => {
      if (this.notified || !this.peer) return;
      this.notified = true;
      void this.native("changed", null).catch(() => {});
    });
    const callback =
      (
        name: "closed" | "delegationStarted" | "workMemory",
      ): NonNullable<PetLongTaskCoordinatorOptions["onTaskClosed"]> =>
      (task) =>
        this.native<void>(name, task, true);
    this.coordinator = new PetLongTaskCoordinator({
      store: this.store,
      projection: {
        getSnapshot: () => this.native<DesktopPetProjectionSnapshot>("snapshot", null),
        subscribe: (listener) => {
          this.subscribers.add(listener);
          return () => this.subscribers.delete(listener);
        },
      },
      launcher: { start: (input) => this.native("launch", input, true) },
      worker: {
        hasLiveWorker: (id) => this.native<boolean>("liveWorker", id),
        requestWorker: (...args) =>
          this.native<Awaited<ReturnType<PetLongTaskWorker["requestWorker"]>>>(
            "worker",
            args,
            args[0] !== "agent/goalGet",
          ),
      },
      onDelegationStarted: callback("delegationStarted"),
      onTaskClosed: callback("closed"),
      onTaskWorkMemory: callback("workMemory"),
      onBackgroundError: (operation, error) =>
        dlog("main", `pet.longTask.${operation}.failed`, { error: String(error) }),
    });
  }
  private admission() {
    const admission = this.pendingGrant.getStore();
    if (admission && !admission.committed) admission.grant.assertCurrent();
    return admission;
  }
  private native<T>(method: string, input: unknown, effect = false): Promise<T> {
    const admission = this.admission();
    if (this.stopped || !this.peer) throw Error("Native Mimi task adapter disconnected");
    // Once a write or worker command is admitted, its acknowledgement and remaining
    // task bookkeeping must finish even if the originating window goes away.
    if (effect && admission) admission.committed = true;
    return this.peer.call<T>(
      method,
      input,
      admission?.committed ? undefined : admission?.grant.signal,
    );
  }
  bind(port: PrivatePort) {
    this.peer?.close();
    this.notified = false;
    const next: PrivateHostPeer = new PrivateHostPeer(
      port,
      () => {
        throw Error("Mimi task native port only accepts adapter replies");
      },
      () => {
        if (this.peer === next) this.peer = undefined;
      },
    );
    this.peer = next;
  }
  async snapshot() {
    await (this.loaded ??= this.store.load());
    await this.store.flush();
    if (this.stopped) throw Error("Mimi tasks disconnected");
    return this.store.getSnapshot();
  }
  async run(command: MimiTaskCommand, grant: BusinessGrant) {
    if (this.stopped) throw Error("Mimi tasks disconnected");
    return this.pendingGrant.run({ grant, committed: false }, async () => {
      await (this.loaded ??= this.store.load());
      await this.store.flush();
      grant.assertCurrent();
      switch (command.method) {
        case "getSnapshot":
          this.notified = false;
          return this.store.getSnapshot();
        case "get":
          return this.store.get(...command.args);
        case "activeForSession":
          return this.store.activeForSession(...command.args);
      }
      if (!this.peer) throw Error("Mimi tasks not connected");
      if (command.method === "start") {
        this.startup ??= this.coordinator.start({ alreadyLoaded: true }).catch((error) => {
          this.coordinator.stop();
          this.startup = undefined;
          throw error;
        });
        await this.startup;
        return;
      }
      if (!this.startup) throw Error("Mimi tasks not initialized");
      // Reverse callbacks during startup replay may inspect the loaded ledger.
      switch (command.method) {
        case "projection":
          for (const notify of this.subscribers) notify(...command.args);
          return;
        case "observeSessionEvent":
          return this.coordinator.observeTaskEvent(...command.args);
        case "recordClosureDecision":
          return this.coordinator.recordClosureDecision(...command.args);
        case "recordContinuationStarted":
          return this.coordinator.recordContinuationStarted(...command.args);
        case "reconcileNow":
          return this.coordinator.reconcileNow();
        case "watchSession":
          return this.coordinator.watchSession(...command.args);
        case "control":
          return this.coordinator.control(...command.args);
        case "startDelegation":
          return this.coordinator.startDelegation(...command.args);
        case "clearTerminal":
          return this.coordinator.clearTerminal();
        case "clearTerminalTask":
          return this.coordinator.clearTerminalTask(...command.args);
        default:
          throw Error("Unknown Mimi task operation");
      }
    });
  }
  async close() {
    this.stopped = true;
    this.coordinator.stop();
    this.peer?.close();
    this.peer = undefined;
    await this.store.flush();
  }
}
