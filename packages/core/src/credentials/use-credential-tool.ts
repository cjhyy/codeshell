/**
 * UseCredential 工具(凭证模块第二期 §3-§5)。
 *
 * 对 AI 暴露**一个统一工具**取用已存凭证(token / link / cookie 同构,描述只说「凭证」)。
 * - 无 `id` → 返回脱敏清单(权威实时源,兜底动态描述的滞后)。
 * - 有 `id` → 过 CredentialUseGate(默认问 / 本会话记住 / 全自动)后:
 *     - token/link → `{ kind: "value", value }`
 *     - cookie     → 就地写临时 cookies.txt(0600),返回 `{ kind: "cookie", cookiesFile, count }`
 *
 * 取值全部 core 直读 CredentialStore(cookie 值第二期已进库),无跨进程。
 * 集中在 core/src/credentials/ 下,只经 ToolDefinition 注册 + ToolContext.askUser 耦合 core,
 * 满足设计稿 §1「可整块外移」约束。
 */

import { writeFileSync, existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ToolDefinition } from "../types.js";
import type { ToolContext } from "../tool-system/context.js";
import { CredentialStore } from "./store.js";
import { formatNetscapeCookies, parseCookieJar } from "./cookie-jar.js";
import {
  credentialUseGate,
  type SessionCredentialAllow,
  type CredentialAskFn,
} from "./use-gate.js";
import { SettingsManager } from "../settings/manager.js";
import { logger } from "../logging/logger.js";

const TOOL_NAME = "UseCredential";
const COOKIE_FILE_PREFIX = "codeshell-cred-cookie-";
const COOKIE_FILE_MAX_AGE_MS = 30 * 60 * 1000; // 30min 启动 sweep 上限

const BASE_DESCRIPTION =
  "Use a stored credential (token / API key / login cookie) to run a command. " +
  "Call with NO arguments first to list available credentials (id + label + type); " +
  "then call again with `id` to fetch one. Token/link credentials return their secret " +
  "value; cookie credentials are materialized to a temporary Netscape cookies.txt file " +
  "(use it as `yt-dlp --cookies <cookiesFile>` / `curl -b <cookiesFile>`). " +
  "Each use is gated by a quick user approval unless auto-approve is on.";

export const useCredentialToolDef: ToolDefinition = {
  name: TOOL_NAME,
  description: BASE_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "Credential id to fetch. Omit to list all available credentials.",
      },
      purpose: {
        type: "string",
        description: "Short reason you need it (shown in the approval prompt).",
      },
    },
  },
};

/**
 * 动态描述:在基础描述末尾附当前可用凭证清单(镜像 generateVideoToolDefFor)。
 * 空时回退基础描述。AI 一搜出/一看到就知道有哪些可用,减少无谓的无参列举调用。
 */
export function useCredentialToolDefFor(cwd: string): ToolDefinition {
  try {
    const list = new CredentialStore(cwd).listMasked();
    if (list.length === 0) return useCredentialToolDef;
    const names = list.map((c) => `${c.id} (${c.type})`).join(", ");
    return {
      ...useCredentialToolDef,
      description: `${BASE_DESCRIPTION}\nCurrently available: ${names}.`,
    };
  } catch {
    return useCredentialToolDef;
  }
}

/** 取用结果(JSON 序列化后回给 AI)。 */
type UseCredentialResult =
  | { kind: "list"; credentials: { id: string; label: string; type: string }[] }
  | { kind: "value"; value: string }
  | { kind: "cookie"; cookiesFile: string; count: number }
  | { kind: "error"; error: string };

/**
 * 启动期清理上次遗留的临时 cookies.txt(沿用 sweepStaleLeases 思路:扫同目录、按 mtime)。
 * 不引入 lease 对象/定时器 —— 文件用完靠进程退出 + 这个轻量 sweep。
 */
export function sweepStaleCredentialCookies(now = Date.now()): void {
  const dir = tmpdir();
  try {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir)) {
      if (!f.startsWith(COOKIE_FILE_PREFIX)) continue;
      const p = join(dir, f);
      try {
        if (now - statSync(p).mtimeMs > COOKIE_FILE_MAX_AGE_MS) rmSync(p, { force: true });
      } catch {
        /* skip */
      }
    }
  } catch {
    /* best-effort */
  }
}

