import type { IpcMain } from "electron";
import { sessionsRoot } from "@cjhyy/code-shell-core";
import {
  readOutputJournal,
  readOutputJournalLegacyBase,
  type OutputJournalOptions,
} from "@cjhyy/code-shell-core/internal";
import { listDiskSessions } from "@cjhyy/code-shell-server/storage";
import { assertDesktopSessionId } from "./session-validation.js";
import { getSessionEvents } from "./rawTranscript.js";
import {
  getSessionTranscript,
  getSessionTranscriptPage,
  MAX_TRANSCRIPT_PAGE_BYTES,
  transcriptToFoldItems,
} from "./transcript-reader.js";

/** Session history reads stay together, with injected storage readers for IPC validation tests. */
export function registerSessionTranscriptIpc(
  ipcMain: Pick<IpcMain, "handle">,
  readers: {
    listDiskSessions?: typeof listDiskSessions;
    getSessionEvents?: typeof getSessionEvents;
  } = {},
): void {
  ipcMain.handle(
    "sessions:listDisk",
    async (_e, opts: { limit?: number; cursor?: string; parentSessionId?: string }) => {
      const limit =
        typeof opts?.limit === "number" && Number.isSafeInteger(opts.limit) && opts.limit > 0
          ? Math.min(opts.limit, 200)
          : 30;
      if (
        opts?.cursor !== undefined &&
        (typeof opts.cursor !== "string" || opts.cursor.length > 512 || opts.cursor.includes("\0"))
      ) {
        throw new Error("invalid session cursor");
      }
      if (opts?.parentSessionId !== undefined) assertDesktopSessionId(opts.parentSessionId);
      return (readers.listDiskSessions ?? listDiskSessions)({
        limit,
        cursor: typeof opts?.cursor === "string" ? opts.cursor : undefined,
        parentSessionId: opts?.parentSessionId,
      });
    },
  );
  ipcMain.handle("sessions:rawEvents", async (_e, sessionId: string, sinceId?: string) => {
    assertDesktopSessionId(sessionId);
    if (
      sinceId !== undefined &&
      (typeof sinceId !== "string" || sinceId.length > 512 || sinceId.includes("\0"))
    ) {
      throw new Error("invalid transcript cursor");
    }
    return (readers.getSessionEvents ?? getSessionEvents)(
      sessionId,
      typeof sinceId === "string" ? sinceId : undefined,
    );
  });
  ipcMain.handle("sessions:transcript", async (_event, sessionId: string) => {
    assertDesktopSessionId(sessionId);
    return getSessionTranscript(sessionId);
  });
  ipcMain.handle(
    "sessions:outputJournal",
    async (_event, sessionId: string, options?: OutputJournalOptions) => {
      assertDesktopSessionId(sessionId);
      const page = readOutputJournal(sessionsRoot(), sessionId, options);
      if (page.status !== "ok" || options?.after !== undefined) return page;
      const base = readOutputJournalLegacyBase(
        sessionsRoot(),
        sessionId,
        page.legacyBaseThroughEventId,
      );
      const raw = base.events.map((event) => JSON.stringify(event)).join("\n");
      const complete = base.complete;
      return {
        ...page,
        legacyBaseComplete: complete,
        legacyBaseItems: complete ? transcriptToFoldItems(raw) : [],
      };
    },
  );
  ipcMain.handle(
    "sessions:transcriptPage",
    async (_event, sessionId: string, options?: { maxBytes?: number }) => {
      assertDesktopSessionId(sessionId);
      if (
        options !== undefined &&
        (!options || typeof options !== "object" || Array.isArray(options))
      ) {
        throw new Error("invalid transcript page options");
      }
      if (
        options?.maxBytes !== undefined &&
        (typeof options.maxBytes !== "number" ||
          !Number.isSafeInteger(options.maxBytes) ||
          options.maxBytes <= 0 ||
          options.maxBytes > MAX_TRANSCRIPT_PAGE_BYTES)
      ) {
        throw new Error("invalid transcript page size");
      }
      return getSessionTranscriptPage(sessionId, options);
    },
  );
}
