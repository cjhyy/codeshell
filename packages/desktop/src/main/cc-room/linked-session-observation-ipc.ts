import type { IpcMain } from "electron";
import type { NativeRooms } from "../desktop-host/rooms-client.js";
export function registerLinkedSessionObservationIpc(
  ipcMain: Pick<IpcMain, "handle">,
  call: NativeRooms["desktop"],
) {
  ipcMain.handle("rooms:close", (event, roomId) => call(event, { op: "close", roomId }));
  ipcMain.handle("ccRoom:openLinkedSession", (event, sessionId, cwd, kind, source) =>
    call(event, { op: "linked", sessionId, cwd, kind, source }),
  );
  ipcMain.handle("ccRoom:takeOverLinkedSession", (event, roomId, sessionId, cwd, kind) =>
    call(event, { op: "takeOver", roomId, sessionId, cwd, kind }),
  );
  ipcMain.handle("ccRoom:subscribeTranscript", (event, roomId, cwd, sessionId, kind, limit) =>
    call(event, { op: "subscribe", roomId, sessionId, cwd, kind, limit }),
  );
  ipcMain.handle("ccRoom:unsubscribeTranscript", (event, roomId) =>
    call(event, { op: "unsubscribe", roomId }),
  );
  ipcMain.handle("ccRoom:closeSession", (event, roomId) => call(event, { op: "end", roomId }));
}
