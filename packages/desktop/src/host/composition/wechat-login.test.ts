import { expect, test } from "bun:test";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { HostBusinessCalls } from "./business-calls.js";
import { wechatLoginOperations } from "./wechat-login.js";
import { registerHostedWechatLogin } from "../../main/desktop-host/wechat-login-client.js";
import type { WechatLoginEvent } from "../../shared/wechat-login.js";

test("QR challenges and codes stay with the initiating document through cancellation and recovery", async () => {
  const handlers: Record<string, (event: IpcMainInvokeEvent, input?: unknown) => Promise<unknown>> =
    {};
  const signals = new Map<IpcMainInvokeEvent, AbortController>();
  const notifications: WechatLoginEvent[] = [];
  let deliver: (event: WechatLoginEvent) => void;
  let waiting = Promise.withResolvers<string>();
  const business = new HostBusinessCalls(
    wechatLoginOperations(
      (event) => deliver(event),
      async ({ onQrCode, requestVerificationCode } = {}) => {
        onQrCode!("fixture:qr");
        const code = await requestVerificationCode!();
        expect(code).toBe("1234");
        return { accountId: "test", configPath: "/test/gateway.json" };
      },
    ),
  );
  function document() {
    const event = {
      sender: {
        send: (_: string, update: WechatLoginEvent) => {
          notifications.push(update);
          if (update.type === "wechat-verification-required") waiting.resolve(update.loginId);
        },
      },
    } as IpcMainInvokeEvent;
    signals.set(event, new AbortController());
    return event;
  }
  let seq = 0;
  registerHostedWechatLogin(
    {
      handle: (name: string, handle: (typeof handlers)[string]) => {
        handlers[name] = handle;
      },
    } as IpcMain,
    {
      documentSignal: (event) => signals.get(event)!.signal,
      onWechatEvent: (listener) => {
        deliver = listener;
      },
      callBusiness: async (method, input, signal) => {
        const id = String(++seq);
        const withdraw = () => business.revoke(id);
        signal?.throwIfAborted();
        signal?.addEventListener("abort", withdraw, { once: true });
        try {
          return (await business.run(id, method, input)) as never;
        } finally {
          signal?.removeEventListener("abort", withdraw);
        }
      },
    },
    (work) => work(),
  );
  const owner = document(),
    other = document();
  const first = handlers["im-gateway:wechatLogin"]!(owner);
  const staleId = await waiting.promise;
  expect(
    await handlers["im-gateway:wechatSubmitVerification"]!(other, {
      loginId: staleId,
      code: "1234",
    }),
  ).toBe(false);
  expect(await handlers["im-gateway:wechatCancelLogin"]!(other)).toBe(false);
  signals.get(owner)!.abort();
  await expect(first).rejects.toThrow("已取消");
  waiting = Promise.withResolvers<string>();
  const second = handlers["im-gateway:wechatLogin"]!(other);
  const loginId = await waiting.promise;
  expect(loginId).not.toBe(staleId);
  expect(
    await handlers["im-gateway:wechatSubmitVerification"]!(other, {
      loginId: staleId,
      code: "1234",
    }),
  ).toBe(false);
  expect(
    await handlers["im-gateway:wechatSubmitVerification"]!(other, { loginId, code: " 1234 " }),
  ).toBe(true);
  expect(await second).toEqual({ accountId: "test", configPath: "/test/gateway.json" });
  expect(notifications.map((e) => e.type)).toEqual([
    "wechat-qr",
    "wechat-verification-required",
    "wechat-qr",
    "wechat-verification-required",
  ]);
});
