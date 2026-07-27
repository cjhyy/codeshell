import React, { useEffect, useState } from "react";
import { Trash2, Upload } from "lucide-react";
import {
  applyTheme,
  applyThemePack,
  loadTheme,
  loadThemePackId,
  saveTheme,
  saveThemePackId,
  type Theme,
} from "../theme";
import { THEME_PACKS, DEFAULT_PACK_ID, type ThemePack } from "../theme-packs";
import { installedThemePacks, refreshInstalledThemes } from "../installedThemes";
import { cn } from "@/lib/utils";
import { useT } from "../i18n/I18nProvider";
import type { TranslationKey } from "../i18n";
import { Button } from "@/components/ui/button";
import { useConfirm } from "../ui/DialogProvider";
import { useToast } from "../ui/ToastProvider";

/**
 * Builtin packs carry an i18n key in `name`; installed packs carry a plain
 * author-supplied string. Resolve to a display string for either.
 */
function packDisplayName(pack: ThemePack, t: (key: TranslationKey) => string): string {
  return pack.source === "installed" ? String(pack.name) : t(pack.name as TranslationKey);
}

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
  const confirm = useConfirm();
  const toast = useToast();
  const [theme, setTheme] = useState<Theme>(() => loadTheme());
  const [packId, setPackId] = useState<string>(() => loadThemePackId());
  const [installed, setInstalled] = useState<ThemePack[]>(() => installedThemePacks());
  const [importing, setImporting] = useState(false);

  const api = globalThis.window?.codeshell;

  useEffect(() => {
    let active = true;
    const reload = (): void => {
      void refreshInstalledThemes().then(() => {
        if (active) setInstalled(installedThemePacks());
      });
    };
    reload();
    const off = api?.onThemesChanged?.(reload);
    return () => {
      active = false;
      off?.();
    };
  }, [api]);

  const choose = (next: Theme): void => {
    setTheme(next);
    saveTheme(next);
    applyTheme(next);
  };

  const choosePack = (next: string): void => {
    setPackId(next);
    saveThemePackId(next);
    applyThemePack(next);
    // `storage` only fires in OTHER windows; notify this one so a live pet
    // sprite / preview in the same window updates immediately too.
    window.dispatchEvent(new Event("codeshell:theme-pack-changed"));
  };

  const importPack = async (): Promise<void> => {
    if (!api) return;
    setImporting(true);
    try {
      const picked = await api.pickAndPreviewTheme();
      if (picked.cancelled) return;
      const { preview } = picked;
      const parts = [
        preview.hasColors ? t("settingsX.appearance.pack.importColors") : null,
        preview.petStates.length ? t("settingsX.appearance.pack.importPet") : null,
        preview.wallpaperModes.length ? t("settingsX.appearance.pack.importWallpaper") : null,
      ].filter(Boolean);
      const approved = await confirm({
        title: t("settingsX.appearance.pack.importConfirmTitle", { name: preview.name }),
        message:
          `${t("settingsX.appearance.pack.importConfirmBody", {
            version: preview.version,
            contents: parts.join("、") || t("settingsX.appearance.pack.importNothing"),
          })}` + (preview.warnings.length ? `\n\n⚠ ${preview.warnings.join("\n")}` : ""),
        confirmLabel: t("settingsX.appearance.pack.importAction"),
      });
      if (!approved) return;
      const pack = await api.installTheme({ path: picked.path, reviewToken: preview.reviewToken });
      await refreshInstalledThemes();
      setInstalled(installedThemePacks());
      choosePack(pack.id); // activate what was just imported
      toast({ message: t("settingsX.appearance.pack.importDone", { name: pack.name }) });
    } catch (cause) {
      toast({
        message: t("settingsX.appearance.pack.importFailed", {
          error: cause instanceof Error ? cause.message : String(cause),
        }),
        variant: "error",
      });
    } finally {
      setImporting(false);
    }
  };

  const removePack = async (pack: ThemePack): Promise<void> => {
    if (!api) return;
    const approved = await confirm({
      title: t("settingsX.appearance.pack.removeTitle"),
      message: t("settingsX.appearance.pack.removeBody", { name: String(pack.name) }),
      confirmLabel: t("settingsX.appearance.pack.removeAction"),
      destructive: true,
    });
    if (!approved) return;
    // If the removed pack is active, fall back to default before it vanishes.
    if (packId === pack.id) choosePack(DEFAULT_PACK_ID);
    await api.uninstallTheme(pack.id);
    await refreshInstalledThemes();
    setInstalled(installedThemePacks());
  };

  const allPacks: ThemePack[] = [...THEME_PACKS, ...installed];

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

      <div className="mt-3 flex items-center justify-between gap-2">
        <h3 className="m-0 text-[0.95rem] font-semibold text-foreground">
          {t("settingsX.appearance.packTitle")}
        </h3>
        {api && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={importing}
            data-theme-import
            onClick={() => void importPack()}
          >
            <Upload size={13} aria-hidden="true" />
            {t("settingsX.appearance.pack.import")}
          </Button>
        )}
      </div>
      <p className="m-0 text-xs text-muted-foreground">{t("settingsX.appearance.packDesc")}</p>
      <div
        className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-2"
        data-appearance-packs
      >
        {allPacks.map((pack) => (
          <div
            key={pack.id}
            data-theme-pack={pack.id}
            className={cn(
              "group relative flex items-center gap-2.5 rounded-md border p-3 text-left",
              packId === pack.id
                ? "border-primary bg-primary/10 ring-1 ring-primary/30"
                : "border-border",
            )}
          >
            <button
              type="button"
              aria-pressed={packId === pack.id}
              className="flex min-w-0 flex-1 items-center gap-2.5 bg-transparent text-left outline-none"
              onClick={() => choosePack(pack.id)}
            >
              <span
                aria-hidden="true"
                className="h-6 w-6 shrink-0 rounded-full border border-border/60"
                style={{ backgroundColor: `hsl(${pack.swatch})` }}
              />
              <span className="truncate text-sm font-medium text-foreground">
                {packDisplayName(pack, t)}
              </span>
            </button>
            {pack.source === "installed" && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                data-theme-uninstall={pack.id}
                aria-label={t("settingsX.appearance.pack.removeAction")}
                className="h-7 w-7 shrink-0 rounded-lg text-muted-foreground hover:bg-status-err/10 hover:text-status-err"
                onClick={() => void removePack(pack)}
              >
                <Trash2 size={13} aria-hidden="true" />
              </Button>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
