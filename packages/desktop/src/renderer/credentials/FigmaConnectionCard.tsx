import React from "react";
import { Figma, Loader2 } from "lucide-react";
import type { LinkSnapshot, MaskedLinkConnection } from "@cjhyy/code-shell-link";
import { Button } from "@/components/ui/button";
import { useT } from "../i18n/I18nProvider";
import { LinkConnectionDialog } from "./LinkConnectionDialog";
import { RemoteProviderSection } from "./RemoteLinkSection";

/** Figma owns both channels. Connecting either channel never reads a design. */
export function FigmaConnectionCard({
  cwd,
  snapshot,
  loadError,
  reload,
  onChanged,
  localApi,
}: {
  cwd: string;
  snapshot?: LinkSnapshot;
  loadError: string;
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
      if (alive.current) {
        await reload();
        if (alive.current) {
          setBusy(false);
          onChanged();
        }
      }
      locked.current = false;
    }
  };
  const connect = (connection?: MaskedLinkConnection) =>
    void run(connection, async (live) => {
      if (alive.current) setAuthorization({ id: crypto.randomUUID(), connection: live });
    });

  return (
    <section
      data-link-integration="figma"
      className="space-y-4 rounded-2xl border border-border/70 bg-card p-4"
    >
      <div className="flex items-start gap-3">
        <Figma className="mt-1 size-5 shrink-0" aria-hidden />
        <div>
          <h4 className="text-sm font-semibold">Figma</h4>
          <p className="mt-1 text-xs text-muted-foreground">{t("ext.link.figma.description")}</p>
        </div>
      </div>
      <div data-figma-channel="api" className="space-y-3 rounded-xl border border-border/60 p-3">
        {!hasRemoteApi && <h5 className="text-sm font-medium">{t("ext.link.figma.apiTitle")}</h5>}
        {hasRemoteApi && (
          <RemoteProviderSection
            cwd={cwd}
            snapshot={snapshot}
            loadError={loadError}
            reload={reload}
            onChanged={onChanged}
            providerId="figma"
            provider={provider}
            embedded
          />
        )}
        {localApi && (
          <details>
            <summary className="cursor-pointer text-xs text-muted-foreground">
              {t("ext.link.figma.localApi")}
            </summary>
            <div className="mt-3 space-y-3">{localApi}</div>
          </details>
        )}
      </div>
      <div data-figma-channel="mcp" className="space-y-3 rounded-xl border border-border/60 p-3">
        <div>
          <h5 className="text-sm font-medium">{t("ext.link.figma.mcpTitle")}</h5>
          <p className="mt-1 text-xs text-muted-foreground">{t("ext.link.figma.mcpDescription")}</p>
        </div>
        {connections.map((connection) => (
          <div
            key={connection.id}
            data-figma-mcp-connection={connection.id}
            className="space-y-2 text-xs"
          >
            <p>
              {connection.account?.label ?? connection.label} ·{" "}
              {t(
                connection.status === "connected"
                  ? "ext.link.remoteAvailable"
                  : "ext.link.remoteReconnectNeeded",
              )}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !available || !connection.editable || Boolean(authorization)}
                onClick={() => connect(connection)}
              >
                {t("ext.link.remoteReconnect")}
              </Button>
              <Button
                size="sm"
                variant="outline"
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
                disabled={busy || !connection.editable || Boolean(authorization)}
                onClick={() =>
                  void run(connection, async (live) => {
                    await window.codeshell.links.remoteDisconnect(cwd, live!.id, live!.revision);
                  })
                }
              >
                {t("ext.link.remoteDisconnect")}
              </Button>
            </div>
          </div>
        ))}
        {connections.length === 0 && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !available || Boolean(authorization)}
            onClick={() => connect()}
          >
            {busy && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
            {t("ext.link.figma.connectMcp")}
          </Button>
        )}
        {!available && (
          <p className="text-xs text-muted-foreground">{t("ext.link.figma.unavailable")}</p>
        )}
        {(error || loadError) && (
          <p role="alert" className="text-xs text-status-err">
            {error || loadError}
          </p>
        )}
      </div>
      {authorization && (
        <LinkConnectionDialog
          key={authorization.id}
          cwd={cwd}
          providerName="Figma"
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
    </section>
  );
}
