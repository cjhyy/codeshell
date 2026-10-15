import React from "react";
import { Figma, Loader2, ShieldCheck, X } from "lucide-react";
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
  onConsumed,
  onResumeConnectionChange,
  readFailed,
  readBusy,
}: {
  intents: ChatLinkResourceIntent[];
  busy: boolean;
  onRead: ChatLinkReadHandler;
  onConsumed: (intent: ChatLinkResourceIntent) => void;
  onResumeConnectionChange: (
    intent: ChatLinkResourceIntent,
    connection: MaskedLinkConnection | undefined,
  ) => void;
  readFailed: (intent: ChatLinkResourceIntent) => boolean;
  readBusy: (intent: ChatLinkResourceIntent) => boolean;
}) {
  return (
    <div className="space-y-2" data-chat-link-resources>
      {intents.map((intent) => (
        <ChatLinkResourceCard
          key={`${intent.clientMessageId}:${intent.resourceId}`}
          intent={intent}
          busy={busy || readBusy(intent)}
          onRead={onRead}
          onConsumed={onConsumed}
          onResumeConnectionChange={onResumeConnectionChange}
          readFailed={readFailed(intent)}
        />
      ))}
    </div>
  );
}

/** Mounting and refreshing are read-only. Account and file consent stay explicit. */
function ChatLinkResourceCard({
  intent,
  busy,
  onRead,
  onConsumed,
  onResumeConnectionChange,
  readFailed,
}: {
  intent: ChatLinkResourceIntent;
  busy: boolean;
  onRead: ChatLinkReadHandler;
  onConsumed: (intent: ChatLinkResourceIntent) => void;
  onResumeConnectionChange: (
    intent: ChatLinkResourceIntent,
    connection: MaskedLinkConnection | undefined,
  ) => void;
  readFailed: boolean;
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
  const alive = React.useRef(false);
  const dismissedRef = React.useRef(false);
  const checkingRef = React.useRef(false);
  const sentRef = React.useRef(false);
  const current = React.useRef({ busy, onRead, onConsumed, onResumeConnectionChange });
  current.current = { busy, onRead, onConsumed, onResumeConnectionChange };
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

  const act = async (resumeConnection?: MaskedLinkConnection) => {
    if (
      dismissedRef.current ||
      checkingRef.current ||
      sentRef.current ||
      authorizationRef.current ||
      current.current.busy
    )
      return;
    checkingRef.current = true;
    setChecking(true);
    setError("");
    try {
      // Capture what the user reviewed, then check that exact account/revision. Never fall back.
      const reviewed = resumeConnection ?? selected;
      const fresh = await window.codeshell.links.remoteSnapshot(intent.cwd);
      if (!alive.current || dismissedRef.current || current.current.busy) return;
      const live = reviewed ? fresh.connections.find((item) => item.id === reviewed.id) : undefined;
      const freshConnections = fresh.connections.filter(
        (item) => item.providerId === "figma" && item.authSource === "remote-link",
      );
      if (
        reviewed &&
        (!live ||
          (!selectedId && connections.length === 1 && freshConnections.length !== 1) ||
          live.revision !== reviewed.revision ||
          live.account?.id !== reviewed.account?.id ||
          figmaFileGranted(live, intent.resourceId) !==
            figmaFileGranted(reviewed, intent.resourceId))
      ) {
        await reload();
        if (alive.current && !dismissedRef.current) {
          if (resumeConnection) current.current.onResumeConnectionChange(intent, undefined);
          setError(t("chat.linkResource.changed"));
        }
        return;
      }
      if (!reviewed && connections.length > 0) return;
      const liveModes =
        fresh.providers
          .find((item) => item.id === "figma")
          ?.authModes?.filter((mode) => mode.id === "remote-link") ?? [];
      if (figmaFileGranted(live, intent.resourceId)) {
        if (dismissedRef.current || sentRef.current) return;
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
        if (accepted) current.current.onConsumed(intent);
        else {
          sentRef.current = false;
          if (resumeConnection) current.current.onResumeConnectionChange(intent, undefined);
          setError(t("chat.linkResource.sessionChanged"));
        }
        return;
      }
      // A completed authorization resumes only its exact granted file. Revocation
      // never silently launches another authorization attempt.
      if (resumeConnection) {
        current.current.onResumeConnectionChange(intent, undefined);
        setError(t("chat.linkResource.changed"));
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
        if (alive.current && !dismissedRef.current) setError(t("chat.linkResource.changed"));
        return;
      }
      const next = {
        id: crypto.randomUUID(),
        connection: live,
        resourceUrl: intent.url,
      };
      authorizationRef.current = next;
      setAuthorization(next);
    } catch (cause) {
      if (alive.current && !dismissedRef.current) {
        sentRef.current = false;
        if (resumeConnection) current.current.onResumeConnectionChange(intent, undefined);
        setError(
          cause instanceof Error
            ? cause.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "")
            : String(cause),
        );
      }
    } finally {
      checkingRef.current = false;
      if (alive.current && !dismissedRef.current) setChecking(false);
    }
  };
  const actRef = React.useRef(act);
  actRef.current = act;
  React.useEffect(() => {
    // The original model turn already has the URL. Never start a competing read
    // while it runs; a successful LinkAction removes the intent in the owner.
    if (intent.resumeConnection && !busy && !checking) void actRef.current(intent.resumeConnection);
  }, [intent.resumeConnection, busy, checking]);

  // Already granted links belong to the original request. Keep the retry UI for
  // actual failures and explicit account choices, without a second model turn.
  if (
    (!snapshot && !loadError) ||
    (granted &&
      !selectedId &&
      !intent.resumeConnection &&
      !readFailed &&
      !error &&
      !loadError &&
      !authorization)
  )
    return null;

  return (
    <article
      className="mx-4 my-2 space-y-3 rounded-xl border border-border/70 bg-card p-3"
      data-chat-link-resource={intent.resourceId}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <Figma className="mt-0.5 size-4 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium">{t("chat.linkResource.title")}</p>
          <p className="mt-1 break-all text-xs text-muted-foreground">{intent.url}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t(
              intent.resumeConnection
                ? "chat.linkResource.waiting"
                : readFailed
                  ? "chat.linkResource.readFailed"
                  : granted
                    ? "chat.linkResource.granted"
                    : "chat.linkResource.description",
            )}
          </p>
        </div>
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-6 shrink-0"
          aria-label={t("chat.linkResource.dismiss")}
          title={t("chat.linkResource.dismiss")}
          onClick={() => {
            // Cancellation takes effect within this event, before React removes
            // the card or an already-resolved snapshot resumes its async check.
            dismissedRef.current = true;
            current.current.onConsumed(intent);
          }}
        >
          <X className="size-3.5" aria-hidden />
        </Button>
      </div>
      {connections.length > 1 || (selectedId && !selected) ? (
        <label className="flex flex-col gap-1 text-xs">
          {t("chat.linkResource.account")}
          <select
            className="h-8 min-w-0 rounded-md border border-input bg-background px-2"
            value={selected?.id ?? ""}
            disabled={checking || Boolean(authorization) || Boolean(intent.resumeConnection)}
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
            Boolean(intent.resumeConnection) ||
            Boolean(authorization) ||
            (connections.length > 0 && !selected) ||
            (!granted && selected?.editable === false)
          }
          onClick={() => void act()}
        >
          {checking && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
          {t(
            granted
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
            if (
              !alive.current ||
              dismissedRef.current ||
              authorizationRef.current?.id !== authorization.id
            )
              return;
            authorizationRef.current = undefined;
            setAuthorization(undefined);
            if (
              connection &&
              authorization.connection &&
              (connection.id !== authorization.connection.id ||
                connection.account?.id !== authorization.connection.account?.id)
            ) {
              setError(t("chat.linkResource.changed"));
              void reload();
              return;
            }
            if (connection) setSelectedId(connection.id);
            if (figmaFileGranted(connection, intent.resourceId))
              current.current.onResumeConnectionChange(intent, connection);
            void reload();
          }}
        />
      )}
    </article>
  );
}