/** 内存会话 allow 集:每个 Engine 一份(从 ctx.sessionId 键)。纯内存,关进程即忘。 */
const sessionAllowByEngine = new Map<string, SessionCredentialAllow>();
function sessionAllowFor(ctx?: ToolContext): SessionCredentialAllow {
  const key = ctx?.sessionId ?? "__nosession__";
  let set = sessionAllowByEngine.get(key);
  if (!set) {
    set = new Set();
    sessionAllowByEngine.set(key, set);
  }
  return set;
}

function readAutoApprove(cwd: string): boolean {
  try {
    const s = new SettingsManager(cwd, "full").get() as { credentialUse?: { autoApprove?: boolean } };
    return s.credentialUse?.autoApprove === true;
  } catch {
    return false;
  }
}

export async function useCredentialTool(
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string> {
  const cwd = ctx?.cwd ?? process.cwd();
  const store = new CredentialStore(cwd);
  const id = typeof args.id === "string" ? args.id.trim() : "";
  const purpose = typeof args.purpose === "string" ? args.purpose : undefined;

  // 无 id → 清单(脱敏,权威实时源)
  if (!id) {
    const credentials = store.listMasked().map((c) => ({ id: c.id, label: c.label, type: c.type }));
    return json({ kind: "list", credentials });
  }

  const cred = store.resolve(id);
  if (!cred) {
    return json({ kind: "error", error: `凭证不存在: "${id}"。调用本工具(无参)可列出可用凭证。` });
  }

  // 取值前过门
  const ask: CredentialAskFn | undefined = ctx?.askUser
    ? (q, opts) => ctx.askUser!(q, opts)
    : undefined;
  const decision = await credentialUseGate(
    { id: cred.id, label: cred.label, purpose },
    {
      autoApprove: readAutoApprove(cwd),
      credentialAutoUse: cred.autoUseByAI === true,
      sessionAllow: sessionAllowFor(ctx),
      ask,
    },
  );
  if (!decision.allowed) {
    const msg =
      decision.reason === "no-ui"
        ? "无法取用凭证:当前无审批 UI(headless),且未开启 credentialUse.autoApprove。"
        : `用户拒绝取用凭证「${cred.label}」。可回退 yt-dlp --cookies-from-browser 或提示用户。`;
    return json({ kind: "error", error: msg });
  }

  // token/link → 直接返回值
  if (cred.type === "token" || cred.type === "link") {
    if (!cred.secret) return json({ kind: "error", error: `凭证「${cred.label}」没有可用的值。` });
    return json({ kind: "value", value: cred.secret });
  }

  // cookie → 就地写临时 cookies.txt
  if (cred.type === "cookie") {
    const jar = parseCookieJar(cred.secret);
    if (jar.length === 0) {
      return json({
        kind: "error",
        error: `凭证「${cred.label}」的 cookie 为空或已失效,请在凭证页对该账号点「重拓」(重新登录后重新拓取)。`,
      });
    }
    const file = join(tmpdir(), `${COOKIE_FILE_PREFIX}${safe(cred.id)}-${process.pid}.txt`);
    try {
      writeFileSync(file, formatNetscapeCookies(jar), { mode: 0o600 });
    } catch (e) {
      logger.warn(`UseCredential: failed to write cookies.txt: ${String(e)}`);
      return json({ kind: "error", error: `写临时 cookie 文件失败: ${String(e)}` });
    }
    return json({ kind: "cookie", cookiesFile: file, count: jar.length });
  }

  return json({ kind: "error", error: `未知凭证类型: ${cred.type}` });
}

/** 文件名安全化(凭证 id 用了 `__`,这里只挡路径分隔符/控制字符)。 */
function safe(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function json(r: UseCredentialResult): string {
  return JSON.stringify(r);
}

/** 测试钩子:清空会话 allow 集(避免跨用例污染)。 */
export function __resetCredentialSessionAllowForTests(): void {
  sessionAllowByEngine.clear();
}
