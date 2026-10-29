import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import type { RoomKind, RoomManager } from "@cjhyy/code-shell-server/mobile-remote";
import type { TaskInboxSourcesDeps } from "../task-inbox/task-inbox-sources.js";
import { DriveAgentTranscriptAccess } from "./drive-agent-transcript-access.js";
import { openLinkedSessionFromIpc, takeOverLinkedSessionFromIpc } from "./linked-session-ipc.js";
import type { TranscriptSubscriptionManager } from "./transcript-subscriptions.js";

interface LinkedSessionObservationDeps {
  ipcMain: Pick<IpcMain, "handle">;
  windows: Iterable<Pick<BrowserWindow, "isDestroyed" | "webContents">>;
  roomManager: Pick<RoomManager, "openLinkedSession" | "takeOverLinkedSession" | "close">;
  listBackgroundWork: NonNullable<TaskInboxSourcesDeps["background"]>["list"];
  requirePath(cwd: unknown): Promise<string>;
  subscriptions: Pick<
    TranscriptSubscriptionManager,
    "subscribe" | "unsubscribe" | "unsubscribeSubscriber" | "endRoom"
  >;
  roomMatchesTranscript(roomId: string, cwd: string, sessionId: string, kind: RoomKind): boolean;
  pendingApprovals(roomId: string): unknown;
}

/** Own the read-only room IPC boundary and its window/room observation lifetime. */
export function registerLinkedSessionObservationIpc(deps: LinkedSessionObservationDeps): void {
  const { ipcMain, roomManager, subscriptions } = deps;
  const access = new DriveAgentTranscriptAccess(deps.listBackgroundWork);
  const cleanupSenders = new Set<number>();
  const requireApplicationWindow = (event: IpcMainInvokeEvent): void => {
    if (
      ![...deps.windows].some(
        (window) => !window.isDestroyed() && window.webContents === event.sender,
      ) ||
      event.senderFrame !== event.sender.mainFrame
    ) {
      throw new Error("DriveAgent transcript observation requires an application window");
    }
  };
  const trackSender = (event: IpcMainInvokeEvent): void => {
    const senderId = event.sender.id;
    if (cleanupSenders.has(senderId)) return;
    cleanupSenders.add(senderId);
    event.sender.once("destroyed", () => {
      cleanupSenders.delete(senderId);
      access.forgetSender(senderId);
      subscriptions.unsubscribeSubscriber(`desktop:${senderId}`);
    });
  };

  ipcMain.handle(
    "ccRoom:openLinkedSession",
    async (event, externalSessionId: unknown, cwd: unknown, kind: unknown, source?: unknown) => {
      let projectCwd: string;
      try {
        projectCwd = await deps.requirePath(cwd);
      } catch (error) {
        if (source === undefined) throw error;
        requireApplicationWindow(event);
        trackSender(event);
        const senderId = event.sender.id;
        const linked = await access.open(
          senderId,
          source,
          { externalSessionId, cwd, kind },
          (target) =>
            openLinkedSessionFromIpc(
              roomManager,
              target.externalSessionId,
              target.cwd,
              target.kind,
            ),
        );
        // Destruction can clean up while the background job snapshot is pending.
        if (event.sender.isDestroyed()) {
          access.forgetSender(senderId);
          throw new Error("DriveAgent transcript observation window was closed", { cause: error });
        }
        return linked;
      }
      return openLinkedSessionFromIpc(roomManager, externalSessionId, projectCwd, kind);
    },
  );
  ipcMain.handle(
    "ccRoom:takeOverLinkedSession",
    async (_event, roomId: unknown, externalSessionId: unknown, cwd: unknown, kind: unknown) =>
      takeOverLinkedSessionFromIpc(
        roomManager,
        roomId,
        externalSessionId,
        await deps.requirePath(cwd),
        kind,
      ),
  );
  ipcMain.handle(
    "ccRoom:subscribeTranscript",
    async (
      event,
      roomId: string,
      cwd: string,
      sessionId: string,
      kind: RoomKind,
      limit: number,
    ) => {
      // The fallback is only this window's exact observed delegation. Writable
      // takeover above retains the project gate, without an observation fallback.
      try {
        cwd = await deps.requirePath(cwd);
      } catch {
        requireApplicationWindow(event);
        cwd = await access.requireSubscription(event.sender.id, roomId, {
          externalSessionId: sessionId,
          cwd,
          kind,
        });
      }
      if (!deps.roomMatchesTranscript(roomId, cwd, sessionId, kind)) {
        throw new Error("cc-room transcript subscription does not match the opened room");
      }
      if (event.sender.isDestroyed()) {
        access.forgetSender(event.sender.id);
        throw new Error("DriveAgent transcript observation window was closed");
      }
      trackSender(event);
      return {
        ...subscriptions.subscribe({
          subscriberId: `desktop:${event.sender.id}`,
          roomId,
          cwd,
          sessionId,
          kind,
          limit,
        }),
        approvals: deps.pendingApprovals(roomId), // cards a remounted view missed
      };
    },
  );
  ipcMain.handle("ccRoom:unsubscribeTranscript", async (event, roomId: string) => {
    subscriptions.unsubscribe(`desktop:${event.sender.id}`, roomId);
  });
  ipcMain.handle("rooms:close", async (event, roomId: string) => {
    roomManager.close(roomId);
    access.forgetRoom(event.sender.id, roomId);
  });
  ipcMain.handle("ccRoom:closeSession", async (event, roomId: string) => {
    subscriptions.endRoom(roomId);
    roomManager.close(roomId);
    access.forgetRoom(event.sender.id, roomId);
  });
}
