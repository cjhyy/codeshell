import { useCallback, useRef, useState } from "react";
import type { ViewMode } from "../view";
import type { TranslationKey } from "../i18n";
import type { SettingsModuleId } from "../settings/SettingsPage";
import {
  loadMimiSettingsSection,
  saveMimiSettingsSection,
  type MimiSettingsSection,
} from "../pet/settings/mimiSettingsSections";

/** Where "back" on the Mimi settings page goes. */
export interface MimiSettingsOrigin {
  view: ViewMode;
  /** The settings center module that linked here (Mimi entry, Computer Use…). */
  settingsModule?: SettingsModuleId;
}

export interface OpenMimiSettingsOptions {
  section?: MimiSettingsSection;
  /** Defaults to the view that is open now. */
  origin?: MimiSettingsOrigin;
}

/** The back button names where it goes. */
export function mimiSettingsBackLabel(origin: MimiSettingsOrigin): TranslationKey {
  if (origin.view === "settings_page" || origin.view === "project_config")
    return "mimiSettings.back.settings";
  if (origin.view === "credentials") return "mimiSettings.back.credentials";
  if (origin.view === "pet" || origin.view === "pet_settings" || origin.view === "pet_memory")
    return "mimiSettings.back.pet";
  return "mimiSettings.back.other";
}

// Views that are part of the Mimi settings round trip: opening from them is
// not a new origin (an in-page jump, or the memory center's own back).
const MIMI_SETTINGS_VIEWS: ReadonlySet<ViewMode> = new Set(["pet_settings", "pet_memory"]);

/**
 * One Mimi settings page reached from the Mimi page, the settings center,
 * Computer Use and the credentials page. It opens on a section (deep link or
 * the last one seen) and "back" returns to whichever surface opened it.
 */
export function useMimiSettingsNavigation({
  viewMode,
  setViewMode,
  openPetPage,
  openSettingsModule,
}: {
  viewMode: ViewMode;
  setViewMode: (view: ViewMode) => void;
  openPetPage: () => void;
  openSettingsModule: (module: SettingsModuleId) => void;
}) {
  const [section, setSection] = useState<MimiSettingsSection>(loadMimiSettingsSection);
  // A restored pet_settings view (app restart) has no opener: the Mimi page.
  const [origin, setOrigin] = useState<MimiSettingsOrigin>({ view: "pet" });
  const viewModeRef = useRef(viewMode);
  viewModeRef.current = viewMode;

  const selectMimiSettingsSection = useCallback((next: MimiSettingsSection) => {
    setSection(next);
    saveMimiSettingsSection(next);
  }, []);

  const openMimiSettings = useCallback(
    (options: OpenMimiSettingsOptions = {}) => {
      if (options.section) selectMimiSettingsSection(options.section);
      const current = viewModeRef.current;
      if (!MIMI_SETTINGS_VIEWS.has(current)) setOrigin(options.origin ?? { view: current });
      if (current !== "pet_settings") setViewMode("pet_settings");
    },
    [selectMimiSettingsSection, setViewMode],
  );

  const leaveMimiSettings = useCallback(() => {
    if (origin.view === "settings_page" && origin.settingsModule)
      openSettingsModule(origin.settingsModule);
    else if (origin.view === "pet" || MIMI_SETTINGS_VIEWS.has(origin.view)) openPetPage();
    else setViewMode(origin.view);
  }, [origin, openPetPage, openSettingsModule, setViewMode]);

  return {
    mimiSettingsSection: section,
    mimiSettingsOrigin: origin,
    selectMimiSettingsSection,
    openMimiSettings,
    leaveMimiSettings,
  };
}
