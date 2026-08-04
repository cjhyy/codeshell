import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  Cable,
  ChevronDown,
  Cloud,
  Globe2,
  ExternalLink,
  Figma,
  Github,
  HardDrive,
  KeyRound,
  MessageCircleMore,
  MessageSquareText,
  MessagesSquare,
  NotebookPen,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  SquareTerminal,
  Sparkles,
  X,
  type LucideIcon,
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
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { useToast } from "../ui/ToastProvider";
import { useT, type TFunction } from "../i18n/I18nProvider";
import { IM_GATEWAY_CHANNEL_NAMES } from "../imGatewayChannels";
import {
  buildLinkCatalog,
  type LinkConnectionMethod,
  type LinkExecutionRuntime,
  type LinkIntegration,
} from "./link-catalog";
import { linkOAuthPrimaryAction } from "./link-oauth-actions";
import type { CredentialView, MaskedCredentialView } from "./types";
import { DingTalkSetupDialog } from "./DingTalkSetupDialog";
import type {
  ImGatewayChannel,
  ImGatewayChannelCapabilities,
  ImGatewayChannelStatus,
  ImGatewayStatus,
  ImGatewayUiEvent,
  CliLinkStatusView,
  BrowserLinkAuthPromptView,
  BrowserLinkAuthStatusView,
  LocalLinkProviderView,
  LocalLinkValidationView,
  ManagedCliInstallStatusView,
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

export function gatewayCapabilityLabels(
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
      t(
        capabilities.outbound.proactive !== false
          ? "ext.link.gatewayCapability.proactive"
          : "ext.link.gatewayCapability.replyOnly",
      ),
      ...(capabilities.outbound.direct ? [t("ext.link.gatewayCapability.direct")] : []),
    ].join("、"),
  };
}

export function gatewayToolNames(
  status: Pick<ImGatewayChannelStatus, "capabilities" | "proactiveReady">,
): string {
  return status.capabilities?.outbound.proactive !== false && status.proactiveReady !== false
    ? "GatewayReply · SendMessage"
    : "GatewayReply";
}

type IntegrationFilter = "all" | "connected" | "planned";

const INTEGRATION_ICONS: Record<LinkIntegration["icon"], LucideIcon> = {
  github: Github,
  figma: Figma,
  notes: NotebookPen,
  conversation: MessageSquareText,
};

function linkCredentialProvider(credential: MaskedCredentialView): string | undefined {
  if (credential.meta?.linkProvider) return credential.meta.linkProvider;
  if (credential.meta?.oauthProvider) return credential.meta.oauthProvider;
  const suffix = "-oauth";
  return credential.id.endsWith(suffix)
    ? credential.id.slice(0, -suffix.length) || undefined
    : undefined;
}

function linkCredentialRuntime(credential: MaskedCredentialView): LinkExecutionRuntime | undefined {
  return (
    credential.meta?.linkExecutionRuntime ??
    (credential.type === "oauth" ? "server" : credential.type === "link" ? "local" : undefined)
  );
}

function linkCredentialIsUsable(credential: MaskedCredentialView | undefined): boolean {
  if (!credential?.hasSecret) return false;
  if (credential.type !== "oauth") return true;
  return credential.oauthStatus?.state !== "expired" && credential.oauthStatus?.state !== "invalid";
}

/** Link Action 的默认路由规则：有效本地连接优先，否则回退到有效服务器连接。 */
export function resolvePreferredLinkRuntime(
  credentials: MaskedCredentialView[],
  providerId: string,
): LinkExecutionRuntime | null {
  const candidates = credentials.filter(
    (credential) => linkCredentialProvider(credential) === providerId,
  );
  const local = candidates.find((credential) => linkCredentialRuntime(credential) === "local");
  if (linkCredentialIsUsable(local)) return "local";
  const server = candidates.find((credential) => linkCredentialRuntime(credential) === "server");
  return linkCredentialIsUsable(server) ? "server" : null;
}

interface LinkMethodEntry {
  item: LinkIntegration;
  method: LinkConnectionMethod;
  credential?: MaskedCredentialView;
  preferredRuntime: LinkExecutionRuntime | null;
}

export function buildLocalLinkCredential(
  item: LinkIntegration,
  method: LinkConnectionMethod,
  label: string,
  secret: string,
  existingId?: string,
  validation?: LocalLinkValidationView,
): CredentialView {
  return {
    id: existingId ?? `link-${item.id}-${method.id}`,
    type: "link",
    label: label.trim() || `${item.name} · ${method.displayName}`,
    secret: secret.trim(),
    autoUseByAI: false,
    meta: {
      linkProvider: item.id,
      linkConnectionMethod: method.id,
      linkExecutionRuntime: "local",
      linkAuthSource: "manual-token",
      agentExposable: false,
      linkAccountId: validation?.identity.externalAccountId,
      linkAccountLabel: validation?.identity.label,
      linkResourceLabels: validation?.identity.resourceLabels,
      linkCapabilityIds: validation?.capabilityIds,
      linkLastVerifiedAt: validation?.verifiedAt,
    },
  };
}

export function oauthErrorRequiresRelogin(message: string | undefined): boolean {
  return /invalid[_ -]?grant|requires? (?:a )?login|sign in again/i.test(message ?? "");
}

export function buildCliLinkConnectionRequest(input: {
  cwd: string;
  providerId: string;
  methodId: string;
  label: string;
  existingId?: string;
  authenticated: boolean;
}) {
  return {
    cwd: input.cwd,
    providerId: input.providerId,
    methodId: input.methodId,
    label: input.label,
    existingId: input.existingId,
    loginIfNeeded: !input.authenticated,
  };
}

