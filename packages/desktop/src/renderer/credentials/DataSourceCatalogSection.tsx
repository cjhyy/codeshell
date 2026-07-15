import React from "react";
import type { SourceDefinition } from "@cjhyy/code-shell-core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "../i18n/I18nProvider";

type EditableSourceKind = "mock" | "mcp-resource";

function errorText(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

/** Global connection definitions; project-specific grants stay in Project Config. */
export function DataSourceCatalogSection() {
  const { t } = useT();
  const [sources, setSources] = React.useState<SourceDefinition[]>([]);
  const [id, setId] = React.useState("");
  const [kind, setKind] = React.useState<EditableSourceKind>("mock");
  const [label, setLabel] = React.useState("");
  const [server, setServer] = React.useState("");
  const [formVersion, setFormVersion] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    const next = await window.codeshell.listSourceCatalog();
    setSources(next);
  }, []);

  React.useEffect(() => {
    void refresh()
      .then(() => setError(null))
      .catch((caught) => setError(errorText(caught)))
      .finally(() => setLoading(false));
  }, [refresh]);

  const run = async (operation: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await operation();
      await refresh();
      return true;
    } catch (caught) {
      setError(errorText(caught));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const createSource = async () => {
    const trimmedId = id.trim();
    const trimmedLabel = label.trim();
    const trimmedServer = server.trim();
    if (!trimmedId || !trimmedLabel) {
      setError(t("ext.link.sourcesRequired"));
      return;
    }
    if (kind === "mcp-resource" && !trimmedServer) {
      setError(t("ext.link.sourcesServerRequired"));
      return;
    }
    const definition: SourceDefinition = {
      id: trimmedId,
      kind,
      label: trimmedLabel,
      adapterConfig: kind === "mcp-resource" ? { server: trimmedServer } : {},
      enabled: true,
    };
    if (await run(() => window.codeshell.saveSourceCatalog(definition))) {
      setId("");
      setKind("mock");
      setLabel("");
      setServer("");
      setFormVersion((version) => version + 1);
    }
  };

  const deleteSource = async (source: SourceDefinition) => {
    if (!window.confirm(t("ext.link.sourcesDeleteConfirm", { label: source.label }))) return;
    await run(() => window.codeshell.deleteSourceCatalog(source.id));
  };

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold">{t("ext.link.sourcesTitle")}</h3>
        <p className="mt-1 text-xs text-muted-foreground">{t("ext.link.sourcesDescription")}</p>
      </div>

      <div className="space-y-3 rounded-lg border border-border bg-card p-4">
        <h4 className="text-sm font-medium text-foreground">{t("ext.link.sourcesCreate")}</h4>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-xs text-muted-foreground">
            <span>{t("ext.link.sourcesId")}</span>
            <Input
              name="source-id"
              value={id}
              disabled={busy}
              placeholder="team-docs"
              onChange={(event) => setId(event.target.value)}
            />
          </label>
          <label className="space-y-1 text-xs text-muted-foreground">
            <span>{t("ext.link.sourcesKind")}</span>
            <select
              key={formVersion}
              name="source-kind"
              className="cs-control h-9 w-full rounded-md px-3 text-sm text-foreground"
              disabled={busy}
              onChange={(event) => setKind(event.target.value as EditableSourceKind)}
            >
              <option value="mock">mock</option>
              <option value="mcp-resource">mcp-resource</option>
            </select>
          </label>
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
          {kind === "mcp-resource" ? (
            <label className="space-y-1 text-xs text-muted-foreground">
              <span>{t("ext.link.sourcesServer")}</span>
              <Input
                name="source-server"
                value={server}
                disabled={busy}
                placeholder={t("ext.link.sourcesServerPlaceholder")}
                onChange={(event) => setServer(event.target.value)}
              />
            </label>
          ) : null}
        </div>
        <Button
          type="button"
          size="sm"
          disabled={busy}
          data-source-create
          onClick={() => void createSource()}
        >
          {t("ext.link.sourcesSave")}
        </Button>
      </div>

      {error ? (
        <p role="alert" className="text-xs text-status-err">
          {error}
        </p>
      ) : null}

      {loading ? (
        <p className="text-xs text-muted-foreground">{t("ext.link.sourcesLoading")}</p>
      ) : sources.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("ext.link.sourcesEmpty")}</p>
      ) : (
        <ul className="space-y-2">
          {sources.map((source) => (
            <li
              key={source.id}
              data-source-definition
              className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card p-3"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-foreground">{source.label}</span>
                  <Badge variant="secondary">{source.kind}</Badge>
                  <Badge variant={source.enabled ? "success" : "secondary"}>
                    {source.enabled ? t("ext.link.sourcesEnabled") : t("ext.link.sourcesDisabled")}
                  </Badge>
                </div>
                <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{source.id}</p>
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
                      window.codeshell.saveSourceCatalog({
                        ...source,
                        enabled: !source.enabled,
                      }),
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
      )}
    </section>
  );
}
