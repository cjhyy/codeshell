export const PET_WIDGET_VISIBLE_STORAGE_KEY = "codeshell.pet.widgetVisible";

type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;

export function loadPetWidgetVisible(
  storage: PreferenceStorage | undefined = globalThis.localStorage,
): boolean {
  try {
    return storage?.getItem(PET_WIDGET_VISIBLE_STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
}

export function savePetWidgetVisible(
  visible: boolean,
  storage: PreferenceStorage | undefined = globalThis.localStorage,
): void {
  try {
    storage?.setItem(PET_WIDGET_VISIBLE_STORAGE_KEY, visible ? "1" : "0");
  } catch {
    // Preference persistence is best-effort; the current window still updates.
  }
}
