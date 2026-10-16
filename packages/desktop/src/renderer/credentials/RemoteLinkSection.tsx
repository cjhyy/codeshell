import React from "react";
import { Cable, Check, Figma, Github, Settings2 } from "lucide-react";
import type { LinkProviderView, LinkSnapshot, MaskedLinkConnection } from "@cjhyy/code-shell-link";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useT } from "../i18n/I18nProvider";
import { LinkConnectionDialog } from "./LinkConnectionDialog";
import { LinkConnectionRow } from "./LinkProviderCard";
import { LinkAccountMenu, LinkPresentationContext, useLinkPrimaryAction } from "./LinkPresentation";

/** Keep the snapshot above filters so connected accounts can always be discovered. */
export function useRemoteLinkSnapshot(cwd: string, { automatic = true } = {}) {
  const [snapshot, setSnapshot] = React.useState<LinkSnapshot>();
  const [error, setError] = React.useState("");
  const [loading, setLoading] = React.useState(true);
  const api = window.codeshell.links;
  const alive = React.useRef(false);
  const generation = React.useRef(0);
  const reload = React.useCallback(
    async (forceCatalog = false) => {
      if (!api.remoteSnapshot) {
        if (alive.current) setLoading(false);
        return;
      }
      const current = ++generation.current;
      if (alive.current) setLoading(true);
      try {
        const next = await api.remoteSnapshot(cwd, forceCatalog);
        if (alive.current && current === generation.current) {
          setSnapshot(next);
          setError("");
        }
      } catch (cause) {
        if (alive.current && current === generation.current) setError(linkError(cause));
      } finally {
        if (alive.current && current === generation.current) setLoading(false);
      }
    },
    [cwd, api],
  );
  React.useEffect(() => {
    alive.current = true;
    generation.current++;
    setSnapshot(undefined);
    setError("");
    setLoading(true);
    if (!automatic)
      return () => {
        alive.current = false;
        generation.current++;
      };
    const refresh = () => void reload();
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      alive.current = false;
      generation.current++;
      window.removeEventListener("focus", refresh);
    };
  }, [reload, automatic]);
  React.useEffect(() => {
    if (!snapshot?.remoteCleanupPending) return;
    const timer = setInterval(() => void reload(), 30_000);
    return () => clearInterval(timer);
  }, [snapshot?.remoteCleanupPending, reload]);
  return { snapshot, error, loading: loading && !snapshot, reload };
}

function linkError(cause: unknown): string {
  return cause instanceof Error
    ? cause.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "")
    : String(cause);
}

/** One card per advertised provider, including saved accounts that are currently offline. */
export function remoteLinkProviders(snapshot?: LinkSnapshot) {
  const providers = new Map<string, LinkProviderView | undefined>();
  for (const provider of snapshot?.providers ?? []) {
    if (provider.authModes?.some((mode) => mode.id === "remote-link"))
      providers.set(provider.id, provider);
  }
  for (const connection of snapshot?.connections ?? []) {
    if (connection.authSource === "remote-link" && !providers.has(connection.providerId))
      providers.set(connection.providerId, undefined);
  }
  return providers;
}

/** Only Host-advertised remote providers are shown; saved accounts stay manageable offline. */
export function RemoteLinkSection(props: {
  cwd: string;
  snapshot?: LinkSnapshot;
  loadError: string;
  reload: () => Promise<void>;
  onChanged: () => void;
  excludeProviderIds?: readonly string[];
}) {
  const { t } = useT();
  const providers = remoteLinkProviders(props.snapshot);
  if (!providers.size && props.loadError)
    return (
      <div
        role="alert"
        className="flex items-center justify-between gap-3 rounded-xl border border-status-err/20 p-3 text-xs text-status-err"
      >
        <p className="min-w-0 break-words">{props.loadError}</p>
        <Button variant="outline" size="sm" onClick={() => void props.reload()}>
          {t("ext.link.retry")}
        </Button>
      </div>
    );
  return (
    <div data-remote-links className="space-y-3">
      {[...providers]
        .filter(([id]) => !props.excludeProviderIds?.includes(id))
        .map(([providerId, provider]) => (
          <RemoteProviderSection
            key={providerId}
            {...props}
            providerId={providerId}
            provider={provider}
          />
        ))}
    </div>
  );
}

