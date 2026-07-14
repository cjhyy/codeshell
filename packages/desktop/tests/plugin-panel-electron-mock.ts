import { mock } from "bun:test";

export const pluginPanelElectronMock = {
  protocolHandler: null as ((request: Request) => Promise<Response>) | null,
  ipcHandlers: new Map<string, (event: { sender: any }, ...args: any[]) => unknown>(),
  trustedSender: { id: 1 },
  ownerWindow: { id: 10, isDestroyed: () => false },
  userDataPath: "/tmp/codeshell-plugin-panel-test",
  dialogResponse: 1,
  openedUrls: [] as string[],
};

export function installPluginPanelElectronMock(): void {
  mock.module("electron", () => ({
    app: { getPath: () => pluginPanelElectronMock.userDataPath },
    BrowserWindow: {
      fromWebContents: (sender: unknown) =>
        sender === pluginPanelElectronMock.trustedSender
          ? pluginPanelElectronMock.ownerWindow
          : null,
      fromId: () => pluginPanelElectronMock.ownerWindow,
    },
    dialog: { showMessageBox: async () => ({ response: pluginPanelElectronMock.dialogResponse }) },
    ipcMain: {
      handle: (channel: string, handler: (event: { sender: any }, ...args: any[]) => unknown) => {
        pluginPanelElectronMock.ipcHandlers.set(channel, handler);
      },
    },
    protocol: { registerSchemesAsPrivileged: () => undefined },
    session: {
      fromPartition: () => ({
        protocol: {
          handle: (_scheme: string, next: (request: Request) => Promise<Response>) => {
            pluginPanelElectronMock.protocolHandler = next;
          },
        },
        setPermissionRequestHandler: () => undefined,
        setPermissionCheckHandler: () => undefined,
      }),
    },
    shell: {
      openExternal: async (url: string) => {
        pluginPanelElectronMock.openedUrls.push(url);
      },
    },
  }));
}
