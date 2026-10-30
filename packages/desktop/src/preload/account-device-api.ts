import { ipcRenderer, type IpcRendererEvent } from "electron";
import type {
  AccountDeviceApi,
  AccountDeviceEvent,
  AccountDeviceSendResult,
} from "../shared/account-device.js";

async function invoke<T>(method: string, input?: unknown): Promise<T> {
  const result = await ipcRenderer.invoke(`accountDevice:${method}`, input);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
export const accountDeviceApi: AccountDeviceApi = {
  list: () => invoke("list"),
  projects: (input) => invoke("projects", input),
  connect: (input) => invoke("connect", input),
  resume: (input) => invoke("resume", input),
  async send(input): Promise<AccountDeviceSendResult> {
    try {
      const result = await ipcRenderer.invoke("accountDevice:send", input);
      if (result?.ok === true) return { ok: true };
      if (
        result?.ok === false &&
        typeof result.error === "string" &&
        (result.delivery === "not-sent" || result.delivery === "unknown")
      )
        return { ok: false, error: result.error, delivery: result.delivery };
    } catch {
      // A rejected IPC promise does not prove whether main already wrote the socket.
    }
    return {
      ok: false,
      error: "任务发送结果未知，请核对原电脑；操作不会自动重发。",
      delivery: "unknown",
    };
  },
  stop: (input) => invoke("stop", input),
  approve: (input) => invoke("approve", input),
  close: (input) => invoke("close", input),
  onEvent(callback) {
    const listener = (_event: IpcRendererEvent, event: AccountDeviceEvent) => callback(event);
    ipcRenderer.on("accountDevice:event", listener);
    return () => ipcRenderer.removeListener("accountDevice:event", listener);
  },
};
