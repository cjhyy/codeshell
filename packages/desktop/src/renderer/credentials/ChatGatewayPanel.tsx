import { useCallback, useEffect, useId, useMemo, useState } from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  ChevronDown,
  ExternalLink,
  MessageCircleMore,
  RefreshCw,
  Settings2,
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
import { useT } from "../i18n/I18nProvider";
import { IM_GATEWAY_CHANNEL_NAMES } from "../imGatewayChannels";
import { DingTalkSetupDialog } from "./DingTalkSetupDialog";
import {
  CHANNEL_GUIDES,
  CHANNEL_STATE_CLASS,
  gatewayCapabilityLabels,
  gatewayToolNames,
} from "./chatGatewayGuides";
import type {
  ImGatewayChannel,
  ImGatewayChannelStatus,
  ImGatewayStatus,
  ImGatewayUiEvent,
} from "../../preload/types";

/**
 * The IM Chat Gateway: bound channels, WeChat QR login, DingTalk setup and
 * recent traffic. It lives in Mimi settings › 消息连接; the credentials page
 * only points there.
 */
export function ChatGatewayPanel() {
  const channelDetailsId = useId();
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
    <div className="space-y-5" data-channel-page>
      <section className="space-y-4" aria-label={t("ext.link.gatewaySection")}>
        <div className="rounded-2xl border border-border/70 bg-card p-4 shadow-sm sm:p-5">
          <div className="flex items-start gap-3">
            <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-emerald-600 text-white shadow-sm">
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

          <div className="mt-4 rounded-xl border border-border/50 bg-muted/35 px-3.5 py-3 text-xs">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-muted-foreground">{t("ext.link.gatewayChannels")}</span>
              {status?.channels.length ? (
                status.channels.map((channel) => (
                  <span
                    key={channel}
                    className="rounded bg-background px-1.5 py-0.5 text-foreground"
                  >
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

          <div className="mt-3 overflow-hidden rounded-xl border border-border/70">
            <Button
              type="button"
              variant="ghost"
              className="h-auto w-full justify-between rounded-none bg-muted/25 px-3 py-2 text-left text-xs font-normal whitespace-normal"
              onClick={() => setChannelsOpen((open) => !open)}
              aria-expanded={channelsOpen}
              aria-controls={channelsOpen ? channelDetailsId : undefined}
              aria-label={t("ext.link.gatewayToggleChannels")}
            >
              <span>
                <span className="font-medium">{t("ext.link.gatewaySupportedChannels")}</span>
                <span className="ml-2 text-muted-foreground">
                  {t("ext.link.gatewayEnabledCount", {
                    enabled: enabledCount,
                    total: channelStatuses.length,
                  })}
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
              <div
                id={channelDetailsId}
                className="grid min-w-0 gap-px bg-border/60 sm:grid-cols-2"
              >
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
                            <code>{gatewayToolNames(channelStatus)}</code>
                          </p>
                          {channelStatus.proactiveReason === "awaiting-inbound-context" && (
                            <p
                              data-gateway-proactive-hint={channelStatus.channel}
                              className="text-status-warn"
                            >
                              {t("ext.link.gatewayCapability.wechatNeedsInbound")}
                            </p>
                          )}
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
            <div className="mt-3 rounded-xl border border-border/70 px-3.5 py-3">
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
                <span className="text-sm text-zinc-500">
                  {t("ext.link.gatewayWechatLoadingQr")}
                </span>
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
    </div>
  );
}
