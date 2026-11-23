import type { MemorySelection } from "../../shared/memory-contracts.js";
import { listMemory, listPendingMemory, readMemory } from "../memory-service.js";
import { requireRendererProjectPath } from "../renderer-project-path.js";
import { businessArguments, businessRead, noBusinessArguments } from "./business-read.js";

export function memoryName(value: unknown) {
  if (typeof value !== "string" || !value || value.length > 512 || value.includes("\0"))
    throw new Error("bounded memory name required");
  return value;
}
export function memorySelection(value: Record<string, unknown>): MemorySelection {
  const { level, scope, cwd, profileName } = value;
  if (level !== "user" && level !== "project" && level !== "profile")
    throw new Error("invalid memory level");
  if (scope !== "user" && scope !== "dream") throw new Error("invalid memory scope");
  if (cwd !== undefined && typeof cwd !== "string") throw new Error("invalid memory cwd");
  if (profileName !== undefined && typeof profileName !== "string")
    throw new Error("invalid profile name");
  return { level, scope, cwd, profileName };
}
export async function memoryCwd({ level, cwd }: { level: string; cwd?: string }) {
  return level === "project" || cwd ? requireRendererProjectPath(cwd) : undefined;
}
const fields = ["level", "scope", "cwd", "profileName"];
export function namedMemory(value: unknown) {
  const args = businessArguments(value, [...fields, "name"]);
  return { ...memorySelection(args), name: memoryName(args.name) };
}
export function memoryListInput(value: unknown) {
  return memorySelection(businessArguments(value, fields));
}
export const readMemoryList = async (input: MemorySelection) =>
  listMemory(input.level, input.scope, await memoryCwd(input), input.profileName);
export const readMemoryBody = async (input: MemorySelection & { name: string }) =>
  readMemory(input.level, input.scope, input.name, await memoryCwd(input), input.profileName);
export const memoryReads = [
  businessRead("memory/list", memoryListInput, readMemoryList),
  businessRead("memory/read", namedMemory, readMemoryBody),
  businessRead("memory/pending", noBusinessArguments, listPendingMemory),
];
