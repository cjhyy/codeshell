import type { MemoryOperations } from "../shared/memory-contracts.js";
import { claimBusinessCommit } from "../host/composition/business-calls.js";
import { requireRendererProjectPath } from "./renderer-project-path.js";
import {
  memoryCwd,
  memoryName,
  memorySelection,
  namedMemory,
} from "./desktop-host/memory-reads.js";
import { ProfileMemoryPromotionReviews } from "./profile-memory-promotion-service.js";
import {
  saveMemory,
  deleteMemory,
  approvePendingMemory,
  demotePendingMemory,
  rejectPendingMemory,
  promoteMemoryToGlobal,
} from "./memory-service.js";

type Stored = Exclude<keyof MemoryOperations, "memory/dream">;
type Handlers = {
  [K in Stored]: (
    input: MemoryOperations[K]["input"],
    beforeWrite: () => void,
  ) => MemoryOperations[K]["result"] | Promise<MemoryOperations[K]["result"]>;
};
const reviews = new ProfileMemoryPromotionReviews();
const handlers: Handlers = {
  async "memory/save"(input, beforeWrite) {
    const selection = memorySelection({ ...input });
    const { name, description, content, type, id, pinned, origin } = input;
    memoryName(name);
    if (
      !name.trim() ||
      typeof description !== "string" ||
      description.length > 4096 ||
      typeof content !== "string" ||
      content.length > 1024 * 1024 ||
      !["user", "feedback", "project", "reference"].includes(type) ||
      (id !== undefined &&
        (typeof id !== "string" || !id || id.length > 512 || id.includes("\0"))) ||
      (pinned !== undefined && typeof pinned !== "boolean") ||
      (origin !== undefined && !["auto", "manual", "dream"].includes(origin))
    )
      throw new Error("invalid memory payload");
    return saveMemory(
      {
        ...selection,
        cwd: await memoryCwd(selection),
        name,
        description,
        content,
        type,
        id,
        pinned,
        origin,
      },
      beforeWrite,
    );
  },
  async "memory/delete"(value, beforeWrite) {
    const input = namedMemory(value);
    return deleteMemory(
      input.level,
      input.scope,
      input.name,
      await memoryCwd(input),
      input.profileName,
      beforeWrite,
    );
  },
  "memory/approve": ({ name }, beforeWrite) => approvePendingMemory(memoryName(name), beforeWrite),
  "memory/demote": ({ name }, beforeWrite) => demotePendingMemory(memoryName(name), beforeWrite),
  "memory/reject": ({ name }, beforeWrite) => rejectPendingMemory(memoryName(name), beforeWrite),
  "memory/promote": async ({ name, cwd }, beforeWrite) =>
    promoteMemoryToGlobal(await requireRendererProjectPath(cwd), memoryName(name), beforeWrite),
  "memory/previewProfilePromotion": async ({ owner, value }, beforeWrite) => {
    const cwd = await requireRendererProjectPath(value.cwd);
    return reviews.preview(owner, { ...value, cwd }, beforeWrite);
  },
  "memory/commitProfilePromotion": async ({ owner, value }, beforeWrite) => {
    const cwd = await requireRendererProjectPath(value.cwd);
    return reviews.commit(owner, { ...value, cwd }, beforeWrite);
  },
  "memory/discardProfilePromotion": ({ owner }) => reviews.clearOwner(owner),
};
export const isMemoryCommand = (method: string): method is Stored =>
  Object.hasOwn(handlers, method);
export async function writeHostedMemory<K extends Stored>(
  method: K,
  { input, permit }: { input: MemoryOperations[K]["input"]; permit: Int32Array },
) {
  let committed = false;
  const beforeWrite = () => {
    if (!committed) {
      claimBusinessCommit(permit);
      committed = true;
    }
  };
  return { result: await handlers[method](input, beforeWrite) };
}
