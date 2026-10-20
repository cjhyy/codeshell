import React from "react";
import { Figma, Loader2 } from "lucide-react";
import type { LinkSnapshot, MaskedLinkConnection } from "@cjhyy/code-shell-link";
import { Button } from "@/components/ui/button";
import { useT } from "../i18n/I18nProvider";
import { captureLinkAuthorizationReturnFocus, LinkConnectionDialog } from "./LinkConnectionDialog";
import { RemoteProviderSection } from "./RemoteLinkSection";
import { LinkConnectionRow, LinkStatus } from "./LinkProviderCard";
import { LinkAccountMenu, LinkConnectionOption, useLinkPrimaryAction } from "./LinkPresentation";

/** Figma owns both channels. Connecting either channel never reads a design. */
export function FigmaConnectionCard({
  cwd,
  snapshot,
  loadError,
  loading = false,
  reload,
  onChanged,
  localApi,
}: {
  cwd: string;
  snapshot?: LinkSnapshot;
  loadError: string;
  loading?: boolean;
  reload: () => Promise<void>;
  onChanged: () => void;
  localApi?: React.ReactNode;
}) {
  const { t } = useT();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [authorization, setAuthorization] = React.useState<{
    id: string;
    connection?: MaskedLinkConnection;
    opener: HTMLElement | null;
  }>();
  const locked = React.useRef(false);
  const alive = React.useRef(false);
  React.useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const provider = snapshot?.providers.find((item) => item.id === "figma");
  const hasRemoteApi = Boolean(
    provider?.authModes?.some((mode) => mode.id === "remote-link") ||
    snapshot?.connections.some(
      (item) => item.providerId === "figma" && item.authSource === "remote-link",
    ),
  );
  const modes = provider?.authModes?.filter((mode) => mode.id === "mcp-oauth") ?? [];
  const available = modes.some((mode) => mode.available);
  const connections =
    snapshot?.connections.filter(
      (item) => item.providerId === "figma" && item.authSource === "mcp-oauth",
    ) ?? [];

  const run = async (
    connection: MaskedLinkConnection | undefined,
    operation: (live?: MaskedLinkConnection) => Promise<void>,
  ) => {
    if (locked.current || authorization) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      const fresh = await window.codeshell.links.remoteSnapshot(cwd);
      if (!alive.current) return;
      const live = connection
        ? fresh.connections.find((item) => item.id === connection.id)
        : undefined;
      if (
        connection
          ? !live ||
            live.providerId !== "figma" ||
            live.authSource !== "mcp-oauth" ||
            live.revision !== connection.revision ||
            live.account?.id !== connection.account?.id
          : fresh.connections.some(
              (item) => item.providerId === "figma" && item.authSource === "mcp-oauth",
            )
      )
        throw new Error(t("chat.linkResource.changed"));
      await operation(live);
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      try {
        // Keep the directory current even if a submitted write outlives its dialog.
        await reload();
      } finally {
        if (alive.current) setBusy(false);
        onChanged();
        locked.current = false;
      }
    }
  };
  const connect = (connection?: MaskedLinkConnection) => {
    const opener = captureLinkAuthorizationReturnFocus();
    void run(connection, async (live) => {
      if (alive.current) setAuthorization({ id: crypto.randomUUID(), connection: live, opener });
    });
  };
  const primary = useLinkPrimaryAction("mcp-oauth", {
    onClick: () => connect(),
    disabled: busy || !available || Boolean(authorization) || connections.length > 0,
  });

  return (
    <>
      {hasRemoteApi && (
        <LinkConnectionOption optionId="remote-link">
          <div data-figma-channel="api">
            <RemoteProviderSection
              cwd={cwd}
              snapshot={snapshot}
              loadError={loadError}
              loading={loading}
              reload={reload}
              onChanged={onChanged}
              providerId="figma"
              provider={provider}
              embedded
            />
          </div>
        </LinkConnectionOption>
      )}
      {localApi}
      <LinkConnectionOption optionId="mcp-oauth">
        <LinkConnectionRow
          data-figma-channel="mcp"
          title={t("ext.link.directory.designContext")}
          technical={primary ? undefined : "MCP"}
          description={t("ext.link.directory.designContextDescription")}
          status={
            primary
              ? undefined
              : connections.some((connection) => connection.status === "connected")
                ? t("ext.link.remoteAvailable")
                : connections.length
                  ? t("ext.link.remoteReconnectNeeded")
                  : loading
                    ? t("ext.link.directory.checking")
                    : !available
                      ? t("ext.link.directory.unavailable")
                      : t("ext.link.directory.notConnected")
          }
          tone={
            connections.some((connection) => connection.status === "connected")
              ? "ready"
              : connections.length
                ? "warning"
                : "neutral"
          }
        >
          {connections.map((connection) => (
            <div
              key={connection.id}
              data-figma-mcp-connection={connection.id}
              className="space-y-2 text-xs"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <strong className="block truncate text-sm font-medium">
                    {primary ? (connection.account?.label ?? connection.label) : connection.label}
                  </strong>
                  {!primary && (
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      {connection.account?.label ?? "Figma"}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <LinkStatus tone={connection.status === "connected" ? "ready" : "warning"}>
                    {t(
                      connection.status === "unavailable"
                        ? "ext.link.directory.serviceUnavailable"
                        : connection.status === "connected"
                          ? "ext.link.remoteAvailable"
                          : "ext.link.remoteReconnectNeeded",
                    )}
                  </LinkStatus>
                  <LinkAccountMenu>
                    {connection.status === "connected" && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="w-full justify-start"
                        disabled={
                          busy || !available || !connection.editable || Boolean(authorization)
                        }
                        onClick={() => connect(connection)}
                      >
                        {t("ext.link.remoteReconnect")}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="w-full justify-start"
                      disabled={busy || !connection.editable || Boolean(authorization)}
                      onClick={() =>
                        void run(connection, async (live) => {
                          await window.codeshell.mcpOAuth.refresh(live!.id);
                        })
                      }
                    >
                      {t("ext.link.figma.refresh")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="w-full justify-start"
                      disabled={busy || !connection.editable || Boolean(authorization)}
                      onClick={() =>
                        void run(connection, async (live) => {
                          await window.codeshell.links.remoteDisconnect(
                            cwd,
                            live!.id,
                            live!.revision,
                          );
                        })
                      }
                    >
                      {t("ext.link.remoteDisconnect")}
                    </Button>
                  </LinkAccountMenu>
                </div>
              </div>
              {connection.status !== "connected" && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || !available || !connection.editable || Boolean(authorization)}
                  onClick={() => connect(connection)}
                >
                  {t("ext.link.remoteReconnect")}
                </Button>
              )}
            </div>
          ))}
          {connections.length === 0 && !primary && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !available || Boolean(authorization)}
              onClick={() => connect()}
            >
              {busy && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
              {t("ext.link.directory.connectDesignContext")}
            </Button>
          )}
          {!available && (
            <p className="text-xs text-muted-foreground">
              {t(loading ? "ext.link.loadingConnections" : "ext.link.directory.unavailableHint")}
            </p>
          )}
          {(error || loadError) && (
            <p role="alert" className="text-xs text-status-err">
              {error || loadError}
            </p>
          )}
        </LinkConnectionRow>
      </LinkConnectionOption>
      {authorization && (
        <LinkConnectionDialog
          key={authorization.id}
          cwd={cwd}
          providerName="Figma"
          opener={authorization.opener}
          icon={Figma}
          modes={modes}
          input={{
            providerId: "figma",
            methodId: "mcp",
            label: authorization.connection?.label ?? "Figma MCP",
            connectionId: authorization.connection?.id,
            expectedRevision: authorization.connection?.revision ?? null,
          }}
          onClose={() => {
            setAuthorization(undefined);
            void reload();
          }}
          onConnected={() => {
            if (!alive.current) return;
            setAuthorization(undefined);
            void reload();
            onChanged();
          }}
        />
      )}
    </>
  );
}
