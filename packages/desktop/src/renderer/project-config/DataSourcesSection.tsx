import React from "react";
import type {
  EffectiveSourceAccess,
  SourceDefinition,
  SourceResourceMeta,
  SourceScope,
} from "@cjhyy/code-shell-core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SimpleSelect } from "@/components/ui/simple-select";
import { useT, type TFunction } from "../i18n";
import { useToast } from "../ui/ToastProvider";

interface WorkspaceSourceSnapshot {
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
  if (kind === "mock") return t("projectConfig.dataSources.kindMock");
  if (kind === "mcp-resource") return t("projectConfig.dataSources.kindMcpResource");
  if (kind === "local-files") return t("projectConfig.dataSources.kindLocalFiles");
  return kind;
}

/** Project-local upload and source-binding controls. Content reads stay in ReadSource. */
export function DataSourcesSection({ cwd }: { cwd: string }) {
  const { t } = useT();
  const toast = useToast();
  const [catalog, setCatalog] = React.useState<SourceDefinition[]>([]);
  const [snapshot, setSnapshot] = React.useState<WorkspaceSourceSnapshot>({
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
  const scopeRequest = React.useRef(0);

  const refresh = React.useCallback(async () => {
    try {
      const [nextCatalog, nextSnapshot] = await Promise.all([
        window.codeshell.listSourceCatalog(),
        window.codeshell.workspaceSourceAccess(cwd),
      ]);
      setCatalog(nextCatalog);
      setSnapshot({ access: nextSnapshot.access, uploads: nextSnapshot.uploads });
      setError(null);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const act = async (
    operation: () => Promise<unknown>,
    opts?: { clearSelection?: boolean; successMessage?: string },
  ) => {
    setBusy(true);
    setError(null);
    try {
      await operation();
      await refresh();
      if (opts?.clearSelection) {
        scopeRequest.current += 1;
        setSelectedSourceId("");
        setScopes([]);
        setSelectedScopes(new Set());
        setReadPolicy("ask");
      }
      if (opts?.successMessage) toast({ message: opts.successMessage });
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  };

  const selectSource = async (sourceId: string) => {
    const request = ++scopeRequest.current;
    setSelectedSourceId(sourceId);
    setScopes([]);
    setSelectedScopes(new Set());
    setError(null);
    if (!sourceId) {
      setLoadingScopes(false);
      return;
    }
    setLoadingScopes(true);
    try {
      const next = await window.codeshell.listSourceScopes(sourceId);
      if (scopeRequest.current === request) setScopes(next);
    } catch (caught) {
      if (scopeRequest.current === request) setError(errorText(caught));
    } finally {
      if (scopeRequest.current === request) setLoadingScopes(false);
    }
  };

  const toggleScope = (scopeId: string, checked: boolean) => {
    setSelectedScopes((current) => {
      const next = new Set(current);
      if (checked) next.add(scopeId);
      else next.delete(scopeId);
      return next;
    });
  };

  const boundIds = new Set(snapshot.access.map((item) => item.sourceId));
  const available = catalog.filter((source) => source.enabled && !boundIds.has(source.id));

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
        <p className="text-xs text-muted-foreground">{t("projectConfig.dataSources.subtitle")}</p>
      </div>

      {error ? <p className="text-xs text-status-err">{error}</p> : null}

      <div className="space-y-3 rounded-md border border-border p-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-medium text-foreground">
              {t("projectConfig.dataSources.uploadTitle")}
            </h3>
            <p className="text-xs text-muted-foreground">
              {t("projectConfig.dataSources.uploadSubtitle")}
            </p>
          </div>
          <Button
            size="sm"
            disabled={busy}
            onClick={() =>
              void act(() => window.codeshell.pickAndUploadSources(cwd), {
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
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    if (
                      !window.confirm(
                        t("projectConfig.dataSources.deleteUploadConfirm", {
                          name: upload.name,
                        }),
                      )
                    ) {
                      return;
                    }
                    void act(() => window.codeshell.deleteUpload(cwd, upload.name), {
                      successMessage: t("projectConfig.dataSources.deleteUploadDone"),
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
        {snapshot.access.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("projectConfig.dataSources.noBound")}</p>
        ) : (
          <ul className="space-y-2">
            {snapshot.access.map((item) => (
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
                  <p className="truncate text-xs text-muted-foreground">
                    {t("projectConfig.dataSources.scopes", {
                      scopes: item.scopes.join(", ") || "—",
                    })}
                  </p>
                </div>
                {item.sourceId !== "project-uploads" ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void act(() => window.codeshell.unbindSource(cwd, item.sourceId), {
                        successMessage: t("projectConfig.dataSources.unbindDone"),
                      })
                    }
                  >
                    {t("projectConfig.dataSources.unbind")}
                  </Button>
                ) : (
                  <Badge variant="outline">{t("projectConfig.dataSources.builtinBadge")}</Badge>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-3 rounded-md border border-border p-3">
        <div>
          <h3 className="text-sm font-medium text-foreground">
            {t("projectConfig.dataSources.bindTitle")}
          </h3>
          <p className="text-xs text-muted-foreground">
            {t("projectConfig.dataSources.bindSubtitle")}
          </p>
        </div>
        {available.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {t("projectConfig.dataSources.noSources")}
          </p>
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
                      <input
                        type="checkbox"
                        className="mt-0.5 accent-primary"
                        value={scope.id}
                        checked={selectedScopes.has(scope.id)}
                        onChange={(event) => toggleScope(scope.id, event.target.checked)}
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
              size="sm"
              disabled={busy || !selectedSourceId || selectedScopes.size === 0}
              onClick={() =>
                void act(
                  () =>
                    window.codeshell.bindSource(cwd, {
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
              {t("projectConfig.dataSources.bind")}
            </Button>
          </>
        )}
      </div>
    </section>
  );
}
