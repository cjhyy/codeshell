import type { PetWorkInboxStore } from "../main/pet/pet-work-inbox-store.js";
import type { selectPetMemories } from "@cjhyy/code-shell-pet";
import type { PetMemoryStore, PetMemoryEntry } from "../main/pet/pet-memory-store.js";
import type { PetJournalEntry, PetJournalRecord } from "../main/pet/pet-journal-store.js";
import type { PetHostActionContext } from "../main/pet/pet-dispatch-service.js";

export type MimiRecordDomain = "memories" | "journal" | "work-inbox";
export interface MimiRecords {
  inboxSnapshot(): ReturnType<PetWorkInboxStore["getSnapshot"]>;
  inboxAdd(ids: readonly string[]): Awaited<ReturnType<PetWorkInboxStore["addDurably"]>>;
  inboxClear(): Awaited<ReturnType<PetWorkInboxStore["clearDurably"]>>;
  inboxClaim(id: string): Awaited<ReturnType<PetWorkInboxStore["addIfAbsentDurably"]>>;
  metadata(): import("../main/pet/pet-metadata-store.js").LocalPetMetadata;
  memoryList(): PetMemoryEntry[];
  memoryRecall(
    input: Parameters<typeof selectPetMemories>[1],
  ): ReturnType<typeof selectPetMemories>;
  memoryAction(
    payload: Record<string, unknown>,
    context?: Pick<PetHostActionContext, "originRef" | "groundedTasks">,
  ): Record<string, unknown>;
  remember(...args: Parameters<PetMemoryStore["remember"]>): PetMemoryEntry;
  update(id: string, text: string): PetMemoryEntry;
  forget(id: string): PetMemoryEntry;
  journalList(): PetJournalEntry[];
  journalIds(): string[];
  record(input: PetJournalRecord): PetJournalEntry;
}
export type MimiRecordCall = {
  [K in keyof MimiRecords]: { action: K; args: Parameters<MimiRecords[K]> };
}[keyof MimiRecords];

export function parseMimiSegmentRange(input: unknown): { start: number; end: number } {
  const row = input as { start?: unknown; end?: unknown } | undefined;
  if (
    !row ||
    typeof row !== "object" ||
    typeof row.start !== "number" ||
    typeof row.end !== "number" ||
    !Number.isSafeInteger(row.start) ||
    !Number.isSafeInteger(row.end) ||
    row.start < 0 ||
    row.end < row.start
  )
    throw Error("invalid segment transcript range");
  return { start: row.start, end: row.end };
}
