import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Code2,
  FileArchive,
  FolderPlus,
  Github,
  Loader2,
  PanelTop,
  RefreshCw,
  Trash2,
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
import { loadProjects, projectLabel, type TrackedProject } from "../projects";
import { writeSettings } from "../settingsBus";
import { useAlert, useConfirm } from "../ui/DialogProvider";
import { useToast } from "../ui/ToastProvider";
import { PanelAppInstallReviewDialog } from "./PanelAppInstallReviewDialog";
import {
  bindingBusyKey,
  computeProjectBindings,
  type ProjectSettingsMap,
} from "./panelAppBindings";

interface Props {
  cwd: string;
  activeProjectPath: string | null;
  query: string;
}

type PanelAppReviewState =
  | { mode: "install"; source: PanelAppSourceInput; preview: PanelAppPreview }
  | { mode: "update"; appId: string; preview: PanelAppPreview };

export function nextPanelAppBindings(value: unknown, appId: string, bound: boolean): string[] {
  const bindings = new Set(
    Array.isArray(value)
      ? value.filter((candidate): candidate is string => typeof candidate === "string")
      : [],
  );
  if (bound) bindings.add(appId);
  else bindings.delete(appId);
  return [...bindings].sort();
}

/** Desktop Panel Apps with optional sandboxed Agent tools and bundled Skills. */
export function PanelsTab({ cwd, activeProjectPath, query }: Props) {
  const { t, lang } = useT();
  const [apps, setApps] = useState<PanelAppExtensionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState<string | null>(null);
  const [installBusy, setInstallBusy] = useState<"dir" | "zip" | "git" | null>(null);
  const [gitOpen, setGitOpen] = useState(false);
  const [gitUrl, setGitUrl] = useState("");
  const [gitRef, setGitRef] = useState("");
  const [gitSubdir, setGitSubdir] = useState("");
  const [review, setReview] = useState<PanelAppReviewState | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [projects, setProjects] = useState<TrackedProject[]>(() => loadProjects());
  const [projectSettings, setProjectSettings] = useState<ProjectSettingsMap>({});
  const [globalDisabled, setGlobalDisabled] = useState<ReadonlySet<string>>(() => new Set());
  const [bindingBusy, setBindingBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const confirm = useConfirm();
  const alert = useAlert();
  const toast = useToast();

  // Blank the list only when the target actually changes, so another project's
  // apps can never show under this one's heading. A post-toggle refresh keeps
  // the current rows on screen — dropping to the loading shell on every switch
  // flip made the whole tab flash.
  useEffect(() => {
    setApps(null);
  }, [cwd, lang]);

  useEffect(() => {
    let alive = true;
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

  /**
   * Read every tracked project's bindings so one app card can show its state
   * across all projects without switching the active project. This reads raw
   * settings (1 + N small getSettings calls) instead of calling
   * listPanelAppExtensions per project — that call re-hashes every installed
   * app's files, so N projects would mean N full catalog scans in main.
   */
  useEffect(() => {
    let alive = true;
    const tracked = loadProjects();
    setProjects(tracked);
    void (async () => {
      const [user, ...scoped] = await Promise.all([
        window.codeshell
          .getSettings("user")
          .then((value) => value ?? {})
          .catch(() => null),
        ...tracked.map((project) =>
          window.codeshell
            .getSettings("project", project.path)
            .then((value) => (value ?? {}) as Record<string, unknown>)
            // A per-project read must not fail the whole list: null marks the
            // row unreadable so a permissions error is distinguishable from
            // an explicit opt-out.
            .catch(() => null),
        ),
      ]);
      if (!alive) return;
      const next: ProjectSettingsMap = {};
      tracked.forEach((project, index) => {
        next[project.path] = scoped[index] ?? null;
      });
      setProjectSettings(next);
      const raw = (user as { disabledPanelApps?: unknown } | null)?.disabledPanelApps;
      setGlobalDisabled(
        new Set(Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : []),
      );
    })();
    return () => {
      alive = false;
    };
  }, [reloadKey]);

  const setProjectBinding = useCallback(
    async (appId: string, projectPath: string, bound: boolean) => {
      setBindingBusy(bindingBusyKey(appId, projectPath));
      setError(null);
      let previous: ProjectSettingsMap | null = null;
      try {
        const settings = (await window.codeshell.getSettings("project", projectPath)) ?? {};
        const nextBindings = nextPanelAppBindings(settings.panelAppBindings, appId, bound);
        // Apply locally first: the row is the only thing that changed, and a
        // full reload here is what made the tab flash on every click.
        setProjectSettings((current) => {
          previous = current;
          return {
            ...current,
            [projectPath]: { ...settings, panelAppBindings: nextBindings, panelAppOverrides: {} },
          };
        });
        await writeSettings(
          "project",
          {
            panelAppBindings: nextBindings,
            // Remove the old tri-state entry so the canonical binding is the
            // only source of truth after the first user action.
            panelAppOverrides: { [appId]: null },
          },
          projectPath,
        );
      } catch (cause) {
        if (previous) setProjectSettings(previous);
        setError(String((cause as Error)?.message ?? cause));
      } finally {
        setBindingBusy(null);
      }
    },
    [],
  );

  const pickAndReview = async (kind: "dir" | "zip") => {
    setError(null);
    if (!activeProjectPath) {
      setError(t("ext.panels.projectRequired"));
      return;
    }
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
    if (!activeProjectPath) {
      setError(t("ext.panels.projectRequired"));
      return;
    }
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

    if (!activeProjectPath) {
      setError(t("ext.panels.projectRequired"));
      return;
    }
    const bindingProjectPath = activeProjectPath;
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
      await setProjectBinding(preview.id, bindingProjectPath, true);
      // Reveal the project list once so the user sees which project it bound to.
      setExpanded((current) => new Set(current).add(preview.id));
      setReview(null);
      if (source.kind === "git") setGitOpen(false);
      setReloadKey((key) => key + 1);
      toast({
        message: t("ext.panels.installedAndBoundToast", {
          name: preview.title.default,
          project: bindingProjectPath.split(/[\\/]/).filter(Boolean).at(-1) ?? bindingProjectPath,
        }),
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
    setCheckingUpdate(app.id);
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
      setCheckingUpdate(null);
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
        ...(app.agent?.tools.map((tool) => tool.name) ?? []),
      ].some((value) => value.toLowerCase().includes(needle)),
  );

  const bindingsByApp = useMemo(() => {
    const map = new Map<string, ReturnType<typeof computeProjectBindings>>();
    for (const app of apps ?? []) {
      map.set(
        app.appId,
        computeProjectBindings(projects, projectSettings, app.appId, globalDisabled),
      );
    }
    return map;
  }, [apps, projects, projectSettings, globalDisabled]);

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
        {/* Each app card owns its own per-project list, so the only thing left
            to say up here is that installing needs a project to bind into. */}
        {!activeProjectPath && (
          <div className="mb-3 flex items-start gap-3 rounded-lg border border-status-warn/30 bg-status-warn/5 px-3 py-2.5">
            <AlertTriangle
              className="mt-0.5 h-4 w-4 shrink-0 text-status-warn"
              aria-hidden="true"
            />
            <div className="min-w-0">
              <div className="text-xs font-medium text-foreground">
                {t("ext.panels.noBindingProject")}
              </div>
              <div className="mt-0.5 text-xs leading-5 text-muted-foreground">
                {t("ext.panels.noBindingProjectDesc")}
              </div>
            </div>
          </div>
        )}
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
            disabled={installBusy !== null || !activeProjectPath}
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
            disabled={installBusy !== null || !activeProjectPath}
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
            disabled={installBusy !== null || !activeProjectPath}
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
                placeholder="apps/design-studio"
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
                  <Badge
                    variant={
                      (bindingsByApp.get(app.appId)?.boundCount ?? 0) > 0 ? "success" : "secondary"
                    }
                  >
                    {(bindingsByApp.get(app.appId)?.boundCount ?? 0) > 0
                      ? t("ext.panels.boundAndEnabled")
                      : t("ext.panels.notBound")}
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
                  {(app.agent?.tools.length ?? 0) > 0 && (
                    <Badge variant="info">
                      {t("ext.panels.agentToolsCount", { count: app.agent!.tools.length })}
                    </Badge>
                  )}
                  {(app.agent?.skills.length ?? 0) > 0 && (
                    <Badge variant="info">
                      {t("ext.panels.agentSkillsCount", { count: app.agent!.skills.length })}
                    </Badge>
                  )}
                </div>
                {(() => {
                  const summary = bindingsByApp.get(app.appId);
                  if (!summary) return null;
                  const open = expanded.has(app.appId);
                  return (
                    <div className="mt-3 border-t pt-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-medium text-foreground">
                          {summary.total === 0
                            ? t("ext.panels.bindingNoProjects")
                            : summary.boundCount === 0
                              ? t("ext.panels.bindingCountNone")
                              : t("ext.panels.bindingCount", {
                                  bound: summary.boundCount,
                                  total: summary.total,
                                })}
                        </span>
                        {summary.total > 0 && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-6 gap-1 px-1.5 text-xs text-muted-foreground"
                            aria-expanded={open}
                            onClick={() =>
                              setExpanded((current) => {
                                const next = new Set(current);
                                if (next.has(app.appId)) next.delete(app.appId);
                                else next.add(app.appId);
                                return next;
                              })
                            }
                          >
                            {open ? (
                              <ChevronDown className="h-3 w-3" aria-hidden="true" />
                            ) : (
                              <ChevronRight className="h-3 w-3" aria-hidden="true" />
                            )}
                            {open ? t("ext.panels.bindingCollapse") : t("ext.panels.bindingExpand")}
                          </Button>
                        )}
                      </div>
                      {open && summary.total > 0 && (
                        <ul
                          className="mt-2 divide-y rounded-lg border"
                          aria-label={t("ext.panels.bindingListAria", { title: app.title })}
                        >
                          {summary.rows.map((row) => {
                            const project = projects.find((item) => item.path === row.projectPath);
                            const rowBusy =
                              bindingBusy === bindingBusyKey(app.appId, row.projectPath);
                            return (
                              <li
                                key={row.projectPath}
                                className="flex items-center gap-2 px-2.5 py-2"
                              >
                                <div className="min-w-0 flex-1">
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <span className="truncate text-xs font-medium text-foreground">
                                      {project ? projectLabel(project) : row.projectPath}
                                    </span>
                                    {row.projectPath === activeProjectPath && (
                                      <Badge variant="outline">
                                        {t("ext.panels.bindingCurrentProject")}
                                      </Badge>
                                    )}
                                    {row.vetoedByGlobalDenylist && (
                                      <Badge
                                        variant="secondary"
                                        title={t("ext.panels.bindingVetoedHint")}
                                      >
                                        {t("ext.panels.bindingVetoed")}
                                      </Badge>
                                    )}
                                    {row.unreadable && (
                                      <Badge variant="outline">
                                        {t("ext.panels.bindingUnreadable")}
                                      </Badge>
                                    )}
                                  </div>
                                  <div className="truncate text-[11px] text-muted-foreground">
                                    {row.projectPath}
                                  </div>
                                </div>
                                {rowBusy ? (
                                  <Loader2
                                    className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground"
                                    aria-hidden="true"
                                  />
                                ) : null}
                                <Switch
                                  checked={row.bound || row.vetoedByGlobalDenylist}
                                  disabled={rowBusy}
                                  aria-label={t("ext.panels.bindingRowAria", {
                                    title: app.title,
                                    project: project ? projectLabel(project) : row.projectPath,
                                  })}
                                  onCheckedChange={(bound) =>
                                    void setProjectBinding(app.appId, row.projectPath, bound)
                                  }
                                />
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  );
                })()}
                <div className="mt-3 flex flex-wrap items-center gap-3 border-t pt-3">
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
                    {checkingUpdate === app.id
                      ? t("ext.panels.checkingUpdate")
                      : t("ext.panels.updateFromSource")}
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
