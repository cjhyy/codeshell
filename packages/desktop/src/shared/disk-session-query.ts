import type { listDiskSessions } from "@cjhyy/code-shell-server/storage";

export type ListSessionOptions = Parameters<typeof listDiskSessions>[0];
export type ListSessions = (options: ListSessionOptions) => ReturnType<typeof listDiskSessions>;

export function isDesktopSessionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    value !== "." &&
    !value.includes("..") &&
    /^[A-Za-z0-9_.-]+$/.test(value)
  );
}

export function assertDesktopSessionId(value: unknown): asserts value is string {
  if (!isDesktopSessionId(value)) throw new Error("invalid desktop sessionId");
}

/** The workbench may request one visible row, a direct-child view or a page.
 * Root overrides, cwd filters and the host's archived/subagent scans stay private. */
export function rendererDiskSessionQuery(input: unknown): ListSessionOptions {
  const opts = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const limit =
    typeof opts.limit === "number" && Number.isSafeInteger(opts.limit) && opts.limit > 0
      ? Math.min(opts.limit, 200)
      : 30;
  if (
    opts.cursor !== undefined &&
    (typeof opts.cursor !== "string" || opts.cursor.length > 512 || opts.cursor.includes("\0"))
  ) {
    throw new Error("invalid session cursor");
  }
  if (opts.parentSessionId !== undefined) assertDesktopSessionId(opts.parentSessionId);
  if (opts.sessionId !== undefined) assertDesktopSessionId(opts.sessionId);
  return {
    limit,
    cursor: opts.cursor,
    parentSessionId: opts.parentSessionId,
    ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
  };
}
