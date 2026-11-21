import type { selectPetMemories } from "@cjhyy/code-shell-pet";
import type { PetMemoryStore, PetMemoryEntry } from "../main/pet/pet-memory-store.js";
import type { PetJournalEntry, PetJournalRecord } from "../main/pet/pet-journal-store.js";
import type { PetHostActionContext } from "../main/pet/pet-dispatch-service.js";

export type MimiRecordDomain = "memories" | "journal";
export interface MimiRecords {
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
