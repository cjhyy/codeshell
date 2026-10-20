import React, { useEffect, useRef, useState } from "react";
import { Check, FolderOpen, Loader2, Trash2, Upload } from "lucide-react";
import type { ThemeImportKind } from "../../shared/theme-packs";
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
import { ThemePackPreview } from "./ThemePackPreview";
import { ThemeAudioSection } from "./ThemeAudioSection";

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
  const removingRef = useRef<string | null>(null);
  const [removal, setRemoval] = useState<{ id: string; pending: boolean } | null>(null);
  const packListRef = useRef<HTMLDivElement>(null);
  const removalFocus = useRef<{ opener: HTMLButtonElement; removed: boolean } | null>(null);

  const api = globalThis.window?.codeshell;

  useEffect(() => {
    let active = true;
    const reload = (): void => {
      void refreshInstalledThemes().then(() => {
        if (active) {
          setInstalled(installedThemePacks());
          setPackId(loadThemePackId());
        }
      });
    };
    reload();
    const off = api?.onThemesChanged?.(reload);
    return () => {
      active = false;
      off?.();
    };
  }, [api]);

  useEffect(() => {
    const sync = () => setPackId(loadThemePackId());
    const storage = (event: StorageEvent) => {
      if (event.key === "codeshell.theme-pack" || event.key === null) sync();
      if (event.key === "codeshell.theme" || event.key === null) setTheme(loadTheme());
    };
    window.addEventListener("storage", storage);
    window.addEventListener("codeshell:theme-pack-changed", sync);
    return () => {
      window.removeEventListener("storage", storage);
      window.removeEventListener("codeshell:theme-pack-changed", sync);
    };
  }, []);

  useEffect(() => {
    if (removal || !removalFocus.current) return;
    const request = removalFocus.current;
    removalFocus.current = null;
    // Wait for the dialog's close autofocus and the re-enabled/removed card
    // to settle. A reader who moved focus while Host worked keeps that focus.
    const timer = window.setTimeout(() => {
      if (document.activeElement !== document.body) return;
      const target = request.removed
        ? packListRef.current?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')
        : request.opener;
      if (target?.isConnected && !target.disabled) target.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [removal]);

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

  const importPack = async (kind: ThemeImportKind): Promise<void> => {
    if (!api) return;
    setImporting(true);
    try {
      const picked = await api.pickAndPreviewTheme(kind);
      if (picked.cancelled) return;
      const { preview } = picked;
      const parts = [
        preview.hasColors ? t("settingsX.appearance.pack.importColors") : null,
        preview.petStates.length ? t("settingsX.appearance.pack.importPet") : null,
        preview.wallpaperModes.length ? t("settingsX.appearance.pack.importWallpaper") : null,
        preview.surfaceNames?.length ? t("settingsX.appearance.pack.importSurfaces") : null,
        preview.hasFrame ? t("settingsX.appearance.pack.importFrame") : null,
        preview.soundEvents?.length ? t("settingsX.appearance.pack.importSounds") : null,
        preview.musicCount ? t("settingsX.appearance.pack.importMusic") : null,
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

  const removePack = async (pack: ThemePack, opener: HTMLButtonElement): Promise<void> => {
    if (!api || removingRef.current) return;
    removingRef.current = pack.id;
    setRemoval({ id: pack.id, pending: false });
    let removed = false;
    try {
      const approved = await confirm({
        title: t("settingsX.appearance.pack.removeTitle"),
        message: t("settingsX.appearance.pack.removeBody", { name: String(pack.name) }),
        confirmLabel: t("settingsX.appearance.pack.removeAction"),
        destructive: true,
      });
      if (!approved) return;
      setRemoval({ id: pack.id, pending: true });
      await api.uninstallTheme(pack.id);
      removed = true;
      // Read the latest persisted choice, not the closure captured before the
      // dialog. Host notifications may have already removed the pack from the
      // cache, so loadThemePackId() would normalize it before we can clear it.
      if (localStorage.getItem("codeshell.theme-pack") === pack.id) choosePack(DEFAULT_PACK_ID);
      await refreshInstalledThemes();
      setInstalled(installedThemePacks());
      toast({
        message: t("settingsX.appearance.pack.removeDone", { name: String(pack.name) }),
        variant: "success",
      });
    } catch (cause) {
      toast({
        message: t("settingsX.appearance.pack.removeFailed", {
          name: String(pack.name),
          error: cause instanceof Error ? cause.message : String(cause),
        }),
        variant: "error",
      });
    } finally {
      removingRef.current = null;
      removalFocus.current = { opener, removed };
      setRemoval(null);
    }
  };

  const allPacks: ThemePack[] = [...THEME_PACKS, ...installed];
  const activePack = allPacks.find((pack) => pack.id === packId) ?? THEME_PACKS[0]!;

  return (
    <section className="mb-6 flex flex-col gap-3">
      <h3 className="m-0 text-[0.95rem] font-semibold text-foreground">
        {t("settingsX.appearance.title")}
      </h3>
      <p className="m-0 text-xs text-muted-foreground">{t("settingsX.appearance.desc")}</p>
      <div
        role="group"
        aria-label={t("settingsX.appearance.title")}
        className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-2"
      >
        {THEMES.map((item) => (
          <Button
            key={item.id}
            type="button"
            variant="outline"
            aria-pressed={theme === item.id}
            data-theme-mode={item.id}
            className={cn(
              "h-auto min-h-20 flex-col items-start gap-1 whitespace-normal p-3 text-left",
              theme === item.id && "border-primary bg-primary/10 ring-1 ring-primary/30",
            )}
            onClick={() => choose(item.id)}
          >
            <span className="flex w-full items-center justify-between gap-2 text-sm font-medium text-foreground">
              {item.label}
              <Check
                className={cn("size-3.5 shrink-0 text-primary", theme !== item.id && "invisible")}
                aria-hidden
              />
            </span>
            <span className="text-xs text-muted-foreground">{item.description}</span>
          </Button>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="m-0 text-[0.95rem] font-semibold text-foreground">
          {t("settingsX.appearance.packTitle")}
        </h3>
        {api && (
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={importing}
              data-theme-import
              onClick={() => void importPack("zip")}
            >
              <Upload size={13} aria-hidden="true" />
              {t("settingsX.appearance.pack.import")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={importing}
              data-theme-import-directory
              onClick={() => void importPack("directory")}
            >
              <FolderOpen size={13} aria-hidden="true" />
              {t("settingsX.appearance.pack.importDirectory")}
            </Button>
          </div>
        )}
      </div>
      <p className="m-0 text-xs text-muted-foreground">{t("settingsX.appearance.packDesc")}</p>
      <div
        ref={packListRef}
        className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-3"
        data-appearance-packs
      >
        {allPacks.map((pack) => (
          <div
            key={pack.id}
            data-theme-pack={pack.id}
            aria-busy={removal?.id === pack.id && removal.pending ? true : undefined}
            className={cn(
              "group relative overflow-hidden rounded-xl border text-left",
              packId === pack.id
                ? "border-primary bg-primary/10 ring-1 ring-primary/30"
                : "border-border",
            )}
          >
            <Button
              type="button"
              variant="ghost"
              aria-pressed={packId === pack.id}
              className="h-auto w-full flex-col items-stretch gap-3 rounded-xl p-2.5 text-left"
              onClick={() => choosePack(pack.id)}
            >
              <ThemePackPreview pack={pack} />
              <span className="flex min-w-0 items-center gap-2 px-1 pb-1 pr-6">
                <span
                  aria-hidden="true"
                  className="size-3 shrink-0 rounded-full border border-border/60"
                  style={{ backgroundColor: `hsl(${pack.swatch})` }}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-foreground">
                    {packDisplayName(pack, t)}
                  </span>
                  <span className="block text-[11px] font-normal text-muted-foreground">
                    {t(
                      pack.surfaces || pack.frame
                        ? "settingsX.appearance.pack.fullSkin"
                        : pack.wallpaper
                          ? "settingsX.appearance.pack.importWallpaper"
                          : "settingsX.appearance.pack.importColors",
                    )}
                  </span>
                </span>
              </span>
            </Button>
            {pack.source === "installed" && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                data-theme-uninstall={pack.id}
                disabled={removal !== null}
                aria-label={t(
                  removal?.id === pack.id && removal.pending
                    ? "settingsX.appearance.pack.removingNamed"
                    : "settingsX.appearance.pack.removeNamed",
                  { name: String(pack.name) },
                )}
                className="absolute bottom-4 right-2 h-7 w-7 rounded-lg text-muted-foreground hover:bg-status-err/10 hover:text-status-err"
                onClick={(event) => void removePack(pack, event.currentTarget)}
              >
                {removal?.id === pack.id && removal.pending ? (
                  <Loader2
                    size={13}
                    className="animate-spin motion-reduce:animate-none"
                    aria-hidden
                  />
                ) : (
                  <Trash2 size={13} aria-hidden="true" />
                )}
              </Button>
            )}
          </div>
        ))}
      </div>
      <ThemeAudioSection key={activePack.id} pack={activePack} />
    </section>
  );
}
