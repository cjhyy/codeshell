import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import { randomUUID } from "node:crypto";
import { compareTaskInboxRecords, deduplicateTaskInboxRecords } from "./task-inbox-mappers.js";
import type {
  TaskInboxActionRequest,
  TaskInboxActionResult,
  TaskInboxListQuery,
  TaskInboxListResult,
  TaskInboxRecordV1,
  TaskInboxSnapshot,
} from "./task-inbox-types.js";

export interface TaskInboxIpcService {
  list(query?: TaskInboxListQuery): TaskInboxListResult;
  get(taskKey: string): TaskInboxRecordV1 | undefined;
  reconcile(): Promise<TaskInboxSnapshot>;
  subscribe(listener: (snapshot: TaskInboxSnapshot) => void): () => void;
  act(
    request: TaskInboxActionRequest,
    context: { webContentsId: number },
  ): Promise<TaskInboxActionResult>;
}

export { parseTaskInboxListQuery } from "./task-inbox-types.js";
export { parseTaskInboxActionRequest as parseTaskInboxAction } from "./task-inbox-types.js";
import {
  parseTaskInboxListQuery,
  parseTaskInboxActionRequest,
  checkedTaskText,
} from "./task-inbox-types.js";

/** Private local data and controls are available only to application top frames. */
export function registerTaskInboxIpc(
  ipc: Pick<IpcMain, "handle" | "removeHandler">,
  windows: () => BrowserWindow[],
  service: TaskInboxIpcService,
  enabled: () => boolean = () => true,
): () => void {
  const channels: string[] = [];
  const pages = new Map<
    string,
    { owner: number; expires: number; query: string; snapshot: TaskInboxSnapshot; bytes: number }
  >();
  const queryKey = (query: TaskInboxListQuery) =>
    JSON.stringify([query.source, query.status, query.projectId, query.search]);
  const prune = () => {
    const owners = new Set(
      windows()
        .filter((window) => !window.isDestroyed())
        .map((window) => window.webContents.id),
    );
    for (const [id, page] of pages)
      if (page.expires < Date.now() || !owners.has(page.owner)) pages.delete(id);
    let bytes = [...pages.values()].reduce((total, page) => total + page.bytes, 0);
    while (pages.size > 8 || bytes > 96 * 1024 * 1024) {
      const oldest = pages.keys().next().value!;
      bytes -= pages.get(oldest)!.bytes;
      pages.delete(oldest);
    }
  };
  const handle = (
    channel: string,
    action: (event: IpcMainInvokeEvent, input: unknown) => unknown,
  ) => {
    channels.push(channel);
    ipc.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (
        !windows().some((window) => !window.isDestroyed() && window.webContents === event.sender) ||
        event.senderFrame !== event.sender.mainFrame
      ) {
        throw new Error("Task inbox requires an application window");
      }
      if (!enabled()) throw new Error("Task inbox is disabled");
      if (args.length > 1) throw new Error("Invalid task inbox arguments");
      return action(event, args[0]);
    });
  };
  handle("taskInbox:list", async (event, input) => {
    const query = parseTaskInboxListQuery(input);
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
        cached.owner !== event.sender.id ||
        cached.query !== queryKey(query) ||
        !Number.isSafeInteger(Number(match[2]))
      ) {
        throw new Error("Task page expired; refresh the task list");
      }
      token = match[1];
      offset = Number(match[2]);
      snapshot = cached.snapshot;
    } else {
      const current = await service.reconcile();
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
        owner: event.sender.id,
        expires: Date.now() + 60_000,
        query: queryKey(query),
        snapshot,
        bytes: Buffer.byteLength(JSON.stringify(snapshot)),
      });
      prune();
    }
    const limit = query.limit ?? 200;
    const more = offset + limit < snapshot.records.length;
    if (!more) pages.delete(token);
    return {
      ...snapshot,
      records: snapshot.records.slice(offset, offset + limit),
      ...(more ? { nextCursor: `page:${token}:${offset + limit}` } : {}),
    };
  });
  handle("taskInbox:get", (_event, input) => {
    const key = checkedTaskText(input, "key", 1100);
    return service.get(key) ?? null;
  });
  handle("taskInbox:act", (event, input) =>
    service.act(parseTaskInboxActionRequest(input), { webContentsId: event.sender.id }),
  );
  const unsubscribe = service.subscribe((snapshot) => {
    if (!enabled()) return;
    for (const window of windows()) {
      if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
      try {
        window.webContents.send("taskInbox:changed", snapshot.version);
      } catch {
        // A closing window cannot make a task projection update fail.
      }
    }
  });
  return () => {
    pages.clear();
    unsubscribe();
    for (const channel of channels) ipc.removeHandler(channel);
  };
}
