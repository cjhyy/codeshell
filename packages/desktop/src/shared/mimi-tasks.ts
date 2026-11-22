import type { PetLongTaskCoordinator } from "../main/pet/pet-long-task-coordinator.js";
import type { PetLongTaskStore } from "../main/pet/pet-long-task-store.js";

export type DirectMimiTask = Pick<
  PetLongTaskCoordinator,
  | "startDelegation"
  | "watchSession"
  | "control"
  | "clearTerminal"
  | "clearTerminalTask"
  | "reconcileNow"
  | "recordClosureDecision"
  | "recordContinuationStarted"
> &
  Pick<PetLongTaskStore, "getSnapshot" | "get" | "activeForSession"> & {
    observeSessionEvent: PetLongTaskCoordinator["observeTaskEvent"];
    start(): Promise<void>;
  };
export type MimiTaskArgs<K extends keyof DirectMimiTask> = Parameters<DirectMimiTask[K]>;
export type MimiTaskResult<K extends keyof DirectMimiTask> = Awaited<ReturnType<DirectMimiTask[K]>>;
export type MimiTaskCommand = {
  [K in keyof DirectMimiTask]: { method: K; args: MimiTaskArgs<K> };
}[keyof DirectMimiTask];
