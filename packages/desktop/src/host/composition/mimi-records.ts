import { nativeExtractionAllowed } from "../../main/pet/pet-native-extraction-policy.js";
import { PetMetadataStore } from "../../main/pet/pet-metadata-store.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { renameSync } from "node:fs";
import { join } from "node:path";
import { selectPetMemories } from "@cjhyy/code-shell-pet";
import type { StateStorage } from "@cjhyy/code-shell-core/internal/storage";
import { PetMemoryStore } from "../../main/pet/pet-memory-store.js";
import { PetJournalStore } from "../../main/pet/pet-journal-store.js";
import { createPetMemoryHost } from "../../main/pet/pet-memory-host.js";
import type { MimiRecordDomain, MimiRecordCall, MimiRecords } from "../../shared/mimi-records.js";
import { claimBusinessCommit, type BusinessMethods } from "./business-calls.js";

export class StoredMimiRecords {
  private readonly grants = new AsyncLocalStorage<{ permit: Int32Array; autoSessionId?: string }>();
  private readonly memory: PetMemoryStore;
  private readonly metadata: PetMetadataStore;
  private readonly journal: PetJournalStore;
  constructor(dir: string) {
    const replaceFile = async (from: string, to: string) => {
      const grant = this.grants.getStore();
      if (!grant) throw Error("Missing Mimi write grant");
      if (grant.autoSessionId && !nativeExtractionAllowed(grant.autoSessionId))
        throw Error("Mimi extraction disabled");
      claimBusinessCommit(grant.permit);
      renameSync(from, to);
    };
    this.metadata = new PetMetadataStore(join(dir, "metadata.json"));
    this.memory = new PetMemoryStore(join(dir, "memories.json"), { replaceFile });
    this.journal = new PetJournalStore(join(dir, "journal.json"), { replaceFile });
  }
  async run({
    call,
    permit,
    autoSessionId,
  }: {
    call: MimiRecordCall;
    permit: Int32Array;
    autoSessionId?: string;
  }) {
    if (autoSessionId && (await this.metadata.ensure()).petSessionId !== autoSessionId)
      throw Error("Mimi session changed");
    return this.grants.run({ permit, autoSessionId }, async () => {
      let result: unknown;
      let changed: MimiRecordDomain | undefined;
      switch (call.action) {
        case "metadata":
          result = await this.metadata.ensure();
          break;
        case "memoryList":
          await this.memory.load();
          result = this.memory.list();
          break;
        case "memoryRecall":
          await this.memory.load();
          result = selectPetMemories(this.memory.list(), ...call.args);
          break;
        case "memoryAction":
          await this.memory.load();
          result = await createPetMemoryHost(this.memory)(...call.args);
          changed = "memories";
          break;
        case "remember":
          result = await this.memory.remember(...call.args);
          changed = "memories";
          break;
        case "update":
          result = await this.memory.update(...call.args);
          changed = "memories";
          break;
        case "forget":
          result = await this.memory.forget(...call.args);
          changed = "memories";
          break;
        case "journalList":
          await this.journal.load();
          result = this.journal.list();
          break;
        case "journalIds":
          await this.journal.load();
          result = [...this.journal.recordedSegmentIds()];
          break;
        case "record":
          result = await this.journal.record(...call.args);
          changed = "journal";
          break;
        default:
          throw Error("Unknown Mimi record request");
      }
      return { result, changed };
    });
  }
}
export function mimiRecordsOperations(
  storage: Promise<StateStorage>,
  announce: (domain: MimiRecordDomain) => void,
) {
  return {
    async "mimi/workMemory"(input, grant) {
      const db = await storage;
      grant.assertCurrent();
      // These are lifecycle commands from the authenticated Mimi manager.
      const row = await db.request<import("../../shared/mimi-work-memory.js").MimiWorkSnapshot>(
        "mimi/workMemory",
        input,
      );
      if (!row) throw Error("Mimi work memory unavailable");
      return row;
    },
    async "mimi/records"(call, grant) {
      const db = await storage;
      grant.assertCurrent();
      const row = await db.request<Awaited<ReturnType<StoredMimiRecords["run"]>>>("mimi/records", {
        call,
        permit: grant.permit,
      });
      if (!row) throw Error("Mimi storage unavailable");
      if (row.changed) announce(row.changed);
      return row.result;
    },
  } satisfies Pick<BusinessMethods, "mimi/records" | "mimi/workMemory">;
}

export async function readMimiList<K extends "memoryList" | "journalList">(
  storage: Promise<StateStorage>,
  action: K,
) {
  const db = await storage;
  const row = await db.request<{ result: ReturnType<MimiRecords[K]> }>("mimi/records", {
    call: { action, args: [] },
  });
  if (!row) throw Error("Mimi storage unavailable");
  return row.result;
}
