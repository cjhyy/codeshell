import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  ChevronDown,
  ExternalLink,
  MessageCircleMore,
  RefreshCw,
  Search,
  Settings2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useToast } from "../ui/ToastProvider";
import { useT, type TFunction } from "../i18n/I18nProvider";
import { IM_GATEWAY_CHANNEL_NAMES } from "../imGatewayChannels";
import { LINK_CATALOG, type LinkIntegration } from "./link-catalog";
import { linkOAuthPrimaryAction } from "./link-oauth-actions";
import type { MaskedCredentialView } from "./types";
import { DataSourceCatalogSection } from "./DataSourceCatalogSection";
import { DingTalkSetupDialog } from "./DingTalkSetupDialog";
import type {
  ImGatewayChannel,
  ImGatewayChannelCapabilities,
  ImGatewayChannelStatus,
  ImGatewayStatus,
  ImGatewayUiEvent,
} from "../../preload/types";

const CHANNEL_GUIDES: Record<
  ImGatewayChannel,
  {
    transport: "polling" | "socket" | "webhook" | "qr";
    fields: string;
    manageUrl?: string | { zh: string; en: string };
  }
> = {
  telegram: {
    transport: "polling",
    fields: "botToken · allowedChatIds",
    manageUrl: "https://t.me/BotFather",
  },
  discord: {
    transport: "socket",
    fields: "botToken · allowedChannelIds",
    manageUrl: "https://discord.com/developers/applications",
  },
  slack: {
    transport: "socket",
    fields: "botToken · appToken · allowedChannelIds",
    manageUrl: "https://api.slack.com/apps",
  },
  lark: {
    transport: "socket",
    fields: "appId · appSecret · allowedChatIds",
    manageUrl: { zh: "https://open.feishu.cn/app", en: "https://open.larksuite.com/app" },
  },
  dingtalk: {
    transport: "socket",
    fields: "clientId · clientSecret · allowedConversationIds",
    manageUrl: "https://open-dev.dingtalk.com/fe/app",
  },
  wecom: {
    transport: "socket",
    fields: "botId · secret · allowedChatIds",
    manageUrl: "https://work.weixin.qq.com/wework_admin/frame#apps",
  },
  wechat: { transport: "qr", fields: "accountId · allowedUserIds (auto-saved)" },
  matrix: { transport: "polling", fields: "homeserverUrl · accessToken · allowedRoomIds" },
  mattermost: { transport: "socket", fields: "serverUrl · botToken · allowedChannelIds" },
  line: {
    transport: "webhook",
    fields: "channelSecret · channelAccessToken · allowedTargetIds",
    manageUrl: "https://developers.line.biz/console/",
  },
  whatsapp: {
    transport: "webhook",
    fields: "accessToken · appSecret · phoneNumberId",
    manageUrl: "https://developers.facebook.com/apps/",
  },
  teams: {
    transport: "webhook",
    fields: "appId · appPassword · appType · tenantId",
    manageUrl: "https://portal.azure.com/#create/Microsoft.AzureBot",
  },
};

const CHANNEL_STATE_CLASS: Record<ImGatewayChannelStatus["state"], string> = {
  disabled: "bg-muted text-muted-foreground",
  "needs-config": "bg-status-err/10 text-status-err",
  ready: "bg-sky-500/10 text-sky-600",
  starting: "bg-status-warn/10 text-status-warn",
  running: "bg-status-ok/10 text-status-ok",
  retrying: "bg-status-err/10 text-status-err",
};

function gatewayCapabilityLabels(
  capabilities: ImGatewayChannelCapabilities,
  t: TFunction,
): { inbound: string; outbound: string } {
  const attachmentLabel = (kind: ImGatewayChannelCapabilities["inbound"]["attachments"][number]) =>
    t(`ext.link.gatewayCapability.${kind}`);
  return {
    inbound: [
      t("ext.link.gatewayCapability.text"),
      ...capabilities.inbound.attachments.map(attachmentLabel),
    ].join("、"),
    outbound: [
      t("ext.link.gatewayCapability.text"),
      t(
        capabilities.outbound.button === "native"
          ? "ext.link.gatewayCapability.buttonNative"
          : "ext.link.gatewayCapability.buttonLink",
      ),
      ...capabilities.outbound.attachments.map(attachmentLabel),
    ].join("、"),
  };
}

