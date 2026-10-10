import type { CollectionEntry, SourceDefinition } from "@cjhyy/code-shell-core";

export interface SourceCollectionView {
  definition: SourceDefinition;
  revision: string;
  entries: Array<{
    entry: CollectionEntry;
    status: "ready" | "changed" | "missing" | "unchecked";
  }>;
  /** Registered projects only; original files never belong to the collection. */
  references: Array<{ projectId: string; name: string }>;
}

export type SourceCollectionChange =
  | { kind: "metadata"; label: string; description?: string; enabled: boolean }
  | { kind: "remove"; entryId: string }
  | { kind: "refresh"; entryId: string }
  | { kind: "url"; url: string };

export interface SourceCollectionApi {
  create(input: { label: string; description?: string }): Promise<SourceCollectionView>;
  get(id: string): Promise<SourceCollectionView>;
  update(
    id: string,
    revision: string,
    change: SourceCollectionChange,
  ): Promise<SourceCollectionView>;
  /** Null means the native picker was cancelled; no changes were made. */
  pick(
    id: string,
    revision: string,
    mode: "files" | "folder",
  ): Promise<SourceCollectionView | null>;
  delete(id: string, revision: string): Promise<void>;
}
