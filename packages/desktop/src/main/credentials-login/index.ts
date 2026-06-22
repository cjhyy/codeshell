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
import { dlog } from "../desktop-logger.js";

/**
 * Stable PREFIXES for the two control signals. The full token a button prints
 * is `<PREFIX>:<nonce>` where the nonce is a one-time high-entropy value minted
 * per login window (see `loginAndCaptureCookies`). The prefix alone is public
 * and guessable; the nonce is NOT — so the page's own JS cannot forge a click
 * by printing a known constant. We match on the full prefix+nonce token.
 */
export const SENTINEL_SAVE = "__CODESHELL_LOGIN_SAVE__";
export const SENTINEL_CANCEL = "__CODESHELL_LOGIN_CANCEL__";

/** The two full tokens the injected buttons print for a given per-window nonce. */
export function tokensFor(nonce: string): { save: string; cancel: string } {
  return { save: `${SENTINEL_SAVE}:${nonce}`, cancel: `${SENTINEL_CANCEL}:${nonce}` };
}

export interface LoginCaptureRequest {
  /** 登录页 URL(如 https://www.youtube.com)。 */
  url: string;
  /** 平台名(凭证分组用;可选,渲染层也会从域名推断)。 */
  platform?: string;
  /**
   * 全量模式:抓登录窗口分区里的**所有** cookie(不按目标域过滤)。
   * 用于登录态分散在多个域 / 子域、按主域抓会漏的站(如小红书)。
   * 默认 false(只抓目标域,jar 干净)。
   */
  fullCapture?: boolean;
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

/**
 * 浮窗注入脚本:提示条 + 两个按钮,点击打印**带 nonce 的** console 哨兵(main 侧监听)。
 * `nonce` 是 per-window 一次性高熵值 —— 页面自身 JS 不知道它,无法伪造点击。
 */
export function injectionScript(nonce: string): string {
  const { save: saveToken, cancel: cancelToken } = tokensFor(nonce);
  return `(function(){
    if(document.getElementById('__cs_login_bar__'))return;
    var bar=document.createElement('div');
    bar.id='__cs_login_bar__';
    bar.style.cssText='position:fixed;top:12px;right:12px;z-index:2147483647;background:#1e293b;color:#fff;padding:10px 12px;border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,.3);font:13px -apple-system,system-ui,sans-serif;display:flex;gap:8px;align-items:center;';
    var txt=document.createElement('span');txt.textContent='登录成功后点「保存」';
    var save=document.createElement('button');save.textContent='我已登录,保存';
    save.style.cssText='background:#22c55e;color:#fff;border:0;border-radius:6px;padding:6px 10px;cursor:pointer;font:inherit;';
    save.onclick=function(){console.log(${JSON.stringify(saveToken)});};
    var cancel=document.createElement('button');cancel.textContent='取消';
    cancel.style.cssText='background:transparent;color:#cbd5e1;border:1px solid #475569;border-radius:6px;padding:6px 10px;cursor:pointer;font:inherit;';
    cancel.onclick=function(){console.log(${JSON.stringify(cancelToken)});};
    bar.appendChild(txt);bar.appendChild(save);bar.appendChild(cancel);
    document.body.appendChild(bar);
  })();`;
}

/**
 * 从 console-message 回调参数里捞出 message 字符串,兼容两种 Electron 签名:
 *  - Electron ≥33: (event, messageDetails:{message,...}) → 取 args[1].message
 *  - Electron <33: (event, level:number, message:string, ...) → 取 args[2]
 * 找不到返回空串。
 */
export function extractConsoleMessage(args: unknown[]): string {
  // 新签名:第二个参数是带 .message 的对象
  const second = args[1];
  if (second && typeof second === "object" && typeof (second as { message?: unknown }).message === "string") {
    return (second as { message: string }).message;
  }
  // 旧签名:第三个参数是 message 字符串
  if (typeof args[2] === "string") return args[2];
  // 兜底:任意位置的字符串
  const str = args.find((a) => typeof a === "string");
  return typeof str === "string" ? str : "";
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
 * Does a cookie's domain apply to the target host we're capturing for?
 * Standard cookie-domain match: the cookie domain (leading dot stripped) must
 * be the host itself, or a registrable parent of it. We require the parent to
 * contain a dot so a bare public-suffix label (e.g. "co" / "com") can NOT match
 * an unrelated host via `host.endsWith(".co")` — defense-in-depth on top of
 * Electron's own per-domain getCookies filter. Empty cookie domains never match.
 */
export function cookieDomainMatches(cookieDomain: string | undefined, targetDomain: string): boolean {
  const d = (cookieDomain ?? "").replace(/^\./, "");
  if (!d || !targetDomain) return false;
  if (d === targetDomain) return true;
  // d is a parent of targetDomain (e.g. d="github.com", target="api.github.com").
  // Reject bare single-label parents (TLD/public suffix) by requiring a dot in d.
  return d.includes(".") && targetDomain.endsWith("." + d);
}

/**
 * 打开登录窗口,等用户点「保存/取消」,产出 cookie + 校验结果。
 * 可注入 `open`(测试替身);默认用真 BrowserHost。
 */
export async function loginAndCaptureCookies(
  req: LoginCaptureRequest,
  deps: {
    open?: typeof openBrowserHost;
    destroy?: typeof destroyPartitionCookies;
    /** Override the per-window nonce (tests only); production mints a random one. */
    nonce?: string;
  } = {},
): Promise<LoginCaptureResult> {
  const targetDomain = hostnameOf(req.url);
  if (!targetDomain) return { ok: false, error: "无效的 URL" };

  const open = deps.open ?? openBrowserHost;
  const destroy = deps.destroy ?? destroyPartitionCookies;
  // Per-window one-time secret: the page cannot guess it, so it cannot forge a
  // save/cancel click by printing a known constant to the console.
  const nonce = deps.nonce ?? randomUUID();
  const { save: saveToken, cancel: cancelToken } = tokensFor(nonce);
  const partition = `persist:login-${randomUUID()}`;

  let handle: BrowserHostHandle;
  try {
    handle = await open({
      kind: "window",
      url: req.url,
      partition,
      title: `登录 ${req.platform ?? targetDomain}`,
    });
    dlog("main", "login.window_opened", { url: req.url, domain: targetDomain, partition });
  } catch (e) {
    dlog("main", "login.open_failed", { error: String(e) });
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

    // 注入浮窗。注入脚本自带幂等守卫(同 id 已存在则跳过),所以可重复注入。
    const inject = (whence: string) => {
      handle
        .executeJavaScript(injectionScript(nonce))
        .then(() => dlog("main", "login.inject_ok", { domain: targetDomain, whence }))
        .catch((e) =>
          dlog("main", "login.inject_failed", { domain: targetDomain, whence, error: String(e) }),
        );
    };
    // 立即注入一次:openBrowserHost 已 await 完初始 loadURL,初始 did-finish-load 早已过,
    // 单靠下面的监听对 SPA(初始 load 后靠 XHR 完成登录、无整页导航)永不触发 → 浮窗永不出现。
    inject("initial");
    // 后续整页导航(多步登录跳转)后重注入。不吞错 —— 失败(常见 CSP 挡)记日志便于诊断。
    handle.webContents.on("did-finish-load", () => {
      dlog("main", "login.did_finish_load", { domain: targetDomain });
      inject("did-finish-load");
    });

    // 渲染/加载崩溃兜底。
    handle.webContents.on("render-process-gone", () => {
      void finish({
        ok: false,
        error: "登录窗口渲染失败(常见 GPU/驱动白屏)。可在设置开启 GPU 兼容模式后重试。",
      });
    });

    // console 哨兵:保存 / 取消。
    // Electron 33 起签名变为 (event, messageDetails:{message,...});旧版是 (event, level, message)。
    // 两种都兜:从 arguments 里捞出字符串型 message。
    (handle.webContents as Electron.WebContents).on(
      "console-message",
      (...callbackArgs: unknown[]) => {
      const message = extractConsoleMessage(callbackArgs);
      if (!message) return;
      // 诊断:只记带本窗口 nonce 的哨兵(避免刷屏 + 不记页面伪造的裸前缀);
      // 若哨兵收不到 = 注入或 console 通道被挡。匹配必须带 nonce —— 仅凭公开前缀
      // (页面可自行 console.log)不算数,否则等于退回可伪造的旧设计。
      if (message.includes(saveToken) || message.includes(cancelToken)) {
        dlog("main", "login.sentinel", { message: message.slice(0, 60) });
      }
      if (message.includes(cancelToken)) {
        void finish({ ok: false, cancelled: true });
        return;
      }
      if (message.includes(saveToken)) {
        // 整段包 try/catch:getCookies / evaluateLoginState 任一抛错都不能让 finish 漏掉,
        // 否则外层 Promise 永不 resolve,渲染层按钮卡死在「处理中…」。
        void (async () => {
          try {
            // 全量模式:抓分区里所有 cookie,不按域过滤(小红书等跨域登录态)。
            // 默认模式:只抓目标域。BrowserHost.getCookies(undefined) 取全量,
            // getCookies(domain) 已按域过滤,这里再保险按主机后缀过滤一次。
            // 后缀过滤只用「相等 / 后缀」,不用 includes(否则 cookie 域 x.com 会误中 myx.com)。
            const all = await handle.getCookies(req.fullCapture ? undefined : targetDomain);
            const jar = req.fullCapture
              ? all
              : all.filter((c) => cookieDomainMatches(c.domain, targetDomain));
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
          } catch (e) {
            dlog("main", "login.save_failed", { domain: targetDomain, error: String(e) });
            await finish({ ok: false, error: `读取 cookie 失败: ${String(e)}` });
          }
        })();
      }
    });

    // 用户直接关窗(没点按钮)→ 取消。
    handle.onClosed(() => {
      void finish({ ok: false, cancelled: true });
    });
  });
}
