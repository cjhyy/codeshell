import React from "react";
import type { SourceDefinition } from "@cjhyy/code-shell-core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SimpleSelect } from "@/components/ui/simple-select";
import { useT, type TFunction } from "../i18n";
import { useConfirm } from "../ui/DialogProvider";
import type { LocalLinkProviderView, MaskedCredentialView } from "../../preload/types";
import { SourceCollectionsSection } from "./SourceCollectionsSection";

type EditableSourceKind = "mcp-resource" | "link";

function errorText(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

function kindLabel(t: TFunction, kind: string): string {
  if (kind === "mcp-resource") return t("ext.link.sourcesKindMcpResource");
  if (kind === "local-files") return t("projectConfig.dataSources.kindLocalFiles");
  if (kind === "link") return t("ext.link.sourcesKindLink");
  return kind;
}

/** Global connection definitions; project-specific grants stay in Project Config. */
export function DataSourceCatalogSection({
  confirmDelete,
  onManageConnections,
}: {
  /** Test seam; production uses the app-level themed confirmation dialog. */
  confirmDelete?: (source: SourceDefinition) => Promise<boolean>;
  onManageConnections?: () => void;
} = {}) {
  const { t } = useT();
  const confirm = useConfirm();
  const [sources, setSources] = React.useState<SourceDefinition[]>([]);
  const [editing, setEditing] = React.useState(false);
  const [kind, setKind] = React.useState<EditableSourceKind>("link");
  const [label, setLabel] = React.useState("");
  const [server, setServer] = React.useState("");
  const [connections, setConnections] = React.useState<MaskedCredentialView[]>([]);
  const [providers, setProviders] = React.useState<LocalLinkProviderView[]>([]);
  const [connectionId, setConnectionId] = React.useState("");
  const [actionId, setActionId] = React.useState("");
  const [params, setParams] = React.useState("{}");
  const [connectionLoading, setConnectionLoading] = React.useState(false);
  const [connectionLoaded, setConnectionLoaded] = React.useState(false);
  const [connectionError, setConnectionError] = React.useState<string | null>(null);
  const [connectionRevision, setConnectionRevision] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [catalogLoaded, setCatalogLoaded] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const active = React.useRef(true);
  const loadRequest = React.useRef(0);
  const busyLock = React.useRef(false);
  React.useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      loadRequest.current += 1;
    };
  }, []);

  React.useEffect(() => {
    if (!editing || kind !== "link") return;
    let cancelled = false;
    setConnectionLoading(true);
    setConnectionLoaded(false);
    setConnectionError(null);
    void Promise.all([
      window.codeshell.credentials.list(""),
      window.codeshell.links.listLocalProviders(),
    ])
      .then(([credentials, nextProviders]) => {
        if (cancelled) return;
        setConnections(
          credentials.filter(
            (entry) =>
              entry.hasSecret &&
              entry.meta?.linkProvider &&
              (entry.type === "link" || entry.meta.linkExecutionRuntime === "server"),
          ),
        );
        setProviders(nextProviders);
        setConnectionLoaded(true);
      })
      .catch((caught) => {
        if (!cancelled) setConnectionError(errorText(caught));
      })
      .finally(() => {
        if (!cancelled) setConnectionLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [editing, kind, connectionRevision]);

  const connection = connections.find((entry) => entry.id === connectionId);
  const provider = providers.find((entry) => entry.id === connection?.meta?.linkProvider);
  const actions =
    provider?.actions.filter(
      (entry) =>
        entry.risk !== "write" &&
        (connection?.meta?.linkExecutionRuntime === "server"
          ? connection.meta.linkCapabilityIds?.includes(`${provider.id}.${entry.id}`)
          : !connection?.meta?.linkCapabilityIds?.length ||
            connection.meta.linkCapabilityIds.includes(`${provider.id}.${entry.id}`)),
    ) ?? [];

  const refresh = React.useCallback(async () => {
    const request = ++loadRequest.current;
    setLoading(true);
    setError(null);
    try {
      const next = await window.codeshell.listSourceCatalog();
      if (active.current && request === loadRequest.current) {
        setSources(next.filter((source) => source.kind !== "mock"));
        setCatalogLoaded(true);
      }
    } catch (caught) {
      if (!active.current || request !== loadRequest.current) return;
      setError(errorText(caught));
      throw caught;
    } finally {
      if (active.current && request === loadRequest.current) setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void refresh().catch(() => {});
  }, [refresh]);

  const run = async (
    operation: () => Promise<unknown>,
    onCommitted?: () => void,
  ): Promise<boolean> => {
    if (busyLock.current || !active.current) return false;
    busyLock.current = true;
    setBusy(true);
    setError(null);
    try {
      await operation();
      if (active.current) onCommitted?.();
      await refresh();
      return true;
    } catch (caught) {
      if (active.current) setError(errorText(caught));
      return false;
    } finally {
      busyLock.current = false;
      if (active.current) setBusy(false);
    }
  };

  const createSource = async () => {
    const trimmedLabel = label.trim();
    const trimmedServer = server.trim();
    if (!trimmedLabel) {
      setError(t("ext.link.sourcesRequired"));
      return;
    }
    if (kind === "mcp-resource" && !trimmedServer) {
      setError(t("ext.link.sourcesServerRequired"));
      return;
    }
    let linkConfig: Record<string, unknown> | undefined;
    if (kind === "link") {
      if (
        connectionLoading ||
        !connectionLoaded ||
        !connection ||
        !provider ||
        !actions.some((entry) => entry.id === actionId)
      ) {
        setError(t("ext.link.sourcesLinkRequired"));
        return;
      }
      try {
        const parsed = JSON.parse(params);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
        linkConfig = { providerId: provider.id, action: actionId, params: parsed };
      } catch {
        setError(t("ext.link.sourcesParamsInvalid"));
        return;
      }
    }
    const definition: SourceDefinition = {
      id: `source_${crypto.randomUUID().replaceAll("-", "")}`,
      kind,
      label: trimmedLabel,
      adapterConfig: linkConfig ?? (kind === "mcp-resource" ? { server: trimmedServer } : {}),
      ...(kind === "link" ? { credentialRef: connectionId } : {}),
      enabled: true,
    };
    await run(
      () => window.codeshell.saveSourceCatalog(definition),
      () => {
        // A committed view is complete even if refreshing its list fails.
        setEditing(false);
        setKind("link");
        setLabel("");
        setServer("");
        setConnectionId("");
        setActionId("");
        setParams("{}");
      },
    );
  };

  const deleteSource = async (source: SourceDefinition) => {
    const accepted = confirmDelete
      ? await confirmDelete(source)
      : await confirm({
          title: t("ext.link.sourcesDeleteTitle"),
          message: t("ext.link.sourcesDeleteConfirm", { label: source.label }),
          confirmLabel: t("ext.link.sourcesDelete"),
          destructive: true,
        });
    if (!accepted || !active.current) return;
    await run(() => window.codeshell.deleteSourceCatalog(source.id));
  };

  const onlineSources = sources.filter((source) => source.kind === "link");
  const advancedSources = sources.filter(
    (source) => source.kind !== "collection" && source.kind !== "link",
  );
  const renderSources = (items: SourceDefinition[]) => (
    <ul className="space-y-2">
      {items.map((source) => (
        <li
          key={source.id}
          data-source-definition
          className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card p-3"
        >
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="break-words text-sm font-medium text-foreground">
                {source.label}
              </span>
              <Badge variant="secondary">
                {source.kind === "link" && source.adapterConfig.action === "get_file"
                  ? t("ext.link.sourcesKindFile")
                  : kindLabel(t, source.kind)}
              </Badge>
              <Badge variant={source.enabled ? "success" : "secondary"}>
                {source.enabled ? t("ext.link.sourcesEnabled") : t("ext.link.sourcesDisabled")}
              </Badge>
            </div>
            <p className="mt-1 break-all text-xs text-muted-foreground">
              {source.kind === "link"
                ? String(source.adapterConfig.providerId ?? "Link")
                : source.kind === "mcp-resource"
                  ? String(source.adapterConfig.server ?? "MCP")
                  : source.id}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              data-source-toggle={source.id}
              onClick={() =>
                void run(() =>
                  window.codeshell.saveSourceCatalog({ ...source, enabled: !source.enabled }),
                )
              }
            >
              {source.enabled ? t("ext.link.sourcesDisable") : t("ext.link.sourcesEnable")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={busy}
              data-source-delete={source.id}
              onClick={() => void deleteSource(source)}
            >
              {t("ext.link.sourcesDelete")}
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
  return (
    <div className="space-y-5">
      {loading && (
        <p role="status" className="text-xs text-muted-foreground">
          {t("ext.link.sourcesLoading")}
        </p>
      )}
      {error && (
        <div role="alert" className="space-y-2 text-xs text-status-err">
          <p>{error}</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={loading || busy}
            onClick={() => void refresh().catch(() => {})}
          >
            {t("sourceCollections.reload")}
          </Button>
        </div>
      )}
      {catalogLoaded && (
        <SourceCollectionsSection
          definitions={sources.filter((source) => source.kind === "collection")}
          onChanged={() => void refresh().catch(() => {})}
        />
      )}
      <section className="space-y-3" data-connected-materials>
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">{t("sourceCollections.catalog.title")}</h3>
            <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
              {t("sourceCollections.catalog.description")}
            </p>
          </div>
          {onManageConnections && (
            <Button type="button" size="sm" variant="outline" onClick={onManageConnections}>
              {t("ext.link.sourcesManageConnections")}
            </Button>
          )}
        </header>
        {catalogLoaded &&
          (onlineSources.length ? (
            renderSources(onlineSources)
          ) : (
            <p className="text-xs text-muted-foreground">{t("sourceCollections.catalog.empty")}</p>
          ))}
      </section>
      <details className="rounded-lg border border-border p-4">
        <summary className="cursor-pointer text-sm font-medium">
          {t("sourceCollections.catalog.advanced")}
        </summary>
        <section className="mt-4 space-y-3">
          <p className="text-xs text-muted-foreground">
            {t("sourceCollections.catalog.advancedHint")}
          </p>
          {catalogLoaded && renderSources(advancedSources)}
          {!editing ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy || !catalogLoaded}
              onClick={() => {
                setError(null);
                setEditing(true);
              }}
            >
              {t("sourceCollections.catalog.createView")}
            </Button>
          ) : (
            <div className="space-y-3 rounded-lg border border-border bg-card p-4">
              <h4 className="text-sm font-medium text-foreground">
                {t("sourceCollections.catalog.createView")}
              </h4>
              <p className="text-xs text-muted-foreground">
                {t("sourceCollections.catalog.viewHint")}
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1 text-xs text-muted-foreground">
                  <span>{t("ext.link.sourcesLabel")}</span>
                  <Input
                    name="source-label"
                    value={label}
                    disabled={busy}
                    placeholder={t("ext.link.sourcesLabelPlaceholder")}
                    onChange={(event) => setLabel(event.target.value)}
                  />
                </label>
                <label className="space-y-1 text-xs text-muted-foreground">
                  <span>{t("sourceCollections.catalog.chooseKind")}</span>
                  <SimpleSelect<EditableSourceKind>
                    size="sm"
                    value={kind}
                    disabled={busy}
                    ariaLabel={t("sourceCollections.catalog.chooseKind")}
                    onChange={(value) => {
                      setKind(value);
                      setConnectionId("");
                      setActionId("");
                      setParams("{}");
                      setError(null);
                    }}
                    options={[
                      { value: "link", label: kindLabel(t, "link") },
                      { value: "mcp-resource", label: kindLabel(t, "mcp-resource") },
                    ]}
                  />
                </label>
                {kind === "mcp-resource" && (
                  <label className="space-y-1 text-xs text-muted-foreground sm:col-span-2">
                    <span>{t("ext.link.sourcesServer")}</span>
                    <Input
                      name="source-server"
                      value={server}
                      disabled={busy}
                      placeholder={t("ext.link.sourcesServerPlaceholder")}
                      onChange={(event) => setServer(event.target.value)}
                    />
                  </label>
                )}
                {kind === "link" && (
                  <>
                    {connectionLoading && (
                      <p role="status" className="text-xs text-muted-foreground sm:col-span-2">
                        {t("sourceCollections.catalog.connectionLoading")}
                      </p>
                    )}
                    {connectionError && (
                      <p role="alert" className="text-xs text-status-err sm:col-span-2">
                        {connectionError}
                      </p>
                    )}
                    {connectionLoaded && connections.length === 0 && (
                      <p className="text-xs text-muted-foreground sm:col-span-2">
                        {t("sourceCollections.catalog.connectionEmpty")}
                      </p>
                    )}
                    <label className="space-y-1 text-xs text-muted-foreground">
                      <span>{t("ext.link.sourcesConnection")}</span>
                      <SimpleSelect
                        size="sm"
                        value={connectionId}
                        disabled={busy || connectionLoading || !connectionLoaded}
                        ariaLabel={t("ext.link.sourcesConnection")}
                        placeholder={t("sourceCollections.catalog.connectionPlaceholder")}
                        onChange={(value) => {
                          setConnectionId(value);
                          setActionId("");
                          setParams("{}");
                        }}
                        options={connections.map((entry) => ({
                          value: entry.id,
                          label: `${entry.label} (${entry.meta?.linkAccountLabel ?? entry.meta?.linkProvider})`,
                        }))}
                      />
                    </label>
                    <label className="space-y-1 text-xs text-muted-foreground">
                      <span>{t("ext.link.sourcesAction")}</span>
                      <SimpleSelect
                        size="sm"
                        value={actionId}
                        disabled={busy || connectionLoading || !connectionLoaded || !connection}
                        ariaLabel={t("ext.link.sourcesAction")}
                        placeholder={t("sourceCollections.catalog.actionPlaceholder")}
                        onChange={(value) => {
                          setActionId(value);
                          setParams("{}");
                        }}
                        options={actions.map((entry) => ({
                          value: entry.id,
                          label: entry.title,
                          description: entry.description,
                        }))}
                      />
                    </label>
                    <div className="flex flex-wrap gap-2 sm:col-span-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={busy || connectionLoading}
                        onClick={() => {
                          setConnectionId("");
                          setActionId("");
                          setParams("{}");
                          setConnectionRevision((value) => value + 1);
                        }}
                      >
                        {t("sourceCollections.catalog.connectionRetry")}
                      </Button>
                    </div>
                    {connection && actionId && (
                      <label className="space-y-1 text-xs text-muted-foreground sm:col-span-2">
                        <span>{t("ext.link.sourcesParams")}</span>
                        <Textarea
                          name="source-link-params"
                          value={params}
                          disabled={busy}
                          onChange={(event) => setParams(event.target.value)}
                        />
                        <p>{t("ext.link.sourcesLinkHelp")}</p>
                        {actions.find((entry) => entry.id === actionId)?.description}
                      </label>
                    )}
                  </>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {t("sourceCollections.catalog.generatedId")}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={busy || (kind === "link" && (connectionLoading || !connectionLoaded))}
                  data-source-create
                  onClick={() => void createSource()}
                >
                  {t("ext.link.sourcesSave")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setEditing(false);
                    setError(null);
                    setLabel("");
                    setServer("");
                    setConnectionId("");
                    setActionId("");
                    setParams("{}");
                    setKind("link");
                  }}
                >
                  {t("sourceCollections.catalog.cancel")}
                </Button>
              </div>
            </div>
          )}
        </section>
      </details>
    </div>
  );
}
