import type { PetLongTask } from "@cjhyy/code-shell-pet";
import {
  collectNoticeArtifacts,
  type ChangedFiles,
  type NoticeActionsInput,
} from "./pet-notice-action-codes.js";
import type { NoticeDraft } from "./pet-session-rule-watcher.js";
import type { SessionOutcome } from "./session-outcome.js";

/** Sessions whose latest changed files are remembered for a long task's closure. */
const MAX_REMEMBERED = 200;

export interface NoticeActionSourcesDeps {
  isExternal(sessionId: string): boolean;
  activeTask(sessionId: string): PetLongTask | undefined;
  /** The Session's last user message (retry resends it); without it a failure offers no retry. */
  lastUserMessage?: (sessionId: string) => Promise<string | undefined>;
  log?: (event: string, data: Record<string, unknown>) => void;
}

export interface NoticeActionSources {
  /**
   * The open item a rule-watcher draft asks for, if any: a Goal pause or
   * limit stop, a failure, a result with something to open (structured
   * sources only). A failure waits for the transcript read that decides
   * whether retry is offered.
   */
  forDraft(
    draft: NoticeDraft,
  ): NoticeActionsInput | undefined | Promise<NoticeActionsInput | undefined>;
  /** The open item of a long task's closure notice (completed / failed). */
  forTask(task: PetLongTask): NoticeActionsInput | undefined;
  /** Remember the files each done outcome changed, for a later task closure. */
  observe(sessionId: string, outcomes: readonly SessionOutcome[]): void;
}

/** What each notice's open item offers, from the outcome it reports (design §7 / §9). */
export function createNoticeActionSources(deps: NoticeActionSourcesDeps): NoticeActionSources {
  const changed = new Map<string, { files: ChangedFiles; at: number }>();
  const base = (sessionId: string) =>
    ({ sessionId, runtime: deps.isExternal(sessionId) ? "external" : "native" }) as const;

  async function failure(sessionId: string): Promise<NoticeActionsInput> {
    let retry = false;
    try {
      retry = Boolean((await deps.lastUserMessage?.(sessionId))?.trim());
    } catch (error) {
      deps.log?.("pet.notice.last_message_unreadable", {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return { ...base(sessionId), family: "failure", ...(retry ? { retry: true } : {}) };
  }

  return {
    forDraft(draft) {
      const { sessionId, context } = draft;
      switch (draft.kind) {
        case "session.blocked": {
          const reason = context?.reason ?? "user";
          const task = deps.activeTask(sessionId);
          return {
            ...base(sessionId),
            family: reason === "user" ? "goal" : "limit",
            reason,
            ...(context?.goalId ? { goalId: context.goalId } : {}),
            ...(context?.revision !== undefined && context.revision >= 1
              ? { revision: context.revision }
              : {}),
            ...(task ? { taskId: task.id } : {}),
          };
        }
        case "session.failed":
          return failure(sessionId);
        case "session.done": {
          const artifacts = collectNoticeArtifacts({
            ...(context?.changedFiles ? { changed: context.changedFiles } : {}),
          });
          return artifacts.length > 0
            ? { ...base(sessionId), family: "open", artifacts }
            : undefined;
        }
      }
    },
    forTask(task) {
      if (task.status === "failed")
        return { ...base(task.sessionId), family: "failure", taskId: task.id, retry: true };
      if (task.status !== "completed") return undefined;
      const remembered = changed.get(task.sessionId);
      // Files changed before this task began belong to some earlier work.
      const files = remembered && remembered.at >= task.createdAt ? remembered.files : undefined;
      const artifacts = collectNoticeArtifacts({
        ...(files ? { changed: files } : {}),
        task: task.artifacts,
      });
      return artifacts.length > 0
        ? { ...base(task.sessionId), family: "open", taskId: task.id, artifacts }
        : undefined;
    },
    observe(sessionId, outcomes) {
      for (const outcome of outcomes) {
        if (outcome.kind !== "done" || !outcome.changedFiles?.paths.length) continue;
        changed.delete(sessionId);
        changed.set(sessionId, { files: outcome.changedFiles, at: outcome.at });
        if (changed.size > MAX_REMEMBERED) changed.delete(changed.keys().next().value!);
      }
    },
  };
}
