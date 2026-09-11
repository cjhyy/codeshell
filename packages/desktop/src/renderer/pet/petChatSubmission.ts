import type { PetDispatchResult } from "../../preload/pet-api";
import type { TFunction } from "../i18n";

/** A retained send intent lets a transport retry use the original id. */
export interface PetChatSubmission {
  clientMessageId: string;
  message: string;
  draft: string;
  paths: string[];
  model?: string;
  preferredProjectPath?: string;
}

export interface PetChatFailure extends PetChatSubmission {
  error: string;
  /** Unknown transport outcomes may be retried idempotently. Completed receipts
   * need a new user intent, created by restoring the draft and sending again. */
  retryable: boolean;
}

export function petChatResultFailure(
  result: PetDispatchResult,
  t: TFunction,
): { error: string; retryable: boolean } | null {
  if (!result.ok) return { error: result.message || t("pet.chat.failed"), retryable: true };
  if (result.type !== "chat") return null;
  if (result.delegationError) return { error: result.delegationError, retryable: false };
  const run = result.result;
  if (!run || typeof run !== "object") return null;
  const { reason, text } = run as { reason?: unknown; text?: unknown };
  if (
    typeof reason !== "string" ||
    reason === "completed" ||
    reason === "steered" ||
    reason === "context_cleared"
  )
    return null;
  return {
    error:
      reason === "aborted_streaming" || reason === "aborted_tools"
        ? t("pet.chat.stopped")
        : typeof text === "string" && text.trim()
          ? text.trim()
          : t("pet.chat.failed"),
    retryable: false,
  };
}
