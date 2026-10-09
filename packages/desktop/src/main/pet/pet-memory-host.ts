import { selectPetMemories } from "@cjhyy/code-shell-pet";
import type { MobileRemoteGatewayStatus } from "../im-gateway-control-server.js";
import type { PetHostActionContext, PetWorldContextInput } from "./pet-dispatch-service.js";
import type { PetMemoryStore } from "./pet-memory-store.js";

export function createPetMemoryHost(store: PetMemoryStore) {
  return async (
    payload: Record<string, unknown>,
    context?: PetHostActionContext,
  ): Promise<Record<string, unknown>> => {
    const action = payload.action;
    const text = typeof payload.text === "string" ? payload.text : "";
    const memoryId = typeof payload.memoryId === "string" ? payload.memoryId : "";
    if (action === "remember") {
      const before = new Map(store.list().map((entry) => [entry.id, entry] as const));
      const entry = await store.remember(text, "mimi", {
        originRef: context?.originRef,
        taskIds: context?.groundedTasks?.map((task) => task.taskId),
      });
      const previous = before.get(entry.id);
      const unchanged =
        previous !== undefined &&
        previous.text === entry.text &&
        previous.source === entry.source &&
        previous.updatedAt === entry.updatedAt;
      return { action, id: entry.id, ...(unchanged ? { unchanged: true } : {}) };
    }
    if (action === "update") {
      const entry = await store.update(memoryId, text);
      return { action, id: entry.id };
    }
    if (action === "forget") {
      const entry = await store.forget(memoryId);
      return { action, id: entry.id };
    }
    throw new Error("invalid memory action");
  };
}

/** Every manager turn recalls from the same durable store the Host action edits. */
export function createPetMemoryWorldContext(
  store: PetMemoryStore,
  remoteStatus: () => MobileRemoteGatewayStatus,
) {
  return async (input: PetWorldContextInput): Promise<Record<string, unknown>> => {
    await store.load();
    const remote = remoteStatus();
    const recalled = selectPetMemories(store.list(), {
      message: input.message,
      originRef: input.originRef,
      groundedObjectives: input.groundedTasks.map((task) => task.objective),
      taskIds: input.groundedTasks.map((task) => task.taskId),
    });
    return {
      ...recalled,
      mobileRemote: {
        running: remote.running,
        tunnelConnected: remote.tunnelConnected,
        passcodeSet: remote.passcodeSet,
        ...(remote.url ? { url: remote.url } : {}),
      },
    };
  };
}