type IntegrationFilter = "all" | "connected" | "available";

export function oauthErrorRequiresRelogin(message: string | undefined): boolean {
  return /invalid[_ -]?grant|requires? (?:a )?login|sign in again/i.test(message ?? "");
}

/**
 * Link tab = 三方集成市场(Codex 风格)。目录写死在 link-catalog.ts;OAuth
 * credential 已存在时展示登录状态。只有 main 已审计 profile 的集成可发起登录。
 */
export function LinkTab({ cwd: _cwd }: { cwd: string }) {
  const { t } = useT();
  const toast = useToast();
  const [credentials, setCredentials] = useState<MaskedCredentialView[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<IntegrationFilter>("all");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const all = await window.codeshell.credentials.list("");
      setCredentials(all.filter((c) => c.type === "oauth"));
      setLoadError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLoadError(message);
      throw error;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load().catch(() => undefined);
  }, [load]);

  const byIntegration = useMemo(() => {
    const map = new Map<string, MaskedCredentialView>();
    for (const cred of credentials) {
      const provider = cred.meta?.oauthProvider;
      if (provider && !map.has(provider)) map.set(provider, cred);
      const suffix = "-oauth";
      if (cred.id.endsWith(suffix)) {
        const id = cred.id.slice(0, -suffix.length);
        if (id && !map.has(id)) map.set(id, cred);
      }
    }
    return map;
  }, [credentials]);

  const catalogItems = useMemo(() => LINK_CATALOG.flatMap((category) => category.items), []);
  const connectedCount = catalogItems.filter((item) => byIntegration.has(item.id)).length;
  const availableCount = catalogItems.filter((item) => Boolean(item.oauthProfileId)).length;
  const filteredCatalog = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return LINK_CATALOG.map((category) => ({
      ...category,
      items: category.items.filter((item) => {
        if (filter === "connected" && !byIntegration.has(item.id)) return false;
        if (filter === "available" && !item.oauthProfileId) return false;
        if (!needle) return true;
        const haystack = `${item.name} ${t(item.descKey)} ${t(category.titleKey)}`;
        return haystack.toLocaleLowerCase().includes(needle);
      }),
    })).filter((category) => category.items.length > 0);
  }, [byIntegration, filter, query, t]);

  const run = async (item: LinkIntegration, action: () => Promise<void>) => {
    if (busyId) return;
    setBusyId(item.id);
    setErrors((current) => ({ ...current, [item.id]: "" }));
    try {
      await action();
      await load();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setErrors((current) => ({ ...current, [item.id]: message }));
      toast({ message });
      // Refresh failures can persist recovery metadata (notably
      // lastRefreshErrorCode=invalid_grant) before rejecting. Reload without
      // replacing the original action error so the row immediately switches
      // to the relogin action while preserving the provider-facing message.
      try {
        await load();
      } catch {
        // The action error above remains the useful failure to show.
      }
    } finally {
      setBusyId(null);
    }
  };

  const onLogin = (item: LinkIntegration, credential?: MaskedCredentialView) => {
    if (!item.oauthProfileId) return;
    void run(item, async () => {
      await window.codeshell.mcpOAuth.login({
        source: "catalog",
        profileId: item.oauthProfileId!,
        credentialId: credential?.id,
      });
    });
  };

  const onRefresh = (item: LinkIntegration, credential: MaskedCredentialView) => {
    // `run` keeps the original provider error visible so the row can derive an
    // immediate re-login action while persisted metadata catches up.
    void run(item, async () => {
      await window.codeshell.mcpOAuth.refresh(credential.id);
    });
  };

  const onLogout = (item: LinkIntegration, credential: MaskedCredentialView) => {
    void run(item, async () => {
      const result = await window.codeshell.mcpOAuth.logout(credential.id);
      toast({
        message: result.remoteRevoked
          ? t("ext.link.oauthLogoutDone", { name: item.name })
          : t("ext.link.oauthLogoutWarning", { name: item.name }),
      });
    });
  };

  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="border-b border-border bg-muted/25 p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="max-w-2xl">
              <h2 className="text-base font-semibold text-foreground">
                {t("ext.link.overviewTitle")}
              </h2>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">{t("ext.link.intro")}</p>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <span className="rounded-md border border-border bg-background px-2.5 py-1.5">
                <span className="font-semibold text-foreground">{connectedCount}</span>{" "}
                <span className="text-muted-foreground">{t("ext.link.connectedCount")}</span>
              </span>
              <span className="rounded-md border border-border bg-background px-2.5 py-1.5">
                <span className="font-semibold text-foreground">{availableCount}</span>{" "}
                <span className="text-muted-foreground">{t("ext.link.availableCount")}</span>
              </span>
            </div>
          </div>
        </div>

        <div className="space-y-3 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-52 flex-1">
              <Search
                className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                value={query}
                type="search"
                className="h-9 pl-9 pr-9"
                placeholder={t("ext.link.searchPlaceholder")}
                aria-label={t("ext.link.searchPlaceholder")}
                onChange={(event) => setQuery(event.target.value)}
              />
              {query ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-0.5 top-0.5 size-8 text-muted-foreground"
                  aria-label={t("ext.link.clearSearch")}
                  onClick={() => setQuery("")}
                >
                  <X className="size-3.5" aria-hidden />
                </Button>
              ) : null}
            </div>
            <div
              className="flex items-center gap-1 rounded-lg border border-border bg-muted/40 p-1"
              role="group"
              aria-label={t("ext.link.filterAria")}
            >
              {(["all", "connected", "available"] as IntegrationFilter[]).map((value) => (
                <Button
                  key={value}
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={cn(
                    "h-7 px-2.5",
                    filter === value && "bg-background text-foreground shadow-sm",
                  )}
                  aria-pressed={filter === value}
                  onClick={() => setFilter(value)}
                >
                  {t(`ext.link.filter.${value}`)}
                </Button>
              ))}
            </div>
          </div>

          {loadError ? (
            <div
              role="alert"
              className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-status-err/30 bg-status-err/5 px-3 py-2"
            >
              <div className="min-w-0">
                <p className="text-xs font-medium text-status-err">{t("ext.link.loadFailed")}</p>
                <p className="mt-0.5 break-words text-xs text-muted-foreground">{loadError}</p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={loading}
                onClick={() => void load().catch(() => undefined)}
              >
                <RefreshCw className={cn("size-3.5", loading && "animate-spin")} aria-hidden />
                {t("ext.link.retry")}
              </Button>
            </div>
          ) : loading ? (
            <p className="text-xs text-muted-foreground" aria-live="polite">
              {t("ext.link.loadingConnections")}
            </p>
          ) : null}
        </div>
      </section>

      <ChatGatewayCard />

      <DataSourceCatalogSection />

      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold">{t("ext.link.appsTitle")}</h3>
          <p className="mt-1 text-xs text-muted-foreground">{t("ext.link.appsDescription")}</p>
        </div>
        {filteredCatalog.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center">
            <p className="text-sm font-medium text-foreground">{t("ext.link.noMatches")}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("ext.link.noMatchesDescription")}
            </p>
            <Button
              type="button"
              variant="link"
              size="sm"
              className="mt-2"
              onClick={() => {
                setQuery("");
                setFilter("all");
              }}
            >
              {t("ext.link.resetFilters")}
            </Button>
          </div>
        ) : (
          filteredCatalog.map((cat) => (
            <section key={cat.id} className="space-y-2">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t(cat.titleKey)}
              </h4>
              <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
                {cat.items.map((item) => (
                  <LinkIntegrationRow
                    key={item.id}
                    item={item}
                    credential={byIntegration.get(item.id)}
                    busy={busyId === item.id}
                    error={errors[item.id]}
                    onLogin={(credential) => onLogin(item, credential)}
                    onRefresh={(credential) => onRefresh(item, credential)}
                    onLogout={(credential) => onLogout(item, credential)}
                  />
                ))}
              </div>
            </section>
          ))
        )}
      </section>
    </div>
  );
}

