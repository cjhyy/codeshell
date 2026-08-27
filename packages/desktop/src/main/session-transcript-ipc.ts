import type { IpcMain } from "electron";
import { assertDesktopSessionId } from "./session-validation.js";
import {
  getSessionTranscript,
  getSessionTranscriptPage,
  MAX_TRANSCRIPT_PAGE_BYTES,
} from "./transcript-reader.js";

export function registerSessionTranscriptIpc(ipcMain: IpcMain): void {
  ipcMain.handle("sessions:transcript", async (_event, sessionId: string) => {
    assertDesktopSessionId(sessionId);
    return getSessionTranscript(sessionId);
  });
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
