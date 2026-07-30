import { mock } from "bun:test";

export const panelAppElectronMock = {
  protocolHandler: null as ((request: Request) => Promise<Response>) | null,
  ipcHandlers: new Map<string, (event: { sender: any }, ...args: any[]) => unknown>(),
  ipcListeners: new Map<string, (event: { sender: any }, ...args: any[]) => void>(),
  trustedSender: { id: 1 },
  ownerWindow: { id: 10, isDestroyed: () => false },
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
        setPermissionRequestHandler: () => undefined,
        setPermissionCheckHandler: () => undefined,
      }),
    },
    shell: {
      openExternal: async (url: string) => {
        panelAppElectronMock.openedUrls.push(url);
      },
    },
  }));
}
