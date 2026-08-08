/**
 * Build the one-time migration summary for a pre-existing Mimi session from
 * its persisted journal entries (oldest → newest). Pure; no model call — the
 * journal already holds the per-segment distillations.
 */
export function buildMigrationSummary(
  entries: readonly { title: string; summary: string }[],
): string {
  if (entries.length === 0) return "";
  const lines = entries.map((entry) => `【${entry.title}】${entry.summary}`);
  return ["以下是此前各段对话的归档小结（旧 → 新）：", ...lines].join("\n\n");
}
