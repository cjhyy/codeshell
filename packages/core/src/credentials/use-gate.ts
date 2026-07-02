/**
 * CredentialUseGate — 凭证取用前的轻量三档审批(凭证模块第二期 §5)。
 *
 * AI 的 `UseCredential` 工具在把某条凭证的值/cookies.txt 交给命令**之前**过这道门:
 *   1. **全自动**:settings `credentialUse.autoApprove === true` → 直接放行,不弹。
 *   2. **本会话记住**:用户上次选了「本会话记住」→ 该凭证 id 进内存 allow 集 → 后续放行。
 *   3. **默认弹审批**:经 `askUser`(InteractiveApprovalBackend)问一次。
 *
 * 关键决策(见设计稿 §5 + memory project_permission_session_cache):
 * - 本会话记住**按凭证 id 键**,不按工具名 —— 否则一次批准会放行对无关凭证的取用。
 * - 会话 allow 集是**纯内存**(关 app 即忘),由 Engine 持有并注入,故 gate 本身无模块级单例,
 *   多 Engine 并发互不干扰、可整块外移。
 *
 * 边界:gate 只依赖 `askUser`(既有审批后端)+ 一个内存 Set + settings 读取,不耦合 core 其它部分。
 */

/** AI 取用一条凭证的请求(供审批文案 + 记忆键)。 */
export interface CredentialUseRequest {
  /** 凭证 id(记忆键)。 */
  id: string;
  /** 展示名(审批文案)。 */
  label: string;
  /** 可选用途(审批文案)。 */
  purpose?: string;
}

export type CredentialUseDecision =
  | { allowed: true }
  | { allowed: false; reason: "denied" | "no-ui" };

/** 本会话已批准的凭证 id 集(纯内存,Engine 持有并跨 turn 复用)。 */
export type SessionCredentialAllow = Set<string>;

/** 审批问询函数(对接 ToolContext.askUser;返回用户所选 label)。 */
export type CredentialAskFn = (
  question: string,
  opts: {
    header?: string;
    options: { label: string; description: string; tone?: "ok" | "danger" | "neutral" }[];
    optionsOnly: true;
  },
) => Promise<string>;

export interface CredentialUseGateDeps {
  /** settings `credentialUse.autoApprove`(全局总闸)。 */
  autoApprove: boolean;
  /** 该凭证自身的逐条「AI 可自动取用」标志(Credential.autoUseByAI);命中即放行。 */
  credentialAutoUse?: boolean;
  /** 本会话 allow 集(内存,可变;gate 命中「本会话记住」时写入)。 */
  sessionAllow: SessionCredentialAllow;
  /** 审批问询(undefined → 无 UI,headless 直接拒)。 */
  ask?: CredentialAskFn;
}

const ALLOW_ONCE = "允许本次";
const ALLOW_SESSION = "本会话都允许";
const DENY = "拒绝";

/**
 * 过门并返回是否放行。命中「本会话记住」会写入 `deps.sessionAllow`。
 */
export async function credentialUseGate(
  req: CredentialUseRequest,
  deps: CredentialUseGateDeps,
): Promise<CredentialUseDecision> {
  // 1. 全自动(全局总闸,或该凭证逐条开了「AI 可自动取用」)
  if (deps.autoApprove || deps.credentialAutoUse) return { allowed: true };
  // 2. 本会话记住
  if (deps.sessionAllow.has(req.id)) return { allowed: true };
  // 3. 默认弹审批
  if (!deps.ask) return { allowed: false, reason: "no-ui" };

  const purpose = req.purpose?.trim();
  const question = purpose
    ? `AI 想用凭证「${req.label}」(${purpose}),是否允许?`
    : `AI 想用凭证「${req.label}」,是否允许?`;
  const choice = await deps.ask(question, {
    header: "凭证取用",
    options: [
      { label: ALLOW_ONCE, description: "仅本次取用该凭证", tone: "ok" },
      { label: ALLOW_SESSION, description: "本会话内该凭证不再询问(关 app 后失效)", tone: "ok" },
      { label: DENY, description: "拒绝本次取用", tone: "danger" },
    ],
    optionsOnly: true,
  });

  if (choice === ALLOW_SESSION) {
    deps.sessionAllow.add(req.id);
    return { allowed: true };
  }
  if (choice === ALLOW_ONCE) return { allowed: true };
  return { allowed: false, reason: "denied" };
}
