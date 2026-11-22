import type { ProfileLibraryReads } from "./profile-library.js";
import type { ActivityReads } from "./activity-history-contracts.js";
import type { CcRoomReads } from "./cc-room-reads.js";
import type { MemoryReads } from "./memory-contracts.js";
import type { WorkspaceReadContracts } from "./workspace-read-contracts.js";
import type { ConfigurationReadContracts } from "./configuration-read-contracts.js";

/** The workbench port advertises each supported read separately. Add a fixed
 * business method here and register its parser/implementation in the Host. */
export interface DesktopBusinessReads
  extends ProfileLibraryReads, ActivityReads, CcRoomReads, MemoryReads, ConfigurationReadContracts, WorkspaceReadContracts {
  "mimi/longTasks": {params:Record<string,never>;result:import("@cjhyy/code-shell-pet").PetLongTaskSnapshot};
  "mimi/workInbox": {params: Record<string, never>;result: ReturnType<import("./mimi-records.js").MimiRecords["inboxSnapshot"]>};
  "mimi/segmentMessages": { params:{start:number;end:number};result: import("../preload/pet-api.js").PetSegmentMessage[] };
  "mimi/workMemory": {
    params: Record<string, never>;
    result: ReturnType<typeof import("./mimi-work-memory.js").mimiWorkView>;
  };
  "mimi/memories": {
    params: Record<string, never>;
    result: import("../main/pet/pet-memory-store.js").PetMemoryEntry[];
  };
  "mimi/journal": {
    params: Record<string, never>;
    result: import("../main/pet/pet-journal-store.js").PetJournalEntry[];
  };
  "catalog/load": {
    params: Record<string, never>;
    result: import("./session-catalog.js").SessionCatalogSnapshot;
  };
  "models/catalog": {
    params: Record<string, never>;
    result: ReturnType<typeof import("@cjhyy/code-shell-core/internal").getMergedCatalog>;
  };
  "models/catalogOrigins": {
    params: Record<string, never>;
    result: ReturnType<typeof import("@cjhyy/code-shell-core/internal").catalogEntryOrigins>;
  };
}
