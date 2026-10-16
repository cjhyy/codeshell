import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Cable,
  ChevronDown,
  Cloud,
  ExternalLink,
  Figma,
  Github,
  HardDrive,
  MessageCircleMore,
  MessagesSquare,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  SquareTerminal,
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
import { RemoteProviderSection, useRemoteLinkSnapshot } from "./RemoteLinkSection";
import { LinkConnectionRow, LinkProviderCard } from "./LinkProviderCard";
import { linkCredentialProvider, mergeLinkDirectoryProviders } from "./linkDirectory";
import { linkOAuthPrimaryAction } from "./link-oauth-actions";
import { LinkConnectionDialog } from "./LinkConnectionDialog";
import { FigmaConnectionCard } from "./FigmaConnectionCard";
import {
  LinkAccountMenu,
  LinkConnectionOption,
  LinkPresentationContext,
  useLinkPrimaryAction,
} from "./LinkPresentation";
import { selectPrimaryLinkOption } from "./linkPrimaryConnection";
import { useCloudAccountStatus } from "./useCloudAccountStatus";
import { localLinkProvider, localLinkSnapshot } from "./linkLocalPresentation";
import type { MaskedCredentialView } from "./types";
import { DingTalkSetupDialog } from "./DingTalkSetupDialog";
import { CredentialsSectionHeader } from "./CredentialsSectionHeader";
import type {
  ImGatewayChannel,
  ImGatewayChannelCapabilities,
  ImGatewayChannelStatus,
  ImGatewayStatus,
  ImGatewayUiEvent,
  CliLinkStatusView,
  LocalLinkProviderView,
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

function integrationIcon(providerId: string): LucideIcon {
  return providerId === "github" ? Github : providerId === "figma" ? Figma : Cable;
}

function linkCredentialRuntime(credential: MaskedCredentialView): LinkExecutionRuntime | undefined {
  return (
    credential.meta?.linkExecutionRuntime ??
    (credential.type === "oauth" ? "server" : credential.type === "link" ? "local" : undefined)
  );
}

function linkCredentialIsUsable(credential: MaskedCredentialView | undefined): boolean {
  if (!credential?.hasSecret) return false;
  return !credential.oauthStatus || credential.oauthStatus.state === "valid";
}

function linkMethodStateKey(
  providerId: string,
  method: Pick<LinkConnectionMethod, "id" | "executionRuntime">,
): string {
  return `${providerId}:${method.executionRuntime}:${method.id}`;
}

/** Multiple saved connections require an explicit choice, even when one is unavailable. */
export function resolvePreferredLinkRuntime(
  credentials: MaskedCredentialView[],
  providerId: string,
): LinkExecutionRuntime | null {
  const candidates = credentials.filter(
    (credential) => linkCredentialProvider(credential) === providerId,
  );
  if (candidates.length !== 1 || !linkCredentialIsUsable(candidates[0])) return null;
  return linkCredentialRuntime(candidates[0]!) ?? null;
}

/**
 * Live CLI login state for a Link card. Held in renderer memory only: it must
 * never be written back to the credential, because LinkAction treats any change
 * to meta.linkLastVerifiedAt as a disconnect and aborts in-flight actions.
 */
export type CliLivenessState = "checking" | "ok" | "mismatch" | "unknown";

export interface CliLiveness {
  state: CliLivenessState;
  command: string;
  account?: string;
}

interface CliProbe {
  command: string;
  pending: boolean;
  status: CliLinkStatusView | null;
}

/** A failed probe is a network/service failure, not proof of a signed-out account. */
export function resolveCliLiveness(
  status: {
    installed: boolean;
    authenticated: boolean;
    accountId?: string;
    account?: string;
  } | null,
  expectedAccountId: string | undefined,
): Exclude<CliLivenessState, "checking"> {
  if (!status || !status.installed || !status.authenticated) return "unknown";
  if (!expectedAccountId || !status.accountId) return "unknown";
  return status.accountId === expectedAccountId ? "ok" : "mismatch";
}

interface LinkMethodEntry {
  item: LinkIntegration;
  method: LinkConnectionMethod;
  credential?: MaskedCredentialView;
  preferredRuntime: LinkExecutionRuntime | null;
  available?: boolean;
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

/**
 * Link tab = 第三方应用连接。每个 provider 同时拥有 local/server 两条连接通道；
 * credential 状态互不覆盖；多个连接由调用方明确选择。
 */
export function LinkTab({ cwd }: { cwd: string }) {
  const { t, lang } = useT();
  const toast = useToast();
  const [credentials, setCredentials] = useState<MaskedCredentialView[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [localMetadataReady, setLocalMetadataReady] = useState(false);
  const loadGeneration = useRef(0);
  const loadMounted = useRef(false);
  const loadCwd = useRef(cwd);
  loadCwd.current = cwd;
  const [loadError, setLoadError] = useState<string | null>(null);
  const [providerViews, setProviderViews] = useState<LocalLinkProviderView[]>([]);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const [filter, setFilter] = useState<IntegrationFilter>("all");
  const [category, setCategory] = useState("all");
  const remote = useRemoteLinkSnapshot(cwd, { automatic: false });
  const account = useCloudAccountStatus();
  const [initialLoadComplete, setInitialLoadComplete] = useState(false);
  useEffect(() => {
    // Present one coherent first directory, rather than sorting partial account
    // and provider results in front of the user. Later refreshes keep the cards.
    if (localMetadataReady && !remote.loading && !account.loading) setInitialLoadComplete(true);
  }, [localMetadataReady, remote.loading, account.loading]);
  const initialLoading = !initialLoadComplete;
  const cloudAvailable = Boolean(
    account.status?.state === "signed-in" && account.status.origin && account.status.account?.id,
  );
  const visibleSnapshot = useMemo(
    () => (cloudAvailable ? remote.snapshot : localLinkSnapshot(remote.snapshot)),
    [cloudAvailable, remote.snapshot],
  );
  const visibleCredentials = useMemo(
    () =>
      cloudAvailable
        ? credentials
        : credentials.filter(
            (credential) =>
              linkCredentialRuntime(credential) === "local" &&
              credential.meta?.linkExecutionBackend !== "remote",
          ),
    [cloudAvailable, credentials],
  );
  const accountIdentity = cloudAvailable
    ? `${account.status!.origin}\n${account.status!.account!.id}`
    : "";
  const previousAccountIdentity = useRef(accountIdentity);
  useEffect(() => {
    if (previousAccountIdentity.current === accountIdentity) return;
    previousAccountIdentity.current = accountIdentity;
    void remote.reload();
  }, [accountIdentity, remote.reload]);
  const [localDialog, setLocalDialog] = useState<{
    item: LinkIntegration;
    method: LinkConnectionMethod;
    credential?: MaskedCredentialView;
  } | null>(null);
  const [cliProbes, setCliProbes] = useState<Record<string, CliProbe>>({});
  const loadData = useRef<{
    cwd: string;
    credentials: MaskedCredentialView[];
    providers: LocalLinkProviderView[];
  }>({ cwd, credentials: [], providers: [] });
  const [refreshing, setRefreshing] = useState(false);
  const refreshPending = useRef<
    | {
        cwd: string;
        forceCatalog: boolean;
        promise: Promise<void>;
      }
    | undefined
  >(undefined);

  const load = useCallback(async () => {
    if (!loadMounted.current || loadCwd.current !== cwd) return;
    const generation = ++loadGeneration.current;
    const current = () =>
      loadMounted.current && generation === loadGeneration.current && loadCwd.current === cwd;
    setLoading(true);
    try {
      const [all, providers] = await Promise.allSettled([
        window.codeshell.credentials.list(cwd),
        window.codeshell.links.listLocalProviders(),
      ]);
      if (!current()) return;
      const previous = loadData.current.cwd === cwd ? loadData.current : undefined;
      const nextCredentials =
        all.status === "fulfilled"
          ? all.value.filter(
              (credential) => credential.type === "oauth" || credential.type === "link",
            )
          : (previous?.credentials ?? []);
      const nextProviders =
        providers.status === "fulfilled" ? providers.value : (previous?.providers ?? []);
      loadData.current = { cwd, credentials: nextCredentials, providers: nextProviders };
      setCredentials(nextCredentials);
      setProviderViews(nextProviders);
      setLocalMetadataReady(true);

      // Probe each provider once. Stable account IDs are compared independently
      // for each saved binding below; labels never identify the approved account.
      const commands = new Map<string, string>();
      for (const provider of nextProviders) {
        const method = provider.connectionMethods.find(
          (candidate) => candidate.quickAuth?.kind === "cli-session",
        );
        if (method?.quickAuth) commands.set(provider.id, method.quickAuth.command);
      }
      const providerIds = new Set(
        nextCredentials.flatMap((credential) =>
          credential.hasSecret &&
          credential.meta?.linkExecutionBackend === "cli" &&
          credential.meta.linkProvider &&
          commands.has(credential.meta.linkProvider)
            ? [credential.meta.linkProvider]
            : [],
        ),
      );
      const statusLoader = window.codeshell.links.cliStatus;
      const targets = typeof statusLoader === "function" ? [...providerIds] : [];
      setCliProbes(
        Object.fromEntries(
          targets.map((providerId) => [
            providerId,
            {
              command: commands.get(providerId)!,
              pending: true,
              status: null,
            },
          ]),
        ),
      );
      await Promise.all(
        targets.map(async (providerId) => {
          let status: CliLinkStatusView | null;
          try {
            status = await statusLoader(providerId, cwd);
          } catch {
            status = null;
          }
          if (!current()) return;
          setCliProbes((probes) => ({
            ...probes,
            [providerId]: {
              command: status?.command || commands.get(providerId)!,
              pending: false,
              status,
            },
          }));
        }),
      );
      if (!current()) return;
      const failure = [all, providers].find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      setLoadError(null);
    } catch (error) {
      if (!current()) return;
      const message = error instanceof Error ? error.message : String(error);
      setLoadError(message);
      throw error;
    } finally {
      if (current()) {
        setLocalMetadataReady(true);
        setLoading(false);
      }
    }
  }, [cwd]);

  const refresh = useCallback(
    (forceCatalog = false) => {
      if (!loadMounted.current || loadCwd.current !== cwd) return Promise.resolve();
      const active = refreshPending.current;
      if (active?.cwd === cwd) {
        active.forceCatalog ||= forceCatalog;
        return active.promise;
      }
      const entry = { cwd, forceCatalog, promise: Promise.resolve() };
      entry.promise = Promise.resolve()
        .then(async () => {
          do {
            if (!loadMounted.current || loadCwd.current !== cwd || refreshPending.current !== entry)
              return;
            const force = entry.forceCatalog;
            entry.forceCatalog = false;
            await Promise.allSettled([load(), remote.reload(force)]);
          } while (entry.forceCatalog);
        })
        .finally(() => {
          if (refreshPending.current !== entry) return;
          refreshPending.current = undefined;
          if (loadMounted.current && loadCwd.current === cwd) setRefreshing(false);
        });
      refreshPending.current = entry;
      setRefreshing(true);
      return entry.promise;
    },
    [cwd, load, remote.reload],
  );

  useEffect(() => {
    loadMounted.current = true;
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      loadMounted.current = false;
      loadGeneration.current++;
      refreshPending.current = undefined;
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  const cliLiveness = useMemo(() => {
    const bindings: Record<string, CliLiveness> = {};
    for (const credential of credentials) {
      if (credential.meta?.linkExecutionBackend !== "cli" || !credential.meta.linkProvider)
        continue;
      const probe = cliProbes[credential.meta.linkProvider];
      if (!probe) continue;
      bindings[credential.id] = {
        state: probe.pending
          ? "checking"
          : resolveCliLiveness(probe.status, credential.meta.linkAccountId),
        command: probe.command,
        account: probe.status?.account,
      };
    }
    return bindings;
  }, [credentials, cliProbes]);

  const catalog = useMemo(
    () =>
      buildLinkCatalog(
        mergeLinkDirectoryProviders(
          cloudAvailable ? providerViews : providerViews.map(localLinkProvider),
          visibleSnapshot?.providers,
          visibleCredentials,
          visibleSnapshot?.connections,
        ),
        lang === "zh" ? "zh" : "en",
      ),
    [lang, providerViews, visibleCredentials, visibleSnapshot, cloudAvailable],
  );
  const entries = useMemo(() => {
    const result: Record<LinkExecutionRuntime, LinkMethodEntry[]> = { local: [], server: [] };
    for (const category of catalog)
      for (const item of category.items) {
        const remoteProvider = visibleSnapshot?.providers.find(
          (provider) => provider.id === item.id,
        );
        for (const method of item.connectionMethods) {
          if (
            method.id === "mcp" ||
            remoteProvider?.authModes?.some(
              (mode) => mode.id === "remote-link" && mode.methodId === method.id,
            )
          )
            continue;
          const matching = visibleCredentials.filter((credential) => {
            if (
              ["remote", "mcp"].includes(credential.meta?.linkExecutionBackend ?? "") ||
              linkCredentialProvider(credential) !== item.id ||
              linkCredentialRuntime(credential) !== method.executionRuntime
            )
              return false;
            const explicitMethod = credential.meta?.linkConnectionMethod;
            if (explicitMethod) return explicitMethod === method.id;
            // A saved record without a method marker appears once, without
            // treating its display name as authority or choosing between accounts.
            const choices = item.connectionMethods.filter(
              (candidate) =>
                candidate.executionRuntime === method.executionRuntime &&
                candidate.id !== "mcp" &&
                !remoteProvider?.authModes?.some(
                  (mode) => mode.id === "remote-link" && mode.methodId === candidate.id,
                ),
            );
            const choice =
              choices.find((candidate) => candidate.id === credential.id) ?? choices[0];
            return choice?.id === method.id;
          });
          const candidates = matching.length ? matching : [undefined];
          for (const credential of candidates) {
            // Managed browser authorization owns this capability; an unavailable
            // catalog must never resurrect a misleading "coming soon" placeholder.
            if (
              method.executionRuntime === "server" &&
              method.authKind === "oauth" &&
              !method.oauthProfileId &&
              method.availability !== "available" &&
              !credential
            )
              continue;
            result[method.executionRuntime].push({
              item,
              method,
              credential,
              preferredRuntime: resolvePreferredLinkRuntime(visibleCredentials, item.id),
              available:
                method.executionRuntime === "local"
                  ? Boolean(
                      remoteProvider?.authModes?.some(
                        (mode) => mode.methodId === method.id && mode.available,
                      ),
                    )
                  : Boolean(method.oauthProfileId && method.availability === "available"),
            });
          }
        }
      }
    return result;
  }, [catalog, visibleCredentials, visibleSnapshot?.providers]);

  /**
   * 旧版通用表单创建的 type:"link" 凭据没有 linkProvider/oauthProvider meta，
   * 匹配不到任何 provider 卡片。单独列出来，让用户至少能看到并删除它们。
   */
  const legacyCredentials = useMemo(
    () =>
      visibleCredentials.filter(
        (credential) => credential.type === "link" && !linkCredentialProvider(credential),
      ),
    [visibleCredentials],
  );

  const run = async (
    item: LinkIntegration,
    method: LinkConnectionMethod,
    action: () => Promise<void>,
  ): Promise<boolean> => {
    if (busyId) return false;
    const key = linkMethodStateKey(item.id, method);
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
  };

  const disconnectLocal = (entry: LinkMethodEntry) => {
    if (!entry.credential) return;
    void run(entry.item, entry.method, async () => {
      await window.codeshell.credentials.remove(cwd, "user", entry.credential!.id);
      toast({ message: t("ext.link.localDisconnected", { name: entry.item.name }) });
    });
  };

  const removeLegacy = async (credential: MaskedCredentialView) => {
    if (busyId) return;
    setBusyId(`legacy:${credential.id}`);
    try {
      await window.codeshell.credentials.remove(cwd, "user", credential.id);
      toast({ message: t("ext.link.legacyDeleted", { label: credential.label }) });
      await load();
    } catch (err) {
      toast({ message: err instanceof Error ? err.message : String(err), variant: "error" });
    } finally {
      setBusyId(null);
    }
  };

  const directory = catalog
    .flatMap((group) =>
      group.items.map((item) => ({ item, categoryId: group.id, categoryTitle: t(group.titleKey) })),
    )
    .map(({ item, categoryId, categoryTitle }) => {
      const accounts =
        visibleSnapshot?.connections.filter((connection) => connection.providerId === item.id) ??
        [];
      const stored = visibleCredentials.filter(
        (credential) => linkCredentialProvider(credential) === item.id,
      );
      const provider = visibleSnapshot?.providers.find((candidate) => candidate.id === item.id);
      const visibleStored = stored.filter(
        (credential) => !accounts.some((account) => account.id === credential.id),
      );
      const usableAccounts = accounts.filter((account) => account.status === "connected");
      const connected =
        usableAccounts.length +
        visibleStored.filter(
          (credential) =>
            !["remote", "mcp"].includes(credential.meta?.linkExecutionBackend ?? "") &&
            linkCredentialIsUsable(credential),
        ).length;
      const saved = accounts.length + visibleStored.length;
      const available =
        provider?.authModes?.some((mode) => mode.available) ||
        item.connectionMethods.some(
          (method) => method.availability === "available" && Boolean(method.oauthProfileId),
        );
      const needsAttention = saved > 0 && connected === 0;
      const accountNames = [
        ...new Set([
          ...accounts.map((account) => account.account?.label ?? account.label),
          ...visibleStored.map(
            (credential) => credential.meta?.linkAccountLabel ?? credential.label,
          ),
        ]),
      ];
      return {
        item,
        categoryId,
        categoryTitle,
        provider,
        accounts,
        stored,
        connected,
        saved,
        available,
        needsAttention,
        accountNames,
      };
    })
    .sort(
      (left, right) =>
        Number(right.connected > 0) - Number(left.connected > 0) ||
        Number(right.needsAttention) - Number(left.needsAttention) ||
        left.item.name.localeCompare(right.item.name),
    );
  const needle = query.trim().toLocaleLowerCase();
  const visibleProviders = directory.filter(
    ({ item, categoryId, connected, available, needsAttention, accountNames }) =>
      (needle || category === "all" || categoryId === category) &&
      (filter !== "connected" || connected > 0) &&
      (filter !== "planned" || needsAttention || !available) &&
      `${item.name} ${item.description} ${item.id === "figma" ? t("ext.link.directory.figmaDescription") : ""} ${accountNames.join(" ")} ${item.connectionMethods.map((method) => method.displayName).join(" ")}`
        .toLocaleLowerCase()
        .includes(needle),
  );
  const visibleProviderIds = new Set(visibleProviders.map(({ item }) => item.id));
  const noMatches = !initialLoading && visibleProviders.length === 0;
  const discoveryUnavailable = ["unavailable", "stale"].includes(
    visibleSnapshot?.remoteCatalog?.state ?? "",
  );
  const stateReadError = loadError || remote.error;
  const directoryError =
    stateReadError || (discoveryUnavailable ? t("ext.link.directory.catalogUnavailable") : "");

  return (
    <div className="space-y-5" data-link-page>
      <header className="flex flex-wrap items-center gap-5 pb-1">
        <div className="min-w-0 flex-1 basis-80">
          <h2 className="text-lg font-semibold tracking-tight text-foreground">
            {t("ext.link.overviewTitle")}
          </h2>
          <p className="mt-2 max-w-xl text-xs leading-5 text-muted-foreground">
            {t("ext.link.directory.description")}
          </p>
        </div>
        <div className="relative w-full shrink-0 sm:w-64" role="search">
          <Search
            className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            ref={searchRef}
            value={query}
            type="search"
            className="h-10 rounded-xl border-border/60 bg-card pl-10 pr-9 [&::-webkit-search-cancel-button]:appearance-none"
            placeholder={t("ext.link.searchPlaceholder")}
            aria-label={t("ext.link.searchPlaceholder")}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute right-1 top-1 size-8 text-muted-foreground"
              aria-label={t("ext.link.clearSearch")}
              onClick={() => {
                setQuery("");
                searchRef.current?.focus();
              }}
            >
              <X className="size-3.5" aria-hidden />
            </Button>
          ) : null}
        </div>
      </header>

      <section
        aria-label={t("ext.link.appsTitle")}
        aria-busy={initialLoading}
        className="grid gap-6 md:grid-cols-[224px_minmax(0,1fr)]"
      >
        <aside className="flex min-w-0 flex-col gap-5 rounded-2xl bg-muted/35 p-3 md:self-start md:p-4">
          <div
            role="group"
            aria-label={t("ext.link.filterAria")}
            className="flex gap-1 md:flex-col"
          >
            {(["all", "connected", "planned"] as IntegrationFilter[]).map((value) => (
              <Button
                key={value}
                type="button"
                variant="ghost"
                size="sm"
                className={cn(
                  "h-9 min-w-0 flex-1 justify-between gap-2 rounded-lg px-3 md:flex-none",
                  filter === value && "bg-background text-foreground shadow-sm",
                )}
                aria-label={t(`ext.link.filter.${value}`)}
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                <span className="min-w-0 truncate">{t(`ext.link.filter.${value}`)}</span>
                <span
                  aria-hidden
                  className="shrink-0 text-[11px] tabular-nums text-muted-foreground"
                >
                  {initialLoading
                    ? "—"
                    : value === "all"
                      ? directory.length
                      : value === "connected"
                        ? directory.filter((entry) => entry.connected > 0).length
                        : directory.filter((entry) => entry.needsAttention || !entry.available)
                            .length}
                </span>
              </Button>
            ))}
          </div>
          <div
            className="min-w-0 space-y-2 border-t border-border/50 pt-4"
            role="group"
            aria-label={t("ext.link.directory.categories")}
          >
            <p className="px-3 text-[11px] font-medium text-muted-foreground">
              {t("ext.link.directory.categories")}
            </p>
            <div className="flex min-w-0 gap-1 overflow-x-auto md:block md:overflow-visible">
              {[
                {
                  id: "all",
                  title: t("ext.link.directory.allCategories"),
                  count: directory.length,
                },
                ...catalog.map((group) => ({
                  id: group.id,
                  title: t(group.titleKey),
                  count: group.items.length,
                })),
              ].map((group) => (
                <Button
                  key={group.id}
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={group.title}
                  aria-pressed={(needle ? "all" : category) === group.id}
                  className={cn(
                    "h-9 shrink-0 justify-between gap-3 rounded-lg px-3 font-normal md:w-full md:min-w-0",
                    (needle ? "all" : category) === group.id &&
                      "bg-background text-foreground shadow-sm",
                  )}
                  onClick={() => {
                    setCategory(group.id);
                    setQuery("");
                  }}
                >
                  <span className="min-w-0 truncate">{group.title}</span>
                  <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                    {group.count}
                  </span>
                </Button>
              ))}
            </div>
          </div>
          <p className="hidden items-center gap-2 border-t border-border/50 px-2 pt-4 text-[11px] leading-5 text-muted-foreground md:flex">
            <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-status-ok" />
            {t("ext.link.directory.connectedSummary", {
              connected: directory.filter((entry) => entry.connected > 0).length,
              total: directory.length,
            })}
          </p>
          {!account.loading && !cloudAvailable && (
            <div
              role="status"
              data-link-local-only
              className="space-y-1.5 border-t border-border/50 px-2 pt-4 text-xs leading-5 text-muted-foreground"
            >
              <p className="flex items-center gap-1.5 font-medium text-foreground">
                <HardDrive aria-hidden className="size-3.5" />
                {t("ext.link.directory.localOnly")}
              </p>
              <p>{t("ext.link.directory.localOnlyHint")}</p>
            </div>
          )}
        </aside>
        <div className="min-w-0 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <p role="status" className="min-h-5 text-xs leading-5 text-muted-foreground">
              {initialLoading
                ? t("ext.link.loadingConnections")
                : t("ext.link.directory.results", { count: visibleProviders.length })}
            </p>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-8 text-xs text-muted-foreground"
              disabled={refreshing || loading || remote.loading}
              onClick={() => void refresh(true)}
            >
              <RefreshCw
                className={cn(
                  "size-3.5",
                  (refreshing || loading || remote.loading) && "animate-spin",
                )}
                aria-hidden
              />
              {t("ext.link.refreshConnections")}
            </Button>
          </div>
          {!initialLoading && directoryError ? (
            <div
              role="alert"
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-status-err/30 bg-status-err/5 px-4 py-3"
            >
              <div className="min-w-0">
                <p className="text-xs font-medium text-status-err">
                  {t(
                    stateReadError
                      ? "ext.link.loadFailed"
                      : "ext.link.directory.catalogUnavailableTitle",
                  )}
                </p>
                <p className="mt-0.5 break-words text-xs text-muted-foreground">{directoryError}</p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={loading}
                onClick={() => void refresh(true)}
              >
                <RefreshCw className={cn("size-3.5", loading && "animate-spin")} aria-hidden />
                {t("ext.link.retry")}
              </Button>
            </div>
          ) : null}

          {initialLoading && (
            <div
              data-link-loading
              aria-hidden
              className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,300px),1fr))] gap-4"
            >
              {Array.from({ length: 6 }, (_, index) => (
                <div
                  key={index}
                  className="h-[230px] space-y-5 rounded-2xl border border-border/65 bg-card p-5"
                >
                  <div className="flex items-center gap-3">
                    <div className="size-12 rounded-xl bg-muted" />
                    <div className="flex-1 space-y-2">
                      <div className="h-3.5 w-2/3 rounded bg-muted" />
                      <div className="h-3 w-1/3 rounded bg-muted/60" />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <div className="h-3 w-full rounded bg-muted/60" />
                    <div className="h-3 w-4/5 rounded bg-muted/60" />
                  </div>
                  <div className="h-3 w-1/2 rounded bg-muted/60" />
                  <div className="h-8 w-24 rounded-lg bg-muted" />
                </div>
              ))}
            </div>
          )}

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
                  setCategory("all");
                  searchRef.current?.focus();
                }}
              >
                {t("ext.link.resetFilters")}
              </Button>
            </div>
          ) : null}
          <div
            hidden={initialLoading || noMatches}
            data-link-directory
            className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,300px),1fr))] items-start gap-4"
          >
            {directory.map(
              ({
                item,
                categoryTitle,
                provider,
                accounts,
                connected,
                saved,
                available,
                needsAttention,
                accountNames,
              }) => {
                const methodEntries = [...entries.local, ...entries.server].filter(
                  (entry) => entry.item.id === item.id,
                );
                const methods = methodEntries.map((entry) => (
                  <LinkConnectionOption
                    key={`${entry.method.id}:${entry.credential?.id ?? "new"}`}
                    optionId={`method:${entry.method.id}:${entry.credential?.id ?? "new"}`}
                  >
                    <LinkMethodCard
                      key={`${entry.method.id}:${entry.credential?.id ?? "new"}`}
                      entry={entry}
                      liveness={entry.credential ? cliLiveness[entry.credential.id] : undefined}
                      busy={busyId === linkMethodStateKey(item.id, entry.method)}
                      error={errors[linkMethodStateKey(item.id, entry.method)]}
                      onLocalConnect={() => openLocalDialog(entry)}
                      onLocalDisconnect={() => disconnectLocal(entry)}
                      onServerLogin={(credential) => onServerLogin(item, entry.method, credential)}
                      onServerRefresh={(credential) =>
                        onServerRefresh(item, entry.method, credential)
                      }
                      onServerLogout={(credential) =>
                        onServerLogout(item, entry.method, credential)
                      }
                    />
                  </LinkConnectionOption>
                ));
                const hasRemote = Boolean(
                  provider?.authModes?.some((mode) => mode.id === "remote-link") ||
                  accounts.some((connection) => connection.authSource === "remote-link"),
                );
                const hasMcp =
                  item.id === "figma" &&
                  Boolean(
                    provider?.authModes?.some((mode) => mode.id === "mcp-oauth") ||
                    accounts.some((connection) => connection.authSource === "mcp-oauth"),
                  );
                const primaryOption = selectPrimaryLinkOption({
                  provider,
                  connections: accounts,
                  options: [
                    ...(hasRemote
                      ? [
                          {
                            id: "remote-link",
                            methodId:
                              provider?.authModes?.find((mode) => mode.id === "remote-link")
                                ?.methodId ?? "remote-link",
                            available: provider?.authModes?.some(
                              (mode) => mode.id === "remote-link" && mode.available,
                            ),
                          },
                        ]
                      : []),
                    ...(hasMcp
                      ? [
                          {
                            id: "mcp-oauth",
                            methodId: "mcp",
                            available: provider?.authModes?.some(
                              (mode) => mode.id === "mcp-oauth" && mode.available,
                            ),
                          },
                        ]
                      : []),
                    ...methodEntries.map((entry) => ({
                      id: `method:${entry.method.id}:${entry.credential?.id ?? "new"}`,
                      methodId: entry.method.id,
                      credentialId: entry.credential?.id,
                      usable: linkCredentialIsUsable(entry.credential),
                      available:
                        entry.available ??
                        (entry.method.availability === "available" &&
                          (entry.method.authKind === "token" ||
                            Boolean(entry.method.oauthProfileId))),
                    })),
                  ],
                });
                const missingAccounts = visibleCredentials.filter(
                  (credential) =>
                    linkCredentialProvider(credential) === item.id &&
                    ["remote", "mcp"].includes(credential.meta?.linkExecutionBackend ?? "") &&
                    !visibleSnapshot?.connections.some((account) => account.id === credential.id),
                );
                return (
                  <LinkProviderCard
                    key={`${cwd}:${item.id}`}
                    id={item.id}
                    hidden={!visibleProviderIds.has(item.id)}
                    name={item.name}
                    category={categoryTitle}
                    icon={integrationIcon(item.id)}
                    brandClass={item.brandClass}
                    brandText={item.brandText}
                    primaryOption={primaryOption}
                    hasConnections={saved > 0}
                    connectionCount={saved}
                    localOnly={!cloudAvailable}
                    description={
                      item.id === "figma"
                        ? t("ext.link.directory.figmaDescription")
                        : item.description
                    }
                    accounts={[
                      accountNames.join(" · "),
                      saved ? t("ext.link.directory.connectionCount", { count: saved }) : "",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                    status={
                      remote.loading && missingAccounts.length
                        ? t("ext.link.directory.checking")
                        : needsAttention
                          ? t("ext.link.directory.needsAttention")
                          : connected
                            ? t("ext.link.remoteAvailable")
                            : saved
                              ? t("ext.link.directory.unavailable")
                              : available
                                ? t("ext.link.directory.notConnected")
                                : t("ext.link.directory.unavailable")
                    }
                    tone={
                      remote.loading && missingAccounts.length
                        ? "neutral"
                        : needsAttention
                          ? "warning"
                          : connected
                            ? "ready"
                            : "neutral"
                    }
                  >
                    {missingAccounts.map((credential) => (
                      <LinkConnectionRow
                        key={credential.id}
                        data-link-saved-unavailable={credential.id}
                        title={credential.meta?.linkAccountLabel ?? credential.label}
                        description={t(
                          remote.loading
                            ? "ext.link.loadingConnections"
                            : "ext.link.directory.savedUnavailable",
                        )}
                        status={t(
                          remote.loading
                            ? "ext.link.directory.checking"
                            : "ext.link.directory.serviceUnavailable",
                        )}
                        tone={remote.loading ? "neutral" : "warning"}
                        actions={
                          <Button size="sm" variant="outline" onClick={() => void refresh(true)}>
                            {t("ext.link.retry")}
                          </Button>
                        }
                      />
                    ))}
                    {item.id === "figma" ? (
                      <FigmaConnectionCard
                        cwd={cwd}
                        snapshot={visibleSnapshot}
                        loadError={remote.error}
                        loading={remote.loading}
                        reload={remote.reload}
                        onChanged={() => void load().catch(() => undefined)}
                        localApi={methods}
                      />
                    ) : (
                      <>
                        {hasRemote && (
                          <LinkConnectionOption optionId="remote-link">
                            <RemoteProviderSection
                              cwd={cwd}
                              snapshot={visibleSnapshot}
                              loadError={remote.error}
                              loading={remote.loading}
                              reload={remote.reload}
                              onChanged={() => void load().catch(() => undefined)}
                              providerId={item.id}
                              provider={provider}
                              embedded
                            />
                          </LinkConnectionOption>
                        )}
                        {methods}
                      </>
                    )}
                  </LinkProviderCard>
                );
              },
            )}
          </div>
        </div>
      </section>

      {legacyCredentials.length > 0 ? (
        <section className="space-y-3" aria-labelledby="link-legacy-title">
          <div>
            <h3 id="link-legacy-title" className="text-sm font-semibold tracking-tight">
              {t("ext.link.legacySection")}
            </h3>
            <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">
              {t("ext.link.legacySectionDescription")}
            </p>
          </div>
          <div className="space-y-2">
            {legacyCredentials.map((credential) => (
              <div
                key={credential.id}
                data-link-legacy-credential={credential.id}
                className="flex items-center justify-between gap-3 rounded-xl border border-border/70 bg-card px-3.5 py-2.5"
              >
                <div className="min-w-0">
                  <div
                    className="truncate text-sm font-medium text-foreground"
                    title={credential.label}
                  >
                    {credential.label}
                  </div>
                  <div
                    className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground"
                    title={credential.id}
                  >
                    {credential.id}
                    {credential.meta?.linkLastVerifiedAt
                      ? ` · ${new Date(credential.meta.linkLastVerifiedAt).toLocaleDateString()}`
                      : ""}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0 text-muted-foreground hover:text-status-err"
                  disabled={Boolean(busyId)}
                  onClick={() => void removeLegacy(credential)}
                >
                  {t("ext.link.legacyDelete")}
                </Button>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {localDialog && (
        <LinkConnectionDialog
          key={`${cwd}:${localDialog.item.id}:${localDialog.method.id}:${localDialog.credential?.id ?? "new"}`}
          cwd={cwd}
          providerName={localDialog.item.name}
          icon={integrationIcon(localDialog.item.id)}
          brandClass={localDialog.item.brandClass}
          input={{
            providerId: localDialog.item.id,
            methodId: localDialog.method.id,
            label: localDialog.credential?.label ?? localDialog.item.name,
            ...(localDialog.credential ? { connectionId: localDialog.credential.id } : {}),
            expectedRevision: localDialog.credential
              ? (remote.snapshot?.connections.find((item) => item.id === localDialog.credential?.id)
                  ?.revision ?? null)
              : null,
          }}
          modes={
            visibleSnapshot?.providers
              .find((item) => item.id === localDialog.item.id)
              ?.authModes?.filter((mode) => mode.methodId === localDialog.method.id) ?? []
          }
          authGuide={localDialog.method.authGuide}
          onClose={() => setLocalDialog(null)}
          onConnected={() => {
            void load().catch(() => undefined);
            void remote.reload();
          }}
        />
      )}
    </div>
  );
}

export function ChatGatewayTab() {
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
      <CredentialsSectionHeader
        title={t("ext.link.gatewayTitle")}
        description={t("ext.link.gatewayHeroDescription")}
        stats={[
          { label: t("ext.link.gatewayConfiguredCount"), value: enabledCount },
          { label: t("ext.link.gatewayStateLabel"), value: statusLabel },
        ]}
      />

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

function LinkMethodCard({
  entry,
  liveness,
  busy,
  error,
  onLocalConnect,
  onLocalDisconnect,
  onServerLogin,
  onServerRefresh,
  onServerLogout,
}: {
  entry: LinkMethodEntry;
  liveness?: CliLiveness;
  busy: boolean;
  error?: string;
  onLocalConnect: () => void;
  onLocalDisconnect: () => void;
  onServerLogin: (credential?: MaskedCredentialView) => void;
  onServerRefresh: (credential: MaskedCredentialView) => void;
  onServerLogout: (credential: MaskedCredentialView) => void;
}) {
  const { t } = useT();
  const { item, method, credential } = entry;
  const local = method.executionRuntime === "local";
  const usable = linkCredentialIsUsable(credential);
  const state =
    credential && !credential.hasSecret
      ? "unavailable"
      : (credential?.oauthStatus?.state ?? (credential ? "valid" : "missing"));
  const primaryAction = linkOAuthPrimaryAction(credential, Boolean(method.oauthProfileId));
  const status =
    state === "unavailable"
      ? t("ext.link.credentialUnavailable")
      : local && usable && !credential?.oauthStatus
        ? t("ext.link.localCredentialSaved")
        : state === "valid"
          ? t("ext.link.oauthStatusValid")
          : state === "expired"
            ? t("ext.link.oauthStatusExpired")
            : state === "invalid"
              ? t("ext.link.oauthStatusInvalid")
              : t("ext.link.oauthStatusMissing");
  const available =
    entry.available ??
    (method.availability === "available" &&
      (method.authKind === "token" || Boolean(method.oauthProfileId)));
  const primary = useLinkPrimaryAction(`method:${method.id}:${credential?.id ?? "new"}`, {
    onClick: local ? onLocalConnect : () => onServerLogin(credential),
    disabled: busy || !available,
  });
  const presentation = React.useContext(LinkPresentationContext);
  const showTechnical = !primary || Boolean(presentation?.advanced);

  return (
    <LinkConnectionRow
      data-link-method-provider={item.id}
      data-link-runtime={method.executionRuntime}
      title={
        primary
          ? (credential?.meta?.linkAccountLabel ?? credential?.label ?? item.name)
          : method.displayName
      }
      technical={
        showTechnical ? t(local ? "ext.link.localRuntime" : "ext.link.serverRuntime") : undefined
      }
      status={
        credential
          ? status
          : available
            ? t("ext.link.directory.notConnected")
            : t("ext.link.directory.unavailable")
      }
      tone={credential && usable ? "ready" : credential ? "warning" : "neutral"}
    >
      <div className="mt-3 min-w-0 flex-1">
        {credential ? (
          <div className="mt-3 rounded-xl border border-border/60 bg-background/65 px-3 py-2 text-xs text-muted-foreground">
            <div
              hidden={primary}
              className="truncate font-medium text-foreground"
              title={credential.label}
            >
              {credential.label}
            </div>
            <div
              hidden={!showTechnical}
              className="mt-0.5 truncate font-mono"
              title={credential.id}
            >
              {credential.id}
              {credential.oauthStatus?.expiresAt
                ? ` · ${new Date(credential.oauthStatus.expiresAt).toLocaleString()}`
                : ""}
            </div>
            {local && usable && credential.meta?.linkAccountLabel ? (
              <div hidden={!showTechnical} className="mt-1 truncate text-muted-foreground">
                {t("ext.link.localCredentialVerified", {
                  account: credential.meta.linkAccountLabel,
                })}
                {credential.meta.linkLastVerifiedAt
                  ? ` · ${t("ext.link.localCredentialVerifiedAt", {
                      time: new Date(credential.meta.linkLastVerifiedAt).toLocaleString(),
                    })}`
                  : ""}
              </div>
            ) : null}
            {local && usable && credential.meta?.linkExecutionBackend === "cli" && liveness ? (
              <div
                data-link-liveness={item.id}
                data-link-liveness-state={liveness.state}
                className={cn(
                  "mt-1",
                  liveness.state === "ok"
                    ? "text-status-ok"
                    : liveness.state === "mismatch"
                      ? "text-status-err"
                      : "text-muted-foreground",
                )}
              >
                {liveness.state === "ok" ? (
                  <ShieldCheck className="mr-1 inline size-3" aria-hidden />
                ) : null}
                {liveness.state === "checking"
                  ? t("ext.link.cliLivenessChecking", { command: liveness.command })
                  : liveness.state === "ok"
                    ? t("ext.link.cliLivenessOk", {
                        command: liveness.command,
                        account: liveness.account ?? "",
                      })
                    : liveness.state === "mismatch"
                      ? t("ext.link.cliLivenessMismatch", {
                          command: liveness.command,
                          account: liveness.account ?? "",
                        })
                      : t("ext.link.cliLivenessUnknown", { command: liveness.command })}
              </div>
            ) : null}
            {local &&
            usable &&
            credential.meta?.linkExecutionBackend === "cli" &&
            method.quickAuth ? (
              <div hidden={!showTechnical} className="mt-1 text-xs text-muted-foreground">
                {t("ext.link.connectedViaCli", { command: method.quickAuth.command })}
              </div>
            ) : null}
            {state === "unavailable" ? (
              <p className="mt-1 text-status-err">{t("ext.link.credentialUnavailableHint")}</p>
            ) : null}
            {local && usable && credential.meta?.linkResourceLabels?.length ? (
              <div className="mt-2" data-link-resource-preview={item.id}>
                <div className="text-xs font-medium text-muted-foreground">
                  {t("ext.link.resourcePreview")}
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {credential.meta.linkResourceLabels.slice(0, 6).map((resource) => (
                    <span
                      key={resource}
                      className="max-w-full truncate rounded-md border border-border/60 bg-muted/60 px-1.5 py-0.5 font-mono text-xs text-foreground"
                      title={resource}
                    >
                      {resource}
                    </span>
                  ))}
                  {credential.meta.linkResourceLabels.length > 6 ? (
                    <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
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
        <div
          hidden={!showTechnical}
          className="flex items-center gap-1.5 text-xs text-muted-foreground"
        >
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
              {(!primary || !usable) && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={onLocalConnect}
                  disabled={busy || !available}
                >
                  {t("ext.link.localReconnect")}
                </Button>
              )}
              <LinkAccountMenu>
                {primary && usable && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={onLocalConnect}
                    disabled={busy || !available}
                  >
                    {t("ext.link.localReconnect")}
                  </Button>
                )}
                <Button variant="ghost" size="sm" onClick={onLocalDisconnect} disabled={busy}>
                  {t("ext.link.localDisconnect")}
                </Button>
              </LinkAccountMenu>
            </>
          ) : !local && credential ? (
            <>
              <LinkAccountMenu>
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
              </LinkAccountMenu>
            </>
          ) : (
            <Button
              hidden={primary}
              variant={available ? "default" : "outline"}
              size="sm"
              onClick={local ? onLocalConnect : () => onServerLogin()}
              disabled={busy || !available}
              title={!available ? t("ext.link.oauthUnsupported") : undefined}
            >
              {available
                ? t(local ? "ext.link.connectLocal" : "ext.link.connectServer")
                : t("ext.link.directory.unavailable")}
            </Button>
          )}
        </div>
      </div>
    </LinkConnectionRow>
  );
}
