import React from "react";
import { Figma, Loader2, ShieldCheck } from "lucide-react";
import type { MaskedLinkConnection } from "@cjhyy/code-shell-link";
import { Button } from "@/components/ui/button";
import { LinkConnectionDialog } from "../credentials/LinkConnectionDialog";
import { useRemoteLinkSnapshot } from "../credentials/RemoteLinkSection";
import { useT } from "../i18n/I18nProvider";
import {
  chatLinkReadArguments,
  figmaFileGranted,
  type ChatLinkReadHandler,
  type ChatLinkResourceIntent,
} from "./linkResourceIntents";

export type { ChatLinkReadHandler } from "./linkResourceIntents";

export function ChatLinkResources({
  intents,
  busy,
  onRead,
}: {
  intents: ChatLinkResourceIntent[];
  busy: boolean;
  onRead: ChatLinkReadHandler;
}) {
  return (
    <div className="mx-4 my-2 space-y-2" data-chat-link-resources>
      {intents.map((intent) => (
        <ChatLinkResourceCard
          key={`${intent.clientMessageId}:${intent.resourceId}`}
          intent={intent}
          busy={busy}
          onRead={onRead}
        />
      ))}
    </div>
  );
}

/** Mounting and refreshing this card are read-only. Only a click mounts an authorization. */
function ChatLinkResourceCard({
  intent,
  busy,
  onRead,
}: {
  intent: ChatLinkResourceIntent;
  busy: boolean;
  onRead: ChatLinkReadHandler;
}) {
  const { t } = useT();
  const { snapshot, error: loadError, reload } = useRemoteLinkSnapshot(intent.cwd);
  const [selectedId, setSelectedId] = React.useState("");
  const [authorization, setAuthorization] = React.useState<{
    id: string;
    connection?: MaskedLinkConnection;
    resourceUrl?: string;
  }>();
  const authorizationRef = React.useRef(authorization);
  authorizationRef.current = authorization;
  const [checking, setChecking] = React.useState(false);
  const [error, setError] = React.useState("");
  const [sent, setSent] = React.useState(false);
  const alive = React.useRef(false);
  const checkingRef = React.useRef(false);
  const sentRef = React.useRef(false);
  const current = React.useRef({ busy, onRead });
  current.current = { busy, onRead };
  React.useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      authorizationRef.current = undefined;
    };
  }, []);
  const connections =
    snapshot?.connections.filter(
      (connection) => connection.providerId === "figma" && connection.authSource === "remote-link",
    ) ?? [];
  const selected = selectedId
    ? connections.find((connection) => connection.id === selectedId)
    : connections.length === 1
      ? connections[0]
      : undefined;
  const provider = snapshot?.providers.find((item) => item.id === "figma");
  const modes = provider?.authModes?.filter((mode) => mode.id === "remote-link") ?? [];
  const available = modes.some((mode) => mode.available);
  const granted = figmaFileGranted(selected, intent.resourceId);

  const act = async () => {
    if (checkingRef.current || sentRef.current || authorizationRef.current || current.current.busy)
      return;
    checkingRef.current = true;
    setChecking(true);
    setError("");
    try {
      // Capture what the user reviewed, then check that exact account/revision. Never fall back.
      const reviewed = selected;
      const fresh = await window.codeshell.links.remoteSnapshot(intent.cwd);
      if (!alive.current || current.current.busy) return;
      const live = reviewed ? fresh.connections.find((item) => item.id === reviewed.id) : undefined;
      if (
        reviewed &&
        (!live ||
          live.revision !== reviewed.revision ||
          live.account?.id !== reviewed.account?.id ||
          figmaFileGranted(live, intent.resourceId) !==
            figmaFileGranted(reviewed, intent.resourceId))
      ) {
        await reload();
        if (alive.current) setError(t("chat.linkResource.changed"));
        return;
      }
      if (!reviewed && connections.length > 0) return;
      const liveModes =
        fresh.providers
          .find((item) => item.id === "figma")
          ?.authModes?.filter((mode) => mode.id === "remote-link") ?? [];
      if (figmaFileGranted(live, intent.resourceId)) {
        if (sentRef.current) return;
        // Consume synchronously before calling the owner, including a repeated click in one frame.
        sentRef.current = true;
        const accepted = current.current.onRead(
          t("chat.linkResource.readPrompt", {
            arguments: JSON.stringify(chatLinkReadArguments(intent, live!.id)),
          }),
          intent.bucket,
          crypto.randomUUID(),
          intent.cwd,
        );
        setSent(accepted);
        if (!accepted) {
          sentRef.current = false;
          setError(t("chat.linkResource.sessionChanged"));
        }
        return;
      }
      if (!liveModes.some((mode) => mode.available) || (live && !live.editable)) {
        setError(t("chat.linkResource.unavailable"));
        return;
      }
      // If an account appeared while the user reviewed “connect”, require explicit selection.
      if (
        !reviewed &&
        fresh.connections.some(
          (item) => item.providerId === "figma" && item.authSource === "remote-link",
        )
      ) {
        await reload();
        if (alive.current) setError(t("chat.linkResource.changed"));
        return;
      }
      const next = {
        id: crypto.randomUUID(),
        connection: live,
        ...(live ? { resourceUrl: intent.url } : {}),
      };
      authorizationRef.current = next;
      setAuthorization(next);
    } catch (cause) {
      if (alive.current)
        setError(
          cause instanceof Error
            ? cause.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "")
            : String(cause),
        );
    } finally {
      checkingRef.current = false;
      if (alive.current) setChecking(false);
    }
  };

  return (
    <article
      className="space-y-3 rounded-xl border border-border/70 bg-card p-3"
      data-chat-link-resource={intent.resourceId}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <Figma className="mt-0.5 size-4 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium">{t("chat.linkResource.title")}</p>
          <p className="mt-1 break-all text-xs text-muted-foreground">{intent.url}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t(granted ? "chat.linkResource.granted" : "chat.linkResource.description")}
          </p>
        </div>
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      </div>
      {connections.length > 1 || (selectedId && !selected) ? (
        <label className="flex flex-col gap-1 text-xs">
          {t("chat.linkResource.account")}
          <select
            className="h-8 min-w-0 rounded-md border border-input bg-background px-2"
            value={selected?.id ?? ""}
            disabled={checking || Boolean(authorization) || sent}
            onChange={(event) => {
              setSelectedId(event.target.value);
              setError("");
            }}
          >
            <option value="">{t("chat.linkResource.chooseAccount")}</option>
            {connections.map((connection) => (
              <option key={connection.id} value={connection.id}>
                {connection.label} ·{" "}
                {connection.account?.label ?? connection.account?.id ?? "Figma"}
              </option>
            ))}
          </select>
        </label>
      ) : selected ? (
        <p className="break-words text-xs text-muted-foreground">
          {selected.label} · {selected.account?.label ?? selected.account?.id ?? "Figma"}
        </p>
      ) : null}
      {(error || loadError) && (
        <p role="alert" className="break-words text-xs text-status-err">
          {error || loadError}
        </p>
      )}
      {loadError || (!available && !granted) ? (
        <Button size="sm" variant="outline" onClick={() => void reload()}>
          {t("ext.link.retry")}
        </Button>
      ) : (
        <Button
          size="sm"
          variant="outline"
          disabled={
            !snapshot ||
            busy ||
            checking ||
            sent ||
            Boolean(authorization) ||
            (connections.length > 0 && !selected) ||
            (!granted && selected?.editable === false)
          }
          onClick={() => void act()}
        >
          {checking && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
          {t(
            sent
              ? "chat.linkResource.sent"
              : granted
                ? "chat.linkResource.read"
                : selected
                  ? "chat.linkResource.authorize"
                  : "chat.linkResource.connect",
          )}
        </Button>
      )}
      {authorization && (
        <LinkConnectionDialog
          key={authorization.id}
          cwd={intent.cwd}
          providerName="Figma"
          icon={Figma}
          modes={modes}
          input={{
            providerId: "figma",
            methodId: "remote-link",
            label: authorization.connection?.label ?? "Figma",
            connectionId: authorization.connection?.id,
            expectedRevision: authorization.connection?.revision ?? null,
            resourceUrl: authorization.resourceUrl,
          }}
          onClose={() => {
            authorizationRef.current = undefined;
            setAuthorization(undefined);
            void reload();
          }}
          onConnected={(connection) => {
            if (!alive.current || authorizationRef.current?.id !== authorization.id) return;
            authorizationRef.current = undefined;
            setAuthorization(undefined);
            if (connection) setSelectedId(connection.id);
            void reload();
          }}
        />
      )}
    </article>
  );
}
