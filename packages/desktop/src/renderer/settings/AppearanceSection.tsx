import React, { useState } from "react";
import { applyTheme, loadTheme, saveTheme, type Theme } from "../theme";
import { cn } from "@/lib/utils";
import { useT } from "../i18n/I18nProvider";

export function AppearanceSection() {
  const { t } = useT();
  const THEMES: Array<{ id: Theme; label: string; description: string }> = [
    { id: "system", label: t("settingsX.appearance.system"), description: t("settingsX.appearance.systemDesc") },
    { id: "light", label: t("settingsX.appearance.light"), description: t("settingsX.appearance.lightDesc") },
    { id: "dark", label: t("settingsX.appearance.dark"), description: t("settingsX.appearance.darkDesc") },
  ];
  const [theme, setTheme] = useState<Theme>(() => loadTheme());

  const choose = (next: Theme): void => {
    setTheme(next);
    saveTheme(next);
    applyTheme(next);
  };

  return (
    <section className="mb-6 flex flex-col gap-3">
      <h3 className="m-0 text-[0.95rem] font-semibold text-foreground">{t("settingsX.appearance.title")}</h3>
      <p className="m-0 text-xs text-muted-foreground">{t("settingsX.appearance.desc")}</p>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-2">
        {THEMES.map((item) => (
          <button
            key={item.id}
            className={cn(
              "flex cursor-pointer flex-col items-start gap-1 rounded-md border bg-transparent p-3 text-left hover:bg-accent",
              theme === item.id && "border-primary bg-primary/10 ring-1 ring-primary/30",
            )}
            onClick={() => choose(item.id)}
          >
            <span className="text-sm font-medium text-foreground">{item.label}</span>
            <span className="text-xs text-muted-foreground">{item.description}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
