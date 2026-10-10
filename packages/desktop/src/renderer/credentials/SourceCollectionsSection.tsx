import React from "react";
import type { SourceDefinition } from "@cjhyy/code-shell-core";
import type { SourceCollectionChange, SourceCollectionView } from "../../shared/source-collections";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "../i18n";
import { useConfirm } from "../ui/DialogProvider";

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Collection mutations go through native selection and revision checks, never the generic catalog. */
export function SourceCollectionsSection({
  definitions,
  onChanged,
}: {
  definitions: SourceDefinition[];
  onChanged: () => void;
}) {
  const { t } = useT();
  const confirm = useConfirm();
  const [editing, setEditing] = React.useState(false);
  const [view, setView] = React.useState<SourceCollectionView | null>(null);
  const [editorId, setEditorId] = React.useState<string | null>(null);
  const [label, setLabel] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [enabled, setEnabled] = React.useState(true);
  const [url, setUrl] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const lifetime = React.useRef(0);
  const active = React.useRef(true);
  const lock = React.useRef<"idle" | "confirming" | "mutating">("idle");

  React.useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      lifetime.current += 1;
    };
  }, []);
  const isCurrent = (request: number) => active.current && request === lifetime.current;
  const adopt = (next: SourceCollectionView, metadata = false) => {
    setView(next);
    if (metadata) {
      setLabel(next.definition.label);
      setDescription(next.definition.description ?? "");
      setEnabled(next.definition.enabled);
    }
  };
  const close = () => {
    if (lock.current === "mutating") return;
    lifetime.current += 1;
    lock.current = "idle";
    setBusy(false);
    setLoading(false);
    setEditing(false);
    setView(null);
    setError(null);
  };
  const open = async (id?: string) => {
    if (lock.current !== "idle") return;
    const request = ++lifetime.current;
    setEditing(true);
    setEditorId(id ?? null);
    setView(null);
    setLabel("");
    setDescription("");
    setEnabled(true);
    setUrl("");
    setError(null);
    setNotice(null);
    setLoading(Boolean(id));
    if (!id) return;
    try {
      const next = await window.codeshell.sourceCollections.get(id);
      if (isCurrent(request)) adopt(next, true);
    } catch (cause) {
      if (isCurrent(request)) setError(errorText(cause));
    } finally {
      if (isCurrent(request)) setLoading(false);
    }
  };
  const create = async () => {
    if (lock.current !== "idle" || !active.current || loading) return;
    if (!label.trim()) {
      setError(t("sourceCollections.nameRequired"));
      return;
    }
    const request = lifetime.current;
    lock.current = "mutating";
    setBusy(true);
    setError(null);
    try {
      const next = await window.codeshell.sourceCollections.create({
        label: label.trim(),
        description: description.trim(),
      });
      if (!isCurrent(request)) return;
      adopt(next, true);
      onChanged();
    } catch (cause) {
      if (isCurrent(request)) setError(errorText(cause));
    } finally {
      if (isCurrent(request)) {
        lock.current = "idle";
        setBusy(false);
      }
    }
  };
  const mutate = async (
    operation: (current: SourceCollectionView) => Promise<SourceCollectionView | null>,
    options?: {
      metadata?: boolean;
      clearUrl?: boolean;
      confirmation?: { title: string; message: string };
    },
  ) => {
    if (lock.current !== "idle" || !view || !active.current) return;
    const request = lifetime.current;
    const current = view;
    lock.current = options?.confirmation ? "confirming" : "mutating";
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (options?.confirmation) {
        const accepted = await confirm({ ...options.confirmation, destructive: true });
        if (!accepted || !isCurrent(request)) return;
        lock.current = "mutating";
      }
      const next = await operation(current);
      if (!isCurrent(request) || !next) return;
      adopt(next, options?.metadata);
      if (options?.clearUrl) setUrl("");
      setNotice(t("sourceCollections.updated"));
      onChanged();
    } catch (cause) {
      if (isCurrent(request)) setError(errorText(cause));
    } finally {
      if (isCurrent(request)) {
        lock.current = "idle";
        setBusy(false);
      }
    }
  };
  const update = (change: SourceCollectionChange, options?: Parameters<typeof mutate>[1]) =>
    mutate(
      (current) =>
        window.codeshell.sourceCollections.update(current.definition.id, current.revision, change),
      options,
    );
  const deleteCollection = async () => {
    if (lock.current !== "idle" || !view || !active.current) return;
    const request = lifetime.current;
    const id = view.definition.id;
    lock.current = "confirming";
    setBusy(true);
    setError(null);
    try {
      // Refresh the registered-project impact before showing the destructive action.
      const latest = await window.codeshell.sourceCollections.get(id);
      if (!isCurrent(request)) return;
      const accepted = await confirm({
        title: t("sourceCollections.deleteTitle"),
        message: t("sourceCollections.deleteMessage", {
          name: latest.definition.label,
          count: latest.references.length,
        }),
        detail: latest.references.length
          ? t("sourceCollections.references", {
              names: latest.references.map((item) => item.name).join("、"),
            })
          : t("sourceCollections.noReferences"),
        confirmLabel: t("sourceCollections.delete"),
        destructive: true,
      });
      if (!accepted || !isCurrent(request)) return;
      lock.current = "mutating";
      await window.codeshell.sourceCollections.delete(id, latest.revision);
      if (!isCurrent(request)) return;
      lock.current = "idle";
      close();
      onChanged();
    } catch (cause) {
      if (isCurrent(request)) setError(errorText(cause));
    } finally {
      if (isCurrent(request)) {
        lock.current = "idle";
        setBusy(false);
      }
    }
  };

  return (
    <section className="space-y-4" data-source-collections>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">{t("sourceCollections.title")}</h3>
          <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
            {t("sourceCollections.description")}
          </p>
        </div>
        <Button type="button" size="sm" disabled={busy} onClick={() => void open()}>
          {t("sourceCollections.new")}
        </Button>
      </header>
      {definitions.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("sourceCollections.empty")}</p>
      ) : (
        <ul className="space-y-2">
          {definitions.map((definition) => (
            <li
              key={definition.id}
              data-collection-id={definition.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-border p-3"
            >
              <div className="min-w-0">
                <span className="text-sm font-medium">{definition.label}</span>
                {!definition.enabled && (
                  <Badge className="ml-2" variant="secondary">
                    {t("sourceCollections.disabled")}
                  </Badge>
                )}
                {definition.description && (
                  <p className="text-xs text-muted-foreground">{definition.description}</p>
                )}
                <p className="text-xs text-muted-foreground">
                  {t("sourceCollections.files", {
                    count: Array.isArray(definition.adapterConfig.entries)
                      ? definition.adapterConfig.entries.length
                      : 0,
                  })}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void open(definition.id)}
              >
                {t("sourceCollections.edit")}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <section
          className="space-y-4 rounded-lg border border-border bg-card p-4"
          aria-label={t("sourceCollections.edit")}
        >
          <div className="flex items-center justify-between gap-3">
            <h4 className="text-sm font-semibold">
              {view?.definition.label ?? t("sourceCollections.new")}
            </h4>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy && lock.current === "mutating"}
              onClick={close}
            >
              {t(view ? "sourceCollections.close" : "sourceCollections.cancel")}
            </Button>
          </div>
          {error && (
            <div role="alert" className="space-y-2 text-xs text-status-err">
              <p>{error}</p>
              {(view || editorId) && (
                <Button
                  type="button"
                  size="sm"
                  disabled={busy}
                  onClick={() => void open(view?.definition.id ?? editorId!)}
                >
                  {t("sourceCollections.reload")}
                </Button>
              )}
            </div>
          )}
          {notice && (
            <p role="status" className="text-xs text-status-ok">
              {notice}
            </p>
          )}
          {loading ? (
            <p className="text-xs text-muted-foreground">{t("sourceCollections.loading")}</p>
          ) : (
            (!editorId || view) && (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="space-y-1 text-xs text-muted-foreground">
                    <span>{t("sourceCollections.name")}</span>
                    <Input
                      name="collection-label"
                      value={label}
                      disabled={busy}
                      onChange={(event) => setLabel(event.target.value)}
                    />
                  </label>
                  <label className="space-y-1 text-xs text-muted-foreground">
                    <span>{t("sourceCollections.descriptionLabel")}</span>
                    <Textarea
                      name="collection-description"
                      value={description}
                      disabled={busy}
                      onChange={(event) => setDescription(event.target.value)}
                    />
                  </label>
                </div>
                {view && (
                  <label className="flex items-center gap-2 text-xs">
                    <Checkbox
                      checked={enabled}
                      disabled={busy}
                      onCheckedChange={(checked) => setEnabled(checked === true)}
                    />
                    {t("sourceCollections.enabled")}
                  </label>
                )}
                <Button
                  type="button"
                  size="sm"
                  disabled={busy || !label.trim()}
                  onClick={() =>
                    view
                      ? void update(
                          {
                            kind: "metadata",
                            label: label.trim(),
                            description: description.trim(),
                            enabled,
                          },
                          { metadata: true },
                        )
                      : void create()
                  }
                >
                  {t(view ? "sourceCollections.save" : "sourceCollections.create")}
                </Button>
                {view && (
                  <>
                    <div className="space-y-2 border-t border-border pt-4">
                      <div className="flex flex-wrap gap-2">
                        {(["files", "folder"] as const).map((mode) => (
                          <Button
                            key={mode}
                            type="button"
                            size="sm"
                            disabled={busy}
                            onClick={() =>
                              void mutate((current) =>
                                window.codeshell.sourceCollections.pick(
                                  current.definition.id,
                                  current.revision,
                                  mode,
                                ),
                              )
                            }
                          >
                            {t(
                              mode === "files"
                                ? "sourceCollections.addFiles"
                                : "sourceCollections.addFolder",
                            )}
                          </Button>
                        ))}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {t("sourceCollections.localHint")}
                      </p>
                    </div>
                    <div className="space-y-2">
                      <label className="space-y-1 text-xs text-muted-foreground">
                        <span>{t("sourceCollections.url")}</span>
                        <Input
                          name="collection-url"
                          value={url}
                          disabled={busy}
                          placeholder="https://example.com/manual.pdf"
                          onChange={(event) => setUrl(event.target.value)}
                        />
                      </label>
                      <p className="text-xs text-muted-foreground">
                        {t("sourceCollections.urlHint")}
                      </p>
                      <Button
                        type="button"
                        size="sm"
                        disabled={busy || !url.trim()}
                        onClick={() =>
                          void update({ kind: "url", url: url.trim() }, { clearUrl: true })
                        }
                      >
                        {t("sourceCollections.addUrl")}
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {t("sourceCollections.files", { count: view.entries.length })}
                    </p>
                    {view.entries.length === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        {t("sourceCollections.noEntries")}
                      </p>
                    ) : (
                      <ul className="divide-y divide-border rounded-md border border-border">
                        {view.entries.map(({ entry, status }) => (
                          <li
                            key={entry.id}
                            data-collection-entry={entry.id}
                            className="space-y-2 p-3"
                          >
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-sm font-medium">
                                {entry.relativePath ?? entry.name}
                              </span>
                              <Badge variant="secondary">
                                {t(
                                  entry.kind === "local"
                                    ? "sourceCollections.local"
                                    : "sourceCollections.remote",
                                )}
                              </Badge>
                              <Badge
                                variant={
                                  status === "missing" || status === "changed"
                                    ? "destructive"
                                    : "secondary"
                                }
                              >
                                {t(`sourceCollections.status.${status}`)}
                              </Badge>
                            </div>
                            <p className="break-all text-xs text-muted-foreground">
                              {entry.kind === "local" ? entry.path : entry.url}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {entry.sizeBytes.toLocaleString()} B ·{" "}
                              {t("sourceCollections.checked", { time: entry.checkedAt })}
                            </p>
                            <div className="flex flex-wrap gap-2">
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={busy}
                                onClick={() => void update({ kind: "refresh", entryId: entry.id })}
                              >
                                {t("sourceCollections.refresh")}
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                disabled={busy}
                                onClick={() =>
                                  void update(
                                    { kind: "remove", entryId: entry.id },
                                    {
                                      confirmation: {
                                        title: t("sourceCollections.removeTitle"),
                                        message: t("sourceCollections.removeMessage", {
                                          name: entry.name,
                                        }),
                                      },
                                    },
                                  )
                                }
                              >
                                {t("sourceCollections.remove")}
                              </Button>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                    <p className="text-xs text-muted-foreground">
                      {view.references.length
                        ? t("sourceCollections.references", {
                            names: view.references.map((item) => item.name).join("、"),
                          })
                        : t("sourceCollections.noReferences")}
                    </p>
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      disabled={busy}
                      onClick={() => void deleteCollection()}
                    >
                      {t("sourceCollections.delete")}
                    </Button>
                  </>
                )}
                {busy && (
                  <p role="status" className="text-xs text-muted-foreground">
                    {t("sourceCollections.working")}
                  </p>
                )}
              </>
            )
          )}
        </section>
      )}
    </section>
  );
}
