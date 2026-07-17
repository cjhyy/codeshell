import type { PetApi, PetWorkInboxSnapshot, PetWorkInboxUpdate } from "../../preload/types";

const STORAGE_KEY = "codeshell.pet.work-inbox.dismissed.v1";
const MAX_DISMISSED_ITEMS = 1_000;
const WORK_ITEM_ID_PATTERN =
  /^(?:pending|unfinished|optimization|completed|other|follow-up):[^\u0000\r\n]+$/;

type PetWorkInboxPersistence = Pick<
  PetApi,
  "getDismissedWorkItemIds" | "updateDismissedWorkItemIds"
>;

function normalizeIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter(
        (item): item is string =>
          typeof item === "string" &&
          item.length > 0 &&
          item.length <= 512 &&
          WORK_ITEM_ID_PATTERN.test(item),
      ),
    ),
  ].slice(-MAX_DISMISSED_ITEMS);
}

function readLegacyIds(): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    return raw ? normalizeIds(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

function saveLegacyIds(ids: readonly string[]): void {
  try {
    const normalized = normalizeIds(ids);
    if (normalized.length === 0) {
      globalThis.localStorage?.removeItem(STORAGE_KEY);
      return;
    }
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // Hiding inbox rows is a convenience; unavailable storage must not break Mimi.
  }
}

function clearLegacyIds(): void {
  try {
    globalThis.localStorage?.removeItem(STORAGE_KEY);
  } catch {
    // A migrated main-process preference does not depend on renderer storage cleanup.
  }
}

export function normalizePetWorkInboxSnapshot(value: unknown): PetWorkInboxSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(record.revision) ||
    (record.revision as number) < 0 ||
    !Array.isArray(record.dismissedIds)
  ) {
    return null;
  }
  return {
    revision: record.revision as number,
    dismissedIds: normalizeIds(record.dismissedIds),
  };
}

export function newerPetWorkInboxSnapshot(
  value: unknown,
  currentRevision: number,
): PetWorkInboxSnapshot | null {
  const snapshot = normalizePetWorkInboxSnapshot(value);
  return snapshot && snapshot.revision > currentRevision ? snapshot : null;
}

/**
 * Hydrates the main-process preference and unions the legacy renderer value
 * once. A failed IPC boundary keeps the legacy value as a best-effort fallback.
 */
export async function loadDismissedPetWorkItemIds(
  persistence: PetWorkInboxPersistence,
): Promise<PetWorkInboxSnapshot> {
  const legacyIds = readLegacyIds();
  let durable: PetWorkInboxSnapshot;
  try {
    const snapshot = normalizePetWorkInboxSnapshot(await persistence.getDismissedWorkItemIds());
    if (!snapshot) throw new Error("invalid work inbox snapshot");
    durable = snapshot;
  } catch {
    return { revision: 0, dismissedIds: legacyIds };
  }
  if (legacyIds.length === 0) {
    clearLegacyIds();
    return durable;
  }
  try {
    const migrated = normalizePetWorkInboxSnapshot(
      await persistence.updateDismissedWorkItemIds({ action: "add", ids: legacyIds }),
    );
    if (!migrated) throw new Error("invalid migrated work inbox snapshot");
    clearLegacyIds();
    return migrated;
  } catch {
    const merged = normalizeIds([...durable.dismissedIds, ...legacyIds]);
    saveLegacyIds(merged);
    return { revision: durable.revision, dismissedIds: merged };
  }
}

export async function updateDismissedPetWorkItemIds(
  persistence: PetWorkInboxPersistence,
  update: PetWorkInboxUpdate,
  fallbackIds: ReadonlySet<string>,
): Promise<PetWorkInboxSnapshot | null> {
  try {
    const snapshot = normalizePetWorkInboxSnapshot(
      await persistence.updateDismissedWorkItemIds(update),
    );
    if (!snapshot) throw new Error("invalid work inbox snapshot");
    clearLegacyIds();
    return snapshot;
  } catch {
    saveLegacyIds([...fallbackIds]);
    return null;
  }
}
