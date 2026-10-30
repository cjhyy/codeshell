import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import type { OutputHistoryRecoveryAcceptance } from "@cjhyy/code-shell-core";
import type { SessionOutputHistoryRecovery } from "./session-output-history-recovery.js";
import { assertDesktopSessionId } from "./session-validation.js";

type RecoveryWindow = Pick<BrowserWindow, "isDestroyed" | "webContents">;

/** Capture the actual sending Main window/frame, never a caller supplied in JSON. */
export function requireOutputRecoveryWindow(
  windows: () => Iterable<RecoveryWindow>,
  event: IpcMainInvokeEvent,
): () => void {
  const window = [...windows()].find((candidate) => candidate.webContents === event.sender);
  const frame = event.senderFrame;
  const assertCurrent = () => {
    if (
      !window ||
      ![...windows()].includes(window) ||
      window.isDestroyed() ||
      event.sender.isDestroyed() ||
      !frame ||
      event.sender.mainFrame !== frame ||
      event.senderFrame !== frame
    )
      throw new Error("Output history recovery requires the current Desktop main window");
  };
  assertCurrent();
  return assertCurrent;
}

function acceptance(value: unknown): OutputHistoryRecoveryAcceptance {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, "planId") ||
    !Object.hasOwn(value, "acceptHistoricalGap")
  )
    throw new Error("invalid output history recovery acceptance");
  const input = value as Record<string, unknown>;
  if (
    input.acceptHistoricalGap !== true ||
    typeof input.planId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.planId)
  )
    throw new Error("invalid output history recovery acceptance");
  return { planId: input.planId, acceptHistoricalGap: true };
}

export function registerSessionOutputHistoryIpc(
  ipcMain: Pick<IpcMain, "handle">,
  windows: () => Iterable<RecoveryWindow>,
  service: Pick<SessionOutputHistoryRecovery, "plan" | "apply">,
): void {
  ipcMain.handle("sessions:outputRecoveryPlan", async (event, ...args: unknown[]) => {
    const assertCurrent = requireOutputRecoveryWindow(windows, event);
    if (args.length !== 1) throw new Error("invalid output history recovery request");
    const [sessionId] = args;
    assertDesktopSessionId(sessionId);
    const caller = { kind: "desktop" as const, webContentsId: event.sender.id };
    const result = await service.plan(sessionId, caller);
    assertCurrent();
    return result;
  });
  ipcMain.handle("sessions:outputRecoveryApply", async (event, ...args: unknown[]) => {
    const assertCurrent = requireOutputRecoveryWindow(windows, event);
    if (args.length !== 2) throw new Error("invalid output history recovery request");
    const [sessionId, input] = args;
    assertDesktopSessionId(sessionId);
    const confirmed = acceptance(input);
    const caller = { kind: "desktop" as const, webContentsId: event.sender.id };
    const result = await service.apply(sessionId, confirmed, caller);
    assertCurrent();
    return result;
  });
}
