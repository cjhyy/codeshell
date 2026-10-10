import React from "react";
import type {
  EffectiveSourceAccess,
  SourceDefinition,
  SourceResourceMeta,
  SourceScope,
  WorkspaceSourceBinding,
} from "@cjhyy/code-shell-core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { SimpleSelect } from "@/components/ui/simple-select";
import { useT, type TFunction } from "../i18n";
import { useToast } from "../ui/ToastProvider";
import { useConfirm } from "../ui/DialogProvider";

interface WorkspaceSourceSnapshot {
  bindings: WorkspaceSourceBinding[];
  access: EffectiveSourceAccess[];
  uploads: SourceResourceMeta[];
}

function errorText(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${Number(kib.toFixed(1))} KB`;
  return `${Number((kib / 1024).toFixed(1))} MB`;
}

function statusLabel(t: TFunction, status: EffectiveSourceAccess["status"]): string {
  if (status === "ok") return t("projectConfig.dataSources.statusOk");
  if (status === "dangling") return t("projectConfig.dataSources.statusDangling");
  return t("projectConfig.dataSources.statusUnavailable");
}

function kindLabel(t: TFunction, kind: string): string {
  if (kind === "collection") return t("sourceCollections.kind");
  if (kind === "mock") return t("projectConfig.dataSources.kindMock");
  if (kind === "mcp-resource") return t("projectConfig.dataSources.kindMcpResource");
  if (kind === "link") return t("ext.link.sourcesKindLink");
  if (kind === "local-files") return t("projectConfig.dataSources.kindLocalFiles");
  return kind;
}

/** Project-local upload and source-binding controls. Content reads stay in ReadSource. */
export function DataSourcesSection({
  projectId,
  confirmDeleteUpload,
}: {
  projectId: string;
  /** Test seam; production uses the app-level themed confirmation dialog. */
  confirmDeleteUpload?: (upload: SourceResourceMeta) => Promise<boolean>;
}) {
  // A changed project owns a fresh form; old confirmations and responses cannot write for it.
  return (
    <ProjectDataSources
      key={projectId}
      projectId={projectId}
      confirmDeleteUpload={confirmDeleteUpload}
    />
  );
}

function ProjectDataSources({
  projectId,
  confirmDeleteUpload,
}: {
  projectId: string;
  confirmDeleteUpload?: (upload: SourceResourceMeta) => Promise<boolean>;
}) {
  const { t } = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const [catalog, setCatalog] = React.useState<SourceDefinition[]>([]);
  const [snapshot, setSnapshot] = React.useState<WorkspaceSourceSnapshot>({
    bindings: [],
    access: [],
    uploads: [],
  });
  const [selectedSourceId, setSelectedSourceId] = React.useState("");
  const [scopes, setScopes] = React.useState<SourceScope[]>([]);
  const [selectedScopes, setSelectedScopes] = React.useState<Set<string>>(() => new Set());
  const [readPolicy, setReadPolicy] = React.useState<"ask" | "deny">("ask");
  const [loading, setLoading] = React.useState(true);
  const [loadingScopes, setLoadingScopes] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [editingBinding, setEditingBinding] = React.useState(false);
  const [selectionMode, setSelectionMode] = React.useState<"all" | "selected">("selected");
  const [missingSelection, setMissingSelection] = React.useState(0);
  const scopeRequest = React.useRef(0);
  const loadRequest = React.useRef(0);
  const active = React.useRef(true);
  const busyLock = React.useRef(false);
  React.useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      scopeRequest.current += 1;
      loadRequest.current += 1;
    };
  }, []);

  const refresh = React.useCallback(async () => {
    const request = ++loadRequest.current;
    try {
      const [nextCatalog, nextSnapshot] = await Promise.all([
        window.codeshell.listSourceCatalog(),
        window.codeshell.projectSourceAccess(projectId),
      ]);
      if (!active.current || request !== loadRequest.current) return false;
      setCatalog(nextCatalog);
      setSnapshot({
        bindings: nextSnapshot.bindings ?? [],
        access: nextSnapshot.access,
        uploads: nextSnapshot.uploads,
      });
      setError(null);
      return true;
    } catch (caught) {
      if (active.current && request === loadRequest.current) setError(errorText(caught));
      return false;
    } finally {
      if (active.current && request === loadRequest.current) setLoading(false);
    }
  }, [projectId]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const act = async (
    operation: () => Promise<unknown>,
    opts?: { clearSelection?: boolean; successMessage?: string },
  ) => {
    if (busyLock.current || !active.current) return;
    busyLock.current = true;
    setBusy(true);
    setError(null);
    try {
      await operation();
      if (!active.current || !(await refresh())) return;
      if (opts?.clearSelection) {
        scopeRequest.current += 1;
        setSelectedSourceId("");
        setScopes([]);
        setSelectedScopes(new Set());
        setReadPolicy("ask");
        setEditingBinding(false);
        setMissingSelection(0);
        setSelectionMode("selected");
      }
      if (opts?.successMessage) toast({ message: opts.successMessage });
    } catch (caught) {
      if (active.current) setError(errorText(caught));
    } finally {
      busyLock.current = false;
      if (active.current) setBusy(false);
    }
  };

  const selectSource = async (sourceId: string, binding?: WorkspaceSourceBinding) => {
    if (busyLock.current || !active.current) return;
    const request = ++scopeRequest.current;
    setSelectedSourceId(sourceId);
    setScopes([]);
    setSelectedScopes(new Set());
    setSelectionMode("selected");
    setMissingSelection(0);
    setEditingBinding(Boolean(binding));
    setReadPolicy(binding?.readPolicy ?? "ask");
    setError(null);
    if (!sourceId) {
      setLoadingScopes(false);
      return;
    }
    setLoadingScopes(true);
    try {
      const next = await window.codeshell.listSourceScopes(sourceId);
      if (active.current && scopeRequest.current === request) {
        setScopes(next);
        if (binding) {
          const ids = new Set(next.map((item) => item.id));
          setSelectedScopes(new Set(binding.scopes.filter((id) => ids.has(id))));
          setMissingSelection(binding.scopes.filter((id) => !ids.has(id)).length);
        }
      }
    } catch (caught) {
      if (active.current && scopeRequest.current === request) setError(errorText(caught));
    } finally {
      if (active.current && scopeRequest.current === request) setLoadingScopes(false);
    }
  };

  const toggleScope = (scopeId: string, checked: boolean) => {
    if (busyLock.current || loadingScopes) return;
    setSelectionMode("selected");
    setSelectedScopes((current) => {
      const next = new Set(current);
      if (checked) next.add(scopeId);
      else next.delete(scopeId);
      return next;
    });
  };

  const boundIds = new Set(snapshot.bindings.map((item) => item.sourceId));
  const available = catalog.filter(
    (source) => (source.enabled && !boundIds.has(source.id)) || source.id === selectedSourceId,
  );
  const selectedSource = catalog.find((source) => source.id === selectedSourceId);
  const isCollection = selectedSource?.kind === "collection";
  const visibleAccess = snapshot.bindings
    .filter((binding) => binding.sourceId !== "project-uploads")
    .map((binding) => {
      const definition = catalog.find((item) => item.id === binding.sourceId);
      const projected = snapshot.access.find((item) => item.sourceId === binding.sourceId);
      return {
        ...binding,
        label: definition?.label ?? projected?.label ?? binding.sourceId,
        kind: definition?.kind ?? projected?.kind ?? "unknown",
        status: (!definition
          ? "dangling"
          : !definition.enabled
            ? "unavailable"
            : (projected?.status ?? "unavailable")) as EffectiveSourceAccess["status"],
        profileUnavailable: Boolean(definition?.enabled && !projected),
        profileRestricted: Boolean(
          projected &&
          (projected.scopes.length < binding.scopes.length ||
            projected.readPolicy !== binding.readPolicy),
        ),
        effectiveScopes: projected?.scopes.length ?? 0,
      };
    });

  if (loading) {
    return (
      <section className="space-y-4 rounded-md border border-border bg-card p-4">
        <div>
          <h2 className="text-base font-semibold text-foreground">
            {t("projectConfig.dataSources.title")}
          </h2>
          <p className="text-xs text-muted-foreground">{t("projectConfig.dataSources.subtitle")}</p>
        </div>
        <p className="text-xs text-muted-foreground">{t("projectConfig.dataSources.loading")}</p>
      </section>
    );
  }

  return (
    <section className="space-y-4 rounded-md border border-border bg-card p-4">
      <div>
        <h2 className="text-base font-semibold text-foreground">
          {t("projectConfig.dataSources.title")}
        </h2>
        <p className="text-xs text-muted-foreground">{t("sourceCollections.projectHint")}</p>
      </div>

      {error ? (
        <p role="alert" className="text-xs text-status-err">
          {error}
        </p>
      ) : null}

      <div className="space-y-3 rounded-md border border-border p-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-medium text-foreground">
              {t("sourceCollections.projectFiles")}
            </h3>
            <p className="text-xs text-muted-foreground">
              {t("sourceCollections.projectFilesHint")}
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={() =>
              void act(() => window.codeshell.pickAndUploadProjectSources(projectId), {
                successMessage: t("projectConfig.dataSources.uploadDone"),
              })
            }
          >
            {t("projectConfig.dataSources.upload")}
          </Button>
        </div>
        {snapshot.uploads.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {t("projectConfig.dataSources.noUploads")}
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {snapshot.uploads.map((upload) => (
              <li
                key={upload.id}
                data-source-upload
                className="flex items-center justify-between gap-3 px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm text-foreground">{upload.name}</p>
                  <p className="text-xs text-muted-foreground">{formatBytes(upload.sizeBytes)}</p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    const approval = confirmDeleteUpload
                      ? confirmDeleteUpload(upload)
                      : confirm({
                          title: t("projectConfig.dataSources.deleteUpload"),
                          message: t("projectConfig.dataSources.deleteUploadConfirm", {
                            name: upload.name,
                          }),
                          confirmLabel: t("projectConfig.dataSources.deleteUpload"),
                          destructive: true,
                        });
                    void approval.then((accepted) => {
                      if (!accepted || !active.current) return;
                      void act(() => window.codeshell.deleteProjectUpload(projectId, upload.name), {
                        successMessage: t("projectConfig.dataSources.deleteUploadDone"),
                      });
                    });
                  }}
                >
                  {t("projectConfig.dataSources.deleteUpload")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-3 rounded-md border border-border p-3">
        <div>
          <h3 className="text-sm font-medium text-foreground">
            {t("projectConfig.dataSources.boundTitle")}
          </h3>
          <p className="text-xs text-muted-foreground">
            {t("projectConfig.dataSources.boundSubtitle")}
          </p>
        </div>
        {visibleAccess.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("projectConfig.dataSources.noBound")}</p>
        ) : (
          <ul className="space-y-2">
            {visibleAccess.map((item) => (
              <li
                key={item.sourceId}
                data-source-access
                className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-foreground">{item.label}</span>
                    <Badge variant="secondary">{kindLabel(t, item.kind)}</Badge>
                    <Badge variant={item.status === "ok" ? "default" : "destructive"}>
                      {statusLabel(t, item.status)}
                    </Badge>
                    <Badge variant="secondary">
                      {item.readPolicy === "ask"
                        ? t("projectConfig.dataSources.readPolicyAsk")
                        : t("projectConfig.dataSources.readPolicyDeny")}
                    </Badge>
                  </div>
                  {item.profileUnavailable && (
                    <p className="text-xs text-muted-foreground">
                      {t("sourceCollections.profileUnavailable")}
                    </p>
                  )}
                  {item.profileRestricted && (
                    <p className="text-xs text-muted-foreground">
                      {t("sourceCollections.profileRestricted", { count: item.effectiveScopes })}
                    </p>
                  )}
                  <p className="truncate text-xs text-muted-foreground">
                    {t("projectConfig.dataSources.scopes", {
                      scopes:
                        item.kind === "collection"
                          ? t("sourceCollections.filesSelected", { count: item.scopes.length })
                          : item.scopes.join(", ") || "—",
                    })}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  {snapshot.bindings.find((binding) => binding.sourceId === item.sourceId) &&
                    catalog.some((source) => source.id === item.sourceId) && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void selectSource(
                            item.sourceId,
                            snapshot.bindings.find((binding) => binding.sourceId === item.sourceId),
                          )
                        }
                      >
                        {t("sourceCollections.editReference")}
                      </Button>
                    )}
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void act(
                        () => window.codeshell.unbindProjectSource(projectId, item.sourceId),
                        {
                          successMessage: t("projectConfig.dataSources.unbindDone"),
                        },
                      )
                    }
                  >
                    {t("projectConfig.dataSources.unbind")}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-3 rounded-md border border-border p-3">
        <div>
          <h3 className="text-sm font-medium text-foreground">
            {t(
              editingBinding
                ? "sourceCollections.editReference"
                : "projectConfig.dataSources.bindTitle",
            )}
          </h3>
          <p className="text-xs text-muted-foreground">
            {t("projectConfig.dataSources.bindSubtitle")}
          </p>
        </div>
        {available.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("sourceCollections.availableHint")}</p>
        ) : (
          <>
            <label className="block space-y-1 text-xs text-muted-foreground">
              <span>{t("projectConfig.dataSources.sourceLabel")}</span>
              <SimpleSelect
                size="sm"
                value={selectedSourceId}
                disabled={busy}
                placeholder={t("projectConfig.dataSources.sourcePlaceholder")}
                ariaLabel={t("projectConfig.dataSources.sourceLabel")}
                onChange={(value) => void selectSource(value)}
                options={available.map((source) => ({
                  value: source.id,
                  label: source.label,
                  description: kindLabel(t, source.kind),
                }))}
              />
            </label>

            {isCollection && (
              <div className="space-y-2">
                <SimpleSelect<"all" | "selected">
                  size="sm"
                  value={selectionMode}
                  disabled={busy || loadingScopes}
                  ariaLabel={t("sourceCollections.kind")}
                  onChange={(mode) => {
                    setSelectionMode(mode);
                    if (mode === "all") setSelectedScopes(new Set(scopes.map((item) => item.id)));
                    else setSelectedScopes(new Set());
                  }}
                  options={[
                    { value: "all", label: t("sourceCollections.allCurrent") },
                    { value: "selected", label: t("sourceCollections.selected") },
                  ]}
                />
                <p className="text-xs text-muted-foreground">
                  {t("sourceCollections.currentOnly")}
                </p>
                {missingSelection > 0 && (
                  <p className="text-xs text-status-err">
                    {t("sourceCollections.removedSelection", { count: missingSelection })}
                  </p>
                )}
              </div>
            )}
            <fieldset className="space-y-2" disabled={busy || loadingScopes}>
              <legend className="text-xs font-medium text-foreground">
                {t("projectConfig.dataSources.scopeLabel")}
              </legend>
              {!selectedSourceId ? (
                <p className="text-xs text-muted-foreground">
                  {t("projectConfig.dataSources.selectSourceFirst")}
                </p>
              ) : loadingScopes ? (
                <p className="text-xs text-muted-foreground">
                  {t("projectConfig.dataSources.loadingScopes")}
                </p>
              ) : scopes.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t("projectConfig.dataSources.noScopes")}
                </p>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                  {scopes.map((scope) => (
                    <label
                      key={scope.id}
                      className="flex items-start gap-2 rounded-md border border-border px-3 py-2 text-sm text-foreground"
                    >
                      <Checkbox
                        className="mt-0.5"
                        value={scope.id}
                        data-scope-id={scope.id}
                        checked={selectedScopes.has(scope.id)}
                        disabled={
                          busy || loadingScopes || (isCollection && selectionMode === "all")
                        }
                        onCheckedChange={(checked) => toggleScope(scope.id, checked === true)}
                      />
                      <span className="min-w-0">
                        <span className="block">{scope.label}</span>
                        {scope.description ? (
                          <span className="block text-xs text-muted-foreground">
                            {scope.description}
                          </span>
                        ) : null}
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </fieldset>

            <label className="block space-y-1 text-xs text-muted-foreground">
              <span>{t("projectConfig.dataSources.readPolicyLabel")}</span>
              <SimpleSelect<"ask" | "deny">
                size="sm"
                value={readPolicy}
                disabled={busy}
                ariaLabel={t("projectConfig.dataSources.readPolicyLabel")}
                onChange={setReadPolicy}
                options={[
                  {
                    value: "ask",
                    label: t("projectConfig.dataSources.readPolicyAsk"),
                    description: t("projectConfig.dataSources.readPolicyAskDesc"),
                  },
                  {
                    value: "deny",
                    label: t("projectConfig.dataSources.readPolicyDeny"),
                    description: t("projectConfig.dataSources.readPolicyDenyDesc"),
                  },
                ]}
              />
            </label>

            <Button
              type="button"
              size="sm"
              disabled={
                busy ||
                loadingScopes ||
                !selectedSourceId ||
                (!editingBinding && selectedScopes.size === 0)
              }
              onClick={() =>
                void act(
                  () =>
                    window.codeshell.bindProjectSource(projectId, {
                      sourceId: selectedSourceId,
                      scopes: scopes
                        .filter((scope) => selectedScopes.has(scope.id))
                        .map((scope) => scope.id),
                      readPolicy,
                    }),
                  {
                    clearSelection: true,
                    successMessage: t("projectConfig.dataSources.bindDone"),
                  },
                )
              }
            >
              {t(
                editingBinding
                  ? "sourceCollections.saveReference"
                  : "projectConfig.dataSources.bind",
              )}
            </Button>
            {selectedSourceId && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void selectSource("")}
              >
                {t("sourceCollections.cancel")}
              </Button>
            )}
          </>
        )}
      </div>
    </section>
  );
}
