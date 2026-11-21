import type { CcRoomReads } from "./cc-room-reads.js";
import type { MemoryReads } from "./memory-contracts.js";
import type { WorkspaceReadContracts } from "./workspace-read-contracts.js";
import type { ConfigurationReadContracts } from "./configuration-read-contracts.js";

/** The workbench port advertises each supported read separately. Add a fixed
 * business method here and register its parser/implementation in the Host. */
export interface DesktopBusinessReads
  extends CcRoomReads, MemoryReads, ConfigurationReadContracts, WorkspaceReadContracts {
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
