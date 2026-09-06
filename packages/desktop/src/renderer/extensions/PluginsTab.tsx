import { useEffect, useState } from "react";
import type {
  LocalPluginPreview,
  PluginMediaDto,
  PluginSummary,
  RendererConfigurationTarget,
} from "../../preload/types";
import { resolveUninstallTarget } from "./uninstallTarget";
import { PluginDetailView } from "./PluginDetailView";
import { PluginInstallReviewDialog } from "./PluginInstallReviewDialog";
import {
  ArrowUpCircle,
  ChevronRight,
  FileArchive,
  FolderPlus,
  Loader2,
  MoreHorizontal,
  Puzzle,
  Search,
} from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { useConfirm, useAlert } from "../ui/DialogProvider";
import { useToast } from "../ui/ToastProvider";
import { signalHotReload, runBatchUpdate, summarizeBatch } from "./applyUpdates";
import { useT } from "../i18n/I18nProvider";
import { pluginLogoSources, shouldLoadPluginListMedia } from "./pluginPresentation";

interface Props {
  cwd: string;
  configurationTarget: RendererConfigurationTarget;
  query: string;
  isEnabled: (p: PluginSummary) => boolean;
  onToggle: (p: PluginSummary, next: boolean) => void;
  onChanged: () => void;
}

