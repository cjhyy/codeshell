import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "../i18n/I18nProvider";
import {
  MIMI_SETTINGS_SECTIONS,
  type MimiSettingsSection,
} from "../pet/settings/mimiSettingsSections";
import { MIMI_SETTINGS_SECTION_META } from "../pet/settings/sectionMeta";

/**
 * The settings center's Mimi entry. Mimi keeps its own settings page; this
 * module only says what is there and jumps to a section.
 */
export function MimiSettingsEntry({
  onOpen,
}: {
  onOpen?: (section?: MimiSettingsSection) => void;
}) {
  const { t } = useT();
  return (
    <section className="grid gap-4" data-mimi-settings-entry>
      <div className="flex flex-wrap items-center gap-3">
        <p className="min-w-0 flex-1 text-sm leading-6 text-muted-foreground">
          {t("mimiSettings.entry.description")}
        </p>
        {onOpen && (
          <Button type="button" size="sm" data-open-mimi-settings onClick={() => onOpen()}>
            {t("mimiSettings.entry.open")}
          </Button>
        )}
      </div>
      <ul className="grid gap-2 sm:grid-cols-2">
        {MIMI_SETTINGS_SECTIONS.map((section) => {
          const { Icon, title, description } = MIMI_SETTINGS_SECTION_META[section];
          return (
            <li key={section}>
              <Button
                type="button"
                variant="outline"
                disabled={!onOpen}
                data-open-mimi-section={section}
                className="h-auto w-full justify-start gap-3 whitespace-normal rounded-xl px-3.5 py-3 text-left font-normal"
                onClick={() => onOpen?.(section)}
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Icon size={16} aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-foreground">{t(title)}</span>
                  <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                    {t(description)}
                  </span>
                </span>
                <ChevronRight size={14} className="shrink-0 text-muted-foreground" aria-hidden />
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
