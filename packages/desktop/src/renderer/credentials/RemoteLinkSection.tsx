import React from "react";
import type { LinkSnapshot, MaskedLinkConnection } from "@cjhyy/code-shell-link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "../i18n/I18nProvider";

/** Native owner-bound IPC; neither callback codes nor private credentials enter this component. */
export function RemoteLinkSection({ cwd, onChanged }: { cwd: string; onChanged: () => void }) {
  const { t } = useT();
  const [snapshot, setSnapshot] = React.useState<LinkSnapshot>();
  const [label, setLabel] = React.useState("GitHub");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const [rename, setRename] = React.useState<MaskedLinkConnection>();
  const [newName, setNewName] = React.useState("");
  const [disconnect, setDisconnect] = React.useState<string>();
  const request = React.useRef<string | undefined>(undefined);
  const alive = React.useRef(false);
  const onChange = React.useRef(onChanged);
  onChange.current = onChanged;
  const api = window.codeshell.links;
  const report = (cause: unknown) => {
    if (alive.current)
      setError(
        cause instanceof Error
          ? cause.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "")
          : t("ext.link.remoteFailed"),
      );
  };
  const load = React.useCallback(async () => {
    if (!api.remoteSnapshot) return;
    const next = await api.remoteSnapshot(cwd);
    if (alive.current) setSnapshot(next);
  }, [cwd, api]);
  React.useEffect(() => {
    alive.current = true;
    const refresh = () => {
      void load().catch(report);
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      alive.current = false;
      window.removeEventListener("focus", refresh);
      if (request.current) void api.remoteCancel(cwd, request.current).catch(() => {});
    };
  }, [cwd, load]);
  React.useEffect(() => {
    if (!snapshot?.remoteCleanupPending) return;
    const timer = setInterval(() => {
      void load().catch(report);
    }, 30_000);
    return () => clearInterval(timer);
  }, [snapshot?.remoteCleanupPending, load]);
  const operation = async (run: () => Promise<void>) => {
    if (busy || request.current) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await run();
    } catch (cause) {
      report(cause);
    } finally {
      if (alive.current) {
        setBusy(false);
        await load().catch(report);
        onChange.current();
      }
    }
  };
  const start = (connection?: MaskedLinkConnection) =>
    void operation(async () => {
      const id = crypto.randomUUID();
      request.current = id;
      try {
        const result = await api.remoteStart(cwd, id, {
          providerId: "github",
          methodId: "remote-link",
          label: connection?.label ?? label.trim(),
          ...(connection ? { connectionId: connection.id } : {}),
          expectedRevision: connection?.revision ?? null,
        });
        if (alive.current) {
          setNotice(
            t(
              result.state === "connected"
                ? "ext.link.remoteConnected"
                : "ext.link.remoteCancelled",
            ),
          );
        }
      } finally {
        if (request.current === id) request.current = undefined;
      }
    });
  if (!api.remoteSnapshot) return null;
  const connections =
    snapshot?.connections.filter((item) => item.authSource === "remote-link") ?? [];
  return (
    <section
      className="space-y-3 rounded-2xl border border-sky-500/20 bg-sky-500/[0.025] p-4"
      data-remote-links
    >
      <div>
        <h3 className="text-sm font-semibold">{t("ext.link.remoteTitle")}</h3>
        <p className="mt-1 text-xs text-muted-foreground">{t("ext.link.remoteDescription")}</p>
        {snapshot?.remoteServer && (
          <p className="mt-1 break-all text-xs text-muted-foreground">
            {snapshot.remoteServer.issuer}
          </p>
        )}
      </div>
      {snapshot && !snapshot.capabilities.remoteAuth && (
        <p className="text-xs text-muted-foreground">{t("ext.link.remoteUnconfigured")}</p>
      )}
      {snapshot?.capabilities.remoteAuth && (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            className="min-w-40 flex-1"
            aria-label={t("ext.link.remoteName")}
            value={label}
            maxLength={100}
            disabled={busy}
            onChange={(event) => setLabel(event.target.value)}
          />
          <Button size="sm" disabled={busy || !label.trim()} onClick={() => start()}>
            {t("ext.link.remoteAdd")}
          </Button>
        </div>
      )}
      {busy && request.current && (
        <div role="status" className="flex flex-wrap items-center gap-2 text-xs">
          {t("ext.link.remoteWaiting")}
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              if (request.current) void api.remoteCancel(cwd, request.current).catch(report);
            }}
          >
            {t("ext.link.remoteCancel")}
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="break-words text-xs text-status-err">
          {error}
        </p>
      )}
      {!!snapshot?.remoteCleanupPending && (
        <p role="status" className="text-xs text-muted-foreground">
          {t("ext.link.remoteCleanupPending")}
        </p>
      )}
      {notice && (
        <p role="status" className="text-xs">
          {notice}
        </p>
      )}
      {connections.map((connection) => (
        <article
          key={connection.id}
          data-remote-link={connection.id}
          className="space-y-2 rounded-xl border border-border/70 bg-card p-3"
        >
          <div className="flex flex-wrap justify-between gap-2 text-xs">
            <strong>{connection.label}</strong>
            <span>
              {t(
                connection.status === "connected"
                  ? "ext.link.remoteAvailable"
                  : "ext.link.remoteReconnectNeeded",
              )}
            </span>
          </div>
          <p className="break-words text-xs text-muted-foreground">
            {connection.account?.label ?? "GitHub"}
          </p>
          {connection.account?.resources?.length ? (
            <p className="break-words text-xs text-muted-foreground">
              {connection.account?.resources.join(" · ")}
            </p>
          ) : null}
          {rename?.id === connection.id && (
            <div className="flex flex-wrap gap-2">
              <Input
                aria-label={t("ext.link.remoteNewName")}
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                maxLength={100}
                disabled={busy}
              />
              <Button
                size="sm"
                disabled={busy || !newName.trim()}
                onClick={() =>
                  void operation(async () => {
                    await api.remoteRename(cwd, rename.id, newName.trim(), rename.revision);
                    if (alive.current) setRename(undefined);
                  })
                }
              >
                {t("ext.link.remoteSaveName")}
              </Button>
            </div>
          )}
          {connection.editable ? (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setRename(connection);
                  setNewName(connection.label);
                }}
              >
                {t("ext.link.remoteRename")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy || !snapshot?.capabilities.remoteAuth}
                onClick={() => start(connection)}
              >
                {t("ext.link.remoteReconnect")}
              </Button>
              {disconnect === connection.id ? (
                <>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void operation(async () => {
                        await api.remoteDisconnect(cwd, connection.id, connection.revision);
                        if (alive.current) {
                          setDisconnect(undefined);
                          setNotice(t("ext.link.remoteDisconnected"));
                        }
                      })
                    }
                  >
                    {t("ext.link.remoteConfirmDisconnect")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => setDisconnect(undefined)}
                  >
                    {t("ext.link.remoteCancel")}
                  </Button>
                </>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => setDisconnect(connection.id)}
                >
                  {t("ext.link.remoteDisconnect")}
                </Button>
              )}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">{t("ext.link.remoteReadOnly")}</p>
          )}
        </article>
      ))}
    </section>
  );
}
