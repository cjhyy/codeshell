/**
 * Monotonic tab-id counter; module-level so ids stay unique across remounts.
 * A renderer reload re-evaluates this module, while a terminal shell keyed by
 * a closed tab's id survives in Main for the same window. Seeding from the
 * clock starts every load above the ids any earlier load issued, so a new tab
 * never reattaches to such a shell. Persisted ids keep the `${kind}-${n}` form.
 */
let panelTabSeq = Date.now();

/**
 * Fresh, collision-proof tab id. Tabs are persisted per bucket; bump past ids
 * already present in this bucket so restored and newly-opened tabs don't collide.
 */
export function nextPanelTabId(
  kind: string,
  existing: readonly { id: string; kind: string }[],
): string {
  const prefix = `${kind}-`;
  let max = panelTabSeq;
  for (const tb of existing) {
    if (tb.kind !== kind || !tb.id.startsWith(prefix)) continue;
    const n = Number(tb.id.slice(prefix.length));
    if (Number.isFinite(n) && n > max) max = n;
  }
  panelTabSeq = max + 1;
  return `${prefix}${panelTabSeq}`;
}
