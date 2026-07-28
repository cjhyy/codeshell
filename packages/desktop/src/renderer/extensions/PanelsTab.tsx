import { useEffect, useState } from "react";
import {
  Check,
  Code2,
  FileArchive,
  FolderPlus,
  Github,
  Loader2,
  PanelTop,
  RefreshCw,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import type {
  PanelAppExtensionSummary,
  PanelAppPreview,
  PanelAppSourceInput,
} from "../../preload/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useT } from "../i18n/I18nProvider";
import { writeSettings } from "../settingsBus";
import { useAlert, useConfirm } from "../ui/DialogProvider";
import { useToast } from "../ui/ToastProvider";
import { PanelAppInstallReviewDialog } from "./PanelAppInstallReviewDialog";

interface Props {
  cwd: string;
  activeProjectPath: string | null;
  query: string;
}

type PanelAppReviewState =
  | { mode: "install"; source: PanelAppSourceInput; preview: PanelAppPreview }
  | { mode: "update"; appId: string; preview: PanelAppPreview };

export function nextDisabledPanelApps(value: unknown, appId: string, enabled: boolean): string[] {
  const disabled = new Set(
    Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [],
  );
  if (enabled) disabled.delete(appId);
  else disabled.add(appId);
  return [...disabled];
}

export function panelAppProjectOverridePatch(
  appId: string,
  state: "inherit" | "on" | "off",
): Record<string, unknown> {
  return {
    panelAppOverrides: { [appId]: state === "inherit" ? null : state },
  };
}

/** Independent Desktop Panel Apps. Agent plugins are managed by PluginsTab. */
export function PanelsTab({ cwd, activeProjectPath, query }: Props) {
  const { t, lang } = useT();
  const [apps, setApps] = useState<PanelAppExtensionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [installBusy, setInstallBusy] = useState<"dir" | "zip" | "git" | null>(null);
  const [gitOpen, setGitOpen] = useState(false);
  const [gitUrl, setGitUrl] = useState("");
  const [gitRef, setGitRef] = useState("");
  const [gitSubdir, setGitSubdir] = useState("");
  const [review, setReview] = useState<PanelAppReviewState | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const confirm = useConfirm();
  const alert = useAlert();
  const toast = useToast();

  useEffect(() => {
    let alive = true;
    setApps(null);
    setError(null);
    window.codeshell
      .listPanelAppExtensions(cwd, lang)
      .then((next) => {
        if (alive) setApps(next);
      })
      .catch((cause) => {
        if (!alive) return;
        setApps([]);
        setError(String((cause as Error)?.message ?? cause));
      });
    return () => {
      alive = false;
    };
  }, [cwd, lang, reloadKey]);

  const toggleGlobal = async (app: PanelAppExtensionSummary, enabled: boolean) => {
    setBusy(app.id);
    setError(null);
    try {
      const settings = (await window.codeshell.getSettings("user")) ?? {};
      const raw = (settings as { disabledPanelApps?: unknown }).disabledPanelApps;
      await writeSettings("user", {
        disabledPanelApps: nextDisabledPanelApps(raw, app.appId, enabled),
      });
      setReloadKey((key) => key + 1);
    } catch (cause) {
      setError(String((cause as Error)?.message ?? cause));
    } finally {
      setBusy(null);
    }
  };

  const setProjectOverride = async (
    app: PanelAppExtensionSummary,
    state: "inherit" | "on" | "off",
  ) => {
    if (!activeProjectPath) return;
    setBusy(app.id);
    setError(null);
    try {
      await writeSettings(
        "project",
        panelAppProjectOverridePatch(app.appId, state),
        activeProjectPath,
      );
      setReloadKey((key) => key + 1);
    } catch (cause) {
      setError(String((cause as Error)?.message ?? cause));
    } finally {
      setBusy(null);
    }
  };

  const pickAndReview = async (kind: "dir" | "zip") => {
    setError(null);
    const picked = await window.codeshell.pickPanelAppSource(kind);
    if (!picked) return;
    setInstallBusy(kind);
    try {
      const source: PanelAppSourceInput = {
        kind: picked.kind,
        path: picked.path,
      };
      const result = await window.codeshell.previewLocalPanelApp(source);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setReview({ mode: "install", source, preview: result.preview });
    } catch (cause) {
      setError(String((cause as Error)?.message ?? cause));
    } finally {
      setInstallBusy(null);
    }
  };

  const reviewGit = async () => {
    if (!gitUrl.trim()) {
      setError(t("ext.panels.githubUrlRequired"));
      return;
    }
    const source: PanelAppSourceInput = {
      kind: "git",
      url: gitUrl.trim(),
      ...(gitRef.trim() ? { ref: gitRef.trim() } : {}),
      ...(gitSubdir.trim() ? { subdir: gitSubdir.trim() } : {}),
    };
    setInstallBusy("git");
    setError(null);
    try {
      const result = await window.codeshell.previewLocalPanelApp(source);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setReview({ mode: "install", source, preview: result.preview });
    } catch (cause) {
      setError(String((cause as Error)?.message ?? cause));
    } finally {
      setInstallBusy(null);
    }
  };

  const installReviewed = async () => {
    if (!review) return;
    const { preview } = review;
    if (review.mode === "update") {
      setBusy(review.appId);
      setError(null);
      try {
        const result = await window.codeshell.installPanelAppUpdate({
          id: review.appId,
          reviewToken: preview.reviewToken,
        });
        if (!result.ok) {
          setReview(null);
          setError(result.error);
          return;
        }
        setReview(null);
        setReloadKey((key) => key + 1);
        toast({
          message: t("ext.panels.updatedToast", { name: preview.title.default }),
          variant: "success",
        });
      } catch (cause) {
        setError(String((cause as Error)?.message ?? cause));
      } finally {
        setBusy(null);
      }
      return;
    }

    const { source } = review;
    let overwrite = false;
    if (preview.alreadyInstalled) {
      overwrite = await confirm({
        title: t("ext.panels.overwriteTitle"),
        message: t("ext.panels.overwriteConfirm", { name: preview.title.default }),
        confirmLabel: t("ext.panels.overwriteConfirmLabel"),
      });
      if (!overwrite) return;
    }
    setInstallBusy(preview.source.kind);
    setError(null);
    try {
      let result = await window.codeshell.installLocalPanelApp({
        source,
        reviewToken: preview.reviewToken,
        overwrite,
      });
      if (!result.ok && result.alreadyInstalled && !overwrite) {
        const approved = await confirm({
          title: t("ext.panels.overwriteTitle"),
          message: t("ext.panels.overwriteConfirm", { name: preview.title.default }),
          confirmLabel: t("ext.panels.overwriteConfirmLabel"),
        });
        if (!approved) return;
        result = await window.codeshell.installLocalPanelApp({
          source,
          reviewToken: preview.reviewToken,
          overwrite: true,
        });
      }
      if (!result.ok) {
        setReview(null);
        setError(result.error);
        return;
      }
      setReview(null);
      if (source.kind === "git") setGitOpen(false);
      setReloadKey((key) => key + 1);
      toast({
        message: t("ext.panels.installedToast", { name: preview.title.default }),
        variant: "success",
      });
    } catch (cause) {
      setError(String((cause as Error)?.message ?? cause));
    } finally {
      setInstallBusy(null);
    }
  };

  const reviewUpdate = async (app: PanelAppExtensionSummary) => {
    setBusy(app.id);
    setError(null);
    try {
      const result = await window.codeshell.previewPanelAppUpdate(app.appId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setReview({ mode: "update", appId: app.appId, preview: result.preview });
    } catch (cause) {
      setError(String((cause as Error)?.message ?? cause));
    } finally {
      setBusy(null);
    }
  };

  const uninstall = async (app: PanelAppExtensionSummary) => {
    const approved = await confirm({
      title: t("ext.panels.uninstallTitle"),
      message: t("ext.panels.uninstallConfirm", { name: app.title }),
      confirmLabel: t("ext.common.uninstall"),
      destructive: true,
    });
    if (!approved) return;
    setBusy(app.id);
    try {
      await window.codeshell.uninstallPanelApp(app.appId, activeProjectPath ?? undefined);
      setReloadKey((key) => key + 1);
    } catch (cause) {
      void alert({
        title: t("ext.panels.uninstallFailedTitle"),
        message: String((cause as Error)?.message ?? cause),
      });
    } finally {
      setBusy(null);
    }
  };

  const needle = query.trim().toLowerCase();
  const rows = (apps ?? []).filter(
    (app) =>
      !needle ||
      [
        app.title,
        app.appId,
        app.version,
        app.description ?? "",
        app.updateSource.label,
        ...app.permissions,
      ].some((value) => value.toLowerCase().includes(needle)),
  );

  return (
    <div className="space-y-3">
      {review && (
        <PanelAppInstallReviewDialog
          preview={review.preview}
          action={review.mode}
          busy={installBusy !== null || (review.mode === "update" && busy === review.appId)}
          onCancel={() => setReview(null)}
          onInstall={() => void installReviewed()}
        />
      )}

      <div className="rounded-xl border bg-card p-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Code2 className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="min-w-[220px] flex-1">
            <div className="text-sm font-semibold text-foreground">
              {t("ext.panels.installTitle")}
            </div>
            <div className="text-xs text-muted-foreground">{t("ext.panels.installDesc")}</div>
          </div>
          <Button
            size="sm"
            className="gap-1.5"
            disabled={installBusy !== null}
            onClick={() => void pickAndReview("dir")}
          >
            {installBusy === "dir" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <FolderPlus className="h-3.5 w-3.5" />
            )}
            {t("ext.panels.fromDir")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            disabled={installBusy !== null}
            onClick={() => void pickAndReview("zip")}
          >
            {installBusy === "zip" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <FileArchive className="h-3.5 w-3.5" />
            )}
            {t("ext.panels.fromZip")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            disabled={installBusy !== null}
            onClick={() => setGitOpen((open) => !open)}
          >
            <Github className="h-3.5 w-3.5" aria-hidden="true" />
            {t("ext.panels.fromGithub")}
          </Button>
        </div>
        {gitOpen && (
          <div className="mt-3 grid gap-2 rounded-lg border bg-muted/15 p-3 sm:grid-cols-[2fr_1fr_2fr_auto]">
            <label className="space-y-1">
              <span className="text-xs font-medium text-foreground">
                {t("ext.panels.githubUrl")}
              </span>
              <Input
                value={gitUrl}
                placeholder="https://github.com/owner/repository"
                onChange={(event) => setGitUrl(event.target.value)}
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-foreground">
                {t("ext.panels.githubRef")}
              </span>
              <Input
                value={gitRef}
                placeholder="main"
                onChange={(event) => setGitRef(event.target.value)}
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-foreground">
                {t("ext.panels.githubSubdir")}
              </span>
              <Input
                value={gitSubdir}
                placeholder="examples/panel-apps/design-studio"
                onChange={(event) => setGitSubdir(event.target.value)}
              />
            </label>
            <div className="flex items-end">
              <Button
                type="button"
                size="sm"
                className="w-full gap-1.5 sm:w-auto"
                disabled={installBusy !== null}
                onClick={() => void reviewGit()}
              >
                {installBusy === "git" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Github className="h-3.5 w-3.5" />
                )}
                {t("ext.panels.reviewGithub")}
              </Button>
            </div>
            <div className="text-xs text-muted-foreground sm:col-span-4">
              {t("ext.panels.githubHint")}
            </div>
          </div>
        )}
        <div className="mt-3 grid gap-2 border-t pt-3 text-xs text-muted-foreground sm:grid-cols-3">
          {[
            t("ext.panels.addStepManifest"),
            t("ext.panels.addStepApp"),
            t("ext.panels.addStepPick"),
          ].map((step, index) => (
            <div key={step} className="flex items-start gap-2">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted font-medium text-foreground">
                {index + 1}
              </span>
              <span>{step}</span>
            </div>
          ))}
        </div>
        <div className="mt-2 text-xs text-muted-foreground">{t("ext.panels.developerHint")}</div>
        {error && (
          <div className="mt-3 rounded-md border border-status-err/30 bg-status-err/5 px-3 py-2 text-xs text-status-err">
            {error}
          </div>
        )}
      </div>

      {apps === null ? (
        <div className="p-4 text-sm text-muted-foreground">{t("ext.common.loading")}</div>
      ) : apps.length === 0 ? (
        <div className="rounded-xl border border-dashed p-8 text-center">
          <PanelTop className="mx-auto h-8 w-8 text-muted-foreground" aria-hidden="true" />
          <div className="mt-3 text-sm font-medium text-foreground">{t("ext.panels.empty")}</div>
          <div className="mt-1 text-xs text-muted-foreground">{t("ext.panels.emptyDesc")}</div>
        </div>
      ) : rows.length === 0 ? (
        <div className="p-4 text-sm text-muted-foreground">{t("ext.panels.noMatch")}</div>
      ) : (
        <ul className="space-y-2">
          {rows.map((app) => (
            <li key={app.id} className="flex items-start gap-3 rounded-lg border bg-card p-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground">
                <PanelTop className="h-4 w-4" aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-sm font-medium text-foreground">{app.title}</span>
                  <Badge variant={app.enabled ? "success" : "secondary"}>
                    {app.enabled ? t("ext.panels.enabled") : t("ext.panels.disabled")}
                  </Badge>
                  <Badge variant="outline">v{app.version}</Badge>
                </div>
                <div className="mt-0.5 truncate text-xs text-muted-foreground">{app.appId}</div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  <span>
                    {t("ext.panels.updateSource")}:{" "}
                    {app.updateSource.label || t("ext.panels.unknownSource")}
                  </span>
                  {!app.updateSource.available && (
                    <Badge variant="outline">{t("ext.panels.sourceUnavailable")}</Badge>
                  )}
                </div>
                {app.description && (
                  <div className="mt-1 text-xs text-muted-foreground">{app.description}</div>
                )}
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {app.permissions.length === 0 ? (
                    <Badge variant="outline">{t("ext.panels.noPermissions")}</Badge>
                  ) : (
                    app.permissions.map((permission) => (
                      <Badge key={permission} variant="outline">
                        {permission}
                      </Badge>
                    ))
                  )}
                  {app.singleton && <Badge variant="outline">{t("ext.panels.singleton")}</Badge>}
                  {app.projectOverride && (
                    <Badge variant="outline">
                      {app.projectOverride === "on"
                        ? t("ext.panels.projectOn")
                        : t("ext.panels.projectOff")}
                    </Badge>
                  )}
                </div>
                {app.disabledByPolicy && (
                  <div className="mt-2 text-xs text-muted-foreground">
                    {t("ext.panels.disabledByPolicy")}
                  </div>
                )}
                <div className="mt-3 flex flex-wrap items-center gap-3 border-t pt-3">
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Switch
                      checked={app.globalEnabled}
                      disabled={busy === app.id}
                      aria-label={t("ext.panels.globalToggleAria", { title: app.title })}
                      onCheckedChange={(enabled) => void toggleGlobal(app, enabled)}
                    />
                    {t("ext.panels.globalToggle")}
                  </label>
                  {activeProjectPath && (
                    <div
                      className="flex flex-wrap items-center gap-1"
                      aria-label={t("ext.panels.projectPolicyAria", { title: app.title })}
                    >
                      <span className="mr-1 text-xs text-muted-foreground">
                        {t("ext.panels.projectPolicy")}
                      </span>
                      {(
                        [
                          ["inherit", RotateCcw, "ext.panels.inherit"],
                          ["on", Check, "ext.panels.on"],
                          ["off", X, "ext.panels.off"],
                        ] as const
                      ).map(([state, Icon, label]) => (
                        <Button
                          key={state}
                          type="button"
                          variant="outline"
                          size="sm"
                          className={`h-7 gap-1 px-2 text-xs ${
                            (app.projectOverride ?? "inherit") === state ? "bg-accent" : ""
                          }`}
                          disabled={busy === app.id}
                          onClick={() => void setProjectOverride(app, state)}
                        >
                          <Icon className="h-3 w-3" aria-hidden="true" />
                          {t(label)}
                        </Button>
                      ))}
                    </div>
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1 px-2 text-xs"
                    disabled={busy === app.id || !app.updateSource.available}
                    title={
                      app.updateSource.available
                        ? t("ext.panels.updateFromSource")
                        : t("ext.panels.sourceUnavailableHint")
                    }
                    onClick={() => void reviewUpdate(app)}
                  >
                    {busy === app.id ? (
                      <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                    ) : (
                      <RefreshCw className="h-3 w-3" aria-hidden="true" />
                    )}
                    {t("ext.panels.updateFromSource")}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="ml-auto h-7 gap-1 px-2 text-xs text-destructive"
                    disabled={busy === app.id}
                    onClick={() => void uninstall(app)}
                  >
                    <Trash2 className="h-3 w-3" aria-hidden="true" />
                    {t("ext.common.uninstall")}
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
