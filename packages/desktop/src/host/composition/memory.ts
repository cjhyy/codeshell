import type { StateStorage } from "@cjhyy/code-shell-core/internal/storage";
import type { MemoryOperations, PrivateMemoryReads } from "../../shared/memory-contracts.js";
import type { BusinessGrant, BusinessMethods } from "./business-calls.js";
import {
  memoryCwd,
  memoryListInput,
  namedMemory,
  readMemoryBody,
  readMemoryList,
} from "../../main/desktop-host/memory-reads.js";
import { listPendingMemory } from "../../main/memory-service.js";
import { runDream } from "../../main/dream-service.js";
export function memoryOperations(storage: Promise<StateStorage>) {
  function route<K extends Exclude<keyof MemoryOperations, "memory/dream">>(method: K) {
    return async (input: MemoryOperations[K]["input"], grant: BusinessGrant) => {
      const owner = await storage;
      grant.assertCurrent();
      const reply = await owner.request<{ result: MemoryOperations[K]["result"] }>(method, {
        input,
        permit: grant.permit,
      });
      if (!reply) throw new Error("Memory storage unavailable");
      return reply.result;
    };
  }
  return {
    "memory/list": (args) => readMemoryList(memoryListInput(args)),
    "memory/read": (args) => readMemoryBody(namedMemory(args)),
    "memory/pending": () => listPendingMemory(),
    "memory/save": route("memory/save"),
    "memory/delete": route("memory/delete"),
    "memory/approve": route("memory/approve"),
    "memory/demote": route("memory/demote"),
    "memory/reject": route("memory/reject"),
    "memory/promote": route("memory/promote"),
    "memory/previewProfilePromotion": route("memory/previewProfilePromotion"),
    "memory/commitProfilePromotion": route("memory/commitProfilePromotion"),
    "memory/discardProfilePromotion": route("memory/discardProfilePromotion"),
    async "memory/dream"(input, grant) {
      if (input.level !== "user" && input.level !== "project")
        throw new Error("invalid dream level");
      const cwd = await memoryCwd(input);
      grant.assertCurrent();
      return runDream(input.level, cwd, grant.signal);
    },
  } satisfies Pick<BusinessMethods, keyof MemoryOperations | keyof PrivateMemoryReads>;
}