export function CliQuickAuthPanel({
  providerName,
  quickAuth,
  status,
  installStatus = null,
  checking,
  installing = false,
  busy,
  onConnect,
  onInstall,
  onManagedInstall = () => undefined,
}: {
  providerName: string;
  quickAuth: NonNullable<LinkConnectionMethod["quickAuth"]>;
  status: CliLinkStatusView | null;
  installStatus?: ManagedCliInstallStatusView | null;
  checking: boolean;
  installing?: boolean;
  busy: boolean;
  onConnect: () => void;
  onInstall: (url: string) => void;
  onManagedInstall?: () => void;
}) {
  const { t } = useT();
  return (
    <div className="rounded-xl border border-primary/20 bg-primary/[0.045] p-3.5">
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-zinc-950 text-white dark:bg-zinc-100 dark:text-zinc-950">
          <SquareTerminal className="size-4.5" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold text-foreground">{quickAuth.displayName}</p>
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
              {t("ext.link.cliQuickLoginBadge")}
            </span>
          </div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {installing
              ? t("ext.link.cliDownloading", { command: quickAuth.command })
              : checking
                ? t("ext.link.cliChecking", { command: quickAuth.command })
                : status?.authenticated
                  ? t("ext.link.cliSignedIn", {
                      command: quickAuth.command,
                      account: status.account ?? providerName,
                    })
                  : status?.installed
                    ? quickAuth.summary
                    : t("ext.link.cliMissing", { command: quickAuth.command })}
          </p>
        </div>
      </div>
      <Button
        type="button"
        className="mt-3 w-full"
        variant={status?.installed === false ? "outline" : "default"}
        disabled={checking || installing || busy}
        onClick={() => {
          if (status?.installed === false) {
            if (installStatus?.supported) onManagedInstall();
            else onInstall(quickAuth.installUrl);
            return;
          }
          onConnect();
        }}
      >
        <SquareTerminal className="mr-2 size-4" aria-hidden />
        {installing
          ? t("ext.link.cliDownloading", { command: quickAuth.command })
          : checking
            ? t("ext.link.cliChecking", { command: quickAuth.command })
            : status?.installed === false
              ? installStatus?.supported
                ? t("ext.link.cliDownloadAndLogin", { command: quickAuth.command })
                : t("ext.link.cliInstall", { command: quickAuth.command })
              : status?.authenticated
                ? t("ext.link.cliUseAccount", { account: status.account ?? providerName })
                : t("ext.link.cliLogin", { name: providerName })}
      </Button>
      <p className="mt-2 text-[11px] leading-4 text-muted-foreground">{quickAuth.privacyNote}</p>
    </div>
  );
}

function BrowserQuickAuthPanel({
  providerName,
  browserAuth,
  status,
  prompt,
  busy,
  onConnect,
  onOpenDocs,
}: {
  providerName: string;
  browserAuth: NonNullable<LinkConnectionMethod["browserAuth"]>;
  status: BrowserLinkAuthStatusView | null;
  prompt: BrowserLinkAuthPromptView | null;
  busy: boolean;
  onConnect: () => void;
  onOpenDocs: (url: string) => void;
}) {
  const { t } = useT();
  return (
    <div className="rounded-xl border border-sky-500/20 bg-sky-500/[0.045] p-3.5">
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-sky-500/12 text-sky-600 dark:text-sky-400">
          <Globe2 className="size-4.5" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">{browserAuth.displayName}</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {prompt
              ? t("ext.link.browserAuthWaiting", { name: providerName })
              : status?.configured === false
                ? t("ext.link.browserAuthUnavailable")
                : browserAuth.summary}
          </p>
        </div>
      </div>
      {prompt ? (
        <div className="mt-3 rounded-lg border border-sky-500/20 bg-background/80 px-3 py-2.5 text-center">
          <p className="text-[11px] text-muted-foreground">{t("ext.link.browserAuthCodeCopied")}</p>
          <p className="mt-1 font-mono text-lg font-semibold tracking-[0.2em] text-foreground">
            {prompt.userCode}
          </p>
        </div>
      ) : null}
      <Button
        type="button"
        className="mt-3 w-full"
        variant="outline"
        disabled={busy || status === null || status.configured === false}
        onClick={onConnect}
      >
        <Globe2 className="mr-2 size-4" aria-hidden />
        {busy
          ? t("ext.link.browserAuthWaiting", { name: providerName })
          : t("ext.link.browserAuthLogin", { name: providerName })}
      </Button>
      <div className="mt-2 flex items-start justify-between gap-3 text-[11px] leading-4 text-muted-foreground">
        <p>{browserAuth.privacyNote}</p>
        <button
          type="button"
          className="shrink-0 font-medium text-primary hover:underline"
          onClick={() => onOpenDocs(browserAuth.docsUrl)}
        >
          {t("ext.link.viewOfficialGuide")}
        </button>
      </div>
    </div>
  );
}

/**
 * Link tab = 第三方应用连接。每个 provider 同时拥有 local/server 两条连接通道；
 * credential 状态互不覆盖，Action 默认选择有效 local，再回退到有效 server。
 */
