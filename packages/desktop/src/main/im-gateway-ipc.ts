import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { ImGatewayService } from "./im-gateway-service.js";
import { dingTalkSetupInput } from "./im-gateway-setup-input.js";

type UiMethod =
  | "status"
  | "start"
  | "stop"
  | "ensureConfig"
  | "getDingTalkSetup"
  | "saveDingTalkSetup"
  | "startDingTalkDiscovery"
  | "stopDingTalkDiscovery";
type GatewayUi = {
  [K in UiMethod]: (
    ...args: Parameters<ImGatewayService[K]>
  ) => ReturnType<ImGatewayService[K]> | Promise<Awaited<ReturnType<ImGatewayService[K]>>>;
};
export function registerImGatewayIpc(
  ipcMain: Pick<IpcMain, "handle">,
  service: GatewayUi,
  work: (event: IpcMainInvokeEvent, run: () => unknown) => unknown = (_event, run) => run(),
) {
  ipcMain.handle("im-gateway:status", (e) => work(e, () => service.status()));
  ipcMain.handle("im-gateway:start", (e) => work(e, () => service.start()));
  ipcMain.handle("im-gateway:stop", (e) => work(e, () => service.stop()));
  ipcMain.handle("im-gateway:ensureConfig", (e) => work(e, () => service.ensureConfig()));
  ipcMain.handle("im-gateway:dingtalkGetSetup", (e) => work(e, () => service.getDingTalkSetup()));
  ipcMain.handle("im-gateway:dingtalkSaveSetup", (e, input: unknown) =>
    work(e, () => service.saveDingTalkSetup(dingTalkSetupInput(input))),
  );
  ipcMain.handle("im-gateway:dingtalkStartDiscovery", (e) =>
    work(e, () => service.startDingTalkDiscovery()),
  );
  ipcMain.handle("im-gateway:dingtalkStopDiscovery", (e) =>
    work(e, () => service.stopDingTalkDiscovery()),
  );
}
