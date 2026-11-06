import { useEffect, type Dispatch, type SetStateAction } from "react";
import {
  normalizeExternalRuntimeModelKey,
  parseExternalRuntimeModelKey,
} from "../../shared/external-runtime-models";

/**
 * Model choices the Desktop user made in this renderer, per bucket. Such a
 * choice is a next-turn intent the disk cannot know yet, so opening the
 * Session must not replace it with the model its last run used.
 */
const desktopModelChoices = new Map<string, string>();

export function noteDesktopModelChoice(bucket: string, modelKey: string): void {
  desktopModelChoices.set(bucket, modelKey);
}

/**
 * The composer model key a Session's persisted state names exactly: its
 * external runtime, or the configured connection of its last native run.
 * Native model labels alone stay ambiguous and are never matched back to a key.
 */
export function persistedSessionModelKey(meta: {
  model?: string;
  provider?: string;
  modelConnectionId?: string;
}): string | undefined {
  const { model, provider } = meta;
  // Same precedence as Main's persistedExternalRuntimeModelKey: a known
  // external provider wins over a lingering connection id.
  const externalProvider = provider === "codex" || provider === "claude-code";
  if (externalProvider || !provider) {
    const key = parseExternalRuntimeModelKey(model)
      ? model
      : externalProvider
        ? `${provider}/${model ?? ""}`
        : undefined;
    if (key && parseExternalRuntimeModelKey(key)?.model) {
      return normalizeExternalRuntimeModelKey(key);
    }
    if (externalProvider) return undefined;
  }
  return meta.modelConnectionId || undefined;
}

/** Apply a persisted Session model unless it conflicts with an unsent Desktop choice. */
export function reconcileModelOverride(
  overrides: Record<string, string>,
  bucket: string,
  persisted: string,
  choices: ReadonlyMap<string, string> = desktopModelChoices,
): Record<string, string> {
  const current = overrides[bucket];
  if (current === persisted) return overrides;
  if (current !== undefined && choices.get(bucket) === current) return overrides;
  return { ...overrides, [bucket]: persisted };
}

/**
 * Opening a Session shows the model it actually runs on. Live changes from
 * another client arrive through agent/mobileSessionSettings; this covers the
 * ones made while this renderer was not listening.
 */
export function useSessionModelReconcile(
  bucket: string,
  engineSessionId: string | null,
  setModelOverrides: Dispatch<SetStateAction<Record<string, string>>>,
): void {
  useEffect(() => {
    if (!engineSessionId || typeof window.codeshell.listDiskSessions !== "function") return;
    let cancelled = false;
    void Promise.resolve()
      .then(() => window.codeshell.listDiskSessions({ limit: 1, sessionId: engineSessionId }))
      .then(({ sessions }) => {
        const persisted = sessions[0] ? persistedSessionModelKey(sessions[0]) : undefined;
        if (cancelled || !persisted) return;
        // Disk has caught up with the choice (it was sent), so it no longer
        // needs protection from a later change made by another client.
        if (desktopModelChoices.get(bucket) === persisted) desktopModelChoices.delete(bucket);
        setModelOverrides((previous) => reconcileModelOverride(previous, bucket, persisted));
      })
      .catch((error) => {
        window.codeshell.log("session.model_reconcile_failed", {
          sessionId: engineSessionId,
          error: String(error),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [bucket, engineSessionId, setModelOverrides]);
}
