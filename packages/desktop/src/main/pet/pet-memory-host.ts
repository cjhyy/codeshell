import type { PetHostActionContext } from "./pet-dispatch-service.js";
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
