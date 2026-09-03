/**
 * Whether one Sessions selector may become this conversation's bound Session.
 *
 * Entering a Session routes the user's future messages into it, so this gate
 * is deliberately stricter than the read-only Sessions listing. The listing's
 * catalog (disclosure/catalog.ts) excludes pet, subagent, child and ephemeral
 * sessions but says nothing about archivedAt or origin, and it knows nothing
 * about whether the Session's directory still exists. Binding on the catalog
 * alone would therefore fail open on an archived Session or one whose worktree
 * was deleted — the message would be written somewhere the user did not mean.
 *
 * Order matters: the cheap identity checks run before any filesystem work, and
 * every failure returns a reason the host can show the user verbatim rather
 * than a generic refusal.
 */
import { stat } from "node:fs/promises";
import type { PetReusableSessionCandidate } from "./pet-dispatch-service.js";

export type BindRefusalReason =
  | "unknown-session"
  | "archived-session"
  | "workspace-missing"
  | "group-chat"
  | "unaddressable-conversation";

export interface BindCandidate {
  sessionId: string;
  title: string;
  workspacePath: string;
}

export type BindValidation =
  | { ok: true; candidate: BindCandidate }
  | { ok: false; reason: BindRefusalReason; message: string };

export interface BindValidatorDeps {
  /**
   * The strict resolver (reusable-session-resolver.ts): catalog membership
   * plus the archivedAt and origin==="desktop" gates that DelegateWork's
   * reuse path already enforces.
   */
  resolveSelector(selector: string): Promise<PetReusableSessionCandidate | null>;
  /** Directory existence, injectable so tests need no real worktree. */
  directoryExists?(path: string): Promise<boolean>;
}

const REFUSAL_MESSAGES: Record<BindRefusalReason, string> = {
  "unknown-session": "找不到这个 Session，可能已被删除。先让我列出最近的 Session，再选一个。",
  "archived-session": "这个 Session 已归档，不能进入。可以先在桌面端恢复它。",
  "workspace-missing":
    "这个 Session 的工作目录已经不存在了（可能 worktree 被删除），进入会把消息写到一个无效目录。",
  "group-chat": "进入 Session 目前只支持私聊。请私聊我再试一次。",
  "unaddressable-conversation": "这个会话缺少可用的身份信息，无法安全绑定。",
};

async function defaultDirectoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export interface ValidateBindInput {
  selector: string;
  /** False for a group conversation; Phase 1 binds private chats only. */
  isDirectMessage: boolean;
  /** Whether the host could build a stable routeKey for this conversation. */
  isAddressable: boolean;
}

export function createConversationSessionBindValidator(deps: BindValidatorDeps) {
  const directoryExists = deps.directoryExists ?? defaultDirectoryExists;
  return async function validate(input: ValidateBindInput): Promise<BindValidation> {
    const refuse = (reason: BindRefusalReason): BindValidation => ({
      ok: false,
      reason,
      message: REFUSAL_MESSAGES[reason],
    });

    // A group binds per-sender but replies land in the whole room, so two
    // people entering different Sessions would read each other's output.
    if (!input.isDirectMessage) return refuse("group-chat");
    if (!input.isAddressable) return refuse("unaddressable-conversation");

    const candidate = await deps.resolveSelector(input.selector);
    // The resolver folds "not in the catalog" and "archived or foreign origin"
    // into one null, so an archived Session is reported precisely only when a
    // caller distinguishes them; both are equally fail-closed here.
    if (!candidate) return refuse("unknown-session");

    if (!candidate.workspacePath || !(await directoryExists(candidate.workspacePath))) {
      return refuse("workspace-missing");
    }

    return {
      ok: true,
      candidate: {
        sessionId: candidate.sessionId,
        title: candidate.title,
        workspacePath: candidate.workspacePath,
      },
    };
  };
}
