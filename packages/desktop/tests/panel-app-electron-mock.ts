import { mock } from "bun:test";

export const panelAppElectronMock = {
  protocolHandler: null as ((request: Request) => Promise<Response>) | null,
  permissionRequestHandler: null as
    | ((
        webContents: any,
        permission: string,
        callback: (granted: boolean) => void,
        details: any,
      ) => void)
    | null,
  permissionCheckHandler: null as
    | ((webContents: any, permission: string, origin: string, details: any) => boolean)
    | null,
  ipcHandlers: new Map<string, (event: { sender: any }, ...args: any[]) => unknown>(),
  ipcListeners: new Map<string, (event: { sender: any }, ...args: any[]) => void>(),
  trustedSender: { id: 1 },
  ownerWindow: { id: 10, isDestroyed: () => false, webContents: { id: 1 } },
  userDataPath: "/tmp/codeshell-panel-app-test",
  dialogResponse: 1,
  openedUrls: [] as string[],
};

export function installPanelAppElectronMock(): void {
  mock.module("electron", () => ({
    app: { getPath: () => panelAppElectronMock.userDataPath },
    BrowserWindow: {
      fromWebContents: (sender: unknown) =>
        sender === panelAppElectronMock.trustedSender ? panelAppElectronMock.ownerWindow : null,
      fromId: () => panelAppElectronMock.ownerWindow,
    },
    dialog: { showMessageBox: async () => ({ response: panelAppElectronMock.dialogResponse }) },
    ipcMain: {
      handle: (channel: string, handler: (event: { sender: any }, ...args: any[]) => unknown) => {
        panelAppElectronMock.ipcHandlers.set(channel, handler);
      },
      on: (channel: string, listener: (event: { sender: any }, ...args: any[]) => void) => {
        panelAppElectronMock.ipcListeners.set(channel, listener);
      },
    },
    protocol: { registerSchemesAsPrivileged: () => undefined },
    session: {
      fromPartition: () => ({
        protocol: {
          handle: (_scheme: string, next: (request: Request) => Promise<Response>) => {
            panelAppElectronMock.protocolHandler = next;
          },
        },
        setPermissionRequestHandler: (handler: any) => {
          panelAppElectronMock.permissionRequestHandler = handler;
        },
        setPermissionCheckHandler: (handler: any) => {
          panelAppElectronMock.permissionCheckHandler = handler;
        },
      }),
    },
    shell: {
      openExternal: async (url: string) => {
        panelAppElectronMock.openedUrls.push(url);
      },
    },
  }));
}
