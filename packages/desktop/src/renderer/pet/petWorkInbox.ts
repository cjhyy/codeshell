const STORAGE_KEY = "codeshell.pet.work-inbox.dismissed.v1";
const MAX_DISMISSED_ITEMS = 1_000;

function normalizeIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter(
        (item): item is string => typeof item === "string" && item.length > 0 && item.length <= 512,
      ),
    ),
  ].slice(-MAX_DISMISSED_ITEMS);
}

/** Best-effort renderer preference. The work source remains the session projection. */
export function loadDismissedPetWorkItemIds(): Set<string> {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    return new Set(raw ? normalizeIds(JSON.parse(raw)) : []);
  } catch {
    return new Set();
  }
}

export function saveDismissedPetWorkItemIds(ids: ReadonlySet<string>): void {
  try {
    const normalized = normalizeIds([...ids]);
    if (normalized.length === 0) {
      globalThis.localStorage?.removeItem(STORAGE_KEY);
      return;
    }
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // Hiding inbox rows is a convenience; unavailable storage must not break Mimi.
  }
}
