/** Private fixture participation only; this is not authority over arbitrary filesystem writers. */
import { StorageFailure } from "./codec.js";
const asyncReaders = new Map<string, number>();
export function claimAsyncFixtureReader(path: string): () => void {
  asyncReaders.set(path, (asyncReaders.get(path) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = asyncReaders.get(path)! - 1;
    if (count) asyncReaders.set(path, count);
    else asyncReaders.delete(path);
  };
}
export function assertSyncFixtureAllowed(path: string): void {
  if (asyncReaders.has(path))
    throw new StorageFailure(
      "busy",
      "Synchronous fixture writer cannot share an async storage path",
    );
}
