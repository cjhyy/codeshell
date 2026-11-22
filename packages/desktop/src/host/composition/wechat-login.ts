import { loginCodeShellWechat } from "@cjhyy/code-shell-chat/codeshell";
import type { WechatLoginEvent, WechatLoginOperations } from "../../shared/wechat-login.js";
import type { BusinessMethods } from "./business-calls.js";

interface ActiveLogin {
  id: string;
  verification?: ReturnType<typeof Promise.withResolvers<string>>;
}

/** QR polling, verification and token/config persistence share one Host login. */
export function wechatLoginOperations(
  emit: (event: WechatLoginEvent) => void,
  login: typeof loginCodeShellWechat = loginCodeShellWechat,
) {
  let active: ActiveLogin | undefined;
  return {
    async "im/wechatLogin"({ loginId }, { signal }) {
      signal.throwIfAborted();
      if (active) throw Error("个人微信登录正在进行中");
      const session: ActiveLogin = { id: loginId };
      active = session;
      const abort = () => session.verification?.reject(Error("微信登录已取消"));
      signal.addEventListener("abort", abort, { once: true });
      try {
        return await login({
          signal,
          onQrCode: (url) => {
            if (!signal.aborted) emit({ type: "wechat-qr", loginId, url });
          },
          onStatus: (status) => {
            if (!signal.aborted) emit({ type: "wechat-status", loginId, status: String(status) });
          },
          requestVerificationCode: () => {
            signal.throwIfAborted();
            if (session.verification) throw Error("已有微信验证数字等待输入");
            const gate = Promise.withResolvers<string>();
            session.verification = gate;
            emit({ type: "wechat-verification-required", loginId });
            return gate.promise;
          },
        });
      } finally {
        signal.removeEventListener("abort", abort);
        session.verification?.reject(Error("微信登录已结束"));
        active = undefined;
      }
    },
    "im/wechatVerify"({ loginId, code }, grant) {
      grant.assertCurrent();
      if (!active || active.id !== loginId || !active.verification || !code.trim()) return false;
      const pending = active.verification;
      active.verification = undefined;
      pending.resolve(code.trim());
      return true;
    },
  } satisfies Pick<BusinessMethods, keyof WechatLoginOperations>;
}
