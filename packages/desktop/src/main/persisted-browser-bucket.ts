import type { SessionCatalogSnapshot } from "../shared/session-catalog.js";

interface PersistedBrowserBucketOptions {
  sessionId: string;
  projectKey: string;
  requestedBucket?: string;
  readCatalog(): SessionCatalogSnapshot;
}

/** Select only a Main-persisted UI alias for this engine Session and project. */
export function resolvePersistedBrowserBucket({
  sessionId,
  projectKey,
  requestedBucket,
  readCatalog,
}: PersistedBrowserBucketOptions): { bucket: string; assertCurrent(): void } {
  const readRows = () => readCatalog().indices[projectKey]?.sessions ?? [];
  const initialRows = readRows();
  const rows = initialRows.filter((row) => (row.engineSessionId ?? row.id) === sessionId);
  const canonical = `${projectKey}::${sessionId}`;
  let selectedId: string | undefined;
  if (requestedBucket !== undefined) {
    selectedId = rows.find((row) => `${projectKey}::${row.id}` === requestedBucket)?.id;
    if (selectedId === undefined && (rows.length > 0 || requestedBucket !== canonical))
      throw new Error("browser bucket does not match the saved conversation");
  } else {
    if (rows.length > 1) throw new Error("browser conversation has multiple saved aliases");
    selectedId = rows[0]?.id;
  }
  if (selectedId === undefined && initialRows.some((row) => row.id === sessionId))
    throw new Error("browser bucket belongs to another saved conversation");
  const bucket = selectedId === undefined ? canonical : `${projectKey}::${selectedId}`;
  return {
    bucket,
    assertCurrent: () => {
      const currentRows = readRows();
      if (
        selectedId === undefined
          ? currentRows.some(
              (row) => row.id === sessionId || (row.engineSessionId ?? row.id) === sessionId,
            )
          : !currentRows.some(
              (row) => row.id === selectedId && (row.engineSessionId ?? row.id) === sessionId,
            )
      )
        throw new Error("browser conversation alias changed");
    },
  };
}
