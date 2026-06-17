/**
 * 登录窗口控制层(凭证登录抓 cookie 第一个业务用例,建在 BrowserHost 上)。
 *
 * 流程(设计稿 §4):
 *   1. 开全新临时分区 persist:login-<id>(= 无痕、天然多账号)
 *   2. BrowserHost 开独立窗口加载登录 URL
 *   3. did-finish-load 注入浮窗:提示 + 「我已登录,保存」+「取消」,点击经 console 哨兵回 main
 *   4. 点保存 → 读该域 cookie + 抓用户名 + 登录态校验
 *   5. 自动关窗 + 销毁临时分区
 *   6. 返回 { jar, domain, suggestedLabel, loginCheck } 或 cancelled
 *
 * 不存凭证 —— 控制层只产出 jar + 建议名;存走渲染层既有 credentials:save(复用第二期)。
 */

import { randomUUID } from "node:crypto";
import type { ElectronCookieLike } from "../credentials-service.js";
import {
  openBrowserHost,
  destroyPartitionCookies,
  type BrowserHostHandle,
} from "../browser-host/index.js";
import {
  evaluateLoginState,
  usernameScriptFor,
  sanitizeUsername,
  type LoginCheck,
} from "./login-state.js";

export const SENTINEL_SAVE = "__CODESHELL_LOGIN_SAVE__";
export const SENTINEL_CANCEL = "__CODESHELL_LOGIN_CANCEL__";

export interface LoginCaptureRequest {
  /** 登录页 URL(如 https://www.youtube.com)。 */
  url: string;
  /** 平台名(凭证分组用;可选,渲染层也会从域名推断)。 */
  platform?: string;
}

export type LoginCaptureResult =
  | {
      ok: true;
      jar: ElectronCookieLike[];
      domain: string;
      suggestedLabel?: string;
      loginCheck: LoginCheck;
    }
  | { ok: false; cancelled?: boolean; error?: string };

/** 浮窗注入脚本:提示条 + 两个按钮,点击打印 console 哨兵(main 侧监听)。 */
export function injectionScript(): string {
  return `(function(){
    if(document.getElementById('__cs_login_bar__'))return;
    var bar=document.createElement('div');
    bar.id='__cs_login_bar__';
    bar.style.cssText='position:fixed;top:12px;right:12px;z-index:2147483647;background:#1e293b;color:#fff;padding:10px 12px;border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,.3);font:13px -apple-system,system-ui,sans-serif;display:flex;gap:8px;align-items:center;';
    var txt=document.createElement('span');txt.textContent='登录成功后点「保存」';
    var save=document.createElement('button');save.textContent='我已登录,保存';
    save.style.cssText='background:#22c55e;color:#fff;border:0;border-radius:6px;padding:6px 10px;cursor:pointer;font:inherit;';
    save.onclick=function(){console.log('${SENTINEL_SAVE}');};
    var cancel=document.createElement('button');cancel.textContent='取消';
    cancel.style.cssText='background:transparent;color:#cbd5e1;border:1px solid #475569;border-radius:6px;padding:6px 10px;cursor:pointer;font:inherit;';
    cancel.onclick=function(){console.log('${SENTINEL_CANCEL}');};
    bar.appendChild(txt);bar.appendChild(save);bar.appendChild(cancel);
    document.body.appendChild(bar);
  })();`;
}

/** 从 URL 取目标主机名(失败返回空)。 */
export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/**
 * 打开登录窗口,等用户点「保存/取消」,产出 cookie + 校验结果。
 * 可注入 `open`(测试替身);默认用真 BrowserHost。
 */
export async function loginAndCaptureCookies(
  req: LoginCaptureRequest,
  deps: { open?: typeof openBrowserHost; destroy?: typeof destroyPartitionCookies } = {},
): Promise<LoginCaptureResult> {
  const targetDomain = hostnameOf(req.url);
  if (!targetDomain) return { ok: false, error: "无效的 URL" };

  const open = deps.open ?? openBrowserHost;
  const destroy = deps.destroy ?? destroyPartitionCookies;
  const partition = `persist:login-${randomUUID()}`;

  let handle: BrowserHostHandle;
  try {
    handle = await open({
      kind: "window",
      url: req.url,
      partition,
      title: `登录 ${req.platform ?? targetDomain}`,
    });
  } catch (e) {
    await destroy(partition);
    return { ok: false, error: `打开登录窗口失败: ${String(e)}` };
  }

  return await new Promise<LoginCaptureResult>((resolve) => {
    let settled = false;
    const finish = async (result: LoginCaptureResult) => {
      if (settled) return;
      settled = true;
      handle.close();
      await destroy(partition); // 登完即焚
      resolve(result);
    };

    // 注入浮窗(载入完成后)。
    handle.webContents.on("did-finish-load", () => {
      void handle.executeJavaScript(injectionScript()).catch(() => {});
    });

    // 渲染/加载崩溃兜底。
    handle.webContents.on("render-process-gone", () => {
      void finish({
        ok: false,
        error: "登录窗口渲染失败(常见 GPU/驱动白屏)。可在设置开启 GPU 兼容模式后重试。",
      });
    });

    // console 哨兵:保存 / 取消。
    handle.webContents.on("console-message", (_e, _level, message) => {
      if (message.includes(SENTINEL_CANCEL)) {
        void finish({ ok: false, cancelled: true });
        return;
      }
      if (message.includes(SENTINEL_SAVE)) {
        void (async () => {
          const all = await handle.getCookies(targetDomain);
          // 仅目标域(BrowserHost.getCookies 已按域过滤,这里再保险按主机后缀过滤一次)。
          const jar = all.filter((c) => {
            const d = (c.domain ?? "").replace(/^\./, "");
            return d === targetDomain || targetDomain.endsWith("." + d) || targetDomain.includes(d);
          });
          let suggestedLabel: string | undefined;
          const script = usernameScriptFor(targetDomain);
          if (script) {
            try {
              suggestedLabel = sanitizeUsername(await handle.executeJavaScript(script));
            } catch {
              /* 抓用户名失败不阻塞 */
            }
          }
          const loginCheck = evaluateLoginState(jar, targetDomain);
          await finish({ ok: true, jar, domain: targetDomain, suggestedLabel, loginCheck });
        })();
      }
    });

    // 用户直接关窗(没点按钮)→ 取消。
    handle.onClosed(() => {
      void finish({ ok: false, cancelled: true });
    });
  });
}
