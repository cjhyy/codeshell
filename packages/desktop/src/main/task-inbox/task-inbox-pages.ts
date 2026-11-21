import { randomUUID } from "node:crypto";
import { compareTaskInboxRecords, deduplicateTaskInboxRecords } from "./task-inbox-mappers.js";
import type {
  TaskInboxListQuery,
  TaskInboxListResult,
  TaskInboxSnapshot,
  TaskInboxVisibility,
} from "./task-inbox-types.js";

/** Cursor snapshots belong to one committed document. A new port or frame cannot reuse them. */
export function createTaskInboxPages(
  read: (visibility: TaskInboxVisibility) => Promise<TaskInboxSnapshot>,
) {
  const pages = new Map<
    string,
    { owner: object; expires: number; query: string; snapshot: TaskInboxSnapshot; bytes: number }
  >();
  const queryKey = (query: TaskInboxListQuery) =>
    JSON.stringify([
      query.source,
      query.status,
      query.projectId,
      query.search,
      query.visibility ?? "visible",
    ]);
  const prune = () => {
    for (const [id, page] of pages) if (page.expires < Date.now()) pages.delete(id);
    let bytes = [...pages.values()].reduce((total, page) => total + page.bytes, 0);
    while (pages.size > 8 || bytes > 96 * 1024 * 1024) {
      const oldest = pages.keys().next().value!;
      bytes -= pages.get(oldest)!.bytes;
      pages.delete(oldest);
    }
  };
  async function list(
    owner: object,
    query: TaskInboxListQuery,
    assertCurrent: () => void,
  ): Promise<TaskInboxListResult> {
    prune();
    let offset = 0;
    let token: string;
    let snapshot: TaskInboxSnapshot;
    if (query.cursor) {
      const match = /^page:([a-f0-9-]{36}):(\d+)$/u.exec(query.cursor);
      const cached = match ? pages.get(match[1]) : undefined;
      if (
        !match ||
        !cached ||
        cached.owner !== owner ||
        cached.query !== queryKey(query) ||
        !Number.isSafeInteger(Number(match[2]))
      ) {
        throw new Error("Task page expired; refresh the task list");
      }
      token = match[1];
      offset = Number(match[2]);
      snapshot = cached.snapshot;
    } else {
      const current = await read(query.visibility ?? "visible");
      assertCurrent();
      // One immutable authority snapshot for the whole read. A cursor never
      // scans sources again or mixes records from a later streaming update.
      const search = query.search?.trim().toLocaleLowerCase();
      snapshot = {
        ...current,
        records: deduplicateTaskInboxRecords(current.records)
          .filter(
            (record) =>
              (!query.source || record.source === query.source) &&
              (!query.status || record.status === query.status) &&
              (!query.projectId || record.projectId === query.projectId) &&
              (!search || record.title.toLocaleLowerCase().includes(search)),
          )
          .sort(compareTaskInboxRecords),
      };
      token = randomUUID();
      pages.set(token, {
        owner: owner,
        expires: Date.now() + 60_000,
        query: queryKey(query),
        snapshot,
        bytes: Buffer.byteLength(JSON.stringify(snapshot)),
      });
      prune();
    }
    assertCurrent();
    const limit = query.limit ?? 200;
    const more = offset + limit < snapshot.records.length;
    if (!more) pages.delete(token);
    return {
      ...snapshot,
      records: snapshot.records.slice(offset, offset + limit),
      ...(more ? { nextCursor: `page:${token}:${offset + limit}` } : {}),
    };
  }
  return { list, clear: () => pages.clear() };
}
