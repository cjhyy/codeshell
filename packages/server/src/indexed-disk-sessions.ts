import {
  checkListIds,
  collectDiskSessionPage,
  comparePositions,
  decodeCursor,
  isListDirectory,
  projectDiskSessionState,
  type DiskSessionListOptions,
  type DiskSessionPosition,
  type ListDiskSessionsResult,
} from "./disk-session-list.js";

interface SessionIndexReader {
  read<T>(sql: string, params?: readonly (number | string)[]): T[] | null;
}

interface IndexPosition extends DiskSessionPosition {
  metadata?: string | null;
}

class IndexUnavailable extends Error {}

const batchSize = 32;

/** Preserve the file catalog's localeCompare order inside mtime ties. SQLite's
 * BINARY and NOCASE collations would skip or duplicate mixed-case/punctuation IDs. */
export async function listIndexedDiskSessions(
  storage: SessionIndexReader,
  opts: DiskSessionListOptions,
): Promise<ListDiskSessionsResult | null> {
  checkListIds(opts);
  const cursor = decodeCursor(opts.cursor);
  const empty = { sessions: [], nextCursor: null };
  if (cursor === null || (opts.sessionId !== undefined && !isListDirectory(opts.sessionId)))
    return empty;
  const where =
    opts.sessionId === undefined
      ? "WHERE id NOT GLOB 'qchat-*' AND id NOT GLOB 'panel-task-*'"
      : "WHERE id = ?";
  const params = opts.sessionId === undefined ? [] : [opts.sessionId];
  const filters = ["metadata_json IS NOT NULL"];
  const visibleParams: string[] = [];
  if (!opts.includeArchived) filters.push("archived_at IS NULL");
  if (opts.parentSessionId !== undefined) {
    filters.push("parent_session_id = ?");
    visibleParams.push(opts.parentSessionId);
  } else if (!opts.includeSubagents) {
    filters.push("parent_session_id IS NULL", "origin IN ('desktop','automation')");
  }
  function read<T>(
    select: string,
    tail: string,
    args: readonly (number | string)[] = [],
    visible = false,
  ): T[] {
    const filter = visible ? " AND " + filters.join(" AND ") : "";
    // Without statistics SQLite may choose the archived_at index and sort every live row.
    // Both indexes below supply exactly the requested directory order.
    const index =
      !visible || opts.sessionId !== undefined
        ? ""
        : opts.parentSessionId !== undefined
          ? " INDEXED BY sessions_parent"
          : " INDEXED BY sessions_directory_order";
    const rows = storage.read<T>(
      `SELECT ${select} FROM sessions${index} ${where}${filter} ${tail}`,
      [...params, ...(visible ? visibleParams : []), ...args],
    );
    if (rows === null) throw new IndexUnavailable();
    return rows;
  }
  function tie(mtime: number, visible = false) {
    return read<IndexPosition>(
      "id, dir_mtime AS mtime",
      "AND dir_mtime = ?",
      [mtime],
      visible,
    ).sort(comparePositions);
  }
  // Numeric offsets count raw directories, including rows with invalid/archived state.
  function precedingOffset(offset: number): DiskSessionPosition | undefined {
    const at = read<{ mtime: number }>(
      "dir_mtime AS mtime",
      "ORDER BY dir_mtime DESC, id LIMIT 1 OFFSET ?",
      [offset - 1],
    )[0];
    if (!at) return undefined;
    const [newer] = read<{ n: number }>("COUNT(*) AS n", "AND dir_mtime > ?", [at.mtime]);
    return tie(at.mtime)[offset - 1 - newer!.n];
  }
  function precedingCursor(cursor: DiskSessionPosition): DiskSessionPosition | undefined {
    const same = tie(cursor.mtime).filter((p) => comparePositions(p, cursor) <= 0);
    if (same.length) return same.at(-1);
    const prior = read<{ mtime: number }>(
      "dir_mtime AS mtime",
      "AND dir_mtime > ? ORDER BY dir_mtime ASC LIMIT 1",
      [cursor.mtime],
    )[0];
    return prior && tie(prior.mtime).at(-1);
  }
  function* positions(
    after: DiskSessionPosition | undefined,
    visible: boolean,
  ): Generator<IndexPosition> {
    let ceiling = after?.mtime;
    let inclusive = true;
    for (;;) {
      const range =
        ceiling === undefined ? "" : inclusive ? "AND dir_mtime <= ?" : "AND dir_mtime < ?";
      const fetched = read<IndexPosition>(
        "id, dir_mtime AS mtime, metadata_json AS metadata",
        `${range} ORDER BY dir_mtime DESC, id LIMIT ?`,
        [...(ceiling === undefined ? [] : [ceiling]), batchSize + 1],
        visible,
      );
      const more = fetched.length > batchSize;
      let page = fetched;
      if (more) {
        const boundary = fetched[batchSize]!.mtime;
        // Defer an incomplete tie to the next batch. For one very large tie, fetch only IDs
        // in that bucket; load metadata by primary key as the page consumes its positions.
        page = fetched.filter((p) => p.mtime > boundary);
        if (!page.length) page = tie(boundary, visible);
      }
      if (!page.length) return;
      page.sort(comparePositions);
      for (const row of page) {
        if (!isListDirectory(row.id) || !Number.isFinite(row.mtime)) throw new IndexUnavailable();
        if (!after || comparePositions(row, after) > 0) yield row;
      }
      if (!more) return;
      ceiling = page.at(-1)!.mtime;
      inclusive = false;
    }
  }
  function metadata(row: IndexPosition) {
    const json =
      row.metadata === undefined
        ? read<{ metadata: string | null }>(
            "metadata_json AS metadata",
            "AND id = ? AND dir_mtime = ?",
            [row.id, row.mtime],
          )[0]?.metadata
        : row.metadata;
    if (json == null) return null;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(json);
    } catch {
      throw new IndexUnavailable();
    }
    if (
      !data ||
      typeof data !== "object" ||
      Array.isArray(data) ||
      data.id !== row.id ||
      data.engineSessionId !== row.id ||
      typeof data.title !== "string" ||
      typeof data.cwd !== "string"
    )
      throw new IndexUnavailable();
    // Reproject only display fields. The directory position remains authoritative if
    // its mtime changed independently of state.json.
    const projected = projectDiskSessionState(row.id, row.mtime, {
      ...data,
      parentSessionId: data.parentSessionId ?? null,
      startedAt: data.createdAt,
      status: data.status === "cancelled" ? "aborted_tools" : data.status,
      lastCompletionKind: data.completionKind,
    });
    if (!projected) throw new IndexUnavailable();
    return projected;
  }
  try {
    let after: DiskSessionPosition | undefined;
    if (typeof cursor === "number") {
      if (!Number.isSafeInteger(cursor)) return empty;
      if (cursor > 0) {
        after = precedingOffset(cursor);
        if (!after) return empty;
      }
    } else after = cursor;
    const previous =
      after && !(opts.limit > 0) && typeof cursor !== "number" ? precedingCursor(after) : after;
    const result = await collectDiskSessionPage(
      opts,
      positions(after, opts.limit > 0),
      metadata,
      previous,
    );
    const last = result.sessions.at(-1);
    // The last accepted row may be followed only by hidden directories. The file API
    // still returns a cursor in that case, so the next page can be empty.
    if (last && result.nextCursor === null && result.sessions.length >= opts.limit) {
      const position = { id: last.id, mtime: last.updatedAt };
      const older = read("1", "AND dir_mtime < ? LIMIT 1", [position.mtime]).length > 0;
      if (older || tie(position.mtime).some((p) => comparePositions(p, position) > 0))
        result.nextCursor = `v1:${position.mtime}:${position.id}`;
    }
    return result;
  } catch (error) {
    if (error instanceof IndexUnavailable) return null;
    throw error;
  }
}