export function PluginsTab({
  cwd,
  configurationTarget,
  query,
  isEnabled,
  onToggle,
  onChanged,
}: Props) {
  const { t } = useT();
  const [plugins, setPlugins] = useState<PluginSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // installKey → has-newer-commit-upstream. Filled in asynchronously after the
  // list renders; only remote plugins ever flip to true (core returns false for
  // local/no-commit sources), so the badge silently no-ops for everything else.
  const [updatable, setUpdatable] = useState<Record<string, boolean>>({});
  // List→detail (same pattern as MarketList→MarketDetail): selected installKey.
  const [selected, setSelected] = useState<string | null>(null);
  const [localBusy, setLocalBusy] = useState<"dir" | "zip" | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [localReview, setLocalReview] = useState<{
    path: string;
    preview: LocalPluginPreview;
  } | null>(null);
  const [mediaByInstallKey, setMediaByInstallKey] = useState<Record<string, PluginMediaDto | null>>(
    {},
  );
  const retry = () => setReloadKey((k) => k + 1);
  const confirm = useConfirm();
  const alert = useAlert();
  const toast = useToast();
  useEffect(() => {
    let alive = true;
    setPlugins(null);
    setError(null);
    setUpdatable({});
    setMediaByInstallKey({});
    window.codeshell
      .listPlugins(configurationTarget)
      .then((d) => {
        if (!alive) return;
        setPlugins(d);
        for (const p of d) {
          if (!shouldLoadPluginListMedia(p.mediaAvailability)) continue;
          void window.codeshell
            .getPluginMedia(p.installKey)
            .then((media) => {
              if (alive) {
                setMediaByInstallKey((current) => ({
                  ...current,
                  [p.installKey]: media,
                }));
              }
            })
            .catch(() => {
              if (alive) {
                setMediaByInstallKey((current) => ({
                  ...current,
                  [p.installKey]: null,
                }));
              }
            });
        }
        // Background, non-blocking: probe each plugin for an upstream update
        // (network per plugin; core no-ops fast for non-remote sources). Each
        // resolves independently so badges appear as they come back.
        for (const p of d) {
          window.codeshell
            .checkPluginUpdate(p.name)
            .then((r) => {
              if (alive && r.updateAvailable) {
                setUpdatable((m) => ({ ...m, [p.installKey]: true }));
              }
            })
            .catch(() => {
              /* check failure → just no badge */
            });
        }
      })
      .catch((e) => {
        if (alive) setError(String(e?.message ?? e));
      });
    return () => {
      alive = false;
    };
  }, [configurationTarget, reloadKey]);
  const uninstall = async (p: PluginSummary) => {
    const target = resolveUninstallTarget(p);
    if (!target.uninstallable) {
      void alert({
        title: t("ext.plugins.cannotUninstallTitle"),
        message: t("ext.plugins.cannotUninstallMsg"),
      });
      return;
    }
    const ok = await confirm({
      title: t("ext.plugins.uninstallTitle"),
      message: t("ext.plugins.uninstallConfirm", { name: p.name }),
      confirmLabel: t("ext.common.uninstall"),
      destructive: true,
    });
    if (!ok) return;
    setBusy(p.installKey);
    try {
      if (target.kind === "local") {
        await window.codeshell.uninstallLocalPlugin(target.pluginName);
      } else {
        await window.codeshell.uninstallPlugin(target.pluginName, target.marketplaceName);
      }
      setReloadKey((k) => k + 1);
      onChanged();
    } catch (e) {
      void alert({
        title: t("ext.plugins.uninstallFailedTitle"),
        message: String((e as Error)?.message ?? e),
      });
    } finally {
      setBusy(null);
    }
  };
  const update = async (p: PluginSummary) => {
    setBusy(p.installKey);
    try {
      const r = await window.codeshell.updatePlugin(p.installKey);
      setReloadKey((k) => k + 1);
      onChanged();
      // Hot-reload: skills/commands are disk-scanned live (next turn picks them
      // up); hooks/MCP re-reconcile off this event on every running session.
      if (r.updated) signalHotReload();
      toast(
        r.updated
          ? { message: t("ext.plugins.updatedToast", { name: p.name }), variant: "success" }
          : { message: t("ext.plugins.updateNoopToast", { name: p.name, reason: r.reason ?? "" }) },
      );
    } catch (e) {
      // Atomic in core — the old version is kept on failure.
      void alert({
        title: t("ext.plugins.updateFailedTitle"),
        message: String((e as Error)?.message ?? e),
      });
    } finally {
      setBusy(null);
    }
  };
  const updateAll = async () => {
    const targets = (plugins ?? []).filter((p) => updatable[p.installKey]);
    if (targets.length === 0) return;
    setBusy("__all__");
    try {
      const labelByInstallKey = new Map(targets.map((p) => [p.installKey, p.name]));
      const outcomes = await runBatchUpdate(
        targets.map((p) => p.installKey),
        (installKey) => labelByInstallKey.get(installKey) ?? installKey,
        (installKey) => window.codeshell.updatePlugin(installKey),
      );
      setReloadKey((k) => k + 1);
      onChanged();
      if (outcomes.some((o) => o.updated)) signalHotReload();
      const s = summarizeBatch(outcomes);
      toast({ message: s.message, variant: s.ok ? "success" : undefined });
    } finally {
      setBusy(null);
    }
  };
  const installLocal = async (kind: "dir" | "zip") => {
    setLocalError(null);
    const picked = await window.codeshell.pickPluginSource(kind);
    if (!picked) return;

    setLocalBusy(kind);
    try {
      const result = await window.codeshell.previewLocalPlugin({
        kind: picked.kind,
        path: picked.path,
      });
      if (!result.ok) {
        setLocalError(result.error || t("ext.plugins.localInstallFailed"));
        return;
      }
      setLocalReview({ path: picked.path, preview: result.preview });
    } catch (e) {
      setLocalError(String((e as Error)?.message ?? e));
    } finally {
      setLocalBusy(null);
    }
  };

  const installReviewedLocal = async () => {
    if (!localReview) return;
    const { path, preview } = localReview;
    let overwrite = false;
    if (preview.alreadyInstalled) {
      const ok = await confirm({
        title: t("ext.plugins.overwriteTitle"),
        message: t("ext.plugins.overwriteConfirm", { name: preview.name }),
        confirmLabel: t("ext.plugins.overwriteConfirmLabel"),
      });
      if (!ok) return;
      overwrite = true;
    }

    setLocalBusy(preview.source.kind);
    setLocalError(null);
    try {
      let res = await window.codeshell.installLocalPlugin({
        kind: preview.source.kind,
        path,
        reviewToken: preview.reviewToken,
        overwrite,
      });
      // A same-name install may race in after preview. Preserve the required
      // overwrite second confirmation before retrying.
      if (!res.ok && "alreadyInstalled" in res && res.alreadyInstalled && !overwrite) {
        const ok = await confirm({
          title: t("ext.plugins.overwriteTitle"),
          message: t("ext.plugins.overwriteConfirm", { name: res.name }),
          confirmLabel: t("ext.plugins.overwriteConfirmLabel"),
        });
        if (!ok) return;
        res = await window.codeshell.installLocalPlugin({
          kind: preview.source.kind,
          path,
          reviewToken: preview.reviewToken,
          overwrite: true,
        });
      }
      if (!res.ok) {
        setLocalReview(null);
        setLocalError(
          ("error" in res ? res.error : undefined) ?? t("ext.plugins.localInstallFailed"),
        );
        return;
      }
      setLocalReview(null);
      // Hot-reload hooks/MCP into running sessions. Skills and commands are
      // disk-scanned on demand; the list refresh below makes the UI immediate.
      signalHotReload();
      setReloadKey((k) => k + 1);
      onChanged();
      toast({
        message: t("ext.plugins.localInstalledToast", { name: res.name }),
        variant: "success",
      });
    } catch (e) {
      setLocalError(String((e as Error)?.message ?? e));
    } finally {
      setLocalBusy(null);
    }
  };

  if (selected !== null) {
    return <PluginDetailView installKey={selected} cwd={cwd} onBack={() => setSelected(null)} />;
  }
  if (error)
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        {t("ext.common.loadFailed", { error })}{" "}
        <Button size="sm" variant="outline" onClick={retry}>
          {t("ext.common.retry")}
        </Button>
      </div>
    );
  if (plugins === null)
    return <div className="p-4 text-sm text-muted-foreground">{t("ext.common.loading")}</div>;
  const q = query.trim().toLowerCase();
  const rows = q
    ? plugins.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.displayName.toLowerCase().includes(q) ||
          (p.developerName ?? "").toLowerCase().includes(q) ||
          (p.category ?? "").toLowerCase().includes(q) ||
          (p.description ?? "").toLowerCase().includes(q),
      )
    : plugins;
  const updatableCount = rows.filter((p) => updatable[p.installKey]).length;
  const localInstallBar = (
    <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-border/70 bg-muted/20 p-4">
      <div className="min-w-0 basis-44 flex-1">
        <div className="text-sm font-medium text-foreground">
          {t("ext.plugins.localInstallTitle")}
        </div>
        <div className="text-xs text-muted-foreground">{t("ext.plugins.localInstallDesc")}</div>
        {localError && <div className="mt-1 text-xs text-status-err">{localError}</div>}
      </div>
      <Button
        size="sm"
        variant="outline"
        className="gap-1.5"
        disabled={localBusy !== null}
        onClick={() => void installLocal("dir")}
      >
        {localBusy === "dir" ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <FolderPlus className="h-3.5 w-3.5" />
        )}
        {t("ext.plugins.localFromDir")}
      </Button>
      <Button
        size="sm"
        variant="outline"
        className="gap-1.5"
        disabled={localBusy !== null}
        onClick={() => void installLocal("zip")}
      >
        {localBusy === "zip" ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <FileArchive className="h-3.5 w-3.5" />
        )}
        {t("ext.plugins.localFromZip")}
      </Button>
    </div>
  );
  return (
    <div className="space-y-3">
      {localReview && (
        <PluginInstallReviewDialog
          preview={localReview.preview}
          busy={localBusy !== null}
          onCancel={() => setLocalReview(null)}
          onInstall={() => void installReviewedLocal()}
        />
      )}
      {localInstallBar}
      {updatableCount > 1 && (
        <div className="flex justify-end">
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            disabled={busy !== null}
            onClick={() => void updateAll()}
          >
            {busy === "__all__" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ArrowUpCircle className="h-3.5 w-3.5" />
            )}
            {t("ext.plugins.updateAll", { count: updatableCount })}
          </Button>
        </div>
      )}
      {rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border bg-muted/20 px-5 py-10 text-center">
          {q ? (
            <Search className="mx-auto mb-3 size-6 text-muted-foreground" aria-hidden />
          ) : (
            <Puzzle className="mx-auto mb-3 size-6 text-muted-foreground" aria-hidden />
          )}
          <p className="text-sm font-medium">
            {t(q ? "ext.plugins.noMatch" : "ext.plugins.empty")}
          </p>
          {q && <p className="mt-2 text-xs text-muted-foreground">{t("ext.common.searchHint")}</p>}
        </div>
      ) : (
        <ul className="space-y-2">
          {rows.map((p) => (
            <li
              key={p.installKey}
              className="flex flex-wrap items-center gap-3 rounded-xl border border-border/70 bg-card p-3 text-sm transition-colors hover:border-primary/25"
            >
              <span
                className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-background text-muted-foreground"
                style={
                  p.brandColor ? { borderColor: p.brandColor, color: p.brandColor } : undefined
                }
              >
                <PluginLogo
                  media={mediaByInstallKey[p.installKey]}
                  alt={p.displayName}
                  fallback={<Puzzle className="h-4 w-4" aria-hidden="true" />}
                />
              </span>
              <button
                type="button"
                className="group flex min-w-0 basis-40 flex-1 items-center gap-1 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => setSelected(p.installKey)}
                title={t("ext.plugins.viewContentTip")}
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium group-hover:underline">{p.displayName}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {p.displayName !== p.name ? `${p.name} · ` : ""}
                    {p.category ? `${p.category} · ` : ""}
                    {p.sourceLabel} · {t("ext.plugins.skillCount", { count: p.skillCount })}
                  </div>
                </div>
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-60 group-hover:opacity-100 group-focus-visible:opacity-100" />
              </button>
              <div className="ml-auto flex max-w-full shrink-0 items-center gap-2">
                {updatable[p.installKey] && (
                  <Button
                    size="icon"
                    variant="ghost"
                    title={t("ext.plugins.hasUpdateTip")}
                    aria-label={`${t("ext.plugins.hasUpdateTip")} · ${p.displayName}`}
                    className="text-status-running hover:text-status-running"
                    disabled={busy === p.installKey}
                    onClick={() => void update(p)}
                  >
                    {busy === p.installKey ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <ArrowUpCircle className="h-4 w-4" />
                    )}
                  </Button>
                )}
                <span
                  className="max-w-28 truncate text-xs text-muted-foreground"
                  title={p.marketplace ?? t("ext.plugins.local")}
                >
                  {p.marketplace ?? t("ext.plugins.local")}
                </span>
                <Switch
                  aria-label={t("ext.plugins.toggle", { name: p.displayName })}
                  checked={isEnabled(p)}
                  onCheckedChange={(v) => onToggle(p, v)}
                />
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      size="icon"
                      variant="ghost"
                      title={t("ext.plugins.moreActions")}
                      aria-label={`${t("ext.plugins.moreActions")} · ${p.displayName}`}
                      disabled={busy === p.installKey}
                    >
                      {busy === p.installKey ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <MoreHorizontal className="h-4 w-4" />
                      )}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => void update(p)}>
                      {t("ext.common.update")}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="text-status-err focus:text-status-err"
                      onSelect={() => void uninstall(p)}
                    >
                      {t("ext.common.uninstall")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PluginLogo({
  media,
  alt,
  fallback,
}: {
  media: PluginMediaDto | null | undefined;
  alt: string;
  fallback: React.ReactNode;
}) {
  const sources = pluginLogoSources(media);
  if (!sources.light) return fallback;
  const hasDistinctDark = sources.dark && sources.dark !== sources.light;
  return (
    <>
      <img
        src={sources.light}
        alt={alt}
        className={`h-full w-full object-contain p-1 ${hasDistinctDark ? "dark:hidden" : ""}`}
      />
      {hasDistinctDark && (
        <img
          src={sources.dark}
          alt={alt}
          className="hidden h-full w-full object-contain p-1 dark:block"
        />
      )}
    </>
  );
}
