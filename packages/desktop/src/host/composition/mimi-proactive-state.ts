import { AsyncLocalStorage } from "node:async_hooks";
import { renameSync } from "node:fs";
import { join } from "node:path";
import { PetProactiveStateStore } from "../../main/pet/pet-proactive-state.js";
import type {
  MimiProactiveCommand,
  MimiProactiveReply,
} from "../../shared/mimi-proactive-state.js";
import { claimBusinessCommit } from "./business-calls.js";

export function storedMimiProactiveState(petDir: string) {
  const grants = new AsyncLocalStorage<Int32Array>();
  const store = new PetProactiveStateStore(join(petDir, "proactive.json"), async (from, to) => {
    const grant = grants.getStore();
    if (!grant) throw Error("Missing Mimi heartbeat grant");
    claimBusinessCommit(grant);
    renameSync(from, to);
  });
  return async ({
    call,
    permit,
  }: {
    call: MimiProactiveCommand;
    permit: Int32Array;
  }): Promise<MimiProactiveReply> => {
    if (!(permit instanceof Int32Array) || Atomics.load(permit, 0) < 0)
      throw Error("Mimi heartbeat grant expired");
    return grants.run(permit, async () =>
      call.type === "read"
        ? { state: await store.read() }
        : { committed: await store.change(call) },
    );
  };
}
