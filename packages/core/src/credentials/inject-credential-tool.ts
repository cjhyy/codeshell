/**
 * InjectCredential 工具:把一条 cookie 凭证「注入内置浏览器」(恢复登录态),
 * 让 AI 能以该账号身份在内置浏览器面板做 UI 操作(配 browser_* 工具)。
 *
 * 与 UseCredential 的区别:
 *  - UseCredential 取 cookie 文件路径走 HTTP 请求(curl/yt-dlp),只读、不改浏览器。
 *  - InjectCredential 改的是内置浏览器的登录态(先清再灌),副作用更大 →
 *    独立的逐条门 `autoInjectByAI`(不复用 autoUseByAI)。
 *
 * 跨进程:实际的 restoreCookiesToBrowser 在 desktop main(core 够不到 Electron
 * session),经 `ctx.injectCredentialToBrowser` 回调(宿主注入,镜像 askUser)触发。
 */

import type { ToolDefinition } from "../types.js";
import type { ToolContext } from "../tool-system/context.js";
import { CredentialStore } from "./store.js";
import {
  credentialUseGate,
  type SessionCredentialAllow,
  type CredentialAskFn,
} from "./use-gate.js";
import { SettingsManager, type SettingsScope } from "../settings/manager.js";

const TOOL_NAME = "InjectCredential";

const BASE_DESCRIPTION =
  "Inject a stored COOKIE credential into the built-in browser to restore its " +
  "login state, so you can then drive the page as that logged-in account with the " +
  "browser_* tools (snapshot/click/type/navigate). This replaces the browser's " +
  "current cookies.\n\n" +
  "ONLY call this when the user EXPLICITLY asks to log in / act as a specific " +
  "account / do something that requires being signed in. Do NOT call it just to " +
  "open, navigate to, or browse a site — 'open 小红书 / go to <url> / take a look' " +
  "is plain navigation: use browser_navigate WITHOUT injecting any cookies. " +
  "Injecting overwrites the browser's current session, so an unrequested inject is " +
  "a surprising, destructive side effect. When unsure whether login is wanted, " +
  "navigate first and ask the user rather than injecting.\n\n" +
  "When it IS wanted: call UseCredential with no args first to see available " +
  "credentials, then call this with `id` of a cookie credential. For HTTP " +
  "scraping/downloads (curl/yt-dlp) use UseCredential instead — this is only for " +
  "driving the built-in browser UI. Gated by a quick user approval unless the " +
  "credential has auto-inject enabled.";

export const injectCredentialToolDef: ToolDefinition = {
  name: TOOL_NAME,
  description: BASE_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "Cookie credential id to inject into the built-in browser.",
      },
      purpose: {
        type: "string",
        description: "Short reason you need it (shown in the approval prompt).",
      },
    },
    required: ["id"],
  },
};

type InjectResult = { kind: "injected"; count: number } | { kind: "error"; error: string };

/** 内存会话 allow 集(每 Engine 一份,与 UseCredential 分开:注入是独立动作)。 */
const injectSessionAllowByEngine = new Map<string, SessionCredentialAllow>();
function sessionAllowFor(ctx?: ToolContext): SessionCredentialAllow {
  // 同 UseCredential:无 sessionId 时绝不共享全局桶,返回一次性 Set,避免跨上下文串台。
  if (!ctx?.sessionId) return new Set();
  const key = ctx.sessionId;
  let set = injectSessionAllowByEngine.get(key);
  if (!set) {
    set = new Set();
    injectSessionAllowByEngine.set(key, set);
  }
  return set;
}

// CredentialStore only distinguishes full user+project from project-only.
// Isolated engines must be at least as restrictive as project-scoped engines.
function credentialScope(scope: SettingsScope | undefined): "full" | "project" {
  return scope === "full" || scope === undefined ? "full" : "project";
}

function readAutoApprove(cwd: string, scope: "full" | "project"): boolean {
  try {
    const s = new SettingsManager(cwd, scope === "full" ? "full" : "project").get() as {
      credentialUse?: { autoApprove?: boolean };
    };
    return s.credentialUse?.autoApprove === true;
  } catch {
    return false;
  }
}

/** 该工具仅在有 cookie 凭证 且 宿主接了注入回调时才可见(BUILTIN_TOOL_GUARDS)。 */
export function isInjectCredentialAvailable(cwd: string, settingsScope?: SettingsScope): boolean {
  try {
    return new CredentialStore(cwd)
      .listMasked(credentialScope(settingsScope))
      .some((c) => c.type === "cookie");
  } catch {
    return false;
  }
}

export async function injectCredentialTool(
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string> {
  const cwd = ctx?.cwd ?? process.cwd();
  const scope = credentialScope(ctx?.settingsScope);
  const id = typeof args.id === "string" ? args.id.trim() : "";
  const purpose = typeof args.purpose === "string" ? args.purpose : undefined;

  if (!id) {
    return json({
      kind: "error",
      error: "缺少 id。先用 UseCredential(无参)列出凭证,再用 cookie 凭证的 id 调本工具。",
    });
  }

  if (!ctx?.injectCredentialToBrowser) {
    return json({
      kind: "error",
      error:
        "当前环境无内置浏览器(headless/无面板),无法注入。请改用 UseCredential 取 cookie 走 HTTP 请求。",
    });
  }

  const cred = new CredentialStore(cwd).resolve(id, scope);
  if (!cred) {
    return json({
      kind: "error",
      error: `凭证不存在: "${id}"。调用 UseCredential(无参)可列出可用凭证。`,
    });
  }
  if (cred.type !== "cookie") {
    return json({ kind: "error", error: `凭证「${cred.label}」不是 cookie 类型,不能注入浏览器。` });
  }

  // 过门:复用三档,但用该凭证的 autoInjectByAI(不是 autoUseByAI)。
  const ask: CredentialAskFn | undefined = ctx.askUser
    ? (q, opts) => ctx.askUser!(q, opts)
    : undefined;
  const decision = await credentialUseGate(
    { id: cred.id, label: cred.label, purpose },
    {
      autoApprove: readAutoApprove(cwd, scope),
      credentialAutoUse: cred.autoInjectByAI === true,
      sessionAllow: sessionAllowFor(ctx),
      ask,
    },
  );
  if (!decision.allowed) {
    const msg =
      decision.reason === "no-ui"
        ? "无法注入:当前无审批 UI(headless),且该凭证未开启自动注入。"
        : `用户拒绝把「${cred.label}」注入浏览器。`;
    return json({ kind: "error", error: msg });
  }

  // 跨进程触发宿主注入。
  const res = await ctx.injectCredentialToBrowser(cred.id, scope);
  if (!res.ok) {
    return json({ kind: "error", error: res.error ?? "注入浏览器失败(宿主未返回成功)。" });
  }
  return json({ kind: "injected", count: res.count ?? 0 });
}

function json(r: InjectResult): string {
  return JSON.stringify(r);
}

/** 测试钩子:清空会话 allow 集。 */
export function __resetInjectCredentialSessionAllowForTests(): void {
  injectSessionAllowByEngine.clear();
}

export function clearInjectCredentialSessionAllow(sessionId: string): void {
  injectSessionAllowByEngine.delete(sessionId);
}
