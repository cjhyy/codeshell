import { sessionSelectorId } from "@cjhyy/code-shell-pet/disclosure";

export interface PetArchivableSession {
  engineSessionId: string;
  origin?: string;
  archivedAt?: number;
}

export interface PetSessionArchiveResult extends Record<string, unknown> {
  action: "archive";
  archived: string[];
  count: number;
}

/**
 * Resolve the entire opaque-selector batch before the first write, then archive
 * in order. Validation failures therefore have no side effects. A storage
 * failure can still occur between separate session files; in that case refresh
 * the catalog and report the exact partial count instead of claiming a wholly
 * failed operation.
 */
export async function archivePetSessionsBySelector(options: {
  selectors: readonly string[];
  listSessions(): Promise<readonly PetArchivableSession[]>;
  archiveSession(sessionId: string, archivedAt: number): Promise<void>;
  refreshCatalog(): Promise<void>;
  now?: () => number;
}): Promise<PetSessionArchiveResult> {
  const selectors = [...options.selectors];
  if (
    selectors.length < 1 ||
    selectors.length > 20 ||
    new Set(selectors).size !== selectors.length ||
    selectors.some((selector) => !/^[A-Za-z0-9_-]{1,128}$/u.test(selector))
  ) {
    throw new Error("Session 归档需要 1 到 20 个唯一的有效选择器");
  }

  const sessions = await options.listSessions();
  const bySelector = new Map(
    sessions
      .filter((session) => session.origin === "desktop")
      .map((session) => [sessionSelectorId(session.engineSessionId), session] as const),
  );
  const resolved = selectors.map((selector) => {
    const session = bySelector.get(selector);
    if (!session) throw new Error(`Session 不存在或不允许归档：${selector}`);
    return { selector, session };
  });
  const pending = resolved.filter(({ session }) => session.archivedAt === undefined);
  if (pending.length === 0) return { action: "archive", archived: [], count: 0 };

  const archived: string[] = [];
  const archivedAt = (options.now ?? Date.now)();
  try {
    for (const { selector, session } of pending) {
      await options.archiveSession(session.engineSessionId, archivedAt);
      archived.push(selector);
    }
  } catch (error) {
    if (archived.length > 0) {
      await options.refreshCatalog().catch(() => undefined);
      throw new Error(
        `Session 批量归档部分完成（${archived.length}/${pending.length}）：${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
    throw error;
  }

  try {
    await options.refreshCatalog();
  } catch (error) {
    throw new Error(
      `已归档 ${archived.length} 个 Session，但工作列表刷新失败：${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
  return { action: "archive", archived, count: archived.length };
}
