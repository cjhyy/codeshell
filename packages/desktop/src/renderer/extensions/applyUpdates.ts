/**
 * Post-update hot-reload + batch-update helpers for the plugin / skill tabs.
 *
 * Hot-reload (feedback: "更新后重载生效"): plugin/skill files live on disk and
 * the engine reads them live — the per-turn PromptComposer + the Skill tool both
 * `scanSkills(cwd)` at use time, so skills/commands a fresh update writes are
 * picked up on the NEXT turn with no restart. Hooks + MCP are the only pieces
 * held in engine state, and those already hot-reload off the
 * `codeshell:settings-changed` event (App.tsx → configure({reloadSettings}) →
 * every running session re-runs reloadHooks + MCP reconcile at its next turn
 * boundary, see [[project_config_hotreload_layer2]]). So a successful update
 * just needs to fire that same event — no new core wiring.
 */

/** Signal already-running sessions to re-pull config (hooks/MCP) after an update. */
export function signalHotReload(): void {
  window.dispatchEvent(new Event("codeshell:settings-changed"));
}

export interface UpdateOutcome {
  /** Identifier (plugin name / skill filePath) for messaging. */
  id: string;
  /** Human label for toasts. */
  label: string;
  updated: boolean;
  /** Reason when not updated (e.g. "already up to date") or an error message. */
  reason?: string;
  error?: boolean;
}

/**
 * Run `updateOne` over every id, sequentially (git fetch per item — serial keeps
 * network/disk pressure sane and output deterministic). Never throws: a per-item
 * failure becomes an `error: true` outcome so one bad update can't abort the rest.
 */
export async function runBatchUpdate(
  ids: string[],
  labelOf: (id: string) => string,
  updateOne: (id: string) => Promise<{ updated: boolean; reason?: string }>,
): Promise<UpdateOutcome[]> {
  const outcomes: UpdateOutcome[] = [];
  for (const id of ids) {
    try {
      const r = await updateOne(id);
      outcomes.push({ id, label: labelOf(id), updated: r.updated, reason: r.reason });
    } catch (e) {
      outcomes.push({
        id,
        label: labelOf(id),
        updated: false,
        error: true,
        reason: (e as Error)?.message ?? String(e),
      });
    }
  }
  return outcomes;
}

/** Summarize batch outcomes into a single toast message. */
export function summarizeBatch(outcomes: UpdateOutcome[]): { message: string; ok: boolean } {
  const updated = outcomes.filter((o) => o.updated);
  const failed = outcomes.filter((o) => o.error);
  const noop = outcomes.filter((o) => !o.updated && !o.error);
  const parts: string[] = [];
  if (updated.length) parts.push(`已更新 ${updated.length} 个`);
  if (noop.length) parts.push(`${noop.length} 个已是最新`);
  if (failed.length) parts.push(`${failed.length} 个失败`);
  return {
    message: parts.length ? parts.join("，") : "没有可更新项",
    ok: failed.length === 0,
  };
}
