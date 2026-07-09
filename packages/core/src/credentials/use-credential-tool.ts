/**
 * UseCredential 工具(凭证模块第二期 §3-§5)。
 *
 * 对 AI 暴露**一个统一工具**取用已存凭证(token / link / cookie 同构,描述只说「凭证」)。
 * - 无 `id` → 返回脱敏清单(权威实时源,兜底动态描述的滞后)。
 * - 有 `id` → 过 CredentialUseGate(默认问 / 本会话记住 / 全自动)后:
 *     - token/link → `{ kind: "value", value }`
 *     - cookie     → 就地写临时 cookies.txt(0600),返回 `{ kind: "cookie", cookiesFile, count }`
 *
 * desktop 下通过 host credential access IPC 按需解析 secret；headless/SDK
 * 仍可使用本地 CredentialStore。
 * 集中在 core/src/credentials/ 下,只经 ToolDefinition 注册 + ToolContext.askUser 耦合 core,
 * 满足设计稿 §1「可整块外移」约束。
 */

import type { ToolDefinition } from "../types.js";
import type { ToolContext } from "../tool-system/context.js";
import { SENSITIVE_TOOL_RESULT_PLACEHOLDER } from "../tool-system/tool-result-redaction.js";
import {
  credentialUseGate,
  type SessionCredentialAllow,
  type CredentialAskFn,
} from "./use-gate.js";
import { SettingsManager, type SettingsScope } from "../settings/manager.js";
import { logger } from "../logging/logger.js";
import {
  credentialAccessScope,
  getCredentialAccess,
  materializeCookieSecret,
  sweepStaleCredentialCookieFiles,
} from "./access.js";

const TOOL_NAME = "UseCredential";

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
    const list = getCredentialAccess().listMasked(cwd, "full");
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
  sweepStaleCredentialCookieFiles(now);
}

/** 内存会话 allow 集:每个 Engine 一份(从 ctx.sessionId 键)。纯内存,关进程即忘。 */
const sessionAllowByEngine = new Map<string, SessionCredentialAllow>();
function sessionAllowFor(ctx?: ToolContext): SessionCredentialAllow {
  // 无 sessionId(headless / 临时 ToolContext / 某些子代理)绝不能共享一个
  // 全局 "__nosession__" 桶 —— 否则一个上下文里「本会话记住」的批准会被
  // 任意其它无 sessionId 的上下文复用,造成跨会话凭证串台。这种情况下返回
  // 一个一次性 Set(不入 map):取用本身正常,但「记住」对它失效,每次重新过门。
  if (!ctx?.sessionId) return new Set();
  const key = ctx.sessionId;
  let set = sessionAllowByEngine.get(key);
  if (!set) {
    set = new Set();
    sessionAllowByEngine.set(key, set);
  }
  return set;
}

// CredentialStore only distinguishes "full" (user+project) from "project"
// (project-only). An "isolated" engine is at least as restrictive as project,
// so it maps to "project" — it must never read the host user's ~/.code-shell.
function credentialScope(scope: SettingsScope | undefined): "full" | "project" {
  return credentialAccessScope(scope);
}

function readAutoApprove(cwd: string, scope: "full" | "project"): boolean {
  try {
    // A project/isolated engine must read autoApprove from its own scope, not
    // the host user's ~/.code-shell — otherwise a host `credentialUse.autoApprove`
    // would silently auto-approve credential use inside an isolated engine.
    const s = new SettingsManager(cwd, scope === "full" ? "full" : "project").get() as {
      credentialUse?: { autoApprove?: boolean };
    };
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
  const access = getCredentialAccess();
  const scope = credentialScope(ctx?.settingsScope);
  const id = typeof args.id === "string" ? args.id.trim() : "";
  const purpose = typeof args.purpose === "string" ? args.purpose : undefined;

  // 无 id → 清单(脱敏,权威实时源)。按 engine scope 过滤:project/isolated
  // 引擎不得列出宿主 user 层凭证。
  if (!id) {
    const credentials = access
      .listMasked(cwd, scope)
      .map((c) => ({ id: c.id, label: c.label, type: c.type }));
    return json({ kind: "list", credentials });
  }

  const cred = access.resolveMeta(cwd, id, scope);
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
      autoApprove: readAutoApprove(cwd, scope),
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
    if (!cred.hasSecret || !access.resolveValue) {
      return json({ kind: "error", error: `凭证「${cred.label}」没有可用的值。` });
    }
    try {
      const value = await access.resolveValue({ cwd, id: cred.id, scope, purpose: "use" });
      return json({ kind: "value", value });
    } catch {
      return json({ kind: "error", error: `凭证「${cred.label}」没有可用的值。` });
    }
  }

  // cookie → 就地写临时 cookies.txt
  if (cred.type === "cookie") {
    if (!cred.hasSecret) {
      return json({
        kind: "error",
        error: `凭证「${cred.label}」的 cookie 为空或已失效,请在凭证页对该账号点「重拓」(重新登录后重新拓取)。`,
      });
    }
    // Unique per write: id + pid alone collides when two concurrent UseCredential
    // calls (the tool is concurrency-safe) materialize the same credential in the
    // same process — the second write would clobber the first and a caller could
    // read another account's cookies. A random component makes each file distinct.
    // Prefix is unchanged so the 30-min startup sweep still matches & cleans them.
    try {
      const materialized = access.materializeCookie
        ? await access.materializeCookie({ cwd, id: cred.id, scope })
        : materializeCookieSecret(
            cred.id,
            await access.resolveValue!({ cwd, id: cred.id, scope, purpose: "use" }),
          );
      return json({
        kind: "cookie",
        cookiesFile: materialized.cookiesFile,
        count: materialized.count,
      });
    } catch (e) {
      if (String(e).includes("cookie jar is empty or invalid")) {
        return json({
          kind: "error",
          error: `凭证「${cred.label}」的 cookie 为空或已失效,请在凭证页对该账号点「重拓」(重新登录后重新拓取)。`,
        });
      }
      logger.warn(`UseCredential: failed to write cookies.txt: ${String(e)}`);
      return json({ kind: "error", error: `写临时 cookie 文件失败: ${String(e)}` });
    }
  }

  return json({ kind: "error", error: `未知凭证类型: ${cred.type}` });
}

export async function useCredentialBuiltinTool(
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<
  | string
  | {
      result: string;
      sensitive: true;
      displayResult: string;
      transcriptResult: string;
    }
> {
  const result = await useCredentialTool(args, ctx);
  if (!isValueResult(result)) return result;
  const redacted = json({ kind: "value", value: SENSITIVE_TOOL_RESULT_PLACEHOLDER });
  return {
    result,
    sensitive: true,
    displayResult: redacted,
    transcriptResult: redacted,
  };
}

function json(r: UseCredentialResult): string {
  return JSON.stringify(r);
}

function isValueResult(result: string): boolean {
  try {
    const parsed = JSON.parse(result) as { kind?: unknown; value?: unknown };
    return parsed.kind === "value" && typeof parsed.value === "string";
  } catch {
    return false;
  }
}

/** 测试钩子:清空会话 allow 集(避免跨用例污染)。 */
export function __resetCredentialSessionAllowForTests(): void {
  sessionAllowByEngine.clear();
}

export function clearCredentialSessionAllow(sessionId: string): void {
  sessionAllowByEngine.delete(sessionId);
}
