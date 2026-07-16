import React, { useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  ExternalLink,
  LoaderCircle,
  Plus,
  Radio,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { useT } from "../i18n/I18nProvider";
import { useToast } from "../ui/ToastProvider";
import type {
  DingTalkDiscoveredConversation,
  DingTalkSetup,
  ImGatewayStatus,
  ImGatewayUiEvent,
} from "../../preload/types";

interface DingTalkSetupDialogProps {
  open: boolean;
  gatewayStatus: ImGatewayStatus | null;
  onOpenChange(open: boolean): void;
  onStatusChange(status: ImGatewayStatus): void;
  onOpenConsole(): void;
}

type DiscoveryState = "idle" | "connecting" | "listening" | "error";

function placeholderConversation(conversationId: string): DingTalkDiscoveredConversation {
  return {
    conversationId,
    users: [],
    lastMessagePreview: "",
    discoveredAt: 0,
  };
}

function unique(values: Iterable<string>): string[] {
  return [...new Set([...values].map((value) => value.trim()).filter(Boolean))];
}

export function DingTalkSetupDialog({
  open,
  gatewayStatus,
  onOpenChange,
  onStatusChange,
  onOpenConsole,
}: DingTalkSetupDialogProps) {
  const { t } = useT();
  const toast = useToast();
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<"discover" | "save" | "start" | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [hasClientSecret, setHasClientSecret] = useState(false);
  const [secretStorage, setSecretStorage] = useState<DingTalkSetup["secretStorage"]>("missing");
  const [conversations, setConversations] = useState<Map<string, DingTalkDiscoveredConversation>>(
    new Map(),
  );
  const [selectedConversationIds, setSelectedConversationIds] = useState<Set<string>>(new Set());
  const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(new Set());
  const [restrictUsers, setRestrictUsers] = useState(false);
  const [manualConversationId, setManualConversationId] = useState("");
  const [discoveryState, setDiscoveryState] = useState<DiscoveryState>("idle");
  const [error, setError] = useState<string | null>(null);
  const discoveryIdRef = useRef<string | null>(null);
  const hadConfiguredConversationsRef = useRef(false);
  const wasOpenRef = useRef(open);
  const gatewayWasRunningRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDiscoveryState("idle");
    discoveryIdRef.current = null;
    void window.codeshell.imGateway
      .getDingTalkSetup()
      .then((setup) => {
        if (cancelled) return;
        const initialConversations = new Map(
          setup.allowedConversationIds.map((id) => [id, placeholderConversation(id)]),
        );
        setEnabled(setup.enabled || setup.allowedConversationIds.length === 0);
        setClientId(setup.clientId);
        setClientSecret("");
        setHasClientSecret(setup.hasClientSecret);
        setSecretStorage(setup.secretStorage);
        setConversations(initialConversations);
        setSelectedConversationIds(new Set(setup.allowedConversationIds));
        setSelectedUserIds(new Set(setup.allowedUserIds));
        setRestrictUsers(setup.allowedUserIds.length > 0);
        hadConfiguredConversationsRef.current = setup.allowedConversationIds.length > 0;
        gatewayWasRunningRef.current = false;
      })
      .catch((loadError) => {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    return window.codeshell.imGateway.onEvent((event: ImGatewayUiEvent) => {
      if (event.type === "dingtalk-discovery-state") {
        if (discoveryIdRef.current && event.discoveryId !== discoveryIdRef.current) return;
        discoveryIdRef.current = event.discoveryId;
        if (event.state === "connecting" || event.state === "listening") {
          setDiscoveryState(event.state);
          setError(null);
        } else if (event.state === "error") {
          setDiscoveryState("error");
          setError(event.error ?? t("ext.link.dingtalk.discoveryFailed"));
          discoveryIdRef.current = null;
        } else {
          setDiscoveryState("idle");
          discoveryIdRef.current = null;
        }
        return;
      }
      if (event.type !== "dingtalk-conversation-discovered") return;
      if (discoveryIdRef.current && event.discoveryId !== discoveryIdRef.current) return;
      discoveryIdRef.current = event.discoveryId;
      const discovered = event.conversation;
      setConversations((current) => {
        const next = new Map(current);
        next.set(discovered.conversationId, discovered);
        return next;
      });
      setSelectedConversationIds((current) => new Set(current).add(discovered.conversationId));
      setSelectedUserIds((current) => {
        const next = new Set(current);
        for (const user of discovered.users) next.add(user.id);
        return next;
      });
      if (!hadConfiguredConversationsRef.current) setRestrictUsers(true);
    });
  }, [t]);

  useEffect(() => {
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = open;
    if (wasOpen && !open) {
      discoveryIdRef.current = null;
      setDiscoveryState("idle");
      void window.codeshell.imGateway.stopDingTalkDiscovery();
    }
  }, [open]);

  useEffect(
    () => () => {
      if (discoveryIdRef.current) void window.codeshell.imGateway.stopDingTalkDiscovery();
    },
    [],
  );

  const close = () => {
    if (busy) return;
    const restoreGateway = gatewayWasRunningRef.current;
    gatewayWasRunningRef.current = false;
    onOpenChange(false);
    if (restoreGateway) {
      void window.codeshell.imGateway
        .stopDingTalkDiscovery()
        .then(() => window.codeshell.imGateway.status())
        .then((current) =>
          current.channels.length > 0 ? window.codeshell.imGateway.start() : current,
        )
        .then(onStatusChange)
        .catch((restoreError) => {
          toast({
            message: restoreError instanceof Error ? restoreError.message : String(restoreError),
            variant: "error",
          });
        });
    }
  };

  const setupInput = (forceEnabled = enabled) => ({
    enabled: forceEnabled,
    clientId: clientId.trim(),
    ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
    allowedConversationIds: unique(selectedConversationIds),
    allowedUserIds: restrictUsers ? unique(selectedUserIds) : [],
  });

  const validateCredentials = (): boolean => {
    if (!clientId.trim()) {
      setError(t("ext.link.dingtalk.clientIdRequired"));
      return false;
    }
    if (!clientSecret.trim() && !hasClientSecret) {
      setError(t("ext.link.dingtalk.clientSecretRequired"));
      return false;
    }
    return true;
  };

  const startDiscovery = async () => {
    if (busy || !validateCredentials()) return;
    setBusy("discover");
    setError(null);
    setDiscoveryState("connecting");
    try {
      if (gatewayStatus?.running) {
        gatewayWasRunningRef.current = true;
        onStatusChange(await window.codeshell.imGateway.stop());
      }
      const setup = await window.codeshell.imGateway.saveDingTalkSetup(
        setupInput(enabled && selectedConversationIds.size > 0),
      );
      setHasClientSecret(setup.hasClientSecret);
      setSecretStorage(setup.secretStorage);
      setClientSecret("");
      const result = await window.codeshell.imGateway.startDingTalkDiscovery();
      discoveryIdRef.current = result.discoveryId;
      setDiscoveryState("listening");
    } catch (discoveryError) {
      setDiscoveryState("error");
      setError(discoveryError instanceof Error ? discoveryError.message : String(discoveryError));
    } finally {
      setBusy(null);
    }
  };

  const stopDiscovery = async () => {
    if (busy) return;
    await window.codeshell.imGateway.stopDingTalkDiscovery();
    discoveryIdRef.current = null;
    setDiscoveryState("idle");
  };

  const save = async (startAfterSave: boolean) => {
    if (busy || !validateCredentials()) return;
    if (enabled && selectedConversationIds.size === 0) {
      setError(t("ext.link.dingtalk.conversationRequired"));
      return;
    }
    if (enabled && restrictUsers && selectedUserIds.size === 0) {
      setError(t("ext.link.dingtalk.userRequired"));
      return;
    }
    setBusy(startAfterSave ? "start" : "save");
    setError(null);
    try {
      const shouldRestoreGateway = Boolean(gatewayStatus?.running || gatewayWasRunningRef.current);
      await window.codeshell.imGateway.stopDingTalkDiscovery();
      discoveryIdRef.current = null;
      if (gatewayStatus?.running) onStatusChange(await window.codeshell.imGateway.stop());
      await window.codeshell.imGateway.saveDingTalkSetup(setupInput());
      const savedStatus = await window.codeshell.imGateway.status();
      const shouldStart =
        startAfterSave || (shouldRestoreGateway && savedStatus.channels.length > 0);
      const status = shouldStart ? await window.codeshell.imGateway.start() : savedStatus;
      gatewayWasRunningRef.current = false;
      onStatusChange(status);
      toast({
        message: shouldStart
          ? t("ext.link.dingtalk.savedAndStarted")
          : t("ext.link.dingtalk.saved"),
        variant: "success",
      });
      onOpenChange(false);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setBusy(null);
    }
  };

  const addManualConversation = () => {
    const id = manualConversationId.trim();
    if (!id) return;
    setConversations((current) => new Map(current).set(id, placeholderConversation(id)));
    setSelectedConversationIds((current) => new Set(current).add(id));
    setManualConversationId("");
  };

  const removeConversation = (id: string) => {
    setConversations((current) => {
      const next = new Map(current);
      next.delete(id);
      return next;
    });
    setSelectedConversationIds((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  };

  const discoveredUsers = new Map<string, string | undefined>();
  for (const conversation of conversations.values()) {
    for (const user of conversation.users) discoveredUsers.set(user.id, user.name);
  }
  for (const userId of selectedUserIds) {
    if (!discoveredUsers.has(userId)) discoveredUsers.set(userId, undefined);
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="max-h-[88vh] max-w-2xl grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden p-0">
        <DialogHeader className="border-b border-border px-6 py-5 pr-12">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-status-running/10 p-2 text-status-running">
              <Radio className="size-5" aria-hidden />
            </div>
            <div>
              <DialogTitle>{t("ext.link.dingtalk.title")}</DialogTitle>
              <DialogDescription className="mt-1">
                {t("ext.link.dingtalk.description")}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-5 overflow-y-auto px-6 py-1">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" aria-hidden />
              {t("ext.link.dingtalk.loading")}
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-muted/25 p-3.5">
                <div>
                  <Label htmlFor="dingtalk-enabled">{t("ext.link.dingtalk.enable")}</Label>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t("ext.link.dingtalk.enableHint")}
                  </p>
                </div>
                <Switch id="dingtalk-enabled" checked={enabled} onCheckedChange={setEnabled} />
              </div>

              <section className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-medium">{t("ext.link.dingtalk.credentials")}</h3>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {t("ext.link.dingtalk.credentialsHint")}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="gap-1"
                    onClick={onOpenConsole}
                  >
                    <ExternalLink className="size-3.5" aria-hidden />
                    {t("ext.link.gatewayOpenConsole")}
                  </Button>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="dingtalk-client-id">Client ID</Label>
                    <Input
                      id="dingtalk-client-id"
                      value={clientId}
                      autoComplete="off"
                      placeholder="ding..."
                      onChange={(event) => setClientId(event.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="dingtalk-client-secret">Client Secret</Label>
                    <Input
                      id="dingtalk-client-secret"
                      value={clientSecret}
                      type="password"
                      autoComplete="new-password"
                      placeholder={
                        hasClientSecret
                          ? t("ext.link.dingtalk.secretSavedPlaceholder")
                          : t("ext.link.dingtalk.secretPlaceholder")
                      }
                      onChange={(event) => setClientSecret(event.target.value)}
                    />
                  </div>
                </div>
                <div
                  className={cn(
                    "flex items-start gap-2 rounded-md px-3 py-2 text-xs",
                    secretStorage === "legacy-config"
                      ? "bg-status-warn/10 text-status-warn"
                      : "bg-status-ok/10 text-status-ok",
                  )}
                >
                  <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  {secretStorage === "legacy-config"
                    ? t("ext.link.dingtalk.legacySecretHint")
                    : t("ext.link.dingtalk.secureSecretHint")}
                </div>
              </section>

              <section className="space-y-3 border-t border-border pt-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-medium">{t("ext.link.dingtalk.discoveryTitle")}</h3>
                    <p className="mt-0.5 max-w-lg text-xs leading-5 text-muted-foreground">
                      {t("ext.link.dingtalk.discoveryHint")}
                    </p>
                  </div>
                  {discoveryState === "listening" ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void stopDiscovery()}
                    >
                      {t("ext.link.dingtalk.stopDiscovery")}
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      className="gap-1.5"
                      disabled={busy !== null}
                      onClick={() => void startDiscovery()}
                    >
                      {busy === "discover" || discoveryState === "connecting" ? (
                        <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
                      ) : (
                        <Radio className="size-3.5" aria-hidden />
                      )}
                      {discoveryState === "connecting"
                        ? t("ext.link.dingtalk.connecting")
                        : t("ext.link.dingtalk.startDiscovery")}
                    </Button>
                  )}
                </div>
                {gatewayStatus?.running && discoveryState === "idle" && (
                  <p className="rounded-md bg-status-warn/10 px-3 py-2 text-xs text-status-warn">
                    {t("ext.link.dingtalk.discoveryStopsGateway")}
                  </p>
                )}
                {discoveryState === "listening" && (
                  <div className="flex items-center gap-2 rounded-md bg-status-running/10 px-3 py-2 text-xs text-status-running">
                    <span className="relative flex size-2">
                      <span className="absolute inline-flex size-full animate-ping rounded-full bg-status-running opacity-60" />
                      <span className="relative inline-flex size-2 rounded-full bg-status-running" />
                    </span>
                    {t("ext.link.dingtalk.listening")}
                  </div>
                )}

                <div className="space-y-2">
                  {[...conversations.values()].map((conversation) => {
                    const selected = selectedConversationIds.has(conversation.conversationId);
                    return (
                      <div
                        key={conversation.conversationId}
                        className="rounded-lg border border-border p-3"
                      >
                        <div className="flex items-start gap-3">
                          <Checkbox
                            className="mt-1"
                            checked={selected}
                            aria-label={conversation.title ?? conversation.conversationId}
                            onCheckedChange={(checked) => {
                              setSelectedConversationIds((current) => {
                                const next = new Set(current);
                                if (checked === true) next.add(conversation.conversationId);
                                else next.delete(conversation.conversationId);
                                return next;
                              });
                            }}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="truncate text-sm font-medium">
                                {conversation.title || t("ext.link.dingtalk.unknownConversation")}
                              </span>
                              {conversation.discoveredAt > 0 && (
                                <CheckCircle2
                                  className="size-3.5 shrink-0 text-status-ok"
                                  aria-hidden
                                />
                              )}
                              {conversation.conversationType && (
                                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                                  {conversation.conversationType === "2"
                                    ? t("ext.link.dingtalk.groupConversation")
                                    : t("ext.link.dingtalk.directConversation")}
                                </span>
                              )}
                            </div>
                            <p className="mt-1 break-all font-mono text-[10px] text-muted-foreground">
                              {conversation.conversationId}
                            </p>
                            {conversation.lastMessagePreview && (
                              <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">
                                {conversation.lastMessagePreview}
                              </p>
                            )}
                          </div>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-7 text-muted-foreground"
                            aria-label={t("ext.link.dingtalk.removeConversation")}
                            onClick={() => removeConversation(conversation.conversationId)}
                          >
                            <Trash2 className="size-3.5" aria-hidden />
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                  {conversations.size === 0 && discoveryState !== "listening" && (
                    <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">
                      {t("ext.link.dingtalk.noConversations")}
                    </div>
                  )}
                </div>

                <div className="flex gap-2">
                  <Input
                    value={manualConversationId}
                    className="font-mono text-xs"
                    placeholder={t("ext.link.dingtalk.manualConversationPlaceholder")}
                    onChange={(event) => setManualConversationId(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        addManualConversation();
                      }
                    }}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    className="gap-1"
                    onClick={addManualConversation}
                  >
                    <Plus className="size-3.5" aria-hidden />
                    {t("ext.link.dingtalk.add")}
                  </Button>
                </div>
              </section>

              <section className="space-y-3 border-t border-border pt-5">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <h3 className="text-sm font-medium">{t("ext.link.dingtalk.userAllowlist")}</h3>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {restrictUsers
                        ? t("ext.link.dingtalk.userAllowlistRestricted")
                        : t("ext.link.dingtalk.userAllowlistOpen")}
                    </p>
                  </div>
                  <Switch checked={restrictUsers} onCheckedChange={setRestrictUsers} />
                </div>
                {restrictUsers && (
                  <div className="grid gap-2 sm:grid-cols-2">
                    {[...discoveredUsers.entries()].map(([id, name]) => (
                      <label
                        key={id}
                        className="flex items-center gap-2 rounded-md border border-border p-2.5 text-xs"
                      >
                        <Checkbox
                          checked={selectedUserIds.has(id)}
                          onCheckedChange={(checked) => {
                            setSelectedUserIds((current) => {
                              const next = new Set(current);
                              if (checked === true) next.add(id);
                              else next.delete(id);
                              return next;
                            });
                          }}
                        />
                        <span className="min-w-0">
                          {name && <span className="block truncate font-medium">{name}</span>}
                          <span className="block truncate font-mono text-[10px] text-muted-foreground">
                            {id}
                          </span>
                        </span>
                      </label>
                    ))}
                    {discoveredUsers.size === 0 && (
                      <p className="text-xs text-muted-foreground">
                        {t("ext.link.dingtalk.noUsers")}
                      </p>
                    )}
                  </div>
                )}
              </section>

              {error && (
                <p
                  role="alert"
                  className="rounded-md bg-status-err/10 px-3 py-2 text-xs text-status-err"
                >
                  {error}
                </p>
              )}
            </>
          )}
        </div>

        <DialogFooter className="border-t border-border px-6 py-4">
          <Button type="button" variant="ghost" disabled={busy !== null} onClick={close}>
            {t("ext.link.dingtalk.cancel")}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={loading || busy !== null}
            onClick={() => void save(false)}
          >
            {busy === "save" ? t("ext.link.dingtalk.saving") : t("ext.link.dingtalk.save")}
          </Button>
          {enabled && (
            <Button
              type="button"
              disabled={loading || busy !== null}
              onClick={() => void save(true)}
            >
              {busy === "start"
                ? t("ext.link.dingtalk.starting")
                : t("ext.link.dingtalk.saveAndStart")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