export function LinkTab({ cwd }: { cwd: string }) {
  const { t, lang } = useT();
  const toast = useToast();
  const [credentials, setCredentials] = useState<MaskedCredentialView[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [providerViews, setProviderViews] = useState<LocalLinkProviderView[]>([]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<IntegrationFilter>("all");
  const [localDialog, setLocalDialog] = useState<{
    item: LinkIntegration;
    method: LinkConnectionMethod;
    credential?: MaskedCredentialView;
  } | null>(null);
  const [localLabel, setLocalLabel] = useState("");
  const [localSecret, setLocalSecret] = useState("");
  const [cliStatus, setCliStatus] = useState<CliLinkStatusView | null>(null);
  const [cliInstallStatus, setCliInstallStatus] = useState<ManagedCliInstallStatusView | null>(
    null,
  );
  const [cliChecking, setCliChecking] = useState(false);
  const [cliInstalling, setCliInstalling] = useState(false);
  const [browserAuthStatus, setBrowserAuthStatus] = useState<BrowserLinkAuthStatusView | null>(
    null,
  );
  const [browserAuthPrompt, setBrowserAuthPrompt] = useState<BrowserLinkAuthPromptView | null>(
    null,
  );
  const [browserAuthBusy, setBrowserAuthBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [all, providers] = await Promise.all([
        window.codeshell.credentials.list(cwd),
        window.codeshell.links.listLocalProviders(),
      ]);
      setCredentials(
        all.filter((credential) => credential.type === "oauth" || credential.type === "link"),
      );
      setProviderViews(providers);
      setLoadError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLoadError(message);
      throw error;
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    void load().catch(() => undefined);
  }, [load]);

  const localDialogProviderId = localDialog?.item.id;
  const localDialogQuickAuth = localDialog?.method.quickAuth;
  useEffect(() => {
    if (!localDialogProviderId || localDialogQuickAuth?.kind !== "cli-session") {
      setCliStatus(null);
      setCliInstallStatus(null);
      setCliChecking(false);
      return;
    }
    const statusLoader = window.codeshell.links?.cliStatus;
    if (!statusLoader) {
      setCliStatus({
        providerId: localDialogProviderId,
        command: localDialogQuickAuth.command,
        installed: false,
        authenticated: false,
      });
      return;
    }
    let cancelled = false;
    setCliChecking(true);
    void statusLoader(localDialogProviderId, cwd)
      .then((status) => {
        if (!cancelled) setCliStatus(status);
      })
      .catch((error) => {
        if (!cancelled) {
          setCliStatus({
            providerId: localDialogProviderId,
            command: localDialogQuickAuth.command,
            installed: false,
            authenticated: false,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      })
      .finally(() => {
        if (!cancelled) setCliChecking(false);
      });
    const installStatusLoader = window.codeshell.links?.cliInstallStatus;
    if (installStatusLoader) {
      void installStatusLoader(localDialogProviderId)
        .then((status) => {
          if (!cancelled) setCliInstallStatus(status);
        })
        .catch(() => {
          if (!cancelled) setCliInstallStatus(null);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [cwd, localDialogProviderId, localDialogQuickAuth]);

  const localDialogBrowserAuth = localDialog?.method.browserAuth;
  useEffect(() => {
    if (!localDialogProviderId || !localDialogBrowserAuth) {
      setBrowserAuthStatus(null);
      setBrowserAuthPrompt(null);
      setBrowserAuthBusy(false);
      return;
    }
    let cancelled = false;
    void window.codeshell.links
      .browserAuthStatus(localDialogProviderId)
      .then((status) => {
        if (!cancelled) setBrowserAuthStatus(status);
      })
      .catch(() => {
        if (!cancelled) setBrowserAuthStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [localDialogBrowserAuth, localDialogProviderId]);

  const catalog = useMemo(
    () => buildLinkCatalog(providerViews, lang === "zh" ? "zh" : "en"),
    [lang, providerViews],
  );
  const byRuntime = useMemo(() => {
    const map = new Map<string, MaskedCredentialView>();
    for (const credential of credentials) {
      const provider = linkCredentialProvider(credential);
      const runtime = linkCredentialRuntime(credential);
      if (provider && runtime && !map.has(`${provider}:${runtime}`)) {
        map.set(`${provider}:${runtime}`, credential);
      }
    }
    return map;
  }, [credentials]);

  const entries = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const result: Record<LinkExecutionRuntime, LinkMethodEntry[]> = { local: [], server: [] };
    for (const category of catalog) {
      for (const item of category.items) {
        for (const method of item.connectionMethods) {
          const credential = byRuntime.get(`${item.id}:${method.executionRuntime}`);
          const available =
            method.availability === "available" &&
            (method.authKind === "token" || Boolean(method.oauthProfileId));
          if (filter === "connected" && !credential) continue;
          if (filter === "planned" && (credential || available)) continue;
          if (needle) {
            const haystack = `${item.name} ${method.displayName} ${item.description} ${t(category.titleKey)}`;
            if (!haystack.toLocaleLowerCase().includes(needle)) continue;
          }
          result[method.executionRuntime].push({
            item,
            method,
            credential,
            preferredRuntime: resolvePreferredLinkRuntime(credentials, item.id),
          });
        }
      }
    }
    return result;
  }, [byRuntime, catalog, credentials, filter, query, t]);

  const localConnectedCount = [...byRuntime.keys()].filter((key) => key.endsWith(":local")).length;
  const serverConnectedCount = [...byRuntime.keys()].filter((key) =>
    key.endsWith(":server"),
  ).length;
  const connectedCount = localConnectedCount + serverConnectedCount;

  const run = async (
    item: LinkIntegration,
    method: LinkConnectionMethod,
    action: () => Promise<void>,
  ): Promise<boolean> => {
    if (busyId) return false;
    const key = `${item.id}:${method.executionRuntime}`;
    setBusyId(key);
    setErrors((current) => ({ ...current, [key]: "" }));
    try {
      await action();
      await load();
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setErrors((current) => ({ ...current, [key]: message }));
      toast({ message, variant: "error" });
      try {
        await load();
      } catch {
        // Keep the provider-facing action error visible.
      }
      return false;
    } finally {
      setBusyId(null);
    }
  };

  const onServerLogin = (
    item: LinkIntegration,
    method: LinkConnectionMethod,
    credential?: MaskedCredentialView,
  ) => {
    if (!method.oauthProfileId) return;
    void run(item, method, async () => {
      await window.codeshell.mcpOAuth.login({
        source: "catalog",
        profileId: method.oauthProfileId!,
        credentialId: credential?.id,
      });
    });
  };

  const onServerRefresh = (
    item: LinkIntegration,
    method: LinkConnectionMethod,
    credential: MaskedCredentialView,
  ) => {
    void run(item, method, async () => {
      await window.codeshell.mcpOAuth.refresh(credential.id);
    });
  };

  const onServerLogout = (
    item: LinkIntegration,
    method: LinkConnectionMethod,
    credential: MaskedCredentialView,
  ) => {
    void run(item, method, async () => {
      const result = await window.codeshell.mcpOAuth.logout(credential.id);
      toast({
        message: result.remoteRevoked
          ? t("ext.link.oauthLogoutDone", { name: item.name })
          : t("ext.link.oauthLogoutWarning", { name: item.name }),
      });
    });
  };

  const openLocalDialog = (entry: LinkMethodEntry) => {
    setLocalDialog({ item: entry.item, method: entry.method, credential: entry.credential });
    setLocalLabel(entry.credential?.label ?? `${entry.item.name} · ${entry.method.displayName}`);
    setLocalSecret("");
  };

  const saveLocalConnection = async () => {
    if (!localDialog) return;
    if (!localSecret.trim()) {
      toast({ message: t("ext.link.localSecretRequired"), variant: "error" });
      return;
    }
    const { item, method, credential } = localDialog;
    const saved = await run(item, method, async () => {
      const validation = await window.codeshell.links.connectLocal({
        cwd,
        providerId: item.id,
        methodId: method.id,
        label: localLabel,
        token: localSecret,
        existingId: credential?.id,
      });
      toast({
        message: t("ext.link.localValidated", { account: validation.identity.label }),
      });
    });
    if (saved) {
      setLocalDialog(null);
      setLocalSecret("");
    }
  };

  const connectFromCli = async (forceLogin = false) => {
    if (!localDialog?.method.quickAuth) return;
    const { item, method, credential } = localDialog;
    const saved = await run(item, method, async () => {
      const validation = await window.codeshell.links.connectCli(
        buildCliLinkConnectionRequest({
          authenticated: forceLogin ? false : cliStatus?.authenticated === true,
          cwd,
          providerId: item.id,
          methodId: method.id,
          label: localLabel,
          existingId: credential?.id,
        }),
      );
      toast({ message: t("ext.link.localValidated", { account: validation.identity.label }) });
    });
    if (saved) {
      setLocalDialog(null);
      setLocalSecret("");
    }
  };

  const installAndConnectCli = async () => {
    if (!localDialog || !cliInstallStatus?.supported || cliInstalling) return;
    setCliInstalling(true);
    try {
      const result = await window.codeshell.links.installCli(localDialog.item.id);
      setCliStatus({
        providerId: localDialog.item.id,
        command: result.command,
        installed: true,
        authenticated: false,
      });
      toast({ message: t("ext.link.cliInstalled", { command: result.command }) });
      await connectFromCli(true);
    } catch (error) {
      toast({ message: error instanceof Error ? error.message : String(error), variant: "error" });
    } finally {
      setCliInstalling(false);
    }
  };

  const connectFromBrowser = async () => {
    if (!localDialog?.method.browserAuth || browserAuthBusy) return;
    const { item, method, credential } = localDialog;
    setBrowserAuthBusy(true);
    const saved = await run(item, method, async () => {
      const prompt = await window.codeshell.links.startBrowserAuth(item.id);
      setBrowserAuthPrompt(prompt);
      const validation = await window.codeshell.links.completeBrowserAuth({
        attemptId: prompt.attemptId,
        cwd,
        providerId: item.id,
        methodId: method.id,
        label: localLabel,
        existingId: credential?.id,
      });
      toast({ message: t("ext.link.localValidated", { account: validation.identity.label }) });
    });
    setBrowserAuthBusy(false);
    setBrowserAuthPrompt(null);
    if (saved) {
      setLocalDialog(null);
      setLocalSecret("");
    }
  };

  const closeLocalDialog = () => {
    if (browserAuthPrompt) {
      void window.codeshell.links.cancelBrowserAuth(browserAuthPrompt.attemptId);
    }
    setBrowserAuthPrompt(null);
    setBrowserAuthBusy(false);
    setLocalDialog(null);
  };

  const openExternalLink = (url: string) => {
    void window.codeshell.openExternal(url).catch((error) => {
      toast({ message: error instanceof Error ? error.message : String(error), variant: "error" });
    });
  };

  const disconnectLocal = (entry: LinkMethodEntry) => {
    if (!entry.credential) return;
    void run(entry.item, entry.method, async () => {
      await window.codeshell.credentials.remove(cwd, "user", entry.credential!.id);
      toast({ message: t("ext.link.localDisconnected", { name: entry.item.name }) });
    });
  };

  const noMatches = entries.local.length === 0 && entries.server.length === 0;

  return (
    <div className="space-y-5" data-link-page>
      <section className="link-hero overflow-hidden rounded-2xl border border-border/70 px-5 py-6 sm:px-6">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-start gap-4">
            <div className="flex size-12 shrink-0 items-center justify-center rounded-2xl border border-primary/20 bg-primary/10 text-primary shadow-sm">
              <Cable className="size-6" aria-hidden />
            </div>
            <div className="min-w-0 max-w-2xl">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-primary">
                  {t("ext.link.eyebrow")}
                </span>
                <span className="inline-flex items-center gap-1 rounded-full border border-status-ok/25 bg-status-ok/8 px-2 py-0.5 text-[10px] font-medium text-status-ok">
                  <ShieldCheck className="size-3" aria-hidden />
                  {t("ext.link.localFirst")}
                </span>
              </div>
              <h2 className="mt-1.5 text-lg font-semibold tracking-tight text-foreground">
                {t("ext.link.overviewTitle")}
              </h2>
              <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
                {t("ext.link.intro")}
              </p>
            </div>
          </div>
          <div className="grid shrink-0 grid-cols-3 gap-2 lg:min-w-72">
            <LinkStat value={connectedCount} label={t("ext.link.connectedCount")} />
            <LinkStat value={localConnectedCount} label={t("ext.link.localConnectedCount")} />
            <LinkStat value={serverConnectedCount} label={t("ext.link.serverConnectedCount")} />
          </div>
        </div>
      </section>

      <section
        className="rounded-2xl border border-status-ok/20 bg-status-ok/[0.045] p-4 sm:p-5"
        aria-labelledby="link-routing-title"
      >
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-status-ok/10 text-status-ok">
              <ShieldCheck className="size-4.5" aria-hidden />
            </div>
            <div>
              <h3 id="link-routing-title" className="text-sm font-semibold">
                {t("ext.link.routingTitle")}
              </h3>
              <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">
                {t("ext.link.routingDescription")}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2 rounded-xl border border-border/60 bg-background/70 px-3 py-2 text-[11px] font-medium">
            <HardDrive className="size-3.5 text-status-ok" aria-hidden />
            {t("ext.link.localRuntime")}
            <ArrowRight className="size-3 text-muted-foreground" aria-hidden />
            <Cloud className="size-3.5 text-sky-600 dark:text-sky-400" aria-hidden />
            {t("ext.link.serverRuntime")}
          </div>
        </div>
      </section>

      <section className="space-y-4" aria-labelledby="link-apps-title">
        <div>
          <div className="flex items-center gap-2">
            <Sparkles className="size-4 text-primary" aria-hidden />
            <h3 id="link-apps-title" className="text-base font-semibold tracking-tight">
              {t("ext.link.appsTitle")}
            </h3>
          </div>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">
            {t("ext.link.appsDescriptionDual")}
          </p>
        </div>

        <div className="flex flex-col gap-2 rounded-xl border border-border/70 bg-card p-2.5 lg:flex-row lg:items-center">
          <div className="relative min-w-52 flex-1">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              value={query}
              type="search"
              className="h-9 border-transparent bg-muted/55 pl-9 pr-9 focus-visible:bg-background"
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
            className="flex items-center gap-1 rounded-lg bg-muted/55 p-1"
            role="group"
            aria-label={t("ext.link.filterAria")}
          >
            {(["all", "connected", "planned"] as IntegrationFilter[]).map((value) => (
              <Button
                key={value}
                type="button"
                variant="ghost"
                size="sm"
                className={cn(
                  "h-7 flex-1 px-2.5 sm:flex-none",
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
            className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-status-err/30 bg-status-err/5 px-4 py-3"
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
          <div
            className="rounded-xl border border-border/70 bg-card px-4 py-3 text-xs text-muted-foreground"
            aria-live="polite"
          >
            {t("ext.link.loadingConnections")}
          </div>
        ) : null}

        {noMatches ? (
          <div className="rounded-xl border border-dashed border-border px-4 py-10 text-center">
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
          <div className="grid gap-4 xl:grid-cols-2 xl:items-start">
            <RuntimeLinkSection
              runtime="local"
              entries={entries.local}
              busyId={busyId}
              errors={errors}
              onLocalConnect={openLocalDialog}
              onLocalDisconnect={disconnectLocal}
              onServerLogin={onServerLogin}
              onServerRefresh={onServerRefresh}
              onServerLogout={onServerLogout}
            />
            <RuntimeLinkSection
              runtime="server"
              entries={entries.server}
              busyId={busyId}
              errors={errors}
              onLocalConnect={openLocalDialog}
              onLocalDisconnect={disconnectLocal}
              onServerLogin={onServerLogin}
              onServerRefresh={onServerRefresh}
              onServerLogout={onServerLogout}
            />
          </div>
        )}
      </section>

      <Dialog
        open={Boolean(localDialog)}
        onOpenChange={(open) => {
          if (!open) closeLocalDialog();
        }}
      >
        <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {t("ext.link.localDialogTitle", { name: localDialog?.item.name ?? "" })}
            </DialogTitle>
            <DialogDescription>{t("ext.link.localDialogDescription")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-1">
            <div className="rounded-xl border border-status-ok/20 bg-status-ok/[0.045] p-3 text-xs leading-5 text-muted-foreground">
              <div className="flex items-center gap-2 font-medium text-foreground">
                <HardDrive className="size-4 text-status-ok" aria-hidden />
                {localDialog?.method.displayName}
              </div>
              <p className="mt-1">{t("ext.link.localDialogStorageNote")}</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="link-local-label">{t("ext.link.localLabel")}</Label>
              <Input
                id="link-local-label"
                value={localLabel}
                onChange={(event) => setLocalLabel(event.target.value)}
              />
            </div>
            {localDialog?.method.quickAuth ? (
              <>
                <CliQuickAuthPanel
                  providerName={localDialog.item.name}
                  quickAuth={localDialog.method.quickAuth}
                  status={cliStatus}
                  installStatus={cliInstallStatus}
                  checking={cliChecking}
                  installing={cliInstalling}
                  busy={Boolean(busyId)}
                  onConnect={() => void connectFromCli()}
                  onInstall={openExternalLink}
                  onManagedInstall={() => void installAndConnectCli()}
                />
              </>
            ) : null}
            {localDialog?.method.browserAuth ? (
              <BrowserQuickAuthPanel
                providerName={localDialog.item.name}
                browserAuth={localDialog.method.browserAuth}
                status={browserAuthStatus}
                prompt={browserAuthPrompt}
                busy={browserAuthBusy}
                onConnect={() => void connectFromBrowser()}
                onOpenDocs={openExternalLink}
              />
            ) : null}
            {localDialog?.method.quickAuth || localDialog?.method.browserAuth ? (
              <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
                <div className="h-px flex-1 bg-border" />
                {t("ext.link.manualCredentialDivider")}
                <div className="h-px flex-1 bg-border" />
              </div>
            ) : null}
            {localDialog?.method.authGuide ? (
              <div className="rounded-xl border border-border/70 bg-muted/20 p-3.5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <p className="text-sm font-medium text-foreground">
                      {localDialog.method.authGuide.title}
                    </p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      {localDialog.method.authGuide.summary}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    onClick={() =>
                      openExternalLink(localDialog.method.authGuide!.createCredentialUrl)
                    }
                  >
                    {t("ext.link.openCredentialPage")}
                    <ExternalLink className="ml-1.5 size-3.5" aria-hidden />
                  </Button>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {localDialog.method.authGuide.permissions.map((permission) => (
                    <span
                      key={permission.id}
                      title={permission.description}
                      className={cn(
                        "rounded-md border bg-background px-2 py-1 font-mono text-[10px]",
                        permission.level === "required"
                          ? "border-primary/25 text-foreground"
                          : "border-border/70 text-muted-foreground",
                      )}
                    >
                      {permission.label}
                      {permission.level === "optional"
                        ? ` · ${t("ext.link.permissionOptional")}`
                        : ""}
                    </span>
                  ))}
                </div>
                <ol className="mt-3 list-decimal space-y-1 pl-4 text-[11px] leading-4 text-muted-foreground">
                  {localDialog.method.authGuide.steps.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
                {localDialog.method.authGuide.note ? (
                  <p className="mt-3 rounded-lg bg-background/70 px-2.5 py-2 text-[11px] leading-4 text-muted-foreground">
                    {localDialog.method.authGuide.note}
                  </p>
                ) : null}
                <button
                  type="button"
                  className="mt-3 inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
                  onClick={() => openExternalLink(localDialog.method.authGuide!.docsUrl)}
                >
                  {t("ext.link.viewOfficialGuide")}
                  <ArrowUpRight className="size-3" aria-hidden />
                </button>
              </div>
            ) : null}
            <div className="space-y-1.5">
              <Label htmlFor="link-local-secret">
                {t("ext.link.credentialInputLabel", {
                  token: localDialog?.method.tokenLabel ?? t("ext.link.localSecret"),
                })}
              </Label>
              <div className="relative">
                <KeyRound
                  className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                  aria-hidden
                />
                <Input
                  id="link-local-secret"
                  type="password"
                  className="pl-9"
                  value={localSecret}
                  autoComplete="off"
                  placeholder={
                    localDialog?.method.tokenPlaceholder ?? t("ext.link.localSecretPlaceholder")
                  }
                  onChange={(event) => setLocalSecret(event.target.value)}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeLocalDialog}>
              {t("common.cancel")}
            </Button>
            <Button
              disabled={!localSecret.trim() || Boolean(busyId)}
              onClick={() => void saveLocalConnection()}
            >
              {busyId
                ? t("ext.link.localValidating")
                : localDialog?.credential
                  ? t("ext.link.localReconnect")
                  : t("ext.link.connectLocal")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function ChatGatewayTab() {
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
      <section className="credential-hero overflow-hidden rounded-2xl border border-border/70 px-5 py-6 sm:px-6">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-start gap-4">
            <div className="flex size-12 shrink-0 items-center justify-center rounded-2xl border border-emerald-500/20 bg-emerald-500/10 text-emerald-600 shadow-sm dark:text-emerald-400">
              <MessagesSquare className="size-6" aria-hidden />
            </div>
            <div className="min-w-0 max-w-2xl">
              <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-600 dark:text-emerald-400">
                {t("ext.link.gatewayEyebrow")}
              </span>
              <h2 className="mt-1.5 text-lg font-semibold tracking-tight text-foreground">
                {t("ext.link.gatewayTitle")}
              </h2>
              <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
                {t("ext.link.gatewayHeroDescription")}
              </p>
            </div>
          </div>
          <div className="grid shrink-0 grid-cols-2 gap-2 lg:min-w-56">
            <div className="rounded-xl border border-border/70 bg-background/70 px-3 py-2.5 backdrop-blur-sm">
              <div className="text-lg font-semibold leading-none tabular-nums text-foreground">
                {enabledCount}
              </div>
              <div className="mt-1 text-[10px] text-muted-foreground">
                {t("ext.link.gatewayConfiguredCount")}
              </div>
            </div>
            <div className="rounded-xl border border-border/70 bg-background/70 px-3 py-2.5 backdrop-blur-sm">
              <div
                className="truncate text-sm font-semibold leading-none text-foreground"
                title={statusLabel}
              >
                {statusLabel}
              </div>
              <div className="mt-1.5 text-[10px] text-muted-foreground">
                {t("ext.link.gatewayStateLabel")}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="space-y-4" aria-labelledby="link-channels-title">
        <div className="flex items-start gap-2.5">
          <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
            <MessagesSquare className="size-4" aria-hidden />
          </div>
          <div>
            <h3 id="link-channels-title" className="text-base font-semibold tracking-tight">
              {t("ext.link.gatewaySection")}
            </h3>
            <p className="mt-0.5 max-w-2xl text-xs leading-5 text-muted-foreground">
              {t("ext.link.gatewaySectionDescription")}
            </p>
          </div>
        </div>
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

function LinkStat({ value, label }: { value: number; label: string }) {
  return (
    <div className="rounded-xl border border-border/70 bg-background/70 px-3 py-2.5 backdrop-blur-sm">
      <div className="text-lg font-semibold leading-none tabular-nums text-foreground">{value}</div>
      <div className="mt-1 truncate text-[10px] text-muted-foreground" title={label}>
        {label}
      </div>
    </div>
  );
}

interface RuntimeLinkSectionProps {
  runtime: LinkExecutionRuntime;
  entries: LinkMethodEntry[];
  busyId: string | null;
  errors: Record<string, string>;
  onLocalConnect: (entry: LinkMethodEntry) => void;
  onLocalDisconnect: (entry: LinkMethodEntry) => void;
  onServerLogin: (
    item: LinkIntegration,
    method: LinkConnectionMethod,
    credential?: MaskedCredentialView,
  ) => void;
  onServerRefresh: (
    item: LinkIntegration,
    method: LinkConnectionMethod,
    credential: MaskedCredentialView,
  ) => void;
  onServerLogout: (
    item: LinkIntegration,
    method: LinkConnectionMethod,
    credential: MaskedCredentialView,
  ) => void;
}

function RuntimeLinkSection(props: RuntimeLinkSectionProps) {
  const { t } = useT();
  const local = props.runtime === "local";
  const RuntimeIcon = local ? HardDrive : Cloud;

  return (
    <section
      data-link-runtime-section={props.runtime}
      className={cn(
        "space-y-3 rounded-2xl border p-3 sm:p-4",
        local ? "border-status-ok/20 bg-status-ok/[0.025]" : "border-sky-500/20 bg-sky-500/[0.025]",
      )}
      aria-labelledby={`link-runtime-${props.runtime}`}
    >
      <div className="flex items-start justify-between gap-3 px-1 py-0.5">
        <div className="flex min-w-0 items-start gap-3">
          <div
            className={cn(
              "flex size-9 shrink-0 items-center justify-center rounded-xl",
              local
                ? "bg-status-ok/10 text-status-ok"
                : "bg-sky-500/10 text-sky-600 dark:text-sky-400",
            )}
          >
            <RuntimeIcon className="size-4" aria-hidden />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h4 id={`link-runtime-${props.runtime}`} className="text-sm font-semibold">
                {t(local ? "ext.link.localSection" : "ext.link.serverSection")}
              </h4>
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-[10px] font-medium",
                  local
                    ? "border border-status-ok/25 bg-status-ok/8 text-status-ok"
                    : "border border-sky-500/20 bg-sky-500/8 text-sky-600 dark:text-sky-400",
                )}
              >
                {t(local ? "ext.link.defaultPreferred" : "ext.link.managedRuntime")}
              </span>
            </div>
            <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
              {t(local ? "ext.link.localSectionDescription" : "ext.link.serverSectionDescription")}
            </p>
          </div>
        </div>
        <span className="text-xs tabular-nums text-muted-foreground">{props.entries.length}</span>
      </div>

      {props.entries.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/70 bg-background/40 px-4 py-8 text-center text-xs text-muted-foreground">
          {t("ext.link.runtimeEmpty")}
        </div>
      ) : (
        <div className="space-y-3">
          {props.entries.map((entry) => {
            const key = `${entry.item.id}:${entry.method.executionRuntime}`;
            return (
              <LinkMethodCard
                key={`${entry.item.id}:${entry.method.id}`}
                entry={entry}
                busy={props.busyId === key}
                error={props.errors[key]}
                onLocalConnect={() => props.onLocalConnect(entry)}
                onLocalDisconnect={() => props.onLocalDisconnect(entry)}
                onServerLogin={(credential) =>
                  props.onServerLogin(entry.item, entry.method, credential)
                }
                onServerRefresh={(credential) =>
                  props.onServerRefresh(entry.item, entry.method, credential)
                }
                onServerLogout={(credential) =>
                  props.onServerLogout(entry.item, entry.method, credential)
                }
              />
            );
          })}
        </div>
      )}
    </section>
  );
}

function LinkMethodCard({
  entry,
  busy,
  error,
  onLocalConnect,
  onLocalDisconnect,
  onServerLogin,
  onServerRefresh,
  onServerLogout,
}: {
  entry: LinkMethodEntry;
  busy: boolean;
  error?: string;
  onLocalConnect: () => void;
  onLocalDisconnect: () => void;
  onServerLogin: (credential?: MaskedCredentialView) => void;
  onServerRefresh: (credential: MaskedCredentialView) => void;
  onServerLogout: (credential: MaskedCredentialView) => void;
}) {
  const { t } = useT();
  const { item, method, credential, preferredRuntime } = entry;
  const Icon = INTEGRATION_ICONS[item.icon];
  const local = method.executionRuntime === "local";
  const state = credential?.oauthStatus?.state ?? (credential ? "valid" : "missing");
  const primaryAction = oauthErrorRequiresRelogin(error)
    ? "login"
    : linkOAuthPrimaryAction(credential, Boolean(method.oauthProfileId));
  const status =
    local && credential
      ? t("ext.link.localCredentialSaved")
      : state === "valid"
        ? t("ext.link.oauthStatusValid")
        : state === "expired"
          ? t("ext.link.oauthStatusExpired")
          : state === "invalid"
            ? t("ext.link.oauthStatusInvalid")
            : t("ext.link.oauthStatusMissing");
  const available =
    method.availability === "available" &&
    (method.authKind === "token" || Boolean(method.oauthProfileId));
  const preferred =
    Boolean(credential) &&
    preferredRuntime === method.executionRuntime &&
    linkCredentialIsUsable(credential);

  return (
    <article
      data-link-integration={item.id}
      data-link-runtime={method.executionRuntime}
      className={cn(
        "link-card group flex min-h-48 flex-col rounded-2xl border border-border/70 bg-card p-4 transition-all",
        item.featured &&
          local &&
          "border-status-ok/20 bg-gradient-to-br from-status-ok/[0.045] via-card to-card",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div
            className={cn(
              "flex size-10 shrink-0 items-center justify-center rounded-xl",
              item.brandClass,
            )}
          >
            <Icon className="size-4.5" aria-hidden />
            <span className="sr-only">{item.brandText}</span>
          </div>
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h5 className="text-sm font-semibold tracking-tight text-foreground">{item.name}</h5>
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-[10px] font-medium",
                  credential && state === "valid"
                    ? "bg-status-ok/10 text-status-ok"
                    : credential && state !== "missing"
                      ? "bg-status-err/10 text-status-err"
                      : available
                        ? "bg-status-running/10 text-status-running"
                        : "bg-muted text-muted-foreground",
                )}
              >
                {credential
                  ? status
                  : available
                    ? t("ext.link.availableStatus")
                    : t("ext.link.comingSoon")}
              </span>
            </div>
            <p className="mt-1 text-[11px] font-medium text-muted-foreground">
              {method.displayName}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap justify-end gap-1.5">
          {preferred ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-primary/20 bg-primary/8 px-2 py-0.5 text-[10px] font-medium text-primary">
              <Cable className="size-3" aria-hidden />
              {t(local ? "ext.link.activePreferred" : "ext.link.activeFallback")}
            </span>
          ) : null}
        </div>
      </div>

      <div className="mt-3 min-w-0 flex-1">
        <p className="text-xs leading-5 text-muted-foreground">{item.description}</p>

        {credential ? (
          <div className="mt-3 rounded-xl border border-border/60 bg-background/65 px-3 py-2 text-[11px] text-muted-foreground">
            <div className="truncate font-medium text-foreground" title={credential.label}>
              {credential.label}
            </div>
            <div className="mt-0.5 truncate font-mono" title={credential.id}>
              {credential.id}
              {credential.oauthStatus?.expiresAt
                ? ` · ${new Date(credential.oauthStatus.expiresAt).toLocaleString()}`
                : ""}
            </div>
            {local && credential.meta?.linkAccountLabel ? (
              <div className="mt-1 truncate text-status-ok">
                <ShieldCheck className="mr-1 inline size-3" aria-hidden />
                {t("ext.link.localCredentialVerified", {
                  account: credential.meta.linkAccountLabel,
                })}
              </div>
            ) : null}
            {local && credential.meta?.linkExecutionBackend === "cli" && method.quickAuth ? (
              <div className="mt-1 text-[10px] text-muted-foreground">
                {t("ext.link.connectedViaCli", { command: method.quickAuth.command })}
              </div>
            ) : null}
            {local && credential.meta?.linkResourceLabels?.length ? (
              <div className="mt-2" data-link-resource-preview={item.id}>
                <div className="text-[10px] font-medium text-muted-foreground">
                  {t("ext.link.resourcePreview")}
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {credential.meta.linkResourceLabels.slice(0, 6).map((resource) => (
                    <span
                      key={resource}
                      className="max-w-full truncate rounded-md border border-border/60 bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] text-foreground"
                      title={resource}
                    >
                      {resource}
                    </span>
                  ))}
                  {credential.meta.linkResourceLabels.length > 6 ? (
                    <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      +{credential.meta.linkResourceLabels.length - 6}
                    </span>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {error ? (
          <div role="alert" className="mt-2 break-words text-xs leading-5 text-status-err">
            {error}
          </div>
        ) : null}
      </div>

      <div className="mt-4 flex min-h-8 flex-wrap items-center justify-between gap-2 border-t border-border/55 pt-3">
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          {local ? (
            <>
              <HardDrive className="size-3.5 text-status-ok" aria-hidden />
              {t("ext.link.secretOnDevice")}
            </>
          ) : (
            <>
              <Cloud className="size-3.5 text-sky-600 dark:text-sky-400" aria-hidden />
              {t("ext.link.secretOnServer")}
            </>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1">
          {local && credential ? (
            <>
              <Button variant="secondary" size="sm" onClick={onLocalConnect} disabled={busy}>
                {t("ext.link.localReconnect")}
              </Button>
              <Button variant="ghost" size="sm" onClick={onLocalDisconnect} disabled={busy}>
                {t("ext.link.localDisconnect")}
              </Button>
            </>
          ) : !local && credential ? (
            <>
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  primaryAction === "login"
                    ? onServerLogin(credential)
                    : onServerRefresh(credential)
                }
                disabled={busy}
              >
                {busy ? <RefreshCw className="size-3.5 animate-spin" aria-hidden /> : null}
                {primaryAction === "login"
                  ? t("ext.link.oauthRelogin")
                  : t("ext.link.oauthRefresh")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onServerLogout(credential)}
                disabled={busy}
              >
                {t("ext.link.oauthLogout")}
              </Button>
            </>
          ) : (
            <Button
              variant={available ? "default" : "outline"}
              size="sm"
              onClick={local ? onLocalConnect : () => onServerLogin()}
              disabled={busy || !available}
              title={!available ? t("ext.link.oauthUnsupported") : undefined}
            >
              {available
                ? t(local ? "ext.link.connectLocal" : "ext.link.connectServer")
                : t("ext.link.comingSoon")}
            </Button>
          )}
        </div>
      </div>
    </article>
  );
}
