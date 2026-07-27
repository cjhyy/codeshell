import React, { useState } from "react";
import {
  applyTheme,
  applyThemePack,
  loadTheme,
  loadThemePackId,
  saveTheme,
  saveThemePackId,
  type Theme,
} from "../theme";
import { THEME_PACKS } from "../theme-packs";
import { cn } from "@/lib/utils";
import { useT } from "../i18n/I18nProvider";
import { Button } from "@/components/ui/button";

export function AppearanceSection() {
  const { t } = useT();
  const THEMES: Array<{ id: Theme; label: string; description: string }> = [
    {
      id: "system",
      label: t("settingsX.appearance.system"),
      description: t("settingsX.appearance.systemDesc"),
    },
    {
      id: "light",
      label: t("settingsX.appearance.light"),
      description: t("settingsX.appearance.lightDesc"),
    },
    {
      id: "dark",
      label: t("settingsX.appearance.dark"),
      description: t("settingsX.appearance.darkDesc"),
    },
  ];
  const [theme, setTheme] = useState<Theme>(() => loadTheme());
  const [packId, setPackId] = useState<string>(() => loadThemePackId());

  const choose = (next: Theme): void => {
    setTheme(next);
    saveTheme(next);
    applyTheme(next);
  };

  const choosePack = (next: string): void => {
    setPackId(next);
    saveThemePackId(next);
    applyThemePack(next);
  };

  return (
    <section className="mb-6 flex flex-col gap-3">
      <h3 className="m-0 text-[0.95rem] font-semibold text-foreground">
        {t("settingsX.appearance.title")}
      </h3>
      <p className="m-0 text-xs text-muted-foreground">{t("settingsX.appearance.desc")}</p>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-2">
        {THEMES.map((item) => (
          <Button
            key={item.id}
            type="button"
            variant="outline"
            className={cn(
              "h-auto min-h-20 flex-col items-start gap-1 whitespace-normal p-3 text-left",
              theme === item.id && "border-primary bg-primary/10 ring-1 ring-primary/30",
            )}
            onClick={() => choose(item.id)}
          >
            <span className="text-sm font-medium text-foreground">{item.label}</span>
            <span className="text-xs text-muted-foreground">{item.description}</span>
          </Button>
        ))}
      </div>

      <h3 className="m-0 mt-3 text-[0.95rem] font-semibold text-foreground">
        {t("settingsX.appearance.packTitle")}
      </h3>
      <p className="m-0 text-xs text-muted-foreground">{t("settingsX.appearance.packDesc")}</p>
      <div
        className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-2"
        data-appearance-packs
      >
        {THEME_PACKS.map((pack) => (
          <Button
            key={pack.id}
            type="button"
            variant="outline"
            data-theme-pack={pack.id}
            aria-pressed={packId === pack.id}
            className={cn(
              "h-auto min-h-16 flex-row items-center gap-2.5 whitespace-normal p-3 text-left",
              packId === pack.id && "border-primary bg-primary/10 ring-1 ring-primary/30",
            )}
            onClick={() => choosePack(pack.id)}
          >
            <span
              aria-hidden="true"
              className="h-6 w-6 shrink-0 rounded-full border border-border/60"
              style={{ backgroundColor: `hsl(${pack.swatch})` }}
            />
            <span className="text-sm font-medium text-foreground">{t(pack.name)}</span>
          </Button>
        ))}
      </div>
    </section>
  );
}
