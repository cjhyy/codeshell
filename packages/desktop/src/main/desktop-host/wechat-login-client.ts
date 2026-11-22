import { randomUUID } from "node:crypto";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { CallShellBusiness } from "../../shared/shell-business-contracts.js";
import type { WechatLoginEvent } from "../../shared/wechat-login.js";

/** A QR challenge belongs to the exact workbench document that initiated it. */
export function registerHostedWechatLogin(
  ipcMain: IpcMain,
  host: {
    callBusiness: CallShellBusiness;
    documentSignal(event: IpcMainInvokeEvent): AbortSignal;
    onWechatEvent(listener: (event: WechatLoginEvent) => void): void;
  },
  withGatewayRestart: <T>(work: () => Promise<T>) => Promise<T>,
) {
  let flow:
    | {
        id: string;
        document: AbortSignal;
        controller: AbortController;
        notify(event: WechatLoginEvent): void;
      }
    | undefined;
  host.onWechatEvent((event) => {
    if (
      flow &&
      event.loginId === flow.id &&
      !flow.document.aborted &&
      !flow.controller.signal.aborted
    )
      flow.notify(event);
  });
  ipcMain.handle("im-gateway:wechatLogin", async (event) => {
    const document = host.documentSignal(event);
    if (flow) throw Error("个人微信登录正在进行中");
    const id = randomUUID();
    const controller = new AbortController();
    const signal = AbortSignal.any([document, controller.signal]);
    flow = {
      id,
      document,
      controller,
      notify: (value) => event.sender.send("im-gateway:event", value),
    };
    try {
      return await withGatewayRestart(() =>
        host.callBusiness("im/wechatLogin", { loginId: id }, signal),
      );
    } catch (error) {
      if (signal.aborted) throw Error("微信登录已取消");
      throw error;
    } finally {
      flow = undefined;
    }
  });
  ipcMain.handle("im-gateway:wechatCancelLogin", (event) => {
    const document = host.documentSignal(event);
    if (!flow || flow.document !== document) return false;
    flow.controller.abort();
    return true;
  });
  ipcMain.handle("im-gateway:wechatSubmitVerification", (event, input: unknown) => {
    const document = host.documentSignal(event);
    if (!flow || flow.document !== document || flow.controller.signal.aborted) return false;
    const msg = input as { loginId?: unknown; code?: unknown } | null;
    if (msg?.loginId !== flow.id || typeof msg.code !== "string" || !msg.code.trim()) return false;
    return host.callBusiness("im/wechatVerify", { loginId: flow.id, code: msg.code }, document);
  });
}