function ChatGatewayCard() {
  const { t, lang } = useT();
  const toast = useToast();
  const [status, setStatus] = useState<ImGatewayStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"start" | "stop" | "config" | null>(null);
  const [wechatBusy, setWechatBusy] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [loginId, setLoginId] = useState<string | null>(null);
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [loginStage, setLoginStage] = useState<"waiting" | "scanned" | "verify">("waiting");
  const [verificationCode, setVerificationCode] = useState("");
  const [channelsOpen, setChannelsOpen] = useState(false);
  const [dingtalkSetupOpen, setDingtalkSetupOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const next = await window.codeshell.imGateway.status();
      setStatus(next);
      setStatusError(null);
      return next;
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }, []);

  useEffect(() => {
    void refresh().catch(() => undefined);
    const unsubscribe = window.codeshell.imGateway.onEvent((event: ImGatewayUiEvent) => {
      if (event.type === "status-changed") {
        setStatus(event.status);
      } else if (event.type === "wechat-qr") {
        setLoginId(event.loginId);
        setQrUrl(event.url);
        setLoginStage("waiting");
      } else if (event.type === "wechat-status") {
        setLoginId(event.loginId);
        if (event.status === "scaned") setLoginStage("scanned");
      } else if (event.type === "wechat-verification-required") {
        setLoginId(event.loginId);
        setLoginStage("verify");
      }
    });
    const poll = globalThis.setInterval(() => void refresh().catch(() => undefined), 2_000);
    return () => {
      globalThis.clearInterval(poll);
      unsubscribe();
    };
  }, [refresh, toast]);

  useEffect(() => {
    if (!qrUrl) {
      setQrDataUrl(null);
      return;
    }
    let cancelled = false;
    // QR rendering is only needed during the short WeChat login flow. Keep the
    // encoder out of the renderer's initial bundle and fetch it on demand.
    void import("qrcode")
      .then(({ default: QRCode }) => QRCode.toDataURL(qrUrl, { width: 224, margin: 1 }))
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [qrUrl]);

  const run = async (
    kind: "start" | "stop" | "config",
    action: () => Promise<ImGatewayStatus | void>,
  ) => {
    if (busy) return;
    setBusy(kind);
    try {
      const next = await action();
      if (next) setStatus(next);
    } catch (error) {
      toast({
        message: error instanceof Error ? error.message : String(error),
        variant: "error",
      });
    } finally {
      setBusy(null);
    }
  };

  const configure = () =>
    run("config", async () => {
      const configPath = await window.codeshell.imGateway.ensureConfig();
      try {
        await window.codeshell.openInEditor(configPath);
      } catch {
        await window.codeshell.openPath(configPath);
      }
      await refresh();
    });

  const openChannelConsole = async (channel: ImGatewayChannel) => {
    const configured = CHANNEL_GUIDES[channel].manageUrl;
    const url =
      typeof configured === "string" ? configured : configured?.[lang === "zh" ? "zh" : "en"];
    if (!url) return;
    try {
      await window.codeshell.openExternal(url);
    } catch (error) {
      toast({
        message: error instanceof Error ? error.message : t("ext.link.gatewayOpenConsoleFailed"),
        variant: "error",
      });
    }
  };

  const loginWechat = () => {
    if (wechatBusy) return;
    setWechatBusy(true);
    setLoginId(null);
    setQrUrl(null);
    setQrDataUrl(null);
    setVerificationCode("");
    setLoginStage("waiting");
    setLoginOpen(true);
    void window.codeshell.imGateway
      .loginWechat()
      .then(async () => {
        setLoginOpen(false);
        await refresh();
        toast({ message: t("ext.link.gatewayWechatConnected"), variant: "success" });
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("已取消")) {
          toast({
            message,
            variant: "error",
          });
        }
      })
      .finally(() => setWechatBusy(false));
  };

  const cancelWechatLogin = () => {
    setLoginOpen(false);
    void window.codeshell.imGateway.cancelWechatLogin();
  };

  const submitVerification = async () => {
    if (!loginId || !verificationCode.trim()) return;
    try {
      const accepted = await window.codeshell.imGateway.submitWechatVerification({
        loginId,
        code: verificationCode,
      });
      if (!accepted) {
        toast({ message: t("ext.link.gatewayWechatVerificationExpired"), variant: "error" });
        return;
      }
      setLoginStage("scanned");
    } catch (error) {
      toast({
        message: error instanceof Error ? error.message : String(error),
        variant: "error",
      });
    }
  };

  const hasChannels = Boolean(status?.channels.length);
  const fallbackStatuses = useMemo<ImGatewayChannelStatus[]>(
    () =>
      (Object.keys(IM_GATEWAY_CHANNEL_NAMES) as ImGatewayChannel[]).map((channel) => ({
        channel,
        enabled: Boolean(status?.channels.includes(channel)),
        state: status?.channels.includes(channel) ? "ready" : "disabled",
      })),
    [status?.channels],
  );
  const channelStatuses = status?.channelStatuses ?? fallbackStatuses;
  const enabledCount = channelStatuses.filter(({ enabled }) => enabled).length;
  const degraded = channelStatuses.some(
    ({ state }) => state === "retrying" || state === "needs-config",
  );
  const statusLabel = !status
    ? t("ext.link.gatewayChecking")
    : status.running
      ? degraded
        ? t("ext.link.gatewayDegraded")
        : t("ext.link.gatewayRunning")
      : hasChannels
        ? t("ext.link.gatewayStopped")
        : t("ext.link.gatewayNeedsConfig");

  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">{t("ext.link.gatewaySection")}</h3>
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-emerald-600 text-white">
            <MessageCircleMore className="size-5" aria-hidden />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-sm font-semibold">CodeShell Chat Gateway</div>
              <span
                className={cn(
                  "rounded px-1.5 py-0.5 text-[10px] font-medium",
                  !status
                    ? "bg-muted text-muted-foreground"
                    : status.running
                      ? degraded
                        ? "bg-status-warn/10 text-status-warn"
                        : "bg-status-ok/10 text-status-ok"
                      : hasChannels
                        ? "bg-muted text-muted-foreground"
                        : "bg-amber-500/10 text-amber-600",
                )}
              >
                {statusLabel}
              </span>
            </div>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {t("ext.link.gatewayDescription")}
            </p>
            {statusError ? (
              <div
                role="alert"
                className="mt-2 flex flex-wrap items-center gap-2 text-xs text-status-err"
              >
                <span className="min-w-0 flex-1 break-words">{statusError}</span>
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto px-0 text-status-err"
                  onClick={() => void refresh().catch(() => undefined)}
                >
                  {t("ext.link.retry")}
                </Button>
              </div>
            ) : null}
          </div>
        </div>

        <div className="mt-3 rounded-md bg-muted/50 px-3 py-2 text-xs">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-muted-foreground">{t("ext.link.gatewayChannels")}</span>
            {status?.channels.length ? (
              status.channels.map((channel) => (
                <span key={channel} className="rounded bg-background px-1.5 py-0.5 text-foreground">
                  {IM_GATEWAY_CHANNEL_NAMES[channel]}
                </span>
              ))
            ) : (
              <span className="text-muted-foreground">{t("ext.link.gatewayNoChannels")}</span>
            )}
          </div>
          <p className="mt-1.5 text-muted-foreground">{t("ext.link.gatewayPromptHint")}</p>
          <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">
            {status?.configPath ?? "~/.code-shell/im-gateway/config.json"}
          </p>
          {status?.configExists && status.error && (
            <p className="mt-1.5 text-status-err">{status.error}</p>
          )}
        </div>

        <div className="mt-3 overflow-hidden rounded-md border border-border/70">
          <Button
            type="button"
            variant="ghost"
            className="h-auto w-full justify-between rounded-none bg-muted/25 px-3 py-2 text-left text-xs font-normal whitespace-normal"
            onClick={() => setChannelsOpen((open) => !open)}
            aria-expanded={channelsOpen}
            aria-label={t("ext.link.gatewayToggleChannels")}
          >
            <span>
              <span className="font-medium">{t("ext.link.gatewaySupportedChannels")}</span>
              <span className="ml-2 text-muted-foreground">
                {t("ext.link.gatewayEnabledCount", { enabled: enabledCount, total: 12 })}
              </span>
            </span>
            <ChevronDown
              className={cn(
                "size-4 text-muted-foreground transition",
                channelsOpen && "rotate-180",
              )}
              aria-hidden
            />
          </Button>
          {channelsOpen && (
            <div className="grid gap-px bg-border/60 sm:grid-cols-2">
              {channelStatuses.map((channelStatus) => {
                const guide = CHANNEL_GUIDES[channelStatus.channel];
                const capabilityLabels = channelStatus.capabilities
                  ? gatewayCapabilityLabels(channelStatus.capabilities, t)
                  : undefined;
                return (
                  <div key={channelStatus.channel} className="min-w-0 bg-card px-3 py-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-xs font-medium">
                        {IM_GATEWAY_CHANNEL_NAMES[channelStatus.channel]}
                      </span>
                      <span
                        className={cn(
                          "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium",
                          CHANNEL_STATE_CLASS[channelStatus.state],
                        )}
                      >
                        {t(`ext.link.gatewayChannelState.${channelStatus.state}`)}
                      </span>
                    </div>
                    <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-foreground">
                      {t(`ext.link.gatewaySetup.${channelStatus.channel}`)}
                    </p>
                    {capabilityLabels && (
                      <div className="mt-1.5 space-y-0.5 text-[10px] leading-4 text-muted-foreground">
                        <p>
                          <span className="font-medium text-foreground/75">
                            {t("ext.link.gatewayCapability.inbound")}：
                          </span>
                          {capabilityLabels.inbound}
                        </p>
                        <p>
                          <span className="font-medium text-foreground/75">
                            {t("ext.link.gatewayCapability.outbound")}：
                          </span>
                          {capabilityLabels.outbound}
                        </p>
                        <p>
                          <span className="font-medium text-foreground/75">
                            {t("ext.link.gatewayCapability.tool")}：
                          </span>
                          <code>GatewayReply</code>
                        </p>
                      </div>
                    )}
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                      <span className="rounded bg-muted px-1.5 py-0.5">
                        {t(`ext.link.gatewayTransport.${guide.transport}`)}
                      </span>
                      <span className="truncate font-mono" title={guide.fields}>
                        {guide.fields}
                      </span>
                    </div>
                    {channelStatus.channel === "dingtalk" && (
                      <Button
                        type="button"
                        variant="link"
                        size="sm"
                        className="mr-3 mt-2 h-auto gap-1 p-0 text-[10px]"
                        aria-label={t("ext.link.dingtalk.configure")}
                        onClick={() => setDingtalkSetupOpen(true)}
                      >
                        <Settings2 className="size-3" aria-hidden />
                        {t("ext.link.dingtalk.configure")}
                      </Button>
                    )}
                    {guide.manageUrl ? (
                      <Button
                        type="button"
                        variant="link"
                        size="sm"
                        className="mt-2 h-auto gap-1 p-0 text-[10px]"
                        aria-label={`${IM_GATEWAY_CHANNEL_NAMES[channelStatus.channel]}：${t("ext.link.gatewayOpenConsole")}`}
                        onClick={() => void openChannelConsole(channelStatus.channel)}
                      >
                        <ExternalLink className="size-3" aria-hidden />
                        {t("ext.link.gatewayOpenConsole")}
                      </Button>
                    ) : channelStatus.channel === "wechat" ? (
                      <Button
                        type="button"
                        variant="link"
                        size="sm"
                        className="mt-2 h-auto p-0 text-[10px]"
                        disabled={wechatBusy}
                        onClick={loginWechat}
                      >
                        {status?.wechatConnected
                          ? t("ext.link.gatewayWechatReconnect")
                          : t("ext.link.gatewayWechatConnect")}
                      </Button>
                    ) : null}
                    {channelStatus.error && (
                      <p className="mt-1.5 line-clamp-2 text-[10px] leading-4 text-status-err">
                        {channelStatus.error}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {Boolean(status?.running || status?.recentActivity?.length) && (
          <div className="mt-3 rounded-md border border-border/70 px-3 py-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium">{t("ext.link.gatewayRecentActivity")}</span>
              <span className="text-[10px] text-muted-foreground">
                {t("ext.link.gatewayActivityLive")}
              </span>
            </div>
            {status?.recentActivity?.length ? (
              <div className="mt-2 space-y-1.5">
                {status.recentActivity.slice(0, 8).map((activity) => (
                  <div
                    key={activity.id}
                    className="flex items-start gap-2 rounded bg-muted/35 px-2 py-1.5 text-[11px]"
                  >
                    {activity.direction === "inbound" ? (
                      <ArrowDownLeft
                        className="mt-0.5 size-3.5 shrink-0 text-sky-600"
                        aria-hidden
                      />
                    ) : (
                      <ArrowUpRight
                        className={cn(
                          "mt-0.5 size-3.5 shrink-0",
                          activity.status === "failed" ? "text-status-err" : "text-status-ok",
                        )}
                        aria-hidden
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                        <span className="font-medium text-foreground">
                          {IM_GATEWAY_CHANNEL_NAMES[activity.channel]}
                        </span>
                        <span>
                          {activity.direction === "inbound"
                            ? t("ext.link.gatewayInbound")
                            : activity.status === "failed"
                              ? t("ext.link.gatewaySendFailed")
                              : t("ext.link.gatewayOutbound")}
                        </span>
                        <span className="ml-auto shrink-0">
                          {new Date(activity.createdAt).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                      </div>
                      <p className="mt-0.5 line-clamp-2 break-all leading-4">
                        {activity.text ||
                          t("ext.link.gatewayAttachmentMessage", {
                            count: activity.attachmentCount ?? 0,
                          })}
                      </p>
                      {activity.direction === "inbound" && activity.senderId && (
                        <p
                          className="mt-0.5 truncate font-mono text-[9px] text-muted-foreground"
                          title={`${activity.senderId} → ${activity.target}`}
                        >
                          {activity.senderId} → {activity.target}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-2 text-[11px] leading-4 text-muted-foreground">
                {t("ext.link.gatewayNoActivity")}
              </p>
            )}
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {status?.running ? (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy !== null}
              onClick={() => void run("stop", () => window.codeshell.imGateway.stop())}
            >
              {busy === "stop" ? t("ext.link.gatewayStopping") : t("ext.link.gatewayStop")}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy !== null || !hasChannels || !status}
              onClick={() => void run("start", () => window.codeshell.imGateway.start())}
            >
              {busy === "start" ? t("ext.link.gatewayStarting") : t("ext.link.gatewayStart")}
            </Button>
          )}
          <Button size="sm" variant="outline" disabled={busy !== null} onClick={configure}>
            {busy === "config"
              ? t("ext.link.gatewayOpeningConfig")
              : t("ext.link.gatewayAdvancedConfigure")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={!status || busy !== null}
            onClick={() => void refresh().catch(() => undefined)}
          >
            <RefreshCw className="size-3.5" aria-hidden />
            {t("ext.link.refreshStatus")}
          </Button>
        </div>
      </div>

      <DingTalkSetupDialog
        open={dingtalkSetupOpen}
        gatewayStatus={status}
        onOpenChange={setDingtalkSetupOpen}
        onStatusChange={setStatus}
        onOpenConsole={() => void openChannelConsole("dingtalk")}
      />

      <Dialog open={loginOpen} onOpenChange={(open) => !open && cancelWechatLogin()}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("ext.link.gatewayWechatTitle")}</DialogTitle>
            <DialogDescription>
              {loginStage === "verify"
                ? t("ext.link.gatewayWechatVerification")
                : loginStage === "scanned"
                  ? t("ext.link.gatewayWechatScanned")
                  : t("ext.link.gatewayWechatWaiting")}
            </DialogDescription>
          </DialogHeader>
          <div className="flex min-h-56 items-center justify-center rounded-md bg-white p-2">
            {qrDataUrl ? (
              <img src={qrDataUrl} alt={t("ext.link.gatewayWechatQrAlt")} className="size-56" />
            ) : (
              <span className="text-sm text-zinc-500">{t("ext.link.gatewayWechatLoadingQr")}</span>
            )}
          </div>
          {loginStage === "verify" && (
            <Input
              value={verificationCode}
              inputMode="numeric"
              autoFocus
              placeholder={t("ext.link.gatewayWechatVerificationPlaceholder")}
              onChange={(event) => setVerificationCode(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void submitVerification();
              }}
            />
          )}
          <DialogFooter>
            <Button variant="outline" onClick={cancelWechatLogin}>
              {t("ext.link.gatewayWechatCancel")}
            </Button>
            {loginStage === "verify" && (
              <Button
                variant="solid"
                disabled={!verificationCode.trim()}
                onClick={() => void submitVerification()}
              >
                {t("ext.link.gatewayWechatSubmit")}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function LinkIntegrationRow({
  item,
  credential,
  busy,
  error,
  onLogin,
  onRefresh,
  onLogout,
}: {
  item: LinkIntegration;
  credential?: MaskedCredentialView;
  busy: boolean;
  error?: string;
  onLogin: (credential?: MaskedCredentialView) => void;
  onRefresh: (credential: MaskedCredentialView) => void;
  onLogout: (credential: MaskedCredentialView) => void;
}) {
  const { t } = useT();
  const state = credential?.oauthStatus?.state ?? (credential ? "valid" : "missing");
  const primaryAction = oauthErrorRequiresRelogin(error)
    ? "login"
    : linkOAuthPrimaryAction(credential, Boolean(item.oauthProfileId));
  const status =
    state === "valid"
      ? t("ext.link.oauthStatusValid")
      : state === "expired"
        ? t("ext.link.oauthStatusExpired")
        : state === "invalid"
          ? t("ext.link.oauthStatusInvalid")
          : t("ext.link.oauthStatusMissing");

  return (
    <div className="flex flex-col gap-3 p-3 transition-colors hover:bg-accent/35 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <div
          className={
            "flex size-10 shrink-0 items-center justify-center rounded-lg text-sm font-semibold text-white shadow-sm " +
            item.brandColor
          }
          aria-hidden
        >
          {item.brandText}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <div className="text-sm font-medium">{item.name}</div>
            <span
              className={cn(
                "rounded px-1.5 py-0.5 text-[10px] font-medium",
                state === "valid"
                  ? "bg-status-ok/10 text-status-ok"
                  : state === "missing"
                    ? "bg-muted text-muted-foreground"
                    : "bg-status-err/10 text-status-err",
              )}
            >
              {status}
            </span>
          </div>
          <div className="mt-0.5 text-xs leading-5 text-muted-foreground">
            {credential ? (
              <span title={`${credential.label} (${credential.id})`}>
                {credential.label} · <span className="font-mono">{credential.id}</span>
                {credential.oauthStatus?.expiresAt
                  ? ` · ${new Date(credential.oauthStatus.expiresAt).toLocaleString()}`
                  : ""}
              </span>
            ) : (
              t(item.descKey)
            )}
          </div>
          {error ? (
            <div role="alert" className="mt-1 break-words text-xs text-status-err">
              {error}
            </div>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1 self-end sm:self-auto">
        {credential ? (
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                primaryAction === "login" ? onLogin(credential) : onRefresh(credential)
              }
              disabled={busy}
            >
              {busy ? <RefreshCw className="size-3.5 animate-spin" aria-hidden /> : null}
              {primaryAction === "login" ? t("ext.link.oauthRelogin") : t("ext.link.oauthRefresh")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => onLogout(credential)} disabled={busy}>
              {t("ext.link.oauthLogout")}
            </Button>
          </>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onLogin()}
            disabled={busy || !item.oauthProfileId}
            title={!item.oauthProfileId ? t("ext.link.oauthUnsupported") : undefined}
          >
            {item.oauthProfileId ? t("ext.link.oauthLogin") : t("ext.link.oauthUnsupported")}
          </Button>
        )}
      </div>
    </div>
  );
}