/** Native owner-bound IPC; private credentials never enter this component. */
export function RemoteProviderSection({
  cwd,
  snapshot,
  loadError,
  loading = false,
  reload,
  onChanged,
  providerId,
  provider,
  embedded = false,
}: {
  cwd: string;
  snapshot?: LinkSnapshot;
  loadError: string;
  loading?: boolean;
  reload: () => Promise<void>;
  onChanged: () => void;
  providerId: string;
  provider?: LinkProviderView;
  embedded?: boolean;
}) {
  const { t, lang } = useT();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const [managing, setManaging] = React.useState(false);
  const [rename, setRename] = React.useState<string>();
  const [newName, setNewName] = React.useState("");
  const [disconnect, setDisconnect] = React.useState<string>();
  const [authorization, setAuthorization] = React.useState<{
    connection?: MaskedLinkConnection;
    resourceUrl?: string;
  }>();
  const [addingFile, setAddingFile] = React.useState<MaskedLinkConnection>();
  const [fileUrl, setFileUrl] = React.useState("");
  const providerName = provider?.displayName ?? providerId;
  const Icon = provider?.icon === "github" ? Github : provider?.icon === "figma" ? Figma : Cable;
  const modes = provider?.authModes?.filter((mode) => mode.id === "remote-link") ?? [];
  const alive = React.useRef(false);
  const api = window.codeshell.links;
  React.useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, [cwd, api]);

  const operation = async (run: () => Promise<void>) => {
    if (busy || authorization) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await run();
    } catch (cause) {
      if (alive.current) setError(linkError(cause));
    } finally {
      if (alive.current) {
        await reload();
        if (alive.current) {
          setBusy(false);
          onChanged();
        }
      }
    }
  };
  const start = (connection?: MaskedLinkConnection, resourceUrl?: string) => {
    setManaging(false);
    setAuthorization({ connection, resourceUrl });
  };
  const addFile = (connection: MaskedLinkConnection) => {
    setFileUrl("");
    setAddingFile(connection);
  };
  const connections =
    snapshot?.connections.filter(
      (item) => item.authSource === "remote-link" && item.providerId === providerId,
    ) ?? [];
  const connected = connections.filter((item) => item.status === "connected");
  const editableConnected = connected.filter((item) => item.editable);
  const available = modes.some((mode) => mode.available);
  const primary = useLinkPrimaryAction("remote-link", {
    onClick: () => start(),
    disabled: busy || Boolean(authorization) || !available,
  });
  const presentation = React.useContext(LinkPresentationContext);
  const showTechnical = !primary || presentation?.advanced;
  const inline = embedded || primary;
  const failed = error || loadError;
  const catalogState = snapshot?.remoteCatalog?.state;
  const unavailableHint = loading
    ? t("ext.link.loadingConnections")
    : catalogState === "unconfigured"
      ? t("ext.link.remoteUnconfigured")
      : catalogState === "unavailable" || catalogState === "stale"
        ? t("ext.link.directory.catalogUnavailable")
        : t("ext.link.directory.unavailableHint");
  const Management = inline ? InlineManagement : Dialog;
  const ManagementContent = inline ? "div" : DialogContent;
  const feedback = (
    <>
      {failed && (
        <p role="alert" className="text-xs text-status-err break-words">
          {failed}
        </p>
      )}
      {notice && (
        <p role="status" className="text-xs text-muted-foreground">
          {notice}
        </p>
      )}
      {!!snapshot?.remoteCleanupPending && (
        <p role="status" className="text-xs text-muted-foreground">
          {t("ext.link.remoteCleanupPending")}
        </p>
      )}
    </>
  );
  return (
    <div className="space-y-3">
      <LinkConnectionRow
        hidden={Boolean(
          primary &&
          available &&
          !failed &&
          !notice &&
          !snapshot?.remoteCleanupPending &&
          !(
            providerId === "figma" &&
            connected.length > 0 &&
            connected.every((item) => !item.account?.resources.length)
          ),
        )}
        data-link-method-provider={providerId}
        data-link-runtime="server"
        title={
          primary
            ? t("ext.link.directory.manageConnection")
            : providerId === "figma"
              ? t("ext.link.directory.basicReading")
              : t("ext.link.directory.browserConnection")
        }
        technical={!primary && providerId === "figma" ? "API" : undefined}
        description={
          primary
            ? undefined
            : providerId === "figma"
              ? t("ext.link.directory.basicReadingDescription")
              : provider?.description[lang]
        }
      >
        {!primary && (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              {connected.length > 0 ? (
                <>
                  <span className="inline-flex items-center gap-1 text-xs text-status-ok">
                    <Check className="size-3.5" aria-hidden />
                    {t("ext.link.remoteAvailable")}
                  </span>
                  {providerId === "figma" && editableConnected.length > 0 && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || !available}
                      onClick={() =>
                        editableConnected.length === 1
                          ? addFile(editableConnected[0]!)
                          : setManaging(true)
                      }
                    >
                      {t("ext.link.remoteAddFile")}
                    </Button>
                  )}
                  {!inline && (
                    <Button size="sm" variant="outline" onClick={() => setManaging(true)}>
                      <Settings2 className="size-3.5" aria-hidden />
                      {t("ext.link.remoteManage")}
                    </Button>
                  )}
                </>
              ) : connections.length > 0 ? (
                <Button
                  size="sm"
                  variant="outline"
                  hidden={inline}
                  onClick={() => setManaging(true)}
                >
                  {t(
                    connections.some((connection) => connection.status === "unavailable")
                      ? "ext.link.directory.serviceUnavailable"
                      : "ext.link.remoteReconnectNeeded",
                  )}
                </Button>
              ) : (
                <Button
                  size="sm"
                  disabled={busy || loading || (!available && !loadError)}
                  onClick={() => (loadError ? void reload() : start())}
                >
                  {t(
                    loading
                      ? "ext.link.directory.checking"
                      : loadError
                        ? "ext.link.retry"
                        : busy
                          ? "ext.link.remoteConnecting"
                          : "ext.link.remoteConnect",
                  )}
                </Button>
              )}
            </div>
          </div>
        )}
        {!primary && connected.length > 0 && (
          <p className="mt-3 truncate text-xs text-muted-foreground">
            {[...new Set(connected.map((item) => item.account?.label ?? item.label))].join(" · ")}
          </p>
        )}
        {providerId === "figma" &&
          connected.length > 0 &&
          connected.every((item) => !item.account?.resources.length) && (
            <p className="mt-2 text-xs text-muted-foreground">{t("ext.link.remoteNoFiles")}</p>
          )}
        {!available && connections.length > 0 && (
          <p className="mt-3 text-xs text-muted-foreground">{unavailableHint}</p>
        )}
        {!managing && <div className="mt-2 space-y-2">{feedback}</div>}
      </LinkConnectionRow>
      <Management open={managing} onOpenChange={setManaging}>
        <ManagementContent
          className={
            inline ? "space-y-3 py-4" : "max-h-[85vh] max-w-md overflow-y-auto rounded-2xl"
          }
        >
          {!inline && (
            <DialogHeader>
              <DialogTitle>
                {t("ext.link.authorizationManageTitle", { name: providerName })}
              </DialogTitle>
              <DialogDescription>
                {providerId === "github"
                  ? t("ext.link.remoteDescription")
                  : provider?.description[lang]}
              </DialogDescription>
            </DialogHeader>
          )}
          {feedback}
          {connections.map((connection) => (
            <article
              key={connection.id}
              data-remote-link={connection.id}
              className={
                inline
                  ? "space-y-3 border-b border-border/60 pb-4 last:border-b-0"
                  : "space-y-3 rounded-xl border border-border/70 p-3"
              }
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <strong className="block truncate text-sm">{connection.label}</strong>
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {connection.account?.label ?? providerName}
                  </p>
                </div>
                <span className="text-xs text-muted-foreground">
                  {t(
                    connection.status === "unavailable"
                      ? "ext.link.directory.serviceUnavailable"
                      : connection.status === "connected"
                        ? "ext.link.remoteAvailable"
                        : "ext.link.remoteReconnectNeeded",
                  )}
                </span>
              </div>
              {!!connection.account?.resources.length && (
                <p className="break-words text-xs text-muted-foreground">
                  {connection.account.resources.join(" · ")}
                </p>
              )}
              {rename === connection.id && (
                <form
                  className="flex gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!newName.trim()) return;
                    void operation(async () => {
                      await api.remoteRename(
                        cwd,
                        connection.id,
                        newName.trim(),
                        connection.revision,
                      );
                      if (alive.current) setRename(undefined);
                    });
                  }}
                >
                  <Input
                    aria-label={t("ext.link.remoteNewName")}
                    value={newName}
                    onChange={(event) => setNewName(event.target.value)}
                    maxLength={100}
                    disabled={busy}
                  />
                  <Button size="sm" disabled={busy || !newName.trim()}>
                    {t("ext.link.remoteSaveName")}
                  </Button>
                </form>
              )}
              {connection.editable ? (
                <div className="flex flex-wrap gap-1">
                  {providerId === "figma" && connection.status === "connected" && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy || !available}
                      onClick={() => addFile(connection)}
                    >
                      {t("ext.link.remoteAddFile")}
                    </Button>
                  )}
                  {(!primary || connection.status !== "connected") && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy || !available}
                      onClick={() => start(connection)}
                    >
                      {t("ext.link.remoteReconnect")}
                    </Button>
                  )}
                  <LinkAccountMenu label={t("ext.link.directory.accountActions")}>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        setRename(connection.id);
                        setNewName(connection.label);
                      }}
                    >
                      {t("ext.link.remoteRename")}
                    </Button>
                    {primary && connection.status === "connected" && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy || !available}
                        onClick={() => start(connection)}
                      >
                        {t("ext.link.remoteReconnect")}
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy || !available}
                      onClick={() => start()}
                    >
                      {t("ext.link.remoteAdd")}
                    </Button>
                    {disconnect !== connection.id && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => setDisconnect(connection.id)}
                      >
                        {t("ext.link.remoteDisconnect")}
                      </Button>
                    )}
                  </LinkAccountMenu>
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
                  ) : null}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">{t("ext.link.remoteReadOnly")}</p>
              )}
            </article>
          ))}
          {connections.length === 0 ? (
            !primary && (
              <Button variant="outline" disabled={busy || !available} onClick={() => start()}>
                {t("ext.link.remoteAdd")}
              </Button>
            )
          ) : !connections.some((connection) => connection.editable) ? (
            <LinkAccountMenu label={t("ext.link.directory.accountActions")}>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy || !available}
                onClick={() => start()}
              >
                {t("ext.link.remoteAdd")}
              </Button>
            </LinkAccountMenu>
          ) : null}
          {snapshot?.remoteServer && (
            <details hidden={!showTechnical} className="text-xs text-muted-foreground">
              <summary className="cursor-pointer">{t("ext.link.remoteServiceDetails")}</summary>
              <p className="mt-2 break-all">{snapshot.remoteServer.issuer}</p>
            </details>
          )}
        </ManagementContent>
      </Management>
      <Dialog open={Boolean(addingFile)} onOpenChange={(open) => !open && setAddingFile(undefined)}>
        <DialogContent className="max-w-md rounded-2xl">
          <DialogHeader>
            <DialogTitle>{t("ext.link.remoteAddFileTitle")}</DialogTitle>
            <DialogDescription>{t("ext.link.remoteAddFileDescription")}</DialogDescription>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (!addingFile || !fileUrl.trim()) return;
              const connection = addingFile;
              setAddingFile(undefined);
              start(connection, fileUrl.trim());
            }}
          >
            <Input
              aria-label={t("ext.link.remoteFileUrl")}
              placeholder="https://www.figma.com/design/…"
              value={fileUrl}
              onChange={(event) => setFileUrl(event.target.value)}
              maxLength={1_000}
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setAddingFile(undefined)}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={!fileUrl.trim()}>
                {t("ext.link.remoteConfirmFile")}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      {authorization && (
        <LinkConnectionDialog
          key={`${cwd}:${providerId}:${authorization.connection?.id ?? "new"}`}
          cwd={cwd}
          providerName={providerName}
          icon={Icon}
          input={{
            providerId,
            methodId: modes[0]?.methodId ?? "remote-link",
            label: authorization.connection?.label ?? providerName,
            ...(authorization.connection ? { connectionId: authorization.connection.id } : {}),
            expectedRevision: authorization.connection?.revision ?? null,
            ...(authorization.resourceUrl ? { resourceUrl: authorization.resourceUrl } : {}),
          }}
          modes={modes}
          onClose={() => setAuthorization(undefined)}
          onConnected={() => {
            void reload();
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function InlineManagement({
  children,
}: {
  children: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return <>{children}</>;
}
